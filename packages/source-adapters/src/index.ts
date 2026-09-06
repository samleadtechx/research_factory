import { z } from "zod";
import type { CampaignPlan } from "@leadfactory/schemas";

export const SourceAdapterHealthSchema = z.object({
  status: z.enum(["healthy", "degraded", "blocked", "disabled"]),
  lastRequestAt: z.string().datetime().optional(),
  successRate: z.number().min(0).max(1).default(0),
  averageLatencyMs: z.number().min(0).optional(),
  notes: z.string().optional()
});

export const SourceRecipeStatusSchema = z.enum(["trial", "active", "disabled"]);
export const SavedProviderStatusSchema = SourceRecipeStatusSchema;

export const ProviderHttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH"]);

const JsonTemplateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonTemplateSchema),
    z.record(z.string(), JsonTemplateSchema)
  ])
);

export const ProviderRequestTemplateSchema = z.object({
  method: ProviderHttpMethodSchema.default("GET"),
  urlTemplate: z.string().trim().min(1),
  headersTemplate: z.record(z.string().trim().min(1), z.string()).default({}),
  queryTemplate: z.record(z.string().trim().min(1), z.string()).default({}),
  bodyTemplate: JsonTemplateSchema.optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
  retryCount: z.number().int().min(0).max(5).default(1)
});

export const EnrichmentOutputMappingSchema = z.object({
  companyNamePath: z.string().trim().min(1).optional(),
  websitePath: z.string().trim().min(1).optional(),
  domainPath: z.string().trim().min(1).optional(),
  phonePath: z.string().trim().min(1).optional(),
  cityPath: z.string().trim().min(1).optional(),
  statePath: z.string().trim().min(1).optional(),
  countryPath: z.string().trim().min(1).optional(),
  emailsPath: z.string().trim().min(1).optional(),
  ownersPath: z.string().trim().min(1).optional(),
  managersPath: z.string().trim().min(1).optional(),
  decisionMakersPath: z.string().trim().min(1).optional(),
  sourceUrlPath: z.string().trim().min(1).optional(),
  evidenceQuotePath: z.string().trim().min(1).optional(),
  confidencePath: z.string().trim().min(1).optional()
});

export const EnrichmentProviderConfigSchema = z.object({
  description: z.string().trim().max(2000).default(""),
  kind: z.enum(["http_api"]).default("http_api"),
  request: ProviderRequestTemplateSchema,
  requiredEnvVars: z.array(z.string().trim().min(1)).max(50).default([]),
  inputFields: z
    .array(z.enum(["companyName", "domain", "website", "city", "state", "country", "phone", "emails"]))
    .default(["companyName", "domain", "website"]),
  runWhen: z.enum(["always", "missing_email", "missing_decision_maker", "missing_contact_data"]).default("missing_contact_data"),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(60),
  outputMapping: EnrichmentOutputMappingSchema.default({})
});

export const CreateEnrichmentProviderInputSchema = EnrichmentProviderConfigSchema.extend({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40).default("v1"),
  status: SavedProviderStatusSchema.default("trial"),
  campaignId: z.string().trim().min(1).optional(),
  supportedDomains: z.array(z.string().trim().min(1)).max(100).default([])
});

const defaultEmailVerificationOutputMapping = {
  statusPath: "status",
  deliverableValues: ["valid", "deliverable", "verified", "ok"],
  invalidValues: ["invalid", "undeliverable", "bad", "rejected"],
  riskyValues: ["risky", "catch_all", "accept_all", "unknown"]
};

export const EmailVerificationOutputMappingSchema = z.object({
  statusPath: z.string().trim().min(1).default(defaultEmailVerificationOutputMapping.statusPath),
  normalizedEmailPath: z.string().trim().min(1).optional(),
  scorePath: z.string().trim().min(1).optional(),
  reasonPath: z.string().trim().min(1).optional(),
  sourceUrlPath: z.string().trim().min(1).optional(),
  evidenceQuotePath: z.string().trim().min(1).optional(),
  deliverableValues: z.array(z.string().trim().min(1)).default(defaultEmailVerificationOutputMapping.deliverableValues),
  invalidValues: z.array(z.string().trim().min(1)).default(defaultEmailVerificationOutputMapping.invalidValues),
  riskyValues: z.array(z.string().trim().min(1)).default(defaultEmailVerificationOutputMapping.riskyValues)
});

