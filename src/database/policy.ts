/**
 * Security & Execution Policy Validation Layer
 * 
 * Enforces guardrails, resource constraints, and blocked operator filtering
 * before any query or pipeline reaches the database adapter.
 */

import {
  FindOptions,
  AggregateOptions,
  CountOptions,
  InsertOptions,
  UpdateOptions,
  DeleteOptions
} from './adapter.js';

export const MAX_FIND_LIMIT = 50;
export const MAX_AGGREGATION_RESULTS = 50;
export const MAX_PIPELINE_STAGES = 20;
export const QUERY_TIMEOUT_MS = 5000;
export const MAX_DOCUMENT_SIZE_BYTES = 1024 * 1024; // 1MB maximum document size
export const MAX_UPDATE_DOCUMENTS = 10;             // Max documents affected in a single update
export const MAX_DELETE_DOCUMENTS = 5;              // Max documents affected in a single delete

export const RESTRICTED_SYSTEM_COLLECTIONS = new Set<string>([
  'sessions',
  'chat_messages',
  'user_memories',
  'audit_logs'
]);

export const BLOCKED_OPERATORS = new Set<string>([
  '$where',       // Arbitrary JavaScript execution
  '$function',    // Custom JavaScript execution in aggregation
  '$accumulator', // Custom JavaScript accumulator in aggregation
  '$out',         // Overwrite/write collections from aggregation
  '$merge'        // Merge/write documents into target collections
]);

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(`[Security Policy Violation] ${message}`);
    this.name = 'PolicyViolationError';
  }
}

/**
 * Validates collection name format and prevents access to system/internal collections.
 */
export function validateCollectionName(name: any): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new PolicyViolationError('Collection name must be a non-empty string.');
  }

  const trimmed = name.trim();

  if (trimmed.startsWith('system.')) {
    throw new PolicyViolationError(`Access to system collection "${trimmed}" is prohibited.`);
  }

  if (trimmed.includes('\0')) {
    throw new PolicyViolationError('Collection name contains invalid null byte character.');
  }

  if (trimmed.includes('$')) {
    throw new PolicyViolationError('Collection name cannot contain "$" character.');
  }

  return trimmed;
}

export interface SecurityContext {
  userId?: string;
  projectId?: string;
  role?: 'readOnly' | 'readWrite' | 'admin';
  allowedCollections?: string[];
  restrictedCollections?: string[];
}

/**
 * Validates that the active user/role has write permissions.
 */
export function validateWritePermission(securityContext?: SecurityContext): void {
  if (securityContext?.role === 'readOnly') {
    throw new PolicyViolationError(
      `Write operations are prohibited: User "${securityContext.userId || 'anonymous'}" has readOnly permissions on this project.`
    );
  }
}

/**
 * Validates that access to a collection complies with project-level whitelists and blacklists.
 */
export function validateCollectionAccessPolicy(
  collectionName: string,
  securityContext?: SecurityContext
): string {
  const collection = validateCollectionName(collectionName);

  if (securityContext) {
    if (securityContext.allowedCollections && securityContext.allowedCollections.length > 0) {
      if (!securityContext.allowedCollections.includes(collection)) {
        throw new PolicyViolationError(
          `Access to collection "${collection}" is prohibited by the project collection whitelist.`
        );
      }
    }

    if (securityContext.restrictedCollections && securityContext.restrictedCollections.includes(collection)) {
      throw new PolicyViolationError(
        `Access to collection "${collection}" is prohibited by the project restricted collections policy.`
      );
    }
  }

  return collection;
}

/**
 * Validates affected document count for updates against maximum threshold.
 */
export function validateAffectedUpdateCount(count: number): void {
  if (count > MAX_UPDATE_DOCUMENTS) {
    throw new PolicyViolationError(
      `Safety threshold exceeded: Filter matches ${count} documents for update (Maximum allowed per operation is ${MAX_UPDATE_DOCUMENTS}). Refine filter query.`
    );
  }
}

/**
 * Validates affected document count for deletes against maximum threshold.
 */
export function validateAffectedDeleteCount(count: number): void {
  if (count > MAX_DELETE_DOCUMENTS) {
    throw new PolicyViolationError(
      `Safety threshold exceeded: Filter matches ${count} documents for delete (Maximum allowed per operation is ${MAX_DELETE_DOCUMENTS}). Refine filter query.`
    );
  }
}

