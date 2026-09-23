import { getDatabase } from '../../config/db.js';
import { logger } from '../../utils/logger.js';

export interface ChatMessage {
  sessionId: string;
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

export class MongoMemoryStore {
  private userId: string;

  constructor(userId: string = 'default_user') {
    this.userId = userId;
  }

  public async getOrCreateSession(sessionId?: string): Promise<SessionRecord> {
    const db = getDatabase();
    const sessionsCol = db.collection<SessionRecord>('sessions');

    const targetId = sessionId || `SESSION-${Date.now().toString().slice(-6)}`;
    const existing = await sessionsCol.findOne({ sessionId: targetId });

    if (existing) {
      await sessionsCol.updateOne({ sessionId: targetId }, { $set: { lastActive: new Date() } });
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

  public async saveMessage(sessionId: string, role: 'user' | 'assistant' | 'tool', content: string) {
    const db = getDatabase();
    const messagesCol = db.collection<ChatMessage>('chat_messages');
    const sessionsCol = db.collection<SessionRecord>('sessions');

    await messagesCol.insertOne({
      sessionId,
      role,
      content,
      timestamp: new Date()
    });

    await sessionsCol.updateOne(
      { sessionId },
      {
        $inc: { messageCount: 1 },
        $set: { lastActive: new Date() }
      }
    );
  }

  public async getRecentMessages(sessionId: string, limit: number = 10): Promise<ChatMessage[]> {
    const db = getDatabase();
    return await db
      .collection<ChatMessage>('chat_messages')
      .find({ sessionId })
      .sort({ timestamp: 1 })
      .limit(limit)
      .toArray();
  }

  public async saveUserFact(key: string, value: string, category: string = 'general'): Promise<void> {
    const db = getDatabase();
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
    const db = getDatabase();
    return await db
      .collection<UserMemoryItem>('user_memories')
      .find({ userId: this.userId })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  public async listSessions(): Promise<SessionRecord[]> {
    const db = getDatabase();
    return await db
      .collection<SessionRecord>('sessions')
      .find({ userId: this.userId })
      .sort({ lastActive: -1 })
      .limit(10)
      .toArray();
  }
}
