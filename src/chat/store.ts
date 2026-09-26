import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type { ChatJobLink } from "./execution.js";
import { MAX_CHAT_ACTIVITY, type ChatActivity } from "./activity.js";

export interface Message { role: "user" | "assistant"; content: string; requestId?: string; job?: ChatJobLink; activity?: ChatActivity[] }
export type ChatSessionVersion = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type PendingReply = { requestId: string; content: string; status: "queued" | "running" | "failed" | "cancelled"; error?: string; startedAt?: string; activity?: ChatActivity[] };
export interface Conversation {
  id: string; ownerId: string; title: string; messages: Message[]; updatedAt: Date; version: number;
  opencodeSessionId?: string; opencodeSessionVersion?: ChatSessionVersion;
  pendingReply?: PendingReply;
}
export interface ChatStore {
  list(ownerId: string): Promise<Pick<Conversation, "id" | "title" | "updatedAt">[]>;
  get(ownerId: string, id: string): Promise<Conversation | null>;
  create(ownerId: string): Promise<Conversation>;
  append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion): Promise<boolean>;
  queueReply(chat: Conversation, message: Message): Promise<boolean>;
  retryReply(ownerId: string, chatId: string, requestId: string, content: string): Promise<boolean>;
  startReply(ownerId: string, chatId: string, requestId: string): Promise<Conversation | null>;
  updateReplyActivity(ownerId: string, chatId: string, requestId: string, activity: ChatActivity[]): Promise<void>;
  completeReply(ownerId: string, chatId: string, requestId: string, message: Message, opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion): Promise<boolean>;
  failReply(ownerId: string, chatId: string, requestId: string, error: string, cancelled?: boolean): Promise<void>;
  pendingReplies(): Promise<Conversation[]>;
  pendingJobs(): Promise<Conversation[]>;
  getByJob(ownerId: string, jobId: string): Promise<Conversation | null>;
  settleJob(ownerId: string, chatId: string, jobId: string, error?: string, cancelled?: boolean): Promise<void>;
}
const newChat = (ownerId: string): Conversation => ({
  id: randomUUID(), ownerId, title: "New conversation", messages: [], updatedAt: new Date(), version: 0,
});
export class MongoChatStore implements ChatStore {
  constructor(private collection: Collection<Conversation>) {}
  async init() {
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1, updatedAt: -1 });
    await this.collection.createIndex({ "messages.job.pending": 1 });
  }
  async list(ownerId: string) {
    return this.collection.find({ ownerId }, { projection: { _id: 0, id: 1, title: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 }).limit(50).toArray();
  }
  get(ownerId: string, id: string) { return this.collection.findOne({ ownerId, id }, { projection: { _id: 0 } }); }
  async create(ownerId: string) {
    const chat = newChat(ownerId);
    await this.collection.insertOne(chat);
    return chat;
  }
  async append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion) {
    const result = await this.collection.updateOne({ id: chat.id, ownerId: chat.ownerId, version: chat.version }, {
      $push: { messages: { $each: messages } },
      $set: {
        title: chat.messages.length ? chat.title : messages[0]!.content.slice(0, 70),
        updatedAt: new Date(),
        ...(opencodeSessionId ? { opencodeSessionId } : {}),
        ...(opencodeSessionVersion ? { opencodeSessionVersion } : {}),
      },
      $inc: { version: 1 },
    });
    return result.modifiedCount === 1;
  }
  async queueReply(chat: Conversation, message: Message) {
    const result = await this.collection.updateOne({ id: chat.id, ownerId: chat.ownerId, version: chat.version, $or: [{ pendingReply: { $exists: false } }, { "pendingReply.status": { $in: ["failed", "cancelled"] } }] }, {
      $push: { messages: message },
      $set: { pendingReply: { requestId: message.requestId!, content: message.content, status: "queued", startedAt: new Date().toISOString() }, updatedAt: new Date(), ...(chat.messages.length ? {} : { title: message.content.slice(0, 70) }) },
      $inc: { version: 1 },
    });
    return result.modifiedCount === 1;
  }
  async retryReply(ownerId: string, chatId: string, requestId: string, content: string) {
    const result = await this.collection.updateOne({ id: chatId, ownerId, "pendingReply.requestId": requestId, "pendingReply.status": { $in: ["failed", "cancelled"] } }, { $set: { "pendingReply.content": content, "pendingReply.status": "queued", "pendingReply.startedAt": new Date().toISOString(), "pendingReply.activity": [] }, $unset: { "pendingReply.error": "" }, $currentDate: { updatedAt: true } });
    return result.modifiedCount === 1;
  }
  async startReply(ownerId: string, chatId: string, requestId: string) {
    const result = await this.collection.findOneAndUpdate({ id: chatId, ownerId, "pendingReply.requestId": requestId, "pendingReply.status": { $in: ["queued", "running"] } }, { $set: { "pendingReply.status": "running" } }, { returnDocument: "after", projection: { _id: 0 } });
    return result || null;
  }
  async updateReplyActivity(ownerId: string, chatId: string, requestId: string, activity: ChatActivity[]) {
    await this.collection.updateOne({ id: chatId, ownerId, "pendingReply.requestId": requestId, "pendingReply.status": "running" },
      { $set: { "pendingReply.activity": activity.slice(-MAX_CHAT_ACTIVITY) } });
  }
  async completeReply(ownerId: string, chatId: string, requestId: string, message: Message, opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion) {
    const result = await this.collection.updateOne({ id: chatId, ownerId, "pendingReply.requestId": requestId, "pendingReply.status": "running" }, {
      $push: { messages: message }, $unset: { pendingReply: "" }, $set: { updatedAt: new Date(), ...(opencodeSessionId ? { opencodeSessionId } : {}), ...(opencodeSessionVersion ? { opencodeSessionVersion } : {}) }, $inc: { version: 1 },
    });
    return result.modifiedCount === 1;
  }
  async failReply(ownerId: string, chatId: string, requestId: string, error: string, cancelled = false) {
    await this.collection.updateOne({ id: chatId, ownerId, "pendingReply.requestId": requestId }, { $set: { "pendingReply.status": cancelled ? "cancelled" : "failed", "pendingReply.error": error, updatedAt: new Date() } });
  }
  pendingReplies() { return this.collection.find({ "pendingReply.status": { $in: ["queued", "running"] } }, { projection: { _id: 0 } }).limit(50).toArray(); }
  pendingJobs() {
    return this.collection.find({ "messages.job.pending": true }, { projection: { _id: 0 } }).limit(50).toArray();
  }
  getByJob(ownerId: string, jobId: string) {
    return this.collection.findOne({ ownerId, "messages.job.jobId": jobId }, { projection: { _id: 0 } });
  }
  async settleJob(ownerId: string, chatId: string, jobId: string, error?: string, cancelled = false) {
    await this.collection.updateOne({ id: chatId, ownerId, "messages.job.jobId": jobId }, {
      $set: { "messages.$.job.pending": false, ...(error ? { "messages.$.job.error": error } : {}), ...(cancelled ? { "messages.$.job.cancelled": true } : {}) },
    });
  }
}
export class MemoryChatStore implements ChatStore {
  private chats = new Map<string, Conversation>();
  async list(ownerId: string) {
    return [...this.chats.values()].filter(chat => chat.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 50)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }
  async get(ownerId: string, id: string) {
    const chat = this.chats.get(id);
    return chat?.ownerId === ownerId ? structuredClone(chat) : null;
  }
  async create(ownerId: string) {
    const chat = newChat(ownerId); this.chats.set(chat.id, chat); return structuredClone(chat);
  }
  async append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion) {
    const current = this.chats.get(chat.id);
    if (!current || current.ownerId !== chat.ownerId || current.version !== chat.version) return false;
    current.title = current.messages.length ? current.title : messages[0]!.content.slice(0, 70);
    if (opencodeSessionId) current.opencodeSessionId = opencodeSessionId;
    if (opencodeSessionVersion) current.opencodeSessionVersion = opencodeSessionVersion;
    current.messages.push(...messages); current.version++; current.updatedAt = new Date();
    return true;
  }
  async queueReply(chat: Conversation, message: Message) {
    const current = this.chats.get(chat.id);
    if (!current || current.ownerId !== chat.ownerId || current.version !== chat.version || (current.pendingReply && !["failed", "cancelled"].includes(current.pendingReply.status))) return false;
    current.title = current.messages.length ? current.title : message.content.slice(0, 70);
    if (!current.messages.some(item => item.requestId === message.requestId)) current.messages.push(message);
    current.pendingReply = { requestId: message.requestId!, content: message.content, status: "queued", startedAt: new Date().toISOString() }; current.version++; current.updatedAt = new Date();
    return true;
  }
  async retryReply(ownerId: string, chatId: string, requestId: string, content: string) {
    const current = this.chats.get(chatId);
    if (!current || current.ownerId !== ownerId || current.pendingReply?.requestId !== requestId || !["failed", "cancelled"].includes(current.pendingReply.status)) return false;
    current.pendingReply.content = content; current.pendingReply.status = "queued"; current.pendingReply.startedAt = new Date().toISOString(); current.pendingReply.activity = []; delete current.pendingReply.error; current.updatedAt = new Date();
    return true;
  }
  async startReply(ownerId: string, chatId: string, requestId: string) {
    const current = this.chats.get(chatId);
    if (!current || current.ownerId !== ownerId || current.pendingReply?.requestId !== requestId || !["queued", "running"].includes(current.pendingReply.status)) return null;
    current.pendingReply.status = "running";
    return structuredClone(current);
  }
  async updateReplyActivity(ownerId: string, chatId: string, requestId: string, activity: ChatActivity[]) {
    const current = this.chats.get(chatId);
    if (current?.ownerId === ownerId && current.pendingReply?.requestId === requestId && current.pendingReply.status === "running") {
      current.pendingReply.activity = structuredClone(activity.slice(-MAX_CHAT_ACTIVITY));
    }
  }
  async completeReply(ownerId: string, chatId: string, requestId: string, message: Message, opencodeSessionId?: string, opencodeSessionVersion?: ChatSessionVersion) {
    const current = this.chats.get(chatId);
    if (!current || current.ownerId !== ownerId || current.pendingReply?.requestId !== requestId || current.pendingReply.status !== "running") return false;
    current.messages.push(message); current.pendingReply = undefined; current.version++; current.updatedAt = new Date();
    if (opencodeSessionId) current.opencodeSessionId = opencodeSessionId;
    if (opencodeSessionVersion) current.opencodeSessionVersion = opencodeSessionVersion;
    return true;
  }
  async failReply(ownerId: string, chatId: string, requestId: string, error: string, cancelled = false) {
    const current = this.chats.get(chatId);
    if (current?.ownerId === ownerId && current.pendingReply?.requestId === requestId) { current.pendingReply.status = cancelled ? "cancelled" : "failed"; current.pendingReply.error = error; current.updatedAt = new Date(); }
  }
  async pendingReplies() { return structuredClone([...this.chats.values()].filter(chat => ["queued", "running"].includes(chat.pendingReply?.status || "")).slice(0, 50)); }
  async pendingJobs() {
    return structuredClone([...this.chats.values()].filter(chat => chat.messages.some(message => message.job?.pending)).slice(0, 50));
  }
  async getByJob(ownerId: string, jobId: string) {
    return structuredClone([...this.chats.values()].find(chat => chat.ownerId === ownerId && chat.messages.some(message => message.job?.jobId === jobId)) || null);
  }
  async settleJob(ownerId: string, chatId: string, jobId: string, error?: string, cancelled = false) {
    const chat = this.chats.get(chatId);
    if (chat?.ownerId !== ownerId) return;
    const link = chat.messages.find(message => message.job?.jobId === jobId)?.job;
    if (link) { link.pending = false; if (error) link.error = error; if (cancelled) link.cancelled = true; }
  }
}
