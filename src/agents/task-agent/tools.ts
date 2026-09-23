import { DatabaseAdapter } from '../../database/adapter.js';
import { MongoDatabaseAdapter } from '../../database/mongo-adapter.js';
import { confirmationManager } from '../../database/confirmation.js';
import { SchemaInspector } from '../../database/schema-inspector.js';
import { AuditLogger, defaultAuditLogger } from '../../database/audit-logger.js';
import { getDatabase } from '../../config/db.js';
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
  },

  // --- Specialized / E-Commerce Operations (Retained for Backward Compatibility) ---
  {
    name: 'update_order_status',
    description: 'Specialized order status updater for e-commerce orders. Automatically handles inventory restocking if cancelled.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: {
          type: Type.STRING,
          description: 'The unique order ID (e.g. "ORD-5003").'
        },
        newStatus: {
          type: Type.STRING,
          description: 'New status: "pending", "processing", "shipped", "delivered", or "cancelled".'
        },
        reason: {
          type: Type.STRING,
          description: 'Reason for the status change.'
        }
      },
      required: ['orderId', 'newStatus']
    }
  },
  {
    name: 'adjust_product_inventory',
    description: 'Specialized product inventory adjustment with safety checks against negative stock.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sku: {
          type: Type.STRING,
          description: 'Product SKU (e.g. "PROD-101", "PROD-104").'
        },
        quantityChange: {
          type: Type.INTEGER,
          description: 'Number to add (e.g. +10) or deduct (e.g. -5).'
        },
        reason: {
          type: Type.STRING,
          description: 'Reason for manual stock adjustment.'
        }
      },
      required: ['sku', 'quantityChange']
    }
  },
  {
    name: 'create_new_order',
    description: 'Places a new customer order with inventory deduction and audit logging.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customerId: {
          type: Type.STRING,
          description: 'Customer ID (e.g. "CUST-001", "CUST-002").'
        },
        items: {
          type: Type.STRING,
          description: 'JSON array of items to order, each with sku and quantity. Example: \'[{"sku": "PROD-104", "quantity": 2}]\''
        },
        paymentMethod: {
          type: Type.STRING,
          description: 'Payment mode: "UPI", "Credit Card", "Debit Card", or "COD".'
        }
      },
      required: ['customerId', 'items', 'paymentMethod']
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
  let auditLogger: AuditLogger = defaultAuditLogger;
  let db: any = null;
  if (currentAdapter instanceof MongoDatabaseAdapter) {
    try {
      db = currentAdapter.getDb();
      auditLogger = new AuditLogger(db);
    } catch {}
  }
  if (!db) {
    try {
      db = getDatabase();
      auditLogger = new AuditLogger(db);
    } catch {}
  }

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

      const dbInstance = (currentAdapter as any)?.getDb?.();
      const inspector = new SchemaInspector(dbInstance);
      const schemaInfo = await inspector.inspectCollection(collectionName);
      const schemaSummary = inspector.formatCollectionForLLM(schemaInfo);

      logger.result(`Inferred ${Object.keys(schemaInfo.fields).length} fields for "${collectionName}"`);

      return {
        collection: collectionName,
        schemaSummary,
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

        await auditLogger.logEvent({
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
        // Staged operation execution with confirmationId
        if (confirmationId) {
          const staged = confirmationManager.getAndConsume(confirmationId);
          if (!staged) {
            throw new Error(`Confirmation ID "${confirmationId}" is invalid or expired. Please stage the operation again.`);
          }

          logger.tool('execute_task_operation:update_confirmed', `Collection: "${staged.collection}", ConfID: ${confirmationId}`);

          const updateResult = await currentAdapter.update({
            collection: staged.collection,
            filter: staged.filter || {},
            update: staged.update || {},
            multi: staged.multi
          });

          await auditLogger.logEvent({
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

        const rawFilter = safeParseJson(args.filter, {});
        const filter = parseObjectIdIfValid(rawFilter);
        const rawUpdate = safeParseJson(args.update, {});

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

        await auditLogger.logEvent({
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
        // Staged operation execution with confirmationId
        if (confirmationId) {
          const staged = confirmationManager.getAndConsume(confirmationId);
          if (!staged) {
            throw new Error(`Confirmation ID "${confirmationId}" is invalid or expired. Please stage the operation again.`);
          }

          logger.tool('execute_task_operation:delete_confirmed', `Collection: "${staged.collection}", ConfID: ${confirmationId}`);

          const deleteResult = await currentAdapter.delete({
            collection: staged.collection,
            filter: staged.filter || {}
          });

          await auditLogger.logEvent({
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

        const rawFilter = safeParseJson(args.filter, {});
        const filter = parseObjectIdIfValid(rawFilter);

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

        await auditLogger.logEvent({
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

      const events = await auditLogger.getRecentEvents(safeLimit);
      logger.result(`Found ${events.length} audit event(s)`);

      return {
        count: events.length,
        auditLogs: events
      };
    }

    // --- Specialized E-Commerce Operations (Legacy Compatibility) ---
    case 'update_order_status': {
      const { orderId, newStatus, reason = 'No reason provided' } = args;
      const normalizedStatus = newStatus.toLowerCase().trim();
      const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

      if (!validStatuses.includes(normalizedStatus)) {
        throw new Error(`Invalid status: "${newStatus}". Must be one of: ${validStatuses.join(', ')}`);
      }

      logger.tool('update_order_status', `Order: "${orderId}" -> "${normalizedStatus}"`);

      const ordersCol = db.collection('orders');
      const order = await ordersCol.findOne({ orderId });

      if (!order) {
        throw new Error(`Order "${orderId}" not found in database.`);
      }

      const previousStatus = order.status;

      if (normalizedStatus === 'cancelled' && (previousStatus === 'shipped' || previousStatus === 'delivered')) {
        throw new Error(
          `Action Rejected: Order "${orderId}" is already ${previousStatus} and cannot be cancelled directly. Please initiate a return request instead.`
        );
      }

      await ordersCol.updateOne(
        { orderId },
        {
          $set: {
            status: normalizedStatus,
            updatedAt: new Date(),
            statusChangeReason: reason
          }
        }
      );

      let restockedItems: any[] = [];
      if (normalizedStatus === 'cancelled' && previousStatus !== 'cancelled') {
        const productsCol = db.collection('products');
        for (const item of order.items || []) {
          await productsCol.updateOne(
            { sku: item.sku },
            { $inc: { stock: item.quantity } }
          );
          restockedItems.push({ sku: item.sku, quantityRestored: item.quantity });
        }
        logger.result(`Restocked items for cancelled order: ${JSON.stringify(restockedItems)}`);
      }

      await auditLogger.logEvent({
        action: 'ORDER_STATUS_UPDATE',
        entityId: orderId,
        previousState: { status: previousStatus },
        newState: { status: normalizedStatus, restockedItems },
        reason
      });

      return {
        success: true,
        orderId,
        previousStatus,
        newStatus: normalizedStatus,
        restockedItems,
        message: `Order "${orderId}" successfully updated from "${previousStatus}" to "${normalizedStatus}".`
      };
    }

    case 'adjust_product_inventory': {
      const { sku, quantityChange, reason = 'Manual inventory adjustment' } = args;
      const changeNum = Number(quantityChange);

      if (isNaN(changeNum) || changeNum === 0) {
        throw new Error('quantityChange must be a non-zero integer.');
      }

      logger.tool('adjust_product_inventory', `SKU: "${sku}", Change: ${changeNum > 0 ? `+${changeNum}` : changeNum}`);

      const productsCol = db.collection('products');
      const product = await productsCol.findOne({ sku });

      if (!product) {
        throw new Error(`Product with SKU "${sku}" not found.`);
      }

      const previousStock = product.stock || 0;
      const newStock = previousStock + changeNum;

      if (newStock < 0) {
        throw new Error(`Stock deduction rejected: Current stock is ${previousStock}, cannot deduct ${Math.abs(changeNum)} (negative inventory prohibited).`);
      }

      await productsCol.updateOne({ sku }, { $set: { stock: newStock, updatedAt: new Date() } });

      await auditLogger.logEvent({
        action: 'INVENTORY_ADJUSTMENT',
        entityId: sku,
        previousState: { stock: previousStock },
        newState: { stock: newStock },
        metadata: { quantityChange: changeNum },
        reason
      });

      logger.result(`Updated SKU "${sku}" stock: ${previousStock} -> ${newStock}`);

      return {
        success: true,
        sku,
        productName: product.name,
        previousStock,
        newStock,
        quantityChange: changeNum,
        message: `Stock for "${product.name}" (${sku}) updated to ${newStock}.`
      };
    }

    case 'create_new_order': {
      const { customerId, paymentMethod } = args;
      const itemsList = safeParseJson(args.items, []);

      if (!Array.isArray(itemsList) || itemsList.length === 0) {
        throw new Error('items must be a non-empty list of { sku, quantity }.');
      }

      logger.tool('create_new_order', `Customer: "${customerId}", Items: ${itemsList.length}`);

      const customersCol = db.collection('customers');
      const customer = await customersCol.findOne({ customerId });
      if (!customer) {
        throw new Error(`Customer "${customerId}" does not exist in database.`);
      }

      const productsCol = db.collection('products');
      let totalAmount = 0;
      const populatedItems = [];

      for (const item of itemsList) {
        const product = await productsCol.findOne({ sku: item.sku });
        if (!product) {
          throw new Error(`Product with SKU "${item.sku}" not found.`);
        }
        if ((product.stock || 0) < item.quantity) {
          throw new Error(`Insufficient stock for "${product.name}" (${item.sku}). Available: ${product.stock}, requested: ${item.quantity}.`);
        }

        const itemTotal = product.price * item.quantity;
        totalAmount += itemTotal;
        populatedItems.push({
          sku: product.sku,
          name: product.name,
          quantity: item.quantity,
          price: product.price
        });
      }

      for (const item of populatedItems) {
        await productsCol.updateOne(
          { sku: item.sku },
          { $inc: { stock: -item.quantity } }
        );
      }

      const count = await db.collection('orders').countDocuments();
      const orderId = `ORD-${5001 + count}`;

      const newOrderDoc = {
        orderId,
        customerId: customer.customerId,
        customerName: customer.name,
        items: populatedItems,
        totalAmount,
        status: 'pending',
        paymentMethod,
        orderDate: new Date()
      };

      await db.collection('orders').insertOne(newOrderDoc);

      await auditLogger.logEvent({
        action: 'ORDER_CREATION',
        entityId: orderId,
        metadata: { customer: customer.name, totalAmount, itemsCount: populatedItems.length },
        reason: 'Order placed by customer'
      });

      logger.result(`Created order "${orderId}" for ${customer.name} (Total: ₹${totalAmount})`);

      return {
        success: true,
        orderId,
        customerName: customer.name,
        totalAmount,
        items: populatedItems,
        status: 'pending',
        message: `Order "${orderId}" placed successfully for ${customer.name}. Total: ₹${totalAmount}.`
      };
    }

    default:
      throw new Error(`Unknown operational task tool: "${name}"`);
  }
}
