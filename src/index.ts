export { QueryAgent } from './agents/query-agent/index.js';
export { RagAgent } from './agents/rag-agent/index.js';
export { TaskAgent } from './agents/task-agent/index.js';
export { UnifiedAgent } from './agents/unified-agent.js';
export { generateEmbedding, cosineSimilarity } from './llm/embeddings.js';
export { connectToDatabase, closeDatabase, getDatabase } from './config/db.js';
export type { DatabaseAdapter } from './database/adapter.js';
export { MongoDatabaseAdapter } from './database/mongo-adapter.js';
export { SchemaInspector } from './database/schema-inspector.js';
export { AuditLogger, defaultAuditLogger } from './database/audit-logger.js';
export type { AuditLogEntry } from './database/audit-logger.js';
export {
  ProjectManager,
  projectManager,
  ConnectionManager,
  connectionManager,
  ProjectNotFoundError,
  UnauthorizedProjectAccessError,
  ProjectPermissionError
} from './projects/index.js';
export type {
  ProjectConfig,
  ProjectSummary,
  UserProjectRole,
  ProjectSecurityContext
} from './projects/index.js';
export {
  MongoMemoryStore,
  UnauthorizedSessionAccessError
} from './agents/memory-agent/store.js';
export type {
  ChatMessage,
  UserMemoryItem,
  SessionRecord
} from './agents/memory-agent/store.js';
export {
  createApiServer,
  startServer,
  schemaCache,
  SchemaCache,
  RateLimiter,
  defaultRateLimiter
} from './api/index.js';
export { seedDatabase } from './data/seed.js';
export { seedKnowledgeAndEmbeddings } from './data/seed-knowledge.js';
export { logger } from './utils/logger.js';
