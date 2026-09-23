import { Db } from 'mongodb';
import { getDatabase } from '../config/db.js';
import {
  DatabaseAdapter,
  CollectionSchema,
  FindOptions,
  FindResult,
  AggregateOptions,
  AggregateResult,
  CountOptions,
  InsertOptions,
  InsertResult,
  UpdateOptions,
  UpdateResult,
  DeleteOptions,
  DeleteResult
} from './adapter.js';
import {
  SecurityContext,
  validateCollectionName,
  validateCollectionAccessPolicy,
  validateAffectedUpdateCount,
  validateAffectedDeleteCount,
  sanitizeFindOptions,
  sanitizeAggregateOptions,
  sanitizeCountOptions,
  sanitizeInsertOptions,
  sanitizeUpdateOptions,
  sanitizeDeleteOptions,
  QUERY_TIMEOUT_MS
} from './policy.js';

export interface MongoAdapterOptions {
  securityContext?: SecurityContext;
}

export class MongoDatabaseAdapter implements DatabaseAdapter {
  private dbInstance?: Db;
  public securityContext?: SecurityContext;

  /**
   * Initializes adapter. Reuses the existing connection pool by default,
   * or accepts an explicit Db instance and security context.
   */
  constructor(db?: Db, options?: MongoAdapterOptions) {
    this.dbInstance = db;
    this.securityContext = options?.securityContext;
  }

  public getDb(): Db {
    return this.dbInstance || getDatabase();
  }

  /**
   * Lists all user collections in the MongoDB database, omitting system collections
   * and applying project collection access policies.
   */
  async listCollections(): Promise<string[]> {
    const db = this.getDb();
    const collections = await db.listCollections().toArray();
    let names = collections
      .map((c) => c.name)
      .filter((name) => !name.startsWith('system.'));

    if (this.securityContext?.allowedCollections && this.securityContext.allowedCollections.length > 0) {
      const allowedSet = new Set(this.securityContext.allowedCollections);
      names = names.filter((n) => allowedSet.has(n));
    }

    if (this.securityContext?.restrictedCollections && this.securityContext.restrictedCollections.length > 0) {
      const restrictedSet = new Set(this.securityContext.restrictedCollections);
      names = names.filter((n) => !restrictedSet.has(n));
    }

    return names;
  }

  /**
   * Introspects field names, data types, and retrieves a sample record from any collection
   * subject to collection access authorization.
   */
  async getCollectionSchema(collectionName: string): Promise<CollectionSchema> {
    const validName = validateCollectionAccessPolicy(collectionName, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(validName);

    const samples = await collection
      .find({})
      .limit(3)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .toArray();

    if (samples.length === 0) {
      return {
        collectionName: validName,
        fields: {},
        totalCount: 0
      };
    }

    const fieldsSummary: Record<string, string> = {};
    samples.forEach((doc) => {
      Object.entries(doc).forEach(([key, val]) => {
        if (!fieldsSummary[key]) {
          if (Array.isArray(val)) {
            const firstItem = val[0];
            const elemType = firstItem !== null && typeof firstItem === 'object' ? 'Object' : typeof firstItem;
            fieldsSummary[key] = `Array<${elemType || 'any'}>`;
          } else if (val instanceof Date) {
            fieldsSummary[key] = 'Date';
          } else if (val !== null && typeof val === 'object') {
            fieldsSummary[key] = val.constructor?.name === 'ObjectId' ? 'ObjectId' : 'Object';
          } else {
            fieldsSummary[key] = typeof val;
          }
        }
      });
    });

    let totalCount = 0;
    try {
      totalCount = await collection.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS });
    } catch {
      totalCount = samples.length;
    }

