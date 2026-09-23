import { getDatabase } from '../../config/db.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';
import { ObjectId } from 'mongodb';

export const taskAgentFunctionDeclarations: FunctionDeclaration[] = [
  // --- Generic Database Operational Tools (Applicable to ANY collection) ---
  {
    name: 'update_document',
    description: 'Safely updates one or more documents in ANY collection matching a specific filter. Automatically records the change in audit_logs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to update (e.g. "projects", "vendors", "invoices", "orders", "users").'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string for filter query matching target document (e.g. \'{"code": "PRJ-101"}\' or \'{"_id": "..."}\'). Empty filter is disallowed.'
        },
        update: {
          type: Type.STRING,
          description: 'JSON string of update operators (e.g. \'{"$set": {"status": "Active", "updatedAt": "2026-09-23"}}\') or plain fields to set.'
        },
        reason: {
          type: Type.STRING,
          description: 'Reason for performing this database update.'
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

const RESTRICTED_SYSTEM_COLLECTIONS = ['sessions', 'chat_messages', 'user_memories', 'audit_logs'];

function parseObjectIdIfValid(filter: Record<string, any>): Record<string, any> {
  const transformed = { ...filter };
  if (transformed._id && typeof transformed._id === 'string' && ObjectId.isValid(transformed._id) && transformed._id.length === 24) {
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

export async function executeTaskTool(name: string, args: any): Promise<any> {
  const db = getDatabase();
  const auditCol = db.collection('audit_logs');

  switch (name) {
    // --- Generic Operational Database Tools ---
    case 'update_document': {
      const { collectionName, reason = 'No reason provided' } = args;
      const colName = collectionName?.trim();
      if (!colName) throw new Error('collectionName is required.');
      if (RESTRICTED_SYSTEM_COLLECTIONS.includes(colName) || colName.startsWith('system.')) {
        throw new Error(`Security restriction: direct modification of internal collection "${colName}" is disallowed.`);
      }

      const rawFilter = safeParseJson(args.filter, {});
      const filter = parseObjectIdIfValid(rawFilter);

      if (!filter || Object.keys(filter).length === 0) {
        throw new Error('Safety violation: An empty filter {} is not allowed for update operations to prevent whole-collection modifications.');
      }

      const rawUpdate = safeParseJson(args.update, {});
      if (!rawUpdate || Object.keys(rawUpdate).length === 0) {
        throw new Error('Update payload must be a non-empty JSON object.');
      }

      const hasOperators = Object.keys(rawUpdate).some((k) => k.startsWith('$'));
      const updatePayload = hasOperators ? rawUpdate : { $set: rawUpdate };

      logger.tool('update_document', `Collection: "${colName}", Filter: ${JSON.stringify(rawFilter)}`);

      const col = db.collection(colName);
      const previousDoc = await col.findOne(filter);

      if (!previousDoc) {
        return {
          success: false,
          collection: colName,
          message: `No document found in "${colName}" matching filter ${JSON.stringify(rawFilter)}.`
        };
      }

      const result = await col.updateOne(filter, updatePayload);
      const updatedDoc = await col.findOne(filter);

      await auditCol.insertOne({
        action: 'UPDATE_DOCUMENT',
        collection: colName,
        filter: rawFilter,
        previousState: previousDoc,
        newState: updatedDoc,
        reason,
        timestamp: new Date()
      });

      logger.result(`Updated document in "${colName}" (matched: ${result.matchedCount}, modified: ${result.modifiedCount})`);

      return {
        success: true,
        collection: colName,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        previousState: previousDoc,
        updatedState: updatedDoc,
        message: `Successfully updated document in "${colName}".`
      };
    }

    case 'insert_document': {
      const { collectionName, reason = 'Direct document creation' } = args;
      const colName = collectionName?.trim();
      if (!colName) throw new Error('collectionName is required.');
      if (RESTRICTED_SYSTEM_COLLECTIONS.includes(colName) || colName.startsWith('system.')) {
        throw new Error(`Security restriction: direct insertion into internal collection "${colName}" is disallowed.`);
      }

      const doc = safeParseJson(args.document, null);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('Document must be a valid JSON object.');
      }

      if (!doc.createdAt) {
        doc.createdAt = new Date();
      }

      logger.tool('insert_document', `Collection: "${colName}"`);

      const col = db.collection(colName);
      const result = await col.insertOne(doc);

      await auditCol.insertOne({
        action: 'INSERT_DOCUMENT',
        collection: colName,
        insertedId: result.insertedId,
        document: doc,
        reason,
        timestamp: new Date()
      });

      logger.result(`Inserted new document in "${colName}" with ID: ${result.insertedId}`);

      return {
        success: true,
        collection: colName,
        insertedId: result.insertedId,
        message: `Document inserted into "${colName}" with ID ${result.insertedId}.`
      };
    }

    case 'delete_document': {
      const { collectionName, reason } = args;
      const colName = collectionName?.trim();
      if (!colName) throw new Error('collectionName is required.');
      if (RESTRICTED_SYSTEM_COLLECTIONS.includes(colName) || colName.startsWith('system.')) {
        throw new Error(`Security restriction: direct deletion from internal collection "${colName}" is disallowed.`);
      }

      const rawFilter = safeParseJson(args.filter, {});
      const filter = parseObjectIdIfValid(rawFilter);

      if (!filter || Object.keys(filter).length === 0) {
        throw new Error('Safety violation: An empty filter {} is not allowed for delete operations.');
      }

      if (!reason || reason.trim().length === 0) {
        throw new Error('A reason is mandatory for document deletion.');
      }

      logger.tool('delete_document', `Collection: "${colName}", Filter: ${JSON.stringify(rawFilter)}`);

      const col = db.collection(colName);
      const docToDelete = await col.findOne(filter);

      if (!docToDelete) {
        return {
          success: false,
          collection: colName,
          message: `No document found in "${colName}" matching filter ${JSON.stringify(rawFilter)}.`
        };
      }

      const result = await col.deleteOne(filter);

      await auditCol.insertOne({
        action: 'DELETE_DOCUMENT',
        collection: colName,
        filter: rawFilter,
        deletedDocument: docToDelete,
        reason,
        timestamp: new Date()
      });

      logger.result(`Deleted document from "${colName}" (deletedCount: ${result.deletedCount})`);

      return {
        success: true,
        collection: colName,
        deletedCount: result.deletedCount,
        deletedDocument: docToDelete,
        message: `Successfully deleted document from "${colName}".`
      };
    }

    // --- Specialized / E-Commerce Operations ---
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

      // Business rule: Cannot cancel shipped or delivered orders
      if (normalizedStatus === 'cancelled' && (previousStatus === 'shipped' || previousStatus === 'delivered')) {
        throw new Error(
          `Action Rejected: Order "${orderId}" is already ${previousStatus} and cannot be cancelled directly. Please initiate a return request instead.`
        );
      }

      // Update the order status
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

      // Automatic Restock if cancelled
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

      // Record Audit Trail
      await auditCol.insertOne({
        action: 'ORDER_STATUS_UPDATE',
        entityId: orderId,
        previousState: { status: previousStatus },
        newState: { status: normalizedStatus, restockedItems },
        reason,
        timestamp: new Date()
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

      await auditCol.insertOne({
        action: 'INVENTORY_ADJUSTMENT',
        entityId: sku,
        previousStock,
        newStock,
        quantityChange: changeNum,
        reason,
        timestamp: new Date()
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

      // Verify customer
      const customersCol = db.collection('customers');
      const customer = await customersCol.findOne({ customerId });
      if (!customer) {
        throw new Error(`Customer "${customerId}" does not exist in database.`);
      }

      // Verify and calculate products
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

      // Deduct inventory
      for (const item of populatedItems) {
        await productsCol.updateOne(
          { sku: item.sku },
          { $inc: { stock: -item.quantity } }
        );
      }

      // Generate Order ID
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

      // Audit entry
      await auditCol.insertOne({
        action: 'ORDER_CREATION',
        entityId: orderId,
        customer: customer.name,
        totalAmount,
        itemsCount: populatedItems.length,
        timestamp: new Date()
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

    case 'view_audit_trail': {
      const { limit = 5 } = args;
      const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
      logger.tool('view_audit_trail', `Limit: ${safeLimit}`);

      const events = await auditCol.find({}).sort({ timestamp: -1 }).limit(safeLimit).toArray();
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
