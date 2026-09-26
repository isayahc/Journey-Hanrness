import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACCESS_RANK = { none: 0, read: 1, job: 2 } as const;
export const executionApproachSchema = z.enum(["dependency-ready", "sequential"]);
export const repositoryAccessSchema = z.enum(["none", "read", "job"]);
export const strategyLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(20),
  maxAttemptsPerStep: z.number().int().min(1).max(5),
  maxDurationMinutes: z.number().int().min(1).max(240),
  maxContextItems: z.number().int().min(1).max(10),
}).strict();
export const memorySelectionSchema = z.object({
  maxEvidenceItems: z.number().int().min(1).max(10),
  includeGoal: z.boolean(),
  includeFailureEvidence: z.boolean(),
  includeDecisions: z.boolean(),
  preferRecent: z.boolean(),
}).strict();
export const strategyPermissionsSchema = z.object({
  tools: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).max(10),
  repositoryAccess: repositoryAccessSchema,
}).strict();
export const strategyConfigSchema = z.object({
  planningInstructions: z.string().trim().min(1).max(2000),
  memorySelection: memorySelectionSchema,
  executionApproach: executionApproachSchema,
  permissions: strategyPermissionsSchema,
  limits: strategyLimitsSchema,
}).strict();
export type StrategyConfig = z.infer<typeof strategyConfigSchema>;
export type StrategyLimits = z.infer<typeof strategyLimitsSchema>;
export type MemorySelection = z.infer<typeof memorySelectionSchema>;

export const PROPOSER_IDS = ["baseline", "failure-evidence-v1", "explicit"] as const;
export type StrategyProposer = (typeof PROPOSER_IDS)[number];
export const STRATEGY_STATUSES = ["active", "candidate", "rejected", "superseded", "rolled_back"] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export interface HarnessStrategy {
  id: string;
  ownerId: string;
  version: number;
  parentId: string | null;
  parentVersion: number | null;
  status: StrategyStatus;
  config: StrategyConfig;
  rationale: string;
  evidenceIds: string[];
  proposer: StrategyProposer;
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

export const FAILURE_EVIDENCE_INSTRUCTION = "On a failed check, revise the next attempt using the recorded failure evidence.";

/** Ceiling for later adaptations. Failure evidence is off until a measured candidate enables it. */
export function baselineConfig(): StrategyConfig {
  return {
    planningInstructions: "Plan ordered steps that cover every success criterion. Verify each criterion with objective evidence before claiming completion.",
    memorySelection: {
      maxEvidenceItems: 5,
      includeGoal: true,
      includeFailureEvidence: false,
      includeDecisions: true,
      preferRecent: true,
    },
    executionApproach: "dependency-ready",
    permissions: { tools: [], repositoryAccess: "none" },
    limits: { maxSteps: 8, maxAttemptsPerStep: 3, maxDurationMinutes: 30, maxContextItems: 5 },
  };
}

export function baselineStrategy(ownerId: string, model: string, now = new Date()): HarnessStrategy {
  return {
    id: randomUUID(),
    ownerId,
    version: 1,
    parentId: null,
    parentVersion: null,
    status: "active",
    config: baselineConfig(),
    rationale: "Initial harness strategy. Planning verifies each success criterion, memory keeps the goal and decisions but does not select failure evidence, and execution follows dependency order. Tools, repository access, and execution limits are the ceiling for later adaptations.",
    evidenceIds: [],
    proposer: "baseline",
    model,
    createdAt: now,
    updatedAt: now,
  };
}

export const proposalInput = z.object({
  rationale: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().uuid()).min(1).max(20),
  planningInstructions: z.string().trim().min(1).max(2000).optional(),
  memorySelection: memorySelectionSchema.partial().optional(),
  executionApproach: executionApproachSchema.optional(),
}).strict();
export type ProposalInput = z.infer<typeof proposalInput>;

export const EXPANSION_FIELDS = ["permissions", "limits", "tools", "repositoryAccess", "maxSteps", "maxAttemptsPerStep", "maxDurationMinutes", "maxContextItems"] as const;

export function expansionViolations(parent: StrategyConfig, candidate: StrategyConfig): string[] {
  const violations: string[] = [];
  if (candidate.permissions.tools.some(tool => !parent.permissions.tools.includes(tool))) violations.push("tools");
  if (ACCESS_RANK[candidate.permissions.repositoryAccess] > ACCESS_RANK[parent.permissions.repositoryAccess]) violations.push("repositoryAccess");
  for (const key of ["maxSteps", "maxAttemptsPerStep", "maxDurationMinutes", "maxContextItems"] as const) {
    if (candidate.limits[key] > parent.limits[key]) violations.push(key);
  }
  if (candidate.memorySelection.maxEvidenceItems > parent.memorySelection.maxEvidenceItems) violations.push("maxEvidenceItems");
  if (candidate.memorySelection.maxEvidenceItems > candidate.limits.maxContextItems) violations.push("maxContextItems");
  return violations;
}

export function applyProposal(parent: StrategyConfig, proposal: ProposalInput): StrategyConfig {
  return {
    planningInstructions: proposal.planningInstructions ?? parent.planningInstructions,
    memorySelection: { ...parent.memorySelection, ...proposal.memorySelection },
    executionApproach: proposal.executionApproach ?? parent.executionApproach,
    permissions: structuredClone(parent.permissions),
    limits: structuredClone(parent.limits),
  };
}

