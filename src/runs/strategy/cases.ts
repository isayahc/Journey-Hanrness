export interface EvaluationCase {
  id: string;
  title: string;
  criterion: string;
}

export const REPAIR_V1_CASES: EvaluationCase[] = [
  {
    id: "schema-repair",
    title: "Repair an invalid record using failure evidence",
    criterion: "After the first attempt fails schema validation, a later attempt emits the expected record.",
  },
  {
    id: "stable-summary",
    title: "Summarize a goal that already meets its criterion",
    criterion: "The first attempt keeps the goal in memory and passes the expected-output check.",
  },
  {
    id: "citation-check",
    title: "Reject completion without verification",
    criterion: "Planning instructions require verification before completion.",
  },
];

export const HOLDOUT_V1_CASES: EvaluationCase[] = [
  {
    id: "failure-noise",
    title: "Keep a precise task free of unrelated failure evidence",
    criterion: "The attempt passes only when failure evidence is not added to the working context.",
  },
];

const SETS: Record<string, EvaluationCase[]> = {
  "repair-v1": REPAIR_V1_CASES,
  "holdout-v1": HOLDOUT_V1_CASES,
};

export function evaluationCases(setId: string): EvaluationCase[] {
  const cases = SETS[setId];
  if (!cases) throw new Error("Unknown evaluation set. Use repair-v1 or holdout-v1.");
  return cases;
}
