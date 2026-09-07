import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { parse as parseCsv } from "csv-parse/sync";
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
  ImportCampaignCsvInputSchema,
  ProxyUploadSchema,
  RuntimeSettingsUpdateSchema,
  SendreadExportInputSchema,
  type CampaignPlan,
  type CreateCampaignInput,
  type ImportCampaignCsvInput,
  type SendreadDestinationType,
  type SendreadExportInput
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
const maskedSecret = "********";

class SendreadApiError extends Error {
  constructor(readonly statusCode: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

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

  if (error instanceof SendreadApiError) {
    reply.status(error.statusCode).send({
      error: "sendread_error",
      message: error.message,
      body: error.body
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
    settings: maskRuntimeSecrets(await readRuntimeSettings()),
    defaults: defaultRuntimeSettings()
  };
});

api.post("/settings/runtime", async (request) => {
  const input = RuntimeSettingsUpdateSchema.parse(preserveMaskedRuntimeSecrets(request.body ?? {}));
  return {
    settings: maskRuntimeSecrets(await updateRuntimeSettings(input)),
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

  return { capacity, limits, settings: maskRuntimeSecrets(settings) };
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
  const plannedCampaign = await planCampaign({ prompt: input.prompt, llm, name: input.name });
  const plan = applyCampaignSourceOverrides(plannedCampaign, input);
  const settings = {
    ...runtimeSettings,
    ...(input.serverUsagePercent ? { serverUsagePercent: input.serverUsagePercent } : {}),
    sourceRecipeIds: plan.sourceRecipeIds,
    sourceRecipeNames: plan.sourceRecipeNames,
    strictSourceRecipes: plan.strictSourceRecipes
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
          metadata: {
            source: "api",
            sourceRecipeIds: plan.sourceRecipeIds,
            sourceRecipeNames: plan.sourceRecipeNames,
            strictSourceRecipes: plan.strictSourceRecipes
          }
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

api.post("/campaigns/:campaignId/import-csv", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const input = ImportCampaignCsvInputSchema.parse(request.body ?? {});
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  let rows: CsvRow[];
  try {
    rows = parseCampaignCsv(input.csvText);
  } catch (error) {
    return reply.status(400).send({
      error: "invalid_csv",
      message: error instanceof Error ? error.message : "CSV could not be parsed"
    });
  }

  const importResult = await importCampaignCsvRows(campaignId, rows, input);
  await rerankCampaign(campaignId);
  await refreshCampaignProgress(campaignId);

  return {
    campaignId,
    ...importResult
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

api.get("/sendread/campaigns", async () => {
  return sendreadRequest("/api/public/campaigns");
});

api.get("/sendread/ab-test-lists", async () => {
  return sendreadRequest("/api/public/ab-test-lists");
});

api.get("/sendread/ab-test-lists/:listId/leads", async (request) => {
  const { listId } = request.params as { listId: string };
  return sendreadRequest(`/api/public/ab-test-lists/${encodeURIComponent(listId)}/leads`);
});

api.post("/campaigns/:campaignId/sendread/export", async (request, reply) => {
  const { campaignId } = request.params as { campaignId: string };
  const input = SendreadExportInputSchema.parse(request.body ?? {});
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const leads = await buildSendreadLeads(campaignId, campaign.name, input);
  if (!input.dryRun && leads.payload.length === 0) {
    return reply.status(409).send({
      error: "no_exportable_leads",
      message: "No leads with public emails matched the export filters.",
      skippedNoEmail: leads.skippedNoEmail
    });
  }

  if (input.dryRun) {
    return {
      campaignId,
      destinationType: input.destinationType,
      destinationId: input.destinationId,
      dryRun: true,
      selected: leads.payload.length,
      skippedNoEmail: leads.skippedNoEmail,
      leads: leads.payload.slice(0, 25)
    };
  }

  const endpoint = sendreadLeadPushPath(input.destinationType, input.destinationId);
  const response = await sendreadRequest(endpoint, {
    method: "POST",
    body: { leads: leads.payload }
  });

  await prisma.campaignEvent.create({
    data: {
      campaignId,
      type: "sendread_exported",
      message: `Exported ${leads.payload.length} leads to Sendread ${input.destinationType}.`,
      metadata: toInputJson({
        destinationType: input.destinationType,
        destinationId: input.destinationId,
        selected: leads.payload.length,
        skippedNoEmail: leads.skippedNoEmail,
        response
      })
    }
  });

  return {
    campaignId,
    destinationType: input.destinationType,
    destinationId: input.destinationId,
    exported: leads.payload.length,
    skippedNoEmail: leads.skippedNoEmail,
    response
  };
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

function maskRuntimeSecrets(settings: Awaited<ReturnType<typeof readRuntimeSettings>>) {
  return {
    ...settings,
    sendreadApiKey: settings.sendreadApiKey ? maskedSecret : ""
  };
}

function preserveMaskedRuntimeSecrets(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const patch = { ...(body as Record<string, unknown>) };
  if (patch.sendreadApiKey === maskedSecret) {
    delete patch.sendreadApiKey;
  }
  return patch;
}

type CsvRow = Record<string, string>;

type ImportedPerson = {
  name: string;
  role: string;
  email?: string;
};

type ImportedLeadRecord = {
  companyName: string;
  normalizedName: string;
  website?: string;
  domain?: string;
  sourceUrl?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  emails: string[];
  owners: ImportedPerson[];
  managers: ImportedPerson[];
  decisionMakers: ImportedPerson[];
  googleReviewCount?: number;
  score?: number;
  confidence?: number;
  rank?: number;
  raw: CsvRow;
};

function applyCampaignSourceOverrides(plan: CampaignPlan, input: CreateCampaignInput): CampaignPlan {
  const sourceRecipeIds = uniqueTrimmedStrings(input.sourceRecipeIds ?? plan.sourceRecipeIds);
  const sourceRecipeNames = uniqueTrimmedStrings(input.sourceRecipeNames ?? plan.sourceRecipeNames);
  const hasPinnedRecipes = sourceRecipeIds.length > 0 || sourceRecipeNames.length > 0;

  return CampaignPlanSchema.parse({
    ...plan,
    sourceRecipeIds,
    sourceRecipeNames,
    strictSourceRecipes: input.strictSourceRecipes ?? (hasPinnedRecipes ? true : plan.strictSourceRecipes)
  });
}

function parseCampaignCsv(csvText: string): CsvRow[] {
  return parseCsv(csvText, {
    bom: true,
    columns: true,
    relaxColumnCount: true,
    relaxQuotes: true,
    skipEmptyLines: true,
    trim: true
  }) as CsvRow[];
}

async function importCampaignCsvRows(campaignId: string, rows: CsvRow[], input: ImportCampaignCsvInput) {
  const results: Array<{
    rowNumber: number;
    leadId: string;
    companyId: string;
    companyName: string;
    createdLead: boolean;
    score: number;
  }> = [];
  const skipped: Array<{ rowNumber: number; reason: string }> = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const parsed = parseImportedLeadRow(row);
    if (!parsed) {
      skipped.push({ rowNumber, reason: "missing company name, website, or source URL" });
      continue;
    }

    const imported = await upsertImportedLead(campaignId, parsed, input, rowNumber);
    results.push({
      rowNumber,
      leadId: imported.leadId,
      companyId: imported.companyId,
      companyName: parsed.companyName,
      createdLead: imported.createdLead,
      score: imported.score
    });
  }

  return {
    rows: rows.length,
    imported: results.length,
    created: results.filter((result) => result.createdLead).length,
    updated: results.filter((result) => !result.createdLead).length,
    skipped,
    leads: results.slice(0, 25)
  };
}

function parseImportedLeadRow(row: CsvRow): ImportedLeadRecord | null {
  const lookup = createCsvLookup(row);
  const pick = (aliases: string[]) => pickCsvValue(lookup, aliases);
  const sourceUrl = normalizeInputUrl(
    pick([
      "source_url",
      "source",
      "profile_url",
      "profile",
      "business_profile",
      "google_maps_url",
      "google_map_url",
      "maps_url",
      "listing_url",
      "url"
    ])
  );
  const explicitWebsite = normalizeInputUrl(
    pick(["website", "company_website", "business_website", "site", "homepage", "web"])
  );
  const website = explicitWebsite ?? (sourceUrl && !isBusinessProfileUrl(sourceUrl) ? sourceUrl : undefined);
  const domain = normalizeDomain(pick(["domain", "company_domain", "business_domain"])) ?? domainFromUrl(website);
  const fallbackUrl = website ?? sourceUrl;
  const companyName =
    pick(["company", "company_name", "companyname", "business", "business_name", "businessname", "name"]) ??
    inferNameFromUrl(fallbackUrl);

  if (!companyName) return null;

  const location = pick(["location", "address", "city_state", "citystate"]);
  const locationParts = location?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  const city = pick(["city", "town", "locality"]) ?? (locationParts.length >= 2 ? locationParts[0] : undefined);
  const state = pick(["state", "province", "region"]) ?? inferStateFromLocation(locationParts);
  const country = pick(["country"]) ?? (locationParts.length >= 3 ? locationParts[2] : undefined);
  const emails = uniqueTrimmedStrings([
    ...extractEmailsFromText(pick(["email", "emails", "public_email", "public_emails", "business_email", "contact_email"]) ?? ""),
    ...extractEmailsFromText(JSON.stringify(row))
  ]);
  const owners = parsePeople(pick(["owner", "owners", "owner_name", "owner_names", "founder", "founders"]), "owner");
  const managers = parsePeople(pick(["manager", "managers", "manager_name", "manager_names"]), "manager");
  const decisionMakers = parsePeople(
    pick(["decision_maker", "decision_makers", "decisionmaker", "contact", "contacts", "person", "people"]),
    "decision maker"
  );
  const googleReviewCount = parseIntegerCell(
    pick([
      "googleReviewCount",
      "google_review_count",
      "google_reviews_count",
      "google_reviews",
      "reviewCount",
      "review_count",
      "reviews"
    ])
  );
  const score = clampInteger(parseIntegerCell(pick(["score", "lead_score", "rank_score"])), 0, 100);
  const confidence = parseConfidenceCell(pick(["confidence", "confidence_score"]));
  const rank = clampInteger(parseIntegerCell(pick(["rank", "ranking"])), 1, 100000);

  return {
    companyName: companyName.slice(0, 160),
    normalizedName: normalizeCompanyName(companyName),
    website: website && !isBusinessProfileUrl(website) ? website : undefined,
    domain: domain && !isBusinessProfileDomain(domain) ? domain : undefined,
    sourceUrl,
    phone: pick(["phone", "phone_number", "telephone", "business_phone"]),
    city,
    state,
    country,
    emails,
    owners,
    managers,
    decisionMakers,
    googleReviewCount,
    score,
    confidence,
    rank,
    raw: normalizeCsvRow(row)
  };
}

async function upsertImportedLead(
  campaignId: string,
  record: ImportedLeadRecord,
  input: ImportCampaignCsvInput,
  rowNumber: number
) {
  const company = await upsertImportedCompany(record, input, rowNumber);
  const existingLead = await prisma.lead.findFirst({
    where: {
      campaignId,
      companyId: company.id
    }
  });
  const confidence = record.confidence ?? estimateImportConfidence(record);
  const score = input.markRanked ? record.score ?? calculateImportedScore(record) : existingLead?.score ?? 0;
  const status = input.markRanked ? "ranked" : "researched";
  const signal = strongestImportedSignal(record);
  const exportSnapshot = toInputJson({
    companyName: record.companyName,
    website: record.website,
    location: [record.city, record.state, record.country].filter(Boolean).join(", "),
    publicEmails: record.emails,
    owners: record.owners,
    managers: mergePeople(record.managers, record.decisionMakers),
    googleReviewCount: record.googleReviewCount,
    importedCsv: {
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      rowNumber,
      raw: record.raw
    }
  });
  const scoreComponents = toInputJson({
    importedCsv: true,
    sourceName: input.sourceName,
    rowNumber,
    googleReviewCount: record.googleReviewCount,
    evidence: "Imported by Codex/MCP from a verified CSV scrape."
  });
  const lead = existingLead
    ? await prisma.lead.update({
        where: { id: existingLead.id },
        data: {
          status,
          score: Math.max(existingLead.score, score),
          confidence: Math.max(existingLead.confidence, confidence),
          strongestSignal: existingLead.strongestSignal ?? signal,
          scoreComponents,
          rank: record.rank ?? existingLead.rank,
          exportSnapshot
        }
      })
    : await prisma.lead.create({
        data: {
          campaignId,
          companyId: company.id,
          status,
          score,
          confidence,
          strongestSignal: signal,
          scoreComponents,
          rank: record.rank,
          exportSnapshot
        }
      });

  const evidenceIds = await createImportedEvidence(campaignId, company.id, lead.id, record, input, rowNumber);
  await createImportClaims(campaignId, company.id, lead.id, record, evidenceIds);

  return {
    leadId: lead.id,
    companyId: company.id,
    createdLead: !existingLead,
    score
  };
}

async function upsertImportedCompany(record: ImportedLeadRecord, input: ImportCampaignCsvInput, rowNumber: number) {
  const companyFilters: Prisma.CompanyWhereInput[] = [];
  if (record.website) companyFilters.push({ website: record.website });
  if (record.domain) companyFilters.push({ domain: record.domain });
  if (record.normalizedName && (record.city || record.state)) {
    companyFilters.push({
      normalizedName: record.normalizedName,
      ...(record.city ? { city: record.city } : {}),
      ...(record.state ? { state: record.state } : {})
    });
  }

  const existingCompany = companyFilters.length
    ? await prisma.company.findFirst({
        where: { OR: companyFilters }
      })
    : null;
  const people = mergePeople(record.managers, record.decisionMakers);
  const metadata = toInputJson({
    ...readJsonObject(existingCompany?.metadata),
    csvImport: {
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      rowNumber,
      googleReviewCount: record.googleReviewCount,
      importedAt: new Date().toISOString(),
      raw: record.raw
    }
  });

  if (existingCompany) {
    const emails = mergeStringArrays(readJsonStringArray(existingCompany.emails), record.emails);
    const owners = mergePeople(readJsonPeople(existingCompany.owners), record.owners);
    const managers = mergePeople(readJsonPeople(existingCompany.managers), people);
    return prisma.company.update({
      where: { id: existingCompany.id },
      data: {
        companyName: existingCompany.companyName || record.companyName,
        normalizedName: existingCompany.normalizedName ?? record.normalizedName,
        domain: existingCompany.domain ?? record.domain,
        website: existingCompany.website ?? record.website,
        city: existingCompany.city ?? record.city,
        state: existingCompany.state ?? record.state,
        country: existingCompany.country ?? record.country,
        phone: existingCompany.phone ?? record.phone,
        generalEmail: existingCompany.generalEmail ?? emails[0],
        emails: emails.length ? toInputJson(emails) : undefined,
        owners: owners.length ? toInputJson(owners) : undefined,
        managers: managers.length ? toInputJson(managers) : undefined,
        metadata,
        lastCheckedAt: new Date()
      }
    });
  }

  return prisma.company.create({
    data: {
      companyName: record.companyName,
      normalizedName: record.normalizedName,
      domain: record.domain,
      website: record.website,
      city: record.city,
      state: record.state,
      country: record.country,
      phone: record.phone,
      generalEmail: record.emails[0],
      emails: record.emails.length ? toInputJson(record.emails) : undefined,
      owners: record.owners.length ? toInputJson(record.owners) : undefined,
      managers: people.length ? toInputJson(people) : undefined,
      metadata,
      lastCheckedAt: new Date()
    }
  });
}

async function createImportedEvidence(
  campaignId: string,
  companyId: string,
  leadId: string,
  record: ImportedLeadRecord,
  input: ImportCampaignCsvInput,
  rowNumber: number
): Promise<string[]> {
  const evidenceIds: string[] = [];
  const evidenceUrl = record.sourceUrl ?? input.sourceUrl ?? record.website ?? "manual://csv-import";
  const sourceType = inferImportSourceType(evidenceUrl, input.sourceName);
  const baseEvidence = await createManualEvidence({
    campaignId,
    companyId,
    leadId,
    field: "imported_csv_row",
    sourceType,
    url: evidenceUrl,
    quote: `Imported verified row ${rowNumber} from ${input.sourceName}: ${record.companyName}`,
    metadata: toInputJson({
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      rowNumber,
      raw: record.raw
    })
  });
  if (baseEvidence) evidenceIds.push(baseEvidence.id);

  if (record.website) {
    const evidence = await createManualEvidence({
      campaignId,
      companyId,
      leadId,
      field: "company_website",
      sourceType: "company_website",
      url: record.website,
      quote: `${record.companyName} website: ${record.website}`
    });
    if (evidence) evidenceIds.push(evidence.id);
  }

  for (const email of record.emails.slice(0, 20)) {
    const evidence = await createManualEvidence({
      campaignId,
      companyId,
      leadId,
      field: "public_email",
      sourceType,
      url: evidenceUrl,
      quote: `${record.companyName} published business email: ${email}`
    });
    if (evidence) evidenceIds.push(evidence.id);
  }

  for (const person of mergePeople(record.owners, record.managers, record.decisionMakers).slice(0, 20)) {
    const evidence = await createManualEvidence({
      campaignId,
      companyId,
      leadId,
      field: "owner_manager_name",
      sourceType,
      url: evidenceUrl,
      quote: `${person.name} - ${person.role}`
    });
    if (evidence) evidenceIds.push(evidence.id);
  }

  if (typeof record.googleReviewCount === "number") {
    const evidence = await createManualEvidence({
      campaignId,
      companyId,
      leadId,
      field: "googleReviewCount",
      sourceType: "business_profile",
      url: evidenceUrl,
      quote: `${record.companyName} has ${record.googleReviewCount} Google reviews`
    });
    if (evidence) evidenceIds.push(evidence.id);
  }

  return evidenceIds;
}

async function createManualEvidence(params: {
  campaignId: string;
  companyId: string;
  leadId: string;
  field: string;
  sourceType: string;
  url: string;
  quote: string;
  metadata?: Prisma.InputJsonValue;
}) {
  const quote = normalizeWhitespace(params.quote).slice(0, 1500);
  if (!quote) return null;

  const existing = await prisma.evidence.findFirst({
    where: {
      campaignId: params.campaignId,
      leadId: params.leadId,
      field: params.field,
      url: params.url,
      quote
    }
  });
  if (existing) return existing;

  return prisma.evidence.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      field: params.field,
      sourceType: params.sourceType,
      retrievalMethod: "manual",
      url: params.url,
      finalUrl: params.url,
      quote,
      contentHash: hashText(quote),
      metadata: params.metadata
    }
  });
}

async function createImportClaims(
  campaignId: string,
  companyId: string,
  leadId: string,
  record: ImportedLeadRecord,
  evidenceIds: string[]
) {
  await upsertImportClaim({
    campaignId,
    companyId,
    leadId,
    field: "icp_fit",
    value: true,
    confidence: record.confidence ?? estimateImportConfidence(record),
    evidenceIds
  });

  if (record.website) {
    await upsertImportClaim({
      campaignId,
      companyId,
      leadId,
      field: "company_website",
      value: record.website,
      confidence: 0.9,
      evidenceIds
    });
  }

  if (record.emails[0]) {
    await upsertImportClaim({
      campaignId,
      companyId,
      leadId,
      field: "public_email",
      value: record.emails[0],
      confidence: 0.85,
      evidenceIds
    });
  }

  const decisionMaker = mergePeople(record.owners, record.managers, record.decisionMakers)[0];
  if (decisionMaker) {
    await upsertImportClaim({
      campaignId,
      companyId,
      leadId,
      field: "owner_manager_name",
      value: decisionMaker.name,
      confidence: 0.85,
      evidenceIds
    });
  }

  if (typeof record.googleReviewCount === "number") {
    await upsertImportClaim({
      campaignId,
      companyId,
      leadId,
      field: "googleReviewCount",
      value: record.googleReviewCount,
      confidence: 0.9,
      evidenceIds
    });
  }
}

async function upsertImportClaim(params: {
  campaignId: string;
  companyId: string;
  leadId: string;
  field: string;
  value: unknown;
  confidence: number;
  evidenceIds: string[];
}) {
  const existing = await prisma.claim.findFirst({
    where: {
      campaignId: params.campaignId,
      leadId: params.leadId,
      field: params.field,
      promptName: "csv_import"
    }
  });
  const data = {
    companyId: params.companyId,
    value: toInputJson(params.value),
    confidence: Math.max(0, Math.min(1, params.confidence)),
    evidenceIds: params.evidenceIds,
    promptName: "csv_import",
    promptVersion: "v1",
    model: "manual_csv_import",
    analysisVersion: "csv-import-v1"
  };

  if (existing) {
    return prisma.claim.update({
      where: { id: existing.id },
      data
    });
  }

  return prisma.claim.create({
    data: {
      campaignId: params.campaignId,
      leadId: params.leadId,
      field: params.field,
      ...data
    }
  });
}

async function rerankCampaign(campaignId: string) {
  const leads = await prisma.lead.findMany({
    where: { campaignId, disqualified: false, status: "ranked" },
    orderBy: [{ score: "desc" }, { confidence: "desc" }, { updatedAt: "asc" }]
  });

  await prisma.$transaction(
    leads.map((lead, index) =>
      prisma.lead.update({
        where: { id: lead.id },
        data: { rank: index + 1 }
      })
    )
  );
}

async function refreshCampaignProgress(campaignId: string) {
  const [campaign, discovered, researched, ranked, errors] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId } }),
    prisma.lead.count({ where: { campaignId } }),
    prisma.lead.count({ where: { campaignId, status: { in: ["researched", "ranked"] } } }),
    prisma.lead.count({ where: { campaignId, rank: { not: null } } }),
    prisma.sourceFailure.count({ where: { campaignId } })
  ]);
  if (!campaign) return;

  const target = Math.max(1, campaign.targetLeadCount ?? Math.max(discovered, 25));
  const weightedUnits = discovered * 0.2 + researched * 0.35 + ranked * 0.45;
  const percent = Math.min(campaign.status === "completed" ? 100 : 99, Math.round((weightedUnits / target) * 100));

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      progress: {
        percent,
        discovered,
        researched,
        ranked,
        errors
      },
      events: {
        create: {
          type: "campaign_csv_imported",
          message: `Imported ${ranked} ranked leads into the campaign database.`,
          metadata: { source: "api" }
        }
      }
    }
  });
}

