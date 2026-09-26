import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import type { Event } from "@opencode-ai/sdk/v2";
import { activityFromEvent, recordActivity, MAX_CHAT_ACTIVITY, type ActivityUpdate } from "../src/chat/activity.js";
import { OpenCodeChatProvider } from "../src/chat/provider.js";
import { createChatApp } from "../src/chat/app.js";
import { MemoryChatStore, MongoChatStore, type ChatStore, type Conversation } from "../src/chat/store.js";
import { eventually } from "./helpers/chat-jobs.js";

const tool = (sessionID: string, status = "running", name = "webfetch"): Event => ({
  type: "message.part.updated", properties: { sessionID, part: { id: "part", sessionID, messageID: "message", type: "tool", callID: "call", tool: name,
    state: { status, input: { url: "https://user:password@example.org/private/token?key=secret", query: "private input" }, output: "secret result", error: "private error" } } },
} as unknown as Event);

test("activity exposes only scoped, allowlisted tool metadata and bounds/deduplicates history", () => {
  const calls = new Map<string, string>();
  assert.equal(activityFromEvent(tool("other"), "ours", calls), undefined);
  assert.equal(activityFromEvent(tool("ours", "running", "bash"), "ours", calls), undefined);
  const update = activityFromEvent(tool("ours"), "ours", calls)!;
  assert.deepEqual(update, { id: "call", label: "Reading example.org", status: "running" });
  assert.equal(activityFromEvent(tool("ours", "error"), "ours", calls)?.status, "failed");
  assert.equal(activityFromEvent({ type: "session.next.reasoning.delta", properties: { sessionID: "ours", delta: "private reasoning" } } as Event, "ours", calls), undefined);
  assert.equal(activityFromEvent({ type: "session.next.text.delta", properties: { sessionID: "ours", delta: '{"content":"unfinished response"}' } } as Event, "ours", calls), undefined);
  const legacy = tool("ours"); delete (legacy.properties as { sessionID?: string }).sessionID;
  assert.equal(activityFromEvent(legacy, "ours", calls)?.label, "Reading example.org");
  let history = recordActivity([], update);
  assert.equal(recordActivity(history, update), history);
  history = recordActivity(history, { ...update, status: "completed" });
  assert.equal(history.length, 1); assert.equal(history[0]!.status, "completed");
  for (let i = 0; i < 30; i++) history = recordActivity(history, { ...update, id: String(i) });
  assert.equal(history.length, MAX_CHAT_ACTIVITY);
  assert.doesNotMatch(JSON.stringify(history), /secret|private|password/);
});

test("OpenCode streams real tool lifecycle events before answering and closes its subscription", async () => {
  const updates: ActivityUpdate[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>, streamSignal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === "/event") {
      streamSignal = request.signal;
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; send({ type: "server.connected", properties: {} }); } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (path.endsWith("/message")) {
      send(tool("unrelated")); send(tool("session", "running", "tavily_search"));
      await gate;
      return Response.json({ info: {}, parts: [{ type: "text", text: "A sourced answer." }] });
    }
    return Response.json({ id: "session" });
  });
  const reply = provider.reply([{ role: "user", content: "Research this" }], undefined, undefined, undefined, { onActivity: update => updates.push(update) });
  try {
    await eventually(async () => updates, value => value.some(item => item.label === "Searching the web"));
    assert.equal(updates.some(item => item.label === "Reading example.org"), false);
    send({ type: "session.next.tool.called", properties: { sessionID: "session", callID: "fetch", tool: "webfetch", input: { url: "https://docs.example.org/path?token=private" } } });
    send({ type: "session.next.tool.success", properties: { sessionID: "session", callID: "fetch", content: [{ text: "private result" }] } });
    await eventually(async () => updates, value => value.some(item => item.id === "fetch" && item.status === "completed"));
    release(); assert.equal((await reply).content, "A sourced answer.");
    assert.equal(streamSignal?.aborted, true);
    assert.doesNotMatch(JSON.stringify(updates), /private|unrelated/);
  } finally { release(); await reply; }
});

test("an unavailable event feed does not block replies or expose provider errors", async () => {
  const updates: ActivityUpdate[] = [];
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === "/event") return new Response("private failure", { status: 503 });
    if (path.endsWith("/message")) return Response.json({ info: {}, parts: [{ type: "text", text: "Still answered." }] });
    return Response.json({ id: "session" });
  });
  assert.equal((await provider.reply([{ role: "user", content: "Hi" }], undefined, undefined, undefined, { onActivity: update => updates.push(update) })).content, "Still answered.");
  assert.ok(updates.some(item => item.id === "activity-unavailable"));
  assert.doesNotMatch(JSON.stringify(updates), /private failure/);
});

