import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { createChatApp } from "../src/chat/app.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";
import { OpenCodeRunPlanner } from "../src/runs/planner.js";
import { runInput, type GoalRun } from "../src/runs/models.js";
import { RunService } from "../src/runs/service.js";
import { MemoryRunStore, MongoRunStore } from "../src/runs/store.js";
import { selectMemory } from "../src/runs/strategy/memory.js";
import { baselineConfig, baselineStrategy, type HarnessStrategy } from "../src/runs/strategy/models.js";
import { StrategyService } from "../src/runs/strategy/service.js";
import { MemoryStrategyStore, MongoStrategyStore } from "../src/runs/strategy/store.js";
import type { SearchService } from "../src/search/service.js";

const goal = { goal: "Repair the exported record", successCriteria: ["The record matches the expected schema"] };
const plan = { summary: "Repair then verify", steps: [{ id: "repair", title: "Repair the record", instruction: "Apply the recorded failure", dependsOn: [], verification: "Schema validation passes" }] };
const failure = {
  caseId: "schema-repair", success: false, attempts: 3, durationMs: 300,
  usage: { modelCalls: 3, toolCalls: 0 }, feedback: "Schema validation failed: expected record did not match.",
};
const baselineSummary = { successes: 2, cases: 3, attempts: 5, durationMs: 500, modelCalls: 5, toolCalls: 0 };
const improvedSummary = { successes: 3, cases: 3, attempts: 4, durationMs: 400, modelCalls: 4, toolCalls: 0 };

function services(model = "opencode/space-bunny-free") {
  const strategies = new MemoryStrategyStore();
  const runs = new MemoryRunStore();
  const strategyService = new StrategyService(strategies, model);
  const seen: Array<HarnessStrategy | undefined> = [];
  const runService = new RunService(runs, { plan: async (_run, strategy) => { seen.push(strategy); return plan; } }, { OPENCODE_MODEL: model }, strategyService);
  return { strategies, runs, strategyService, runService, seen };
}

async function improvedCandidate(strategyService: StrategyService, owner = "owner") {
  const active = await strategyService.active(owner);
  const outcome = await strategyService.recordOutcome(owner, { ...failure, strategyId: active.id });
  const proposed = await strategyService.proposeFromOutcomes(owner);
  assert.ok(proposed.strategy);
  return { active, outcome, candidate: proposed.strategy };
}

test("memory selection keeps the budget and does not promote assumptions", () => {
  const selection = { ...baselineConfig().memorySelection, maxEvidenceItems: 2, includeFailureEvidence: true };
  const older = new Date("2020-01-01T00:00:00Z");
  const newer = new Date("2020-01-02T00:00:00Z");
  const selected = selectMemory(selection, [
    { id: "assumption", kind: "assumption", text: "This is probably fine", createdAt: newer },
    { id: "old-failure", kind: "failure", text: "Schema mismatch", createdAt: older },
    { id: "new-failure", kind: "failure", text: "Missing field", createdAt: newer },
    { id: "goal", kind: "goal", text: "Repair the record", createdAt: newer },
    { id: "decision", kind: "decision", text: "Keep the previous field", createdAt: older },
  ]);
  assert.deepEqual(selected.map(item => item.id), ["new-failure", "goal"]);
  const withoutFailures = selectMemory({ ...selection, includeFailureEvidence: false, maxEvidenceItems: 5 }, [
    { id: "failure", kind: "failure", text: "Schema mismatch" },
    { id: "goal", kind: "goal", text: "Repair the record" },
  ]);
  assert.deepEqual(withoutFailures.map(item => item.id), ["goal"]);
});

