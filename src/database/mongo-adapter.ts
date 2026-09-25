import { Db } from 'mongodb';
import { getDatabase } from '../config/db.js';
import { AuditLogger } from './audit-logger.js';
import {
  DatabaseAdapter,
  CollectionSchema,
  IndexInfo,
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
  MAX_UPDATE_DOCUMENTS,
  MAX_DELETE_DOCUMENTS,
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
   * Helper to infer approximate data type of a single value.
   */
  private inferValueType(val: any): string {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (val instanceof Date) return 'date';

    if (Array.isArray(val)) {
      if (val.length === 0) return 'array';
      const itemTypes = new Set<string>();
      for (const item of val) {
        itemTypes.add(this.inferValueType(item));
        if (itemTypes.size > 2) break;
      }
      if (itemTypes.size === 1) {
        return `array<${Array.from(itemTypes)[0]}>`;
      }
      return 'array';
    }

    if (typeof val === 'object') {
      const ctorName = val.constructor?.name;
      if (ctorName === 'ObjectId' || val._bsontype === 'ObjectID') return 'ObjectId';
      if (ctorName === 'Decimal128') return 'decimal';
      if (ctorName === 'Binary' || Buffer.isBuffer(val)) return 'binary';
      return 'object';
    }

    return typeof val;
  }

  /**
   * Recursively traverses a document to extract dot-notated field paths and inferred types.
   */
  private extractFieldsFromDoc(
    doc: Record<string, any>,
    pathTypeMap: Map<string, Set<string>>,
    prefix: string = '',
    depth: number = 0
  ): void {
    if (!doc || typeof doc !== 'object' || depth > 4) return;

    for (const [key, val] of Object.entries(doc)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      const type = this.inferValueType(val);

      if (!pathTypeMap.has(currentPath)) {
        pathTypeMap.set(currentPath, new Set<string>());
      }
      pathTypeMap.get(currentPath)!.add(type);

      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        !(val instanceof Date) &&
        val.constructor?.name !== 'ObjectId' &&
        val._bsontype !== 'ObjectID' &&
        !Buffer.isBuffer(val)
      ) {
        this.extractFieldsFromDoc(val, pathTypeMap, currentPath, depth + 1);
      } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        if (
          val[0].constructor?.name !== 'ObjectId' &&
          val[0]._bsontype !== 'ObjectID' &&
          !(val[0] instanceof Date)
        ) {
          this.extractFieldsFromDoc(val[0], pathTypeMap, `${currentPath}[]`, depth + 1);
        }
      }
    }
  }

  /**
   * Introspects field names, data types, indexes, and retrieves a sample record from any collection
   * subject to collection access authorization.
   */
  async getCollectionSchema(collectionName: string): Promise<CollectionSchema> {
    const validName = validateCollectionAccessPolicy(collectionName, this.securityContext);
    const db = this.getDb();
    const collection = db.collection(validName);

    const samples = await collection
      .find({})
      .limit(5)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .toArray();

    let totalCount = 0;
    try {
      totalCount = await collection.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS });
    } catch {
      totalCount = samples.length;
    }

    let indexes: IndexInfo[] = [];
    try {
      const rawIndexes = await collection.listIndexes().toArray();
      indexes = rawIndexes.map((idx) => ({
        name: idx.name || 'unknown',
        keys: idx.key as Record<string, number | string>,
        unique: Boolean(idx.unique)
      }));
    } catch {}

    if (samples.length === 0) {
      const emptySchema: CollectionSchema = {
        collectionName: validName,
        isEmpty: true,
        fields: {},
        totalCount: 0,
        indexes,
        schemaSummary: `${validName}:\n  (Empty collection)\n`
      };
      return emptySchema;
    }

    const pathTypeMap = new Map<string, Set<string>>();
    for (const doc of samples) {
      this.extractFieldsFromDoc(doc, pathTypeMap);
    }

    const consolidatedFields: Record<string, string> = {};
    for (const [path, typesSet] of pathTypeMap.entries()) {
      consolidatedFields[path] = Array.from(typesSet).join(' | ');
    }

    const schema: CollectionSchema = {
      collectionName: validName,
      isEmpty: false,
      fields: consolidatedFields,
      sampleDocument: samples[0],
      totalCount,
      indexes
    };
    schema.schemaSummary = this.formatSchemaForLLM(schema);
    return schema;
  }

  /**
   * Introspects the entire database schema across all accessible collections.
   */
  async getDatabaseSchema(): Promise<Record<string, CollectionSchema>> {
    const collections = await this.listCollections();
    const result: Record<string, CollectionSchema> = {};
    for (const col of collections) {
      try {
        result[col] = await this.getCollectionSchema(col);
      } catch {
        result[col] = {
          collectionName: col,
          isEmpty: true,
          fields: {},
          totalCount: 0,
          indexes: []
        };
      }
    }
    return result;
  }

  /**
   * Formats a collection or database schema into a compact representation for LLM prompts.
   */
  formatSchemaForLLM(schema: CollectionSchema | Record<string, CollectionSchema>): string {
    if (typeof (schema as any).collectionName === 'string') {
      const col = schema as CollectionSchema;
      let out = `${col.collectionName}:\n`;
      if (col.isEmpty) return out + '  (Empty collection)\n';
      for (const [field, type] of Object.entries(col.fields || {})) {
        out += `  ${field}: ${type}\n`;
      }
      if (col.indexes && col.indexes.length > 0) {
        const idxStrings = col.indexes.map((idx: IndexInfo) => {
          const keyList = Object.keys(idx.keys).join(', ');
          return idx.unique ? `${keyList} (unique)` : keyList;
        });
        out += `  [Indexes: ${idxStrings.join(' | ')}]\n`;
      }
      return out;
    }

    let output = '';
    for (const info of Object.values(schema)) {
      output += this.formatSchemaForLLM(info) + '\n';
    }
    return output.trim();
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

    if (sanitized.multi) {
      // Find matching document IDs up to safety ceiling + 1
      const matchingDocs = await collection
        .find(sanitized.filter, { projection: { _id: 1 } })
        .limit(MAX_UPDATE_DOCUMENTS + 1)
        .maxTimeMS(sanitized.timeoutMs)
        .toArray();

      validateAffectedUpdateCount(matchingDocs.length);

      if (matchingDocs.length === 0) {
        return {
          matchedCount: 0,
          modifiedCount: 0,
          acknowledged: true
        };
      }

      const targetIds = matchingDocs.map((d) => d._id);
      const result = await collection.updateMany(
        { _id: { $in: targetIds } },
        sanitized.update,
        { maxTimeMS: sanitized.timeoutMs }
      );

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

    if (sanitized.multi) {
      // Find matching document IDs up to safety ceiling + 1
      const matchingDocs = await collection
        .find(sanitized.filter, { projection: { _id: 1 } })
        .limit(MAX_DELETE_DOCUMENTS + 1)
        .maxTimeMS(sanitized.timeoutMs)
        .toArray();

      validateAffectedDeleteCount(matchingDocs.length);

      if (matchingDocs.length === 0) {
        return {
          deletedCount: 0,
          acknowledged: true
        };
      }

      const targetIds = matchingDocs.map((d) => d._id);
      const result = await collection.deleteMany(
        { _id: { $in: targetIds } },
        { maxTimeMS: sanitized.timeoutMs }
      );

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

  /**
   * Records an immutable entry in the audit trail.
   */
  async logAuditEvent(entry: any): Promise<any> {
    const auditLogger = new AuditLogger(this.getDb());
    return await auditLogger.logEvent({
      ...entry,
      userId: entry.userId || this.securityContext?.userId,
      projectId: entry.projectId || this.securityContext?.projectId
    });
  }

  /**
   * Retrieves recent audit trail events.
   */
  async getRecentAuditEvents(limit: number = 5): Promise<any[]> {
    const auditLogger = new AuditLogger(this.getDb());
    return await auditLogger.getRecentEvents(limit);
  }
}
