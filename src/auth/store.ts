import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Collection } from "mongodb";
import type { PlatformUser } from "../models.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface GitHubProfile {
  id: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface GitHubIdentity {
  userId: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface OAuthState {
  stateHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthStore {
  init(): Promise<void>;
  bindGitHubUser(profile: GitHubProfile): Promise<GitHubIdentity>;
  createSession(userId: string): Promise<{ token: string; expiresAt: Date }>;
  resolveSession(token: string): Promise<GitHubIdentity | null>;
  deleteSession(token: string): Promise<void>;
  createOAuthState(): Promise<string>;
  consumeOAuthState(state: string, cookieState: string | undefined): Promise<boolean>;
}

function secret(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sameSecret(a: string, b: string | undefined) {
  if (!b) return false;
  const left = Buffer.from(hash(a), "hex");
  const right = Buffer.from(hash(b), "hex");
  return timingSafeEqual(left, right);
}

export class MongoAuthStore implements AuthStore {
  constructor(
    private users: Collection<PlatformUser>,
    private identities: Collection<GitHubIdentity>,
    private sessions: Collection<AuthSession>,
    private oauthStates: Collection<OAuthState>,
  ) {}

  async init() {
    await Promise.all([
      this.users.createIndex({ userId: 1 }, { unique: true }),
      this.identities.createIndex({ githubUserId: 1 }, { unique: true }),
      this.identities.createIndex({ userId: 1 }, { unique: true }),
      this.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.oauthStates.createIndex({ stateHash: 1 }, { unique: true }),
      this.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }

  async bindGitHubUser(profile: GitHubProfile) {
    const now = new Date();
    const userId = randomUUID();
    const identity = await this.identities.findOneAndUpdate(
      { githubUserId: profile.id },
      {
        $set: {
          githubLogin: profile.login,
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          updatedAt: now,
        },
        $setOnInsert: { userId, githubUserId: profile.id, createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!identity) throw new Error("Could not bind GitHub identity");
    await this.users.updateOne(
      { userId: identity.userId },
      {
        $setOnInsert: {
          userId: identity.userId,
          displayName: profile.name?.trim() || profile.login,
          headline: "",
          interests: [],
          publicLinks: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return identity;
  }

  async createSession(userId: string) {
    const token = secret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.sessions.insertOne({ tokenHash: hash(token), userId, createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  async resolveSession(token: string) {
    const session = await this.sessions.findOne({ tokenHash: hash(token), expiresAt: { $gt: new Date() } });
    if (!session) return null;
    return this.identities.findOne({ userId: session.userId });
  }

  async deleteSession(token: string) {
    await this.sessions.deleteOne({ tokenHash: hash(token) });
  }

  async createOAuthState() {
    const state = secret();
    const now = new Date();
    await this.oauthStates.insertOne({ stateHash: hash(state), createdAt: now, expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS) });
    return state;
  }

  async consumeOAuthState(state: string, cookieState: string | undefined) {
    if (!sameSecret(state, cookieState)) return false;
    const record = await this.oauthStates.findOneAndDelete({ stateHash: hash(state), expiresAt: { $gt: new Date() } });
    return record !== null;
  }
}

export class MemoryAuthStore implements AuthStore {
  private identities = new Map<number, GitHubIdentity>();
  private sessions = new Map<string, AuthSession>();
  private oauthStates = new Map<string, OAuthState>();

  async init() {}

  async bindGitHubUser(profile: GitHubProfile) {
    const now = new Date();
    const existing = this.identities.get(profile.id);
    const identity: GitHubIdentity = existing ? {
      ...existing,
      githubLogin: profile.login,
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      updatedAt: now,
    } : {
      userId: randomUUID(), githubUserId: profile.id, githubLogin: profile.login,
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      createdAt: now, updatedAt: now,
    };
    this.identities.set(profile.id, identity);
    return structuredClone(identity);
  }

  async createSession(userId: string) {
    const token = secret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.sessions.set(hash(token), { tokenHash: hash(token), userId, createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  async resolveSession(token: string) {
    const session = this.sessions.get(hash(token));
    if (!session || session.expiresAt <= new Date()) return null;
    const identity = [...this.identities.values()].find(item => item.userId === session.userId);
    return identity ? structuredClone(identity) : null;
  }

  async deleteSession(token: string) { this.sessions.delete(hash(token)); }

  async createOAuthState() {
    const state = secret();
    const now = new Date();
    this.oauthStates.set(hash(state), { stateHash: hash(state), createdAt: now, expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS) });
    return state;
  }

  async consumeOAuthState(state: string, cookieState: string | undefined) {
    if (!sameSecret(state, cookieState)) return false;
    const key = hash(state);
    const record = this.oauthStates.get(key);
    if (!record || record.expiresAt <= new Date()) return false;
    this.oauthStates.delete(key);
    return true;
  }
}
