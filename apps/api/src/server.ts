import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { planCampaign } from "@leadfactory/campaign-planner";
import { prisma, Prisma } from "@leadfactory/database";
import {
  createDebugBrowserController,
  DebugBrowserClickInputSchema,
  DebugBrowserExtractInputSchema,
  DebugBrowserOpenInputSchema,
  DebugBrowserScreenshotInputSchema,
  DebugBrowserSessionIdSchema,
  DebugBrowserTypeInputSchema,
  StartDebugBrowserInputSchema
} from "./debugBrowser.js";
import { OpenAICompatibleLLMProvider } from "@leadfactory/llm";
import { createLeadResearchMcpServer } from "@leadfactory/mcp-server";
import { parseProxyText } from "@leadfactory/proxy-manager";
import { createQueue, queueNames, type BrowserResearchPayload } from "@leadfactory/queue";
import {
  calculateWorkerLimits,
  probeServerHealth,
  probeSystemCapacity
} from "@leadfactory/resource-governor";
import { defaultRuntimeSettings, readRuntimeSettings, updateRuntimeSettings } from "@leadfactory/runtime-config";
import {
  CreateCampaignInputSchema,
  CampaignPlanSchema,
  ProxyUploadSchema,
  RuntimeSettingsUpdateSchema,
  type CampaignPlan
} from "@leadfactory/schemas";
import {
  CreateEmailVerificationProviderInputSchema,
  CreateEnrichmentProviderInputSchema,
  CreateSourceRecipeInputSchema,
  EmailVerificationProviderConfigSchema,
  EnrichmentProviderConfigSchema,
  SourceRecipeConfigSchema,
  UpdateSavedProviderStatusInputSchema,
  UpdateSourceRecipeStatusInputSchema
} from "@leadfactory/source-adapters";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "dotenv/config";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

const api = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info"
  }
});
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const debugBrowsers = createDebugBrowserController({
  rootDir,
  storageDir: defaultRuntimeSettings().appStorageDir,
  getSettings: readRuntimeSettings
});

await api.register(cors, {
  origin: true
});

api.addHook("onClose", async () => {
  await debugBrowsers.closeAll();
});

api.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: "validation_error",
      issues: error.issues
    });
    return;
  }

  api.log.error({ err: error });
  reply.status(500).send({
    error: "internal_error",
    message: error instanceof Error ? error.message : "Unknown error"
  });
});

api.get("/health", async () => ({
  ok: true,
  service: "leadfactory-api",
  time: new Date().toISOString()
}));

api.route({
  method: ["GET", "POST", "DELETE"],
  url: "/mcp",
  handler: handleRemoteMcpRequest
});

api.get("/settings/defaults", async () => defaultRuntimeSettings());

api.get("/settings/runtime", async () => {
  return {
    settings: await readRuntimeSettings(),
    defaults: defaultRuntimeSettings()
  };
});

api.post("/settings/runtime", async (request) => {
  const input = RuntimeSettingsUpdateSchema.parse(request.body ?? {});
  return {
    settings: await updateRuntimeSettings(input),
    defaults: defaultRuntimeSettings()
  };
});

api.get("/system/capacity", async () => {
  const settings = await readRuntimeSettings();
  const capacity = await probeSystemCapacity(settings.appStorageDir);
  const healthyProxyCount = await prisma.proxy.count({
    where: {
      status: { in: ["healthy", "untested", "degraded"] }
    }
  });
  const limits = calculateWorkerLimits({
    settings,
    capacity,
    healthyProxyCount,
    qwenHealthy: true
  });

  return { capacity, limits, settings };
});

api.get("/system/health", async () => {
  const settings = await readRuntimeSettings();
  return probeServerHealth({
    appStorageDir: settings.appStorageDir,
    databaseUrl: requiredEnv("DATABASE_URL"),
    redisUrl: settings.redisUrl,
    localLlmBaseUrl: settings.localLlmBaseUrl,
    rootDir
  });
});

api.get("/debug-browser/sessions", async () => debugBrowsers.list());

api.post("/debug-browser/sessions", async (request) => {
  return debugBrowsers.start(StartDebugBrowserInputSchema.parse(request.body ?? {}));
});

