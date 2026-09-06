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
import {
  EmailVerificationProviderConfigSchema,
  EnrichmentProviderConfigSchema,
  type EmailVerificationProviderConfig,
  type EnrichmentProviderConfig,
  type ProviderRequestTemplate
} from "@leadfactory/source-adapters";
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

type SavedProviderRecord = {
  id: string;
  campaignId: string | null;
  name: string;
  version: string;
  status: string;
  provider: unknown;
  supportedDomains: string[];
  successCount: number;
  failureCount: number;
};

type CompanySnapshot = {
  id: string;
  companyName: string;
  domain: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  emails: Prisma.JsonValue | null;
  owners: Prisma.JsonValue | null;
  managers: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
};

type EnrichedPerson = {
  name: string;
  role?: string;
  email?: string;
};

type EnrichmentResult = {
  companyName?: string;
  website?: string;
  domain?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  emails: string[];
  owners: EnrichedPerson[];
  managers: EnrichedPerson[];
  decisionMakers: EnrichedPerson[];
  sourceUrl?: string;
  evidenceQuote?: string;
  confidence: number;
  raw: unknown;
};

type EmailVerificationStatus = "verified" | "invalid" | "risky" | "unknown";

type EmailVerificationResult = {
  email: string;
  normalizedEmail?: string;
  status: EmailVerificationStatus;
  score?: number;
  reason?: string;
  sourceUrl?: string;
  evidenceQuote?: string;
  raw: unknown;
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
  const enrichmentResults = await runActiveEnrichmentProviders({
    campaignId: payload.campaignId,
    leadId: lead.id,
    companyId: lead.companyId ?? undefined,
    company: lead.company,
    plan
  });
  const leadAfterEnrichment = await prisma.lead.findUnique({
    where: { id: payload.leadId },
    include: {
      company: true,
      evidence: {
        orderBy: { retrievedAt: "desc" }
      }
    }
  });
  const analysis = await runQwenAnalysis({
    campaignId: payload.campaignId,
    prompt: lead.campaign.prompt,
    plan,
    companyName: leadAfterEnrichment?.company?.companyName ?? lead.company?.companyName ?? "Unknown company",
    website: leadAfterEnrichment?.company?.website ?? lead.company?.website ?? "",
    documents,
    fallbackEvidence: (leadAfterEnrichment?.evidence ?? lead.evidence).map((evidence) => ({
      id: evidence.id,
      field: evidence.field,
      quote: evidence.quote,
      url: evidence.url
    }))
  });

  await updateCompanyFromAnalysis(lead.companyId ?? undefined, analysis);
  const companyForVerification = lead.companyId
    ? await prisma.company.findUnique({ where: { id: lead.companyId } })
    : null;
  const emailsForVerification = mergeStringArrays(
    readJsonStringArray(companyForVerification?.emails),
    analysis.publicEmails.map((email) => email.value)
  );
  const verificationResults = await runActiveEmailVerificationProviders({
    campaignId: payload.campaignId,
    leadId: lead.id,
    companyId: lead.companyId ?? undefined,
    company: companyForVerification,
    emails: emailsForVerification
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
  const verificationEvidenceIds = matchingEvidenceIds(deterministicEvidence, "email_verification");
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
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "verified_email_found",
      value: verificationResults.some((result) => result.status === "verified"),
      confidence: maxVerificationConfidence(verificationResults, verificationEvidenceIds.length > 0 ? 0.75 : 0.2),
      evidenceIds: verificationEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );
  claims.push(
    await createClaim({
      campaignId: payload.campaignId,
      companyId: lead.companyId ?? undefined,
      leadId: lead.id,
      field: "invalid_email_found",
      value: verificationResults.some((result) => result.status === "invalid"),
      confidence: maxVerificationConfidence(
        verificationResults.filter((result) => result.status === "invalid"),
        0.2
      ),
      evidenceIds: verificationEvidenceIds,
      promptName: payload.promptName,
      promptVersion: payload.promptVersion
    })
  );

  const rules = mergeScoringRules(defaultScoringRules(), plan.scoringRules);
  const scored = scoreClaims({ claims, rules, cap: 100 });
  const score = Math.max(0, Math.min(100, scored.score));
  const disqualified = analysis.negativeMatches.some((match) => match.confidence >= 0.75);

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
        qwenModel: model,
        enrichmentProviders: enrichmentResults.map((result) => ({
          sourceUrl: result.sourceUrl,
          emails: result.emails.length,
          decisionMakers: result.decisionMakers.length,
          confidence: result.confidence
        })),
        emailVerification: verificationResults.map((result) => ({
          email: result.normalizedEmail ?? result.email,
          status: result.status,
          score: result.score,
          reason: result.reason
        }))
      },
      disqualified,
      disqualificationReason: disqualified
        ? analysis.negativeMatches.map((match) => match.value).join("; ").slice(0, 300)
        : null,
      exportSnapshot: buildExportSnapshot(analysis, verificationResults)
    }
  });

  await rerankCampaign(payload.campaignId);
  await maybeCompleteCampaign(payload.campaignId);

  return {
    analyzed: true,
    score,
    disqualified,
    claims: claims.length,
    evidence: allEvidenceIds.length + signalEvidenceIds.length,
    enrichmentProviders: enrichmentResults.length,
    emailVerifications: verificationResults.length
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

async function runActiveEnrichmentProviders(params: {
  campaignId: string;
  leadId: string;
  companyId?: string;
  company: CompanySnapshot | null;
  plan: CampaignPlan;
}): Promise<EnrichmentResult[]> {
  const providers = await prisma.enrichmentProvider.findMany({
    where: {
      OR: [
        { status: "active", campaignId: null },
        { status: "active", campaignId: params.campaignId },
        { status: "trial", campaignId: params.campaignId }
      ]
    },
    orderBy: [{ successCount: "desc" }, { updatedAt: "desc" }],
    take: Number(process.env.MAX_ACTIVE_ENRICHMENT_PROVIDERS ?? 5)
  });

  const results: EnrichmentResult[] = [];
  for (const provider of providers) {
    const parsed = EnrichmentProviderConfigSchema.safeParse(provider.provider);
    if (!parsed.success) {
      await markEnrichmentProviderFailure(provider, "invalid_provider_config");
      continue;
    }

    const config = parsed.data;
    if (missingEnvVars(config.requiredEnvVars).length) continue;
    if (!providerAppliesToCompany(provider.supportedDomains, params.company)) continue;
    if (!shouldRunEnrichmentProvider(config, params.company)) continue;

    const input = buildProviderInput(params.company, params.plan);
    const run = await startProviderRun({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      providerType: "enrichment",
      providerId: provider.id,
      providerName: provider.name,
      input
    });

    try {
      const raw = await executeProviderRequest(config.request, input);
      const mapped = mapEnrichmentResult(raw, config);
      if (!hasEnrichmentResult(mapped)) {
        await finishProviderRun(run.id, "completed", mapped, undefined);
        await markEnrichmentProviderFailure(provider, "empty_enrichment_result");
        continue;
      }

      await applyEnrichmentResult({
        campaignId: params.campaignId,
        companyId: params.companyId,
        leadId: params.leadId,
        providerName: provider.name,
        result: mapped
      });
      await finishProviderRun(run.id, "completed", mapped, undefined);
      await markEnrichmentProviderSuccess(provider);
      results.push(mapped);
    } catch (error) {
      await finishProviderRun(run.id, "failed", undefined, error);
      await markEnrichmentProviderFailure(provider, error instanceof Error ? error.message : "provider_request_failed");
    } finally {
      await waitForProviderRateLimit(config.rateLimitPerMinute);
    }
  }

  return results;
}

async function runActiveEmailVerificationProviders(params: {
  campaignId: string;
  leadId: string;
  companyId?: string;
  company: CompanySnapshot | null;
  emails: string[];
}): Promise<EmailVerificationResult[]> {
  const emails = [...new Set(params.emails.map(normalizeEmail).filter((email): email is string => Boolean(email)))].slice(
    0,
    Number(process.env.MAX_EMAILS_TO_VERIFY_PER_LEAD ?? 10)
  );
  if (!emails.length) return [];

  const providers = await prisma.emailVerificationProvider.findMany({
    where: {
      OR: [
        { status: "active", campaignId: null },
        { status: "active", campaignId: params.campaignId },
        { status: "trial", campaignId: params.campaignId }
      ]
    },
    orderBy: [{ successCount: "desc" }, { updatedAt: "desc" }],
    take: Number(process.env.MAX_ACTIVE_EMAIL_VERIFICATION_PROVIDERS ?? 3)
  });

  const results: EmailVerificationResult[] = [];
  const remaining = new Set(emails);
  for (const provider of providers) {
    const parsed = EmailVerificationProviderConfigSchema.safeParse(provider.provider);
    if (!parsed.success) {
      await markEmailVerificationProviderFailure(provider, "invalid_provider_config");
      continue;
    }

    const config = parsed.data;
    if (missingEnvVars(config.requiredEnvVars).length) continue;

    for (const email of [...remaining]) {
      if (!providerAppliesToEmail(provider.supportedDomains, email)) continue;
      const input = {
        ...buildProviderInput(params.company, null),
        email,
        emailDomain: email.split("@")[1] ?? ""
      };
      const run = await startProviderRun({
        campaignId: params.campaignId,
        companyId: params.companyId,
        leadId: params.leadId,
        providerType: "email_verification",
        providerId: provider.id,
        providerName: provider.name,
        input
      });

      try {
        const raw = await executeProviderRequest(config.request, input);
        const mapped = mapEmailVerificationResult(raw, config, email);
        await createProviderEvidence({
          campaignId: params.campaignId,
          companyId: params.companyId,
          leadId: params.leadId,
          field: "email_verification",
          sourceType: "email_verification",
          url: mapped.sourceUrl ?? `https://provider.local/${encodeURIComponent(provider.name)}`,
          quote:
            mapped.evidenceQuote ??
            `${mapped.normalizedEmail ?? mapped.email} verification: ${mapped.status}${mapped.reason ? ` (${mapped.reason})` : ""}`
        });
        await updateCompanyEmailVerification(params.companyId, provider.name, mapped);
        await finishProviderRun(run.id, "completed", mapped, undefined);
        await markEmailVerificationProviderSuccess(provider);
        results.push(mapped);
        remaining.delete(email);
      } catch (error) {
        await finishProviderRun(run.id, "failed", undefined, error);
        await markEmailVerificationProviderFailure(provider, error instanceof Error ? error.message : "provider_request_failed");
      } finally {
        await waitForProviderRateLimit(config.rateLimitPerMinute);
      }
    }

    if (!remaining.size) break;
  }

  return results;
}

async function executeProviderRequest(request: ProviderRequestTemplate, input: Record<string, unknown>): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= request.retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const url = new URL(renderTemplate(request.urlTemplate, input));
      for (const [key, value] of Object.entries(request.queryTemplate)) {
        const rendered = renderTemplate(value, input);
        if (rendered) url.searchParams.set(key, rendered);
      }

      const headers = Object.fromEntries(
        Object.entries(request.headersTemplate).map(([key, value]) => [key, renderTemplate(value, input)])
      );
      const method = request.method ?? "GET";
      const body = request.bodyTemplate === undefined ? undefined : renderTemplateValue(request.bodyTemplate, input);
      const response = await fetch(url, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = parseProviderResponse(text);
      if (!response.ok) {
        throw new Error(`Provider HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

async function applyEnrichmentResult(params: {
  campaignId: string;
  companyId?: string;
  leadId: string;
  providerName: string;
  result: EnrichmentResult;
}) {
  if (params.companyId) {
    const company = await prisma.company.findUnique({ where: { id: params.companyId } });
    if (company) {
      const people = [...params.result.decisionMakers, ...params.result.owners, ...params.result.managers].map((person) => ({
        name: person.name,
        role: person.role ?? "decision maker",
        email: person.email
      }));
      await prisma.company.update({
        where: { id: params.companyId },
        data: {
          companyName: params.result.companyName ?? company.companyName,
          website: company.website ?? params.result.website,
          domain: company.domain ?? params.result.domain ?? domainFromUrl(params.result.website ?? ""),
          phone: company.phone ?? params.result.phone,
          city: company.city ?? params.result.city,
          state: company.state ?? params.result.state,
          country: company.country ?? params.result.country,
          generalEmail: company.generalEmail ?? params.result.emails[0],
          emails: mergeStringArrays(readJsonStringArray(company.emails), params.result.emails),
          owners: mergePeople(readJsonPeople(company.owners), people.filter((person) => /owner|founder|ceo|president|principal/i.test(person.role))),
          managers: mergePeople(readJsonPeople(company.managers), people),
          metadata: mergeProviderMetadata(company.metadata, {
            enrichment: {
              providerName: params.providerName,
              checkedAt: new Date().toISOString(),
              confidence: params.result.confidence,
              sourceUrl: params.result.sourceUrl
            }
          }),
          lastCheckedAt: new Date()
        }
      });
    }
  }

  const evidenceUrl = params.result.sourceUrl ?? `https://provider.local/${encodeURIComponent(params.providerName)}`;
  const evidenceQuote =
    params.result.evidenceQuote ??
    [
      params.result.companyName,
      params.result.website,
      params.result.phone,
      params.result.emails.slice(0, 3).join(", ")
    ]
      .filter(Boolean)
      .join(" | ");

  if (evidenceQuote) {
    await createProviderEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      field: "enrichment_provider",
      sourceType: "enrichment_provider",
      url: evidenceUrl,
      quote: evidenceQuote
    });
  }

  for (const email of params.result.emails.slice(0, 20)) {
    await createProviderEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      field: "public_email",
      sourceType: "enrichment_provider",
      url: evidenceUrl,
      quote: params.result.evidenceQuote ?? email
    });
  }

  const people = [...params.result.decisionMakers, ...params.result.owners, ...params.result.managers];
  for (const person of people.slice(0, 20)) {
    await createProviderEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      field: "owner_manager_name",
      sourceType: "enrichment_provider",
      url: evidenceUrl,
      quote: params.result.evidenceQuote ?? `${person.name}${person.role ? ` - ${person.role}` : ""}`
    });
  }
}

