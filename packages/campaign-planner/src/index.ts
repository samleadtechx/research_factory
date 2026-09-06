import type { LLMProvider } from "@leadfactory/llm";
import { CampaignPlanSchema, type CampaignPlan } from "@leadfactory/schemas";

export async function planCampaign(params: {
  prompt: string;
  llm: LLMProvider;
}): Promise<CampaignPlan> {
  return params.llm.structuredCompletion({
    system:
      "You are a lead research campaign architect. Return only valid JSON. Design strict, evidence-first campaigns.",
    prompt: buildCampaignPlannerPrompt(params.prompt),
    schema: CampaignPlanSchema,
    temperature: 0.1
  });
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
- Return JSON matching the requested schema.`;
}