api.get("/debug-browser/sessions/:sessionId", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.snapshot(sessionId);
});

api.post("/debug-browser/sessions/:sessionId/open", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.open(sessionId, DebugBrowserOpenInputSchema.parse(request.body));
});

api.post("/debug-browser/sessions/:sessionId/click", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.click(sessionId, DebugBrowserClickInputSchema.parse(request.body));
});

api.post("/debug-browser/sessions/:sessionId/type", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.type(sessionId, DebugBrowserTypeInputSchema.parse(request.body));
});

api.post("/debug-browser/sessions/:sessionId/extract", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.extract(sessionId, DebugBrowserExtractInputSchema.parse(request.body ?? {}));
});

api.post("/debug-browser/sessions/:sessionId/screenshot", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.screenshot(sessionId, DebugBrowserScreenshotInputSchema.parse(request.body ?? {}));
});

api.get("/debug-browser/sessions/:sessionId/recipe-draft", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.recipeDraft(sessionId);
});

api.post("/debug-browser/sessions/:sessionId/close", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.close(sessionId);
});

api.delete("/debug-browser/sessions/:sessionId", async (request) => {
  const { sessionId } = DebugBrowserSessionIdSchema.parse(request.params);
  return debugBrowsers.close(sessionId);
});

api.get("/source-recipes", async (request) => {
  const { campaignId } = request.query as { campaignId?: string };
  const recipes = await prisma.sourceRecipe.findMany({
    where: campaignId
      ? {
          OR: [{ campaignId }, { campaignId: null }]
        }
      : undefined,
    orderBy: [{ status: "asc" }, { successCount: "desc" }, { updatedAt: "desc" }],
    take: 500
  });

  return {
    recipes: recipes.map(formatSourceRecipe),
    summary: {
      total: recipes.length,
      active: recipes.filter((recipe) => recipe.status === "active").length,
      trial: recipes.filter((recipe) => recipe.status === "trial").length,
      disabled: recipes.filter((recipe) => recipe.status === "disabled").length,
      successes: recipes.reduce((total, recipe) => total + recipe.successCount, 0),
      failures: recipes.reduce((total, recipe) => total + recipe.failureCount, 0)
    }
  };
});

api.get("/source-recipes/:recipeId", async (request, reply) => {
  const { recipeId } = request.params as { recipeId: string };
  const recipe = await prisma.sourceRecipe.findUnique({ where: { id: recipeId } });
  if (!recipe) return reply.status(404).send({ error: "not_found" });
  return formatSourceRecipe(recipe);
});

api.post("/source-recipes", async (request, reply) => {
  const input = CreateSourceRecipeInputSchema.parse(request.body);
  if (input.campaignId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId } });
    if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
  }

  const recipeConfig = SourceRecipeConfigSchema.parse(input);
  const recipe = await prisma.sourceRecipe.upsert({
    where: {
      name_version: {
        name: input.name,
        version: input.version
      }
    },
    update: {
      campaignId: input.campaignId ?? null,
      status: input.status,
      recipe: recipeConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    },
    create: {
      campaignId: input.campaignId,
      name: input.name,
      version: input.version,
      status: input.status,
      recipe: recipeConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    }
  });

  if (input.campaignId) {
    await prisma.campaignEvent.create({
      data: {
        campaignId: input.campaignId,
        type: "source_recipe_saved",
        message: `Source recipe ${input.name}@${input.version} saved for reuse.`,
        metadata: { source: "api", recipeId: recipe.id, status: recipe.status }
      }
    });
  }

  return {
    sourceRecipe: formatSourceRecipe(recipe)
  };
});

api.post("/source-recipes/:recipeId/status", async (request, reply) => {
  const { recipeId } = request.params as { recipeId: string };
  const input = UpdateSourceRecipeStatusInputSchema.parse(request.body);
  const recipe = await prisma.sourceRecipe
    .update({
      where: { id: recipeId },
      data: { status: input.status }
    })
    .catch(() => null);
  if (!recipe) return reply.status(404).send({ error: "not_found" });
  return { sourceRecipe: formatSourceRecipe(recipe) };
});

api.post("/source-recipes/:recipeId/activate", async (request, reply) => {
  return setSourceRecipeStatus(request.params as { recipeId: string }, "active", reply);
});

