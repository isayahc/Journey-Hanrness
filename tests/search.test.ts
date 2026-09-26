import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { TavilyClient, SearchError } from "../src/search/tavily.js";
import { MemorySearchStore, MongoSearchStore, SEARCH_BUDGET, type SearchStore } from "../src/search/store.js";
import { SearchService } from "../src/search/service.js";
import { createSearchTool, searchRuntime } from "../src/search/tool.js";
import { createChatApp } from "../src/chat/app.js";
import { MemoryChatStore } from "../src/chat/store.js";
import { OpenCodeChatProvider } from "../src/chat/provider.js";
import { OpenCodeRunPlanner } from "../src/runs/planner.js";
import { RunService } from "../src/runs/service.js";
import { MemoryRunStore } from "../src/runs/store.js";
import { runInput } from "../src/runs/models.js";

const scope = { ownerId: "alice", kind: "run" as const, resourceId: "goal-1" };
const source = { title: "Official documentation", url: "https://example.com/docs", content: "A useful factual excerpt." };
const goodFetch: typeof fetch = async () => Response.json({ results: [source] });
function runtime(store: SearchStore = new MemorySearchStore(), fetcher: typeof fetch = goodFetch) {
  return new SearchService(store, new TavilyClient({ TAVILY_API_KEY: "test-key" }, fetcher));
}

test("Tavily uses authenticated bounded search, filters unsafe URLs, and truncates excerpts", async () => {
  let calls = 0;
  const client = new TavilyClient({ TAVILY_API_KEY: "private-key" }, async (input, init) => {
    calls++;
    assert.equal(input, "https://api.tavily.com/search");
    const request = new Request(input, init);
    assert.equal(request.headers.get("Authorization"), "Bearer private-key");
    const body = await request.json();
    assert.deepEqual(body, { query: "battery suppliers", max_results: 2, search_depth: "basic", topic: "general", auto_parameters: false,
      include_answer: false, include_raw_content: false, include_images: false });
    assert.equal(init?.redirect, "error");
    return Response.json({ results: [
      { ...source, url: "javascript:alert(1)" }, { ...source, url: "https://user:password@example.com" },
      { ...source, content: "x".repeat(6000), title: "a".repeat(300) }, source, source,
    ] });
  });
  const result = await client.search({ query: " battery suppliers ", maxResults: 2 });
  assert.equal(result.query, "battery suppliers");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0]?.excerpt.length, 1000);
  assert.equal(result.sources[0]?.title.length, 200);
  assert.ok(result.retrievedAt instanceof Date);
  assert.equal(calls, 1);
});

test("invalid search input and missing keys never call the provider", async () => {
  let calls = 0;
  const client = new TavilyClient({ TAVILY_API_KEY: "key" }, async () => { calls++; return Response.json({}); });
  for (const value of [{ query: " " }, { query: "x".repeat(401) }, { query: "ok", maxResults: 6 }, { query: "ok", url: "https://other.example" }]) {
    await assert.rejects(client.search(value), error => error instanceof SearchError && error.code === "INVALID_SEARCH");
  }
  await assert.rejects(new TavilyClient({}, goodFetch).search({ query: "test" }), /TAVILY_API_KEY/);
  assert.equal(calls, 0);
});

test("Tavily authentication, quota, network, timeout, and malformed responses are sanitized", async () => {
  for (const [status, code] of [[401, "SEARCH_AUTH_FAILED"], [403, "SEARCH_AUTH_FAILED"], [429, "SEARCH_LIMIT_REACHED"], [432, "SEARCH_LIMIT_REACHED"], [433, "SEARCH_LIMIT_REACHED"], [500, "SEARCH_PROVIDER_FAILED"]] as const) {
    const client = new TavilyClient({ TAVILY_API_KEY: "secret-key" }, async () => new Response("secret-key upstream details", { status }));
    await assert.rejects(client.search({ query: "test" }), error => {
      assert.ok(error instanceof SearchError); assert.equal(error.code, code); assert.doesNotMatch(error.message, /secret-key|upstream/); return true;
    });
  }
  const bad = new TavilyClient({ TAVILY_API_KEY: "key" }, async () => { throw new Error("secret network detail"); });
  await assert.rejects(bad.search({ query: "test" }), /unreachable or returned an invalid response/);
  await assert.rejects(new TavilyClient({ TAVILY_API_KEY: "key" }, async () => Response.json({ nope: true })).search({ query: "test" }), /invalid response/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bad.search({ query: "test" }, controller.signal), error => error instanceof SearchError && error.code === "SEARCH_TIMEOUT");
});

test("oversized responses are rejected before becoming evidence", async () => {
  const client = new TavilyClient({ TAVILY_API_KEY: "key" }, async () => new Response("x".repeat(512001)));
  await assert.rejects(client.search({ query: "test" }), error => error instanceof SearchError && error.code === "SEARCH_RESPONSE_TOO_LARGE");
});