export const EmailVerificationProviderConfigSchema = z.object({
  description: z.string().trim().max(2000).default(""),
  kind: z.enum(["http_api"]).default("http_api"),
  request: ProviderRequestTemplateSchema,
  requiredEnvVars: z.array(z.string().trim().min(1)).max(50).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(60),
  outputMapping: EmailVerificationOutputMappingSchema.default(defaultEmailVerificationOutputMapping)
});

export const CreateEmailVerificationProviderInputSchema = EmailVerificationProviderConfigSchema.extend({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40).default("v1"),
  status: SavedProviderStatusSchema.default("trial"),
  campaignId: z.string().trim().min(1).optional(),
  supportedDomains: z.array(z.string().trim().min(1)).max(100).default([])
});

export const UpdateSavedProviderStatusInputSchema = z.object({
  status: SavedProviderStatusSchema
});

export const SourceRecipeStepSchema = z.object({
  action: z.enum([
    "open_url",
    "search_web",
    "click_selector",
    "extract_links",
    "extract_text",
    "extract_structured_fields",
    "paginate"
  ]),
  selector: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

export const SourceRecipeConfigSchema = z.object({
  description: z.string().trim().max(2000).default(""),
  discoveryQueries: z.array(z.string().trim().min(1)).max(50).default([]),
  seedUrls: z.array(z.string().trim().min(1)).max(100).default([]),
  steps: z.array(SourceRecipeStepSchema).max(200).default([]),
  outputMapping: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({})
});

export const CreateSourceRecipeInputSchema = SourceRecipeConfigSchema.extend({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40).default("v1"),
  status: SourceRecipeStatusSchema.default("trial"),
  campaignId: z.string().trim().min(1).optional(),
  supportedDomains: z.array(z.string().trim().min(1)).max(100).default([])
});

export const UpdateSourceRecipeStatusInputSchema = z.object({
  status: SourceRecipeStatusSchema
});

export const SourceRecipeSchema = SourceRecipeConfigSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  status: SourceRecipeStatusSchema.default("trial"),
  supportedDomains: z.array(z.string()).default([]),
  generatedFromCampaignId: z.string().optional(),
  successCount: z.number().int().min(0).default(0),
  failureCount: z.number().int().min(0).default(0)
});

export type SourceAdapterHealth = z.infer<typeof SourceAdapterHealthSchema>;
export type SourceRecipe = z.infer<typeof SourceRecipeSchema>;
export type SourceRecipeConfig = z.infer<typeof SourceRecipeConfigSchema>;
export type SourceRecipeStep = z.infer<typeof SourceRecipeStepSchema>;
export type CreateSourceRecipeInput = z.infer<typeof CreateSourceRecipeInputSchema>;
export type SourceRecipeStatus = z.infer<typeof SourceRecipeStatusSchema>;
export type SavedProviderStatus = z.infer<typeof SavedProviderStatusSchema>;
export type ProviderRequestTemplate = z.infer<typeof ProviderRequestTemplateSchema>;
export type EnrichmentProviderConfig = z.infer<typeof EnrichmentProviderConfigSchema>;
export type CreateEnrichmentProviderInput = z.infer<typeof CreateEnrichmentProviderInputSchema>;
export type EmailVerificationProviderConfig = z.infer<typeof EmailVerificationProviderConfigSchema>;
export type CreateEmailVerificationProviderInput = z.infer<typeof CreateEmailVerificationProviderInputSchema>;

export type DiscoveredCandidate = {
  name: string;
  website?: string;
  sourceUrl: string;
  location?: string;
  raw: Record<string, unknown>;
};

export type SourceAdapterSearchParams = {
  campaignId: string;
  plan: CampaignPlan;
  query: string;
  geography?: string[];
  limit: number;
};

export interface DiscoverySourceAdapter {
  name: string;
  rateLimitPerMinute: number;
  concurrencyLimit: number;
  supportedGeographies: string[];
  health(): Promise<SourceAdapterHealth>;
  search(params: SourceAdapterSearchParams): Promise<DiscoveredCandidate[]>;
}
