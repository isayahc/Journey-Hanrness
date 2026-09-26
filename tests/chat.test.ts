import assert from "node:assert/strict";
import test from "node:test";
import { createChatApp } from "../src/chat/app.js";
import { DemoChatProvider, OpenCodeChatError, OpenCodeChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";

function browser(app: ReturnType<typeof createChatApp>) {
  let cookie = "";
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
test("chat creates, sends, reloads history, and isolates browser owners", async () => {
  const app = createChatApp(new MemoryChatStore(), new DemoChatProvider(), true, 3000);
  const request = browser(app);
  const created = await (await request("/api/chats", {})).json();
  const reply = await request(`/api/chats/${created.id}/messages`, { content: "Hello" });
  assert.equal(reply.status, 200);
  const chat = await reply.json();
  assert.equal(chat.messages.length, 2);
  assert.match(chat.messages[1].content, /Demo response/);
  assert.equal((await (await request(`/api/chats/${created.id}`)).json()).messages.length, 2);
  assert.equal((await (await request('/api/chats')).json())[0].title, "Hello");
  assert.equal((await browser(app)(`/api/chats/${created.id}`)).status, 404);
});
test("failed replies preserve history and allow retry; input and origin are checked", async () => {
  const store = new MemoryChatStore();
  let fail = true;
  const app = createChatApp(store, { reply: async () => { if (fail) throw new Error("secret"); return { content: "OK" }; } }, false, 3000);
  const request = browser(app);
  const chat = await (await request('/api/chats', {})).json();
  const path = `/api/chats/${chat.id}/messages`;
  assert.equal((await request(path, { content: " " })).status, 400);
  assert.equal((await request(path, { content: "x".repeat(4001) })).status, 400);
  const error = await request(path, { content: "hello" });
  assert.equal(error.status, 502); assert.doesNotMatch(await error.text(), /secret/);
  assert.equal((await (await request(`/api/chats/${chat.id}`)).json()).messages.length, 0);
  fail = false;
  assert.equal((await request(path, { content: "retry" })).status, 200);
  assert.equal((await app(new Request('http://evil.test:3000/api/chats'))).status, 403);
  assert.equal((await app(new Request('http://localhost:3000/api/chats', {
    method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}',
  }))).status, 403);
});
test("chat persistence stores the OpenCode session mapping", async () => {
  const calls: (string | undefined)[] = [];
  const app = createChatApp(new MemoryChatStore(), {
    reply: async (_messages, sessionId) => {
      calls.push(sessionId);
      return { content: "OK", opencodeSessionId: sessionId || "session-for-chat", opencodeSessionVersion: 2 };
    },
  }, false, 3000);
  const request = browser(app);
  const chat = await (await request('/api/chats', {})).json();
  await request(`/api/chats/${chat.id}/messages`, { content: "first" });
  await request(`/api/chats/${chat.id}/messages`, { content: "second" });
  assert.deepEqual(calls, [undefined, "session-for-chat"]);
  assert.equal((await (await request(`/api/chats/${chat.id}`)).json()).opencodeSessionId, "session-for-chat");
});
test("OpenCode defaults to Space Bunny when OPENCODE_MODEL is unset", async () => {
  const calls: { path: string; body: any }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : null;
    calls.push({ path, body });
    if (path.endsWith("/message")) return Response.json({ info: {}, parts: [{ type: "text", text: "Default model reply" }] });
    return Response.json({ id: "session-default-model" });
  };
  const provider = new OpenCodeChatProvider({ OPENCODE_URL: "http://localhost:4096" }, fakeFetch);
  const reply = await provider.reply([{ role: "user", content: "Hello" }]);
  assert.equal(reply.content, "Default model reply");
  assert.deepEqual(calls.find(call => call.path.endsWith("/message"))?.body.model, {
    providerID: "opencode",
    modelID: "space-bunny-free",
  });
});

test("OpenCode surfaces sanitized model availability failures", async () => {
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/message")) {
      throw new Error("free usage exceeded: internal provider detail");
    }
    return Response.json({ id: "session-model-unavailable" });
  };
  const provider = new OpenCodeChatProvider({ OPENCODE_URL: "http://localhost:4096" }, fakeFetch);
  await assert.rejects(
    provider.reply([{ role: "user", content: "Hello" }]),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeChatError);
      assert.equal(error.kind, "model_unavailable");
      assert.match(error.message, /free usage limit/i);
      assert.doesNotMatch(error.message, /internal provider detail/i);
      return true;
    },
  );
});

