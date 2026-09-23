/**
 * Generic Database Abstraction Layer - Interface
 * 
 * Defines database-independent interfaces and contracts for querying and inspecting
 * any backend database without coupling to a specific database technology or schema.
 */

export interface CollectionSchema {
  collectionName: string;
  fields: Record<string, string>;
  sampleDocument?: Record<string, any>;
  totalCount?: number;
}

export interface FindOptions {
  collection: string;
  filter?: Record<string, any>;
  projection?: Record<string, any>;
  sort?: Record<string, any>;
  limit?: number;
  skip?: number;
  timeoutMs?: number;
}

export interface FindResult {
  documents: any[];
  count: number;
}

export interface AggregateOptions {
  collection: string;
  pipeline: Record<string, any>[];
  limit?: number;
  timeoutMs?: number;
}

export interface AggregateResult {
  results: any[];
  count: number;
}

export interface CountOptions {
  collection: string;
  filter?: Record<string, any>;
  timeoutMs?: number;
}

export interface InsertOptions {
  collection: string;
  document: Record<string, any>;
  timeoutMs?: number;
}

export interface InsertResult {
  insertedId: any;
  acknowledged: boolean;
}

export interface UpdateOptions {
  collection: string;
  filter: Record<string, any>;
  update: Record<string, any>;
  multi?: boolean;
  timeoutMs?: number;
}

export interface UpdateResult {
  matchedCount: number;
  modifiedCount: number;
  acknowledged: boolean;
  upsertedId?: any;
}

export interface DeleteOptions {
  collection: string;
  filter: Record<string, any>;
  multi?: boolean;
  timeoutMs?: number;
}

export interface DeleteResult {
  deletedCount: number;
  acknowledged: boolean;
}

export interface DatabaseAdapter {
  /**
   * Lists all non-system collection names present in the database.
   */
  listCollections(): Promise<string[]>;

  /**
   * Introspects field names, inferred types, and returns sample structure for a collection.
   */
  getCollectionSchema(collectionName: string): Promise<CollectionSchema>;

  /**
   * Executes a safe query with filtering, projection, sorting, and pagination limits.
   */
  find(options: FindOptions): Promise<FindResult>;

  /**
   * Executes a multi-stage analytical aggregation pipeline.
   */
  aggregate(options: AggregateOptions): Promise<AggregateResult>;

  /**
   * Returns the count of documents matching the specified filter.
   */
  count(options: CountOptions): Promise<number>;

  /**
   * Inserts a document into a collection.
   */
  insert(options: InsertOptions): Promise<InsertResult>;

  /**
   * Updates one or more documents in a collection matching a filter.
   */
  update(options: UpdateOptions): Promise<UpdateResult>;

  /**
   * Deletes one or more documents in a collection matching a filter.
   */
  delete(options: DeleteOptions): Promise<DeleteResult>;
}
