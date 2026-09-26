import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { MAX_PLANNING_ATTEMPTS, PLANNING_LEASE_MS, type GoalRun, type Plan, type RunInput } from "./models.js";

export type PlanningResult = { plan: Plan } | { error: NonNullable<GoalRun["error"]> };
export interface RunStore {
  init(): Promise<void>;
  create(ownerId: string, input: RunInput, model: string): Promise<GoalRun>;
  list(ownerId: string): Promise<GoalRun[]>;
  get(ownerId: string, id: string): Promise<GoalRun | null>;
  claim(ownerId: string, id: string, now: Date): Promise<GoalRun | null>;
  finish(run: GoalRun, result: PlanningResult, now: Date): Promise<boolean>;
}
function newRun(ownerId: string, input: RunInput, model: string): GoalRun {
  return { ...structuredClone(input), id: randomUUID(), ownerId, model, status: "draft", planningAttempts: 0, createdAt: new Date(), updatedAt: new Date() };
}

export class MongoRunStore implements RunStore {
  constructor(private collection: Collection<GoalRun>) {}
  async init() {
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1, updatedAt: -1 });
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
      ownerId, id, planningAttempts: { $lt: MAX_PLANNING_ATTEMPTS },
      $or: [{ status: { $in: ["draft", "blocked"] } }, { status: "planning", planningExpiresAt: { $lte: now } }],
    }, {
      $set: { status: "planning", updatedAt: now, planningToken: randomUUID(), planningExpiresAt: new Date(now.getTime() + PLANNING_LEASE_MS) },
      $inc: { planningAttempts: 1 }, $unset: { error: "" },
    }, { returnDocument: "after", projection: { _id: 0 } });
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
    if (!run || run.ownerId !== ownerId || run.status === "planned" || run.planningAttempts >= MAX_PLANNING_ATTEMPTS
      || run.status === "planning" && (!run.planningExpiresAt || run.planningExpiresAt > now)) return null;
    Object.assign(run, { status: "planning", updatedAt: now, planningToken: randomUUID(), planningExpiresAt: new Date(now.getTime() + PLANNING_LEASE_MS), planningAttempts: run.planningAttempts + 1 });
    delete run.error;
    return structuredClone(run);
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
