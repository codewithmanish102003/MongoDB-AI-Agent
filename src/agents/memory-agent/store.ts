import { Db } from 'mongodb';
import { getDatabase } from '../../config/db.js';
import { logger } from '../../utils/logger.js';

export interface ChatMessage {
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
}

export interface UserMemoryItem {
  userId: string;
  key: string;
  value: string;
  category: string;
  updatedAt: Date;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  title: string;
  createdAt: Date;
  lastActive: Date;
  messageCount: number;
}

export class UnauthorizedSessionAccessError extends Error {
  constructor(userId: string, sessionId: string) {
    super(`User "${userId}" is not authorized to access session "${sessionId}".`);
    this.name = 'UnauthorizedSessionAccessError';
  }
}

export class MongoMemoryStore {
  private userId: string;
  private dbInstance?: Db;

  constructor(userId: string = 'default_user', db?: Db) {
    this.userId = userId;
    this.dbInstance = db;
  }

  private getDb(): Db {
    return this.dbInstance || getDatabase();
  }

  public async getOrCreateSession(sessionId?: string): Promise<SessionRecord> {
    const db = this.getDb();
    const sessionsCol = db.collection<SessionRecord>('sessions');

    const targetId = sessionId || `SESSION-${Date.now().toString().slice(-6)}`;
    const existing = await sessionsCol.findOne({ sessionId: targetId });

    if (existing) {
      // Enforce user isolation: User cannot hijack another user's session
      if (existing.userId !== this.userId && this.userId !== 'admin') {
        throw new UnauthorizedSessionAccessError(this.userId, targetId);
      }

      await sessionsCol.updateOne(
        { sessionId: targetId, userId: existing.userId },
        { $set: { lastActive: new Date() } }
      );
      return existing;
    }

    const newSession: SessionRecord = {
      sessionId: targetId,
      userId: this.userId,
      title: 'New Conversation',
      createdAt: new Date(),
      lastActive: new Date(),
      messageCount: 0
    };

    await sessionsCol.insertOne(newSession as any);
    return newSession;
  }

  public async saveMessage(sessionId: string, role: 'user' | 'assistant' | 'tool', content: string): Promise<void> {
    const db = this.getDb();
    const messagesCol = db.collection<ChatMessage>('chat_messages');
    const sessionsCol = db.collection<SessionRecord>('sessions');

    // Verify session ownership before writing message
    const session = await sessionsCol.findOne({ sessionId });
    if (session && session.userId !== this.userId && this.userId !== 'admin') {
      throw new UnauthorizedSessionAccessError(this.userId, sessionId);
    }

    await messagesCol.insertOne({
      sessionId,
      userId: this.userId,
      role,
      content,
      timestamp: new Date()
    });

    await sessionsCol.updateOne(
      { sessionId, userId: this.userId },
      {
        $inc: { messageCount: 1 },
        $set: { lastActive: new Date() }
      }
    );
  }

  public async getRecentMessages(sessionId: string, limit: number = 10): Promise<ChatMessage[]> {
    const db = this.getDb();
    const sessionsCol = db.collection<SessionRecord>('sessions');

    // Scoped strictly by sessionId AND userId
    const session = await sessionsCol.findOne({ sessionId });
    if (session && session.userId !== this.userId && this.userId !== 'admin') {
      throw new UnauthorizedSessionAccessError(this.userId, sessionId);
    }

    return await db
      .collection<ChatMessage>('chat_messages')
      .find({ sessionId, userId: this.userId })
      .sort({ timestamp: 1 })
      .limit(limit)
      .toArray();
  }

  public async saveUserFact(key: string, value: string, category: string = 'general'): Promise<void> {
    const db = this.getDb();
    const memoriesCol = db.collection<UserMemoryItem>('user_memories');

    await memoriesCol.updateOne(
      { userId: this.userId, key },
      {
        $set: {
          value,
          category,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    logger.tool('saveUserFact', `Memory Saved: [${category}] ${key} = "${value}"`);
  }

  public async getUserFacts(): Promise<UserMemoryItem[]> {
    const db = this.getDb();
    return await db
      .collection<UserMemoryItem>('user_memories')
      .find({ userId: this.userId })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  public async listSessions(): Promise<SessionRecord[]> {
    const db = this.getDb();
    return await db
      .collection<SessionRecord>('sessions')
      .find({ userId: this.userId })
      .sort({ lastActive: -1 })
      .limit(10)
      .toArray();
  }
}
