import type { Database } from "../db.js";
import { researchResult } from "../models.js";
import type { ResearchProvider } from "./provider.js";

export async function runOneJob(db: Database, provider: ResearchProvider) {
  const job = await db.jobs.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "running", startedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!job) return null;
  try {
    const user = await db.users.findOne({ userId: job.userId });
    if (!user) throw new Error("Platform user not found");
    const result = researchResult.parse(await provider.research(user));
    await db.profiles.updateOne({ userId: job.userId }, { $set: {
      ...result, userId: job.userId, jobId: job.jobId,
      provider: provider.name, status: "draft", updatedAt: new Date(),
    } }, { upsert: true });
    await db.jobs.updateOne({ jobId: job.jobId }, {
      $set: { status: "completed", finishedAt: new Date() },
    });
    return { jobId: job.jobId, status: "completed" as const };
  } catch {
    // Do not persist raw provider errors: they may contain credentials or source data.
    await db.jobs.updateOne({ jobId: job.jobId }, {
      $set: { status: "failed", finishedAt: new Date(), errorCode: "RESEARCH_FAILED" },
    });
    return { jobId: job.jobId, status: "failed" as const };
  }
}
