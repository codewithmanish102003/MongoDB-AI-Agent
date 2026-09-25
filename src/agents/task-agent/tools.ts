import { DatabaseAdapter } from '../../database/adapter.js';
import { MongoDatabaseAdapter } from '../../database/mongo-adapter.js';
import { confirmationManager } from '../../database/confirmation.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';
import { ObjectId } from 'mongodb';

let defaultAdapter: DatabaseAdapter = new MongoDatabaseAdapter();

export function setDefaultTaskDatabaseAdapter(adapter: DatabaseAdapter) {
  defaultAdapter = adapter;
}

export const taskAgentFunctionDeclarations: FunctionDeclaration[] = [
  // --- Schema Discovery Tools ---
  {
    name: 'list_collections',
    description: 'Lists all available collections in the database. Use this to discover collections in an unfamiliar database.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'get_collection_schema',
    description: 'Inspects field names, nested paths, data types, indexes, and sample document of any collection. Call this BEFORE modifying data so you never guess field names.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The name of the collection to inspect.'
        }
      },
      required: ['collectionName']
    }
  },

  // --- Core Generic Structured Database Operation Tool ---
  {
    name: 'execute_task_operation',
    description: 'Executes or stages a structured generic database write operation (insert, update, or delete). For safety, updates and deletions require explicit confirmation before execution.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: {
          type: Type.STRING,
          description: 'Operation type: "insert", "update", or "delete".'
        },
        collection: {
          type: Type.STRING,
          description: 'Target collection name in the database.'
        },
        document: {
          type: Type.STRING,
          description: 'JSON string representing the document to insert (required for type="insert").'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string filter matching the document(s) (required for type="update" or "delete"). Must not be empty.'
        },
        update: {
          type: Type.STRING,
          description: 'JSON string of update operators (e.g. \'{"$set": {"status": "inactive"}}\') (required for type="update").'
        },
        reason: {
          type: Type.STRING,
          description: 'Mandatory business explanation for performing this operation.'
        },
        confirmed: {
          type: Type.BOOLEAN,
          description: 'Set to true ONLY if the user has explicitly confirmed the execution.'
        },
        confirmationId: {
          type: Type.STRING,
          description: 'The confirmationId received from a previous dry-run/preview step.'
        }
      },
      required: ['type', 'collection', 'reason']
    }
  },
  {
    name: 'update_document',
    description: 'Safely updates document(s) in ANY collection matching a specific non-empty filter. Automatically logs the change in audit_logs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to update.'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string for filter query matching target document (e.g. \'{"code": "PRJ-101"}\' or \'{"_id": "..."}\'). Empty filter is disallowed.'
        },
        update: {
          type: Type.STRING,
          description: 'JSON string of update operators (e.g. \'{"$set": {"status": "Active"}}\') or plain fields to set.'
        },
        reason: {
          type: Type.STRING,
          description: 'Reason for performing this database update.'
        },
        confirmed: {
          type: Type.BOOLEAN,
          description: 'Set to true if user has confirmed execution.'
        },
        confirmationId: {
          type: Type.STRING,
          description: 'Optional confirmation ID from a previous preview step.'
        }
      },
      required: ['collectionName', 'filter', 'update']
    }
  },
  {
    name: 'insert_document',
    description: 'Inserts a new document into ANY collection in the database. Automatically creates an audit trail entry.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name where document will be inserted.'
        },
        document: {
          type: Type.STRING,
          description: 'JSON string representing the document to insert.'
        },
        reason: {
          type: Type.STRING,
          description: 'Reason for creating this record.'
        }
      },
      required: ['collectionName', 'document']
    }
  },
  {
    name: 'delete_document',
    description: 'Deletes a document from ANY collection matching a specific non-empty filter. Records the deleted document in audit_logs for traceability.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to delete from.'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string filter matching the specific document to delete. Must specify a unique key or _id.'
        },
        reason: {
          type: Type.STRING,
          description: 'Required explanation for why this document is being removed.'
        },
        confirmed: {
          type: Type.BOOLEAN,
          description: 'Set to true if user has confirmed deletion.'
        },
        confirmationId: {
          type: Type.STRING,
          description: 'Optional confirmation ID from preview step.'
        }
      },
      required: ['collectionName', 'filter', 'reason']
    }
  },
  {
    name: 'view_audit_trail',
    description: 'Retrieves the most recent database modifications, status changes, or operational logs from the audit_logs collection.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of recent audit events to view (default 5, max 20).'
        }
      }
    }
  }
];

