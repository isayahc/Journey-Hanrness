import type { Collection, Db } from "mongodb";
import type {
  EvaluationRecord, HarnessStrategy, RecordedOutcome, StrategyComparison, StrategyDecision, StrategyMigration, StrategyStatus,
} from "./models.js";

export interface StrategyHead { ownerId: string; activeStrategyId: string; updatedAt: Date }
export interface StrategyStore {
  init(): Promise<void>;
  getActive(ownerId: string): Promise<HarnessStrategy | null>;
  ensureBaseline(strategy: HarnessStrategy): Promise<HarnessStrategy>;
  get(ownerId: string, id: string): Promise<HarnessStrategy | null>;
  list(ownerId: string): Promise<HarnessStrategy[]>;
  nextVersion(ownerId: string): Promise<number>;
  insert(strategy: HarnessStrategy): Promise<void>;
  promote(ownerId: string, parentId: string, candidateId: string, now: Date): Promise<boolean>;
  rollback(ownerId: string, activeId: string, parentId: string, now: Date): Promise<boolean>;
  setStatus(ownerId: string, id: string, from: StrategyStatus, to: StrategyStatus, now: Date): Promise<boolean>;
  saveOutcome(outcome: RecordedOutcome): Promise<void>;
  listOutcomes(ownerId: string, strategyId: string): Promise<RecordedOutcome[]>;
  outcomesByIds(ownerId: string, ids: string[]): Promise<RecordedOutcome[]>;
  saveComparison(comparison: StrategyComparison, records: EvaluationRecord[]): Promise<void>;
  latestComparison(ownerId: string, candidateId: string, baselineId: string, evaluationSetId: string): Promise<StrategyComparison | null>;
  getComparison(ownerId: string, id: string): Promise<StrategyComparison | null>;
  listRecords(ownerId: string, comparisonId: string): Promise<EvaluationRecord[]>;
  saveDecision(decision: StrategyDecision): Promise<void>;
  listDecisions(ownerId: string): Promise<StrategyDecision[]>;
  saveMigration(migration: StrategyMigration): Promise<void>;
  listMigrations(ownerId: string, runId: string): Promise<StrategyMigration[]>;
}