test("search persists scoped evidence, errors, empty results, and an atomic budget across sessions", async () => {
  const store = new MemorySearchStore();
  const search = runtime(store);
  assert.equal((await search.execute("unknown", { query: "test" })).ok, false);
  const first = await search.start(scope, "session-one");
  const result = await search.execute("session-one", { query: "battery suppliers" });
  assert.equal(result.ok, true);
  assert.equal((await search.evidence(scope)).length, 1);
  assert.deepEqual(await search.evidence({ ...scope, ownerId: "bob" }), []);
  assert.deepEqual(await search.evidence({ ...scope, resourceId: "goal-2" }), []);
  const second = await search.start(scope, "session-two");
  await search.end(first); // A stale request must not revoke a newer binding.
  const results = await Promise.all(Array.from({ length: SEARCH_BUDGET + 5 }, () => search.execute("session-two", { query: "more evidence" })));
  assert.equal(results.filter(result => result.ok).length, SEARCH_BUDGET - 1);
  await search.end(second);
  await search.start(scope, "session-three");
  assert.equal((await search.execute("session-three", { query: "over budget" })).ok, false);
  assert.equal((await search.evidence(scope)).length, SEARCH_BUDGET);
  assert.doesNotMatch(JSON.stringify(await search.evidence(scope)), /ownerId|sessionId|token/);
  const expired = { ...scope, resourceId: "expired" };
  await store.bind(expired, "expired-session", new Date(Date.now() - 121000));
  assert.equal((await search.execute("expired-session", { query: "late" })).ok, false);

  const failed = runtime(store, async () => new Response("private", { status: 401 }));
  const another = { ...scope, resourceId: "failure" }; await failed.start(another, "failed-session");
  assert.equal((await failed.execute("failed-session", { query: "failure" })).error?.code, "SEARCH_AUTH_FAILED");
  assert.equal((await failed.evidence(another))[0]?.error?.code, "SEARCH_AUTH_FAILED");
  const empty = runtime(store, async () => Response.json({ results: [] }));
  await empty.start({ ...scope, resourceId: "empty" }, "empty-session");
  const noSources = await empty.execute("empty-session", { query: "nothing" });
  assert.equal(noSources.ok, true); assert.ok("message" in noSources && noSources.message?.includes("No usable sources"));
});

