import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoDatabaseAdapter } from '../src/database/mongo-adapter.js';
import { executeQueryTool } from '../src/agents/query-agent/tools.js';
import { executeTaskTool } from '../src/agents/task-agent/tools.js';
import { projectManager } from '../src/projects/project-manager.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const TEST_DB_NAME = 'genericity_multi_schema_test';

async function runMultiSchemaTests() {
  console.log('--- Running Phase 9: Multi-Schema Genericity Verification ---');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(TEST_DB_NAME);

  // Clean up any existing collections
  await db.dropDatabase().catch(() => {});

  const adapter = new MongoDatabaseAdapter(db);

  try {
    // ========================================================
    // DOMAIN A: BLOG / CMS PLATFORM
    // ========================================================
    console.log('\n[Domain A: Blog / CMS Platform]');
    await db.collection('articles').insertMany([
      {
        slug: 'mongodb-ai-architectures',
        title: 'Modern AI Architectures with MongoDB',
        author: { name: 'Elena Rostova', handle: '@elena' },
        views: 1420,
        tags: ['mongodb', 'ai', 'cloud'],
        publishedAt: new Date('2026-01-15T10:00:00Z'),
        isDraft: false
      },
      {
        slug: 'prompt-injection-defense',
        title: 'Guarding Against Prompt Injections',
        author: { name: 'Marcus Vance', handle: '@mvance' },
        views: 890,
        tags: ['security', 'ai', 'owasp'],
        publishedAt: new Date('2026-02-10T14:30:00Z'),
        isDraft: false
      }
    ]);

    // Inspect Blog schema dynamically
    const blogSchema = await adapter.getCollectionSchema('articles');
    assert.equal(blogSchema.isEmpty, false);
    assert.ok(blogSchema.fields['slug']);
    assert.ok(blogSchema.fields['author.name']);
    assert.ok(blogSchema.fields['tags']);
    console.log('✓ Discovered Blog fields:', Object.keys(blogSchema.fields));

    // Dynamic find using query tool
    const blogFind = await executeQueryTool('find_documents', {
      collectionName: 'articles',
      filter: JSON.stringify({ 'tags': { $in: ['security'] } }),
      limit: 5
    }, adapter);
    assert.equal(blogFind.count, 1);
    assert.equal(blogFind.documents[0].slug, 'prompt-injection-defense');
    console.log('✓ Discovered Blog query succeeded:', blogFind.documents[0].title);

    // ========================================================
    // DOMAIN B: B2B CRM PIPELINE
    // ========================================================
    console.log('\n[Domain B: B2B CRM Pipeline]');
    await db.collection('deals').insertMany([
      {
        dealCode: 'DEAL-9901',
        company: 'Acme Corporation',
        stage: 'Negotiation',
        amount: 85000,
        currency: 'USD',
        rep: { id: 'REP-101', name: 'Rachel Green' },
        productsInterested: ['Enterprise License', '24/7 SLA Support']
      },
      {
        dealCode: 'DEAL-9902',
        company: 'Stark Industries',
        stage: 'Closed Won',
        amount: 250000,
        currency: 'USD',
        rep: { id: 'REP-102', name: 'Tony Stark' },
        productsInterested: ['Titanium Cloud', 'Defense Gateway']
      }
    ]);

    // Inspect CRM schema dynamically
    const crmSchema = await adapter.getCollectionSchema('deals');
    assert.equal(crmSchema.isEmpty, false);
    assert.ok(crmSchema.fields['dealCode']);
    assert.ok(crmSchema.fields['amount']);
    assert.ok(crmSchema.fields['stage']);
    assert.ok(crmSchema.fields['rep.name']);
    console.log('✓ Discovered CRM fields:', Object.keys(crmSchema.fields));

    // Dynamic aggregation on CRM deals
    const crmAgg = await executeQueryTool('run_aggregation', {
      collectionName: 'deals',
      pipeline: JSON.stringify([
        { $group: { _id: '$stage', totalRevenue: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { totalRevenue: -1 } }
      ])
    }, adapter);
    assert.equal(crmAgg.count, 2);
    console.log('✓ Discovered CRM aggregation succeeded:', crmAgg.results);

    // ========================================================
    // DOMAIN C: SCHOOL MANAGEMENT SYSTEM
    // ========================================================
    console.log('\n[Domain C: School Management System]');
    await db.collection('courses').insertMany([
      {
        courseCode: 'CS-401',
        title: 'Distributed Systems & Cloud Databases',
        instructor: 'Prof. Turing',
        credits: 4,
        enrolledStudentsCount: 38,
        syllabusModules: ['Consensus', 'Replication', 'Vector Clocks']
      },
      {
        courseCode: 'MATH-202',
        title: 'Linear Algebra & Vector Spaces',
        instructor: 'Prof. Gauss',
        credits: 3,
        enrolledStudentsCount: 65,
        syllabusModules: ['Matrices', 'Eigenvalues', 'PCA']
      }
    ]);

    // Inspect School schema dynamically
    const schoolSchema = await adapter.getCollectionSchema('courses');
    assert.equal(schoolSchema.isEmpty, false);
    assert.ok(schoolSchema.fields['courseCode']);
    assert.ok(schoolSchema.fields['enrolledStudentsCount']);
    assert.ok(schoolSchema.fields['syllabusModules']);
    console.log('✓ Discovered School fields:', Object.keys(schoolSchema.fields));

    // Dynamic update through generic task tool
    const updateRes = await executeTaskTool('execute_task_operation', {
      type: 'update',
      collection: 'courses',
      filter: JSON.stringify({ courseCode: 'CS-401' }),
      update: JSON.stringify({ $inc: { enrolledStudentsCount: 1 } }),
      confirmed: true,
      reason: 'Late student enrollment accepted'
    }, adapter);
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.modifiedCount, 1);

    const updatedCourse = await adapter.find({
      collection: 'courses',
      filter: { courseCode: 'CS-401' }
    });
    assert.equal(updatedCourse.documents[0].enrolledStudentsCount, 39);
    console.log('✓ Discovered School dynamic update confirmed: Enrolled count is now 39');

    // ========================================================
    // VERIFY DATABASE SCHEMA OVERVIEW
    // ========================================================
    const fullDbSchema = await adapter.getDatabaseSchema();
    const collectionNames = Object.keys(fullDbSchema);
    assert.ok(collectionNames.includes('articles'));
    assert.ok(collectionNames.includes('deals'));
    assert.ok(collectionNames.includes('courses'));
    assert.ok(collectionNames.includes('audit_logs'));

    const llmFormatted = adapter.formatSchemaForLLM(fullDbSchema);
    assert.ok(llmFormatted.includes('articles:'));
    assert.ok(llmFormatted.includes('deals:'));
    assert.ok(llmFormatted.includes('courses:'));
    console.log('\n✓ Formatted LLM Schema Summary across all 3 domains successfully generated.');

    console.log('\n======================================================');
    console.log('✅ ALL MULTI-SCHEMA GENERICITY TESTS PASSED!');
    console.log('======================================================');
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

runMultiSchemaTests().catch((err) => {
  console.error('Multi-schema test failure:', err);
  process.exit(1);
});