api.post("/source-recipes/:recipeId/disable", async (request, reply) => {
  return setSourceRecipeStatus(request.params as { recipeId: string }, "disabled", reply);
});

api.get("/enrichment-providers", async (request) => {
  const { campaignId } = request.query as { campaignId?: string };
  const providers = await prisma.enrichmentProvider.findMany({
    where: campaignId ? { OR: [{ campaignId }, { campaignId: null }] } : undefined,
    orderBy: [{ status: "asc" }, { successCount: "desc" }, { updatedAt: "desc" }],
    take: 500
  });

  return {
    providers: providers.map(formatEnrichmentProvider),
    summary: summarizeSavedProviders(providers)
  };
});

api.get("/enrichment-providers/:providerId", async (request, reply) => {
  const { providerId } = request.params as { providerId: string };
  const provider = await prisma.enrichmentProvider.findUnique({ where: { id: providerId } });
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return formatEnrichmentProvider(provider);
});

api.post("/enrichment-providers", async (request, reply) => {
  const input = CreateEnrichmentProviderInputSchema.parse(request.body);
  if (input.campaignId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId } });
    if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
  }

  const providerConfig = EnrichmentProviderConfigSchema.parse(input);
  const provider = await prisma.enrichmentProvider.upsert({
    where: {
      name_version: {
        name: input.name,
        version: input.version
      }
    },
    update: {
      campaignId: input.campaignId ?? null,
      status: input.status,
      provider: providerConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    },
    create: {
      campaignId: input.campaignId,
      name: input.name,
      version: input.version,
      status: input.status,
      provider: providerConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    }
  });

  if (input.campaignId) {
    await prisma.campaignEvent.create({
      data: {
        campaignId: input.campaignId,
        type: "enrichment_provider_saved",
        message: `Enrichment provider ${input.name}@${input.version} saved for reuse.`,
        metadata: { source: "api", providerId: provider.id, status: provider.status }
      }
    });
  }

  return { provider: formatEnrichmentProvider(provider) };
});

api.post("/enrichment-providers/:providerId/status", async (request, reply) => {
  const { providerId } = request.params as { providerId: string };
  const input = UpdateSavedProviderStatusInputSchema.parse(request.body);
  const provider = await prisma.enrichmentProvider
    .update({
      where: { id: providerId },
      data: { status: input.status }
    })
    .catch(() => null);
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return { provider: formatEnrichmentProvider(provider) };
});

api.post("/enrichment-providers/:providerId/activate", async (request, reply) => {
  return setEnrichmentProviderStatus(request.params as { providerId: string }, "active", reply);
});

api.post("/enrichment-providers/:providerId/disable", async (request, reply) => {
  return setEnrichmentProviderStatus(request.params as { providerId: string }, "disabled", reply);
});

api.get("/email-verification-providers", async (request) => {
  const { campaignId } = request.query as { campaignId?: string };
  const providers = await prisma.emailVerificationProvider.findMany({
    where: campaignId ? { OR: [{ campaignId }, { campaignId: null }] } : undefined,
    orderBy: [{ status: "asc" }, { successCount: "desc" }, { updatedAt: "desc" }],
    take: 500
  });

  return {
    providers: providers.map(formatEmailVerificationProvider),
    summary: summarizeSavedProviders(providers)
  };
});

api.get("/email-verification-providers/:providerId", async (request, reply) => {
  const { providerId } = request.params as { providerId: string };
  const provider = await prisma.emailVerificationProvider.findUnique({ where: { id: providerId } });
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return formatEmailVerificationProvider(provider);
});

api.post("/email-verification-providers", async (request, reply) => {
  const input = CreateEmailVerificationProviderInputSchema.parse(request.body);
  if (input.campaignId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId } });
    if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
  }

  const providerConfig = EmailVerificationProviderConfigSchema.parse(input);
  const provider = await prisma.emailVerificationProvider.upsert({
    where: {
      name_version: {
        name: input.name,
        version: input.version
      }
    },
    update: {
      campaignId: input.campaignId ?? null,
      status: input.status,
      provider: providerConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    },
    create: {
      campaignId: input.campaignId,
      name: input.name,
      version: input.version,
      status: input.status,
      provider: providerConfig as Prisma.InputJsonValue,
      supportedDomains: normalizeSourceDomains(input.supportedDomains)
    }
  });

  if (input.campaignId) {
    await prisma.campaignEvent.create({
      data: {
        campaignId: input.campaignId,
        type: "email_verification_provider_saved",
        message: `Email verification provider ${input.name}@${input.version} saved for reuse.`,
        metadata: { source: "api", providerId: provider.id, status: provider.status }
      }
    });
  }

  return { provider: formatEmailVerificationProvider(provider) };
});

