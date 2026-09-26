import { connectDatabase, ensureIndexes } from "./db.js";
import { enqueueResearch, saveUser } from "./store.js";
import { createProvider } from "./research/provider.js";
import { runOneJob } from "./research/worker.js";

async function main() {
  const command = process.argv[2];
  if (!["init", "demo", "worker", "profiles"].includes(command || "")) {
    throw new Error("Expected init, demo, worker, or profiles");
  }
  const db = await connectDatabase();
  try {
    await ensureIndexes(db);
    if (command === "init") console.log("MongoDB collections and indexes ready.");
    if (command === "demo") {
      await saveUser(db, {
        userId: "demo-user", displayName: "Demo User (fictional)",
        headline: "Building a sample project", interests: ["hardware design", "startup collaboration"],
      });
      console.log(await enqueueResearch(db, "demo-user"));
    }
    if (command === "worker") {
      const provider = createProvider();
      if (provider.name === "opencode") throw new Error("OpenCode adapter is a placeholder. Set RESEARCH_PROVIDER=stub.");
      const result = await runOneJob(db, provider);
      console.log(result || "No queued jobs.");
      if (result?.status === "failed") process.exitCode = 1;
    }
    if (command === "profiles") {
      console.log(JSON.stringify(await db.profiles.find({}, { projection: { _id: 0 } }).limit(20).toArray(), null, 2));
    }
  } finally {
    await db.client.close();
  }
}
main().catch((error) => {
  console.error("[cli] failed", error instanceof Error ? error.message : String(error));
  console.error("Command failed. Check MONGODB_URI, MongoDB connectivity, .env, and pending jobs.");
  process.exitCode = 1;
});
