import assert from "node:assert/strict";
import test from "node:test";
import { newStrategy, type EvaluationLimits, type StrategyCaseResult } from "../src/strategies/models.js";
import { StrategyService } from "../src/strategies/service.js";
import { MemoryStrategyStore } from "../src/strategies/store.js";

const limits: EvaluationLimits = {
  maxAttemptsPerCase: 3,
  maxDurationMinutes: 10,
  maxUsageUnits: 100,
  tools: ["repository"],
  repositoryAccess: ["example/repo"],
};
const result = (caseId: string, succeeded: boolean, attempts: number, usageUnits = 10): StrategyCaseResult => ({
  caseId, succeeded, attempts, durationMs: attempts * 1000, usageUnits, evidenceRefs: [`evaluation:${caseId}`],
});

async function fixture() {
  const store = new MemoryStrategyStore();
  const baseline = newStrategy({
    version: 1, status: "active", rationale: "Initial harness strategy",
    config: { planningInstructions: "Plan conservatively.", memoryPolicy: "relevant_evidence" },
  });
  const candidate = newStrategy({
    version: 2, parentId: baseline.id, status: "candidate", rationale: "Use failure evidence more explicitly",
    proposalEvidence: ["run:failed-1"],
    config: { planningInstructions: "Plan conservatively and cite the latest objective failure.", memoryPolicy: "relevant_evidence" },
  });
  await store.insert(baseline); await store.insert(candidate);
  return { store, baseline, candidate, service: new StrategyService(store, () => new Date("2026-09-26T20:00:00Z")) };
}

test("promotes a candidate only when baseline successes are preserved and a measured improvement exists", async () => {
  const f = await fixture();
  const evaluation = await f.service.evaluate({
    evaluationSetVersion: "demo-v1", baselineStrategyId: f.baseline.id, candidateStrategyId: f.candidate.id,
    model: "saved/model", baselineLimits: limits, candidateLimits: limits,
    baselineResults: [result("passes", true, 2), result("repair", false, 3)],
    candidateResults: [result("passes", true, 1), result("repair", true, 2)],
  });
  assert.equal(evaluation.decision, "promoted");
  assert.equal((await f.store.get(f.baseline.id))?.status, "retired");
  assert.equal((await f.store.get(f.candidate.id))?.status, "active");
  assert.equal((await f.store.evaluations()).length, 1);
});

test("rejects regressions, missing evidence, and permission or limit expansion", async () => {
  {
    const f = await fixture();
    const evaluation = await f.service.evaluate({
      evaluationSetVersion: "demo-v1", baselineStrategyId: f.baseline.id, candidateStrategyId: f.candidate.id,
      model: "saved/model", baselineLimits: limits, candidateLimits: limits,
      baselineResults: [result("stable", true, 1)], candidateResults: [result("stable", false, 1)],
    });
    assert.equal(evaluation.decision, "rejected");
    assert.equal((await f.store.get(f.baseline.id))?.status, "active");
    assert.equal((await f.store.get(f.candidate.id))?.status, "rejected");
  }
  {
    const f = await fixture();
    const evaluation = await f.service.evaluate({
      evaluationSetVersion: "demo-v1", baselineStrategyId: f.baseline.id, candidateStrategyId: f.candidate.id,
      model: "saved/model", baselineLimits: limits, candidateLimits: { ...limits, tools: ["repository", "shell"] },
      baselineResults: [result("stable", true, 2)], candidateResults: [result("stable", true, 1)],
    });
    assert.equal(evaluation.decision, "rejected");
    assert.match(evaluation.reason, /cannot expand/i);
  }
  {
    const f = await fixture();
    const evaluation = await f.service.evaluate({
      evaluationSetVersion: "demo-v1", baselineStrategyId: f.baseline.id, candidateStrategyId: f.candidate.id,
      model: "saved/model", baselineLimits: limits, candidateLimits: limits,
      baselineResults: [result("a", true, 2), result("b", false, 3)], candidateResults: [result("a", true, 1)],
    });
    assert.equal(evaluation.decision, "rejected");
    assert.match(evaluation.reason, /complete results/i);
  }
});

test("rollback restores the prior immutable version without rewriting strategy contents", async () => {
  const f = await fixture();
  const baselineSnapshot = structuredClone(f.baseline);
  await f.service.evaluate({
    evaluationSetVersion: "demo-v1", baselineStrategyId: f.baseline.id, candidateStrategyId: f.candidate.id,
    model: "saved/model", baselineLimits: limits, candidateLimits: limits,
    baselineResults: [result("repair", false, 3)], candidateResults: [result("repair", true, 2)],
  });
  const active = await f.service.rollback(f.candidate.id, f.baseline.id);
  assert.equal(active?.id, f.baseline.id);
  const restored = await f.store.get(f.baseline.id);
  assert.deepEqual(restored?.config, baselineSnapshot.config);
  assert.deepEqual(restored?.proposalEvidence, baselineSnapshot.proposalEvidence);
});

test("strategy versions are append-only; duplicate IDs or version numbers are rejected", async () => {
  const f = await fixture();
  await assert.rejects(f.store.insert(structuredClone(f.baseline)), /STRATEGY_VERSION_EXISTS/);
  const duplicateVersion = newStrategy({
    version: f.candidate.version, parentId: f.candidate.id, status: "candidate", rationale: "duplicate",
    config: { planningInstructions: "different", memoryPolicy: "recent_evidence" },
  });
  await assert.rejects(f.store.insert(duplicateVersion), /STRATEGY_VERSION_EXISTS/);
});
