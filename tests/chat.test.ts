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
