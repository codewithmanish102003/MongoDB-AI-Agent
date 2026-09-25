import assert from 'node:assert/strict';
import { confirmationManager } from '../src/database/confirmation.js';
import { MongoDatabaseAdapter } from '../src/database/mongo-adapter.js';
import { DatabaseAdapter } from '../src/database/adapter.js';
import { executeQueryTool } from '../src/agents/query-agent/tools.js';
import { executeTaskTool } from '../src/agents/task-agent/tools.js';
import { executeRagTool } from '../src/agents/rag-agent/tools.js';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const TEST_DB_NAME = 'hardening_verification_test';

async function runHardeningTests() {
  console.log('--- Running Phase 9: Hardening, Tamper-Resistance & Abstraction Tests ---');

  // ========================================================
  // TEST 1: ACTION-BOUND CONFIRMATION MANAGER TAMPER RESISTANCE
  // ========================================================
  console.log('\n[Test 1] Testing Action-Bound Confirmation Manager Tamper Resistance...');

  const validContext = {
    userId: 'user_alice',
    projectId: 'proj_hospital'
  };

  const stagedOp = confirmationManager.stageOperation({
    action: 'update',
    collection: 'patients',
    filter: { patientId: 'PT-100' },
    update: { $set: { status: 'Discharged' } },
    reason: 'Doctor approved discharge',
    matchedCount: 1,
    multi: false,
    affectedDocumentsPreview: [{ patientId: 'PT-100', name: 'John Doe', status: 'Admitted' }],
    userId: validContext.userId,
    projectId: validContext.projectId
  });

  const confId = stagedOp.confirmationId;
  assert.ok(confId.startsWith('CONF-'));

  // Tamper 1: Attacker user_mallory attempts to redeem Alice's token
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: 'user_mallory',
        projectId: validContext.projectId,
        action: 'update',
        collection: 'patients',
        filter: { patientId: 'PT-100' },
        update: { $set: { status: 'Discharged' } }
      });
    },
    /Security violation: User "user_mallory" is not authorized to redeem this confirmation token/,
    'Should reject cross-user confirmation token theft'
  );
  console.log('✓ Rejected cross-user confirmation redemption attempt');

  // Tamper 2: Cross-project token re-use
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: validContext.userId,
        projectId: 'proj_other_fintech',
        action: 'update',
        collection: 'patients',
        filter: { patientId: 'PT-100' },
        update: { $set: { status: 'Discharged' } }
      });
    },
    /Security violation: Confirmation token was issued for project "proj_hospital"/,
    'Should reject cross-project confirmation redemption attempt'
  );
  console.log('✓ Rejected cross-project confirmation redemption attempt');

  // Tamper 3: Action tampering (e.g. staged update redeemed as delete)
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: validContext.userId,
        projectId: validContext.projectId,
        action: 'delete',
        collection: 'patients',
        filter: { patientId: 'PT-100' }
      });
    },
    /Security violation: Confirmation token action mismatch/,
    'Should reject action tampering'
  );
  console.log('✓ Rejected action-type tampering attempt');

  // Tamper 4: Collection tampering (redirecting update to a different collection)
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: validContext.userId,
        projectId: validContext.projectId,
        action: 'update',
        collection: 'admin_users',
        filter: { patientId: 'PT-100' },
        update: { $set: { status: 'Discharged' } }
      });
    },
    /Security violation: Confirmation token was issued for collection "patients"/,
    'Should reject collection tampering'
  );
  console.log('✓ Rejected collection tampering attempt');

  // Tamper 5: Payload tampering (modifying the update clause to gain privileges)
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: validContext.userId,
        projectId: validContext.projectId,
        action: 'update',
        collection: 'patients',
        filter: { patientId: 'PT-100' },
        update: { $set: { role: 'SuperAdmin' } }
      });
    },
    /Security violation: Update payload does not match the staged operation parameters/,
    'Should reject payload tampering'
  );
  console.log('✓ Rejected payload parameter tampering attempt');

  // Tamper 6: Filter tampering (expanding scope of update)
  assert.throws(
    () => {
      confirmationManager.getAndConsume(confId, {
        userId: validContext.userId,
        projectId: validContext.projectId,
        action: 'update',
        collection: 'patients',
        filter: {},
        update: { $set: { status: 'Discharged' } }
      });
    },
    /Security violation: Operation filter does not match the staged operation parameters/,
    'Should reject filter tampering'
  );
  console.log('✓ Rejected filter expansion tampering attempt');

  // Legitimate redemption succeeds
  const redeemed = confirmationManager.getAndConsume(confId, {
    userId: validContext.userId,
    projectId: validContext.projectId,
    action: 'update',
    collection: 'patients',
    filter: { patientId: 'PT-100' },
    update: { $set: { status: 'Discharged' } }
  });
  assert.ok(redeemed);
  assert.equal(redeemed.reason, 'Doctor approved discharge');
  console.log('✓ Authorized, untampered confirmation redeemed successfully');

  // Replay attempt with consumed token fails
  const replayAttempt = confirmationManager.getAndConsume(confId, {
    userId: validContext.userId,
    projectId: validContext.projectId,
    action: 'update',
    collection: 'patients',
    filter: { patientId: 'PT-100' },
    update: { $set: { status: 'Discharged' } }
  });
  assert.equal(replayAttempt, null);
  console.log('✓ Consumed confirmation token cannot be replayed (Single-Use Guarantee)');

  // ========================================================
  // TEST 2: RACE-FREE BOUNDED MULTI-UPDATE & MULTI-DELETE
  // ========================================================
  console.log('\n[Test 2] Testing Race-Free Bounded Write Safety in MongoDatabaseAdapter...');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(TEST_DB_NAME);
  await db.dropDatabase().catch(() => {});

  const adapter = new MongoDatabaseAdapter(db);

  // Seed 12 items
  const items = Array.from({ length: 12 }, (_, i) => ({
    sku: `SKU-${1000 + i}`,
    active: true,
    batch: 'BATCH-ALPHA',
    qty: 10
  }));
  await db.collection('inventory_bounded_test').insertMany(items);

  // Attempt multi-update exceeding MAX_UPDATE_DOCUMENTS (10)
  await assert.rejects(
    async () => {
      await adapter.update({
        collection: 'inventory_bounded_test',
        filter: { batch: 'BATCH-ALPHA' },
        update: { $set: { active: false } },
        multi: true
      });
    },
    /Safety threshold exceeded/,
    'Should reject update matching 12 documents when max is 10'
  );
  console.log('✓ Mass multi-update exceeding threshold safely blocked');

  // Attempt multi-delete exceeding MAX_DELETE_DOCUMENTS (5)
  await assert.rejects(
    async () => {
      await adapter.delete({
        collection: 'inventory_bounded_test',
        filter: { batch: 'BATCH-ALPHA' },
        multi: true
      });
    },
    /Safety threshold exceeded/,
    'Should reject delete matching 12 documents when max is 5'
  );
  console.log('✓ Mass multi-delete exceeding threshold safely blocked');

  // Bounded update targeting exact document IDs within limits
  const singleUpdate = await adapter.update({
    collection: 'inventory_bounded_test',
    filter: { sku: 'SKU-1000' },
    update: { $set: { qty: 25 } }
  });
  assert.equal(singleUpdate.matchedCount, 1);
  assert.equal(singleUpdate.modifiedCount, 1);
  console.log('✓ Targeted write safely executed and authoritatively confirmed');

  // ========================================================
  // TEST 3: ZERO RAW DB LEAKS ACROSS AGENT TOOLS
  // ========================================================
  console.log('\n[Test 3] Testing Zero Raw Db Leaks Across Query, Task, and RAG Tools...');

  // Create an adapter that strictly conforms to DatabaseAdapter and has NO getDb method
  const pureAdapter: DatabaseAdapter = {
    async listCollections() {
      return ['pure_orders', 'pure_customers'];
    },
    async getCollectionSchema(collectionName: string) {
      return {
        collectionName,
        isEmpty: false,
        fields: { id: 'string', name: 'string', total: 'number' },
        schemaSummary: `${collectionName}:\n  id: string\n  name: string\n  total: number\n`
      };
    },
    async getDatabaseSchema() {
      return {
        pure_orders: {
          collectionName: 'pure_orders',
          isEmpty: false,
          fields: { orderId: 'string', total: 'number' }
        }
      };
    },
    formatSchemaForLLM() {
      return 'pure_orders:\n  orderId: string\n  total: number\n';
    },
    async find() {
      return { documents: [{ id: 'ORD-1', name: 'Widget Alpha', total: 100 }], count: 1 };
    },
    async aggregate() {
      return { results: [{ _id: 'ALL', sum: 500 }], count: 1 };
    },
    async count() {
      return 1;
    },
    async insert() {
      return { insertedId: 'MOCK-ID-1', acknowledged: true };
    },
    async update() {
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async delete() {
      return { deletedCount: 1, acknowledged: true };
    },
    async logAuditEvent(entry) {
      return { ...entry, timestamp: new Date() };
    },
    async getRecentAuditEvents() {
      return [];
    }
  };

  assert.equal((pureAdapter as any).getDb, undefined, 'pureAdapter must NOT expose getDb');

  // Test executeQueryTool with pureAdapter
  const queryResult = await executeQueryTool('get_collection_schema', { collectionName: 'pure_orders' }, pureAdapter);
  assert.ok(queryResult.fields.id);
  console.log('✓ executeQueryTool operates without raw getDb access');

  // Test executeTaskTool with pureAdapter
  const taskResult = await executeTaskTool('execute_task_operation', {
    type: 'insert',
    collection: 'pure_orders',
    document: JSON.stringify({ id: 'ORD-2', name: 'Widget Beta', total: 200 })
  }, pureAdapter);
  assert.equal(taskResult.status, 'EXECUTED');
  console.log('✓ executeTaskTool operates without raw getDb access');

  // Test executeRagTool with pureAdapter
  const ragResult = await executeRagTool('semantic_search', {
    collectionName: 'pure_orders',
    query: 'Widget'
  }, pureAdapter);
  assert.ok(ragResult);
  console.log('✓ executeRagTool operates without raw getDb access');

  await db.dropDatabase().catch(() => {});
  await client.close();

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 9 HARDENING & TAMPER-RESISTANCE TESTS PASSED!');
  console.log('======================================================');
}

runHardeningTests().catch((err) => {
  console.error('Hardening verification failure:', err);
  process.exit(1);
});
