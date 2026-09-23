import {
  ProjectManager,
  ConnectionManager,
  UnauthorizedSessionAccessError,
  MongoMemoryStore
} from '../src/index.js';
import { PolicyViolationError } from '../src/database/policy.js';
import { AuditLogger } from '../src/database/audit-logger.js';
import { getEnvConfig } from '../src/config/env.js';

async function runSecurityAuthorizationTests() {
  console.log('--- Testing Phase 6: Database Security & Authorization Guardrails ---');

  const config = getEnvConfig();
  const uri = config.MONGODB_URI;

  const cm = new ConnectionManager();
  const pm = new ProjectManager(cm);

  const testDbName = 'security_enforcement_test';
  const client = await cm.getClient(uri);
  const db = client.db(testDbName);

  // Ensure clean test database
  await db.dropDatabase();

  // =========================================================================
  // 1. Session & Memory Cross-User Scoping Isolation
  // =========================================================================
  console.log('\n[1] Testing Session & Memory Scoping (userId + sessionId Isolation)...');

  const aliceStore = new MongoMemoryStore('user_alice', db);
  const bobStore = new MongoMemoryStore('user_bob', db);

  const aliceSessionId = 'SESSION-ALICE-SECRET-777';

  // Alice creates session and writes messages
  const aliceSession = await aliceStore.getOrCreateSession(aliceSessionId);
  await aliceStore.saveMessage(aliceSessionId, 'user', 'Confidential financial forecast: Net profit 4.2M');
  await aliceStore.saveMessage(aliceSessionId, 'assistant', 'Understood, keeping this confidential.');

  console.log(`✓ Alice created session "${aliceSession.sessionId}".`);

  // Bob attempts to hijack Alice's session via getOrCreateSession
  try {
    await bobStore.getOrCreateSession(aliceSessionId);
    throw new Error('Security failure: Bob was able to access Alice\'s session!');
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError) {
      console.log(`✓ Caught expected UnauthorizedSessionAccessError on getOrCreateSession: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Bob attempts to inject messages into Alice's session
  try {
    await bobStore.saveMessage(aliceSessionId, 'user', 'Malicious injected prompt');
    throw new Error('Security failure: Bob was able to append message to Alice\'s session!');
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError) {
      console.log(`✓ Caught expected UnauthorizedSessionAccessError on saveMessage: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Bob attempts to read Alice's messages
  try {
    await bobStore.getRecentMessages(aliceSessionId);
    throw new Error('Security failure: Bob was able to read Alice\'s messages!');
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError) {
      console.log(`✓ Caught expected UnauthorizedSessionAccessError on getRecentMessages: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Alice reads her own messages -> Success
  const aliceMessages = await aliceStore.getRecentMessages(aliceSessionId);
  if (aliceMessages.length !== 2) {
    throw new Error(`Expected Alice to see 2 messages, saw ${aliceMessages.length}`);
  }
  console.log(`✓ Alice securely accessed her own ${aliceMessages.length} messages.`);

  // =========================================================================
  // 2. Role-Based Access Control (RBAC): readOnly vs readWrite Permissions
  // =========================================================================
  console.log('\n[2] Testing RBAC Permissions (readOnly vs readWrite)...');

  pm.registerProject({
    projectId: 'proj_financial_audit',
    name: 'Corporate Financial Audit Portal',
    connectionUri: uri,
    databaseName: testDbName,
    ownerId: 'user_cfo',
    allowedUserIds: ['user_auditor', 'user_accountant'],
    userRoles: {
      user_auditor: 'readOnly',
      user_accountant: 'readWrite'
    }
  });

  const auditorAdapter = await pm.getAdapter('user_auditor', 'proj_financial_audit');
  const accountantAdapter = await pm.getAdapter('user_accountant', 'proj_financial_audit');

  // Seed sample record as accountant
  await accountantAdapter.insert({
    collection: 'general_ledger',
    document: { entryId: 'GL-101', amount: 50000, description: 'Server hardware purchase' }
  });
  console.log('✓ Accountant (readWrite) successfully inserted ledger entry.');

  // Auditor attempts to read -> Allowed
  const auditorRead = await auditorAdapter.find({ collection: 'general_ledger' });
  if (auditorRead.count !== 1) {
    throw new Error('Auditor should have read access to general_ledger!');
  }
  console.log(`✓ Auditor (readOnly) successfully queried ${auditorRead.count} ledger entry.`);

  // Auditor attempts to insert -> Blocked
  try {
    await auditorAdapter.insert({
      collection: 'general_ledger',
      document: { entryId: 'GL-MALICIOUS', amount: 999999 }
    });
    throw new Error('Security failure: readOnly user was allowed to insert!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError on readOnly insert: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Auditor attempts to update -> Blocked
  try {
    await auditorAdapter.update({
      collection: 'general_ledger',
      filter: { entryId: 'GL-101' },
      update: { $set: { amount: 0 } }
    });
    throw new Error('Security failure: readOnly user was allowed to update!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError on readOnly update: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Auditor attempts to delete -> Blocked
  try {
    await auditorAdapter.delete({
      collection: 'general_ledger',
      filter: { entryId: 'GL-101' }
    });
    throw new Error('Security failure: readOnly user was allowed to delete!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError on readOnly delete: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // =========================================================================
  // 3. Collection Access Policies (Whitelists & Blacklists)
  // =========================================================================
  console.log('\n[3] Testing Collection Access Whitelists & Blacklists...');

  pm.registerProject({
    projectId: 'proj_restricted_compliance',
    name: 'Compliance Monitored Database',
    connectionUri: uri,
    databaseName: testDbName,
    ownerId: 'user_cfo',
    allowedUserIds: ['user_compliance_officer'],
    allowedCollections: ['general_ledger', 'public_reports'],
    restrictedCollections: ['executive_payroll', 'system_keys']
  });

  const complianceAdapter = await pm.getAdapter('user_compliance_officer', 'proj_restricted_compliance');

  // Query allowed collection -> Success
  const allowedQuery = await complianceAdapter.find({ collection: 'general_ledger' });
  console.log(`✓ Allowed collection "general_ledger" accessed successfully (${allowedQuery.count} record).`);

  // Query collection outside whitelist -> Blocked
  try {
    await complianceAdapter.find({ collection: 'customer_ssn_vault' });
    throw new Error('Security failure: Access to non-whitelisted collection was permitted!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError for non-whitelisted collection: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Query explicitly restricted collection -> Blocked
  try {
    await complianceAdapter.find({ collection: 'executive_payroll' });
    throw new Error('Security failure: Access to restricted collection was permitted!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError for blacklisted collection: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // =========================================================================
  // 4. Affected Document Limits for Updates and Deletions
  // =========================================================================
  console.log('\n[4] Testing Affected Document Safety Thresholds...');

  const bulkCol = db.collection('bulk_items_test');
  await bulkCol.deleteMany({});

  // Insert 15 matching items
  const items = Array.from({ length: 15 }, (_, i) => ({
    sku: `ITEM-${1000 + i}`,
    category: 'bulk_batch',
    active: true
  }));
  await bulkCol.insertMany(items);
  console.log(`✓ Seeded 15 bulk items in test collection.`);

  // Attempt update touching 15 items (MAX_UPDATE_DOCUMENTS is 10)
  try {
    await accountantAdapter.update({
      collection: 'bulk_items_test',
      filter: { category: 'bulk_batch' },
      update: { $set: { active: false } },
      multi: true
    });
    throw new Error('Security failure: Update touching 15 items was permitted (limit is 10)!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError for mass update: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Attempt delete touching 15 items (MAX_DELETE_DOCUMENTS is 5)
  try {
    await accountantAdapter.delete({
      collection: 'bulk_items_test',
      filter: { category: 'bulk_batch' },
      multi: true
    });
    throw new Error('Security failure: Delete touching 15 items was permitted (limit is 5)!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected PolicyViolationError for mass delete: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Single-document update within limit -> Allowed
  const singleUpdate = await accountantAdapter.update({
    collection: 'bulk_items_test',
    filter: { sku: 'ITEM-1000' },
    update: { $set: { active: false } }
  });
  if (singleUpdate.modifiedCount !== 1) {
    throw new Error('Single document update failed!');
  }
  console.log('✓ Targeted single-document update within threshold executed successfully.');

  // =========================================================================
  // 5. Append-Only Audit Trail Enforcement
  // =========================================================================
  console.log('\n[5] Testing Append-Only Audit Trail Enforcement...');

  const auditLogger = new AuditLogger(db);

  await auditLogger.logEvent({
    action: 'POLICY_EVALUATION',
    reason: 'Security compliance periodic inspection',
    userId: 'user_compliance_officer',
    metadata: { rule: 'SOX_404_COMPLIANCE' }
  });

  const recentLogs = await auditLogger.getRecentEvents(5);
  if (recentLogs.length === 0 || recentLogs[0].action !== 'POLICY_EVALUATION') {
    throw new Error('Failed to read append-only audit trail!');
  }
  console.log(`✓ Successfully appended and read audit log event: "${recentLogs[0].action}".`);

  // Direct modification of audit_logs via adapter must be prohibited
  try {
    await accountantAdapter.delete({
      collection: 'audit_logs',
      filter: { action: 'POLICY_EVALUATION' }
    });
    throw new Error('Security failure: Direct delete on audit_logs was permitted!');
  } catch (err: any) {
    if (err instanceof PolicyViolationError) {
      console.log(`✓ Caught expected protection error on audit_logs: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Teardown
  console.log('\n[6] Teardown and pool cleanup...');
  await db.dropDatabase();
  await cm.closeAll();
  console.log('✓ Dropped test database and closed all connection pools.');

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 6 SECURITY & AUTHORIZATION TESTS PASSED!');
  console.log('======================================================');
}

runSecurityAuthorizationTests().catch(async (err) => {
  console.error('\n❌ Phase 6 Security Test Failed:', err);
  process.exit(1);
});