api.post("/email-verification-providers/:providerId/status", async (request, reply) => {
  const { providerId } = request.params as { providerId: string };
  const input = UpdateSavedProviderStatusInputSchema.parse(request.body);
  const provider = await prisma.emailVerificationProvider
    .update({
      where: { id: providerId },
      data: { status: input.status }
    })
    .catch(() => null);
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return { provider: formatEmailVerificationProvider(provider) };
});

api.post("/email-verification-providers/:providerId/activate", async (request, reply) => {
  return setEmailVerificationProviderStatus(request.params as { providerId: string }, "active", reply);
});

api.post("/email-verification-providers/:providerId/disable", async (request, reply) => {
  return setEmailVerificationProviderStatus(request.params as { providerId: string }, "disabled", reply);
});

api.get("/campaigns", async () => {
  const campaigns = await prisma.campaign.findMany({
    orderBy: {
      updatedAt: "desc"
    },
    take: 100
  });

  const enriched = await Promise.all(
    campaigns.map(async (campaign) => {
      const [leadCount, rankedLeadCount, sourceFailureCount] = await Promise.all([
        prisma.lead.count({ where: { campaignId: campaign.id } }),
        prisma.lead.count({ where: { campaignId: campaign.id, rank: { not: null } } }),
        prisma.sourceFailure.count({ where: { campaignId: campaign.id } })
      ]);
      const progress = normalizeProgress(campaign.progress);

      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        prompt: campaign.prompt,
        progress: {
          ...progress,
          discovered: Math.max(progress.discovered, leadCount),
          ranked: Math.max(progress.ranked, rankedLeadCount),
          errors: Math.max(progress.errors, sourceFailureCount)
        },
        createdAt: campaign.createdAt.toISOString(),
        updatedAt: campaign.updatedAt.toISOString()
      };
    })
  );

  return {
    campaigns: enriched,
    summary: summarizeCampaigns(enriched)
  };
});

api.get("/campaigns/:campaignId", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 50
      }
    }
  });

  if (!campaign) {
    reply.status(404).send({ error: "not_found" });
    return;
  }

  return {
    ...campaign,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null
  };
});

api.post("/campaigns", async (request) => {
  const input = CreateCampaignInputSchema.parse(request.body);
  const runtimeSettings = await readRuntimeSettings();
  const llm = new OpenAICompatibleLLMProvider({
    baseUrl: runtimeSettings.localLlmBaseUrl,
    model: runtimeSettings.localLlmModel,
    apiKey: runtimeSettings.localLlmApiKey
  });
  const plan = await planCampaign({ prompt: input.prompt, llm });
  const settings = {
    ...runtimeSettings,
    ...(input.serverUsagePercent ? { serverUsagePercent: input.serverUsagePercent } : {})
  };

  const campaign = await prisma.campaign.create({
    data: {
      name: input.name ?? plan.campaignName,
      prompt: input.prompt,
      promptVersion: "v1",
      status: "queued",
      plan: plan as Prisma.InputJsonValue,
      settings: settings as Prisma.InputJsonValue,
      targetLeadCount: input.targetLeadCount,
      serverUsagePercent: settings.serverUsagePercent,
      progress: emptyProgress(),
      jobs: {
        create: {
          type: "discovery",
          status: "queued",
          priority: 0,
          parameters: { source: "campaign_create" }
        }
      },
      events: {
        create: {
          type: "campaign_created",
          message: "Campaign created through API/MCP and queued for discovery.",
          metadata: { source: "api" }
        }
      }
    }
  });

  const discoveryJob = await prisma.researchJob.findFirst({
    where: {
      campaignId: campaign.id,
      type: "discovery"
    },
    orderBy: { createdAt: "desc" }
  });

  await enqueueDiscovery(campaign.id, plan, discoveryJob?.id);

  return {
    campaignId: campaign.id,
    status: campaign.status,
    name: campaign.name,
    plan,
    createdAt: campaign.createdAt.toISOString()
  };
});

