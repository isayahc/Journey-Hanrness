import { evaluatePromotion, type EvaluationLimits, type HarnessStrategyVersion, type StrategyCaseResult, type StrategyEvaluation } from "./models.js";
import { evaluationId, type StrategyStore } from "./store.js";

export class StrategyService {
  constructor(private store: StrategyStore, private now: () => Date = () => new Date()) {}

  async evaluate(input: {
    evaluationSetVersion: string;
    baselineStrategyId: string;
    candidateStrategyId: string;
    model: string;
    baselineLimits: EvaluationLimits;
    candidateLimits: EvaluationLimits;
    baselineResults: StrategyCaseResult[];
    candidateResults: StrategyCaseResult[];
  }): Promise<StrategyEvaluation> {
    const [baseline, candidate] = await Promise.all([
      this.store.get(input.baselineStrategyId),
      this.store.get(input.candidateStrategyId),
    ]);
    if (!baseline || baseline.status !== "active") throw new Error("STRATEGY_BASELINE_NOT_ACTIVE");
    if (!candidate || candidate.status !== "candidate" || candidate.parentId !== baseline.id) throw new Error("STRATEGY_CANDIDATE_INVALID");

    const decision = evaluatePromotion(input.baselineResults, input.candidateResults, input.baselineLimits, input.candidateLimits);
    const record: StrategyEvaluation = {
      id: evaluationId(),
      evaluationSetVersion: input.evaluationSetVersion,
      baselineStrategyId: baseline.id,
      candidateStrategyId: candidate.id,
      model: input.model,
      limits: structuredClone(input.candidateLimits),
      baselineResults: structuredClone(input.baselineResults),
      candidateResults: structuredClone(input.candidateResults),
      decision: decision.promotable ? "promoted" : "rejected",
      reason: decision.reason,
      createdAt: this.now(),
    };
    await this.store.recordEvaluation(record);

    if (!decision.promotable) {
      if (!await this.store.transition(candidate.id, "candidate", "rejected", record.createdAt)) throw new Error("STRATEGY_DECISION_CONFLICT");
      return record;
    }

    if (!await this.store.transition(baseline.id, "active", "retired", record.createdAt)) throw new Error("STRATEGY_DECISION_CONFLICT");
    if (!await this.store.transition(candidate.id, "candidate", "active", record.createdAt)) {
      await this.store.transition(baseline.id, "retired", "active", record.createdAt);
      throw new Error("STRATEGY_DECISION_CONFLICT");
    }
    return record;
  }

  async rollback(currentId: string, previousId: string) {
    const [current, previous] = await Promise.all([this.store.get(currentId), this.store.get(previousId)]);
    if (!current || current.status !== "active" || !previous || previous.status !== "retired") throw new Error("STRATEGY_ROLLBACK_INVALID");
    const at = this.now();
    if (!await this.store.transition(current.id, "active", "retired", at)) throw new Error("STRATEGY_DECISION_CONFLICT");
    if (!await this.store.transition(previous.id, "retired", "active", at)) {
      await this.store.transition(current.id, "retired", "active", at);
      throw new Error("STRATEGY_DECISION_CONFLICT");
    }
    return this.store.active() as Promise<HarnessStrategyVersion | null>;
  }
}
