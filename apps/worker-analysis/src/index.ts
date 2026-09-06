import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma, Prisma } from "@leadfactory/database";
import { OpenAICompatibleLLMProvider } from "@leadfactory/llm";
import { createRedisConnection, queueNames, type AnalysisPayload } from "@leadfactory/queue";
import { calculateWorkerLimits, probeSystemCapacity } from "@leadfactory/resource-governor";
import {
  CampaignPlanSchema,
  ServerSettingsSchema,
  type CampaignPlan,
  type Claim,
  type ScoringRule
} from "@leadfactory/schemas";
import { scoreClaims } from "@leadfactory/scoring";
import { Job, Worker } from "bullmq";
import "dotenv/config";
import { z } from "zod";

type SourceDocument = {
  id: string;
  url: string;
  finalUrl: string | null;
  title: string | null;
  cleanTextPath: string | null;
  text: string;
};

const EvidenceBackedItemSchema = z.object({
  value: z.string().min(1),
  evidenceQuote: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7)
});

const DecisionMakerSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  email: z.string().optional(),
  evidenceQuote: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7)
});

const LeadAnalysisSchema = z.object({
  companyName: z.string().optional(),
  icpFit: z
    .object({
      matches: z.boolean(),
      confidence: z.number().min(0).max(1).default(0.5),
      reasons: z.array(z.string()).default([]),
      evidenceQuote: z.string().optional()
    })
    .default({ matches: false, confidence: 0.2, reasons: [] }),
  publicEmails: z.array(EvidenceBackedItemSchema).default([]),
  decisionMakers: z.array(DecisionMakerSchema).default([]),
  buyingSignals: z.array(EvidenceBackedItemSchema).default([]),
  negativeMatches: z.array(EvidenceBackedItemSchema).default([]),
  summary: z.string().default(""),
  strongestSignal: z.string().optional()
});

type LeadAnalysis = z.infer<typeof LeadAnalysisSchema>;

const redisUrl = requiredEnv("REDIS_URL");
const model = process.env.LOCAL_LLM_MODEL ?? "qwen2.5:14b";

export async function main() {
  const limits = await resolveWorkerLimits();
  const worker = new Worker<AnalysisPayload>(queueNames.qwenAnalysis, processAnalysisJob, {
    connection: createRedisConnection(redisUrl),
    concurrency: limits.maxAnalysisConcurrency
  });

  worker.on("completed", (job) => {
    console.log(JSON.stringify({ service: "worker-analysis", jobId: job.id, status: "completed" }));
  });
  worker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        service: "worker-analysis",
        jobId: job?.id,
        status: "failed",
        error: error.message
      })
    );
  });

  console.log(
    JSON.stringify({
      service: "worker-analysis",
      status: "running",
      queues: [queueNames.qwenAnalysis],
      limits
    })
  );

  await waitForShutdown(async () => {
    await worker.close();
    await prisma.$disconnect();
  });
}

async function processAnalysisJob(job: Job<AnalysisPayload>) {
  const campaign = await prisma.campaign.findUnique({ where: { id: job.data.campaignId } });
  if (!campaign || ["paused", "cancelled", "completed", "failed"].includes(campaign.status)) {
    await markResearchJob(job.data.researchJobId, "completed", {
      skipped: "campaign_not_active"
    });
    return { skipped: "campaign_not_active" };
  }

  await markResearchJob(job.data.researchJobId, "running");

  try {
    const result = await analyzeAndRankLead(job.data);
    await markResearchJob(job.data.researchJobId, "completed", result);
    return result;
  } catch (error) {
    await markResearchJob(job.data.researchJobId, "failed", {
      message: error instanceof Error ? error.message : "Unknown analysis error"
    });
    throw error;
  } finally {
    await updateCampaignProgress(job.data.campaignId);
  }
}

