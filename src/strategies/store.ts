import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import type { HarnessStrategyVersion, StrategyEvaluation } from "./models.js";

export interface StrategyStore {
  init(): Promise<void>;
  list(): Promise<HarnessStrategyVersion[]>;
  get(id: string): Promise<HarnessStrategyVersion | null>;
  active(): Promise<HarnessStrategyVersion | null>;
  insert(strategy: HarnessStrategyVersion): Promise<void>;
  recordEvaluation(evaluation: StrategyEvaluation): Promise<void>;
  evaluations(): Promise<StrategyEvaluation[]>;
  transition(id: string, from: HarnessStrategyVersion["status"], to: HarnessStrategyVersion["status"], at: Date): Promise<boolean>;
}

export class MongoStrategyStore implements StrategyStore {
  constructor(
    private strategies: Collection<HarnessStrategyVersion>,
    private evaluationRecords: Collection<StrategyEvaluation>,
  ) {}
  async init() {
    await Promise.all([
      this.strategies.createIndex({ id: 1 }, { unique: true }),
      this.strategies.createIndex({ version: 1 }, { unique: true }),
      this.strategies.createIndex({ status: 1 }),
      this.evaluationRecords.createIndex({ id: 1 }, { unique: true }),
      this.evaluationRecords.createIndex({ candidateStrategyId: 1, createdAt: -1 }),
    ]);
  }
  list() { return this.strategies.find({}, { projection: { _id: 0 } }).sort({ version: 1 }).toArray(); }
  get(id: string) { return this.strategies.findOne({ id }, { projection: { _id: 0 } }); }
  active() { return this.strategies.findOne({ status: "active" }, { projection: { _id: 0 } }); }
  async insert(strategy: HarnessStrategyVersion) {
    await this.strategies.insertOne(structuredClone(strategy));
  }
  async recordEvaluation(evaluation: StrategyEvaluation) {
    await this.evaluationRecords.insertOne(structuredClone(evaluation));
  }
  evaluations() {
    return this.evaluationRecords.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  }
  async transition(id: string, from: HarnessStrategyVersion["status"], to: HarnessStrategyVersion["status"], at: Date) {
    return (await this.strategies.updateOne({ id, status: from }, { $set: { status: to, decidedAt: at } })).modifiedCount === 1;
  }
}

export class MemoryStrategyStore implements StrategyStore {
  private strategies = new Map<string, HarnessStrategyVersion>();
  private records: StrategyEvaluation[] = [];
  async init() {}
  async list() { return structuredClone([...this.strategies.values()].sort((a, b) => a.version - b.version)); }
  async get(id: string) { return structuredClone(this.strategies.get(id) || null); }
  async active() { return structuredClone([...this.strategies.values()].find(strategy => strategy.status === "active") || null); }
  async insert(strategy: HarnessStrategyVersion) {
    if (this.strategies.has(strategy.id) || [...this.strategies.values()].some(existing => existing.version === strategy.version)) throw new Error("STRATEGY_VERSION_EXISTS");
    this.strategies.set(strategy.id, structuredClone(strategy));
  }
  async recordEvaluation(evaluation: StrategyEvaluation) {
    if (this.records.some(record => record.id === evaluation.id)) throw new Error("STRATEGY_EVALUATION_EXISTS");
    this.records.push(structuredClone(evaluation));
  }
  async evaluations() { return structuredClone(this.records); }
  async transition(id: string, from: HarnessStrategyVersion["status"], to: HarnessStrategyVersion["status"], at: Date) {
    const strategy = this.strategies.get(id);
    if (!strategy || strategy.status !== from) return false;
    strategy.status = to; strategy.decidedAt = new Date(at);
    return true;
  }
}

export function evaluationId() { return randomUUID(); }
