import { randomUUID } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { connectDatabase } from "../db.js";
import { resolveOpenCodeModel } from "../opencode-model.js";
import { MongoSearchStore, type SearchTicket } from "./store.js";
import { SEARCH_TOOL, SearchService, searchInstructions } from "./service.js";
import { TavilyClient } from "./tavily.js";

async function main() {
  const tavily = new TavilyClient();
  if (!tavily.enabled) throw new Error("Add TAVILY_API_KEY to .env before running the live search smoke test.");
  const db = await connectDatabase();
  const store = new MongoSearchStore(db.database);
  const service = new SearchService(store, tavily);
  const scope = { ownerId: "search-smoke", kind: "chat" as const, resourceId: randomUUID() };
  const client = createOpencodeClient({ baseUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096", throwOnError: true,
    headers: process.env.OPENCODE_SERVER_PASSWORD ? { Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } : undefined });
  let sessionID: string | undefined, ticket: SearchTicket | undefined;
  try {
    await store.init();
    const signal = AbortSignal.timeout(90_000);
    const ids = await client.tool.ids({}, { signal });
    if (!ids.data?.includes(SEARCH_TOOL)) throw new Error("Restart OpenCode from this project so it loads tavily_search.");
    const session = await client.session.create({ title: "Journey Harness search smoke", permission: [
      { permission: "*", pattern: "*", action: "deny" }, { permission: SEARCH_TOOL, pattern: "*", action: "allow" },
    ] }, { signal });
    sessionID = session.data?.id;
    if (!sessionID) throw new Error("Could not create the smoke session.");
    ticket = await service.start(scope, sessionID);
    const result = await client.session.prompt({ sessionID, model: resolveOpenCodeModel().model,
      system: searchInstructions(true),
      parts: [{ type: "text", text: "Call tavily_search once with query 'MongoDB official documentation' and maxResults 2. Give a short answer citing one returned URL. If the tool fails, state the failure." }],
    }, { signal });
    const records = await service.evidence(scope);
    const sources = records.flatMap(record => record.sources);
    if (result.data?.info.error || !sources.length) throw new Error(records.find(record => record.error)?.error?.message || "The agent did not return saved search evidence. Check the key and shared MongoDB configuration on both services.");
    const answer = result.data?.parts.filter(part => part.type === "text").map(part => part.text).join("\n") || "";
    if (!sources.some(source => answer.includes(source.url))) throw new Error("Search worked but the agent did not cite a returned URL. Run the smoke test again.");
    console.log(`TAVILY_SEARCH_OK · ${sources.length} persisted sources · ${resolveOpenCodeModel().name}`);
  } finally {
    await service.end(ticket).catch(() => {});
    if (sessionID) {
      await client.session.abort({ sessionID }, { signal: AbortSignal.timeout(3000) }).catch(() => {});
      await client.session.delete({ sessionID }, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
    try {
      await db.database.collection("search_contexts").deleteOne({ key: `chat:${scope.resourceId}`, ownerId: scope.ownerId });
      await db.database.collection("search_evidence").deleteMany(scope);
    } finally { await db.client.close(); }
  }
}
main().catch(error => {
  // Provider/SDK errors may contain headers or connection strings; only print our safe messages.
  console.error(error instanceof Error && /^(Add TAVILY|Restart OpenCode|Could not create|The agent did not|Search worked|Tavily|The search)/.test(error.message)
    ? error.message : "Live search verification failed. Check .env, MongoDB, and the running OpenCode service.");
  process.exitCode = 1;
});
