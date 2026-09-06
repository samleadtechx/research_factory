import { z } from "zod";

export const CampaignStatusSchema = z.enum([
  "draft",
  "planning",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);

export const RetrievalMethodSchema = z.enum([
  "browser",
  "camoufox",
  "http",
  "api",
  "manual"
]);

export const ProxyProtocolSchema = z.enum(["http", "https", "socks5"]);

export const ProxyStatusSchema = z.enum([
  "untested",
  "healthy",
  "degraded",
  "cooldown",
  "quarantined"
]);

export const EvidenceSourceTypeSchema = z.enum([
  "company_website",
  "business_profile",
  "search_result",
  "directory",
  "review_page",
  "careers_page",
  "job_posting",
  "social_business_page",
  "other_public_source"
]);

export const ConfidenceBandSchema = z.enum([
  "auto_accept",
  "cross_check",
  "validation_required"
]);

export const EmailStatusSchema = z.enum([
  "verified",
  "published",
  "unknown",
  "invalid"
]);

export const ServerSettingsSchema = z.object({
  serverUsagePercent: z.number().int().min(1).max(100).default(60),
  maxBrowsersHardCap: z.number().int().min(1).max(200).default(40),
  maxQwenConcurrency: z.number().int().min(1).max(64).default(4),
  maxCampaignRuntimeMinutes: z.number().int().min(1).max(10080).default(240),
  maxPagesPerLead: z.number().int().min(1).max(500).default(25),
  proxyRetryCount: z.number().int().min(0).max(10).default(2),
  browserFirst: z.boolean().default(true)
});

export const DebugBrowserHeadlessSchema = z.union([z.boolean(), z.literal("virtual")]);

export const RuntimeSettingsSchema = ServerSettingsSchema.extend({
  redisUrl: z.string().trim().min(1).default("redis://localhost:6379"),
  localLlmBaseUrl: z.string().trim().min(1).default("http://73.72.215.253:11434/v1"),
  localLlmModel: z.string().trim().min(1).default("qwen2.5:14b"),
  localLlmApiKey: z.string().default("local"),
  appStorageDir: z.string().trim().min(1).default("./data"),
  maxDiscoveryResults: z.number().int().min(1).max(100000).default(80),
  searchRetryCount: z.number().int().min(0).max(10).default(2),
  browserHeadless: z.boolean().default(true),
  browserActionTimeoutMs: z.number().int().min(500).max(120000).default(15000),
  browserNavigationTimeoutMs: z.number().int().min(1000).max(180000).default(45000),
  maxActiveSourceRecipes: z.number().int().min(0).max(200).default(10),
  sourceRecipeResultLimit: z.number().int().min(1).max(10000).default(60),
  sourceRecipeMaxQueries: z.number().int().min(0).max(200).default(8),
  sourceRecipeMaxSeeds: z.number().int().min(0).max(500).default(10),
  sourceRecipeMaxPages: z.number().int().min(1).max(100).default(8),
  sourceRecipeRetryCount: z.number().int().min(0).max(10).default(2),
  sourceRecipeAutoActivateAfter: z.number().int().min(0).max(1000).default(3),
  sourceRecipeAutoDisableAfter: z.number().int().min(0).max(1000).default(10),
  maxActiveEnrichmentProviders: z.number().int().min(0).max(200).default(5),
  maxActiveEmailVerificationProviders: z.number().int().min(0).max(100).default(3),
  maxEmailsToVerifyPerLead: z.number().int().min(0).max(500).default(10),
  providerAutoActivateAfter: z.number().int().min(0).max(1000).default(3),
  providerAutoDisableAfter: z.number().int().min(0).max(1000).default(10),
  providerEnforceRateLimits: z.boolean().default(true),
  providerMaxRateDelayMs: z.number().int().min(0).max(300000).default(30000),
  qwenTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  qwenMaxSourceChars: z.number().int().min(1000).max(1000000).default(45000),
  debugBrowserHeadless: DebugBrowserHeadlessSchema.default("virtual"),
  debugBrowserMaxSessions: z.number().int().min(1).max(50).default(3),
  debugBrowserActionTimeoutMs: z.number().int().min(500).max(120000).default(15000),
  debugBrowserNavigationTimeoutMs: z.number().int().min(1000).max(180000).default(45000),
  debugBrowserConnectTimeoutMs: z.number().int().min(1000).max(180000).default(45000),
  debugBrowserMaxTextChars: z.number().int().min(1000).max(500000).default(8000)
});

export const RuntimeSettingsUpdateSchema = z.object({
  redisUrl: z.string().trim().min(1).optional(),
  localLlmBaseUrl: z.string().trim().min(1).optional(),
  localLlmModel: z.string().trim().min(1).optional(),
  localLlmApiKey: z.string().optional(),
  appStorageDir: z.string().trim().min(1).optional(),
  serverUsagePercent: z.number().int().min(1).max(100).optional(),
  maxBrowsersHardCap: z.number().int().min(1).max(200).optional(),
  maxQwenConcurrency: z.number().int().min(1).max(64).optional(),
  maxCampaignRuntimeMinutes: z.number().int().min(1).max(10080).optional(),
  maxPagesPerLead: z.number().int().min(1).max(500).optional(),
  proxyRetryCount: z.number().int().min(0).max(10).optional(),
  browserFirst: z.boolean().optional(),
  maxDiscoveryResults: z.number().int().min(1).max(100000).optional(),
  searchRetryCount: z.number().int().min(0).max(10).optional(),
  browserHeadless: z.boolean().optional(),
  browserActionTimeoutMs: z.number().int().min(500).max(120000).optional(),
  browserNavigationTimeoutMs: z.number().int().min(1000).max(180000).optional(),
  maxActiveSourceRecipes: z.number().int().min(0).max(200).optional(),
  sourceRecipeResultLimit: z.number().int().min(1).max(10000).optional(),
  sourceRecipeMaxQueries: z.number().int().min(0).max(200).optional(),
  sourceRecipeMaxSeeds: z.number().int().min(0).max(500).optional(),
  sourceRecipeMaxPages: z.number().int().min(1).max(100).optional(),
  sourceRecipeRetryCount: z.number().int().min(0).max(10).optional(),
  sourceRecipeAutoActivateAfter: z.number().int().min(0).max(1000).optional(),
  sourceRecipeAutoDisableAfter: z.number().int().min(0).max(1000).optional(),
  maxActiveEnrichmentProviders: z.number().int().min(0).max(200).optional(),
  maxActiveEmailVerificationProviders: z.number().int().min(0).max(100).optional(),
  maxEmailsToVerifyPerLead: z.number().int().min(0).max(500).optional(),
  providerAutoActivateAfter: z.number().int().min(0).max(1000).optional(),
  providerAutoDisableAfter: z.number().int().min(0).max(1000).optional(),
  providerEnforceRateLimits: z.boolean().optional(),
  providerMaxRateDelayMs: z.number().int().min(0).max(300000).optional(),
  qwenTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  qwenMaxSourceChars: z.number().int().min(1000).max(1000000).optional(),
  debugBrowserHeadless: DebugBrowserHeadlessSchema.optional(),
  debugBrowserMaxSessions: z.number().int().min(1).max(50).optional(),
  debugBrowserActionTimeoutMs: z.number().int().min(500).max(120000).optional(),
  debugBrowserNavigationTimeoutMs: z.number().int().min(1000).max(180000).optional(),
  debugBrowserConnectTimeoutMs: z.number().int().min(1000).max(180000).optional(),
  debugBrowserMaxTextChars: z.number().int().min(1000).max(500000).optional()
});

export const CreateCampaignInputSchema = z.object({
  prompt: z.string().trim().min(20),
  name: z.string().trim().min(1).max(160).optional(),
  targetLeadCount: z.number().int().min(1).max(100000).optional(),
  serverUsagePercent: z.number().int().min(1).max(100).optional()
});

export const ScoringRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  field: z.string().min(1),
  operator: z.enum([
    "equals",
    "not_equals",
    "contains",
    "exists",
    "not_exists",
    "gte",
    "lte"
  ]),
  value: z.unknown().optional(),
  points: z.number().int().min(-100).max(100),
  requiredConfidence: z.number().min(0).max(1).default(0.8),
  requiresEvidence: z.boolean().default(true)
});

