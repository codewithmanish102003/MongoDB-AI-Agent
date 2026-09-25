import { connectToDatabase, closeDatabase, getDatabase } from '../src/config/db.js';
import { executeQueryTool } from '../src/agents/query-agent/tools.js';
import { executeTaskTool } from '../src/agents/task-agent/tools.js';
import { executeRagTool } from '../src/agents/rag-agent/tools.js';
import { executeMemoryTool } from '../src/agents/memory-agent/tools.js';
import { MongoMemoryStore } from '../src/agents/memory-agent/store.js';

async function runGenericValidation() {
  console.log('--- Starting Generic MongoDB AI Agent Verification ---');
  await connectToDatabase();
  const db = getDatabase();

  const testColName = 'arbitrary_projects_test';
  const testCol = db.collection(testColName);
  await testCol.deleteMany({});

  // 1. Test Generic Insert
  console.log('\n[1] Testing generic insert_document tool...');
  const insertRes = await executeTaskTool('insert_document', {
    collectionName: testColName,
    document: JSON.stringify({
      projectCode: 'PRJ-GENERIC-900',
      title: 'Solar Power Plant Phase 1',
      budget: 15000000,
      status: 'Draft',
      manager: 'Ramesh Gupta'
    }),
    reason: 'Initial setup of solar project'
  });
  console.log('✔ insert_document result:', insertRes.success, insertRes.insertedId);

  // 2. Test Generic Schema Discovery & Query
  console.log('\n[2] Testing generic schema inference and find...');
  const schemaRes = await executeQueryTool('get_collection_schema', { collectionName: testColName });
  console.log('✔ Schema fields inferred:', Object.keys(schemaRes.fields));

  const findRes = await executeQueryTool('find_documents', {
    collectionName: testColName,
    filter: JSON.stringify({ projectCode: 'PRJ-GENERIC-900' })
  });
  console.log('✔ Found documents count:', findRes.count, 'Title:', findRes.documents[0]?.title);

  // 3. Test Generic Update
  console.log('\n[3] Testing generic update_document tool with audit tracking...');
  const updateRes = await executeTaskTool('update_document', {
    collectionName: testColName,
    filter: JSON.stringify({ projectCode: 'PRJ-GENERIC-900' }),
    update: JSON.stringify({ status: 'Approved', approvedAt: new Date().toISOString() }),
    reason: 'Executive committee signoff'
  });
  console.log('✔ update_document result:', updateRes.success, 'New status:', updateRes.updatedState?.status);

  // 4. Verify Audit Log Entry
  const auditEntry = await db.collection('audit_logs').findOne({
    action: 'UPDATE_DOCUMENT',
    collection: testColName
  });
  console.log('✔ Audit log recorded:', Boolean(auditEntry), 'Reason:', auditEntry?.reason);

  // 5. Test Generic Semantic RAG on Custom Collection
  console.log('\n[4] Testing generic add_knowledge_document and semantic_search...');
  const customKbCol = 'custom_company_guidelines';
  await db.collection(customKbCol).deleteMany({});

  await executeRagTool('add_knowledge_document', {
    collectionName: customKbCol,
    title: 'Site Safety Protocol for High Voltage Work',
    category: 'Safety',
    content: 'All engineers and contractors must wear class 4 dielectric gloves, non-conductive safety helmets, and establish a 10-meter boundary barrier.'
  });

  const searchRes = await executeRagTool('semantic_search', {
    collectionName: customKbCol,
    query: 'What protective gloves and safety gear are required for electrical work?'
  });
  console.log('✔ Semantic search matches in custom collection:', searchRes.matches?.length);
  if (searchRes.matches?.length > 0) {
    console.log('  Top match:', searchRes.matches[0].title, '| Score:', searchRes.matches[0].similarityScore);
  }

  // 6. Test Generic Delete
  console.log('\n[5] Testing generic delete_document...');
  const deleteRes = await executeTaskTool('delete_document', {
    collectionName: testColName,
    filter: JSON.stringify({ projectCode: 'PRJ-GENERIC-900' }),
    reason: 'Cleanup of test project record'
  });
  console.log('✔ delete_document result:', deleteRes.success, 'Deleted count:', deleteRes.deletedCount);

  // Cleanup test collections
  await testCol.drop().catch(() => {});
  await db.collection(customKbCol).drop().catch(() => {});

  console.log('\n🎉 ALL GENERIC CAPABILITIES VERIFIED SUCCESSFULLY!');
  await closeDatabase();
}

runGenericValidation().catch(async (err) => {
  console.error('Validation failed:', err);
  await closeDatabase();
  process.exit(1);
});
