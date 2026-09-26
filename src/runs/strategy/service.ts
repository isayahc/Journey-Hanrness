import { randomUUID } from "node:crypto";
import type { RunStore } from "../store.js";
import { evaluationCases } from "./cases.js";
import { judge } from "./decide.js";
import { evaluateCase } from "./evaluate.js";
import {
  EVALUATION_EXECUTOR, EVALUATION_SET_REPAIR, EXPANSION_FIELDS, PROMOTION_CRITERIA_ID,
  applyProposal, expansionViolations, migrationInput, outcomeInput, proposalInput, publicComparison,
  publicDecision, publicMigration, publicOutcome, publicRecord, publicStrategy, baselineStrategy,
  type ComparisonVerdict, type DecisionReason, type EvaluationRecord, type HarnessStrategy,
  type ProposalInput, type StrategyComparison, type StrategyDecision,
} from "./models.js";
import { proposalFromOutcomes } from "./propose.js";
import type { StrategyStore } from "./store.js";

export class StrategyRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

const LIMIT_MESSAGE = "Strategy proposals cannot add tools, repository access, or execution budget. Adaptation keeps the parent strategy's permissions and limits.";

function duplicate(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export class StrategyService {
  constructor(private store: StrategyStore, private model: string) {}

  async ensureBaseline(ownerId: string) {
    const existing = await this.store.getActive(ownerId);
    if (existing) return existing;
    return this.store.ensureBaseline(baselineStrategy(ownerId, this.model));
  }
  async list(ownerId: string) { return (await this.store.list(ownerId)).map(publicStrategy); }
  async active(ownerId: string) { return publicStrategy(await this.ensureBaseline(ownerId)); }
  async get(ownerId: string, id: string) {
    const strategy = await this.store.get(ownerId, id);
    if (!strategy) throw new StrategyRequestError("Strategy not found.", 404, "NOT_FOUND");
    return publicStrategy(strategy);
  }
  async decisions(ownerId: string) { return (await this.store.listDecisions(ownerId)).map(publicDecision); }
  async pinned(ownerId: string, id: string, version: number) {
    const strategy = await this.store.get(ownerId, id);
    return strategy?.version === version ? strategy : null;
  }

  async recordOutcome(ownerId: string, value: unknown) {
    const parsed = outcomeInput.safeParse(value);
    if (!parsed.success) throw new StrategyRequestError("Invalid outcome. Record the strategy, success, attempts, duration, usage, and feedback from a real check.", 400, "INVALID_OUTCOME");
    const strategy = await this.store.get(ownerId, parsed.data.strategyId);
    if (!strategy) throw new StrategyRequestError("Strategy not found.", 404, "NOT_FOUND");
    const outcome = {
      id: randomUUID(),
      ownerId,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      runId: parsed.data.runId ?? null,
      caseId: parsed.data.caseId ?? null,
      success: parsed.data.success,
      attempts: parsed.data.attempts,
      durationMs: parsed.data.durationMs,
      usage: parsed.data.usage,
      feedback: parsed.data.feedback,
      createdAt: new Date(),
    };
    await this.store.saveOutcome(outcome);
    return publicOutcome(outcome);
  }

  async propose(ownerId: string, value: unknown, proposer: "explicit" | "failure-evidence-v1" = "explicit") {
    const active = await this.ensureBaseline(ownerId);
    const parsed = proposalInput.safeParse(value);
    if (!parsed.success) {
      const unknownKeys = parsed.error.issues.flatMap(issue => issue.code === "unrecognized_keys" ? issue.keys : []);
      if (unknownKeys.some(key => (EXPANSION_FIELDS as readonly string[]).includes(key))) {
        return { strategy: null, decision: await this.recordDecision(ownerId, active, null, "rejected", "LIMIT_EXPANSION", LIMIT_MESSAGE, [], null, null) };
      }
      throw new StrategyRequestError("Invalid strategy proposal. Provide a rationale, 1–20 recorded outcome IDs, and an optional bounded change to planning instructions, memory selection, or execution approach.", 400, "INVALID_PROPOSAL");
    }
    return this.acceptProposal(ownerId, active, parsed.data, proposer);
  }

  async proposeFromOutcomes(ownerId: string) {
    const active = await this.ensureBaseline(ownerId);
    const outcomes = await this.store.listOutcomes(ownerId, active.id);
    const proposal = proposalFromOutcomes(active.config, outcomes);
    if (!proposal) {
      return {
        strategy: null,
        decision: await this.recordDecision(ownerId, active, null, "rejected", "NO_IMPROVEMENT", "Recorded outcomes do not support a bounded strategy change.", [], null, null),
      };
    }
    return this.acceptProposal(ownerId, active, proposal, "failure-evidence-v1");
  }

  async compare(ownerId: string, strategyId: string, evaluationSetId = EVALUATION_SET_REPAIR) {
    const strategy = await this.store.get(ownerId, strategyId);
    if (!strategy) throw new StrategyRequestError("Strategy not found.", 404, "NOT_FOUND");
    if (strategy.status === "rejected" || strategy.status === "rolled_back" || strategy.status === "superseded") {
      throw new StrategyRequestError("Only an active strategy or an open candidate can be compared.", 409, "NOT_COMPARABLE");
    }
    if (!strategy.parentId) throw new StrategyRequestError("The baseline strategy has no parent to compare against.", 409, "NOT_COMPARABLE");
    const baseline = await this.store.get(ownerId, strategy.parentId);
    if (!baseline) throw new StrategyRequestError("Parent strategy not found.", 404, "NOT_FOUND");
    let cases;
    try { cases = evaluationCases(evaluationSetId); }
    catch (error) { throw new StrategyRequestError(error instanceof Error ? error.message : "Unknown evaluation set.", 400, "UNKNOWN_EVALUATION_SET"); }
    const limits = structuredClone(baseline.config.limits);
    const now = new Date();
    const comparisonId = randomUUID();
    const records: EvaluationRecord[] = [];
    for (const side of [baseline, strategy]) {
      for (const evalCase of cases) {
        const measured = evaluateCase(side.config, evalCase, limits);
        records.push({
          id: randomUUID(),
          ownerId,
          comparisonId,
          strategyId: side.id,
          strategyVersion: side.version,
          caseId: evalCase.id,
          model: this.model,
          limits: structuredClone(limits),
          evaluationSetId,
          executor: EVALUATION_EXECUTOR,
          criteriaId: PROMOTION_CRITERIA_ID,
          ...measured,
          createdAt: now,
        });
      }
    }
    const summary = judge(records.filter(record => record.strategyId === baseline.id), records.filter(record => record.strategyId === strategy.id));
    const comparison: StrategyComparison = {
      id: comparisonId,
      ownerId,
      baselineStrategyId: baseline.id,
      baselineVersion: baseline.version,
      candidateStrategyId: strategy.id,
      candidateVersion: strategy.version,
      model: this.model,
      limits,
      evaluationSetId,
      executor: EVALUATION_EXECUTOR,
      criteriaId: PROMOTION_CRITERIA_ID,
      recordIds: records.map(record => record.id),
      summary,
      createdAt: now,
    };
    await this.store.saveComparison(comparison, records);
    return { comparison: publicComparison(comparison), records: records.map(publicRecord) };
  }

  async promote(ownerId: string, candidateId: string) {
    const candidate = await this.store.get(ownerId, candidateId);
    if (!candidate || candidate.status !== "candidate") throw new StrategyRequestError("Candidate strategy not found.", 404, "NOT_FOUND");
    const active = await this.store.getActive(ownerId);
    if (!active || active.id !== candidate.parentId) {
      throw new StrategyRequestError("The parent strategy is no longer active. Compare the candidate with the current strategy before promotion.", 409, "STALE_PARENT");
    }
    const comparison = await this.store.latestComparison(ownerId, candidate.id, active.id, EVALUATION_SET_REPAIR);
    if (!comparison) {
      return this.recordDecision(ownerId, active, candidate, "rejected", "INCOMPLETE_COMPARISON", "Promotion requires a repair-v1 comparison of this candidate against the active strategy. No evaluation records are linked yet.", candidate.evidenceIds, null, null);
    }
    const loaded = await this.loadVerdict(ownerId, comparison, active.id, candidate.id);
    if (!loaded) {
      return this.recordDecision(ownerId, active, candidate, "rejected", "INCOMPLETE_COMPARISON", "The stored comparison is missing baseline or candidate evaluation records.", candidate.evidenceIds, comparison.id, null);
    }
    const violations = expansionViolations(active.config, candidate.config);
    if (violations.length || loaded.reason !== "IMPROVEMENT") {
      const reason: DecisionReason = violations.length ? "LIMIT_EXPANSION" : loaded.reason === "REGRESSION" ? "REGRESSION" : "NO_IMPROVEMENT";
      await this.store.setStatus(ownerId, candidate.id, "candidate", "rejected", new Date());
      const rationale = violations.length
        ? `Candidate expands ${violations.join(", ")}. The active strategy was retained.`
        : reason === "REGRESSION"
          ? `Candidate regresses on ${loaded.regressions.join(", ")}. The active strategy was retained.`
          : "Candidate does not improve successes, attempts, or measured time. The active strategy was retained.";
      return this.recordDecision(ownerId, active, candidate, "rejected", reason, rationale, comparison.recordIds, comparison.id, loaded);
    }
    if (!await this.store.promote(ownerId, active.id, candidate.id, new Date())) {
      throw new StrategyRequestError("Promotion lost a race with another strategy change. Refresh the active strategy and compare again.", 409, "STALE_PARENT");
    }
    return this.recordDecision(ownerId, active, candidate, "promoted", "IMPROVEMENT", "Candidate improved the repair-v1 comparison without a regression and without expanding permissions or limits.", comparison.recordIds, comparison.id, loaded);
  }

  async rollback(ownerId: string, strategyId: string, comparisonId: string) {
    const active = await this.store.getActive(ownerId);
    if (!active || active.id !== strategyId) throw new StrategyRequestError("Only the active strategy can be rolled back.", 409, "NOT_ACTIVE");
    if (!active.parentId) throw new StrategyRequestError("The baseline strategy has no parent to restore.", 409, "NOT_ACTIVE");
    const parent = await this.store.get(ownerId, active.parentId);
    if (!parent) throw new StrategyRequestError("Parent strategy not found.", 404, "NOT_FOUND");
    const comparison = await this.store.getComparison(ownerId, comparisonId);
    if (!comparison || comparison.candidateStrategyId !== active.id || comparison.baselineStrategyId !== parent.id) {
      throw new StrategyRequestError("Rollback requires a stored comparison of this strategy against its parent.", 404, "MISSING_EVIDENCE");
    }
    const loaded = await this.loadVerdict(ownerId, comparison, parent.id, active.id);
    if (!loaded) throw new StrategyRequestError("The comparison is missing evaluation records.", 409, "INCOMPLETE_COMPARISON");
    if (loaded.reason !== "REGRESSION") {
      throw new StrategyRequestError("Rollback requires a comparison where the active strategy fails a case its parent passed.", 409, "NO_REGRESSION");
    }
    if (!await this.store.rollback(ownerId, active.id, parent.id, new Date())) {
      throw new StrategyRequestError("The active strategy changed before rollback completed.", 409, "NOT_ACTIVE");
    }
    return this.recordDecision(ownerId, parent, active, "rolled_back", "POST_PROMOTION_REGRESSION", `Active strategy regresses on ${loaded.regressions.join(", ")}. Restored parent strategy v${parent.version}.`, comparison.recordIds, comparison.id, loaded);
  }

  async migrateRun(ownerId: string, runId: string, value: unknown, runs: RunStore) {
    const parsed = migrationInput.safeParse(value);
    if (!parsed.success) throw new StrategyRequestError("Provide the strategy to pin and a short reason for the migration.", 400, "INVALID_MIGRATION");
    const run = await runs.get(ownerId, runId);
    if (!run) throw new StrategyRequestError("Run not found.", 404, "NOT_FOUND");
    const strategy = await this.store.get(ownerId, parsed.data.strategyId);
    if (!strategy || strategy.status === "candidate" || strategy.status === "rejected") {
      throw new StrategyRequestError("Runs can only be migrated to a retained strategy version.", 409, "NOT_MIGRATABLE");
    }
    const now = new Date();
    const updated = await runs.pinStrategy(ownerId, runId, { strategyId: strategy.id, strategyVersion: strategy.version }, now);
    if (!updated) throw new StrategyRequestError("Run not found.", 404, "NOT_FOUND");
    const migration = {
      id: randomUUID(),
      ownerId,
      runId,
      fromStrategyId: run.strategyId ?? null,
      fromVersion: run.strategyVersion ?? null,
      toStrategyId: strategy.id,
      toVersion: strategy.version,
      reason: parsed.data.reason,
      createdAt: now,
    };
    await this.store.saveMigration(migration);
    return { migration: publicMigration(migration) };
  }
  async migrations(ownerId: string, runId: string) {
    return (await this.store.listMigrations(ownerId, runId)).map(publicMigration);
  }
  async comparison(ownerId: string, id: string) {
    const comparison = await this.store.getComparison(ownerId, id);
    if (!comparison) throw new StrategyRequestError("Comparison not found.", 404, "NOT_FOUND");
    const records = await this.store.listRecords(ownerId, comparison.id);
    return { comparison: publicComparison(comparison), records: records.map(publicRecord) };
  }

  private async acceptProposal(ownerId: string, active: HarnessStrategy, proposal: ProposalInput, proposer: "explicit" | "failure-evidence-v1") {
    const evidence = await this.store.outcomesByIds(ownerId, proposal.evidenceIds);
    if (evidence.length !== proposal.evidenceIds.length || evidence.some(outcome => outcome.strategyId !== active.id)) {
      const found = new Set(evidence.filter(outcome => outcome.strategyId === active.id).map(outcome => outcome.id));
      const missing = proposal.evidenceIds.filter(id => !found.has(id));
      return {
        strategy: null,
        decision: await this.recordDecision(ownerId, active, null, "rejected", "MISSING_EVIDENCE", `Missing recorded outcomes for the active strategy: ${missing.join(", ") || "none of the supplied outcomes belong to it"}.`, proposal.evidenceIds, null, null),
      };
    }
    const config = applyProposal(active.config, proposal);
    const violations = expansionViolations(active.config, config);
    if (violations.length) {
      return {
        strategy: null,
        decision: await this.recordDecision(ownerId, active, null, "rejected", "LIMIT_EXPANSION", `Proposal expands ${violations.join(", ")}. ${LIMIT_MESSAGE}`, proposal.evidenceIds, null, null),
      };
    }
    const now = new Date();
    const strategy: HarnessStrategy = {
      id: randomUUID(),
      ownerId,
      version: await this.store.nextVersion(ownerId),
      parentId: active.id,
      parentVersion: active.version,
      status: "candidate",
      config,
      rationale: proposal.rationale,
      evidenceIds: proposal.evidenceIds,
      proposer,
      model: this.model,
      createdAt: now,
      updatedAt: now,
    };
    try { await this.store.insert(strategy); }
    catch (error) {
      if (duplicate(error)) throw new StrategyRequestError("A strategy version was saved concurrently. Retry the proposal.", 409, "VERSION_CONFLICT");
      throw error;
    }
    return { strategy: publicStrategy(strategy), decision: null };
  }

  private async loadVerdict(ownerId: string, comparison: StrategyComparison, baselineId: string, candidateId: string): Promise<ComparisonVerdict | null> {
    const records = await this.store.listRecords(ownerId, comparison.id);
    const cases = evaluationCases(comparison.evaluationSetId);
    const baseline = cases.map(evalCase => records.find(record => record.strategyId === baselineId && record.caseId === evalCase.id));
    const candidate = cases.map(evalCase => records.find(record => record.strategyId === candidateId && record.caseId === evalCase.id));
    if (baseline.some(record => !record) || candidate.some(record => !record)) return null;
    const baselineRecords = baseline.filter((record): record is EvaluationRecord => !!record);
    const candidateRecords = candidate.filter((record): record is EvaluationRecord => !!record);
    const shared = JSON.stringify(comparison.limits);
    for (const record of [...baselineRecords, ...candidateRecords]) {
      if (record.model !== comparison.model || JSON.stringify(record.limits) !== shared || record.evaluationSetId !== comparison.evaluationSetId) return null;
    }
    return judge(baselineRecords, candidateRecords);
  }

  private async recordDecision(
    ownerId: string,
    parent: HarnessStrategy,
    strategy: HarnessStrategy | null,
    action: StrategyDecision["action"],
    reason: DecisionReason,
    rationale: string,
    evidenceIds: string[],
    comparisonId: string | null,
    metrics: ComparisonVerdict | null,
  ) {
    const decision: StrategyDecision = {
      id: randomUUID(),
      ownerId,
      action,
      reason,
      strategyId: strategy?.id ?? null,
      strategyVersion: strategy?.version ?? null,
      parentStrategyId: parent.id,
      parentVersion: parent.version,
      comparisonId,
      rationale,
      evidenceIds,
      metrics,
      createdAt: new Date(),
    };
    await this.store.saveDecision(decision);
    return publicDecision(decision);
  }
}
