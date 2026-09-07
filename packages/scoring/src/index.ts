import type { Claim, LeadScoreComponent, ScoringRule } from "@leadfactory/schemas";

export type ScoreResult = {
  score: number;
  components: LeadScoreComponent[];
  rejectedRuleIds: string[];
};

export function scoreClaims(params: {
  claims: Claim[];
  rules: ScoringRule[];
  cap?: number;
}): ScoreResult {
  const components: LeadScoreComponent[] = [];
  const rejectedRuleIds: string[] = [];

  for (const rule of params.rules) {
    const claim = params.claims.find((candidate) => fieldsMatch(candidate.field, rule.field));
    if (!claim || claim.confidence < rule.requiredConfidence) {
      rejectedRuleIds.push(rule.id);
      continue;
    }

    if (rule.requiresEvidence && claim.evidenceIds.length === 0) {
      rejectedRuleIds.push(rule.id);
      continue;
    }

    if (!matchesRule(claim.value, rule)) {
      rejectedRuleIds.push(rule.id);
      continue;
    }

    components.push({
      ruleId: rule.id,
      label: rule.label,
      points: rule.points,
      claimIds: [claim.id],
      evidenceIds: claim.evidenceIds,
      explanation: `${rule.label}: ${rule.points > 0 ? "+" : ""}${rule.points}`
    });
  }

  const rawScore = components.reduce((total, component) => total + component.points, 0);
  const score = typeof params.cap === "number" ? Math.min(params.cap, rawScore) : rawScore;

  return { score, components, rejectedRuleIds };
}

function fieldsMatch(claimField: string, ruleField: string): boolean {
  if (claimField === ruleField) return true;
  const claimAliases = fieldAliases(claimField);
  const ruleAliases = fieldAliases(ruleField);
  return claimAliases.some((alias) => ruleAliases.includes(alias));
}

function fieldAliases(field: string): string[] {
  const normalized = field.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  if (
    [
      "googlereviewcount",
      "googlereviews",
      "googlereviewscount",
      "reviewcount",
      "reviewscount",
      "reviews"
    ].includes(normalized)
  ) {
    return ["googlereviewcount", "reviewcount", "reviews"];
  }
  return [normalized];
}

function matchesRule(value: unknown, rule: ScoringRule): boolean {
  switch (rule.operator) {
    case "equals":
      return value === rule.value;
    case "not_equals":
      return value !== rule.value;
    case "contains":
      return Array.isArray(value)
        ? value.includes(rule.value)
        : String(value).toLowerCase().includes(String(rule.value).toLowerCase());
    case "exists":
      return value !== null && value !== undefined && value !== "";
    case "not_exists":
      return value === null || value === undefined || value === "";
    case "gte":
      return Number(value) >= Number(rule.value);
    case "lte":
      return Number(value) <= Number(rule.value);
    default:
      return false;
  }
}
