import { MongoClient, Db } from 'mongodb';
import { getEnvConfig } from './env.js';
import { logger } from '../utils/logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDatabase(): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) {
    return { client, db };
  }

  const config = getEnvConfig();
  try {
    logger.info(`Connecting to MongoDB at: ${config.MONGODB_URI} (Database: ${config.MONGODB_DATABASE})`);
    client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    db = client.db(config.MONGODB_DATABASE);
    logger.success('Connected to MongoDB successfully!');
    return { client, db };
  } catch (error) {
    logger.error('Failed to connect to MongoDB', error);
    throw error;
  }
}

export function getDatabase(): Db {
  if (!db) {
    throw new Error('Database not connected. Call connectToDatabase() first.');
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('MongoDB connection closed.');
  }
}
