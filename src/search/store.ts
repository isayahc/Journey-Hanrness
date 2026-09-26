import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { SearchSource } from "./tavily.js";

export const SEARCH_BUDGET = 10;
export interface SearchScope { ownerId: string; kind: "chat" | "run"; resourceId: string }
export interface SearchContext extends SearchScope {
  key: string; used: number; sessionId?: string; token?: string; expiresAt?: Date;
}
export interface SearchEvidence extends SearchScope {
  id: string; query: string; retrievedAt: Date; sources: SearchSource[];
  error?: { code: string; message: string };
}
export interface SearchTicket { key: string; token: string }
export interface SearchStore {
  init(): Promise<void>;
  bind(scope: SearchScope, sessionId: string, now: Date): Promise<SearchTicket>;
  release(ticket: SearchTicket): Promise<void>;
  claim(sessionId: string, now: Date): Promise<SearchContext | null>;
  save(record: SearchEvidence): Promise<void>;
  list(scope: SearchScope): Promise<SearchEvidence[]>;
}
const scopeKey = (scope: SearchScope) => `${scope.kind}:${scope.resourceId}`;

export class MongoSearchStore implements SearchStore {
  private contexts: Collection<SearchContext>;
  private evidence: Collection<SearchEvidence>;
  constructor(db: Db) {
    this.contexts = db.collection<SearchContext>("search_contexts");
    this.evidence = db.collection<SearchEvidence>("search_evidence");
  }
  async init() {
    await this.contexts.createIndex({ key: 1 }, { unique: true });
    await this.contexts.createIndex({ sessionId: 1 }, { unique: true, partialFilterExpression: { sessionId: { $type: "string" } } });
    await this.evidence.createIndex({ id: 1 }, { unique: true });
    await this.evidence.createIndex({ ownerId: 1, kind: 1, resourceId: 1, retrievedAt: -1 });
  }
  async bind(scope: SearchScope, sessionId: string, now: Date) {
    const key = scopeKey(scope), token = randomUUID();
    await this.contexts.updateOne({ key, ownerId: scope.ownerId }, {
      $setOnInsert: { ...scope, key, used: 0 },
      $set: { sessionId, token, expiresAt: new Date(now.getTime() + 120_000) },
    }, { upsert: true });
    return { key, token };
  }
  async release(ticket: SearchTicket) {
    await this.contexts.updateOne(ticket, { $unset: { sessionId: "", token: "", expiresAt: "" } });
  }
  claim(sessionId: string, now: Date) {
    return this.contexts.findOneAndUpdate({ sessionId, expiresAt: { $gt: now }, used: { $lt: SEARCH_BUDGET } },
      { $inc: { used: 1 } }, { returnDocument: "after", projection: { _id: 0 } });
  }
  async save(record: SearchEvidence) { await this.evidence.insertOne({ ...record }); }
  list(scope: SearchScope) {
    return this.evidence.find(scope, { projection: { _id: 0 } }).sort({ retrievedAt: -1 }).limit(SEARCH_BUDGET).toArray();
  }
}

export class MemorySearchStore implements SearchStore {
  private contexts = new Map<string, SearchContext>();
  private evidence: SearchEvidence[] = [];
  async init() {}
  async bind(scope: SearchScope, sessionId: string, now: Date) {
    const key = scopeKey(scope), token = randomUUID();
    const previous = this.contexts.get(key);
    if (previous && previous.ownerId !== scope.ownerId) throw new Error("Search owner mismatch");
    if ([...this.contexts.values()].some(item => item.key !== key && item.sessionId === sessionId)) throw new Error("Search session already bound");
    this.contexts.set(key, { ...scope, key, token, sessionId, used: previous?.used ?? 0, expiresAt: new Date(now.getTime() + 120_000) });
    return { key, token };
  }
  async release(ticket: SearchTicket) {
    const item = this.contexts.get(ticket.key);
    if (item?.token === ticket.token) { delete item.sessionId; delete item.token; delete item.expiresAt; }
  }
  async claim(sessionId: string, now: Date) {
    const item = [...this.contexts.values()].find(item => item.sessionId === sessionId);
    if (!item || !item.expiresAt || item.expiresAt <= now || item.used >= SEARCH_BUDGET) return null;
    item.used++;
    return structuredClone(item);
  }
  async save(record: SearchEvidence) { this.evidence.push(structuredClone(record)); }
  async list(scope: SearchScope) {
    return structuredClone(this.evidence.filter(item => item.ownerId === scope.ownerId && item.kind === scope.kind && item.resourceId === scope.resourceId)
      .sort((a, b) => b.retrievedAt.getTime() - a.retrievedAt.getTime()).slice(0, SEARCH_BUDGET));
  }
}
