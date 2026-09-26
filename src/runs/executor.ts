import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GitHubAppRuntime } from "../chat/app.js";
import type { AgentJobAuthorization } from "../agents/job-authorizations.js";
import { EXECUTION_LEASE_MS, publicRun, type GoalRun, type Plan, type RunExecution, type StepExecution } from "./models.js";
import type { RunStore } from "./store.js";
import { RunRequestError } from "./service.js";

const startInput = z.object({ repositoryId: z.number().int().positive() }).strict();
const checkedCommands = new Set(["npm run check", "npm test", "npm run build"]);
export function hasPassingChecks(job: AgentJobAuthorization) {
  return !!job.checks?.some(check => checkedCommands.has(check.command)) && job.checks.every(check => check.ok);
}

/** Supported plans are explicit linear repository changes followed by optional check inspection. */
export function executionProblem(plan: Plan): string | undefined {
  for (const [index, step] of plan.steps.entries()) {
    if (!step.execution || step.execution.kind === "unsupported") return `Step ${step.id} is not executable. Create a repository-change goal and generate a new plan; research, manual tasks, and legacy untyped plans are not supported yet.`;
    if (index === 0 && (step.dependsOn.length || step.execution.kind !== "repository_change")
      || index > 0 && (step.dependsOn.length !== 1 || step.dependsOn[0] !== plan.steps[index - 1]!.id)) {
      return "Execution currently supports one ordered chain: the first step changes a repository and each later step depends on the immediately preceding step.";
    }
    if (step.execution.kind === "repository_change" && step.execution.scaffold && index !== 0) return "Scaffolding is supported only in the first step. Later steps must modify the existing app.";
  }
}