export const CampaignPlanSchema = z.object({
  campaignName: z.string().min(1).max(160),
  icpDescription: z.string().min(1),
  geography: z.array(z.string().min(1)).default([]),
  positiveSignals: z.array(z.string().min(1)).default([]),
  negativeFilters: z.array(z.string().min(1)).default([]),
  disqualificationRules: z.array(z.string().min(1)).default([]),
  requiredEvidenceFields: z.array(z.string().min(1)).default([]),
  contactRequirements: z.array(z.string().min(1)).default([
    "company website emails",
    "public business profile emails",
    "public owner or manager names"
  ]),
  sourceStrategy: z.array(z.string().min(1)).default([]),
  scoringRules: z.array(ScoringRuleSchema).default([]),
  maxPagesPerLead: z.number().int().min(1).max(500).default(25),
  outputColumns: z.array(z.string().min(1)).default([]),
  plannerNotes: z.string().default("")
});

export const ProxyInputSchema = z.object({
  protocol: ProxyProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  label: z.string().optional()
});

export const ProxyUploadSchema = z.object({
  text: z.string().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional()
});

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1).optional(),
  leadId: z.string().min(1).optional(),
  sourceType: EvidenceSourceTypeSchema,
  retrievalMethod: RetrievalMethodSchema,
  url: z.string().url(),
  finalUrl: z.string().url().optional(),
  quote: z.string().min(1),
  documentId: z.string().min(1).optional(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().min(1).optional()
});