function mapEnrichmentResult(raw: unknown, config: EnrichmentProviderConfig): EnrichmentResult {
  const mapping = config.outputMapping;
  return {
    companyName: firstStringAtPath(raw, mapping.companyNamePath ?? "companyName"),
    website: firstStringAtPath(raw, mapping.websitePath ?? "website"),
    domain: firstStringAtPath(raw, mapping.domainPath ?? "domain"),
    phone: firstStringAtPath(raw, mapping.phonePath ?? "phone"),
    city: firstStringAtPath(raw, mapping.cityPath ?? "city"),
    state: firstStringAtPath(raw, mapping.statePath ?? "state"),
    country: firstStringAtPath(raw, mapping.countryPath ?? "country"),
    emails: stringsAtPath(raw, mapping.emailsPath ?? "emails"),
    owners: peopleAtPath(raw, mapping.ownersPath ?? "owners"),
    managers: peopleAtPath(raw, mapping.managersPath ?? "managers"),
    decisionMakers: peopleAtPath(raw, mapping.decisionMakersPath ?? "decisionMakers"),
    sourceUrl: firstStringAtPath(raw, mapping.sourceUrlPath ?? "sourceUrl"),
    evidenceQuote: firstStringAtPath(raw, mapping.evidenceQuotePath ?? "evidenceQuote"),
    confidence: clamp01(numberAtPath(raw, mapping.confidencePath ?? "confidence") ?? 0.7),
    raw
  };
}

