import { randomUUID } from "node:crypto";

export type StrategyStatus = "candidate" | "active" | "rejected" | "retired";

export interface HarnessStrategyConfig {
  planningInstructions: string;
  memoryPolicy: "relevant_evidence" | "recent_evidence";
}

export interface HarnessStrategyVersion {
  id: string;
  version: number;
  parentId?: string;
  status: StrategyStatus;
  config: HarnessStrategyConfig;
  rationale: string;
  proposalEvidence: string[];
  createdAt: Date;
  decidedAt?: Date;
}

export interface EvaluationLimits {
  maxAttemptsPerCase: number;
  maxDurationMinutes: number;
  maxUsageUnits: number;
  tools: string[];
  repositoryAccess: string[];
}

export interface StrategyCaseResult {
  caseId: string;
  succeeded: boolean;
  attempts: number;
  durationMs: number;
  usageUnits: number;
  evidenceRefs: string[];
}

export interface StrategyEvaluation {
  id: string;
  evaluationSetVersion: string;
  baselineStrategyId: string;
  candidateStrategyId: string;
  model: string;
  limits: EvaluationLimits;
  baselineResults: StrategyCaseResult[];
  candidateResults: StrategyCaseResult[];
  decision: "promoted" | "rejected";
  reason: string;
  createdAt: Date;
}

export interface PromotionDecision {
  promotable: boolean;
  reason: string;
}

export function newStrategy(input: {
  version: number;
  parentId?: string;
  status: StrategyStatus;
  config: HarnessStrategyConfig;
  rationale: string;
  proposalEvidence?: string[];
}): HarnessStrategyVersion {
  return {
    id: randomUUID(),
    version: input.version,
    parentId: input.parentId,
    status: input.status,
    config: structuredClone(input.config),
    rationale: input.rationale,
    proposalEvidence: [...(input.proposalEvidence || [])],
    createdAt: new Date(),
  };
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every(value => b.includes(value));
}

export function evaluatePromotion(
  baseline: StrategyCaseResult[],
  candidate: StrategyCaseResult[],
  baselineLimits: EvaluationLimits,
  candidateLimits: EvaluationLimits,
): PromotionDecision {
  if (!baseline.length || baseline.length !== candidate.length) {
    return { promotable: false, reason: "Baseline and candidate must have complete results for the same evaluation cases." };
  }
  const candidateById = new Map(candidate.map(result => [result.caseId, result]));
  if (candidateById.size !== candidate.length || new Set(baseline.map(result => result.caseId)).size !== baseline.length) {
    return { promotable: false, reason: "Evaluation case IDs must be unique." };
  }
  if (!sameSet(baselineLimits.tools, candidateLimits.tools)
    || !sameSet(baselineLimits.repositoryAccess, candidateLimits.repositoryAccess)
    || candidateLimits.maxAttemptsPerCase > baselineLimits.maxAttemptsPerCase
    || candidateLimits.maxDurationMinutes > baselineLimits.maxDurationMinutes
    || candidateLimits.maxUsageUnits > baselineLimits.maxUsageUnits) {
    return { promotable: false, reason: "Candidate evaluation cannot expand tools, repository access, or execution limits." };
  }

  let improved = false;
  for (const base of baseline) {
    const next = candidateById.get(base.caseId);
    if (!next) return { promotable: false, reason: "Baseline and candidate must use the same evaluation cases." };
    if (base.succeeded && !next.succeeded) {
      return { promotable: false, reason: `Candidate regressed on evaluation case ${base.caseId}.` };
    }
    if (!base.succeeded && next.succeeded) improved = true;
    if (base.succeeded && next.succeeded
      && (next.attempts < base.attempts || next.usageUnits < base.usageUnits || next.durationMs < base.durationMs)) improved = true;
  }
  return improved
    ? { promotable: true, reason: "Candidate preserves baseline successes and demonstrates a measured improvement." }
    : { promotable: false, reason: "Candidate did not demonstrate a measured improvement." };
}