export class GoalExecutor {
  constructor(readonly store: RunStore, private github?: GitHubAppRuntime, private clock = () => new Date()) {}
  availability() {
    const enabled = !!this.github?.jobStore && this.github.repositoryExecutor?.backend === "daytona";
    return { enabled, reason: enabled ? undefined : "Goal execution requires GitHub sign-in, an enabled repository, and Daytona execution configured on the server." };
  }
  private async repository(ownerId: string, repositoryId: number) {
    if (!this.availability().enabled) throw new RunRequestError(this.availability().reason!, 503);
    const [repositories, installations] = await Promise.all([
      this.github!.repositoryStore.listForUser(ownerId), this.github!.store.listForUser(ownerId),
    ]);
    const repository = repositories.find(item => item.repositoryId === repositoryId);
    if (!repository || !installations.some(item => item.installationId === repository.installationId)) throw new RunRequestError("Repository access is unavailable. Reconnect GitHub and sync repositories.", 403);
    for (const action of ["createBranch", "commit", "pushAgentBranch", "openPullRequest"] as const) {
      if (!await this.github!.repositoryStore.authorizeAgentRepositoryAction(ownerId, repositoryId, action)) throw new RunRequestError("Enable agent access and the required repository write policy before executing this plan.", 403);
    }
    return repository;
  }
  private async get(ownerId: string, id: string) {
    const run = await this.store.get(ownerId, id);
    if (!run) throw new RunRequestError("Run not found.", 404);
    return run;
  }
  async start(ownerId: string, id: string, value: unknown) {
    const run = await this.get(ownerId, id);
    const input = startInput.safeParse(value);
    if (!input.success) throw new RunRequestError("Select one authorized repository to execute the plan.", 400);
    if (run.execution) {
      if (run.execution.repositoryId !== input.data.repositoryId) throw new RunRequestError("This run already has a different repository target.", 409);
      return publicRun(run, this.clock());
    }
    if (run.status !== "planned" || !run.plan) throw new RunRequestError("Generate a valid plan before execution.", 409);
    const repository = await this.repository(ownerId, input.data.repositoryId);
    const now = this.clock();
    const execution: RunExecution = { repositoryId: repository.repositoryId, repositoryFullName: repository.fullName,
      startedAt: now, deadlineAt: new Date(+now + run.limits.maxDurationMinutes * 60_000),
      steps: run.plan.steps.map(step => ({ id: step.id, status: "pending", attempts: 0, evaluation: "pending" })),
    };
    if (!await this.store.startExecution(ownerId, id, execution)) throw new RunRequestError("Run changed. Refresh its execution state.", 409);
    return publicRun(await this.get(ownerId, id), now);
  }
  async resume(ownerId: string, id: string) {
    const run = await this.get(ownerId, id);
    if (!run.execution) throw new RunRequestError("This run has not started execution.", 409);
    if (run.status === "running") return publicRun(run, this.clock());
    if (!publicRun(run, this.clock()).canResume) throw new RunRequestError("This run cannot resume: its time or attempt limit is exhausted, or execution has finished.", 409);
    await this.repository(ownerId, run.execution.repositoryId);
    if (!await this.store.resumeExecution(ownerId, id, this.clock())) throw new RunRequestError("Run changed. Refresh before resuming.", 409);
    return publicRun(await this.get(ownerId, id), this.clock());
  }
  async recover() {
    for (const run of await this.store.pendingExecutions(this.clock())) {
      // One bad run must not prevent recovery of other owners' work.
      try { await this.tick(run.ownerId, run.id); }
      catch { console.warn("[goal-execution] Recovery deferred; check database connectivity."); }
    }
  }
  async tick(ownerId: string, id: string) {
    const run = await this.store.claimExecution(ownerId, id, this.clock());
    if (!run?.execution || !run.plan) return;
    const execution = structuredClone(run.execution);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.store.renewExecution(run, this.clock()).then(ok => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, EXECUTION_LEASE_MS / 3);
    heartbeat.unref();
    const save = (status: GoalRun["status"] = "running") => this.store.saveExecution(run, execution, status, this.clock());
    const block = async (code: string, message: string, step?: StepExecution) => {
      execution.error = { code, message };
      if (step) { step.status = "blocked"; step.error = execution.error; }
      await save("blocked");
    };
    let step: StepExecution | undefined;
    try {
      if (execution.deadlineAt <= this.clock()) {
        for (const item of execution.steps) if (item.jobId && item.status !== "succeeded") await this.github?.repositoryExecutor?.cancel(item.jobId, ownerId);
        await block("TIME_LIMIT", "The saved execution deadline has expired. Review the preserved work before creating a new run."); return;
      }
      const problem = executionProblem(run.plan);
      if (problem) { await block("UNSUPPORTED_PLAN", problem); return; }
      await this.repository(ownerId, execution.repositoryId);
      step = execution.steps.find(item => item.status !== "succeeded");
      if (!step) { await save("awaiting_evaluation"); return; }
      const definition = run.plan.steps.find(item => item.id === step!.id)!;
      if (!definition.dependsOn.every(dependency => execution.steps.some(item => item.id === dependency && item.status === "succeeded"))) {
        await block("DEPENDENCY_BLOCKED", "A required earlier step has not completed successfully.", step); return;
      }
      const previousJobId = execution.steps.slice(0, execution.steps.indexOf(step)).reverse().find(item => item.jobId)?.jobId;
      if (definition.execution!.kind === "inspect_checks") {
        const job = previousJobId ? await this.github!.jobStore!.get(previousJobId, ownerId) : null;
        if (!job || job.status !== "completed" || !hasPassingChecks(job)) {
          await block("CHECK_EVIDENCE_REQUIRED", "No completed repository job with passing check/test/build evidence is available.", step); return;
        }
        step.attempts ||= 1; step.status = "succeeded"; step.completedAt = this.clock();
        step.checkpoint = `job:${job.jobId}:checks`; step.output = { checks: job.checks!, commitSha: job.commitSha, pullRequestUrl: job.pullRequestUrl };
        await save(); return;
      }
      // Commit a stable intent before creating any repository job or external side effect.
      if (step.status === "pending" || step.status === "blocked") {
        if (step.attempts >= run.limits.maxAttemptsPerStep) { await block("ATTEMPT_LIMIT", "This step reached its attempt limit. Review its saved job and failure evidence.", step); return; }
        step.jobId ||= randomUUID(); step.attempts++; step.status = "running"; step.startedAt ||= this.clock();
        delete step.error; delete execution.error;
        await save(); return;
      }
      let job = await this.github!.jobStore!.get(step.jobId!, ownerId);
      if (!job) {
        if (leaseLost || !await this.store.renewExecution(run, this.clock())) return;
        const action = definition.execution!;
        job = await this.github!.repositoryExecutor!.createJob({
          jobId: step.jobId!, userId: ownerId, repositoryId: execution.repositoryId,
          instruction: definition.instruction, executionBackend: "daytona", model: run.model,
          deadlineAt: execution.deadlineAt, run: { id: run.id, stepId: step.id }, parentJobId: previousJobId,
          ...(action.kind === "repository_change" && action.scaffold ? { scaffold: action.scaffold } : {}),
        });
      }
      if (job.run?.id !== run.id || job.run.stepId !== step.id || job.repositoryId !== execution.repositoryId || job.model !== run.model) {
        await block("JOB_BINDING_MISMATCH", "The saved execution job does not match this run. Review its records before retrying.", step); return;
      }
      step.checkpoint = job.checkpoint || "job_created";
      step.output = { summary: job.summary, checks: job.checks || [], commitSha: job.commitSha, pullRequestUrl: job.pullRequestUrl };
      if (job.status === "completed") {
        if (!hasPassingChecks(job)) { await block("CHECK_EVIDENCE_REQUIRED", "Repository work was saved, but no passing check/test/build evidence establishes execution success. Review the PR and add objective checks.", step); return; }
        step.status = "succeeded"; step.completedAt = job.completedAt || this.clock();
      } else if (job.status === "cancelled") {
        await block("JOB_CANCELLED", "The linked repository job was cancelled. Its recorded progress is preserved.", step); return;
      } else if (job.status === "failed" && step.attempts <= (job.runAttempt || 1)) {
        await block(job.failure || "JOB_FAILED", `Repository execution failed (${job.failure || "JOB_FAILED"}). Inspect its saved checks and sandbox, correct configuration if needed, then resume within the original limits.`, step); return;
      } else if (!job.leaseUntil || job.leaseUntil <= this.clock()) {
        if (leaseLost || !await this.store.renewExecution(run, this.clock())) return;
        // Claim is synchronous in the executor before work starts; duplicate deliveries share the same job ID.
        void this.github!.repositoryExecutor!.execute(job, job.request || definition.instruction, step.attempts).catch(() => {});
      }
      await save();
    } catch (error) {
      if (!leaseLost) await block("EXECUTION_UNAVAILABLE", error instanceof RunRequestError ? error.message
        : "Execution could not continue. Check repository access, Daytona, and the recorded model. Saved checkpoints and job IDs are preserved; resume only after resolving the failure.", step);
    } finally { clearInterval(heartbeat); }
  }
}
