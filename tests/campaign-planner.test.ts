import { describe, expect, it } from "vitest";
import { createFallbackCampaignPlan, planCampaign } from "@leadfactory/campaign-planner";
import type { LLMProvider } from "@leadfactory/llm";
import { CreateCampaignInputSchema } from "@leadfactory/schemas";

describe("campaign planner", () => {
  it("keeps valid structured planner output", async () => {
    const llm: LLMProvider = {
      async structuredCompletion() {
        return createFallbackCampaignPlan({
          prompt: "Find commercial roofing companies in Texas",
          name: "Texas roofing"
        });
      }
    };

    const plan = await planCampaign({
      prompt: "Find commercial roofing companies in Texas",
      llm
    });

    expect(plan.campaignName).toBe("Texas roofing");
    expect(plan.icpDescription).toBe("Find commercial roofing companies in Texas");
  });

  it("falls back when planner output is missing required fields", async () => {
    const llm: LLMProvider = {
      async structuredCompletion() {
        throw new Error("campaignName and icpDescription are required");
      }
    };

    const plan = await planCampaign({
      prompt: "ory integration",
      name: "Ory integration",
      llm
    });

    expect(plan.campaignName).toBe("Ory integration");
    expect(plan.icpDescription).toBe("ory integration");
    expect(plan.requiredEvidenceFields).toContain("public_email");
    expect(plan.plannerNotes).toContain("Fallback plan generated");
  });

  it("accepts compact campaign prompts", () => {
    const input = CreateCampaignInputSchema.parse({
      prompt: "ory integration"
    });

    expect(input.prompt).toBe("ory integration");
  });
});