api.post("/campaigns/:campaignId/pause", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const campaign = await updateCampaignStatus(campaignId, "paused");
  if (!campaign) return reply.status(404).send({ error: "not_found" });
  return { campaignId, status: campaign.status };
});

api.post("/campaigns/:campaignId/resume", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const campaign = await updateCampaignStatus(campaignId, "queued");
  if (!campaign) return reply.status(404).send({ error: "not_found" });
  const parsedPlan = CampaignPlanSchema.safeParse(campaign.plan);
  if (!parsedPlan.success) {
    reply.status(409).send({ error: "campaign_plan_missing" });
    return;
  }
  const researchJob = await prisma.researchJob.create({
    data: {
      campaignId: campaign.id,
      type: "discovery",
      status: "queued",
      priority: 0,
      parameters: { source: "campaign_resume" }
    }
  });
  await enqueueDiscovery(campaign.id, parsedPlan.data, researchJob.id);
  return { campaignId, status: campaign.status };
});

api.post("/campaigns/:campaignId/cancel", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const campaign = await updateCampaignStatus(campaignId, "cancelled");
  if (!campaign) return reply.status(404).send({ error: "not_found" });
  return { campaignId, status: campaign.status };
});

api.get("/campaigns/:campaignId/leads", async (request) => {
  const { campaignId } = request.params as { campaignId: string };
  const leads = await prisma.lead.findMany({
    where: { campaignId },
    include: {
      company: true,
      evidence: {
        take: 5,
        orderBy: { retrievedAt: "desc" }
      }
    },
    orderBy: [{ rank: "asc" }, { score: "desc" }, { updatedAt: "desc" }],
    take: 200
  });

  return {
    leads: leads.map((lead) => ({
      id: lead.id,
      campaignId: lead.campaignId,
      rank: lead.rank,
      score: lead.score,
      confidence: lead.confidence,
      strongestSignal: lead.strongestSignal,
      status: lead.status,
      companyName: lead.company?.companyName ?? "Unknown company",
      website: lead.company?.website,
      emails: readJsonStringArray(lead.company?.emails),
      owners: readJsonPeople(lead.company?.owners),
      managers: readJsonPeople(lead.company?.managers),
      location: [lead.company?.city, lead.company?.state, lead.company?.country].filter(Boolean).join(", "),
      exportSnapshot: lead.exportSnapshot,
      evidence: lead.evidence.map((evidence) => ({
        id: evidence.id,
        field: evidence.field,
        url: evidence.url,
        quote: evidence.quote
      }))
    }))
  };
});

api.get("/leads/:leadId/evidence", async (request, reply) => {
  const { leadId } = request.params as { leadId: string };
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      company: true,
      evidence: {
        orderBy: { retrievedAt: "desc" }
      },
      claims: {
        orderBy: { createdAt: "desc" }
      }
    }
  });

  if (!lead) return reply.status(404).send({ error: "not_found" });
  return lead;
});

api.get("/campaigns/:campaignId/export.csv", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const leads = await prisma.lead.findMany({
    where: { campaignId },
    include: {
      company: true,
      evidence: {
        take: 5,
        orderBy: { retrievedAt: "desc" }
      }
    },
    orderBy: [{ rank: "asc" }, { score: "desc" }, { updatedAt: "desc" }]
  });

  reply.header("content-type", "text/csv; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="campaign-${campaignId}-leads.csv"`);

  return toCsv([
    [
      "rank",
      "company",
      "website",
      "location",
      "public_emails",
      "owners",
      "managers",
      "score",
      "confidence",
      "strongest_signal",
      "evidence"
    ],
    ...leads.map((lead) => [
      lead.rank ?? "",
      lead.company?.companyName ?? "Unknown company",
      lead.company?.website ?? "",
      [lead.company?.city, lead.company?.state, lead.company?.country].filter(Boolean).join(", "),
      readJsonStringArray(lead.company?.emails).join(" | "),
      readJsonPeople(lead.company?.owners)
        .map((person) => `${person.name}${person.role ? ` (${person.role})` : ""}${person.email ? ` <${person.email}>` : ""}`)
        .join(" | "),
      readJsonPeople(lead.company?.managers)
        .map((person) => `${person.name}${person.role ? ` (${person.role})` : ""}${person.email ? ` <${person.email}>` : ""}`)
        .join(" | "),
      lead.score,
      lead.confidence,
      lead.strongestSignal ?? "",
      lead.evidence.map((evidence) => `${evidence.id}: ${evidence.url}`).join(" | ")
    ])
  ]);
});