export const outcomeInput = z.object({
  strategyId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  caseId: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/).optional(),
  success: z.boolean(),
  attempts: z.number().int().min(1).max(20),
  durationMs: z.number().int().min(0).max(86_400_000),
  usage: z.object({
    modelCalls: z.number().int().min(0).max(100),
    toolCalls: z.number().int().min(0).max(100),
  }).strict(),
  feedback: z.string().trim().min(1).max(2000),
}).strict();
export type OutcomeInput = z.infer<typeof outcomeInput>;

export interface RecordedOutcome {
  id: string;
  ownerId: string;
  strategyId: string;
  strategyVersion: number;
  runId: string | null;
  caseId: string | null;
  success: boolean;
  attempts: number;
  durationMs: number;
  usage: { modelCalls: number; toolCalls: number };
  feedback: string;
  createdAt: Date;
}

export const EVALUATION_SET_REPAIR = "repair-v1";
export const EVALUATION_SET_HOLDOUT = "holdout-v1";
export const EVALUATION_EXECUTOR = "deterministic-v1";
export const PROMOTION_CRITERIA_ID = "strict-improvement-v1";
export const ATTEMPT_MS = 100;
export const PROMOTION_CRITERIA = {
  id: PROMOTION_CRITERIA_ID,
  noCaseRegression: true,
  improvement: "Pass more cases than the baseline, or pass the same cases in fewer attempts, or use the same attempts in less measured time.",
  sharedLimits: "Both sides use the parent strategy execution limits and the same model.",
  attemptMs: ATTEMPT_MS,
} as const;

export interface EvaluationRecord {
  id: string;
  ownerId: string;
  comparisonId: string;
  strategyId: string;
  strategyVersion: number;
  caseId: string;
  model: string;
  limits: StrategyLimits;
  evaluationSetId: string;
  executor: typeof EVALUATION_EXECUTOR;
  criteriaId: typeof PROMOTION_CRITERIA_ID;
  success: boolean;
  attempts: number;
  durationMs: number;
  usage: { modelCalls: number; toolCalls: number };
  passedChecks: number;
  totalChecks: number;
  observation: string;
  createdAt: Date;
}

export interface SideSummary {
  successes: number;
  cases: number;
  attempts: number;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
}
export interface CaseComparison {
  caseId: string;
  baseline: { success: boolean; attempts: number; durationMs: number; modelCalls: number; toolCalls: number };
  candidate: { success: boolean; attempts: number; durationMs: number; modelCalls: number; toolCalls: number };
}
export interface ComparisonVerdict {
  reason: "IMPROVEMENT" | "REGRESSION" | "NO_IMPROVEMENT";
  regressions: string[];
  improvements: string[];
  baseline: SideSummary;
  candidate: SideSummary;
  cases: CaseComparison[];
}

export interface StrategyComparison {
  id: string;
  ownerId: string;
  baselineStrategyId: string;
  baselineVersion: number;
  candidateStrategyId: string;
  candidateVersion: number;
  model: string;
  limits: StrategyLimits;
  evaluationSetId: string;
  executor: typeof EVALUATION_EXECUTOR;
  criteriaId: typeof PROMOTION_CRITERIA_ID;
  recordIds: string[];
  summary: ComparisonVerdict;
  createdAt: Date;
}

export const DECISION_REASONS = [
  "IMPROVEMENT", "REGRESSION", "NO_IMPROVEMENT", "MISSING_EVIDENCE", "LIMIT_EXPANSION", "INCOMPLETE_COMPARISON", "POST_PROMOTION_REGRESSION",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export interface StrategyDecision {
  id: string;
  ownerId: string;
  action: "promoted" | "rejected" | "rolled_back";
  reason: DecisionReason;
  strategyId: string | null;
  strategyVersion: number | null;
  parentStrategyId: string | null;
  parentVersion: number | null;
  comparisonId: string | null;
  rationale: string;
  evidenceIds: string[];
  metrics: ComparisonVerdict | null;
  createdAt: Date;
}

export interface StrategyMigration {
  id: string;
  ownerId: string;
  runId: string;
  fromStrategyId: string | null;
  fromVersion: number | null;
  toStrategyId: string;
  toVersion: number;
  reason: string;
  createdAt: Date;
}

export const migrationInput = z.object({
  strategyId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export function publicStrategy(strategy: HarnessStrategy) {
  const { ownerId: _owner, ...data } = strategy;
  return data;
}
export function publicOutcome(outcome: RecordedOutcome) {
  const { ownerId: _owner, ...data } = outcome;
  return data;
}
export function publicComparison(comparison: StrategyComparison) {
  const { ownerId: _owner, ...data } = comparison;
  return data;
}
export function publicRecord(record: EvaluationRecord) {
  const { ownerId: _owner, ...data } = record;
  return data;
}
export function publicDecision(decision: StrategyDecision) {
  const { ownerId: _owner, ...data } = decision;
  return data;
}
export function publicMigration(migration: StrategyMigration) {
  const { ownerId: _owner, ...data } = migration;
  return data;
}