function mapEmailVerificationResult(
  raw: unknown,
  config: EmailVerificationProviderConfig,
  email: string
): EmailVerificationResult {
  const mapping = config.outputMapping;
  const statusValue = firstStringAtPath(raw, mapping.statusPath);
  const score = numberAtPath(raw, mapping.scorePath ?? "score");
  return {
    email,
    normalizedEmail: firstStringAtPath(raw, mapping.normalizedEmailPath ?? "email") ?? email,
    status: mapVerificationStatus(statusValue, score, mapping),
    score,
    reason: firstStringAtPath(raw, mapping.reasonPath ?? "reason"),
    sourceUrl: firstStringAtPath(raw, mapping.sourceUrlPath ?? "sourceUrl"),
    evidenceQuote: firstStringAtPath(raw, mapping.evidenceQuotePath ?? "evidenceQuote"),
    raw
  };
}

function hasEnrichmentResult(result: EnrichmentResult): boolean {
  return Boolean(
    result.companyName ||
      result.website ||
      result.domain ||
      result.phone ||
      result.city ||
      result.state ||
      result.country ||
      result.emails.length ||
      result.owners.length ||
      result.managers.length ||
      result.decisionMakers.length
  );
}

function shouldRunEnrichmentProvider(config: EnrichmentProviderConfig, company: CompanySnapshot | null): boolean {
  if (config.runWhen === "always") return true;
  const emails = readJsonStringArray(company?.emails);
  const people = [...readJsonPeople(company?.owners), ...readJsonPeople(company?.managers)];
  if (config.runWhen === "missing_email") return emails.length === 0;
  if (config.runWhen === "missing_decision_maker") return people.length === 0;
  return emails.length === 0 || people.length === 0 || !company?.phone || !company.website;
}