export const ClaimSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
  promptName: z.string().min(1),
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  analysisVersion: z.string().min(1),
  createdAt: z.string().datetime()
});

export const LeadScoreComponentSchema = z.object({
  ruleId: z.string().min(1),
  label: z.string().min(1),
  points: z.number().int(),
  claimIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  explanation: z.string().default("")
});

export const LeadSummarySchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  companyName: z.string().min(1),
  website: z.string().url().optional(),
  location: z.string().optional(),
  score: z.number().int(),
  confidence: z.number().min(0).max(1),
  strongestSignal: z.string().optional(),
  compactEvidence: z.array(EvidenceSchema).max(10).default([])
});

export const SystemCapacitySchema = z.object({
  platform: z.string(),
  cpuCores: z.number().int().min(1),
  loadAverage1m: z.number().min(0).optional(),
  cpuUsagePercent: z.number().min(0).max(100).optional(),
  totalMemoryBytes: z.number().int().min(1),
  freeMemoryBytes: z.number().int().min(0).optional(),
  usedMemoryBytes: z.number().int().min(0).optional(),
  memoryUsagePercent: z.number().min(0).max(100).optional(),
  disk: z
    .object({
      path: z.string(),
      totalBytes: z.number().int().min(1),
      usedBytes: z.number().int().min(0),
      availableBytes: z.number().int().min(0),
      usagePercent: z.number().min(0).max(100)
    })
    .optional(),
  gpu: z
    .object({
      available: z.boolean(),
      name: z.string().optional(),
      memoryTotalMiB: z.number().optional(),
      memoryUsedMiB: z.number().optional(),
      utilizationPercent: z.number().optional(),
      detectionSource: z.string().optional(),
      detail: z.string().optional()
    })
    .default({ available: false })
});

export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;
export type ScoringRule = z.infer<typeof ScoringRuleSchema>;
export type ProxyInput = z.infer<typeof ProxyInputSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
export type DebugBrowserHeadless = z.infer<typeof DebugBrowserHeadlessSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type RuntimeSettingsUpdate = z.infer<typeof RuntimeSettingsUpdateSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type LeadScoreComponent = z.infer<typeof LeadScoreComponentSchema>;
export type LeadSummary = z.infer<typeof LeadSummarySchema>;
export type SystemCapacity = z.infer<typeof SystemCapacitySchema>;

export function confidenceBand(confidence: number): z.infer<typeof ConfidenceBandSchema> {
  if (confidence >= 0.9) return "auto_accept";
  if (confidence >= 0.7) return "cross_check";
  return "validation_required";
}
