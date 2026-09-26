import { resolveOpenCodeModel } from "../opencode-model.js";
import { InvalidPlanError, MAX_PLANNING_ATTEMPTS, publicRun, runInput, validatePlan } from "./models.js";
import type { RunPlanner } from "./planner.js";
import type { PlanningResult, RunStore } from "./store.js";
import { SearchError } from "../search/tavily.js";

export class RunRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export class RunService {
  private model: string;
  constructor(readonly store: RunStore, private planner: RunPlanner, env: NodeJS.ProcessEnv = process.env) {
    this.model = resolveOpenCodeModel(env).name;
  }
  async create(ownerId: string, value: unknown) {
    const parsed = runInput.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new RunRequestError(`Invalid ${issue.path.join(".") || "run"}. Provide a goal (1–4,000 characters), 1–10 success criteria (up to 500 characters each), and limits: 1–20 steps, 1–5 attempts per step, 1–240 minutes.`, 400);
    }
    return publicRun(await this.store.create(ownerId, parsed.data, this.model));
  }
  async list(ownerId: string) { return (await this.store.list(ownerId)).map(run => publicRun(run)); }
  async get(ownerId: string, id: string) {
    const run = await this.store.get(ownerId, id);
    if (!run) throw new RunRequestError("Run not found.", 404);
    return publicRun(run);
  }
  async plan(ownerId: string, id: string) {
    const existing = await this.get(ownerId, id);
    if (existing.status === "planned") return existing;
    const run = await this.store.claim(ownerId, id, new Date());
    if (!run) {
      const current = await this.get(ownerId, id);
      throw new RunRequestError(current.planningAttempts >= MAX_PLANNING_ATTEMPTS
        ? "Planning attempt limit reached. Create a new run with a revised goal or criteria."
        : "Planning is already in progress. Refresh the run; interrupted planning can be retried after two minutes.", 409);
    }
    let result: PlanningResult;
    try {
      result = { plan: validatePlan(await this.planner.plan(run), run.limits.maxSteps) };
    } catch (error) {
      result = { error: error instanceof InvalidPlanError
        ? { code: "INVALID_PLAN", message: error.message }
        : { code: "PLANNER_UNAVAILABLE", message: error instanceof SearchError ? error.message : "Planning failed or timed out. Your goal is saved. Check the OpenCode server and access to the run's recorded model, then retry." } };
    }
    if (!await this.store.finish(run, result, new Date())) {
      throw new RunRequestError("This planning attempt expired or was replaced. Refresh the run before retrying.", 409);
    }
    return this.get(ownerId, id);
  }
}
