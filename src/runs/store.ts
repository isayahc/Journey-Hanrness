import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { MAX_PLANNING_ATTEMPTS, PLANNING_LEASE_MS, EXECUTION_LEASE_MS, type RunExecution, type GoalRun, type Plan, type RunInput } from "./models.js";

export type PlanningResult = { plan: Plan } | { error: NonNullable<GoalRun["error"]> };
export interface RunStore {
  init(): Promise<void>;
  create(ownerId: string, input: RunInput, model: string): Promise<GoalRun>;
  list(ownerId: string): Promise<GoalRun[]>;
  get(ownerId: string, id: string): Promise<GoalRun | null>;
  claim(ownerId: string, id: string, now: Date): Promise<GoalRun | null>;
  finish(run: GoalRun, result: PlanningResult, now: Date): Promise<boolean>;
  startExecution(ownerId: string, id: string, execution: RunExecution): Promise<boolean>;
  resumeExecution(ownerId: string, id: string, now: Date): Promise<boolean>;
  pendingExecutions(now: Date): Promise<GoalRun[]>;
  claimExecution(ownerId: string, id: string, now: Date): Promise<GoalRun | null>;
  renewExecution(run: GoalRun, now: Date): Promise<boolean>;
  saveExecution(run: GoalRun, execution: RunExecution, status: GoalRun["status"], now: Date): Promise<boolean>;

}
function newRun(ownerId: string, input: RunInput, model: string): GoalRun {
  return { ...structuredClone(input), id: randomUUID(), ownerId, model, status: "draft", planningAttempts: 0, createdAt: new Date(), updatedAt: new Date() };
}