test("a failed evidence write is never reported as successful search", async () => {
  const store = new MemorySearchStore();
  store.save = async () => { throw new Error("private database connection string"); };
  const search = runtime(store); await search.start(scope, "session");
  const result = await search.execute("session", { query: "test" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SEARCH_STORAGE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /connection string|Official documentation/);
});

test("the OpenCode tool takes scope from trusted session context rather than model arguments", async () => {
  const search = runtime(); await search.start(scope, "session");
  const definition = createSearchTool(async () => search);
  const context = { sessionID: "session", messageID: "message", agent: "test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} };
  const result = JSON.parse(await definition.execute({ query: "test" }, context) as string);
  assert.equal(result.ok, true);
  const other = JSON.parse(await definition.execute({ query: "test" }, { ...context, sessionID: "unbound" }) as string);
  assert.equal(other.ok, false);
  assert.equal((await search.evidence(scope)).length, 1);
});

test("missing Tavily configuration does not connect to MongoDB or prevent tool loading", async () => {
  const previous = process.env.TAVILY_API_KEY;
  try {
    delete process.env.TAVILY_API_KEY;
    const service = await searchRuntime();
    const result = await service.execute("session", { query: "hello" });
    assert.equal(result.error?.code, "SEARCH_NOT_CONFIGURED");
  } finally { if (previous === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previous; }
});

test("chat invokes Tavily with persisted scope and exposes owner-scoped evidence", async () => {
  const search = runtime();
  const calls: { path: string; body?: any }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : undefined;
    calls.push({ path, body });
    if (path.endsWith("/tool/ids")) return Response.json(["tavily_search", "websearch", "webfetch"]);
    if (path.endsWith("/message")) {
      const evidence = await search.execute("chat-session", { query: "official information" });
      assert.equal(evidence.ok, true);
      return Response.json({ info: { structured: { content: "See https://example.com/docs for the sourced information.", execution: null } }, parts: [] });
    }
    return Response.json({ id: "chat-session" });
  };
  const app = createChatApp(new MemoryChatStore(), new OpenCodeChatProvider({}, fetcher, search), false, 3000, undefined, undefined, undefined, undefined, search);
  let cookie = "";
  async function request(path: string, body?: unknown, ownerCookie = cookie) {
    const response = await app(new Request(`http://localhost:3000${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { cookie: ownerCookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
    return response;
  }
  const chat = await (await request("/api/chats", {})).json();
  const response = await request(`/api/chats/${chat.id}/messages`, { content: "Find official information" });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.opencodeSessionVersion, 6);
  const permission = calls.find(call => call.path === "/session")?.body.permission;
  assert.ok(permission.some((item: any) => item.permission === "tavily_search" && item.action === "allow"));
  assert.equal(permission.some((item: any) => item.permission === "websearch" && item.action === "allow"), false);
  const sources = await (await request(`/api/chats/${chat.id}/evidence`)).json();
  assert.equal(sources[0].sources[0].url, source.url);
  assert.equal((await request(`/api/chats/${chat.id}/evidence`, undefined, "")).status, 404);
  assert.equal((await search.execute("chat-session", { query: "after request" })).ok, false);
});

test("legacy chat sessions migrate permissions and carry their saved transcript forward", async () => {
  let created = 0;
  let prompt: any;
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/message")) {
      prompt = await request.json(); return Response.json({ info: {}, parts: [{ type: "text", text: "I remember" }] });
    }
    created++; return Response.json({ id: "new-session" });
  });
  const messages = [{ role: "user" as const, content: "Remember this goal" }, { role: "assistant" as const, content: "Saved" }, { role: "user" as const, content: "Continue" }];
  const result = await provider.reply(messages, "legacy", 2);
  assert.equal(created, 1); assert.equal(result.opencodeSessionVersion, 3);
  assert.deepEqual(JSON.parse(prompt.parts[0].text).messages, messages);
  assert.match(prompt.system, /Web search is unavailable/);
});

test("goal planning can use Tavily evidence and retains it on a later planner failure", async () => {
  const search = runtime();
  const runStore = new MemoryRunStore();
  const planner = new OpenCodeRunPlanner({}, async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith("/tool/ids")) return Response.json(["tavily_search"]);
    if (path.endsWith("/message")) {
      const data = await request.json(); assert.deepEqual(data.model, { providerID: "opencode", modelID: "space-bunny-free" });
      assert.equal((await search.execute("goal-session", { query: "goal research" })).ok, true);
      return Response.json({ info: { error: { name: "APIError" } }, parts: [] });
    }
    return Response.json({ id: "goal-session" });
  }, search);
  const service = new RunService(runStore, planner, {});
  const run = await service.create("alice", { goal: "Find suppliers", successCriteria: ["Cite official documentation"] });
  const result = await service.plan("alice", run.id);
  assert.equal(result.status, "blocked");
  assert.equal((await search.evidence({ ownerId: "alice", kind: "run", resourceId: run.id })).length, 1);
  assert.equal((await search.execute("goal-session", { query: "after failure" })).ok, false);
  // A new service/process can read the stored evidence and planner receives it on retry.
  const retry = new OpenCodeRunPlanner({}, async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith("/tool/ids")) return Response.json(["tavily_search"]);
    if (path.endsWith("/message")) {
      const data = await request.json();
      assert.equal(JSON.parse(data.parts[0].text).evidence[0].sources[0].url, source.url);
      return Response.json({ info: {}, parts: [{ type: "text", text: JSON.stringify({ summary: "Use cited evidence", steps: [{ id: "review", title: "Review", instruction: "Review sources", dependsOn: [], verification: "All claims have citations" }] }) }] });
    }
    return Response.json({ id: "retry-session" });
  }, search);
  assert.equal((await new RunService(runStore, retry, {}).plan("alice", run.id)).status, "planned");
});

test("MongoDB search evidence and budgets survive reconnects without crossing owners", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const name = `journey_search_${crypto.randomUUID().replaceAll("-", "")}`;
  let client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    let store = new MongoSearchStore(client.db(name)); await store.init();
    let search = runtime(store); await search.start(scope, "session");
    const results = await Promise.all(Array.from({ length: 20 }, () => search.execute("session", { query: "bounded search" })));
    assert.equal(results.filter(result => result.ok).length, SEARCH_BUDGET);
    await client.close(); client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 }); await client.connect();
    store = new MongoSearchStore(client.db(name)); await store.init(); search = runtime(store);
    const ticket = await search.start(scope, "restarted-session");
    assert.equal((await search.execute("restarted-session", { query: "over budget" })).ok, false);
    assert.equal((await search.evidence(scope)).length, SEARCH_BUDGET);
    assert.deepEqual(await search.evidence({ ...scope, ownerId: "bob" }), []);
    await assert.rejects(search.start({ ...scope, ownerId: "bob" }, "intruder"));
    await search.end(ticket);
    assert.equal(await store.claim("restarted-session", new Date()), null);
  } finally { try { await client.db(name).dropDatabase(); } finally { await client.close(); } }
});
