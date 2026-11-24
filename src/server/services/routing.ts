import type { RoutingRule, RoutingTarget } from "../../shared/schemas";

type Answers = Record<string, string | string[]>;

function norm(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function conditionMatches(cond: RoutingRule["conditions"][number], answers: Answers): boolean {
  const actual = norm(answers[cond.fieldId]);
  const expected = norm(cond.value as string | string[] | undefined);
  switch (cond.op) {
    case "is_empty":
      return actual.length === 0;
    case "not_empty":
      return actual.length > 0;
    case "equals":
      return actual.length > 0 && expected.length > 0 && actual.join(",") === expected.join(",");
    case "not_equals":
      return actual.join(",") !== expected.join(",");
    case "contains":
      return expected.length > 0 && actual.some((a) => expected.some((e) => a.includes(e)));
    case "in":
      return actual.length > 0 && actual.some((a) => expected.includes(a));
  }
}

/** First matching rule wins; otherwise the fallback target is used. */
export function evaluateRouting(rules: RoutingRule[], fallback: RoutingTarget, answers: Answers): RoutingTarget {
  for (const rule of rules) {
    const results = rule.conditions.map((c) => conditionMatches(c, answers));
    const ok = rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
    if (ok) return rule.target;
  }
  return fallback;
}