    return {
      collectionName: validName,
      fields: fieldsSummary,
      sampleDocument: samples[0],
      totalCount
    };
  }

  /**
   * Safely queries documents using filtering, projection, sorting, and clamped limits.
   */
  async find(options: FindOptions): Promise<FindResult> {
    const sanitized = sanitizeFindOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    let cursor = collection.find(sanitized.filter);

    if (Object.keys(sanitized.projection).length > 0) {
      cursor = cursor.project(sanitized.projection);
    }

    if (Object.keys(sanitized.sort).length > 0) {
      cursor = cursor.sort(sanitized.sort);
    }

    if (sanitized.skip > 0) {
      cursor = cursor.skip(sanitized.skip);
    }

    cursor = cursor.limit(sanitized.limit).maxTimeMS(sanitized.timeoutMs);

    const documents = await cursor.toArray();
    return {
      documents,
      count: documents.length
    };
  }

  /**
   * Executes a multi-stage aggregation pipeline with stage complexity validation.
   */
  async aggregate(options: AggregateOptions): Promise<AggregateResult> {
    const sanitized = sanitizeAggregateOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    const pipelineWithLimit = [...sanitized.pipeline];
    const hasLimitStage = pipelineWithLimit.some((stage) => '$limit' in stage);
    if (!hasLimitStage) {
      pipelineWithLimit.push({ $limit: sanitized.limit });
    }

    const cursor = collection.aggregate(pipelineWithLimit, {
      maxTimeMS: sanitized.timeoutMs
    });

    const results = await cursor.toArray();
    return {
      results,
      count: results.length
    };
  }

  /**
   * Counts documents matching a validated filter.
   */
  async count(options: CountOptions): Promise<number> {
    const sanitized = sanitizeCountOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    return await collection.countDocuments(sanitized.filter, {
      maxTimeMS: sanitized.timeoutMs
    });
  }

  /**
   * Inserts a document into a collection after strict schema, size, and RBAC policy validation.
   */
  async insert(options: InsertOptions): Promise<InsertResult> {
    const sanitized = sanitizeInsertOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    const result = await collection.insertOne(sanitized.document, {
      maxTimeMS: sanitized.timeoutMs
    });

    return {
      insertedId: result.insertedId,
      acknowledged: result.acknowledged
    };
  }

  /**
   * Updates documents matching a validated non-empty filter with affected count limits.
   */
  async update(options: UpdateOptions): Promise<UpdateResult> {
    const sanitized = sanitizeUpdateOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    // Pre-flight check: ensure matching documents do not exceed safety threshold
    const matchCount = await collection.countDocuments(sanitized.filter, {
      maxTimeMS: sanitized.timeoutMs
    });
    validateAffectedUpdateCount(matchCount);

    if (sanitized.multi) {
      const result = await collection.updateMany(sanitized.filter, sanitized.update, {
        maxTimeMS: sanitized.timeoutMs
      });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        acknowledged: result.acknowledged,
        upsertedId: result.upsertedId
      };
    } else {
      const result = await collection.updateOne(sanitized.filter, sanitized.update, {
        maxTimeMS: sanitized.timeoutMs
      });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        acknowledged: result.acknowledged,
        upsertedId: result.upsertedId
      };
    }
  }

  /**
   * Deletes documents matching a validated non-empty filter with affected count limits.
   */
  async delete(options: DeleteOptions): Promise<DeleteResult> {
    const sanitized = sanitizeDeleteOptions(options, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(sanitized.collection);

    // Pre-flight check: ensure matching documents do not exceed safety threshold
    const matchCount = await collection.countDocuments(sanitized.filter, {
      maxTimeMS: sanitized.timeoutMs
    });
    validateAffectedDeleteCount(matchCount);

    if (sanitized.multi) {
      const result = await collection.deleteMany(sanitized.filter, {
        maxTimeMS: sanitized.timeoutMs
      });
      return {
        deletedCount: result.deletedCount,
        acknowledged: result.acknowledged
      };
    } else {
      const result = await collection.deleteOne(sanitized.filter, {
        maxTimeMS: sanitized.timeoutMs
      });
      return {
        deletedCount: result.deletedCount,
        acknowledged: result.acknowledged
      };
    }
  }
}