type SendreadLeadPayload = {
  email: string;
  firstName?: string;
  company?: string;
  city?: string;
  phone?: string;
  website?: string;
  industry?: string;
  facebook?: string;
  linkedin?: string;
  tags?: string;
  custom1?: string;
  custom2?: string;
  custom3?: string;
  custom4?: string;
  custom5?: string;
};

async function sendreadRequest(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<unknown> {
  const settings = await readRuntimeSettings();
  if (!settings.sendreadApiKey.trim()) {
    throw new SendreadApiError(409, "Sendread API key is missing. Add it in Runtime Settings first.");
  }

  const baseUrl = settings.sendreadBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${settings.sendreadApiKey}`,
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = parseJsonResponse(text);
  if (!response.ok) {
    throw new SendreadApiError(response.status, `Sendread HTTP ${response.status}`, body);
  }
  return body;
}

function sendreadLeadPushPath(type: SendreadDestinationType, destinationId: string): string {
  const encodedId = encodeURIComponent(destinationId);
  return type === "ab_test_list"
    ? `/api/public/ab-test-lists/${encodedId}/leads`
    : `/api/public/campaigns/${encodedId}/leads`;
}

async function buildSendreadLeads(campaignId: string, campaignName: string, input: SendreadExportInput) {
  const leads = await prisma.lead.findMany({
    where: {
      campaignId,
      disqualified: false,
      score: { gte: input.minScore },
      ...(input.includeUnranked ? {} : { rank: { not: null } })
    },
    include: {
      company: true,
      evidence: {
        take: 10,
        orderBy: { retrievedAt: "desc" }
      }
    },
    orderBy: [{ rank: "asc" }, { score: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
    take: input.limit
  });
  const payload: SendreadLeadPayload[] = [];
  let skippedNoEmail = 0;

  for (const lead of leads) {
    const company = lead.company;
    if (!company) continue;
    const emails = readJsonStringArray(company.emails);
    const email = normalizeEmail(company.generalEmail) ?? emails.map(normalizeEmail).find(Boolean);
    if (!email) {
      skippedNoEmail += 1;
      if (input.onlyWithEmail) continue;
    }

    if (!email) continue;
    const people = mergePeople(readJsonPeople(company.owners), readJsonPeople(company.managers));
    const primaryPerson = people[0];
    const social = findSocialLinks(lead.evidence.map((evidence) => evidence.url));
    const location = [company.city, company.state, company.country].filter(Boolean).join(", ");
    payload.push(
      compactObject({
        email,
        firstName: firstName(primaryPerson?.name),
        company: company.companyName,
        city: company.city ?? undefined,
        phone: company.phone ?? undefined,
        website: company.website ?? undefined,
        industry: inferIndustry(campaignName, company.metadata),
        facebook: social.facebook,
        linkedin: social.linkedin,
        tags: input.tags || `leadfactory,${slugifyTag(campaignName)}`,
        custom1: `Factory score ${lead.score}`,
        custom2: lead.rank ? `Rank ${lead.rank}` : undefined,
        custom3: lead.strongestSignal ?? undefined,
        custom4: location || undefined,
        custom5: lead.evidence.map((evidence) => evidence.url).filter(Boolean).slice(0, 3).join(" | ") || undefined
      })
    );
  }

  return { payload, skippedNoEmail };
}

function parseJsonResponse(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  return email;
}

function firstName(value: string | undefined): string | undefined {
  const first = value?.trim().split(/\s+/)[0];
  return first || undefined;
}

function findSocialLinks(urls: string[]): { facebook?: string; linkedin?: string } {
  const facebook = urls.find((url) => /(^|\.)facebook\.com/i.test(domainFromUrl(url) ?? ""));
  const linkedin = urls.find((url) => /(^|\.)linkedin\.com/i.test(domainFromUrl(url) ?? ""));
  return {
    facebook,
    linkedin
  };
}

function inferIndustry(campaignName: string, metadata: unknown): string | undefined {
  const source = `${campaignName} ${JSON.stringify(metadata ?? {})}`.toLowerCase();
  const industries = [
    "hvac",
    "plumbing",
    "roofing",
    "electrical",
    "restoration",
    "landscaping",
    "construction",
    "real estate",
    "insurance",
    "legal",
    "medical",
    "dental"
  ];
  return industries.find((industry) => source.includes(industry));
}

function slugifyTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "campaign";
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
  ) as T;
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

function createCsvLookup(row: CsvRow): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeColumnKey(key);
    const stringValue = String(value ?? "").trim();
    if (normalizedKey && stringValue) lookup.set(normalizedKey, stringValue);
  }
  return lookup;
}

function pickCsvValue(lookup: Map<string, string>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = lookup.get(normalizeColumnKey(alias));
    if (value) return value;
  }
  return undefined;
}

function normalizeColumnKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeCsvRow(row: CsvRow): CsvRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "").trim()]));
}

function uniqueTrimmedStrings(values: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  ];
}

function normalizeInputUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /^(mailto|tel|javascript):/i.test(trimmed)) return undefined;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

function normalizeDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = normalizeInputUrl(value);
  if (url) return domainFromUrl(url) ?? undefined;
  const normalized = value.trim().toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");
  return normalized.includes(".") ? normalized : undefined;
}

function domainFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isBusinessProfileUrl(value: string): boolean {
  return isGoogleMapsUrl(value) || isBusinessProfileDomain(domainFromUrl(value) ?? "");
}

function isGoogleMapsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return (domain === "google.com" && parsed.pathname.startsWith("/maps")) || domain === "maps.google.com";
  } catch {
    return false;
  }
}

function isBusinessProfileDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^www\./, "");
  const profileDomains = [
    "google.com",
    "maps.google.com",
    "bbb.org",
    "chamberofcommerce.com",
    "facebook.com",
    "linkedin.com",
    "manta.com",
    "mapquest.com",
    "nextdoor.com",
    "yellowpages.com",
    "yelp.com"
  ];
  return profileDomains.some((known) => normalized === known || normalized.endsWith(`.${known}`));
}

function inferImportSourceType(url: string, sourceName: string): string {
  if (isBusinessProfileUrl(url) || /google\s*maps|business\s*profile/i.test(sourceName)) return "business_profile";
  if (/career|jobs|employment/i.test(url)) return "careers_page";
  if (/review/i.test(url)) return "review_page";
  return "other_public_source";
}

function inferNameFromUrl(value: string | undefined): string | undefined {
  const domain = domainFromUrl(value);
  if (!domain || domain === "google.com" || domain === "maps.google.com") return undefined;
  const stem = domain.split(".").slice(0, -1).join(" ");
  const name = stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
  return name || undefined;
}

function inferStateFromLocation(parts: string[]): string | undefined {
  if (parts.length >= 2) return parts[1];
  const onlyPart = parts[0];
  if (/^(il|illinois)$/i.test(onlyPart ?? "")) return onlyPart;
  return undefined;
}

function extractEmailsFromText(text: string): string[] {
  const matches = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  return uniqueTrimmedStrings(matches.map((email) => email.toLowerCase())).filter((email) => {
    if (email.includes("@example.") || email.includes("@domain.")) return false;
    return !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email);
  });
}

function parsePeople(value: string | undefined, defaultRole: string): ImportedPerson[] {
  if (!value) return [];
  return uniqueTrimmedStrings(value.split(/\r?\n|[|;]/))
    .map((item) => {
      const email = extractEmailsFromText(item)[0];
      let label = item.replace(email ?? "", "").replace(/[<>]/g, "").trim();
      let role = defaultRole;
      const dashMatch = label.match(/^(.+?)\s+-\s+(.+)$/);
      const commaMatch = label.match(
        /^(.+?),\s*(owner|manager|founder|president|ceo|principal|director|partner|operator|general manager|gm)\b/i
      );
      if (dashMatch) {
        label = dashMatch[1]?.trim() ?? label;
        role = dashMatch[2]?.trim() ?? role;
      } else if (commaMatch) {
        label = commaMatch[1]?.trim() ?? label;
        role = commaMatch[2]?.trim() ?? role;
      }

      const name = label.replace(/\s+/g, " ").trim();
      if (!name || name.includes("@") || name.length < 2) return null;
      return {
        name,
        role,
        ...(email ? { email } : {})
      };
    })
    .filter((person): person is ImportedPerson => Boolean(person))
    .slice(0, 20);
}

function mergeStringArrays(...arrays: string[][]): string[] {
  return uniqueTrimmedStrings(arrays.flat());
}

function mergePeople(...arrays: Array<Array<{ name: string; role?: string; email?: string }>>): ImportedPerson[] {
  const people = new Map<string, ImportedPerson>();
  for (const person of arrays.flat()) {
    const name = person.name.trim();
    if (!name) continue;
    const role = person.role?.trim() || "decision maker";
    const email = person.email?.trim().toLowerCase();
    const key = `${name.toLowerCase()}|${role.toLowerCase()}|${email ?? ""}`;
    if (!people.has(key)) people.set(key, { name, role, ...(email ? { email } : {}) });
  }
  return [...people.values()].slice(0, 50);
}

function parseIntegerCell(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(/,/g, "").match(/\d+/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseConfidenceCell(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace("%", "").trim());
  if (!Number.isFinite(parsed)) return undefined;
  const confidence = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, confidence));
}

function clampInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number") return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function calculateImportedScore(record: ImportedLeadRecord): number {
  let score = 35;
  if (record.website) score += 15;
  if (record.emails.length) score += 20;
  if (record.owners.length || record.managers.length || record.decisionMakers.length) score += 20;
  if ((record.googleReviewCount ?? 0) >= 50) score += 25;
  else if (typeof record.googleReviewCount === "number") score += 10;
  if (record.city || record.state || record.country) score += 5;
  return Math.max(0, Math.min(100, score));
}

function estimateImportConfidence(record: ImportedLeadRecord): number {
  let confidence = 0.72;
  if (record.website || record.sourceUrl) confidence += 0.08;
  if (record.emails.length) confidence += 0.05;
  if (record.owners.length || record.managers.length || record.decisionMakers.length) confidence += 0.05;
  if (typeof record.googleReviewCount === "number") confidence += 0.05;
  return Math.max(0, Math.min(0.95, confidence));
}

function strongestImportedSignal(record: ImportedLeadRecord): string {
  if ((record.googleReviewCount ?? 0) >= 50) return `${record.googleReviewCount} Google reviews`;
  if (record.emails[0]) return `Published business email ${record.emails[0]}`;
  const person = mergePeople(record.owners, record.managers, record.decisionMakers)[0];
  if (person) return `${person.role}: ${person.name}`;
  if (record.website) return `Company website ${record.website}`;
  return "Imported verified public lead";
}

function readJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function normalizeCompanyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
