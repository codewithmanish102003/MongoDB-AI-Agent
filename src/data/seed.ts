import { connectToDatabase, closeDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';

export async function seedDatabase() {
  const { db } = await connectToDatabase();

  logger.info('Starting sample data seeding...');

  // 1. Customers Collection
  const customers = db.collection('customers');
  await customers.deleteMany({});
  await customers.insertMany([
    {
      customerId: 'CUST-001',
      name: 'Aarav Sharma',
      email: 'aarav.sharma@example.com',
      city: 'Mumbai',
      tier: 'Platinum',
      joinedAt: new Date('2023-01-15')
    },
    {
      customerId: 'CUST-002',
      name: 'Priya Patel',
      email: 'priya.patel@example.com',
      city: 'Bengaluru',
      tier: 'Gold',
      joinedAt: new Date('2023-03-22')
    },
    {
      customerId: 'CUST-003',
      name: 'Rohan Mehta',
      email: 'rohan.mehta@example.com',
      city: 'Delhi',
      tier: 'Silver',
      joinedAt: new Date('2023-07-10')
    },
    {
      customerId: 'CUST-004',
      name: 'Ananya Verma',
      email: 'ananya.verma@example.com',
      city: 'Pune',
      tier: 'Gold',
      joinedAt: new Date('2023-11-05')
    },
    {
      customerId: 'CUST-005',
      name: 'Vikram Singh',
      email: 'vikram.singh@example.com',
      city: 'Jaipur',
      tier: 'Platinum',
      joinedAt: new Date('2024-02-18')
    }
  ]);

  // 2. Products Collection
  const products = db.collection('products');
  await products.deleteMany({});
  await products.insertMany([
    {
      sku: 'PROD-101',
      name: 'Noise-Cancelling Wireless Headphones',
      category: 'Electronics',
      price: 14999,
      stock: 35,
      rating: 4.7,
      tags: ['audio', 'wireless', 'bluetooth']
    },
    {
      sku: 'PROD-102',
      name: 'Mechanical Gaming Keyboard',
      category: 'Electronics',
      price: 6499,
      stock: 12,
      rating: 4.5,
      tags: ['gaming', 'rgb', 'accessories']
    },
    {
      sku: 'PROD-103',
      name: 'Ergonomic Office Chair',
      category: 'Furniture',
      price: 18500,
      stock: 8,
      rating: 4.8,
      tags: ['office', 'ergonomic', 'furniture']
    },
    {
      sku: 'PROD-104',
      name: 'Stainless Steel Water Bottle (1L)',
      category: 'Fitness',
      price: 899,
      stock: 120,
      rating: 4.3,
      tags: ['fitness', 'eco-friendly']
    },
    {
      sku: 'PROD-105',
      name: 'Ultra-Wide 4K Monitor 34-inch',
      category: 'Electronics',
      price: 42999,
      stock: 15,
      rating: 4.9,
      tags: ['display', '4k', 'gaming']
    },
    {
      sku: 'PROD-106',
      name: 'Standing Desk Converter',
      category: 'Furniture',
      price: 12499,
      stock: 22,
      rating: 4.4,
      tags: ['desk', 'workplace', 'furniture']
    }
  ]);

  // 3. Orders Collection
  const orders = db.collection('orders');
  await orders.deleteMany({});
  await orders.insertMany([
    {
      orderId: 'ORD-5001',
      customerId: 'CUST-001',
      customerName: 'Aarav Sharma',
      items: [
        { sku: 'PROD-105', name: 'Ultra-Wide 4K Monitor 34-inch', quantity: 1, price: 42999 },
        { sku: 'PROD-102', name: 'Mechanical Gaming Keyboard', quantity: 1, price: 6499 }
      ],
      totalAmount: 49498,
      status: 'delivered',
      paymentMethod: 'UPI',
      orderDate: new Date('2024-05-12T10:30:00Z')
    },
    {
      orderId: 'ORD-5002',
      customerId: 'CUST-002',
      customerName: 'Priya Patel',
      items: [
        { sku: 'PROD-101', name: 'Noise-Cancelling Wireless Headphones', quantity: 2, price: 14999 }
      ],
      totalAmount: 29998,
      status: 'delivered',
      paymentMethod: 'Credit Card',
      orderDate: new Date('2024-05-14T14:15:00Z')
    },
    {
      orderId: 'ORD-5003',
      customerId: 'CUST-003',
      customerName: 'Rohan Mehta',
      items: [
        { sku: 'PROD-104', name: 'Stainless Steel Water Bottle (1L)', quantity: 3, price: 899 }
      ],
      totalAmount: 2697,
      status: 'pending',
      paymentMethod: 'UPI',
      orderDate: new Date('2024-05-20T08:00:00Z')
    },
    {
      orderId: 'ORD-5004',
      customerId: 'CUST-004',
      customerName: 'Ananya Verma',
      items: [
        { sku: 'PROD-103', name: 'Ergonomic Office Chair', quantity: 1, price: 18500 },
        { sku: 'PROD-106', name: 'Standing Desk Converter', quantity: 1, price: 12499 }
      ],
      totalAmount: 30999,
      status: 'processing',
      paymentMethod: 'Net Banking',
      orderDate: new Date('2024-05-21T16:45:00Z')
    },
    {
      orderId: 'ORD-5005',
      customerId: 'CUST-005',
      customerName: 'Vikram Singh',
      items: [
        { sku: 'PROD-101', name: 'Noise-Cancelling Wireless Headphones', quantity: 1, price: 14999 },
        { sku: 'PROD-104', name: 'Stainless Steel Water Bottle (1L)', quantity: 2, price: 899 }
      ],
      totalAmount: 16797,
      status: 'shipped',
      paymentMethod: 'UPI',
      orderDate: new Date('2024-05-22T11:20:00Z')
    }
  ]);

  logger.success('Sample data successfully seeded into MongoDB!');
  logger.info('Created collections: customers (5), products (6), orders (5)');
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed.ts')) {
  seedDatabase()
    .catch((err) => logger.error('Seeding failed', err))
    .finally(() => closeDatabase());
}
