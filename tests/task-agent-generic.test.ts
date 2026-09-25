import { connectToDatabase, closeDatabase, getDatabase } from '../src/config/db.js';
import { executeTaskTool } from '../src/agents/task-agent/tools.js';
import { confirmationManager } from '../src/database/confirmation.js';
import { MongoDatabaseAdapter } from '../src/database/mongo-adapter.js';

async function runTaskAgentGenericTests() {
  console.log('--- Testing Phase 4: Generic Task Operations & Safety Guardrails ---');
  await connectToDatabase();
  const db = getDatabase();
  const adapter = new MongoDatabaseAdapter(db);

  const testCol = 'manufacturing_inventory_test';
  const col = db.collection(testCol);
  const auditCol = db.collection('audit_logs');

  // Clean test collections
  await col.deleteMany({});
  await auditCol.deleteMany({ collection: testCol });

  console.log('\n[1] Testing Generic Insert Operation...');
  const insertDoc = {
    partNumber: 'PN-8801',
    description: 'Precision Hydraulic Bearing',
    stockLevel: 150,
    costPerUnit: 45.5,
    supplier: {
      name: 'HydroTech Global',
      country: 'Germany'
    },
    tags: ['bearings', 'hydraulics', 'critical']
  };

  const insertRes = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'insert',
      collection: testCol,
      document: JSON.stringify(insertDoc),
      reason: 'Initial stock intake for Q3'
    },
    adapter
  );

  console.log('Insert Result:', insertRes);
  if (!insertRes.success || !insertRes.insertedId || insertRes.status !== 'EXECUTED') {
    throw new Error('Generic insert operation failed!');
  }

  // Verify document exists in database
  const insertedRecord = await col.findOne({ partNumber: 'PN-8801' });
  if (!insertedRecord || insertedRecord.stockLevel !== 150) {
    throw new Error('Inserted document not found in MongoDB!');
  }
  console.log('✓ Successfully inserted and verified document in database.');

  // Verify audit log
  const insertAudit = await auditCol.findOne({
    action: 'INSERT_DOCUMENT',
    collection: testCol,
    'document.partNumber': 'PN-8801'
  });
  if (!insertAudit || insertAudit.reason !== 'Initial stock intake for Q3') {
    throw new Error('Audit log for insert was not recorded!');
  }
  console.log('✓ Verified audit log entry for insert operation.');

  // Add more documents for update and delete testing
  await col.insertMany([
    {
      partNumber: 'PN-8802',
      description: 'Pneumatic Actuator Valve',
      stockLevel: 45,
      costPerUnit: 120.0,
      tags: ['pneumatics', 'valves']
    },
    {
      partNumber: 'PN-8803',
      description: 'Defective Sensor Module',
      stockLevel: 0,
      costPerUnit: 15.0,
      tags: ['electrical', 'scrap']
    }
  ]);

  console.log('\n[2] Testing Update Operation - Safety Preview & Confirmation Protocol...');
  // Attempt update without confirmation
  const updateDryRunRes = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'update',
      collection: testCol,
      filter: JSON.stringify({ partNumber: 'PN-8802' }),
      update: JSON.stringify({ $set: { stockLevel: 75, status: 'Restocked' } }),
      reason: 'Received shipment from supplier'
    },
    adapter
  );

  console.log('Update Dry Run Result:', updateDryRunRes);
  if (
    updateDryRunRes.status !== 'REQUIRES_CONFIRMATION' ||
    !updateDryRunRes.confirmationRequired ||
    !updateDryRunRes.confirmationId ||
    updateDryRunRes.matchedCount !== 1
  ) {
    throw new Error('Update safety preview failed! Expected REQUIRES_CONFIRMATION status.');
  }

  // Check preview documents
  if (!updateDryRunRes.affectedDocumentsPreview || updateDryRunRes.affectedDocumentsPreview.length !== 1) {
    throw new Error('Missing preview documents in update dry-run!');
  }
  console.log('✓ Update successfully stopped for human confirmation with preview and confirmationId.');

  // Now execute with confirmationId
  const confId = updateDryRunRes.confirmationId;
  const updateConfirmedRes = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'update',
      collection: testCol,
      confirmed: true,
      confirmationId: confId,
      reason: 'Confirmed by manager'
    },
    adapter
  );

  console.log('Update Confirmed Result:', updateConfirmedRes);
  if (updateConfirmedRes.status !== 'EXECUTED' || updateConfirmedRes.modifiedCount !== 1) {
    throw new Error('Confirmed update execution failed!');
  }

  const updatedDoc = await col.findOne({ partNumber: 'PN-8802' });
  if (!updatedDoc || updatedDoc.stockLevel !== 75 || updatedDoc.status !== 'Restocked') {
    throw new Error('Updated document not reflected in database!');
  }
  console.log('✓ Successfully executed confirmed update in database.');

  // Verify that the consumed confirmationId cannot be reused
  const expiredAttempt = confirmationManager.getAndConsume(confId);
  if (expiredAttempt !== null) {
    throw new Error('Security flaw: Staged confirmationId was not consumed after execution!');
  }
  console.log('✓ Verified confirmation token replay protection (consumed token cannot be reused).');

  console.log('\n[3] Testing Delete Operation - Safety Preview & Confirmation Protocol...');
  // Attempt delete without confirmation
  const deleteDryRunRes = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'delete',
      collection: testCol,
      filter: JSON.stringify({ partNumber: 'PN-8803' }),
      reason: 'Scrap defective obsolete component'
    },
    adapter
  );

  console.log('Delete Dry Run Result:', deleteDryRunRes);
  if (
    deleteDryRunRes.status !== 'REQUIRES_CONFIRMATION' ||
    !deleteDryRunRes.confirmationRequired ||
    !deleteDryRunRes.confirmationId ||
    deleteDryRunRes.matchedCount !== 1
  ) {
    throw new Error('Delete safety preview failed! Expected REQUIRES_CONFIRMATION status.');
  }
  console.log('✓ Delete successfully stopped for human confirmation.');

  // Execute confirmed delete
  const deleteConfId = deleteDryRunRes.confirmationId;
  const deleteConfirmedRes = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'delete',
      collection: testCol,
      confirmed: true,
      confirmationId: deleteConfId,
      reason: 'Authorized scrap disposal'
    },
    adapter
  );

  console.log('Delete Confirmed Result:', deleteConfirmedRes);
  if (deleteConfirmedRes.status !== 'EXECUTED' || deleteConfirmedRes.deletedCount !== 1) {
    throw new Error('Confirmed delete execution failed!');
  }

  const deletedDoc = await col.findOne({ partNumber: 'PN-8803' });
  if (deletedDoc !== null) {
    throw new Error('Document still exists after confirmed delete!');
  }
  console.log('✓ Document successfully removed from database after confirmation.');

  console.log('\n[4] Testing Empty Filter Protection (Disallowing Unrestricted Updates/Deletes)...');
  try {
    await executeTaskTool(
      'execute_task_operation',
      {
        type: 'update',
        collection: testCol,
        filter: '{}',
        update: '{"$set": {"status": "Wiped"}}',
        confirmed: true,
        reason: 'Malicious or accidental wipe'
      },
      adapter
    );
    throw new Error('Security policy failed: Empty filter was permitted for update!');
  } catch (err: any) {
    console.log(`✓ Caught expected empty filter error for update: "${err.message}"`);
  }

  try {
    await executeTaskTool(
      'execute_task_operation',
      {
        type: 'delete',
        collection: testCol,
        filter: '   ',
        confirmed: true,
        reason: 'Accidental delete'
      },
      adapter
    );
    throw new Error('Security policy failed: Blank filter was permitted for delete!');
  } catch (err: any) {
    console.log(`✓ Caught expected empty filter error for delete: "${err.message}"`);
  }

  console.log('\n[5] Testing System Collection Protection Policy...');
  try {
    await executeTaskTool(
      'execute_task_operation',
      {
        type: 'delete',
        collection: 'audit_logs',
        filter: '{"_id": "test"}',
        confirmed: true,
        reason: 'Attempting to erase audit trail'
      },
      adapter
    );
    throw new Error('Security policy failed: Write to audit_logs was permitted!');
  } catch (err: any) {
    console.log(`✓ Caught expected protection error on audit_logs: "${err.message}"`);
  }

  console.log('\n[6] Testing Schema Discovery Tools in Task Agent...');
  const collectionsRes = await executeTaskTool('list_collections', {}, adapter);
  if (!collectionsRes.collections.includes(testCol)) {
    throw new Error('list_collections did not return test collection!');
  }
  console.log(`✓ list_collections returned: [${collectionsRes.collections.slice(0, 5).join(', ')}...]`);

  const schemaRes = await executeTaskTool('get_collection_schema', { collectionName: testCol }, adapter);
  if (!schemaRes.schemaDetails || !schemaRes.schemaDetails.fields['partNumber']) {
    throw new Error('get_collection_schema failed to discover partNumber field!');
  }
  console.log(`✓ get_collection_schema discovered fields: [${Object.keys(schemaRes.schemaDetails.fields).join(', ')}]`);

  console.log('\n[7] Testing view_audit_trail Tool...');
  const auditTrailRes = await executeTaskTool('view_audit_trail', { limit: 5 }, adapter);
  if (!auditTrailRes.auditLogs || auditTrailRes.auditLogs.length === 0) {
    throw new Error('view_audit_trail did not return any audit events!');
  }
  console.log(`✓ view_audit_trail returned ${auditTrailRes.count} recent audit records.`);

  // Cleanup
  await col.deleteMany({});
  await auditCol.deleteMany({ collection: testCol });
  await closeDatabase();

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 4 GENERIC TASK OPERATION TESTS PASSED!');
  console.log('======================================================');
}

runTaskAgentGenericTests().catch(async (err) => {
  console.error('\n❌ Phase 4 Test Failed:', err);
  try {
    await closeDatabase();
  } catch {}
  process.exit(1);
});
