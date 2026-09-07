import type { LLMProvider } from "@leadfactory/llm";
import { CampaignPlanSchema, type CampaignPlan } from "@leadfactory/schemas";

export async function planCampaign(params: {
  prompt: string;
  llm: LLMProvider;
  name?: string;
}): Promise<CampaignPlan> {
  try {
    return await params.llm.structuredCompletion({
      system:
        "You are a lead research campaign architect. Return only valid JSON. Design strict, evidence-first campaigns.",
      prompt: buildCampaignPlannerPrompt(params.prompt),
      schema: CampaignPlanSchema,
      temperature: 0.1
    });
  } catch (error) {
    return createFallbackCampaignPlan({
      prompt: params.prompt,
      name: params.name,
      reason: error instanceof Error ? error.message : "Planner returned an invalid campaign plan."
    });
  }
}

export function buildCampaignPlannerPrompt(userPrompt: string): string {
  return `Create a lead research campaign plan from this user prompt.

User prompt:
${userPrompt}

Rules:
- This is a generic lead generation system. Do not assume RingPort or restoration unless the user prompt says so.
- Create positive buying signals and negative filters automatically.
- Use browser-first public web discovery.
- Require evidence for every important factual field.
- Include public owner or manager names and public business contact emails when relevant.
- Do not include private personal data.
- Do not bypass login pages, CAPTCHA, bans, or access controls.
- Keep output columns useful for a ranked dashboard and compact CSV.
- Scoring rules must be deterministic and explainable.
- Return JSON matching the requested schema.
- Always include non-empty campaignName and icpDescription.

Required JSON shape:
{
  "campaignName": "Short descriptive campaign name",
  "icpDescription": "The exact target customer profile in plain language",
  "geography": [],
  "positiveSignals": [],
  "negativeFilters": [],
  "disqualificationRules": [],
  "requiredEvidenceFields": ["company_website", "public_email", "owner_manager_name"],
  "contactRequirements": ["company website emails", "public business profile emails", "public owner or manager names"],
  "sourceStrategy": ["browser_search", "company_website", "business_profile"],
  "scoringRules": [],
  "maxPagesPerLead": 25,
  "outputColumns": ["rank", "company", "website", "score", "email", "decision_maker", "evidence"],
  "plannerNotes": ""
}`;
}

export function createFallbackCampaignPlan(params: {
  prompt: string;
  name?: string;
  reason?: string;
}): CampaignPlan {
  const prompt = normalizeWhitespace(params.prompt);
  return CampaignPlanSchema.parse({
    campaignName: params.name ?? deriveCampaignName(prompt),
    icpDescription: prompt || "Unspecified lead research prompt",
    geography: [],
    positiveSignals: [
      "matches the user supplied ICP prompt",
      "has a public company website or business profile",
      "publishes owner, manager, or business contact information"
    ],
    negativeFilters: [
      "does not match the user supplied ICP prompt",
      "requires login or private access to verify fit",
      "only has weak or missing public evidence"
    ],
    disqualificationRules: [
      "Do not include companies without public evidence of fit.",
      "Do not include private personal emails or scraped gated data.",
      "Do not guess owners, managers, email addresses, or decision makers."
    ],
    requiredEvidenceFields: ["company_website", "public_email", "owner_manager_name"],
    contactRequirements: [
      "company website emails",
      "public business profile emails",
      "public owner or manager names"
    ],
    sourceStrategy: ["browser_search", "company_website", "business_profile"],
    scoringRules: [
      {
        id: "public_fit_evidence",
        label: "Public evidence matches ICP",
        field: "icp_fit",
        operator: "exists",
        points: 40,
        requiredConfidence: 0.8,
        requiresEvidence: true
      },
      {
        id: "public_contact_email",
        label: "Published business email found",
        field: "public_email",
        operator: "exists",
        points: 25,
        requiredConfidence: 0.8,
        requiresEvidence: true
      },
      {
        id: "decision_maker_found",
        label: "Owner or manager identified",
        field: "owner_manager_name",
        operator: "exists",
        points: 25,
        requiredConfidence: 0.8,
        requiresEvidence: true
      },
      {
        id: "weak_or_blocked_source",
        label: "Weak, blocked, or unverifiable public evidence",
        field: "evidence_quality",
        operator: "equals",
        value: "weak",
        points: -30,
        requiredConfidence: 0.8,
        requiresEvidence: true
      }
    ],
    maxPagesPerLead: 25,
    outputColumns: ["rank", "company", "website", "score", "email", "decision_maker", "evidence"],
    plannerNotes: `Fallback plan generated because planner output was invalid. ${params.reason ?? ""}`.trim()
  });
}

function deriveCampaignName(prompt: string): string {
  const firstLine = prompt.split(/\n/).map((line) => line.trim()).find(Boolean) ?? "Lead research campaign";
  const cleaned = firstLine
    .replace(/^find\s+/i, "")
    .replace(/^search\s+/i, "")
    .replace(/^create\s+(a\s+)?campaign\s+(for\s+)?/i, "")
    .trim();
  const base = cleaned || "Lead research campaign";
  return base.length <= 96 ? base : `${base.slice(0, 93).trim()}...`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
