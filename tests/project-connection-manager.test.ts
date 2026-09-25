import {
  ProjectManager,
  ConnectionManager,
  UnauthorizedProjectAccessError,
  ProjectNotFoundError
} from '../src/projects/index.js';
import { executeQueryTool } from '../src/agents/query-agent/tools.js';
import { executeTaskTool } from '../src/agents/task-agent/tools.js';
import { QueryAgent } from '../src/agents/query-agent/index.js';
import { TaskAgent } from '../src/agents/task-agent/index.js';
import { getEnvConfig } from '../src/config/env.js';

async function runProjectConnectionManagerTests() {
  console.log('--- Testing Phase 5: Project & MongoDB Connection Management ---');

  const config = getEnvConfig();
  const uri = config.MONGODB_URI;

  const cm = new ConnectionManager();
  const pm = new ProjectManager(cm);

  const dbNameA = 'healthcare_management_test';
  const dbNameB = 'fintech_platform_test';
  const dbNameC = 'shared_workspace_test';

  // Ensure clean slate
  const initClient = await cm.getClient(uri);
  await initClient.db(dbNameA).dropDatabase();
  await initClient.db(dbNameB).dropDatabase();
  await initClient.db(dbNameC).dropDatabase();

  // 1. Register projects
  console.log('\n[1] Registering projects with access control...');
  pm.registerProject({
    projectId: 'proj_healthcare',
    name: 'Healthcare Clinic System',
    description: 'Patient medical records and appointments',
    connectionUri: uri,
    databaseName: dbNameA,
    ownerId: 'user_alice',
    allowedUserIds: []
  });

  pm.registerProject({
    projectId: 'proj_fintech',
    name: 'Fintech Banking Core',
    description: 'Accounts, ledgers, and transactions',
    connectionUri: uri,
    databaseName: dbNameB,
    ownerId: 'user_bob',
    allowedUserIds: []
  });

  pm.registerProject({
    projectId: 'proj_shared',
    name: 'Shared Enterprise Workspace',
    description: 'Shared cross-departmental documentation',
    connectionUri: uri,
    databaseName: dbNameC,
    ownerId: 'user_alice',
    allowedUserIds: ['user_bob', 'user_charlie']
  });

  console.log(`✓ Registered 3 distinct projects (Total registered: ${pm.totalProjects})`);

  // 2. Access Control Verification
  console.log('\n[2] Testing Access Control & Authorization Enforcement...');

  // user_alice accessing proj_healthcare -> Allowed
  if (!pm.hasAccess('user_alice', 'proj_healthcare')) {
    throw new Error('Owner should have access to own project!');
  }
  console.log('✓ Owner (user_alice) has access to proj_healthcare.');

  // user_bob accessing proj_healthcare -> Denied
  if (pm.hasAccess('user_bob', 'proj_healthcare')) {
    throw new Error('user_bob should NOT have access to proj_healthcare!');
  }
  console.log('✓ Unauthorized user (user_bob) correctly denied access to proj_healthcare.');

  // user_bob accessing proj_fintech -> Allowed
  if (!pm.hasAccess('user_bob', 'proj_fintech')) {
    throw new Error('Owner (user_bob) should have access to proj_fintech!');
  }
  console.log('✓ Owner (user_bob) has access to proj_fintech.');

  // user_bob accessing proj_shared -> Allowed via allowedUserIds
  if (!pm.hasAccess('user_bob', 'proj_shared')) {
    throw new Error('user_bob should have access to proj_shared via allowedUserIds!');
  }
  console.log('✓ Collaborator (user_bob) has access to proj_shared.');

  // user_stranger accessing proj_shared -> Denied
  if (pm.hasAccess('user_stranger', 'proj_shared')) {
    throw new Error('user_stranger should NOT have access to proj_shared!');
  }
  console.log('✓ Stranger (user_stranger) correctly denied access to proj_shared.');

  // Admin override -> Allowed
  if (!pm.hasAccess('admin', 'proj_healthcare')) {
    throw new Error('Admin should have access to any project!');
  }
  console.log('✓ Admin has override access across projects.');

  // Test getAdapter exception on unauthorized access
  try {
    await pm.getAdapter('user_bob', 'proj_healthcare');
    throw new Error('Security policy failed: unauthorized getAdapter succeeded!');
  } catch (err: any) {
    if (err instanceof UnauthorizedProjectAccessError) {
      console.log(`✓ Caught expected UnauthorizedProjectAccessError: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // Test getAdapter exception on non-existent project
  try {
    await pm.getAdapter('user_alice', 'non_existent_project');
    throw new Error('Security policy failed: non-existent project succeeded!');
  } catch (err: any) {
    if (err instanceof ProjectNotFoundError) {
      console.log(`✓ Caught expected ProjectNotFoundError: "${err.message}"`);
    } else {
      throw err;
    }
  }

  // 3. Credential Protection in Project Listings
  console.log('\n[3] Testing Safe Project Listing (No Credentials Exposed)...');
  const bobProjects = pm.listUserProjects('user_bob');
  console.log('user_bob accessible projects:', bobProjects.map((p) => p.name));

  const bobCustomProjects = bobProjects.filter((p) => p.projectId !== 'default');
  if (bobCustomProjects.length !== 2) {
    throw new Error(`Expected user_bob to see 2 custom projects, saw ${bobCustomProjects.length}`);
  }

  if (bobProjects.some((p) => p.projectId === 'proj_healthcare')) {
    throw new Error('Security leak: user_bob was able to see unauthorized proj_healthcare!');
  }

  for (const summary of bobProjects) {
    if ('connectionUri' in summary || (summary as any).uri || (summary as any).password) {
      throw new Error('CRITICAL SECURITY LEAK: Connection URI exposed in project summary!');
    }
  }
  console.log('✓ Verified: No connection URIs or credentials leaked in public project summaries.');

  // 4. Connection Pooling
  console.log('\n[4] Testing Connection Manager Pooling & Reuse...');
  const adapterA = await pm.getAdapter('user_alice', 'proj_healthcare');
  const adapterB = await pm.getAdapter('user_bob', 'proj_fintech');

  // Both projects use the same host connectionUri, so pool count should be 1
  if (cm.activePoolCount !== 1) {
    throw new Error(`Expected 1 pooled MongoClient, found: ${cm.activePoolCount}`);
  }
  console.log(`✓ Connection pooling verified: ${cm.activePoolCount} shared MongoClient pool across multiple databases.`);

  // 5. Database Isolation Test
  console.log('\n[5] Testing Cross-Project Database Isolation...');
  // Insert patient record in Project A
  await adapterA.insert({
    collection: 'patients',
    document: {
      patientId: 'PT-1001',
      name: 'Sarah Connor',
      department: 'Cardiology'
    }
  });

  // Insert transaction record in Project B
  await adapterB.insert({
    collection: 'accounts',
    document: {
      accountNumber: 'ACC-88001',
      holder: 'Cyberdyne Systems Inc',
      balance: 5000000
    }
  });

  // Verify Project A contains 'patients' and DOES NOT contain 'accounts'
  const collectionsA = await adapterA.listCollections();
  if (!collectionsA.includes('patients') || collectionsA.includes('accounts')) {
    throw new Error('Database isolation failed: Project A has contaminated collections!');
  }
  console.log(`✓ Project A isolated collections: [${collectionsA.join(', ')}]`);

  // Verify Project B contains 'accounts' and DOES NOT contain 'patients'
  const collectionsB = await adapterB.listCollections();
  if (!collectionsB.includes('accounts') || collectionsB.includes('patients')) {
    throw new Error('Database isolation failed: Project B has contaminated collections!');
  }
  console.log(`✓ Project B isolated collections: [${collectionsB.join(', ')}]`);

  // Verify record counts
  const patientCountA = await adapterA.count({ collection: 'patients', filter: {} });
  if (patientCountA !== 1) throw new Error('Expected 1 patient in Project A');

  const accountCountB = await adapterB.count({ collection: 'accounts', filter: {} });
  if (accountCountB !== 1) throw new Error('Expected 1 account in Project B');

  console.log('✓ Project A and Project B databases strictly isolated from each other.');

  // 6. Agent Tool Execution with Bound Adapters
  console.log('\n[6] Testing Agent Operations Routed Through Project-Specific Adapters...');
  // Query tool with adapterA
  const queryResA = await executeQueryTool(
    'find_documents',
    {
      collectionName: 'patients',
      filter: '{"patientId": "PT-1001"}'
    },
    adapterA
  );
  if (!queryResA.documents || queryResA.documents.length === 0) {
    throw new Error('Query through adapterA failed to find patient!');
  }
  console.log(`✓ Query through Project A adapter returned patient: "${queryResA.documents[0].name}"`);

  // Task tool with adapterB
  const taskResB = await executeTaskTool(
    'execute_task_operation',
    {
      type: 'insert',
      collection: 'accounts',
      document: JSON.stringify({
        accountNumber: 'ACC-88002',
        holder: 'Miles Dyson',
        balance: 750000
      }),
      reason: 'Open new VIP account'
    },
    adapterB
  );
  if (!taskResB.success || taskResB.status !== 'EXECUTED') {
    throw new Error('Task insert through adapterB failed!');
  }
  console.log(`✓ Task insert through Project B adapter executed successfully (ID: ${taskResB.insertedId})`);

  // Verify accounts in B increased to 2
  const updatedAccountsB = await adapterB.count({ collection: 'accounts', filter: {} });
  if (updatedAccountsB !== 2) throw new Error('Expected 2 accounts in Project B');
  console.log(`✓ Project B account count is now ${updatedAccountsB}.`);

  // 7. Cleanup & Teardown
  console.log('\n[7] Cleaning up test databases and closing connection pools...');
  const client = await cm.getClient(uri);
  await client.db(dbNameA).dropDatabase();
  await client.db(dbNameB).dropDatabase();
  await client.db(dbNameC).dropDatabase();
  await cm.closeAll();

  if (cm.activePoolCount !== 0) {
    throw new Error('ConnectionManager failed to close all pools!');
  }
  console.log('✓ All test databases dropped and connection pools closed.');

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 5 PROJECT & CONNECTION TESTS PASSED!');
  console.log('======================================================');
}

runProjectConnectionManagerTests().catch(async (err) => {
  console.error('\n❌ Phase 5 Test Failed:', err);
  process.exit(1);
});
