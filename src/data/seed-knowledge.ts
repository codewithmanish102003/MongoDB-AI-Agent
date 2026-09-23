import { connectToDatabase, closeDatabase } from '../config/db.js';
import { generateEmbedding } from '../llm/embeddings.js';
import { logger } from '../utils/logger.js';

const KNOWLEDGE_DOCS = [
  {
    docId: 'KB-001',
    category: 'Returns & Refunds',
    title: '30-Day Return Policy and Refund Process',
    content: `Customers can return any product within 30 days of delivery if it is unused, in its original packaging with all tags intact. Once received and inspected at our warehouse, refunds are processed within 3 to 5 business days back to the original payment method (UPI, card, or bank account). Electronics must have original serial numbers intact.`
  },
  {
    docId: 'KB-002',
    category: 'Warranty & Repairs',
    title: 'Comprehensive 1-Year Manufacturer Warranty',
    content: `All electronic items including headphones, monitors, and mechanical keyboards come with a standard 1-year manufacturer warranty covering internal hardware defects and manufacturing faults. Accidental physical damage or water exposure is not covered under standard warranty. Claims can be filed via support email with invoice proof.`
  },
  {
    docId: 'KB-003',
    category: 'Shipping & Delivery',
    title: 'Standard & Express Shipping Timelines',
    content: `We provide free standard shipping across India on orders above ₹999, typically delivered within 3 to 5 business days. Express next-day delivery is available for metro cities (Mumbai, Delhi, Bengaluru, Pune) for a flat fee of ₹150. Live tracking links are shared via SMS and email upon dispatch.`
  },
  {
    docId: 'KB-004',
    category: 'Payment Methods',
    title: 'Accepted Payment Modes and Security',
    content: `We support 100% secure payments via UPI (Google Pay, PhonePe, Paytm), Visa/Mastercard Credit and Debit Cards, Net Banking across 50+ banks, and Cash on Delivery (COD) for orders up to ₹10,000. All transactions are encrypted with 256-bit SSL.`
  },
  {
    docId: 'KB-005',
    category: 'Loyalty Program',
    title: 'Customer Loyalty Tiers and Rewards',
    content: `Our customer club features three membership tiers: Silver, Gold, and Platinum. Silver members get 2% cashback points. Gold members get 5% cashback, free standard shipping, and early access to sales. Platinum members enjoy 10% points back, priority customer support, and free express shipping.`
  }
];

export async function seedKnowledgeAndEmbeddings() {
  const { db } = await connectToDatabase();
  logger.info('Seeding knowledge base and generating vector embeddings...');

  // 1. Seed Knowledge Base with Embeddings
  const kbCollection = db.collection('knowledge_base');
  await kbCollection.deleteMany({});

  for (const doc of KNOWLEDGE_DOCS) {
    logger.info(`Generating embedding for KB document: "${doc.title}"...`);
    const embedding = await generateEmbedding(`${doc.title}\nCategory: ${doc.category}\n${doc.content}`);
    await kbCollection.insertOne({
      ...doc,
      embedding,
      updatedAt: new Date()
    });
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 600));
  }
  logger.success(`Seeded ${KNOWLEDGE_DOCS.length} documents into "knowledge_base" with embeddings!`);

  // 2. Enrich Products with Embeddings
  const productsCollection = db.collection('products');
  const products = await productsCollection.find({}).toArray();

  if (products.length > 0) {
    logger.info(`Generating vector embeddings for ${products.length} products in catalog...`);
    for (const p of products) {
      const description = `${p.name} (${p.category}). Price: ₹${p.price}. Tags: ${(p.tags || []).join(', ')}. Rating: ${p.rating}/5.`;
      logger.info(`Embedding product: "${p.name}"...`);
      const embedding = await generateEmbedding(description);
      await productsCollection.updateOne(
        { _id: p._id },
        { $set: { embedding, searchDescription: description } }
      );
      await new Promise(r => setTimeout(r, 600));
    }
    logger.success(`Updated ${products.length} products with vector embeddings!`);
  }
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-knowledge.ts')) {
  seedKnowledgeAndEmbeddings()
    .catch(err => logger.error('Vector seeding failed', err))
    .finally(() => closeDatabase());
}
