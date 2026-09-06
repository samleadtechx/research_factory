import { describe, expect, it } from "vitest";
import { scoreClaims } from "@leadfactory/scoring";

describe("lead scoring", () => {
  it("requires confidence and evidence before awarding points", () => {
    const result = scoreClaims({
      cap: 25,
      claims: [
        {
          id: "claim_1",
          field: "hiring_dispatcher",
          value: true,
          confidence: 0.96,
          evidenceIds: ["ev_1"],
          promptName: "job_signal",
          promptVersion: "v1",
          model: "qwen2.5:14b",
          analysisVersion: "v1",
          createdAt: new Date().toISOString()
        },
        {
          id: "claim_2",
          field: "owner_name",
          value: "Jane Smith",
          confidence: 0.62,
          evidenceIds: ["ev_2"],
          promptName: "decision_maker",
          promptVersion: "v1",
          model: "qwen2.5:14b",
          analysisVersion: "v1",
          createdAt: new Date().toISOString()
        }
      ],
      rules: [
        {
          id: "hiring_dispatcher",
          label: "Hiring dispatcher",
          field: "hiring_dispatcher",
          operator: "equals",
          value: true,
          points: 5,
          requiredConfidence: 0.9,
          requiresEvidence: true
        },
        {
          id: "owner_identified",
          label: "Owner identified",
          field: "owner_name",
          operator: "exists",
          points: 2,
          requiredConfidence: 0.85,
          requiresEvidence: true
        }
      ]
    });

    expect(result.score).toBe(5);
    expect(result.components).toHaveLength(1);
    expect(result.rejectedRuleIds).toEqual(["owner_identified"]);
  });
});
