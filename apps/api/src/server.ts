import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { planCampaign } from "@leadfactory/campaign-planner";
import { prisma, Prisma } from "@leadfactory/database";
import { OpenAICompatibleLLMProvider } from "@leadfactory/llm";
import { parseProxyText } from "@leadfactory/proxy-manager";
import { createQueue, queueNames, type BrowserResearchPayload } from "@leadfactory/queue";
import {
  calculateWorkerLimits,
  probeServerHealth,
  probeSystemCapacity
} from "@leadfactory/resource-governor";
import {
  CreateCampaignInputSchema,
  CampaignPlanSchema,
  ProxyUploadSchema,
  ServerSettingsSchema,
  type CampaignPlan
} from "@leadfactory/schemas";
import "dotenv/config";
import Fastify from "fastify";
import { ZodError } from "zod";

const api = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info"
  }
});
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));

await api.register(cors, {
  origin: true
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

api.get("/settings/defaults", async () => readSettingsFromEnv());

api.get("/system/capacity", async () => {
  const settings = readSettingsFromEnv();
  const capacity = await probeSystemCapacity();
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
  return probeServerHealth({
    appStorageDir: process.env.APP_STORAGE_DIR ?? `${rootDir}/data`,
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://leadfactory:leadfactory@localhost:5432/leadfactory",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    localLlmBaseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://73.72.215.253:11434/v1",
    rootDir
  });
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
  const llm = new OpenAICompatibleLLMProvider({
    baseUrl: requiredEnv("LOCAL_LLM_BASE_URL"),
    model: requiredEnv("LOCAL_LLM_MODEL"),
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "local"
  });
  const plan = await planCampaign({ prompt: input.prompt, llm });
  const settings = {
    ...readSettingsFromEnv(),
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

function readSettingsFromEnv() {
  return ServerSettingsSchema.parse({
    serverUsagePercent: Number(process.env.SERVER_USAGE_PERCENT ?? 60),
    maxBrowsersHardCap: Number(process.env.MAX_BROWSERS_HARD_CAP ?? 40),
    maxQwenConcurrency: Number(process.env.MAX_QWEN_CONCURRENCY ?? 4),
    maxCampaignRuntimeMinutes: Number(process.env.MAX_CAMPAIGN_RUNTIME_MINUTES ?? 240),
    maxPagesPerLead: Number(process.env.MAX_PAGES_PER_LEAD ?? 25),
    proxyRetryCount: Number(process.env.PROXY_RETRY_COUNT ?? 2),
    browserFirst: process.env.BROWSER_FIRST !== "false"
  });
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
  const queue = createQueue<BrowserResearchPayload>(queueNames.discovery, requiredEnv("REDIS_URL"));
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