function buildProviderInput(company: CompanySnapshot | null, plan: CampaignPlan | null): Record<string, unknown> {
  const domain = company?.domain ?? domainFromUrl(company?.website ?? "") ?? "";
  const emails = readJsonStringArray(company?.emails);
  return {
    companyName: company?.companyName ?? "",
    domain,
    website: company?.website ?? "",
    city: company?.city ?? "",
    state: company?.state ?? "",
    country: company?.country ?? "",
    phone: company?.phone ?? "",
    emails,
    icp: plan?.icpDescription ?? "",
    campaignName: plan?.campaignName ?? "",
    geography: plan?.geography.join(" ") ?? "",
    signals: plan?.positiveSignals.join(" ") ?? ""
  };
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
      id: "default_verified_email",
      label: "Verified business email",
      field: "verified_email_found",
      operator: "equals",
      value: true,
      points: 10,
      requiredConfidence: 0.75,
      requiresEvidence: true
    },
    {
      id: "default_invalid_email_penalty",
      label: "Invalid email penalty",
      field: "invalid_email_found",
      operator: "equals",
      value: true,
      points: -10,
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

function buildExportSnapshot(analysis: LeadAnalysis, verificationResults: EmailVerificationResult[] = []) {
  return {
    publicEmails: analysis.publicEmails.map((email) => email.value),
    emailVerification: verificationResults.map((result) => ({
      email: result.normalizedEmail ?? result.email,
      status: result.status,
      score: result.score,
      reason: result.reason
    })),
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

async function startProviderRun(params: {
  campaignId: string;
  companyId?: string;
  leadId?: string;
  providerType: string;
  providerId: string;
  providerName: string;
  input: unknown;
}) {
  return prisma.providerRun.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      providerType: params.providerType,
      providerId: params.providerId,
      providerName: params.providerName,
      status: "running",
      input: toInputJson(params.input)
    }
  });
}

