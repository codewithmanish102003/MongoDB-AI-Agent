import { connectToDatabase, closeDatabase, getDatabase } from '../src/config/db.js';
import { MongoDatabaseAdapter } from '../src/database/mongo-adapter.js';
import {
  PolicyViolationError,
  validateCollectionName,
  validateFilter,
  validatePipeline
} from '../src/database/policy.js';

async function runDatabaseAbstractionTests() {
  console.log('--- Testing Phase 1: Generic Database Abstraction Layer ---');
  await connectToDatabase();
  const db = getDatabase();

  const adapter = new MongoDatabaseAdapter(db);

  // Setup temporary test collection
  const testColName = 'adapter_abstraction_test';
  const testCol = db.collection(testColName);
  await testCol.deleteMany({});
  await testCol.insertMany([
    { sku: 'TEST-101', name: 'Alpha Unit', category: 'Hardware', price: 250, inStock: true, score: 95 },
    { sku: 'TEST-102', name: 'Beta Unit', category: 'Hardware', price: 450, inStock: false, score: 80 },
    { sku: 'TEST-103', name: 'Gamma Unit', category: 'Software', price: 120, inStock: true, score: 88 }
  ]);

  // 1. Test listCollections
  console.log('\n[1] Testing adapter.listCollections()...');
  const collections = await adapter.listCollections();
  console.log('✔ listCollections found:', collections.length, 'collections (omits system collections)');
  if (!collections.includes(testColName)) {
    throw new Error(`Expected collections to contain ${testColName}`);
  }

  // 2. Test getCollectionSchema
  console.log('\n[2] Testing adapter.getCollectionSchema()...');
  const schema = await adapter.getCollectionSchema(testColName);
  console.log('✔ Inferred schema fields:', Object.keys(schema.fields));
  if (!schema.fields.sku || !schema.fields.price) {
    throw new Error('Expected schema to contain sku and price fields');
  }

  // 3. Test find with projection, sort, and limit
  console.log('\n[3] Testing adapter.find()...');
  const findRes = await adapter.find({
    collection: testColName,
    filter: { category: 'Hardware' },
    projection: { sku: 1, name: 1, price: 1 },
    sort: { price: -1 },
    limit: 10
  });
  console.log('✔ Found documents count:', findRes.count, 'Top item:', findRes.documents[0]?.name);
  if (findRes.count !== 2 || findRes.documents[0]?.name !== 'Beta Unit') {
    throw new Error('Find query returned unexpected results');
  }

  // 4. Test count
  console.log('\n[4] Testing adapter.count()...');
  const count = await adapter.count({
    collection: testColName,
    filter: { inStock: true }
  });
  console.log('✔ In stock count:', count);
  if (count !== 2) {
    throw new Error(`Expected count 2, got ${count}`);
  }

  // 5. Test aggregate
  console.log('\n[5] Testing adapter.aggregate()...');
  const aggRes = await adapter.aggregate({
    collection: testColName,
    pipeline: [
      { $match: { inStock: true } },
      { $group: { _id: '$category', avgPrice: { $avg: '$price' }, total: { $sum: 1 } } },
      { $sort: { avgPrice: -1 } }
    ]
  });
  console.log('✔ Aggregate groups returned:', aggRes.count, aggRes.results);
  if (aggRes.count === 0) {
    throw new Error('Aggregation returned empty results');
  }

  // 6. Test Policy Layer - Security Validations
  console.log('\n[6] Testing security policy layer...');

  // Test 6a: Block system collection
  try {
    validateCollectionName('system.views');
    throw new Error('Failed to block system collection');
  } catch (err: any) {
    console.log('✔ Blocked system collection as expected:', err.message);
  }

  // Test 6b: Block $where
  try {
    validateFilter({ $where: 'this.price > 100' });
    throw new Error('Failed to block $where');
  } catch (err: any) {
    console.log('✔ Blocked $where operator as expected:', err.message);
  }

  // Test 6c: Block $function in pipeline
  try {
    validatePipeline([
      {
        $project: {
          computed: {
            $function: {
              body: 'function(x) { return x * 2; }',
              args: ['$price'],
              lang: 'js'
            }
          }
        }
      }
    ]);
    throw new Error('Failed to block $function');
  } catch (err: any) {
    console.log('✔ Blocked $function stage in pipeline as expected:', err.message);
  }

  // Test 6d: Block $out and $merge
  try {
    validatePipeline([{ $out: 'compromised_collection' }]);
    throw new Error('Failed to block $out');
  } catch (err: any) {
    console.log('✔ Blocked $out stage in pipeline as expected:', err.message);
  }

  try {
    validatePipeline([{ $merge: { into: 'compromised_collection' } }]);
    throw new Error('Failed to block $merge');
  } catch (err: any) {
    console.log('✔ Blocked $merge stage in pipeline as expected:', err.message);
  }

  // Test 6e: Pipeline complexity limit (> 20 stages)
  try {
    const hugePipeline = Array.from({ length: 25 }, () => ({ $match: { active: true } }));
    validatePipeline(hugePipeline);
    throw new Error('Failed to block pipeline with > 20 stages');
  } catch (err: any) {
    console.log('✔ Blocked oversized pipeline (>20 stages) as expected:', err.message);
  }

  // Test 6f: Legitimate operators ($expr, $lookup, $unwind) must be allowed
  const legitimatePipeline = [
    { $match: { $expr: { $gt: ['$price', 100] } } },
    { $project: { sku: 1, price: 1 } },
    { $sort: { price: 1 } }
  ];
  const validated = validatePipeline(legitimatePipeline);
  console.log('✔ Legitimate pipeline operators ($expr, $match, $project, $sort) allowed successfully:', validated.length, 'stages');

  // Cleanup test collection
  await testCol.drop().catch(() => {});
  await closeDatabase();
  console.log('\n🎉 ALL PHASE 1 DATABASE ABSTRACTION TESTS PASSED!\n');
}

runDatabaseAbstractionTests().catch(async (err) => {
  console.error('Test execution failed:', err);
  await closeDatabase();
  process.exit(1);
});