api.post("/proxies/parse", async (request) => {
  const body = ProxyUploadSchema.parse(request.body);
  const parsed = parseProxyText(body.text ?? "");
  return {
    accepted: parsed.proxies.length,
    rejected: parsed.errors.length,
    proxies: parsed.proxies,
    errors: parsed.errors
  };
});

api.post("/proxies/upload", async (request) => {
  const body = ProxyUploadSchema.parse(request.body);
  const parsed = parseProxyText(body.text ?? "");
  const saved = [];

  for (const proxy of parsed.proxies) {
    const record = await prisma.proxy.upsert({
      where: {
        protocol_host_port_username: {
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username ?? ""
        }
      },
      update: {
        passwordEncrypted: proxy.password,
        status: "untested",
        label: proxy.label
      },
      create: {
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username ?? "",
        passwordEncrypted: proxy.password,
        status: "untested",
        label: proxy.label
      }
    });
    saved.push({ id: record.id, protocol: record.protocol, host: record.host, port: record.port });
  }

  return {
    accepted: saved.length,
    rejected: parsed.errors.length,
    proxies: saved,
    errors: parsed.errors
  };
});

api.get("/proxies", async () => {
  const proxies = await prisma.proxy.findMany({
    orderBy: [{ status: "asc" }, { healthScore: "desc" }],
    take: 500
  });

  return {
    proxies: proxies.map((proxy) => ({
      id: proxy.id,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      status: proxy.status,
      successes: proxy.successes,
      failures: proxy.failures,
      averageLatencyMs: proxy.averageLatencyMs,
      healthScore: proxy.healthScore,
      lastUsedAt: proxy.lastUsedAt?.toISOString() ?? null,
      cooldownUntil: proxy.cooldownUntil?.toISOString() ?? null
    })),
    summary: {
      total: proxies.length,
      healthy: proxies.filter((proxy) => proxy.status === "healthy").length,
      untested: proxies.filter((proxy) => proxy.status === "untested").length,
      degraded: proxies.filter((proxy) => proxy.status === "degraded").length,
      quarantined: proxies.filter((proxy) => proxy.status === "quarantined").length
    }
  };
});

const port = Number(process.env.API_PORT ?? 4000);
await api.listen({ port, host: "0.0.0.0" });

async function handleRemoteMcpRequest(request: FastifyRequest, reply: FastifyReply) {
  const settings = await readRuntimeSettings();
  const bearerToken = settings.mcpBearerToken.trim();
  if (bearerToken) {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (authorization !== `Bearer ${bearerToken}`) {
      return reply.status(401).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized"
        },
        id: null
      });
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  const server = createLeadResearchMcpServer({
    apiBaseUrl: internalApiBaseUrl(),
    publicApiBaseUrl: publicApiBaseUrl(request)
  });

  reply.hijack();
  reply.raw.once("close", () => {
    void Promise.allSettled([transport.close(), server.close()]);
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    api.log.error({ err: error }, "Remote MCP request failed");
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        })
      );
    } else if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
}

function internalApiBaseUrl(): string {
  const configured = process.env.MCP_INTERNAL_API_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `http://127.0.0.1:${process.env.API_PORT ?? process.env.PORT ?? 4000}`;
}