function parseObjectIdIfValid(filter: Record<string, any>): Record<string, any> {
  const transformed = { ...filter };
  if (
    transformed._id &&
    typeof transformed._id === 'string' &&
    ObjectId.isValid(transformed._id) &&
    transformed._id.length === 24
  ) {
    transformed._id = new ObjectId(transformed._id);
  }
  return transformed;
}

function safeParseJson(val: any, fallback: any = {}): any {
  if (typeof val === 'object' && val !== null) return val;
  if (!val || typeof val !== 'string') return fallback;
  try {
    return JSON.parse(val);
  } catch {
    const cleaned = val.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  }
}

export async function executeTaskTool(name: string, args: any, adapter?: DatabaseAdapter): Promise<any> {
  const currentAdapter = adapter || defaultAdapter;
  const securityContext = (currentAdapter as any)?.securityContext;

  switch (name) {
    // --- Schema Discovery Tools ---
    case 'list_collections': {
      logger.tool('list_collections');
      const names = await currentAdapter.listCollections();
      logger.result(`Found collections: [${names.join(', ')}]`);
      return { collections: names };
    }

    case 'get_collection_schema': {
      const { collectionName } = args;
      logger.tool('get_collection_schema', `Collection: "${collectionName}"`);

      const schemaInfo = await currentAdapter.getCollectionSchema(collectionName);
      logger.result(`Inferred ${Object.keys(schemaInfo.fields).length} fields for "${collectionName}"`);

      return {
        collection: collectionName,
        schemaSummary: schemaInfo.schemaSummary || currentAdapter.formatSchemaForLLM(schemaInfo),
        schemaDetails: schemaInfo
      };
    }

    // --- Core Generic Structured Database Operation Tool ---
    case 'execute_task_operation': {
      const {
        type,
        collection,
        reason = 'No reason provided',
        confirmed = false,
        confirmationId
      } = args;

      const opType = (type || '').toLowerCase().trim();
      const colName = (collection || '').trim();

      if (!['insert', 'update', 'delete'].includes(opType)) {
        throw new Error(`Invalid operation type "${type}". Must be "insert", "update", or "delete".`);
      }

      // --- INSERT ---
      if (opType === 'insert') {
        const doc = safeParseJson(args.document, null);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new Error('Insert operation requires a valid JSON document object.');
        }

        if (!doc.createdAt) {
          doc.createdAt = new Date();
        }

        logger.tool('execute_task_operation:insert', `Collection: "${colName}"`);

        const insertResult = await currentAdapter.insert({
          collection: colName,
          document: doc
        });

        await currentAdapter.logAuditEvent({
          action: 'INSERT_DOCUMENT',
          collection: colName,
          insertedId: insertResult.insertedId,
          document: doc,
          reason
        });

        logger.result(`Inserted document into "${colName}" (ID: ${insertResult.insertedId})`);

        return {
          status: 'EXECUTED',
          success: true,
          action: 'insert',
          collection: colName,
          insertedId: insertResult.insertedId,
          message: `Successfully inserted new document into "${colName}" with ID: ${insertResult.insertedId}.`
        };
      }

      // --- UPDATE ---
      if (opType === 'update') {
        const rawFilter = safeParseJson(args.filter, {});
        const filter = parseObjectIdIfValid(rawFilter);
        const rawUpdate = safeParseJson(args.update, {});

        // Staged operation execution with confirmationId
        if (confirmationId) {
          const staged = confirmationManager.getAndConsume(confirmationId, {
            userId: securityContext?.userId,
            projectId: securityContext?.projectId,
            action: 'update',
            collection: colName,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
            update: Object.keys(rawUpdate).length > 0 ? rawUpdate : undefined
          });
          if (!staged) {
            throw new Error(`Confirmation ID "${confirmationId}" is invalid, expired, or parameters were tampered with. Please stage the operation again.`);
          }

          logger.tool('execute_task_operation:update_confirmed', `Collection: "${staged.collection}", ConfID: ${confirmationId}`);

          const updateResult = await currentAdapter.update({
            collection: staged.collection,
            filter: staged.filter || {},
            update: staged.update || {},
            multi: staged.multi
          });

          await currentAdapter.logAuditEvent({
            action: 'UPDATE_DOCUMENT',
            collection: staged.collection,
            filter: staged.filter,
            update: staged.update,
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount,
            reason: staged.reason,
            confirmationId
          });

          logger.result(`Executed confirmed update in "${staged.collection}" (${updateResult.modifiedCount} modified)`);

          return {
            status: 'EXECUTED',
            success: true,
            action: 'update',
            collection: staged.collection,
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount,
            message: `Successfully executed confirmed update in "${staged.collection}" (${updateResult.modifiedCount} document(s) modified).`
          };
        }

        // If NOT confirmed, stage for user confirmation
        if (!confirmed) {
          const matchedCount = await currentAdapter.count({ collection: colName, filter });
          if (matchedCount === 0) {
            return {
              status: 'NOT_FOUND',
              action: 'update',
              collection: colName,
              matchedCount: 0,
              message: `No documents found in "${colName}" matching filter ${JSON.stringify(rawFilter)}.`
            };
          }

          const previewDocs = await currentAdapter.find({ collection: colName, filter, limit: 3 });

          const staged = confirmationManager.stageOperation({
            userId: securityContext?.userId,
            projectId: securityContext?.projectId,
            action: 'update',
            collection: colName,
            filter,
            update: rawUpdate,
            matchedCount,
            previewDocuments: previewDocs.documents,
            reason
          });

          logger.warn(`Staged update requiring confirmation: ${staged.confirmationId} (${matchedCount} doc(s))`);

          return {
            status: 'REQUIRES_CONFIRMATION',
            confirmationRequired: true,
            confirmationId: staged.confirmationId,
            action: 'update',
            collection: colName,
            matchedCount,
            affectedDocumentsPreview: staged.previewDocuments,
            proposedUpdate: rawUpdate,
            reason,
            message: `CONFIRMATION REQUIRED: This operation will update ${matchedCount} document(s) in collection "${colName}". Please ask the user to confirm. Once confirmed, invoke execute_task_operation with confirmed: true and confirmationId: "${staged.confirmationId}".`
          };
        }

        // Direct execution when explicitly confirmed
        logger.tool('execute_task_operation:update_direct', `Collection: "${colName}", Filter: ${JSON.stringify(rawFilter)}`);

        const updateResult = await currentAdapter.update({
          collection: colName,
          filter,
          update: rawUpdate
        });

        await currentAdapter.logAuditEvent({
          action: 'UPDATE_DOCUMENT',
          collection: colName,
          filter: rawFilter,
          update: rawUpdate,
          matchedCount: updateResult.matchedCount,
          modifiedCount: updateResult.modifiedCount,
          reason
        });

        logger.result(`Updated document in "${colName}" (${updateResult.modifiedCount} modified)`);

        return {
          status: 'EXECUTED',
          success: true,
          action: 'update',
          collection: colName,
          matchedCount: updateResult.matchedCount,
          modifiedCount: updateResult.modifiedCount,
          message: `Successfully updated document in "${colName}".`
        };
      }

      // --- DELETE ---
      if (opType === 'delete') {
        const rawFilter = safeParseJson(args.filter, {});
        const filter = parseObjectIdIfValid(rawFilter);

        // Staged operation execution with confirmationId
        if (confirmationId) {
          const staged = confirmationManager.getAndConsume(confirmationId, {
            userId: securityContext?.userId,
            projectId: securityContext?.projectId,
            action: 'delete',
            collection: colName,
            filter: Object.keys(filter).length > 0 ? filter : undefined
          });
          if (!staged) {
            throw new Error(`Confirmation ID "${confirmationId}" is invalid, expired, or parameters were tampered with. Please stage the operation again.`);
          }

          logger.tool('execute_task_operation:delete_confirmed', `Collection: "${staged.collection}", ConfID: ${confirmationId}`);

          const deleteResult = await currentAdapter.delete({
            collection: staged.collection,
            filter: staged.filter || {}
          });

          await currentAdapter.logAuditEvent({
            action: 'DELETE_DOCUMENT',
            collection: staged.collection,
            filter: staged.filter,
            deletedCount: deleteResult.deletedCount,
            deletedPreview: staged.previewDocuments,
            reason: staged.reason,
            confirmationId
          });

          logger.result(`Executed confirmed deletion in "${staged.collection}" (${deleteResult.deletedCount} deleted)`);

          return {
            status: 'EXECUTED',
            success: true,
            action: 'delete',
            collection: staged.collection,
            deletedCount: deleteResult.deletedCount,
            message: `Successfully executed confirmed deletion in "${staged.collection}" (${deleteResult.deletedCount} document(s) deleted).`
          };
        }

        // If NOT confirmed, stage for user confirmation
        if (!confirmed) {
          const matchedCount = await currentAdapter.count({ collection: colName, filter });
          if (matchedCount === 0) {
            return {
              status: 'NOT_FOUND',
              action: 'delete',
              collection: colName,
              matchedCount: 0,
              message: `No documents found in "${colName}" matching filter ${JSON.stringify(rawFilter)}.`
            };
          }

          const previewDocs = await currentAdapter.find({ collection: colName, filter, limit: 3 });

          const staged = confirmationManager.stageOperation({
            userId: securityContext?.userId,
            projectId: securityContext?.projectId,
            action: 'delete',
            collection: colName,
            filter,
            matchedCount,
            previewDocuments: previewDocs.documents,
            reason
          });

          logger.warn(`Staged delete requiring confirmation: ${staged.confirmationId} (${matchedCount} doc(s))`);

          return {
            status: 'REQUIRES_CONFIRMATION',
            confirmationRequired: true,
            confirmationId: staged.confirmationId,
            action: 'delete',
            collection: colName,
            matchedCount,
            affectedDocumentsPreview: staged.previewDocuments,
            reason,
            message: `DANGER: CONFIRMATION REQUIRED: This operation will permanently delete ${matchedCount} document(s) from collection "${colName}". Please ask the user for explicit confirmation. Once confirmed, invoke execute_task_operation with confirmed: true and confirmationId: "${staged.confirmationId}".`
          };
        }

        // Direct execution when explicitly confirmed
        logger.tool('execute_task_operation:delete_direct', `Collection: "${colName}", Filter: ${JSON.stringify(rawFilter)}`);

        const deleteResult = await currentAdapter.delete({
          collection: colName,
          filter
        });

        await currentAdapter.logAuditEvent({
          action: 'DELETE_DOCUMENT',
          collection: colName,
          filter: rawFilter,
          deletedCount: deleteResult.deletedCount,
          reason
        });

        logger.result(`Deleted document(s) from "${colName}" (${deleteResult.deletedCount} deleted)`);

        return {
          status: 'EXECUTED',
          success: true,
          action: 'delete',
          collection: colName,
          deletedCount: deleteResult.deletedCount,
          message: `Successfully deleted document(s) from "${colName}".`
        };
      }

      throw new Error(`Unsupported operation type: "${type}"`);
    }

    // --- Convenience Generic Methods Delegating to execute_task_operation ---
    case 'update_document': {
      return await executeTaskTool(
        'execute_task_operation',
        {
          type: 'update',
          collection: args.collectionName,
          filter: args.filter,
          update: args.update,
          reason: args.reason || 'Direct document update',
          confirmed: args.confirmed ?? true,
          confirmationId: args.confirmationId
        },
        currentAdapter
      );
    }

    case 'insert_document': {
      return await executeTaskTool(
        'execute_task_operation',
        {
          type: 'insert',
          collection: args.collectionName,
          document: args.document,
          reason: args.reason || 'Direct document creation',
          confirmed: true
        },
        currentAdapter
      );
    }

    case 'delete_document': {
      return await executeTaskTool(
        'execute_task_operation',
        {
          type: 'delete',
          collection: args.collectionName,
          filter: args.filter,
          reason: args.reason,
          confirmed: args.confirmed ?? true,
          confirmationId: args.confirmationId
        },
        currentAdapter
      );
    }

    case 'view_audit_trail': {
      const { limit = 5 } = args;
      const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
      logger.tool('view_audit_trail', `Limit: ${safeLimit}`);

      const events = await currentAdapter.getRecentAuditEvents(safeLimit);
      logger.result(`Found ${events.length} audit event(s)`);

      return {
        count: events.length,
        auditLogs: events
      };
    }

    default:
      throw new Error(`Unknown operational task tool: "${name}"`);
  }
}
