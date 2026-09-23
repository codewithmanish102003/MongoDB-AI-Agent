import { MongoClient, Db } from 'mongodb';
import { logger } from '../utils/logger.js';

/**
 * Server-Side MongoDB Connection Pool Manager
 * 
 * Manages active MongoClient instances keyed by connection URI.
 * Reuses existing connection pools across databases on the same host/cluster.
 * Keeps connection strings and credentials strictly server-side.
 */
export class ConnectionManager {
  private clientPool: Map<string, MongoClient> = new Map();

  /**
   * Normalizes connection URI to ensure consistent pooling key
   */
  private normalizeUri(uri: string): string {
    return uri.trim();
  }

  /**
   * Resolves or creates a MongoClient for the given connection URI.
   * Credentials remain strictly in server memory.
   */
  public async getClient(connectionUri: string): Promise<MongoClient> {
    const key = this.normalizeUri(connectionUri);

    if (this.clientPool.has(key)) {
      return this.clientPool.get(key)!;
    }

    // Mask credentials for safe logging
    const maskedUri = key.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
    logger.info(`[ConnectionManager] Creating new connection pool for: ${maskedUri}`);

    try {
      const client = new MongoClient(key, {
        maxPoolSize: 20,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000
      });

      await client.connect();
      this.clientPool.set(key, client);
      return client;
    } catch (err: any) {
      logger.error(`[ConnectionManager] Failed to connect to MongoDB: ${err.message}`);
      throw err;
    }
  }

  /**
   * Resolves a target Db instance for the specified connection and database.
   */
  public async getConnection(connectionUri: string, databaseName: string): Promise<Db> {
    const client = await this.getClient(connectionUri);
    return client.db(databaseName);
  }

  /**
   * Closes a specific connection pool by URI.
   */
  public async closeConnection(connectionUri: string): Promise<void> {
    const key = this.normalizeUri(connectionUri);
    const client = this.clientPool.get(key);
    if (client) {
      await client.close();
      this.clientPool.delete(key);
      logger.info(`[ConnectionManager] Closed connection pool for URI.`);
    }
  }

  /**
   * Closes all active connection pools gracefully.
   */
  public async closeAll(): Promise<void> {
    const closePromises = Array.from(this.clientPool.entries()).map(async ([_, client]) => {
      try {
        await client.close();
      } catch (err: any) {
        logger.warn(`[ConnectionManager] Error closing client: ${err.message}`);
      }
    });

    await Promise.all(closePromises);
    this.clientPool.clear();
    logger.info('[ConnectionManager] All connection pools closed.');
  }

  /**
   * Number of active pooled clients.
   */
  public get activePoolCount(): number {
    return this.clientPool.size;
  }
}

export const connectionManager = new ConnectionManager();
