import { z } from "zod";
import { scaffoldInput } from "../chat/execution.js";

export const runInput = z.object({
  goal: z.string().trim().min(1).max(4000),
  successCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  limits: z.object({
    maxSteps: z.number().int().min(1).max(20).default(8),
    maxAttemptsPerStep: z.number().int().min(1).max(5).default(3),
    maxDurationMinutes: z.number().int().min(1).max(240).default(30),
  }).strict().default({}),
}).strict();
export type RunInput = z.infer<typeof runInput>;

const stepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  title: z.string().trim().min(1).max(160),
  instruction: z.string().trim().min(1).max(2000),
  dependsOn: z.array(z.string()).max(20),
  verification: z.string().trim().min(1).max(1000),
  execution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("repository_change"), scaffold: scaffoldInput.optional() }).strict(),
    z.object({ kind: z.literal("inspect_checks") }).strict(),
    z.object({ kind: z.literal("unsupported"), reason: z.string().trim().min(1).max(500) }).strict(),
  ]).optional(),
}).strict();
const planSchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  steps: z.array(stepSchema).min(1).max(20),
}).strict();
export type Plan = z.infer<typeof planSchema>;

export class InvalidPlanError extends Error {}
export function validatePlan(value: unknown, maxSteps: number): Plan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    // Avoid echoing model output or unknown field names in errors.
    throw new InvalidPlanError(`The plan has a missing or invalid ${issue.path.slice(0, 3).join(".") || "structure"}. Retry planning with clear, measurable success criteria.`);
  }
  const plan = parsed.data;
  if (plan.steps.length > maxSteps) throw new InvalidPlanError(`The plan exceeds the ${maxSteps}-step limit. Retry with a narrower goal or create a run with a larger step limit.`);
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id)) throw new InvalidPlanError("The plan repeats a step ID. Retry planning to generate unique steps.");
    if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !seen.has(id))) {
      throw new InvalidPlanError("Plan dependencies must reference distinct earlier steps. Retry planning to correct missing, circular, or out-of-order dependencies.");
    }
    seen.add(step.id);
  }
  return plan;
}

export const MAX_PLANNING_ATTEMPTS = 3;
export const PLANNING_LEASE_MS = 120_000;
export interface GoalRun extends RunInput {
  id: string;
  ownerId: string;
  model: string;
  status: "draft" | "planning" | "planned" | "blocked" | "running" | "awaiting_evaluation";
  execution?: RunExecution;
  executionToken?: string;
  executionLeaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
  planningAttempts: number;
  planningToken?: string;
  planningExpiresAt?: Date;
  plan?: Plan;
  error?: { code: "INVALID_PLAN" | "PLANNER_UNAVAILABLE"; message: string };
}

export function publicRun(run: GoalRun, now = new Date()) {
  const { ownerId: _owner, planningToken: _token, executionToken: _executionToken, ...data } = run;
  return {
    ...data,
    canStart: run.status === "planned" && !run.execution,
    canResume: run.status === "blocked" && !!run.execution && run.execution.deadlineAt > now
      && !["UNSUPPORTED_PLAN", "JOB_CANCELLED", "JOB_BINDING_MISMATCH", "CHECK_EVIDENCE_REQUIRED"].includes(run.execution.error?.code || "")
      && (run.execution.steps.find(step => step.status !== "succeeded")?.attempts ?? Infinity) < run.limits.maxAttemptsPerStep,
    canPlan: !run.execution && run.status !== "planned" && run.planningAttempts < MAX_PLANNING_ATTEMPTS
      && (run.status !== "planning" || !!run.planningExpiresAt && run.planningExpiresAt <= now),
    maxPlanningAttempts: MAX_PLANNING_ATTEMPTS,
  };
}

/** Execution success records completed work, never verification of natural-language criteria. */
export interface StepExecution {
  id: string;
  status: "pending" | "running" | "succeeded" | "blocked";
  attempts: number;
  jobId?: string;
  checkpoint?: string;
  output?: { summary?: string; commitSha?: string; pullRequestUrl?: string; checks: Array<{ command: string; ok: boolean }> };
  error?: { code: string; message: string };
  startedAt?: Date;
  completedAt?: Date;
  evaluation: "pending";
}
export interface RunExecution {
  repositoryId: number;
  repositoryFullName: string;
  startedAt: Date;
  deadlineAt: Date;
  steps: StepExecution[];
  error?: { code: string; message: string };
}
export const EXECUTION_LEASE_MS = 30_000;