async function finishProviderRun(runId: string, status: "completed" | "failed", output?: unknown, error?: unknown) {
  return prisma.providerRun.update({
    where: { id: runId },
    data: {
      status,
      output: output === undefined ? undefined : toInputJson(output),
      error:
        error === undefined
          ? undefined
          : toInputJson({
              message: error instanceof Error ? error.message : String(error)
            }),
      completedAt: new Date()
    }
  });
}

async function markEnrichmentProviderSuccess(provider: SavedProviderRecord) {
  await prisma.enrichmentProvider.update({
    where: { id: provider.id },
    data: {
      successCount: { increment: 1 },
      lastUsedAt: new Date(),
      ...(shouldAutoActivateProvider(provider) ? { status: "active" } : {})
    }
  });
}

async function markEnrichmentProviderFailure(provider: SavedProviderRecord, reason: string) {
  await prisma.enrichmentProvider.update({
    where: { id: provider.id },
    data: {
      failureCount: { increment: 1 },
      lastUsedAt: new Date(),
      ...(shouldAutoDisableProvider(provider) ? { status: "disabled" } : {})
    }
  });
  console.warn(JSON.stringify({ service: "worker-analysis", providerType: "enrichment", providerId: provider.id, reason }));
}

async function markEmailVerificationProviderSuccess(provider: SavedProviderRecord) {
  await prisma.emailVerificationProvider.update({
    where: { id: provider.id },
    data: {
      successCount: { increment: 1 },
      lastUsedAt: new Date(),
      ...(shouldAutoActivateProvider(provider) ? { status: "active" } : {})
    }
  });
}

