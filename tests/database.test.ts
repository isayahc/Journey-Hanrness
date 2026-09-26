import assert from "node:assert/strict";
import test from "node:test";
import { connectDatabase, ensureIndexes } from "../src/db.js";
import { enqueueResearch, saveUser } from "../src/store.js";
import { StubResearchProvider } from "../src/research/provider.js";
import { MongoChatStore, type Conversation } from "../src/chat/store.js";
import { runOneJob } from "../src/research/worker.js";

// Only a dedicated, disposable test database is dropped.
test("MongoDB queue, persistence, deduplication, and failure flow", {
  skip: !process.env.MONGODB_TEST_URI,
}, async () => {
  process.env.MONGODB_URI = process.env.MONGODB_TEST_URI;
  process.env.MONGODB_DB = `journey_harness_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = await connectDatabase();
  try {
    await ensureIndexes(db);
    const chats = new MongoChatStore(db.database.collection<Conversation>("chat_conversations"));
    await chats.init();
    const chat = await chats.create("owner");
    assert.equal(await chats.append(chat, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]), true);
    assert.equal(await chats.append(chat, [{ role: "user", content: "stale" }]), false);
    const reopened = new MongoChatStore(db.database.collection<Conversation>("chat_conversations"));
    assert.equal((await reopened.get("owner", chat.id))?.messages.length, 2);
    assert.equal(await reopened.get("someone-else", chat.id), null);
    await saveUser(db, { userId: "test", displayName: "Test", interests: ["robotics"] });
    await assert.rejects(enqueueResearch(db, "missing"));
    await enqueueResearch(db, "test");
    await assert.rejects(enqueueResearch(db, "test"));
    const results = await Promise.all([
      runOneJob(db, new StubResearchProvider()), runOneJob(db, new StubResearchProvider()),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean)?.status, "completed");
    assert.equal((await db.profiles.findOne({ userId: "test" }))?.signals[0]?.description, "robotics");
    await enqueueResearch(db, "test");
    const failed = await runOneJob(db, {
      name: "stub", research: async () => { throw new Error("private provider detail"); },
    });
    assert.equal(failed?.status, "failed");
    const record = await db.jobs.findOne({ jobId: failed?.jobId });
    assert.equal(record?.errorCode, "RESEARCH_FAILED");
    assert.equal(JSON.stringify(record).includes("private provider detail"), false);
    assert.equal(await db.profiles.countDocuments({ userId: "test" }), 1);
  } finally {
    await db.database.dropDatabase();
    await db.client.close();
  }
});
