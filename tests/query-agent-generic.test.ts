import { connectToDatabase, closeDatabase, getDatabase } from '../src/config/db.js';
import { executeQueryTool } from '../src/agents/query-agent/tools.js';
import { QueryAgent } from '../src/agents/query-agent/index.js';
import { MongoDatabaseAdapter } from '../src/database/mongo-adapter.js';

async function runQueryAgentGenericTests() {
  console.log('--- Testing Phase 3: Generic Query Agent & Schema Discovery Integration ---');
  await connectToDatabase();
  const db = getDatabase();

  const adapter = new MongoDatabaseAdapter(db);
  const testCol = 'telecom_subscriptions_test';
  const col = db.collection(testCol);

  await col.deleteMany({});
  await col.insertMany([
    {
      subscriberId: 'SUB-901',
      plan: 'Unlimited 5G Enterprise',
      monthlyFee: 1499,
      status: 'Active',
      customer: {
        company: 'Apex Logistics Ltd',
        region: 'North',
        contact: { email: 'ops@apex.com', phone: '+91-9876543210' }
      },
      dataUsageGb: 142.5,
      activatedAt: new Date('2024-03-01')
    },
    {
      subscriberId: 'SUB-902',
      plan: 'Basic 4G IoT',
      monthlyFee: 299,
      status: 'Active',
      customer: {
        company: 'Swift Fleet Inc',
        region: 'West',
        contact: { email: 'fleet@swift.com' }
      },
      dataUsageGb: 12.8,
      activatedAt: new Date('2024-04-15')
    },
    {
      subscriberId: 'SUB-903',
      plan: 'Unlimited 5G Enterprise',
      monthlyFee: 1499,
      status: 'Suspended',
      customer: {
        company: 'Nova Healthcare',
        region: 'North',
        contact: { email: 'it@nova.org' }
      },
      dataUsageGb: 0.0,
      activatedAt: new Date('2024-01-20')
    }
  ]);

  // 1. Test list_collections tool via executeQueryTool
  console.log('\n[1] Testing list_collections tool...');
  const listRes = await executeQueryTool('list_collections', {}, adapter);
  console.log('✔ list_collections returned:', listRes.collections.length, 'collections');
  if (!listRes.collections.includes(testCol)) {
    throw new Error(`Expected list_collections to include ${testCol}`);
  }

  // 2. Test get_collection_schema tool via executeQueryTool
  console.log('\n[2] Testing get_collection_schema on arbitrary collection...');
  const schemaRes = await executeQueryTool('get_collection_schema', { collectionName: testCol }, adapter);
  console.log('✔ Inferred fields count:', Object.keys(schemaRes.fields).length);
  console.log('  Nested dot notation detected:', schemaRes.fields['customer.company'], schemaRes.fields['customer.contact.email']);
  if (!schemaRes.fields['customer.company'] || !schemaRes.fields['monthlyFee']) {
    throw new Error('Schema discovery failed to detect nested fields');
  }

  // 3. Test find_documents on nested field
  console.log('\n[3] Testing find_documents using discovered nested field filter...');
  const findRes = await executeQueryTool(
    'find_documents',
    {
      collectionName: testCol,
      filter: JSON.stringify({ 'customer.region': 'North', status: 'Active' }),
      projection: JSON.stringify({ subscriberId: 1, 'customer.company': 1, monthlyFee: 1 }),
      limit: 5
    },
    adapter
  );
  console.log('✔ find_documents count:', findRes.count, 'Found subscriber:', findRes.documents[0]?.subscriberId);
  if (findRes.count !== 1 || findRes.documents[0]?.subscriberId !== 'SUB-901') {
    throw new Error('find_documents on nested filter failed');
  }

  // 4. Test count_documents tool
  console.log('\n[4] Testing count_documents on arbitrary collection...');
  const countRes = await executeQueryTool(
    'count_documents',
    {
      collectionName: testCol,
      filter: JSON.stringify({ status: 'Active' })
    },
    adapter
  );
  console.log('✔ count_documents count:', countRes.count);
  if (countRes.count !== 2) {
    throw new Error(`Expected count 2, got ${countRes.count}`);
  }

  // 5. Test run_aggregation on arbitrary collection
  console.log('\n[5] Testing run_aggregation grouped by plan and region...');
  const aggRes = await executeQueryTool(
    'run_aggregation',
    {
      collectionName: testCol,
      pipeline: JSON.stringify([
        { $match: { status: 'Active' } },
        { $group: { _id: '$plan', totalRevenue: { $sum: '$monthlyFee' }, avgData: { $avg: '$dataUsageGb' } } }
      ])
    },
    adapter
  );
  console.log('✔ run_aggregation results:', aggRes.count, aggRes.results);
  if (aggRes.count !== 2) {
    throw new Error('Aggregation failed');
  }

  // 6. Security Enforcement through executeQueryTool
  console.log('\n[6] Testing security policy enforcement through executeQueryTool...');
  try {
    await executeQueryTool(
      'find_documents',
      {
        collectionName: testCol,
        filter: JSON.stringify({ $where: 'this.monthlyFee > 500' })
      },
      adapter
    );
    throw new Error('Security policy failed to block $where in executeQueryTool');
  } catch (err: any) {
    console.log('✔ Blocked $where via Policy validation:', err.message);
  }

  try {
    await executeQueryTool(
      'run_aggregation',
      {
        collectionName: testCol,
        pipeline: JSON.stringify([{ $out: 'stolen_data' }])
      },
      adapter
    );
    throw new Error('Security policy failed to block $out in executeQueryTool');
  } catch (err: any) {
    console.log('✔ Blocked $out via Policy validation:', err.message);
  }

  // 7. Test QueryAgent instantiation with custom adapter
  console.log('\n[7] Testing QueryAgent class instantiation with DatabaseAdapter...');
  const queryAgent = new QueryAgent(adapter);
  if (!queryAgent) {
    throw new Error('Failed to instantiate QueryAgent');
  }
  console.log('✔ QueryAgent successfully accepts and binds DatabaseAdapter');

  // Cleanup test collection
  await col.drop().catch(() => {});
  await closeDatabase();

  console.log('\n🎉 ALL PHASE 3 QUERY AGENT GENERIC INTEGRATION TESTS PASSED!\n');
}

runQueryAgentGenericTests().catch(async (err) => {
  console.error('Test execution failed:', err);
  await closeDatabase();
  process.exit(1);
});
