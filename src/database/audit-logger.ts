import { Db, Collection } from 'mongodb';
import { getDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';

export interface AuditLogEntry {
  action: string;
  collection?: string;
  entityId?: string;
  insertedId?: any;
  filter?: any;
  update?: any;
  matchedCount?: number;
  modifiedCount?: number;
  deletedCount?: number;
  deletedPreview?: any[];
  document?: any;
  previousState?: any;
  newState?: any;
  reason?: string;
  userId?: string;
  projectId?: string;
  confirmationId?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

/**
 * Append-Only Audit Trail Logger
 * 
 * Provides an append-only interface for logging sensitive operational events,
 * data modifications, and security actions. Does NOT expose any update or delete
 * methods. Direct modification of the underlying audit_logs collection via
 * the DatabaseAdapter or tools is strictly rejected by the policy layer.
 */
export class AuditLogger {
  private dbInstance?: Db;

  constructor(db?: Db) {
    this.dbInstance = db;
  }

  private getCollection(): Collection<AuditLogEntry> {
    const db = this.dbInstance || getDatabase();
    return db.collection<AuditLogEntry>('audit_logs');
  }

  /**
   * Appends an immutable audit event to the audit trail.
   */
  public async logEvent(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<AuditLogEntry> {
    const record: AuditLogEntry = {
      ...entry,
      timestamp: new Date()
    };

    try {
      const col = this.getCollection();
      await col.insertOne(record as any);
      return record;
    } catch (err: any) {
      logger.error(`[AuditLogger] Failed to write audit event: ${err.message}`);
      throw err;
    }
  }

  /**
   * Retrieves recent audit events for inspection (Read-Only).
   */
  public async getRecentEvents(
    limit: number = 10,
    filter: { collection?: string; userId?: string; action?: string } = {}
  ): Promise<AuditLogEntry[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const col = this.getCollection();

    const query: Record<string, any> = {};
    if (filter.collection) query.collection = filter.collection;
    if (filter.userId) query.userId = filter.userId;
    if (filter.action) query.action = filter.action;

    return await col.find(query).sort({ timestamp: -1 }).limit(safeLimit).toArray();
  }
}

export const defaultAuditLogger = new AuditLogger();