async function markEmailVerificationProviderFailure(provider: SavedProviderRecord, reason: string) {
  await prisma.emailVerificationProvider.update({
    where: { id: provider.id },
    data: {
      failureCount: { increment: 1 },
      lastUsedAt: new Date(),
      ...(shouldAutoDisableProvider(provider) ? { status: "disabled" } : {})
    }
  });
  console.warn(
    JSON.stringify({ service: "worker-analysis", providerType: "email_verification", providerId: provider.id, reason })
  );
}

async function createProviderEvidence(params: {
  campaignId: string;
  companyId?: string;
  leadId?: string;
  field: string;
  sourceType: string;
  url: string;
  quote: string;
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
      retrievalMethod: "api",
      url: params.url,
      finalUrl: params.url,
      quote,
      contentHash: hashText(quote)
    }
  });
}

async function updateCompanyEmailVerification(
  companyId: string | undefined,
  providerName: string,
  result: EmailVerificationResult
) {
  if (!companyId) return;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;
  const email = result.normalizedEmail ?? result.email;
  const metadata = isRecord(company.metadata) ? { ...company.metadata } : {};
  const current = isRecord(metadata.emailVerification) ? metadata.emailVerification : {};
  metadata.emailVerification = {
    ...current,
    [email]: {
      providerName,
      status: result.status,
      score: result.score,
      reason: result.reason,
      checkedAt: new Date().toISOString()
    }
  };

  await prisma.company.update({
    where: { id: companyId },
    data: {
      metadata: metadata as Prisma.InputJsonValue,
      lastCheckedAt: new Date()
    }
  });
}

function parseProviderResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function renderTemplateValue(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, input);
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, input));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, input)]));
  }
  return value;
}

function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template
    .replace(/\{env[:.]([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "")
    .replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, pathValue: string) => stringifyTemplateValue(firstValueAtPath(input, pathValue)));
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringifyTemplateValue).filter(Boolean).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function firstStringAtPath(value: unknown, pathValue?: string): string | undefined {
  if (!pathValue) return undefined;
  const valueAtPath = firstValueAtPath(value, pathValue);
  if (typeof valueAtPath === "string") return valueAtPath.trim() || undefined;
  if (typeof valueAtPath === "number" || typeof valueAtPath === "boolean") return String(valueAtPath);
  return undefined;
}

