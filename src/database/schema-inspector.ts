/**
 * Automatic MongoDB Schema Discovery & Inspection
 * 
 * Inspects any connected MongoDB database dynamically without pre-configured schemas.
 * Discovers collection names, infers nested fields (dot notation), handles arrays,
 * detects inconsistent field types, extracts indexes, and generates LLM-ready representations.
 */

import { Db, Collection } from 'mongodb';
import { getDatabase } from '../config/db.js';
import { validateCollectionName, QUERY_TIMEOUT_MS } from './policy.js';

export interface IndexInfo {
  name: string;
  keys: Record<string, number | string>;
  unique?: boolean;
}

export interface CollectionSchemaInfo {
  collectionName: string;
  isEmpty: boolean;
  sampleCount: number;
  totalDocumentEstimate: number;
  fields: Record<string, string>;
  indexes: IndexInfo[];
  sampleDocument?: Record<string, any>;
}

export interface DatabaseSchemaReport {
  databaseName: string;
  collectionCount: number;
  collections: Record<string, CollectionSchemaInfo>;
  generatedAt: Date;
}

export interface SchemaInspectorOptions {
  sampleSize?: number;
  timeoutMs?: number;
  maxNestingDepth?: number;
}

export class SchemaInspector {
  private dbInstance?: Db;
  private sampleSize: number;
  private timeoutMs: number;
  private maxNestingDepth: number;

  constructor(db?: Db, options?: SchemaInspectorOptions) {
    this.dbInstance = db;
    this.sampleSize = Math.min(Math.max(options?.sampleSize || 5, 1), 20);
    this.timeoutMs = Math.min(options?.timeoutMs || QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MS);
    this.maxNestingDepth = options?.maxNestingDepth || 4;
  }

  private getDb(): Db {
    return this.dbInstance || getDatabase();
  }

  /**
   * Helper to determine approximate type of a single value.
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
      if (ctorName === 'ObjectId' || val._bsontype === 'ObjectID') {
        return 'ObjectId';
      }
      if (ctorName === 'Decimal128') {
        return 'decimal';
      }
      if (ctorName === 'Binary' || Buffer.isBuffer(val)) {
        return 'binary';
      }
      return 'object';
    }

    return typeof val; // 'string' | 'number' | 'boolean'
  }

  /**
   * Recursively traverses a document to extract dot-notated field paths and their types.
   */
  private extractFieldsFromDoc(
    doc: Record<string, any>,
    pathTypeMap: Map<string, Set<string>>,
    prefix: string = '',
    depth: number = 0
  ): void {
    if (!doc || typeof doc !== 'object' || depth > this.maxNestingDepth) {
      return;
    }

    for (const [key, val] of Object.entries(doc)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;

      const type = this.inferValueType(val);

      if (!pathTypeMap.has(currentPath)) {
        pathTypeMap.set(currentPath, new Set<string>());
      }
      pathTypeMap.get(currentPath)!.add(type);

      // If object and not a special BSON type or array, traverse nested fields
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
        // If array of objects, inspect the first element's nested fields
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
   * Inspects index definitions for a given collection safely.
   */
  private async getIndexes(col: Collection): Promise<IndexInfo[]> {
    try {
      const rawIndexes = await col.listIndexes().toArray();
      return rawIndexes.map((idx) => ({
        name: idx.name || 'unknown',
        keys: idx.key as Record<string, number | string>,
        unique: Boolean(idx.unique)
      }));
    } catch {
      return [];
    }
  }

  /**
   * Inspects a single collection by name and returns comprehensive schema metadata.
   */
  async inspectCollection(collectionName: string): Promise<CollectionSchemaInfo> {
    const validName = validateCollectionName(collectionName);
    const db = this.getDb();
    const collection = db.collection(validName);

    // 1. Fetch small sample
    const samples = await collection
      .find({})
      .limit(this.sampleSize)
      .maxTimeMS(this.timeoutMs)
      .toArray();

    // 2. Fetch estimated count
    let totalCount = 0;
    try {
      totalCount = await collection.estimatedDocumentCount({ maxTimeMS: this.timeoutMs });
    } catch {
      totalCount = samples.length;
    }

    // 3. Fetch indexes
    const indexes = await this.getIndexes(collection);

    if (samples.length === 0) {
      return {
        collectionName: validName,
        isEmpty: true,
        sampleCount: 0,
        totalDocumentEstimate: totalCount,
        fields: {},
        indexes
      };
    }

    // 4. Map fields and detect inconsistent types across samples
    const pathTypeMap = new Map<string, Set<string>>();
    for (const doc of samples) {
      this.extractFieldsFromDoc(doc, pathTypeMap);
    }

    const consolidatedFields: Record<string, string> = {};
    for (const [path, typesSet] of pathTypeMap.entries()) {
      // If multiple types observed across docs (e.g. string and null), represent as union
      const types = Array.from(typesSet);
      consolidatedFields[path] = types.join(' | ');
    }

    return {
      collectionName: validName,
      isEmpty: false,
      sampleCount: samples.length,
      totalDocumentEstimate: totalCount,
      fields: consolidatedFields,
      indexes,
      sampleDocument: samples[0]
    };
  }

  /**
   * Discovers and inspects all non-system collections across the database.
   */
  async inspectDatabase(targetCollections?: string[]): Promise<DatabaseSchemaReport> {
    const db = this.getDb();
    let colNames: string[] = [];

    if (targetCollections && targetCollections.length > 0) {
      colNames = targetCollections.map(validateCollectionName);
    } else {
      const allCols = await db.listCollections().toArray();
      colNames = allCols
        .map((c) => c.name)
        .filter((n) => !n.startsWith('system.'));
    }

    const report: DatabaseSchemaReport = {
      databaseName: db.databaseName,
      collectionCount: colNames.length,
      collections: {},
      generatedAt: new Date()
    };

    // Inspect collections in sequence to avoid overloading database connection
    for (const colName of colNames) {
      try {
        report.collections[colName] = await this.inspectCollection(colName);
      } catch (err: any) {
        report.collections[colName] = {
          collectionName: colName,
          isEmpty: true,
          sampleCount: 0,
          totalDocumentEstimate: 0,
          fields: {},
          indexes: []
        };
      }
    }

    return report;
  }

  /**
   * Formats a collection schema into clean, intuitive text for LLM prompts.
   */
  formatCollectionForLLM(info: CollectionSchemaInfo, includeIndexes: boolean = true): string {
    let out = `${info.collectionName}:\n`;

    if (info.isEmpty) {
      out += '  (Empty collection)\n';
      return out;
    }

    for (const [field, type] of Object.entries(info.fields)) {
      out += `  ${field}: ${type}\n`;
    }

    if (includeIndexes && info.indexes.length > 0) {
      const idxStrings = info.indexes.map((idx) => {
        const keyList = Object.keys(idx.keys).join(', ');
        return idx.unique ? `${keyList} (unique)` : keyList;
      });
      out += `  [Indexes: ${idxStrings.join(' | ')}]\n`;
    }

    return out;
  }

  /**
   * Formats the entire database schema into a compact, human/LLM-readable summary.
   */
  formatReportForLLM(report: DatabaseSchemaReport, includeIndexes: boolean = true): string {
    let output = `Database: ${report.databaseName} (${report.collectionCount} collections)\n\n`;

    for (const info of Object.values(report.collections)) {
      output += this.formatCollectionForLLM(info, includeIndexes) + '\n';
    }

    return output.trim();
  }
}