test("a failure-evidence candidate improves repair-v1 and keeps permissions and limits", async () => {
  const { strategyService } = services();
  const { active, outcome, candidate } = await improvedCandidate(strategyService);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.version, 2);
  assert.equal(candidate.parentId, active.id);
  assert.equal(candidate.parentVersion, 1);
  assert.equal(candidate.proposer, "failure-evidence-v1");
  assert.deepEqual(candidate.evidenceIds, [outcome.id]);
  assert.match(candidate.rationale, /failed an objective check/);
  assert.equal(candidate.config.memorySelection.includeFailureEvidence, true);
  assert.match(candidate.config.planningInstructions, /failure evidence/);
  assert.match(candidate.config.planningInstructions, /Verify/);
  assert.deepEqual(candidate.config.permissions, active.config.permissions);
  assert.deepEqual(candidate.config.limits, active.config.limits);
  assert.deepEqual(candidate.config.permissions, { tools: [], repositoryAccess: "none" });

  const compared = await strategyService.compare("owner", candidate.id);
  assert.equal(compared.comparison.model, "opencode/space-bunny-free");
  assert.equal(compared.comparison.evaluationSetId, "repair-v1");
  assert.equal(compared.comparison.executor, "deterministic-v1");
  assert.equal(compared.comparison.criteriaId, "strict-improvement-v1");
  assert.deepEqual(compared.comparison.limits, active.config.limits);
  assert.deepEqual(compared.comparison.summary.baseline, baselineSummary);
  assert.deepEqual(compared.comparison.summary.candidate, improvedSummary);
  assert.deepEqual(compared.comparison.summary.improvements, ["schema-repair"]);
  assert.deepEqual(compared.comparison.summary.regressions, []);
  assert.equal(compared.records.length, 6);
  assert.ok(compared.records.every(record => record.comparisonId === compared.comparison.id));
  assert.ok(compared.records.every(record => record.usage.toolCalls === 0));
  assert.ok(compared.comparison.recordIds.every(id => compared.records.some(record => record.id === id)));
  const schema = compared.comparison.summary.cases.find(item => item.caseId === "schema-repair");
  assert.deepEqual(schema, {
    caseId: "schema-repair",
    baseline: { success: false, attempts: 3, durationMs: 300, modelCalls: 3, toolCalls: 0 },
    candidate: { success: true, attempts: 2, durationMs: 200, modelCalls: 2, toolCalls: 0 },
  });

  const repeated = await strategyService.compare("owner", candidate.id);
  assert.notEqual(repeated.comparison.id, compared.comparison.id);
  assert.deepEqual(repeated.comparison.summary, compared.comparison.summary);
  assert.deepEqual(repeated.comparison.limits, compared.comparison.limits);
  assert.equal(repeated.comparison.model, compared.comparison.model);

  const decision = await strategyService.promote("owner", candidate.id);
  assert.equal(decision.action, "promoted");
  assert.equal(decision.reason, "IMPROVEMENT");
  assert.equal(decision.comparisonId, repeated.comparison.id);
  assert.deepEqual(decision.metrics?.baseline, baselineSummary);
  assert.deepEqual(decision.metrics?.candidate, improvedSummary);
  assert.equal((await strategyService.active("owner")).id, candidate.id);
  assert.equal((await strategyService.get("owner", active.id)).status, "superseded");
  assert.deepEqual((await strategyService.active("owner")).config.permissions, active.config.permissions);
  assert.deepEqual((await strategyService.active("owner")).config.limits, active.config.limits);
  assert.equal((await strategyService.decisions("owner")).some(item => item.action === "promoted"), true);
});

test("strategy versions, comparisons, and promotion decisions survive a new service on the same store", async () => {
  const { strategies, strategyService } = services("recorded/model");
  const { candidate } = await improvedCandidate(strategyService);
  await strategyService.compare("owner", candidate.id);
  const decision = await strategyService.promote("owner", candidate.id);
  const restarted = new StrategyService(strategies, "changed/model");
  assert.equal((await restarted.active("owner")).version, 2);
  assert.equal((await restarted.active("owner")).model, "recorded/model");
  const decisions = await restarted.decisions("owner");
  assert.equal(decisions[0]?.action, "promoted");
  assert.equal(decisions[0]?.comparisonId, decision.comparisonId);
  const loaded = await restarted.comparison("owner", decision.comparisonId!);
  assert.equal(loaded.records.length, 6);
  assert.deepEqual(loaded.comparison.summary.candidate, improvedSummary);
  assert.equal(loaded.comparison.model, "recorded/model");
});

