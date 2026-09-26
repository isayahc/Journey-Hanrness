import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { createChatApp, type AuthRuntime } from "../src/chat/app.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";
import { MemoryAuthStore } from "../src/auth/store.js";
import { InvalidPlanError, PLANNING_LEASE_MS, runInput, validatePlan, type GoalRun } from "../src/runs/models.js";
import { OpenCodeRunPlanner } from "../src/runs/planner.js";
import { RunRequestError, RunService } from "../src/runs/service.js";
import { MemoryRunStore, MongoRunStore, type RunStore } from "../src/runs/store.js";

const input = { goal: "Compare three battery suppliers", successCriteria: ["Three suppliers with cited specifications", "A comparison table"] };
const plan = { summary: "Research then compare the options", steps: [
  { id: "research", title: "Gather specifications", instruction: "Find official specifications for three suppliers", dependsOn: [], verification: "Three distinct suppliers each have a source URL" },
  { id: "compare", title: "Compare the suppliers", instruction: "Build a comparison table", dependsOn: ["research"], verification: "The table contains all three suppliers and cited specifications" },
] };

function appFor(service: RunService, auth?: AuthRuntime) {
  return createChatApp(new MemoryChatStore(), new DemoChatProvider(), false, 3000, auth, undefined, undefined, service);
}
function browser(app: ReturnType<typeof appFor>, initialCookie = "") {
  let cookie = initialCookie;
  return async (path: string, body?: unknown) => {
    const response = await app(new Request(`http://localhost:3000${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
    return response;
  };
}

test("goal API persists validated plans and isolates browser owners", async () => {
  const store = new MemoryRunStore();
  let calls = 0;
  const service = new RunService(store, { plan: async run => {
    calls++;
    assert.equal((await store.get(run.ownerId, run.id))?.status, "planning");
    return plan;
  } }, {});
  const app = appFor(service);
  const request = browser(app);
  const response = await request("/api/runs", input);
  assert.equal(response.status, 201);
  const run = await response.json();
  assert.equal(run.status, "draft");
  assert.equal(run.model, "opencode/space-bunny-free");
  assert.deepEqual(run.limits, { maxSteps: 8, maxAttemptsPerStep: 3, maxDurationMinutes: 30 });
  assert.equal(calls, 0);
  assert.equal("ownerId" in run, false);
  const planned = await (await request(`/api/runs/${run.id}/plan`, {})).json();
  assert.equal(planned.status, "planned");
  assert.deepEqual(planned.plan, plan);
  assert.equal(planned.canPlan, false);
  assert.equal("planningToken" in planned, false);
  assert.equal((await request(`/api/runs/${run.id}/plan`, {})).status, 200);
  assert.equal(calls, 1, "already planned runs must not invoke the model twice");
  assert.deepEqual((await (await request(`/api/runs/${run.id}`)).json()).plan, plan);
  assert.equal((await (await request("/api/runs")).json()).length, 1);
  const other = browser(app);
  assert.deepEqual(await (await other("/api/runs")).json(), []);
  assert.equal((await other(`/api/runs/${run.id}`)).status, 404);
  assert.equal((await other(`/api/runs/${run.id}/plan`, {})).status, 404);
});

test("goals require measurable criteria, bounded limits, valid JSON, and same-origin requests", async () => {
  const service = new RunService(new MemoryRunStore(), { plan: async () => plan }, {});
  const app = appFor(service);
  const request = browser(app);
  for (const value of [
    {}, { ...input, goal: " " }, { ...input, successCriteria: [] }, { ...input, successCriteria: [" "] },
    { ...input, successCriteria: ["a".repeat(501)] }, { ...input, limits: { maxSteps: 21 } },
    { ...input, limits: { maxAttemptsPerStep: 0 } }, { ...input, limits: { maxDurationMinutes: 241 } },
    { ...input, ownerId: "someone-else" }, { ...input, model: "override/in-request" },
  ]) assert.equal((await request("/api/runs", value)).status, 400);
  assert.equal((await app(new Request("http://localhost:3000/api/runs", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{",
  }))).status, 400);
  assert.equal((await app(new Request("http://localhost:3000/api/runs", {
    method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/json" }, body: JSON.stringify(input),
  }))).status, 403);
  assert.deepEqual(await service.list("someone-else"), []);
});

test("signed-in goal access follows account sessions and never anonymous owner cookies", async () => {
  const store = new MemoryAuthStore();
  const alice = await store.bindGitHubUser({ id: 11, login: "alice" });
  const bob = await store.bindGitHubUser({ id: 22, login: "bob" });
  const aSession = await store.createSession(alice.userId);
  const bSession = await store.createSession(bob.userId);
  const auth: AuthRuntime = { store, github: {
    authorizationUrl: () => "https://github.example/login", exchangeCode: async () => ({ id: 11, login: "alice" }),
  } };
  const service = new RunService(new MemoryRunStore(), { plan: async () => plan }, {});
  const app = appFor(service, auth);
  assert.equal((await browser(app)("/api/runs", input)).status, 401);
  const a = browser(app, `journey_session=${aSession.token}`);
  const b = browser(app, `journey_session=${bSession.token}; journey_owner=${alice.userId}`);
  const run = await (await a("/api/runs", input)).json();
  assert.equal((await b(`/api/runs/${run.id}`)).status, 404);
  assert.equal((await b(`/api/runs/${run.id}/plan`, {})).status, 404);
  await store.deleteSession(aSession.token);
  assert.equal((await a(`/api/runs/${run.id}`)).status, 401);
});

test("plan validation rejects incomplete, duplicate, circular, missing, and over-budget steps", () => {
  for (const value of [
    {}, { ...plan, steps: [] }, { ...plan, steps: [{ ...plan.steps[0], verification: " " }] },
    { ...plan, steps: [plan.steps[0], plan.steps[0]] },
    { ...plan, steps: [{ ...plan.steps[0], dependsOn: ["compare"] }, plan.steps[1]] },
    { ...plan, steps: [plan.steps[0], { ...plan.steps[1], dependsOn: ["missing"] }] },
    { ...plan, steps: [plan.steps[0], { ...plan.steps[1], dependsOn: ["research", "research"] }] },
    { ...plan, steps: [{ ...plan.steps[0], dependsOn: ["research"] }] },
  ]) assert.throws(() => validatePlan(value, 8), InvalidPlanError);
  assert.throws(() => validatePlan(plan, 1), /step limit/);
  assert.deepEqual(validatePlan(plan, 2), plan);
});

test("failed and invalid plans preserve goals, redact provider errors, and bound retries", async () => {
  const store = new MemoryRunStore();
  let calls = 0;
  const service = new RunService(store, { plan: async () => {
    calls++;
    if (calls === 1) throw new Error("secret provider credential");
    return { steps: [] };
  } }, { OPENCODE_MODEL: "custom/planner" });
  const run = await service.create("owner", input);
  let failed = await service.plan("owner", run.id);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.error?.code, "PLANNER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failed), /secret provider credential/);
  assert.equal(failed.goal, input.goal);
  assert.equal(failed.model, "custom/planner");
  failed = await service.plan("owner", run.id);
  assert.equal(failed.error?.code, "INVALID_PLAN");
  failed = await service.plan("owner", run.id);
  assert.equal(failed.planningAttempts, 3);
  assert.equal(failed.canPlan, false);
  await assert.rejects(service.plan("owner", run.id), error => error instanceof RunRequestError && error.status === 409);
  assert.equal(calls, 3);
});

test("a saved blocked goal can be successfully planned after a service restart", async () => {
  const store = new MemoryRunStore();
  const first = new RunService(store, { plan: async () => { throw new Error("offline"); } }, { OPENCODE_MODEL: "saved/model" });
  const run = await first.create("owner", input);
  await first.plan("owner", run.id);
  const restarted = new RunService(store, { plan: async saved => { assert.equal(saved.model, "saved/model"); return plan; } }, { OPENCODE_MODEL: "changed/model" });
  const result = await restarted.plan("owner", run.id);
  assert.equal(result.status, "planned");
  assert.equal(result.planningAttempts, 2);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.plan, plan);
});

test("concurrent planning requests invoke the model once", async () => {
  const store = new MemoryRunStore();
  let complete!: (value: unknown) => void;
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  const service = new RunService(store, { plan: () => { started(); return new Promise(resolve => { complete = resolve; }); } }, {});
  const run = await service.create("owner", input);
  const active = service.plan("owner", run.id);
  await didStart;
  await assert.rejects(service.plan("owner", run.id), /already in progress/);
  const visible = await service.get("owner", run.id);
  assert.equal(visible.status, "planning");
  assert.equal(visible.canPlan, false);
  assert.equal("planningToken" in visible, false);
  complete(plan);
  assert.equal((await active).status, "planned");
});

async function verifyClaims(store: RunStore) {
  await store.init();
  const run = await store.create("owner", runInput.parse(input), "opencode/space-bunny-free");
  const now = new Date();
  const claims = await Promise.all([store.claim("owner", run.id, now), store.claim("owner", run.id, now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  const later = new Date(now.getTime() + PLANNING_LEASE_MS + 1);
  assert.equal(await store.finish(first, { plan }, later), false, "an expired response cannot commit");
  assert.equal(await store.claim("someone-else", run.id, later), null);
  const second = await store.claim("owner", run.id, later);
  assert.ok(second);
  assert.notEqual(first.planningToken, second.planningToken);
  assert.equal(await store.finish(first, { plan }, later), false, "a stale response cannot overwrite a newer attempt");
  assert.equal(await store.finish(second, { plan }, later), true);
  assert.equal(await store.finish(second, { error: { code: "PLANNER_UNAVAILABLE", message: "late" } }, later), false);
  assert.equal(await store.claim("owner", run.id, later), null);
  return run.id;
}
test("planning leases allow interrupted attempts to be retried and reject stale results", async () => {
  await verifyClaims(new MemoryRunStore());
});

test("MongoDB goals and plans survive reconnects, with atomic claims and owner isolation", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const uri = process.env.MONGODB_TEST_URI!;
  const name = `journey_runs_${crypto.randomUUID().replaceAll("-", "")}`;
  let client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    let store = new MongoRunStore(client.db(name).collection<GoalRun>("goal_runs"));
    const id = await verifyClaims(store);
    const draft = await store.create("owner", runInput.parse(input), "saved/model");
    await client.close();
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    store = new MongoRunStore(client.db(name).collection<GoalRun>("goal_runs"));
    await store.init();
    assert.deepEqual((await store.get("owner", id))?.plan, plan);
    assert.equal((await store.get("owner", id))?.planningAttempts, 2);
    assert.equal((await store.get("owner", draft.id))?.model, "saved/model");
    assert.equal((await store.get("owner", draft.id))?.status, "draft");
    assert.equal((await store.list("owner")).length, 2);
    assert.equal(await store.get("someone-else", id), null);
    assert.deepEqual(await store.list("someone-else"), []);
  } finally {
    try { await client.db(name).dropDatabase(); } finally { await client.close(); }
  }
});

test("OpenCode planning uses the run's recorded model and denies tools", async () => {
  const calls: { path: string; body: any; auth: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({ path, body: await request.json(), auth: request.headers.get("authorization") });
    return path.endsWith("/message")
      ? Response.json({ info: {}, parts: [{ type: "text", text: JSON.stringify(plan) }] })
      : Response.json({ id: "planner-session" });
  };
  const planner = new OpenCodeRunPlanner({ OPENCODE_MODEL: "ignored/model", OPENCODE_SERVER_PASSWORD: "test-password" }, fetcher);
  const run = await new MemoryRunStore().create("owner", runInput.parse(input), "recorded/model");
  assert.deepEqual(await planner.plan(run), plan);
  assert.deepEqual(calls[0]?.body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
  assert.deepEqual(calls[1]?.body.model, { providerID: "recorded", modelID: "model" });
  assert.ok(calls[0]?.auth?.startsWith("Basic "));
  assert.match(calls[1]?.body.parts[0].text, /Three suppliers/);
  assert.doesNotMatch(calls[1]?.body.parts[0].text, /ownerId|planningToken/);
});

test("OpenCode malformed output becomes an actionable plan error", async () => {
  const planner = new OpenCodeRunPlanner({}, async (input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname.endsWith("/message")
      ? Response.json({ info: {}, parts: [{ type: "text", text: "I completed everything!" }] })
      : Response.json({ id: "planner-session" });
  });
  const run = await new MemoryRunStore().create("owner", runInput.parse(input), "opencode/space-bunny-free");
  await assert.rejects(planner.plan(run), /valid JSON/);
});