async function analyzeAndRankLead(payload: AnalysisPayload) {
  const lead = await prisma.lead.findUnique({
    where: { id: payload.leadId },
    include: {
      campaign: true,
      company: true,
      evidence: {
        orderBy: { retrievedAt: "desc" }
      }
    }
  });
  if (!lead) return { analyzed: false, reason: "lead_missing" };

  const plan = parseCampaignPlan(lead.campaign.plan, lead.campaign.prompt, lead.campaign.name);
  const documents = await readSourceDocuments(payload.documentIds);
  const analysis = await runQwenAnalysis({
    campaignId: payload.campaignId,
    prompt: lead.campaign.prompt,
    plan,
    companyName: lead.company?.companyName ?? "Unknown company",
    website: lead.company?.website ?? "",
    documents,
    fallbackEvidence: lead.evidence.map((evidence) => ({
      id: evidence.id,
      field: evidence.field,
      quote: evidence.quote,
      url: evidence.url
    }))
  });

  await prisma.claim.deleteMany({
    where: {
      campaignId: payload.campaignId,
      leadId: payload.leadId,
      promptName: payload.promptName,
      analysisVersion: "v1"
    }
  });

  const deterministicEvidence = await prisma.evidence.findMany({
    where: { campaignId: payload.campaignId, leadId: payload.leadId }
  });
  const claims: Claim[] = [];
  const allEvidenceIds = deterministicEvidence.map((evidence) => evidence.id);
  const emailEvidenceIds = matchingEvidenceIds(deterministicEvidence, "public_email");
  const peopleEvidenceIds = matchingEvidenceIds(deterministicEvidence, "owner_manager_name");
  const signalEvidenceIds: string[] = [];

  if (analysis.icpFit.evidenceQuote) {
    const evidence = await createQuotedEvidence({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      documents,
      field: "icp_fit",
      quote: analysis.icpFit.evidenceQuote
    });
    if (evidence) signalEvidenceIds.push(evidence.id);
  }

  for (const signal of analysis.buyingSignals.slice(0, 10)) {
    if (!signal.evidenceQuote) continue;
    const evidence = await createQuotedEvidence({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      documents,
      field: "buying_signal",
      quote: signal.evidenceQuote
    });
    if (evidence) signalEvidenceIds.push(evidence.id);
  }

  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "icp_fit",
      value: analysis.icpFit.matches,
      confidence: analysis.icpFit.confidence,
      evidenceIds: [...new Set([...signalEvidenceIds, ...allEvidenceIds])].slice(0, 20),
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "public_email_found",
      value: analysis.publicEmails.length > 0 || emailEvidenceIds.length > 0,
      confidence: maxConfidence(analysis.publicEmails, emailEvidenceIds.length > 0 ? 0.85 : 0.2),
      evidenceIds: emailEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "owner_or_manager_found",
      value: analysis.decisionMakers.length > 0 || peopleEvidenceIds.length > 0,
      confidence: maxDecisionMakerConfidence(analysis.decisionMakers, peopleEvidenceIds.length > 0 ? 0.8 : 0.2),
      evidenceIds: peopleEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "buying_signal_count",
      value: analysis.buyingSignals.length,
      confidence: maxConfidence(analysis.buyingSignals, signalEvidenceIds.length > 0 ? 0.75 : 0.4),
      evidenceIds: signalEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "negative_match",
      value: analysis.negativeMatches.length > 0,
      confidence: maxConfidence(analysis.negativeMatches, analysis.negativeMatches.length > 0 ? 0.75 : 0.7),
      evidenceIds: signalEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );

  const rules = mergeScoringRules(defaultScoringRules(), plan.scoringRules);
  const scored = scoreClaims({ claims, rules, cap: 100 });
  const score = Math.max(0, Math.min(100, scored.score));
  const disqualified = analysis.negativeMatches.some((match) => match.confidence >= 0.75);

  await updateCompanyFromAnalysis(lead.companyId ?? undefined, analysis);
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status: "ranked",
      score,
      confidence: averageClaimConfidence(claims),
      strongestSignal: analysis.strongestSignal ?? scored.components[0]?.label ?? analysis.summary.slice(0, 160),
      scoreComponents: {
        components: scored.components,
        rejectedRuleIds: scored.rejectedRuleIds,
        qwenSummary: analysis.summary,
        qwenModel: model
      },
      disqualified,
      disqualificationReason: disqualified
        ? analysis.negativeMatches.map((match) => match.value).join("; ").slice(0, 300)
        : null,
      exportSnapshot: buildExportSnapshot(analysis)
    }
  });

  await rerankCampaign(payload.campaignId);
  await maybeCompleteCampaign(payload.campaignId);

  return {
    analyzed: true,
    score,
    disqualified,
    claims: claims.length,
    evidence: allEvidenceIds.length + signalEvidenceIds.length
  };
}