export class MongoRunStore implements RunStore {
  constructor(private collection: Collection<GoalRun>) {}
  async init() {
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1, updatedAt: -1 });
    await this.collection.createIndex({ status: 1, executionLeaseUntil: 1 });
  }
  async create(ownerId: string, input: RunInput, model: string) {
    const run = newRun(ownerId, input, model);
    await this.collection.insertOne({ ...run });
    return run;
  }
  list(ownerId: string) {
    return this.collection.find({ ownerId }, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray();
  }
  get(ownerId: string, id: string) { return this.collection.findOne({ ownerId, id }, { projection: { _id: 0 } }); }
  claim(ownerId: string, id: string, now: Date) {
    return this.collection.findOneAndUpdate({
      ownerId, id, execution: { $exists: false }, planningAttempts: { $lt: MAX_PLANNING_ATTEMPTS },
      $or: [{ status: { $in: ["draft", "blocked"] } }, { status: "planning", planningExpiresAt: { $lte: now } }],
    }, {
      $set: { status: "planning", updatedAt: now, planningToken: randomUUID(), planningExpiresAt: new Date(now.getTime() + PLANNING_LEASE_MS) },
      $inc: { planningAttempts: 1 }, $unset: { error: "" },
    }, { returnDocument: "after", projection: { _id: 0 } });
  }
  async startExecution(ownerId: string, id: string, execution: RunExecution) {
    return (await this.collection.updateOne({ ownerId, id, status: "planned", execution: { $exists: false } }, {
      $set: { status: "running", execution, updatedAt: execution.startedAt },
    })).modifiedCount === 1;
  }
  async resumeExecution(ownerId: string, id: string, now: Date) {
    return (await this.collection.updateOne({ ownerId, id, status: "blocked", "execution.deadlineAt": { $gt: now } }, {
      $set: { status: "running", updatedAt: now }, $unset: { "execution.error": "", executionToken: "", executionLeaseUntil: "" },
    })).modifiedCount === 1;
  }
  pendingExecutions(now: Date) {
    return this.collection.find({ status: "running", execution: { $exists: true },
      $or: [{ executionLeaseUntil: { $exists: false } }, { executionLeaseUntil: { $lte: now } }],
    }, { projection: { _id: 0 } }).sort({ updatedAt: 1 }).limit(50).toArray();
  }
  claimExecution(ownerId: string, id: string, now: Date) {
    return this.collection.findOneAndUpdate({ ownerId, id, status: "running", execution: { $exists: true },
      $or: [{ executionLeaseUntil: { $exists: false } }, { executionLeaseUntil: { $lte: now } }],
    }, { $set: { executionToken: randomUUID(), executionLeaseUntil: new Date(now.getTime() + EXECUTION_LEASE_MS), updatedAt: now } },
    { returnDocument: "after", projection: { _id: 0 } });
  }
  async renewExecution(run: GoalRun, now: Date) {
    return (await this.collection.updateOne({ ownerId: run.ownerId, id: run.id, status: "running", executionToken: run.executionToken,
      executionLeaseUntil: { $gt: now } }, { $set: { executionLeaseUntil: new Date(now.getTime() + EXECUTION_LEASE_MS) } })).matchedCount === 1;
  }
  async saveExecution(run: GoalRun, execution: RunExecution, status: GoalRun["status"], now: Date) {
    return (await this.collection.updateOne({ ownerId: run.ownerId, id: run.id, status: "running", executionToken: run.executionToken,
      executionLeaseUntil: { $gt: now } }, { $set: { execution, status, updatedAt: now },
        $unset: { executionToken: "", executionLeaseUntil: "" } })).matchedCount === 1;
  }

  async finish(run: GoalRun, result: PlanningResult, now: Date) {
    const update = await this.collection.updateOne({
      ownerId: run.ownerId, id: run.id, status: "planning", planningToken: run.planningToken,
      planningExpiresAt: { $gt: now },
    }, {
      $set: { ...result, status: "plan" in result ? "planned" : "blocked", updatedAt: now },
      $unset: { planningToken: "", planningExpiresAt: "" },
    });
    return update.modifiedCount === 1;
  }
}

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, GoalRun>();
  async init() {}
  async create(ownerId: string, input: RunInput, model: string) {
    const run = newRun(ownerId, input, model);
    this.runs.set(run.id, run);
    return structuredClone(run);
  }
  async list(ownerId: string) {
    return structuredClone([...this.runs.values()].filter(run => run.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 50));
  }
  async get(ownerId: string, id: string) {
    const run = this.runs.get(id);
    return run?.ownerId === ownerId ? structuredClone(run) : null;
  }
  async claim(ownerId: string, id: string, now: Date) {
    const run = this.runs.get(id);
    if (!run || run.ownerId !== ownerId || run.execution || run.status === "planned" || run.planningAttempts >= MAX_PLANNING_ATTEMPTS
      || run.status === "planning" && (!run.planningExpiresAt || run.planningExpiresAt > now)) return null;
    Object.assign(run, { status: "planning", updatedAt: now, planningToken: randomUUID(), planningExpiresAt: new Date(now.getTime() + PLANNING_LEASE_MS), planningAttempts: run.planningAttempts + 1 });
    delete run.error;
    return structuredClone(run);
  }
  async startExecution(ownerId: string, id: string, execution: RunExecution) {
    const run = this.runs.get(id);
    if (!run || run.ownerId !== ownerId || run.status !== "planned" || run.execution) return false;
    Object.assign(run, { status: "running", execution: structuredClone(execution), updatedAt: execution.startedAt });
    return true;
  }
  async resumeExecution(ownerId: string, id: string, now: Date) {
    const run = this.runs.get(id);
    if (!run || run.ownerId !== ownerId || run.status !== "blocked" || !run.execution || run.execution.deadlineAt <= now) return false;
    run.status = "running"; run.updatedAt = now;
    delete run.execution.error; delete run.executionToken; delete run.executionLeaseUntil;
    return true;
  }
  async pendingExecutions(now: Date) {
    return structuredClone([...this.runs.values()].filter(run => run.status === "running" && run.execution
      && (!run.executionLeaseUntil || run.executionLeaseUntil <= now)).sort((a, b) => +a.updatedAt - +b.updatedAt).slice(0, 50));
  }
  async claimExecution(ownerId: string, id: string, now: Date) {
    const run = this.runs.get(id);
    if (!run || run.ownerId !== ownerId || run.status !== "running" || !run.execution || run.executionLeaseUntil && run.executionLeaseUntil > now) return null;
    run.executionToken = randomUUID(); run.executionLeaseUntil = new Date(+now + EXECUTION_LEASE_MS); run.updatedAt = now;
    return structuredClone(run);
  }
  private owns(claim: GoalRun, now: Date) {
    const run = this.runs.get(claim.id);
    return run?.ownerId === claim.ownerId && run.status === "running" && run.executionToken === claim.executionToken
      && run.executionLeaseUntil && run.executionLeaseUntil > now ? run : null;
  }
  async renewExecution(claim: GoalRun, now: Date) {
    const run = this.owns(claim, now); if (!run) return false;
    run.executionLeaseUntil = new Date(+now + EXECUTION_LEASE_MS); return true;
  }
  async saveExecution(claim: GoalRun, execution: RunExecution, status: GoalRun["status"], now: Date) {
    const run = this.owns(claim, now); if (!run) return false;
    Object.assign(run, { execution: structuredClone(execution), status, updatedAt: now });
    delete run.executionToken; delete run.executionLeaseUntil;
    return true;
  }

  async finish(claim: GoalRun, result: PlanningResult, now: Date) {
    const run = this.runs.get(claim.id);
    if (!run || run.ownerId !== claim.ownerId || run.status !== "planning" || run.planningToken !== claim.planningToken
      || !run.planningExpiresAt || run.planningExpiresAt <= now) return false;
    Object.assign(run, structuredClone(result), { status: "plan" in result ? "planned" : "blocked", updatedAt: now });
    delete run.planningToken;
    delete run.planningExpiresAt;
    return true;
  }
}