test("a regressing candidate is rejected and the active strategy stays in place", async () => {
  const { strategies, strategyService } = services();
  const active = await strategyService.active("owner");
  const outcome = await strategyService.recordOutcome("owner", { ...failure, strategyId: active.id });
  const proposed = await strategyService.propose("owner", {
    rationale: "Stop verifying and reuse the failure evidence.",
    evidenceIds: [outcome.id],
    planningInstructions: "On a failed check, revise the next attempt using the recorded failure evidence. Assert completion without a separate check.",
    memorySelection: { includeFailureEvidence: true },
  });
  assert.equal(proposed.strategy?.status, "candidate");
  const compared = await strategyService.compare("owner", proposed.strategy!.id);
  assert.deepEqual(compared.comparison.summary.regressions, ["citation-check"]);
  assert.ok(compared.comparison.summary.improvements.includes("schema-repair"));
  const decision = await strategyService.promote("owner", proposed.strategy!.id);
  assert.equal(decision.action, "rejected");
  assert.equal(decision.reason, "REGRESSION");
  assert.equal(decision.comparisonId, compared.comparison.id);
  assert.deepEqual(decision.evidenceIds, compared.comparison.recordIds);
  assert.equal((await strategyService.active("owner")).id, active.id);
  assert.equal((await strategyService.get("owner", proposed.strategy!.id)).status, "rejected");
  const restarted = new StrategyService(strategies, "opencode/space-bunny-free");
  assert.equal((await restarted.active("owner")).id, active.id);
  assert.equal((await restarted.decisions("owner"))[0]?.reason, "REGRESSION");
});

test("rollback restores the parent only when a later comparison shows a regression", async () => {
  const { strategies, strategyService, runService } = services();
  const { active, candidate } = await improvedCandidate(strategyService);
  const repair = await strategyService.compare("owner", candidate.id);
  await strategyService.promote("owner", candidate.id);
  await assert.rejects(strategyService.rollback("owner", candidate.id, repair.comparison.id), /fails a case its parent passed/);
  assert.equal((await strategyService.active("owner")).id, candidate.id);
  const holdout = await strategyService.compare("owner", candidate.id, "holdout-v1");
  assert.equal(holdout.comparison.evaluationSetId, "holdout-v1");
  assert.deepEqual(holdout.comparison.summary.regressions, ["failure-noise"]);
  assert.equal(holdout.comparison.summary.baseline.successes, 1);
  assert.equal(holdout.comparison.summary.candidate.successes, 0);
  assert.equal(holdout.records.find(record => record.caseId === "failure-noise" && record.strategyId === candidate.id)?.success, false);
  const decision = await strategyService.rollback("owner", candidate.id, holdout.comparison.id);
  assert.equal(decision.action, "rolled_back");
  assert.equal(decision.reason, "POST_PROMOTION_REGRESSION");
  assert.equal(decision.parentStrategyId, active.id);
  assert.deepEqual(decision.evidenceIds, holdout.comparison.recordIds);
  assert.equal((await strategyService.active("owner")).id, active.id);
  assert.equal((await strategyService.get("owner", candidate.id)).status, "rolled_back");
  assert.equal((await runService.create("owner", goal)).strategyVersion, 1);
  const restarted = new StrategyService(strategies, "opencode/space-bunny-free");
  assert.equal((await restarted.active("owner")).version, 1);
  assert.equal((await restarted.decisions("owner"))[0]?.action, "rolled_back");
});