async function runQwenAnalysis(params: {
  campaignId: string;
  prompt: string;
  plan: CampaignPlan;
  companyName: string;
  website: string;
  documents: SourceDocument[];
  fallbackEvidence: Array<{ id: string; field: string | null; quote: string; url: string }>;
}): Promise<LeadAnalysis> {
  const llm = new OpenAICompatibleLLMProvider({
    baseUrl: requiredEnv("LOCAL_LLM_BASE_URL"),
    model,
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
    timeoutMs: Number(process.env.QWEN_TIMEOUT_MS ?? 120000)
  });

  try {
    return await llm.structuredCompletion({
      system:
        "You analyze B2B leads using only supplied public source text. Return only JSON. Never infer private personal data. Unknown is better than guessed.",
      prompt: buildLeadAnalysisPrompt(params),
      schema: LeadAnalysisSchema,
      temperature: 0
    });
  } catch (error) {
    await prisma.campaignEvent.create({
      data: {
        campaignId: params.campaignId,
        type: "qwen_analysis_fallback",
        message: "Qwen analysis failed, using deterministic contact evidence fallback.",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          companyName: params.companyName
        }
      }
    }).catch(() => undefined);

    return fallbackAnalysis(params.fallbackEvidence);
  }
}

function buildLeadAnalysisPrompt(params: {
  prompt: string;
  plan: CampaignPlan;
  companyName: string;
  website: string;
  documents: SourceDocument[];
}): string {
  return `Analyze this lead for the campaign. Use only the source documents below.

Campaign prompt:
${params.prompt}

Campaign plan:
${JSON.stringify(params.plan, null, 2)}

Lead:
- Company: ${params.companyName}
- Website/profile: ${params.website}

Return JSON with:
- companyName if found
- icpFit.matches, confidence, reasons, evidenceQuote
- publicEmails with value, evidenceQuote, confidence
- decisionMakers with name, role, email if directly connected in the text, evidenceQuote, confidence
- buyingSignals with value, evidenceQuote, confidence
- negativeMatches with value, evidenceQuote, confidence
- summary
- strongestSignal

Rules:
- Only cite facts present in the source documents.
- Do not guess owner names or emails.
- Do not include personal emails unless they are public business contact emails in the source text.
- Use evidenceQuote as a short exact phrase from the supplied text.
- If evidence is weak or missing, return empty arrays or false.

Source documents:
${buildSourcePack(params.documents)}`;
}

async function readSourceDocuments(documentIds: string[]): Promise<SourceDocument[]> {
  const documents = await prisma.document.findMany({
    where: { id: { in: documentIds } },
    orderBy: { retrievedAt: "asc" }
  });

  return Promise.all(
    documents.map(async (document) => ({
      id: document.id,
      url: document.url,
      finalUrl: document.finalUrl,
      title: document.title,
      cleanTextPath: document.cleanTextPath,
      text: document.cleanTextPath ? await safeReadFile(document.cleanTextPath) : ""
    }))
  );
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function createQuotedEvidence(params: {
  campaignId: string;
  companyId?: string;
  leadId: string;
  documents: SourceDocument[];
  field: string;
  quote: string;
}) {
  const quote = normalizeWhitespace(params.quote).slice(0, 900);
  if (!quote) return null;

  const document = params.documents.find((candidate) => quoteAppearsInText(candidate.text, quote));
  if (!document) return null;

  const existing = await prisma.evidence.findFirst({
    where: {
      campaignId: params.campaignId,
      leadId: params.leadId,
      field: params.field,
      documentId: document.id,
      quote
    }
  });
  if (existing) return existing;

  return prisma.evidence.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      documentId: document.id,
      field: params.field,
      sourceType: "company_website",
      retrievalMethod: "browser",
      url: document.url,
      finalUrl: document.finalUrl,
      quote,
      contentHash: hashText(quote)
    }
  });
}

