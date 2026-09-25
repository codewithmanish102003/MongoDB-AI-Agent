import { DatabaseSchemaReport } from '../database/schema-inspector.js';

interface CacheEntry {
  report: DatabaseSchemaReport;
  expiresAt: number;
}

/**
 * In-Memory Schema Cache
 * 
 * Caches introspected database schemas per project to eliminate costly
 * repeated inspection passes during continuous multi-turn chat sessions.
 */
export class SchemaCache {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 15 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  public get(projectId: string): DatabaseSchemaReport | null {
    const entry = this.cache.get(projectId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(projectId);
      return null;
    }

    return entry.report;
  }

  public set(projectId: string, report: DatabaseSchemaReport, ttlMs?: number): void {
    const ttl = ttlMs || this.defaultTtlMs;
    this.cache.set(projectId, {
      report,
      expiresAt: Date.now() + ttl
    });
  }

  public invalidate(projectId: string): boolean {
    return this.cache.delete(projectId);
  }

  public clear(): void {
    this.cache.clear();
  }

  public get size(): number {
    return this.cache.size;
  }
}

export const schemaCache = new SchemaCache();