test("missing outcome evidence and a missing comparison block promotion", async () => {
  const { strategies, strategyService } = services();
  const missing = await strategyService.propose("owner", {
    rationale: "Select failure evidence from a check that was not recorded.",
    evidenceIds: [crypto.randomUUID()],
    memorySelection: { includeFailureEvidence: true },
  });
  assert.equal(missing.strategy, null);
  assert.equal(missing.decision?.reason, "MISSING_EVIDENCE");
  assert.equal(missing.decision?.strategyId, null);
  assert.equal((await strategyService.list("owner")).length, 1);

  const active = await strategyService.active("owner");
  const other = await new StrategyService(strategies, "opencode/space-bunny-free").recordOutcome("intruder", { ...failure, strategyId: (await strategyService.active("intruder")).id });
  const foreign = await strategyService.propose("owner", {
    rationale: "Cite another owner's outcome.",
    evidenceIds: [other.id],
    memorySelection: { includeFailureEvidence: true },
  });
  assert.equal(foreign.decision?.reason, "MISSING_EVIDENCE");

  const outcome = await strategyService.recordOutcome("owner", { ...failure, strategyId: active.id });
  const proposed = await strategyService.propose("owner", {
    rationale: "Select failure evidence before measuring it.",
    evidenceIds: [outcome.id],
    memorySelection: { includeFailureEvidence: true },
    planningInstructions: `${active.config.planningInstructions} On a failed check, revise the next attempt using the recorded failure evidence.`,
  });
  const incomplete = await strategyService.promote("owner", proposed.strategy!.id);
  assert.equal(incomplete.reason, "INCOMPLETE_COMPARISON");
  assert.equal(incomplete.action, "rejected");
  assert.equal((await strategyService.get("owner", proposed.strategy!.id)).status, "candidate");
  assert.equal((await strategyService.active("owner")).id, active.id);
  const restarted = new StrategyService(strategies, "opencode/space-bunny-free");
  assert.ok((await restarted.decisions("owner")).some(decision => decision.reason === "MISSING_EVIDENCE"));
  assert.ok((await restarted.decisions("owner")).some(decision => decision.reason === "INCOMPLETE_COMPARISON"));
});

test("proposals cannot expand tools, repository access, or execution budgets", async () => {
  const { strategyService } = services();
  const active = await strategyService.active("owner");
  const outcome = await strategyService.recordOutcome("owner", { ...failure, strategyId: active.id });
  for (const value of [
    { rationale: "Add a shell tool.", evidenceIds: [outcome.id], permissions: { tools: ["bash"], repositoryAccess: "job" } },
    { rationale: "Raise the step budget.", evidenceIds: [outcome.id], limits: { maxSteps: 20, maxAttemptsPerStep: 5, maxDurationMinutes: 240, maxContextItems: 10 } },
    { rationale: "Open repository access.", evidenceIds: [outcome.id], repositoryAccess: "job" },
  ]) {
    const rejected = await strategyService.propose("owner", value);
    assert.equal(rejected.strategy, null);
    assert.equal(rejected.decision?.reason, "LIMIT_EXPANSION");
  }
  const largerMemory = await strategyService.propose("owner", {
    rationale: "Read more evidence than the parent budget allows.",
    evidenceIds: [outcome.id],
    memorySelection: { maxEvidenceItems: 10 },
  });
  assert.equal(largerMemory.decision?.reason, "LIMIT_EXPANSION");
  assert.equal((await strategyService.list("owner")).length, 1);
  assert.deepEqual((await strategyService.active("owner")).config, active.config);

  const unchanged = await strategyService.propose("owner", {
    rationale: "Run steps one at a time without new permissions.",
    evidenceIds: [outcome.id],
    executionApproach: "sequential",
  });
  assert.equal(unchanged.strategy?.status, "candidate");
  assert.deepEqual(unchanged.strategy?.config.permissions, active.config.permissions);
  assert.deepEqual(unchanged.strategy?.config.limits, active.config.limits);
  await strategyService.compare("owner", unchanged.strategy!.id);
  const decision = await strategyService.promote("owner", unchanged.strategy!.id);
  assert.equal(decision.reason, "NO_IMPROVEMENT");
  assert.equal((await strategyService.active("owner")).id, active.id);
  assert.equal((await strategyService.get("owner", unchanged.strategy!.id)).status, "rejected");
});

