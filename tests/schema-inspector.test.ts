import { connectToDatabase, closeDatabase, getDatabase } from '../src/config/db.js';
import { SchemaInspector } from '../src/database/schema-inspector.js';

async function runSchemaInspectorTests() {
  console.log('--- Testing Phase 2: Automatic MongoDB Schema Discovery ---');
  await connectToDatabase();
  const db = getDatabase();

  const inspector = new SchemaInspector(db, { sampleSize: 5 });

  // 1. Setup temporary test collections
  const usersColName = 'temp_test_users';
  const postsColName = 'temp_test_posts';
  const emptyColName = 'temp_test_empty';

  const usersCol = db.collection(usersColName);
  const postsCol = db.collection(postsColName);
  const emptyCol = db.collection(emptyColName);

  await usersCol.deleteMany({});
  await postsCol.deleteMany({});
  await emptyCol.deleteMany({});

  // Insert mock users with nested fields, arrays, and inconsistent types across docs
  await usersCol.insertMany([
    {
      name: 'Alice Johnson',
      email: 'alice@example.com',
      age: 29, // number
      address: {
        city: 'New York',
        zipCode: '10001',
        coordinates: { lat: 40.71, lng: -74.0 }
      },
      roles: ['admin', 'editor'],
      createdAt: new Date('2024-01-10')
    },
    {
      name: 'Bob Smith',
      email: 'bob@example.com',
      age: '35', // string! Inconsistent type across docs
      address: {
        city: 'San Francisco',
        zipCode: '94103'
      },
      roles: ['viewer'],
      metadata: { lastLoginIp: '192.168.1.1' },
      createdAt: new Date('2024-02-15')
    }
  ]);

  // Create an index on email
  await usersCol.createIndex({ email: 1 }, { unique: true });

  // Insert mock posts
  await postsCol.insertMany([
    {
      title: 'Getting Started with MongoDB AI',
      tags: ['ai', 'mongodb', 'typescript'],
      views: 1200,
      isPublished: true,
      comments: [
        { author: 'Charlie', text: 'Great article!' }
      ],
      createdAt: new Date()
    }
  ]);

  // 2. Test inspectCollection on users
  console.log('\n[1] Inspecting collection with nested objects & inconsistent types...');
  const userSchema = await inspector.inspectCollection(usersColName);
  console.log('✔ Users collection inspected. Fields found:', Object.keys(userSchema.fields).length);
  console.log('  Fields summary:');
  for (const [k, v] of Object.entries(userSchema.fields)) {
    console.log(`    ${k}: ${v}`);
  }

  // Assertions for users
  if (!userSchema.fields['address.city']?.includes('string')) {
    throw new Error('Expected address.city to be detected as string');
  }
  if (!userSchema.fields['address.coordinates.lat']?.includes('number')) {
    throw new Error('Expected address.coordinates.lat to be detected as number');
  }
  if (!userSchema.fields['age']?.includes('number') || !userSchema.fields['age']?.includes('string')) {
    throw new Error(`Expected age to detect union type "number | string", got: ${userSchema.fields['age']}`);
  }
  if (!userSchema.fields['roles']?.includes('array')) {
    throw new Error('Expected roles to be detected as array');
  }

  // Index verification
  const emailIdx = userSchema.indexes.find((i) => i.keys.email !== undefined);
  console.log('✔ Indexes detected:', userSchema.indexes.map((i) => i.name).join(', '));
  if (!emailIdx || !emailIdx.unique) {
    throw new Error('Expected unique index on email');
  }

  // 3. Test inspectCollection on empty collection
  console.log('\n[2] Inspecting empty collection...');
  const emptySchema = await inspector.inspectCollection(emptyColName);
  console.log('✔ Empty collection handled gracefully:', emptySchema.isEmpty, 'Fields count:', Object.keys(emptySchema.fields).length);
  if (!emptySchema.isEmpty || Object.keys(emptySchema.fields).length !== 0) {
    throw new Error('Expected empty collection to report isEmpty: true with 0 fields');
  }

  // 4. Test inspectCollection on posts (arrays of objects)
  console.log('\n[3] Inspecting posts with arrays of objects...');
  const postSchema = await inspector.inspectCollection(postsColName);
  console.log('  Fields for posts:');
  for (const [k, v] of Object.entries(postSchema.fields)) {
    console.log(`    ${k}: ${v}`);
  }
  if (!postSchema.fields['comments[].author']?.includes('string')) {
    throw new Error('Expected comments[].author to be detected');
  }

  // 5. Test formatCollectionForLLM & formatReportForLLM
  console.log('\n[4] Testing LLM-ready prompt string formatting...');
  const formattedUser = inspector.formatCollectionForLLM(userSchema);
  console.log('--- Formatted Output for LLM ---');
  console.log(formattedUser.trim());
  console.log('--------------------------------');

  const report = await inspector.inspectDatabase([usersColName, postsColName, emptyColName]);
  const formattedReport = inspector.formatReportForLLM(report);
  console.log('\n--- Full Database LLM Report ---');
  console.log(formattedReport);
  console.log('--------------------------------');

  // Cleanup test collections
  await usersCol.drop().catch(() => {});
  await postsCol.drop().catch(() => {});
  await emptyCol.drop().catch(() => {});

  await closeDatabase();
  console.log('\n🎉 ALL PHASE 2 SCHEMA INSPECTION TESTS PASSED!\n');
}

runSchemaInspectorTests().catch(async (err) => {
  console.error('Schema Inspector test failed:', err);
  await closeDatabase();
  process.exit(1);
});
