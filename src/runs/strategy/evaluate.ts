import type { EvaluationCase } from "./cases.js";
import { ATTEMPT_MS, type StrategyConfig, type StrategyLimits } from "./models.js";

export interface CaseMeasurement {
  success: boolean;
  attempts: number;
  durationMs: number;
  usage: { modelCalls: number; toolCalls: number };
  passedChecks: number;
  totalChecks: number;
  observation: string;
}

function measure(success: boolean, attempts: number, observation: string): CaseMeasurement {
  return {
    success,
    attempts,
    durationMs: attempts * ATTEMPT_MS,
    usage: { modelCalls: attempts, toolCalls: 0 },
    passedChecks: success ? 1 : 0,
    totalChecks: 1,
    observation,
  };
}

/**
 * Deterministic executor `deterministic-v1`.
 * Duration is 100ms per attempt so the same strategy, case, and limits always
 * reproduce the same measurements. The executor does not call a model, grant
 * tools, or raise the supplied attempt budget.
 */
export function evaluateCase(config: StrategyConfig, evalCase: EvaluationCase, limits: StrategyLimits): CaseMeasurement {
  const attempts = limits.maxAttemptsPerStep;
  if (evalCase.id === "schema-repair") {
    const canRepair = config.memorySelection.includeFailureEvidence && /failure evidence/i.test(config.planningInstructions);
    if (canRepair && attempts >= 2) {
      return measure(true, 2, "Attempt 1 failed schema validation. Attempt 2 matched the expected record after applying recorded failure evidence.");
    }
    return measure(false, attempts, "Attempt 1 failed schema validation. Later attempts repeated the invalid record because recorded failure evidence was not selected.");
  }
  if (evalCase.id === "stable-summary") {
    if (config.memorySelection.includeGoal && config.memorySelection.maxEvidenceItems >= 1) {
      return measure(true, 1, "Goal retained in the selected memory; expected summary check passed.");
    }
    return measure(false, attempts, "Goal was absent from the selected memory; expected summary check failed.");
  }
  if (evalCase.id === "citation-check") {
    if (/verify/i.test(config.planningInstructions)) {
      return measure(true, 1, "Planning instructions require verification; citation check passed.");
    }
    return measure(false, attempts, "Planning instructions do not require verification; citation check failed.");
  }
  if (evalCase.id === "failure-noise") {
    if (!config.memorySelection.includeFailureEvidence) {
      return measure(true, 1, "Failure evidence stayed out of context; precise-task check passed.");
    }
    return measure(false, attempts, "Failure evidence was added to context; precise-task check failed.");
  }
  throw new Error(`Unknown evaluation case ${evalCase.id}.`);
}