/**
 * Validates that a collection is permissible for write operations.
 * Protects system metadata and audit log collections, and applies project collection policies.
 */
export function validateWriteCollection(name: any, securityContext?: SecurityContext): string {
  validateWritePermission(securityContext);
  const collection = validateCollectionAccessPolicy(name, securityContext);

  if (RESTRICTED_SYSTEM_COLLECTIONS.has(collection)) {
    throw new PolicyViolationError(
      `Direct modification of internal system collection "${collection}" is strictly prohibited.`
    );
  }

  return collection;
}

/**
 * Validates that a document payload does not exceed the maximum allowed size.
 */
export function validateDocumentSize(doc: any): void {
  try {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new PolicyViolationError(
        `Document size (${(size / 1024).toFixed(1)} KB) exceeds safety limit of ${MAX_DOCUMENT_SIZE_BYTES / 1024} KB.`
      );
    }
  } catch (err: any) {
    if (err instanceof PolicyViolationError) throw err;
    throw new PolicyViolationError('Document contains circular structures or non-serializable fields.');
  }
}

/**
 * Recursively scans an object, array, or nested structure for prohibited MongoDB operators.
 */
export function scanForBlockedOperators(target: any, path: string = ''): void {
  if (!target || typeof target !== 'object') {
    return;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      scanForBlockedOperators(target[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(target)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (BLOCKED_OPERATORS.has(key)) {
      throw new PolicyViolationError(
        `Operator "${key}" at path "${currentPath}" is strictly blocked for security reasons.`
      );
    }

    if (typeof value === 'function') {
      throw new PolicyViolationError(`Functions and executable code are not allowed in queries at "${currentPath}".`);
    }

    if (value && typeof value === 'object') {
      scanForBlockedOperators(value, currentPath);
    }
  }
}

/**
 * Validates a query filter object.
 */
export function validateFilter(filter: any): Record<string, any> {
  if (filter === undefined || filter === null) {
    return {};
  }

  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new PolicyViolationError('Filter must be a valid JSON object.');
  }

  scanForBlockedOperators(filter, 'filter');
  return filter;
}

/**
 * Validates projection document.
 */
export function validateProjection(projection: any): Record<string, any> {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    return {};
  }

  scanForBlockedOperators(projection, 'projection');
  return projection;
}

/**
 * Validates sort document.
 */
export function validateSort(sort: any): Record<string, any> {
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) {
    return {};
  }

  scanForBlockedOperators(sort, 'sort');
  return sort;
}

/**
 * Validates an aggregation pipeline for stage count limits and blocked operators.
 */
export function validatePipeline(pipeline: any): Record<string, any>[] {
  if (!Array.isArray(pipeline)) {
    throw new PolicyViolationError('Aggregation pipeline must be an array of pipeline stages.');
  }

  if (pipeline.length > MAX_PIPELINE_STAGES) {
    throw new PolicyViolationError(
      `Pipeline stage complexity exceeded: ${pipeline.length} stages (Maximum allowed is ${MAX_PIPELINE_STAGES}).`
    );
  }

  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new PolicyViolationError(`Pipeline stage at index [${i}] must be a valid object.`);
    }

    const stageKeys = Object.keys(stage);
    for (const key of stageKeys) {
      if (BLOCKED_OPERATORS.has(key)) {
        throw new PolicyViolationError(`Prohibited stage "${key}" at pipeline index [${i}].`);
      }
    }

    scanForBlockedOperators(stage, `pipeline[${i}]`);
  }

  return pipeline;
}

/**
 * Validates and clamps result limits.
 */
export function validateLimit(limit: any, maxLimit: number): number {
  if (limit === undefined || limit === null) {
    return 10;
  }

  const num = Number(limit);
  if (isNaN(num) || num <= 0) {
    return 10;
  }

  return Math.min(Math.floor(num), maxLimit);
}

/**
 * Validates and enforces maximum query execution timeout.
 */
export function validateTimeout(timeoutMs?: number): number {
  if (!timeoutMs || typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    return QUERY_TIMEOUT_MS;
  }

  return Math.min(Math.floor(timeoutMs), QUERY_TIMEOUT_MS);
}

/**
 * Sanitizes and validates find options according to security policies.
 */