function publicApiBaseUrl(request: FastifyRequest): string {
  const explicit = firstHeader(request.headers["x-leadfactory-public-api-base-url"]);
  if (explicit) return explicit.replace(/\/$/, "");

  const configured = process.env.MCP_PUBLIC_API_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");

  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost ?? firstHeader(request.headers.host);
  if (!host) return internalApiBaseUrl();

  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]) ?? "https";
  const requestPath = request.url.split("?")[0]?.replace(/\/+$/, "") || "";
  const apiPath = requestPath.endsWith("/mcp") ? requestPath.slice(0, -"/mcp".length) : "";
  return `${forwardedProto}://${host}${apiPath}`.replace(/\/$/, "");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function emptyProgress() {
  return {
    percent: 0,
    discovered: 0,
    researched: 0,
    ranked: 0,
    errors: 0
  };
}

function normalizeProgress(value: unknown): ReturnType<typeof emptyProgress> {
  if (!value || typeof value !== "object") return emptyProgress();
  const progress = value as Partial<ReturnType<typeof emptyProgress>>;
  return {
    percent: Number(progress.percent ?? 0),
    discovered: Number(progress.discovered ?? 0),
    researched: Number(progress.researched ?? 0),
    ranked: Number(progress.ranked ?? 0),
    errors: Number(progress.errors ?? 0)
  };
}

async function setSourceRecipeStatus(
  params: { recipeId: string },
  status: "trial" | "active" | "disabled",
  reply: FastifyReply
) {
  const recipe = await prisma.sourceRecipe
    .update({
      where: { id: params.recipeId },
      data: { status }
    })
    .catch(() => null);
  if (!recipe) return reply.status(404).send({ error: "not_found" });
  return { sourceRecipe: formatSourceRecipe(recipe) };
}

async function setEnrichmentProviderStatus(
  params: { providerId: string },
  status: "trial" | "active" | "disabled",
  reply: FastifyReply
) {
  const provider = await prisma.enrichmentProvider
    .update({
      where: { id: params.providerId },
      data: { status }
    })
    .catch(() => null);
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return { provider: formatEnrichmentProvider(provider) };
}

async function setEmailVerificationProviderStatus(
  params: { providerId: string },
  status: "trial" | "active" | "disabled",
  reply: FastifyReply
) {
  const provider = await prisma.emailVerificationProvider
    .update({
      where: { id: params.providerId },
      data: { status }
    })
    .catch(() => null);
  if (!provider) return reply.status(404).send({ error: "not_found" });
  return { provider: formatEmailVerificationProvider(provider) };
}