test("chat surfaces safe OpenCode availability errors", async () => {
  const app = createChatApp(new MemoryChatStore(), {
    reply: async () => {
      throw new OpenCodeChatError(
        "The configured OpenCode model is temporarily unavailable or its free usage limit has been reached. Try again later or set OPENCODE_MODEL to another model you can access.",
        "model_unavailable",
      );
    },
  }, false, 3000);
  const request = browser(app);
  const chat = await (await request("/api/chats", {})).json();
  const response = await request(`/api/chats/${chat.id}/messages`, { content: "hello" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /free usage limit/i);
  assert.doesNotMatch(body.error, /MongoDB/i);
});

test("OpenCode maps a chat to one persistent session", async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ path, method: request.method, body });
    if (path.endsWith('/message')) return Response.json({ info: {}, parts: [{ type: 'text', text: 'Hello from model' }] });
    return Response.json({ id: 'session-test' });
  };
  const provider = new OpenCodeChatProvider({ OPENCODE_URL: 'http://localhost:4096', OPENCODE_MODEL: 'openai/test-model' }, fakeFetch);
  const first = await provider.reply([{ role: 'user', content: 'Hello' }]);
  assert.equal(first.content, 'Hello from model');
  assert.equal(first.opencodeSessionId, 'session-test');
  assert.deepEqual(calls[0]?.body.permission, [
    { permission: '*', pattern: '*', action: 'deny' },
    { permission: 'webfetch', pattern: '*', action: 'allow' },
  ]);
  assert.deepEqual(calls[1]?.body.model, { providerID: 'openai', modelID: 'test-model' });
  assert.match(calls[1]?.body.parts[0].text, /Hello/);
  const callCount = calls.length;
  const second = await provider.reply([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello from model' }, { role: 'user', content: 'Again' }], first.opencodeSessionId, first.opencodeSessionVersion);
  assert.equal(second.opencodeSessionId, 'session-test');
  assert.equal(calls.length, callCount + 1);
  assert.equal(calls.at(-1)?.path.endsWith('/message'), true);
  assert.equal(calls.at(-1)?.body.parts[0].text, JSON.stringify({ messages: [{ role: 'user', content: 'Again' }], evidence: [] }));
});

test("cancellation is owner-scoped, stops only the requested chat, and does not save a late reply", async () => {
  const calls = new Map<string, { signal: AbortSignal; finish: () => void }>();
  const app = createChatApp(new MemoryChatStore(), {
    reply: async (messages, _id, _version, _scope, options) => {
      await new Promise<void>(finish => calls.set(messages.at(-1)!.content, { signal: options!.signal!, finish }));
      return { content: "Late provider reply" };
    },
  }, false, 3000);
  const request = browser(app);
  const first = await (await request('/api/chats', {})).json();
  const second = await (await request('/api/chats', {})).json();
  const reply1 = request(`/api/chats/${first.id}/messages`, { content: 'first' });
  const reply2 = request(`/api/chats/${second.id}/messages`, { content: 'second' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await browser(app)(`/api/chats/${first.id}/cancel`, {})).status, 404);
  assert.equal(calls.get('first')!.signal.aborted, false);
  assert.equal((await request(`/api/chats/${first.id}/messages`, { content: 'duplicate' })).status, 409);
  assert.equal((await request(`/api/chats/${first.id}/cancel`, {})).status, 200);
  assert.equal(calls.get('first')!.signal.aborted, true);
  assert.equal(calls.get('second')!.signal.aborted, false);
  calls.get('first')!.finish();
  assert.equal((await (await reply1).json()).code, 'CHAT_CANCELLED');
  assert.equal((await (await request(`/api/chats/${first.id}`)).json()).messages.length, 0);
  calls.get('second')!.finish();
  assert.equal((await reply2).status, 200);
  assert.equal((await (await request(`/api/chats/${second.id}`)).json()).messages.length, 2);
  const retry = request(`/api/chats/${first.id}/messages`, { content: 'retry' });
  await new Promise(resolve => setImmediate(resolve));
  calls.get('retry')!.finish();
  assert.equal((await retry).status, 200, 'cancelled chat is unlocked after cleanup');
});

test("OpenCode cancellation aborts the remote session and repository context is included on every turn", async () => {
  const controller = new AbortController();
  const calls: { path: string; body: any }[] = [];
  let started!: () => void;
  const prompting = new Promise<void>(resolve => { started = resolve; });
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path, body });
    if (path.endsWith('/message')) {
      started();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
    if (path.endsWith('/abort')) return Response.json(true);
    return Response.json({ id: 'cancellable-session' });
  });
  const github = { status: 'connected' as const, total: 1, truncated: false, repositories: [
    { fullName: 'alice/project', defaultBranch: 'main', private: true, archived: false, agentEnabled: false, lastSyncedAt: '2026-09-26T17:00:00.000Z' },
  ] };
  const reply = provider.reply([{ role: 'user', content: 'Which repositories?' }], 'existing-session', 3, undefined, { signal: controller.signal, github });
  const rejected = assert.rejects(reply, error => error instanceof DOMException && error.name === 'AbortError');
  await prompting;
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await rejected;
  const prompt = calls.find(call => call.path.endsWith('/message'))!.body;
  assert.deepEqual(JSON.parse(prompt.parts[0].text).github, github);
  assert.match(prompt.system, /supersedes older repository lists/);
  assert.match(prompt.system, /does not give this chat repository file access/);
  assert.ok(calls.some(call => call.path === '/session/existing-session/abort'));
});
