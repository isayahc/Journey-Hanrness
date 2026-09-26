import type { Collection } from "mongodb";

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
  commitSha?: string;
  summary?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
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
}

type AgentJobExecutionPatch = Partial<Pick<
  AgentJobAuthorization,
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
