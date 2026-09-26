import { createServer } from "node:http";
import { once } from "node:events";
import { createChatApp } from "../../src/chat/app.js";
import { MemoryChatStore } from "../../src/chat/store.js";
import type { ActivityUpdate } from "../../src/chat/activity.js";
import type { ChatReplyOptions } from "../../src/chat/provider.js";

/** Real HTTP/chat persistence with controllable external-agent activity. */
export async function activityFixture() {
  const replies = new Map<string, { options: ChatReplyOptions; finish: () => void; fail: () => void; update: (activity: ActivityUpdate) => void }>();
  const store = new MemoryChatStore();
  let calls = 0, app: ReturnType<typeof createChatApp>, base: string;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const response = await app(new Request(`${base}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; base = `http://127.0.0.1:${port}`;
  app = createChatApp(store, { async reply(messages, _session, _version, _scope, options) {
    calls++;
    return new Promise((resolve, reject) => {
      const content = messages.at(-1)!.content;
      replies.set(content, { options: options!, finish: () => resolve({ content: `Answer for ${content}` }), fail: () => reject(new Error("private failure")), update: activity => options!.onActivity?.(activity) });
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    });
  } }, true, port);
  return { base, replies, store, get calls() { return calls; }, async close() { for (const reply of replies.values()) reply.finish(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