function stringsAtPath(value: unknown, pathValue?: string): string[] {
  if (!pathValue) return [];
  return [...new Set(collectStrings(valuesAtPath(value, pathValue)).map((item) => item.trim()).filter(Boolean))];
}

function numberAtPath(value: unknown, pathValue?: string): number | undefined {
  if (!pathValue) return undefined;
  const valueAtPath = firstValueAtPath(value, pathValue);
  if (typeof valueAtPath === "number" && !Number.isNaN(valueAtPath)) return valueAtPath > 1 ? valueAtPath / 100 : valueAtPath;
  if (typeof valueAtPath === "string") {
    const parsed = Number(valueAtPath);
    if (!Number.isNaN(parsed)) return parsed > 1 ? parsed / 100 : parsed;
  }
  return undefined;
}

function firstValueAtPath(value: unknown, pathValue: string): unknown {
  return valuesAtPath(value, pathValue)[0];
}

function valuesAtPath(value: unknown, pathValue: string): unknown[] {
  const segments = pathValue.split(".").map((segment) => segment.trim()).filter(Boolean);
  let current: unknown[] = [value];

  for (const segment of segments) {
    const { key, arrayMode, index } = parsePathSegment(segment);
    const next: unknown[] = [];
    for (const item of current) {
      const valueAtKey = key ? readProperty(item, key) : item;
      if (index !== undefined && Array.isArray(valueAtKey)) {
        next.push(valueAtKey[index]);
      } else if (arrayMode && Array.isArray(valueAtKey)) {
        next.push(...valueAtKey);
      } else {
        next.push(valueAtKey);
      }
    }
    current = next.filter((item) => item !== null && item !== undefined);
  }

  return current;
}

function parsePathSegment(segment: string): { key: string; arrayMode: boolean; index?: number } {
  const arrayMatch = segment.match(/^(.+)\[\]$/);
  if (arrayMatch) return { key: arrayMatch[1], arrayMode: true };
  const indexMatch = segment.match(/^(.+)\[(\d+)\]$/);
  if (indexMatch) return { key: indexMatch[1], arrayMode: false, index: Number(indexMatch[2]) };
  return { key: segment, arrayMode: false };
}

function readProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function collectStrings(values: unknown[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      strings.push(String(value));
    } else if (Array.isArray(value)) {
      strings.push(...collectStrings(value));
    } else if (isRecord(value)) {
      for (const key of ["email", "value", "address", "url", "name"]) {
        if (typeof value[key] === "string") strings.push(value[key]);
      }
    }
  }
  return strings;
}

function peopleAtPath(value: unknown, pathValue?: string): EnrichedPerson[] {
  if (!pathValue) return [];
  const people: EnrichedPerson[] = [];
  for (const item of valuesAtPath(value, pathValue)) {
    const items = Array.isArray(item) ? item : [item];
    for (const candidate of items) {
      const person = personFromValue(candidate);
      if (person) people.push(person);
    }
  }
  return dedupePeople(people);
}

function personFromValue(value: unknown): EnrichedPerson | null {
  if (typeof value === "string") {
    const [name, role] = value.split(/\s+-\s+|\s+\|\s+/, 2).map((part) => part.trim());
    return name ? { name, role } : null;
  }
  if (!isRecord(value)) return null;
  const firstName = stringFromUnknown(value.firstName ?? value.first_name);
  const lastName = stringFromUnknown(value.lastName ?? value.last_name);
  const name =
    stringFromUnknown(value.name ?? value.fullName ?? value.full_name) ??
    [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!name) return null;
  return {
    name,
    role: stringFromUnknown(value.role ?? value.title ?? value.jobTitle ?? value.job_title ?? value.position),
    email: normalizeEmail(stringFromUnknown(value.email ?? value.emailAddress ?? value.email_address) ?? "")
  };
}