async function createClaim(params: {
  campaignId: string;
  companyId?: string;
  leadId: string;
  field: string;
  value: unknown;
  confidence: number;
  evidenceIds: string[];
  promptName: string;
  promptVersion: string;
}): Promise<Claim> {
  const record = await prisma.claim.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      field: params.field,
      value: params.value as Prisma.InputJsonValue,
      confidence: clamp01(params.confidence),
      evidenceIds: [...new Set(params.evidenceIds)],
      promptName: params.promptName,
      promptVersion: params.promptVersion,
      model,
      analysisVersion: "v1"
    }
  });

  return {
    id: record.id,
    field: record.field,
    value: record.value,
    confidence: record.confidence,
    evidenceIds: record.evidenceIds,
    promptName: record.promptName,
    promptVersion: record.promptVersion,
    model: record.model,
    analysisVersion: record.analysisVersion,
    createdAt: record.createdAt.toISOString()
  };
}

async function updateCompanyFromAnalysis(companyId: string | undefined, analysis: LeadAnalysis) {
  if (!companyId) return;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const emails = mergeStringArrays(
    readJsonStringArray(company.emails),
    analysis.publicEmails.map((email) => email.value.toLowerCase())
  );
  const people = analysis.decisionMakers.map((person) => ({
    name: person.name,
    role: person.role ?? "decision maker",
    email: person.email
  }));

  await prisma.company.update({
    where: { id: companyId },
    data: {
      companyName: analysis.companyName ?? company.companyName,
      generalEmail: company.generalEmail ?? emails[0],
      emails,
      owners: mergePeople(readJsonPeople(company.owners), people.filter((person) => /owner|founder|ceo|president|principal/i.test(person.role))),
      managers: mergePeople(readJsonPeople(company.managers), people),
      lastCheckedAt: new Date()
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

async function maybeCompleteCampaign(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign?.targetLeadCount) return;

  const ranked = await prisma.lead.count({ where: { campaignId, rank: { not: null } } });
  if (ranked < campaign.targetLeadCount) return;

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "completed",
      completedAt: new Date(),
      progress: {
        ...(campaign.progress && typeof campaign.progress === "object" ? campaign.progress : {}),
        percent: 100,
        ranked
      },
      events: {
        create: {
          type: "campaign_completed",
          message: `Campaign reached target of ${campaign.targetLeadCount} ranked leads.`,
          metadata: { ranked }
        }
      }
    }
  });
}

async function updateCampaignProgress(campaignId: string) {
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
      }
    }
  });
}

async function markResearchJob(
  researchJobId: string | undefined,
  status: "running" | "completed" | "failed",
  payload?: unknown
) {
  if (!researchJobId) return;

  await prisma.researchJob.update({
    where: { id: researchJobId },
    data: {
      status,
      startedAt: status === "running" ? new Date() : undefined,
      completedAt: status === "completed" || status === "failed" ? new Date() : undefined,
      statistics: status === "completed" ? (payload as object) : undefined,
      error: status === "failed" ? (payload as object) : undefined
    }
  });
}

