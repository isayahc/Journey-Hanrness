import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";

export interface Message { role: "user" | "assistant"; content: string }
export interface Conversation {
  id: string; ownerId: string; title: string; messages: Message[]; updatedAt: Date; version: number;
  opencodeSessionId?: string; opencodeSessionVersion?: 2;
}
export interface ChatStore {
  list(ownerId: string): Promise<Pick<Conversation, "id" | "title" | "updatedAt">[]>;
  get(ownerId: string, id: string): Promise<Conversation | null>;
  create(ownerId: string): Promise<Conversation>;
  append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: 2): Promise<boolean>;
}
const newChat = (ownerId: string): Conversation => ({
  id: randomUUID(), ownerId, title: "New conversation", messages: [], updatedAt: new Date(), version: 0,
});
export class MongoChatStore implements ChatStore {
  constructor(private collection: Collection<Conversation>) {}
  async init() {
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1, updatedAt: -1 });
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
  async append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: 2) {
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
  async append(chat: Conversation, messages: Message[], opencodeSessionId?: string, opencodeSessionVersion?: 2) {
    const current = this.chats.get(chat.id);
    if (!current || current.ownerId !== chat.ownerId || current.version !== chat.version) return false;
    current.title = current.messages.length ? current.title : messages[0]!.content.slice(0, 70);
    if (opencodeSessionId) current.opencodeSessionId = opencodeSessionId;
    if (opencodeSessionVersion) current.opencodeSessionVersion = opencodeSessionVersion;
    current.messages.push(...messages); current.version++; current.updatedAt = new Date();
    return true;
  }
}
