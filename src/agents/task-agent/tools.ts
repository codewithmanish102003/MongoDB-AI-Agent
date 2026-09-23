import { getDatabase } from '../../config/db.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

export const taskAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'update_order_status',
    description: 'Updates an order status (e.g. pending, processing, shipped, delivered, cancelled). Automatically handles inventory restocking if cancelled.',
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
    description: 'Increases or decreases product stock quantity in MongoDB with safety checks against negative inventory.',
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
    description: 'Places a new customer order, checks product stock availability, auto-deducts inventory, and records the order.',
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
  },
  {
    name: 'view_audit_trail',
    description: 'Retrieves the most recent database modifications, orders, or stock changes from the audit_logs collection.',
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

function safeParseJson(val: any, fallback: any = []): any {
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