async function resolveWorkerLimits() {
  const settings = ServerSettingsSchema.parse({
    serverUsagePercent: Number(process.env.SERVER_USAGE_PERCENT ?? 60),
    maxBrowsersHardCap: Number(process.env.MAX_BROWSERS_HARD_CAP ?? 40),
    maxQwenConcurrency: Number(process.env.MAX_QWEN_CONCURRENCY ?? 4),
    maxCampaignRuntimeMinutes: Number(process.env.MAX_CAMPAIGN_RUNTIME_MINUTES ?? 240),
    maxPagesPerLead: Number(process.env.MAX_PAGES_PER_LEAD ?? 25),
    proxyRetryCount: Number(process.env.PROXY_RETRY_COUNT ?? 2),
    browserFirst: process.env.BROWSER_FIRST !== "false"
  });
  const [capacity, usableProxyCount] = await Promise.all([
    probeSystemCapacity(),
    prisma.proxy.count({ where: { status: { in: ["healthy", "untested", "degraded"] } } })
  ]);

  return calculateWorkerLimits({
    settings,
    capacity,
    healthyProxyCount: usableProxyCount,
    qwenHealthy: true
  });
}

function defaultScoringRules(): ScoringRule[] {
  return [
    {
      id: "default_icp_fit",
      label: "ICP fit",
      field: "icp_fit",
      operator: "equals",
      value: true,
      points: 35,
      requiredConfidence: 0.65,
      requiresEvidence: true
    },
    {
      id: "default_public_email",
      label: "Public business email",
      field: "public_email_found",
      operator: "equals",
      value: true,
      points: 25,
      requiredConfidence: 0.75,
      requiresEvidence: true
    },
    {
      id: "default_decision_maker",
      label: "Owner or manager found",
      field: "owner_or_manager_found",
      operator: "equals",
      value: true,
      points: 20,
      requiredConfidence: 0.7,
      requiresEvidence: true
    },
    {
      id: "default_buying_signal",
      label: "Buying signal",
      field: "buying_signal_count",
      operator: "gte",
      value: 1,
      points: 15,
      requiredConfidence: 0.65,
      requiresEvidence: true
    },
    {
      id: "default_no_negative_match",
      label: "No disqualifier found",
      field: "negative_match",
      operator: "equals",
      value: false,
      points: 5,
      requiredConfidence: 0.5,
      requiresEvidence: false
    }
  ];
}

function mergeScoringRules(defaultRules: ScoringRule[], planRules: ScoringRule[]): ScoringRule[] {
  const rules = new Map<string, ScoringRule>();
  for (const rule of [...defaultRules, ...planRules]) rules.set(rule.id, rule);
  return [...rules.values()];
}

function fallbackAnalysis(evidence: Array<{ field: string | null; quote: string }>): LeadAnalysis {
  const emails = evidence
    .filter((item) => item.field === "public_email")
    .map((item) => ({ value: firstEmail(item.quote) ?? item.quote, evidenceQuote: item.quote, confidence: 0.85 }))
    .filter((item) => item.value.includes("@"));
  const people = evidence
    .filter((item) => item.field === "owner_manager_name")
    .map((item) => ({
      name: extractNameFromQuote(item.quote),
      role: extractRoleFromQuote(item.quote),
      evidenceQuote: item.quote,
      confidence: 0.75
    }))
    .filter((item) => item.name.length > 0);

  return {
    icpFit: {
      matches: false,
      confidence: 0.2,
      reasons: ["Qwen unavailable; no ICP inference made."]
    },
    publicEmails: emails,
    decisionMakers: people,
    buyingSignals: [],
    negativeMatches: [],
    summary: "Deterministic fallback used public contact evidence only.",
    strongestSignal: emails[0]?.value ?? people[0]?.name
  };
}

function parseCampaignPlan(value: unknown, prompt: string, campaignName: string): CampaignPlan {
  const parsed = CampaignPlanSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  return {
    campaignName,
    icpDescription: prompt,
    geography: [],
    positiveSignals: [],
    negativeFilters: [],
    disqualificationRules: [],
    requiredEvidenceFields: ["public_email", "owner_manager_name", "company_website"],
    contactRequirements: ["company website emails", "public business profile emails", "public owner or manager names"],
    sourceStrategy: ["browser_search", "company_website"],
    scoringRules: [],
    maxPagesPerLead: 10,
    outputColumns: ["rank", "company", "website", "score", "email", "decision_maker", "evidence"],
    plannerNotes: "Fallback plan generated by analysis worker because stored plan was unavailable."
  };
}

