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

test("Mongo repository checkpoints and leases survive store restart and remain owner-scoped", {
  skip: !process.env.MONGODB_TEST_URI,
}, async () => {
  const { MongoClient } = await import("mongodb");
  const { MongoAgentJobAuthorizationStore } = await import("../src/agents/job-authorizations.js");
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_sandbox_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const collection = database.collection<import("../src/agents/job-authorizations.js").AgentJobAuthorization>("agent_jobs");
    const first = new MongoAgentJobAuthorizationStore(collection);
    await first.init();
    await first.create("job-1", "alice", 1);
    await first.updateExecution("job-1", "alice", { checkpoint: "modified", sandbox: {
      id: "sandbox-1", name: "journey-job-1", state: "stopped", updatedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    } });
    const second = new MongoAgentJobAuthorizationStore(collection);
    assert.equal((await second.get("job-1", "alice"))?.sandbox?.id, "sandbox-1");
    assert.equal((await second.get("job-1", "alice"))?.checkpoint, "modified");
    assert.equal(await second.get("job-1", "mallory"), null);
    assert.equal(await second.updateExecution("job-1", "mallory", { checkpoint: "completed" }), null);
    const lease = new Date(Date.now() + 60000);
    const claims = await Promise.all([first.claim("job-1", "alice", lease), second.claim("job-1", "alice", lease)]);
    assert.equal(claims.filter(Boolean).length, 1);
  } finally {
    await database.dropDatabase();
    await client.close();
  }
});

test("Mongo conversation outbox and job relationship recover across fresh stores without duplicate work", {
  skip: !process.env.MONGODB_TEST_URI,
}, async () => {
  const { MongoClient } = await import('mongodb');
  const { MongoAgentJobAuthorizationStore } = await import('../src/agents/job-authorizations.js');
  const { ChatJobService } = await import('../src/chat/jobs.js');
  const { chatJobsFixture, eventually } = await import('./helpers/chat-jobs.js');
  const client = await new MongoClient(process.env.MONGODB_TEST_URI!).connect();
  const database = client.db(`journey_chat_job_test_${crypto.randomUUID().replaceAll('-', '')}`);
  try {
    const collection = database.collection<Conversation>('chats');
    const chats = new MongoChatStore(collection);
    const jobCollection = database.collection<import('../src/agents/job-authorizations.js').AgentJobAuthorization>('jobs');
    const jobs = new MongoAgentJobAuthorizationStore(jobCollection);
    await chats.init(); await jobs.init();
    const f = await chatJobsFixture(chats, jobs);
    const service = new ChatJobService(chats, f.runtime), requestId = crypto.randomUUID();
    const link = await service.prepare(f.alice.userId, f.state.decision!);
    await chats.append(f.chat, [{ role: 'user', content: 'Build', requestId }, { role: 'assistant', content: 'Queued', requestId, job: link }]);
    const reopened = new MongoChatStore(collection), freshJobs = new MongoAgentJobAuthorizationStore(jobCollection);
    assert.equal(await reopened.getByJob('stranger', link.jobId), null);
    assert.equal((await reopened.getByJob(f.alice.userId, link.jobId))?.id, f.chat.id);
    const recovery = new ChatJobService(reopened, { ...f.runtime, jobStore: freshJobs });
    await Promise.all([recovery.recover(), service.recover()]);
    await eventually(() => freshJobs.get(link.jobId, f.alice.userId), job => job?.status === 'completed');
    await recovery.recover();
    assert.equal((await reopened.pendingJobs()).length, 0);
    const chat = (await reopened.get(f.alice.userId, f.chat.id))!;
    assert.equal(chat.messages[1]?.job?.jobId, link.jobId);
    assert.equal((await recovery.states(chat))[0]?.status, 'completed');
    assert.equal(await jobCollection.countDocuments(), 1); assert.equal(f.state.prs, 1);
    await reopened.settleJob('stranger', chat.id, link.jobId, 'injected error', true);
    assert.equal((await reopened.get(f.alice.userId, chat.id))?.messages[1]?.job?.error, undefined);
  } finally { await database.dropDatabase(); await client.close(); }
});