function dedupePeople(people: EnrichedPerson[]): EnrichedPerson[] {
  const deduped = new Map<string, EnrichedPerson>();
  for (const person of people) {
    deduped.set(`${person.name.toLowerCase()}|${(person.role ?? "").toLowerCase()}`, person);
  }
  return [...deduped.values()].slice(0, 50);
}

function mapVerificationStatus(
  statusValue: string | undefined,
  score: number | undefined,
  mapping: EmailVerificationProviderConfig["outputMapping"]
): EmailVerificationStatus {
  const normalized = (statusValue ?? "").toLowerCase().trim();
  if (mapping.deliverableValues.map((value) => value.toLowerCase()).includes(normalized)) return "verified";
  if (mapping.invalidValues.map((value) => value.toLowerCase()).includes(normalized)) return "invalid";
  if (mapping.riskyValues.map((value) => value.toLowerCase()).includes(normalized)) return "risky";
  if (typeof score === "number" && score >= 0.8) return "verified";
  if (typeof score === "number" && score <= 0.2) return "invalid";
  return "unknown";
}

function maxVerificationConfidence(results: EmailVerificationResult[], fallback: number): number {
  return Math.max(fallback, ...results.map(verificationConfidence));
}

function verificationConfidence(result: EmailVerificationResult): number {
  if (typeof result.score === "number") return clamp01(result.score);
  if (result.status === "verified" || result.status === "invalid") return 0.85;
  if (result.status === "risky") return 0.55;
  return 0.35;
}

function providerAppliesToCompany(supportedDomains: string[], company: CompanySnapshot | null): boolean {
  if (!supportedDomains.length) return true;
  const domains = [
    company?.domain,
    domainFromUrl(company?.website ?? ""),
    ...readJsonStringArray(company?.emails).map((email) => email.split("@")[1])
  ].filter((domain): domain is string => Boolean(domain));
  return domains.some((domain) => supportedDomains.some((supported) => domainMatches(domain, supported)));
}

function providerAppliesToEmail(supportedDomains: string[], email: string): boolean {
  if (!supportedDomains.length) return true;
  const domain = email.split("@")[1];
  return Boolean(domain && supportedDomains.some((supported) => domainMatches(domain, supported)));
}

function domainMatches(domain: string, supportedDomain: string): boolean {
  const normalized = supportedDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const candidate = domain.trim().toLowerCase().replace(/^www\./, "");
  return Boolean(normalized) && (candidate === normalized || candidate.endsWith(`.${normalized}`));
}

function domainFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]?.toLowerCase();
  if (!email || email.includes("@example.") || email.includes("@domain.")) return undefined;
  return email;
}

function missingEnvVars(names: string[]): string[] {
  return names.filter((name) => !process.env[name]);
}

function shouldAutoActivateProvider(provider: SavedProviderRecord): boolean {
  const threshold = Number(process.env.PROVIDER_AUTO_ACTIVATE_AFTER ?? 3);
  return provider.status === "trial" && threshold > 0 && provider.successCount + 1 >= threshold;
}

function shouldAutoDisableProvider(provider: SavedProviderRecord): boolean {
  const threshold = Number(process.env.PROVIDER_AUTO_DISABLE_AFTER ?? 10);
  return provider.status !== "disabled" && provider.successCount === 0 && threshold > 0 && provider.failureCount + 1 >= threshold;
}

async function waitForProviderRateLimit(rateLimitPerMinute: number) {
  if (process.env.PROVIDER_ENFORCE_RATE_LIMITS === "false") return;
  const delayMs = Math.ceil(60_000 / Math.max(1, rateLimitPerMinute));
  const cappedDelayMs = Math.min(delayMs, Number(process.env.PROVIDER_MAX_RATE_DELAY_MS ?? 30_000));
  if (cappedDelayMs > 50) await sleep(cappedDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeProviderMetadata(existing: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = isRecord(existing) ? existing : {};
  return {
    ...base,
    ...patch
  } as Prisma.InputJsonValue;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
