import type { Collection } from "mongodb";
import type { ScaffoldInput } from "../chat/execution.js";

export type AgentJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentJobAuthorization {
  jobId: string;
  userId: string;
  repositoryId: number;
  repositoryFullName?: string;
  defaultBranch?: string;
  baseSha?: string;
  branch?: string;
  request?: string;
  scaffold?: ScaffoldInput;
  chat?: { id: string; requestId: string };
  executionBackend?: "daytona";
  commitSha?: string;
  summary?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  checkpoint?: "workspace" | "scaffolded" | "modified" | "committed" | "push_pending" | "pushed" | "pr_pending" | "completed";
  sandbox?: {
    name: string;
    id?: string;
    state: "provisioning" | "running" | "stopped" | "deleted" | "cleanup_failed";
    updatedAt: Date;
    expiresAt: Date;
  };
  artifacts?: Array<{ kind: "diff" | "checks"; uri: string }>;
  executionLog?: Array<{ command: string; code: number; at: Date }>;
  leaseUntil?: Date;
  status: AgentJobStatus;
  checks?: Array<{ command: string; ok: boolean }>;
  failure?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CreateAgentJobInput {
  jobId: string;
  userId: string;
  repositoryId: number;
  repositoryFullName?: string;
  defaultBranch?: string;
  baseSha?: string;
  branch?: string;
  request?: string;
  scaffold?: ScaffoldInput;
  chat?: { id: string; requestId: string };
  executionBackend?: "daytona";
}

type AgentJobExecutionPatch = Partial<Pick<
  AgentJobAuthorization,
  | "checkpoint"
  | "sandbox"
  | "artifacts"
  | "executionLog"
  | "leaseUntil"
  | "commitSha"
  | "summary"
  | "pullRequestNumber"
  | "pullRequestUrl"
  | "checks"
  | "failure"
  | "startedAt"
  | "completedAt"
>>;

export interface AgentJobAuthorizationStore {
  init(): Promise<void>;
  listForUser(userId: string): Promise<AgentJobAuthorization[]>;
  claim(jobId: string, userId: string, leaseUntil: Date): Promise<AgentJobAuthorization | null>;
  create(jobId: string, userId: string, repositoryId: number, metadata?: Omit<CreateAgentJobInput, "jobId" | "userId" | "repositoryId">): Promise<AgentJobAuthorization>;
  get(jobId: string, userId: string): Promise<AgentJobAuthorization | null>;
  setStatus(jobId: string, userId: string, status: AgentJobStatus): Promise<AgentJobAuthorization | null>;
  updateExecution(jobId: string, userId: string, patch: AgentJobExecutionPatch): Promise<AgentJobAuthorization | null>;
  authorizeCredentialJob(userId: string, jobId: string, repositoryId: number): Promise<AgentJobAuthorization | null>;
}

export class MongoAgentJobAuthorizationStore implements AgentJobAuthorizationStore {
  constructor(private jobs: Collection<AgentJobAuthorization>) {}

  async init() {
    await Promise.all([
      this.jobs.createIndex({ jobId: 1 }, { unique: true }),
      this.jobs.createIndex({ userId: 1, repositoryId: 1, status: 1 }),
      this.jobs.createIndex({ userId: 1, createdAt: -1 }),
    ]);
  }

  /** Return the owner's latest jobs for the repository monitor. */
  async listForUser(userId: string): Promise<AgentJobAuthorization[]> {
    return this.jobs.find({ userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).limit(50).toArray();
  }

  /** Atomically excludes duplicate workers; a bounded lease permits restart recovery. */
  async claim(jobId: string, userId: string, leaseUntil: Date) {
    return this.jobs.findOneAndUpdate(
      { jobId, userId, status: { $in: ["queued", "running", "failed"] },
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
      { $set: { status: "running", leaseUntil, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  }

  async create(jobId: string, userId: string, repositoryId: number, metadata = {}) {
    const now = new Date();
    const job: AgentJobAuthorization = {
      jobId,
      userId,
      repositoryId,
      ...metadata,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.insertOne(job);
    return structuredClone(job);
  }

  async get(jobId: string, userId: string) {
    return this.jobs.findOne({ jobId, userId }, { projection: { _id: 0 } });
  }

  async setStatus(jobId: string, userId: string, status: AgentJobStatus) {
    return this.jobs.findOneAndUpdate(
      { jobId, userId },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  }

  async updateExecution(jobId: string, userId: string, patch: AgentJobExecutionPatch) {
    return this.jobs.findOneAndUpdate(
      { jobId, userId },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  }

  async authorizeCredentialJob(userId: string, jobId: string, repositoryId: number) {
    return this.jobs.findOne(
      {
        jobId,
        userId,
        repositoryId,
        status: { $in: ["queued", "running"] },
      },
      { projection: { _id: 0 } },
    );
  }
}

export class MemoryAgentJobAuthorizationStore implements AgentJobAuthorizationStore {
  private jobs = new Map<string, AgentJobAuthorization>();

  async init() {}

  /** Match the bounded, owner-scoped MongoDB history. */
  async listForUser(userId: string): Promise<AgentJobAuthorization[]> {
    return structuredClone([...this.jobs.values()].filter(job => job.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 50));
  }

  /** In-memory equivalent of the atomic MongoDB job claim. */
  async claim(jobId: string, userId: string, leaseUntil: Date) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId || !["queued", "running", "failed"].includes(job.status)
      || (job.leaseUntil && job.leaseUntil > new Date())) return null;
    const updated = { ...job, status: "running" as const, leaseUntil, updatedAt: new Date() };
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }

  async create(jobId: string, userId: string, repositoryId: number, metadata = {}) {
    if (this.jobs.has(jobId)) throw new Error("Agent job already exists");
    const now = new Date();
    const job: AgentJobAuthorization = {
      jobId,
      userId,
      repositoryId,
      ...metadata,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, job);
    return structuredClone(job);
  }

  async get(jobId: string, userId: string) {
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? structuredClone(job) : null;
  }

  async setStatus(jobId: string, userId: string, status: AgentJobStatus) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    const updated = { ...job, status, updatedAt: new Date() };
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }

  async updateExecution(jobId: string, userId: string, patch: AgentJobExecutionPatch) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    const updated = { ...job, ...structuredClone(patch), updatedAt: new Date() };
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }

  async authorizeCredentialJob(userId: string, jobId: string, repositoryId: number) {
    const job = this.jobs.get(jobId);
    return job
      && job.userId === userId
      && job.repositoryId === repositoryId
      && (job.status === "queued" || job.status === "running")
      ? structuredClone(job)
      : null;
  }
}