async function verifyActivityStore(store: ChatStore) {
  const chat = await store.create("alice"), id = crypto.randomUUID();
  await store.queueReply(chat, { role: "user", content: "Research", requestId: id });
  await store.startReply("alice", chat.id, id);
  const activity = recordActivity([], { id: "search", label: "Searching the web", status: "running" });
  await store.updateReplyActivity("other", chat.id, id, activity);
  await store.updateReplyActivity("alice", chat.id, "old-request", activity);
  assert.equal((await store.get("alice", chat.id))?.pendingReply?.activity, undefined);
  await store.updateReplyActivity("alice", chat.id, id, activity);
  assert.deepEqual((await store.get("alice", chat.id))?.pendingReply?.activity, activity);
  await store.failReply("alice", chat.id, id, "Reply stopped.", true);
  await store.updateReplyActivity("alice", chat.id, id, []);
  assert.deepEqual((await store.get("alice", chat.id))?.pendingReply?.activity, activity);
  await store.retryReply("alice", chat.id, id, "Research");
  assert.deepEqual((await store.get("alice", chat.id))?.pendingReply?.activity, []);
  await store.startReply("alice", chat.id, id);
  await store.updateReplyActivity("alice", chat.id, id, activity);
  await store.completeReply("alice", chat.id, id, { role: "assistant", content: "Done", activity });
  await store.updateReplyActivity("alice", chat.id, id, []);
  const saved = (await store.get("alice", chat.id))!;
  assert.equal(saved.pendingReply, undefined); assert.deepEqual(saved.messages.at(-1)?.activity, activity);
  return { chat, activity };
}
test("activity writes are owner/request scoped and cannot revive completed or cancelled replies", async () => { await verifyActivityStore(new MemoryChatStore()); });

test("MongoDB activity and timing survive reconnect, cancellation and completion", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  let client = await new MongoClient(process.env.MONGODB_TEST_URI!).connect();
  const name = `journey_activity_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const store = new MongoChatStore(client.db(name).collection<Conversation>("chats"));
    await store.init(); const { chat, activity } = await verifyActivityStore(store);
    const active = await store.create("alice"), id = crypto.randomUUID();
    await store.queueReply(active, { role: "user", content: "In progress", requestId: id });
    await store.startReply("alice", active.id, id); await store.updateReplyActivity("alice", active.id, id, activity);
    const before = (await store.get("alice", active.id))!.pendingReply!;
    await client.close(); client = await new MongoClient(process.env.MONGODB_TEST_URI!).connect();
    const reopened = new MongoChatStore(client.db(name).collection<Conversation>("chats"));
    assert.deepEqual((await reopened.get("alice", active.id))?.pendingReply, before);
    assert.deepEqual((await reopened.get("alice", chat.id))?.messages.at(-1)?.activity, activity);
    assert.equal(await reopened.get("other", active.id), null);
  } finally { await client.db(name).dropDatabase(); await client.close(); }
});

test("chat API persists public progress during a reply, then attaches it to the answer", async () => {
  const store = new MemoryChatStore(); let report!: (activity: ActivityUpdate) => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = createChatApp(store, { async reply(_messages, _id, _version, _scope, options) {
    report = options!.onActivity!; await gate; return { content: "Answer" };
  } }, true, 3000);
  const created = await app(new Request("http://localhost:3000/api/chats", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}" }));
  const chat = await created.json(), cookie = created.headers.get("set-cookie")!.split(";")[0]!;
  const request = (suffix: string, body?: object, authenticated = true) => app(new Request(`http://localhost:3000/api/chats/${chat.id}${suffix}`, {
    method: body ? "POST" : "GET", headers: { origin: "http://localhost:3000", ...(authenticated ? { cookie } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  try {
    assert.equal((await request("/messages", { content: "Research" })).status, 202);
    await eventually(async () => report, Boolean);
    report({ id: "search", label: "Searching the web", status: "running" });
    const progress = await eventually(async () => (await request("")).json(), value => value.pendingReply?.activity?.some((item: ActivityUpdate) => item.id === "search"));
    assert.ok(progress.pendingReply.startedAt); assert.equal((await request("", undefined, false)).status, 404);
    release();
    const answer = await eventually(async () => (await request("")).json(), value => !value.pendingReply);
    assert.equal(answer.messages.at(-1).activity.at(-1).label, "Searching the web");
    report({ id: "late", label: "Late event", status: "running" });
    assert.equal(JSON.stringify(await (await request("")).json()).includes("Late event"), false);
  } finally { release(); }
});