function duplicate(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStrategyStore implements StrategyStore {
  private strategies = new Map<string, HarnessStrategy>();
  private heads = new Map<string, StrategyHead>();
  private outcomes: RecordedOutcome[] = [];
  private comparisons = new Map<string, StrategyComparison>();
  private records: EvaluationRecord[] = [];
  private decisions: StrategyDecision[] = [];
  private migrations: StrategyMigration[] = [];
  async init() {}
  private owned(ownerId: string, id: string) {
    const strategy = this.strategies.get(id);
    return strategy?.ownerId === ownerId ? strategy : undefined;
  }
  async getActive(ownerId: string) {
    const head = this.heads.get(ownerId);
    const strategy = head ? this.owned(ownerId, head.activeStrategyId) : undefined;
    return strategy ? clone(strategy) : null;
  }
  async ensureBaseline(strategy: HarnessStrategy) {
    const current = await this.getActive(strategy.ownerId);
    if (current) return current;
    this.strategies.set(strategy.id, clone(strategy));
    this.heads.set(strategy.ownerId, { ownerId: strategy.ownerId, activeStrategyId: strategy.id, updatedAt: strategy.updatedAt });
    return clone(strategy);
  }
  async get(ownerId: string, id: string) {
    const strategy = this.owned(ownerId, id);
    return strategy ? clone(strategy) : null;
  }
  async list(ownerId: string) {
    return [...this.strategies.values()].filter(strategy => strategy.ownerId === ownerId)
      .sort((a, b) => b.version - a.version).slice(0, 50).map(strategy => clone(strategy));
  }
  async nextVersion(ownerId: string) {
    const versions = [...this.strategies.values()].filter(strategy => strategy.ownerId === ownerId).map(strategy => strategy.version);
    return Math.max(0, ...versions) + 1;
  }
  async insert(strategy: HarnessStrategy) {
    if ([...this.strategies.values()].some(item => item.ownerId === strategy.ownerId && item.version === strategy.version)) {
      throw Object.assign(new Error("Duplicate strategy version"), { code: 11000 });
    }
    this.strategies.set(strategy.id, clone(strategy));
  }
  async promote(ownerId: string, parentId: string, candidateId: string, now: Date) {
    const head = this.heads.get(ownerId);
    const parent = this.owned(ownerId, parentId);
    const candidate = this.owned(ownerId, candidateId);
    if (!head || head.activeStrategyId !== parentId || !parent || parent.status !== "active" || !candidate || candidate.status !== "candidate" || candidate.parentId !== parentId) return false;
    head.activeStrategyId = candidateId;
    head.updatedAt = now;
    candidate.status = "active";
    candidate.updatedAt = now;
    parent.status = "superseded";
    parent.updatedAt = now;
    return true;
  }
  async rollback(ownerId: string, activeId: string, parentId: string, now: Date) {
    const head = this.heads.get(ownerId);
    const active = this.owned(ownerId, activeId);
    const parent = this.owned(ownerId, parentId);
    if (!head || head.activeStrategyId !== activeId || !active || !parent || active.parentId !== parentId) return false;
    head.activeStrategyId = parentId;
    head.updatedAt = now;
    active.status = "rolled_back";
    active.updatedAt = now;
    parent.status = "active";
    parent.updatedAt = now;
    return true;
  }
  async setStatus(ownerId: string, id: string, from: StrategyStatus, to: StrategyStatus, now: Date) {
    const strategy = this.owned(ownerId, id);
    if (!strategy || strategy.status !== from) return false;
    strategy.status = to;
    strategy.updatedAt = now;
    return true;
  }
  async saveOutcome(outcome: RecordedOutcome) { this.outcomes.push(clone(outcome)); }
  async listOutcomes(ownerId: string, strategyId: string) {
    return this.outcomes.filter(outcome => outcome.ownerId === ownerId && outcome.strategyId === strategyId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 100).map(outcome => clone(outcome));
  }
  async outcomesByIds(ownerId: string, ids: string[]) {
    const wanted = new Set(ids);
    return this.outcomes.filter(outcome => outcome.ownerId === ownerId && wanted.has(outcome.id)).map(outcome => clone(outcome));
  }
  async saveComparison(comparison: StrategyComparison, records: EvaluationRecord[]) {
    this.comparisons.set(comparison.id, clone(comparison));
    this.records.push(...records.map(record => clone(record)));
  }
  async latestComparison(ownerId: string, candidateId: string, baselineId: string, evaluationSetId: string) {
    const match = [...this.comparisons.values()].filter(comparison => comparison.ownerId === ownerId
      && comparison.candidateStrategyId === candidateId && comparison.baselineStrategyId === baselineId
      && comparison.evaluationSetId === evaluationSetId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return match ? clone(match) : null;
  }
  async getComparison(ownerId: string, id: string) {
    const comparison = this.comparisons.get(id);
    return comparison?.ownerId === ownerId ? clone(comparison) : null;
  }
  async listRecords(ownerId: string, comparisonId: string) {
    return this.records.filter(record => record.ownerId === ownerId && record.comparisonId === comparisonId).map(record => clone(record));
  }
  async saveDecision(decision: StrategyDecision) { this.decisions.push(clone(decision)); }
  async listDecisions(ownerId: string) {
    return this.decisions.map((decision, index) => ({ decision, index })).filter(item => item.decision.ownerId === ownerId)
      .sort((a, b) => b.decision.createdAt.getTime() - a.decision.createdAt.getTime() || b.index - a.index)
      .slice(0, 50).map(item => clone(item.decision));
  }
  async saveMigration(migration: StrategyMigration) { this.migrations.push(clone(migration)); }
  async listMigrations(ownerId: string, runId: string) {
    return this.migrations.filter(migration => migration.ownerId === ownerId && migration.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(migration => clone(migration));
  }
}

export class MongoStrategyStore implements StrategyStore {
  private strategies: Collection<HarnessStrategy>;
  private heads: Collection<StrategyHead>;
  private outcomes: Collection<RecordedOutcome>;
  private comparisons: Collection<StrategyComparison>;
  private records: Collection<EvaluationRecord>;
  private decisions: Collection<StrategyDecision>;
  private migrations: Collection<StrategyMigration>;
  constructor(db: Db) {
    this.strategies = db.collection<HarnessStrategy>("harness_strategies");
    this.heads = db.collection<StrategyHead>("harness_strategy_heads");
    this.outcomes = db.collection<RecordedOutcome>("harness_strategy_outcomes");
    this.comparisons = db.collection<StrategyComparison>("harness_strategy_comparisons");
    this.records = db.collection<EvaluationRecord>("harness_strategy_evaluations");
    this.decisions = db.collection<StrategyDecision>("harness_strategy_decisions");
    this.migrations = db.collection<StrategyMigration>("harness_strategy_migrations");
  }
  async init() {
    await this.strategies.createIndex({ id: 1 }, { unique: true });
    await this.strategies.createIndex({ ownerId: 1, version: 1 }, { unique: true });
    await this.heads.createIndex({ ownerId: 1 }, { unique: true });
    await this.outcomes.createIndex({ id: 1 }, { unique: true });
    await this.outcomes.createIndex({ ownerId: 1, strategyId: 1, createdAt: 1 });
    await this.comparisons.createIndex({ id: 1 }, { unique: true });
    await this.comparisons.createIndex({ ownerId: 1, candidateStrategyId: 1, evaluationSetId: 1, createdAt: -1 });
    await this.records.createIndex({ id: 1 }, { unique: true });
    await this.records.createIndex({ ownerId: 1, comparisonId: 1 });
    await this.decisions.createIndex({ id: 1 }, { unique: true });
    await this.decisions.createIndex({ ownerId: 1, createdAt: -1 });
    await this.migrations.createIndex({ id: 1 }, { unique: true });
    await this.migrations.createIndex({ ownerId: 1, runId: 1, createdAt: 1 });
  }
  async getActive(ownerId: string) {
    const head = await this.heads.findOne({ ownerId }, { projection: { _id: 0 } });
    if (!head) return null;
    return this.strategies.findOne({ ownerId, id: head.activeStrategyId }, { projection: { _id: 0 } });
  }
  async ensureBaseline(strategy: HarnessStrategy) {
    const current = await this.getActive(strategy.ownerId);
    if (current) return current;
    try {
      await this.strategies.insertOne(clone(strategy));
      await this.heads.insertOne({ ownerId: strategy.ownerId, activeStrategyId: strategy.id, updatedAt: strategy.updatedAt });
      return strategy;
    } catch (error) {
      if (!duplicate(error)) throw error;
      const winner = await this.getActive(strategy.ownerId);
      if (winner) return winner;
      throw error;
    }
  }
  get(ownerId: string, id: string) { return this.strategies.findOne({ ownerId, id }, { projection: { _id: 0 } }); }
  list(ownerId: string) {
    return this.strategies.find({ ownerId }, { projection: { _id: 0 } }).sort({ version: -1 }).limit(50).toArray();
  }
  async nextVersion(ownerId: string) {
    const latest = await this.strategies.find({ ownerId }, { projection: { _id: 0, version: 1 } }).sort({ version: -1 }).limit(1).next();
    return (latest?.version ?? 0) + 1;
  }
  async insert(strategy: HarnessStrategy) { await this.strategies.insertOne(clone(strategy)); }
  async promote(ownerId: string, parentId: string, candidateId: string, now: Date) {
    const head = await this.heads.findOneAndUpdate({ ownerId, activeStrategyId: parentId },
      { $set: { activeStrategyId: candidateId, updatedAt: now } }, { returnDocument: "after", projection: { _id: 0 } });
    if (!head) return false;
    const candidate = await this.strategies.updateOne({ ownerId, id: candidateId, status: "candidate", parentId },
      { $set: { status: "active", updatedAt: now } });
    if (candidate.modifiedCount !== 1) {
      await this.heads.updateOne({ ownerId, activeStrategyId: candidateId }, { $set: { activeStrategyId: parentId, updatedAt: now } });
      return false;
    }
    await this.strategies.updateOne({ ownerId, id: parentId, status: "active" }, { $set: { status: "superseded", updatedAt: now } });
    return true;
  }
  async rollback(ownerId: string, activeId: string, parentId: string, now: Date) {
    const head = await this.heads.findOneAndUpdate({ ownerId, activeStrategyId: activeId },
      { $set: { activeStrategyId: parentId, updatedAt: now } }, { returnDocument: "after", projection: { _id: 0 } });
    if (!head) return false;
    const active = await this.strategies.updateOne({ ownerId, id: activeId, parentId }, { $set: { status: "rolled_back", updatedAt: now } });
    if (active.modifiedCount !== 1) {
      await this.heads.updateOne({ ownerId, activeStrategyId: parentId }, { $set: { activeStrategyId: activeId, updatedAt: now } });
      return false;
    }
    await this.strategies.updateOne({ ownerId, id: parentId }, { $set: { status: "active", updatedAt: now } });
    return true;
  }
  async setStatus(ownerId: string, id: string, from: StrategyStatus, to: StrategyStatus, now: Date) {
    const updated = await this.strategies.updateOne({ ownerId, id, status: from }, { $set: { status: to, updatedAt: now } });
    return updated.modifiedCount === 1;
  }
  async saveOutcome(outcome: RecordedOutcome) { await this.outcomes.insertOne(clone(outcome)); }
  listOutcomes(ownerId: string, strategyId: string) {
    return this.outcomes.find({ ownerId, strategyId }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(100).toArray();
  }
  outcomesByIds(ownerId: string, ids: string[]) {
    return this.outcomes.find({ ownerId, id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
  }
  async saveComparison(comparison: StrategyComparison, records: EvaluationRecord[]) {
    await this.comparisons.insertOne(clone(comparison));
    if (records.length) await this.records.insertMany(records.map(record => clone(record)));
  }
  latestComparison(ownerId: string, candidateId: string, baselineId: string, evaluationSetId: string) {
    return this.comparisons.find({ ownerId, candidateStrategyId: candidateId, baselineStrategyId: baselineId, evaluationSetId },
      { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(1).next();
  }
  getComparison(ownerId: string, id: string) { return this.comparisons.findOne({ ownerId, id }, { projection: { _id: 0 } }); }
  listRecords(ownerId: string, comparisonId: string) {
    return this.records.find({ ownerId, comparisonId }, { projection: { _id: 0 } }).toArray();
  }
  async saveDecision(decision: StrategyDecision) { await this.decisions.insertOne(clone(decision)); }
  listDecisions(ownerId: string) {
    return this.decisions.find({ ownerId }).sort({ createdAt: -1, _id: -1 }).limit(50).project<StrategyDecision>({ _id: 0 }).toArray();
  }
  async saveMigration(migration: StrategyMigration) { await this.migrations.insertOne(clone(migration)); }
  listMigrations(ownerId: string, runId: string) {
    return this.migrations.find({ ownerId, runId }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  }
}