export function sanitizeFindOptions(options: FindOptions, securityContext?: SecurityContext): {
  collection: string;
  filter: Record<string, any>;
  projection: Record<string, any>;
  sort: Record<string, any>;
  limit: number;
  skip: number;
  timeoutMs: number;
} {
  const collection = validateCollectionAccessPolicy(options.collection, securityContext);
  const filter = validateFilter(options.filter);
  const projection = validateProjection(options.projection);
  const sort = validateSort(options.sort);
  const limit = validateLimit(options.limit, MAX_FIND_LIMIT);
  const skip = Math.max(Number(options.skip) || 0, 0);
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    filter,
    projection,
    sort,
    limit,
    skip,
    timeoutMs
  };
}

/**
 * Sanitizes and validates aggregation options according to security policies.
 */
export function sanitizeAggregateOptions(options: AggregateOptions, securityContext?: SecurityContext): {
  collection: string;
  pipeline: Record<string, any>[];
  limit: number;
  timeoutMs: number;
} {
  const collection = validateCollectionAccessPolicy(options.collection, securityContext);
  const pipeline = validatePipeline(options.pipeline);
  const limit = validateLimit(options.limit, MAX_AGGREGATION_RESULTS);
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    pipeline,
    limit,
    timeoutMs
  };
}

/**
 * Sanitizes and validates count options according to security policies.
 */
export function sanitizeCountOptions(options: CountOptions, securityContext?: SecurityContext): {
  collection: string;
  filter: Record<string, any>;
  timeoutMs: number;
} {
  const collection = validateCollectionAccessPolicy(options.collection, securityContext);
  const filter = validateFilter(options.filter);
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    filter,
    timeoutMs
  };
}

/**
 * Sanitizes and validates insert options.
 */
export function sanitizeInsertOptions(options: InsertOptions, securityContext?: SecurityContext): {
  collection: string;
  document: Record<string, any>;
  timeoutMs: number;
} {
  const collection = validateWriteCollection(options.collection, securityContext);

  if (!options.document || typeof options.document !== 'object' || Array.isArray(options.document)) {
    throw new PolicyViolationError('Insert document must be a non-empty JSON object.');
  }

  validateDocumentSize(options.document);
  scanForBlockedOperators(options.document, 'insert.document');
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    document: options.document,
    timeoutMs
  };
}

/**
 * Sanitizes and validates update options.
 * Enforces non-empty filter requirement to prevent whole-collection updates.
 */
export function sanitizeUpdateOptions(options: UpdateOptions, securityContext?: SecurityContext): {
  collection: string;
  filter: Record<string, any>;
  update: Record<string, any>;
  multi: boolean;
  timeoutMs: number;
} {
  const collection = validateWriteCollection(options.collection, securityContext);
  const filter = validateFilter(options.filter);

  if (!filter || Object.keys(filter).length === 0) {
    throw new PolicyViolationError(
      'Safety violation: An empty filter {} is strictly disallowed for update operations to prevent whole-collection overwrite.'
    );
  }

  if (!options.update || typeof options.update !== 'object' || Array.isArray(options.update)) {
    throw new PolicyViolationError('Update payload must be a non-empty JSON object.');
  }

  validateDocumentSize(options.update);
  scanForBlockedOperators(options.update, 'update.payload');

  // Ensure update has MongoDB operator(s) or wrap in $set
  const hasOperators = Object.keys(options.update).some((k) => k.startsWith('$'));
  const update = hasOperators ? options.update : { $set: options.update };
  const multi = Boolean(options.multi);
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    filter,
    update,
    multi,
    timeoutMs
  };
}

/**
 * Sanitizes and validates delete options.
 * Enforces non-empty filter requirement to prevent accidental mass deletion.
 */
export function sanitizeDeleteOptions(options: DeleteOptions, securityContext?: SecurityContext): {
  collection: string;
  filter: Record<string, any>;
  multi: boolean;
  timeoutMs: number;
} {
  const collection = validateWriteCollection(options.collection, securityContext);
  const filter = validateFilter(options.filter);

  if (!filter || Object.keys(filter).length === 0) {
    throw new PolicyViolationError(
      'Safety violation: An empty filter {} is strictly disallowed for delete operations.'
    );
  }

  const multi = Boolean(options.multi);
  const timeoutMs = validateTimeout(options.timeoutMs);

  return {
    collection,
    filter,
    multi,
    timeoutMs
  };
}