test("runs keep their pinned strategy until an explicit migration", async () => {
  const { strategies, runs, strategyService, runService, seen } = services("saved/model");
  const first = await runService.create("owner", goal);
  assert.equal(first.strategyVersion, 1);
  assert.equal(first.model, "saved/model");
  const { candidate } = await improvedCandidate(strategyService);
  await assert.rejects(strategyService.migrateRun("owner", first.id, { strategyId: candidate.id, reason: "An unpromoted candidate cannot be pinned." }, runs), /retained strategy/);
  await strategyService.compare("owner", candidate.id);
  await strategyService.promote("owner", candidate.id);
  assert.equal((await runService.get("owner", first.id)).strategyVersion, 1);
  assert.equal((await runService.get("owner", first.id)).strategyId, first.strategyId);
  const second = await runService.create("owner", goal);
  assert.equal(second.strategyVersion, 2);
  assert.notEqual(second.strategyId, first.strategyId);
  const legacy = await runs.create("owner", runInput.parse(goal), "saved/model");
  assert.equal((await runService.get("owner", legacy.id)).strategyId, null);
  assert.equal((await runService.get("owner", legacy.id)).strategyVersion, null);
  const migration = await strategyService.migrateRun("owner", legacy.id, {
    strategyId: first.strategyId, reason: "Attach the original baseline without changing other runs.",
  }, runs);
  assert.equal(migration.migration.fromStrategyId, null);
  assert.equal(migration.migration.toVersion, 1);
  assert.equal((await runService.get("owner", legacy.id)).strategyId, first.strategyId);
  assert.equal((await runService.get("owner", first.id)).strategyVersion, 1);
  assert.equal((await strategyService.migrations("owner", legacy.id)).length, 1);
  await runService.plan("owner", first.id);
  assert.equal(seen[0]?.version, 1);
  assert.equal(seen[0]?.id, first.strategyId);
  const restarted = new RunService(runs, { plan: async () => plan }, { OPENCODE_MODEL: "changed/model" }, new StrategyService(strategies, "changed/model"));
  assert.equal((await restarted.get("owner", first.id)).strategyVersion, 1);
  assert.equal((await restarted.get("owner", second.id)).strategyVersion, 2);
  assert.equal((await restarted.get("owner", legacy.id)).strategyVersion, 1);
  assert.deepEqual((await restarted.get("owner", first.id)).limits, { maxSteps: 8, maxAttemptsPerStep: 3, maxDurationMinutes: 30 });
});

test("strategy records stay scoped to their owner", async () => {
  const { strategyService } = services();
  const { candidate } = await improvedCandidate(strategyService, "alice");
  await assert.rejects(strategyService.get("bob", candidate.id), /not found/);
  await assert.rejects(strategyService.compare("bob", candidate.id), /not found/);
  await assert.rejects(strategyService.promote("bob", candidate.id), /not found/);
  assert.deepEqual(await strategyService.list("bob"), []);
  assert.deepEqual(await strategyService.decisions("bob"), []);
});

test("planning keeps the pinned strategy and does not grant strategy tools", async () => {
  const calls: { path: string; body: { permission?: unknown; parts?: { text: string }[] } }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({ path, body: await request.json() });
    return path.endsWith("/message")
      ? Response.json({ info: {}, parts: [{ type: "text", text: JSON.stringify(plan) }] })
      : Response.json({ id: "planner-session" });
  };
  const strategy = baselineStrategy("owner", "recorded/model");
  strategy.config.permissions = { tools: ["bash"], repositoryAccess: "job" };
  strategy.config.memorySelection.maxEvidenceItems = 1;
  const search = {
    enabled: false,
    async evidence() {
      return [
        { id: "old", ownerId: "owner", kind: "run" as const, resourceId: "run", query: "stale evidence", retrievedAt: new Date("2020-01-01T00:00:00Z"), sources: [] },
        { id: "new", ownerId: "owner", kind: "run" as const, resourceId: "run", query: "newest evidence", retrievedAt: new Date("2020-01-02T00:00:00Z"), sources: [] },
      ];
    },
    async end() {},
    async start() { return { key: "k", token: "t" }; },
  } as unknown as SearchService;
  const planner = new OpenCodeRunPlanner({ OPENCODE_MODEL: "ignored/model" }, fetcher, search);
  const run = { id: "run", ownerId: "owner", model: "recorded/model", ...runInput.parse(goal), status: "planning", planningAttempts: 1, createdAt: new Date(), updatedAt: new Date() } as GoalRun;
  await planner.plan(run, strategy);
  assert.deepEqual(calls[0]?.body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
  const task = JSON.parse(calls[1]!.body.parts![0]!.text);
  assert.deepEqual(task.evidence, [{ id: "new", text: "newest evidence" }]);
  assert.equal(task.strategy.version, 1);
  assert.deepEqual(task.strategy.frozenPermissions, { tools: ["bash"], repositoryAccess: "job" });
  assert.deepEqual(task.limits, { maxSteps: 8, maxAttemptsPerStep: 3, maxDurationMinutes: 30 });
  assert.equal("ownerId" in task, false);
});