function buildSourcePack(documents: SourceDocument[]): string {
  const maxChars = Number(process.env.QWEN_MAX_SOURCE_CHARS ?? 45000);
  let remaining = maxChars;
  const chunks: string[] = [];

  for (const document of documents) {
    if (remaining <= 0) break;
    const text = normalizeWhitespace(document.text).slice(0, remaining);
    remaining -= text.length;
    chunks.push(`DOCUMENT ${document.id}
URL: ${document.finalUrl ?? document.url}
TITLE: ${document.title ?? ""}
TEXT:
${text}`);
  }

  return chunks.join("\n\n---\n\n");
}

function matchingEvidenceIds(
  evidence: Array<{ id: string; field: string | null }>,
  field: string
): string[] {
  return evidence.filter((item) => item.field === field).map((item) => item.id);
}

function maxConfidence(items: Array<{ confidence: number }>, fallback: number): number {
  return Math.max(fallback, ...items.map((item) => item.confidence));
}

function maxDecisionMakerConfidence(items: Array<{ confidence: number }>, fallback: number): number {
  return Math.max(fallback, ...items.map((item) => item.confidence));
}

function averageClaimConfidence(claims: Claim[]): number {
  if (claims.length === 0) return 0;
  return Math.round((claims.reduce((total, claim) => total + claim.confidence, 0) / claims.length) * 100) / 100;
}

function buildExportSnapshot(analysis: LeadAnalysis) {
  return {
    publicEmails: analysis.publicEmails.map((email) => email.value),
    decisionMakers: analysis.decisionMakers.map((person) => ({
      name: person.name,
      role: person.role,
      email: person.email
    })),
    buyingSignals: analysis.buyingSignals.map((signal) => signal.value),
    summary: analysis.summary
  };
}

function quoteAppearsInText(text: string, quote: string): boolean {
  const normalizedText = normalizeComparable(text);
  const normalizedQuote = normalizeComparable(quote);
  if (!normalizedQuote) return false;
  if (normalizedText.includes(normalizedQuote)) return true;
  return normalizedQuote
    .split(" ")
    .filter((part) => part.length > 4)
    .slice(0, 6)
    .every((part) => normalizedText.includes(part));
}

function normalizeComparable(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9@. ]+/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function readJsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readJsonPeople(value: unknown): Array<{ name: string; role: string; email?: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is { name: string; role: string; email?: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { name?: unknown }).name === "string" &&
      typeof (item as { role?: unknown }).role === "string"
  );
}

function mergeStringArrays(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter(Boolean).map((item) => item.toLowerCase()))].slice(0, 50);
}

function mergePeople(
  left: Array<{ name: string; role: string; email?: string }>,
  right: Array<{ name: string; role: string; email?: string }>
): Array<{ name: string; role: string; email?: string }> {
  const people = new Map<string, { name: string; role: string; email?: string }>();
  for (const person of [...left, ...right]) {
    people.set(`${person.name.toLowerCase()}|${person.role.toLowerCase()}`, person);
  }
  return [...people.values()].slice(0, 50);
}

function firstEmail(value: string): string | null {
  return value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]?.toLowerCase() ?? null;
}

function extractNameFromQuote(value: string): string {
  const match = value.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/);
  return match?.[1] ?? "";
}

function extractRoleFromQuote(value: string): string {
  const match = value.match(/\b(Owner|Founder|Co-Founder|CEO|President|Principal|General Manager|Operations Manager|Manager|Director)\b/i);
  return match?.[1] ?? "decision maker";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  let closing = false;
  return new Promise((resolve) => {
    const shutdown = () => {
      if (closing) return;
      closing = true;
      cleanup()
        .catch((error) => console.error(error))
        .finally(resolve);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

await main();
