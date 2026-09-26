import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { userInput } from "./models.js";

export async function saveUser(db: Database, input: unknown) {
  const user = userInput.parse(input);
  const now = new Date();
  await db.users.updateOne({ userId: user.userId }, {
    $set: { ...user, updatedAt: now }, $setOnInsert: { createdAt: now },
  }, { upsert: true });
  return user;
}

export async function enqueueResearch(db: Database, userId: string) {
  if (!await db.users.findOne({ userId })) throw new Error("Platform user not found");
  const job = { jobId: randomUUID(), userId, status: "queued" as const, createdAt: new Date() };
  await db.jobs.insertOne(job);
  return job;
}