test("strategy HTTP routes isolate owners and preserve the active strategy", async () => {
  const { strategyService, runService } = services();
  const app = createChatApp(new MemoryChatStore(), new DemoChatProvider(), false, 3000, undefined, undefined, undefined, runService, undefined, strategyService);
  let cookie = "";
  const request = async (path: string, body?: unknown) => {
    const response = await app(new Request(`http://localhost:3000${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
    return response;
  };
  const created = await (await request("/api/runs", goal)).json();
  assert.equal(created.strategyVersion, 1);
  const active = await (await request("/api/strategies/active")).json();
  const outcome = await (await request("/api/strategies/outcomes", { ...failure, strategyId: active.id })).json();
  const proposed = await (await request("/api/strategies/proposals/from-outcomes", {})).json();
  assert.equal(proposed.strategy.evidenceIds[0], outcome.id);
  const compared = await (await request(`/api/strategies/${proposed.strategy.id}/compare`, {})).json();
  assert.deepEqual(compared.comparison.summary.candidate, improvedSummary);
  const decision = await (await request(`/api/strategies/${proposed.strategy.id}/promote`, {})).json();
  assert.equal(decision.action, "promoted");
  assert.equal((await (await request("/api/runs/" + created.id)).json()).strategyVersion, 1);
  const other = createChatApp(new MemoryChatStore(), new DemoChatProvider(), false, 3000, undefined, undefined, undefined, runService, undefined, strategyService);
  const hidden = await other(new Request(`http://localhost:3000/api/strategies/comparisons/${compared.comparison.id}`, { headers: { origin: "http://localhost:3000" } }));
  assert.equal(hidden.status, 404);
});

test("MongoDB strategy versions, decisions, and run pins survive reconnect", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const uri = process.env.MONGODB_TEST_URI!;
  const name = `journey_strategy_${crypto.randomUUID().replaceAll("-", "")}`;
  let client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const open = () => {
      const strategies = new MongoStrategyStore(client.db(name));
      const runs = new MongoRunStore(client.db(name).collection<GoalRun>("goal_runs"));
      return { strategies, runs, strategyService: new StrategyService(strategies, "saved/model") };
    };
    let { strategies, runs, strategyService } = open();
    await Promise.all([strategies.init(), runs.init()]);
    const legacy = await runs.create("owner", runInput.parse(goal), "saved/model");
    const { candidate } = await improvedCandidate(strategyService);
    await strategyService.compare("owner", candidate.id);
    const decision = await strategyService.promote("owner", candidate.id);
    const runService = new RunService(runs, { plan: async () => plan }, { OPENCODE_MODEL: "saved/model" }, strategyService);
    const pinned = await runService.create("owner", goal);
    assert.equal(pinned.strategyVersion, 2);
    await client.close();
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    ({ strategies, runs, strategyService } = open());
    await strategies.init();
    const restartedRuns = new RunService(runs, { plan: async () => plan }, { OPENCODE_MODEL: "changed/model" }, strategyService);
    assert.equal((await strategyService.active("owner")).id, candidate.id);
    assert.equal((await strategyService.decisions("owner"))[0]?.reason, "IMPROVEMENT");
    assert.deepEqual((await strategyService.comparison("owner", decision.comparisonId!)).comparison.summary.baseline, baselineSummary);
    assert.equal((await restartedRuns.get("owner", pinned.id)).strategyVersion, 2);
    assert.equal((await restartedRuns.get("owner", legacy.id)).strategyId, null);
    await strategyService.migrateRun("owner", legacy.id, { strategyId: (await strategyService.get("owner", candidate.id)).parentId, reason: "Explicit baseline backfill." }, runs);
    assert.equal((await restartedRuns.get("owner", legacy.id)).strategyVersion, 1);
    assert.equal((await strategyService.migrations("owner", legacy.id))[0]?.fromVersion, null);
  } finally {
    try { await client.db(name).dropDatabase(); } finally { await client.close(); }
  }
});