function formatSourceRecipe(recipe: {
  id: string;
  campaignId: string | null;
  name: string;
  version: string;
  status: string;
  recipe: Prisma.JsonValue;
  supportedDomains: string[];
  successCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  const parsedConfig = SourceRecipeConfigSchema.safeParse(recipe.recipe);
  const config = parsedConfig.success
    ? parsedConfig.data
    : SourceRecipeConfigSchema.parse({
        description: "Stored recipe could not be parsed. Save a fresh version before activating.",
        steps: []
      });

  return {
    id: recipe.id,
    campaignId: recipe.campaignId,
    generatedFromCampaignId: recipe.campaignId ?? undefined,
    name: recipe.name,
    version: recipe.version,
    status: normalizeSourceRecipeStatus(recipe.status),
    supportedDomains: recipe.supportedDomains,
    successCount: recipe.successCount,
    failureCount: recipe.failureCount,
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
    ...config
  };
}

function formatEnrichmentProvider(provider: {
  id: string;
  campaignId: string | null;
  name: string;
  version: string;
  status: string;
  provider: Prisma.JsonValue;
  supportedDomains: string[];
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const parsedConfig = EnrichmentProviderConfigSchema.safeParse(provider.provider);
  const config = parsedConfig.success
    ? parsedConfig.data
    : EnrichmentProviderConfigSchema.parse({
        description: "Stored provider could not be parsed. Save a fresh version before activating.",
        request: { urlTemplate: "https://invalid.local" }
      });

  return {
    id: provider.id,
    campaignId: provider.campaignId,
    generatedFromCampaignId: provider.campaignId ?? undefined,
    name: provider.name,
    version: provider.version,
    status: normalizeSourceRecipeStatus(provider.status),
    supportedDomains: provider.supportedDomains,
    successCount: provider.successCount,
    failureCount: provider.failureCount,
    missingEnvVars: config.requiredEnvVars.filter((name) => !process.env[name]),
    lastUsedAt: provider.lastUsedAt?.toISOString() ?? null,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
    ...config
  };
}

function formatEmailVerificationProvider(provider: {
  id: string;
  campaignId: string | null;
  name: string;
  version: string;
  status: string;
  provider: Prisma.JsonValue;
  supportedDomains: string[];
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const parsedConfig = EmailVerificationProviderConfigSchema.safeParse(provider.provider);
  const config = parsedConfig.success
    ? parsedConfig.data
    : EmailVerificationProviderConfigSchema.parse({
        description: "Stored provider could not be parsed. Save a fresh version before activating.",
        request: { urlTemplate: "https://invalid.local" }
      });

  return {
    id: provider.id,
    campaignId: provider.campaignId,
    generatedFromCampaignId: provider.campaignId ?? undefined,
    name: provider.name,
    version: provider.version,
    status: normalizeSourceRecipeStatus(provider.status),
    supportedDomains: provider.supportedDomains,
    successCount: provider.successCount,
    failureCount: provider.failureCount,
    missingEnvVars: config.requiredEnvVars.filter((name) => !process.env[name]),
    lastUsedAt: provider.lastUsedAt?.toISOString() ?? null,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
    ...config
  };
}

function summarizeSavedProviders(providers: Array<{ status: string; successCount: number; failureCount: number }>) {
  return {
    total: providers.length,
    active: providers.filter((provider) => provider.status === "active").length,
    trial: providers.filter((provider) => provider.status === "trial").length,
    disabled: providers.filter((provider) => provider.status === "disabled").length,
    successes: providers.reduce((total, provider) => total + provider.successCount, 0),
    failures: providers.reduce((total, provider) => total + provider.failureCount, 0)
  };
}

function normalizeSourceRecipeStatus(status: string): "trial" | "active" | "disabled" {
  if (status === "active" || status === "disabled" || status === "trial") return status;
  return "trial";
}

function normalizeSourceDomains(domains: string[]): string[] {
  return [
    ...new Set(
      domains
        .map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
        .filter(Boolean)
    )
  ];
}

function summarizeCampaigns(campaigns: Array<{ status: string; progress: ReturnType<typeof emptyProgress> }>) {
  return {
    total: campaigns.length,
    queued: campaigns.filter((campaign) => campaign.status === "queued").length,
    running: campaigns.filter((campaign) => campaign.status === "running").length,
    paused: campaigns.filter((campaign) => campaign.status === "paused").length,
    completed: campaigns.filter((campaign) => campaign.status === "completed").length,
    failed: campaigns.filter((campaign) => campaign.status === "failed").length,
    rankedLeads: campaigns.reduce((total, campaign) => total + campaign.progress.ranked, 0),
    errors: campaigns.reduce((total, campaign) => total + campaign.progress.errors, 0)
  };
}

async function enqueueDiscovery(campaignId: string, plan: CampaignPlan, researchJobId?: string) {
  const settings = await readRuntimeSettings();
  const queue = createQueue<BrowserResearchPayload>(queueNames.discovery, settings.redisUrl);
  try {
    await queue.add(
      "discover_candidates",
      {
        campaignId,
        researchJobId,
        task: "discover_candidates",
        proxyStrategy: "auto",
        query: buildPrimaryQuery(plan)
      },
      {
        jobId: `campaign_${campaignId}_discover_${Date.now()}`
      }
    );
  } finally {
    await queue.close();
  }
}

async function updateCampaignStatus(campaignId: string, status: "paused" | "queued" | "cancelled") {
  const existing = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!existing) return null;

  return prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status,
      events: {
        create: {
          type: `campaign_${status}`,
          message: `Campaign marked ${status}.`,
          metadata: { source: "api" }
        }
      }
    }
  });
}

function buildPrimaryQuery(plan: CampaignPlan): string {
  const geography = plan.geography.slice(0, 3).join(" ");
  const signal = plan.positiveSignals.slice(0, 2).join(" ");
  return [plan.icpDescription, geography, signal].filter(Boolean).join(" ");
}

function readJsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readJsonPeople(value: unknown): Array<{ name: string; role?: string; email?: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is { name: string; role?: string; email?: string } =>
      Boolean(item) && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
  );
}

function toCsv(rows: Array<Array<unknown>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(",")
    )
    .join("\n");
}
