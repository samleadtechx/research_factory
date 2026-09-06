import { z } from "zod";
import type { CampaignPlan } from "@leadfactory/schemas";

export const SourceAdapterHealthSchema = z.object({
  status: z.enum(["healthy", "degraded", "blocked", "disabled"]),
  lastRequestAt: z.string().datetime().optional(),
  successRate: z.number().min(0).max(1).default(0),
  averageLatencyMs: z.number().min(0).optional(),
  notes: z.string().optional()
});

export const SourceRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["trial", "active", "disabled"]).default("trial"),
  supportedDomains: z.array(z.string()).default([]),
  generatedFromCampaignId: z.string().optional(),
  steps: z.array(
    z.object({
      action: z.enum([
        "open_url",
        "search_web",
        "click_selector",
        "extract_links",
        "extract_text",
        "extract_structured_fields",
        "paginate"
      ]),
      selector: z.string().optional(),
      value: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional()
    })
  ),
  successCount: z.number().int().min(0).default(0),
  failureCount: z.number().int().min(0).default(0)
});

export type SourceAdapterHealth = z.infer<typeof SourceAdapterHealthSchema>;
export type SourceRecipe = z.infer<typeof SourceRecipeSchema>;

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
