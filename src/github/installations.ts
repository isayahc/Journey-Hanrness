import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Collection } from "mongodb";
import type { VerifiedGitHubInstallation } from "../auth/github.js";

const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

export type GitHubInstallationLifecycle = "active" | "suspended" | "deleted";

export interface GitHubInstallationLink {
  installationId: number;
  connectedByUserId: string;
  accountId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  active: boolean;
  suspended: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitHubInstallationState {
  stateHash: string;
  userId: string;
  installationId: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface GitHubInstallationStore {
  init(): Promise<void>;
  createVerificationState(userId: string, installationId: number): Promise<string>;
  consumeVerificationState(state: string, cookieState: string | undefined, userId: string): Promise<number | null>;
  linkInstallation(userId: string, installation: VerifiedGitHubInstallation): Promise<GitHubInstallationLink>;
  listForUser(userId: string): Promise<GitHubInstallationLink[]>;
  findByInstallationId(installationId: number): Promise<GitHubInstallationLink[]>;
  setInstallationState(installationId: number, state: GitHubInstallationLifecycle): Promise<void>;
}

function secret() { return randomBytes(32).toString("base64url"); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sameSecret(a: string, b: string | undefined) {
  if (!b) return false;
  return timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
}

export class MongoGitHubInstallationStore implements GitHubInstallationStore {
  constructor(
    private installations: Collection<GitHubInstallationLink>,
    private states: Collection<GitHubInstallationState>,
  ) {}

  async init() {
    await Promise.all([
      this.installations.createIndex({ connectedByUserId: 1, installationId: 1 }, { unique: true }),
      this.installations.createIndex({ connectedByUserId: 1, updatedAt: -1 }),
      this.installations.createIndex({ installationId: 1 }),
      this.states.createIndex({ stateHash: 1 }, { unique: true }),
      this.states.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }

  async createVerificationState(userId: string, installationId: number) {
    const state = secret();
    const now = new Date();
    await this.states.insertOne({
      stateHash: hash(state),
      userId,
      installationId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INSTALL_STATE_TTL_MS),
    });
    return state;
  }

  async consumeVerificationState(state: string, cookieState: string | undefined, userId: string) {
    if (!sameSecret(state, cookieState)) return null;
    const record = await this.states.findOneAndDelete({
      stateHash: hash(state),
      userId,
      expiresAt: { $gt: new Date() },
    });
    return record?.installationId ?? null;
  }

  async linkInstallation(userId: string, installation: VerifiedGitHubInstallation) {
    const now = new Date();
    const record = await this.installations.findOneAndUpdate(
      { connectedByUserId: userId, installationId: installation.installationId },
      {
        $set: {
          accountId: installation.accountId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          permissions: installation.permissions,
          active: true,
          suspended: false,
          updatedAt: now,
        },
        $setOnInsert: { connectedByUserId: userId, installationId: installation.installationId, createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!record) throw new Error("Could not save GitHub installation");
    return record;
  }

  async listForUser(userId: string) {
    return this.installations.find(
      { connectedByUserId: userId, active: { $ne: false }, suspended: { $ne: true } },
      { projection: { _id: 0 } },
    ).sort({ updatedAt: -1 }).toArray();
  }

  async findByInstallationId(installationId: number) {
    return this.installations.find(
      { installationId },
      { projection: { _id: 0 } },
    ).toArray();
  }

  async setInstallationState(installationId: number, state: GitHubInstallationLifecycle) {
    const now = new Date();
    if (state === "active") {
      await this.installations.updateMany(
        { installationId },
        { $set: { active: true, suspended: false, updatedAt: now } },
      );
    } else if (state === "suspended") {
      await this.installations.updateMany(
        { installationId },
        { $set: { active: true, suspended: true, updatedAt: now } },
      );
    } else {
      await this.installations.updateMany(
        { installationId },
        { $set: { active: false, suspended: false, updatedAt: now } },
      );
    }
  }
}

export class MemoryGitHubInstallationStore implements GitHubInstallationStore {
  private installations = new Map<string, GitHubInstallationLink>();
  private states = new Map<string, GitHubInstallationState>();

  async init() {}

  async createVerificationState(userId: string, installationId: number) {
    const state = secret();
    const now = new Date();
    this.states.set(hash(state), {
      stateHash: hash(state), userId, installationId, createdAt: now,
      expiresAt: new Date(now.getTime() + INSTALL_STATE_TTL_MS),
    });
    return state;
  }

  async consumeVerificationState(state: string, cookieState: string | undefined, userId: string) {
    if (!sameSecret(state, cookieState)) return null;
    const key = hash(state);
    const record = this.states.get(key);
    if (!record || record.userId !== userId || record.expiresAt <= new Date()) return null;
    this.states.delete(key);
    return record.installationId;
  }

  async linkInstallation(userId: string, installation: VerifiedGitHubInstallation) {
    const key = `${userId}:${installation.installationId}`;
    const existing = this.installations.get(key);
    const now = new Date();
    const record: GitHubInstallationLink = {
      installationId: installation.installationId,
      connectedByUserId: userId,
      accountId: installation.accountId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      permissions: structuredClone(installation.permissions),
      active: true,
      suspended: false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.installations.set(key, record);
    return structuredClone(record);
  }

  async listForUser(userId: string) {
    return [...this.installations.values()]
      .filter(item => item.connectedByUserId === userId && item.active !== false && item.suspended !== true)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(item => structuredClone(item));
  }

  async findByInstallationId(installationId: number) {
    return [...this.installations.values()]
      .filter(item => item.installationId === installationId)
      .map(item => structuredClone(item));
  }

  async setInstallationState(installationId: number, state: GitHubInstallationLifecycle) {
    const now = new Date();
    for (const [key, installation] of this.installations) {
      if (installation.installationId !== installationId) continue;
      this.installations.set(key, {
        ...installation,
        active: state !== "deleted",
        suspended: state === "suspended",
        updatedAt: now,
      });
    }
  }
}
