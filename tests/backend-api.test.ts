import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createApiServer } from '../src/api/server.js';
import { RateLimiter } from '../src/api/middleware.js';
import { connectionManager } from '../src/projects/connection-manager.js';
import { getEnvConfig } from '../src/config/env.js';

interface TestHttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function makeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<TestHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = options.body ? JSON.stringify(options.body) : undefined;

    const reqOptions: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData).toString() } : {}),
        ...options.headers
      }
    };

    const req = http.request(reqOptions, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {}
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers,
          body
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runBackendApiTests() {
  console.log('--- Testing Phase 7: Backend REST API for MongoDB AI Agent ---');

  const config = getEnvConfig();
  const uri = config.MONGODB_URI;
  const testDbName = 'api_gateway_test_db';

  // Seed sample database for schema introspection
  const client = await connectionManager.getClient(uri);
  const db = client.db(testDbName);
  await db.dropDatabase();
  await db.collection('patients').insertOne({
    patientId: 'PT-99',
    name: 'Arthur Dent',
    condition: 'Mild Confusion',
    admittedAt: new Date()
  });

  // Start test server on ephemeral port
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;

  console.log(`✓ Test API server listening on ${baseUrl}`);

  try {
    // 1. Healthcheck
    console.log('\n[1] Testing GET /health...');
    const healthRes = await makeRequest(`${baseUrl}/health`);
    if (healthRes.statusCode !== 200 || healthRes.body.status !== 'ok') {
      throw new Error(`Healthcheck failed with status ${healthRes.statusCode}`);
    }
    if (!healthRes.headers['x-request-id']) {
      throw new Error('Missing x-request-id header in health response!');
    }
    console.log(`✓ Healthcheck passed (Request ID: ${healthRes.headers['x-request-id']}).`);

    // 2. Project Registration with Zod Validation
    console.log('\n[2] Testing POST /projects validation & registration...');
    // Invalid registration (missing databaseName)
    const invalidReg = await makeRequest(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' },
      body: {
        projectId: 'proj_api_clinic',
        name: 'Clinic System',
        connectionUri: uri
        // missing databaseName
      }
    });
    if (invalidReg.statusCode !== 400 || !invalidReg.body.error.includes('databaseName')) {
      throw new Error('Validation failed to reject missing databaseName!');
    }
    console.log('✓ Validation correctly rejected incomplete project payload with 400.');

    // Valid registration
    const validReg = await makeRequest(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' },
      body: {
        projectId: 'proj_api_clinic',
        name: 'Clinic System',
        description: 'Outpatient clinic portal',
        connectionUri: uri,
        databaseName: testDbName,
        allowedUserIds: ['user_nurse_nancy'],
        userRoles: {
          user_nurse_nancy: 'readOnly'
        }
      }
    });

    if (validReg.statusCode !== 201 || !validReg.body.success) {
      throw new Error(`Project registration failed: ${JSON.stringify(validReg.body)}`);
    }
    if ('connectionUri' in validReg.body.project) {
      throw new Error('SECURITY VIOLATION: connectionUri leaked in project registration response!');
    }
    console.log(`✓ Project registered successfully (Owner: user_dr_smith, ID: ${validReg.body.project.projectId}).`);

    // 3. Project Listing Isolation
    console.log('\n[3] Testing GET /projects multi-tenant isolation...');
    // Owner listing
    const smithProjects = await makeRequest(`${baseUrl}/projects`, {
      headers: { 'x-user-id': 'user_dr_smith' }
    });
    const smithHasClinic = smithProjects.body.projects.some((p: any) => p.projectId === 'proj_api_clinic');
    if (!smithHasClinic) {
      throw new Error('Owner should see proj_api_clinic in their projects list!');
    }

    // Stranger listing
    const strangerProjects = await makeRequest(`${baseUrl}/projects`, {
      headers: { 'x-user-id': 'user_stranger' }
    });
    const strangerHasClinic = strangerProjects.body.projects.some((p: any) => p.projectId === 'proj_api_clinic');
    if (strangerHasClinic) {
      throw new Error('Stranger was able to view proj_api_clinic!');
    }
    console.log('✓ Project listing properly scoped: Owner sees project, stranger does not.');

    // 4. Schema Introspection & Caching
    console.log('\n[4] Testing GET & POST /projects/:id/schema caching...');
    // Initial fetch (cache miss)
    const schema1 = await makeRequest(`${baseUrl}/projects/proj_api_clinic/schema`, {
      headers: { 'x-user-id': 'user_dr_smith' }
    });
    if (schema1.statusCode !== 200 || schema1.body.cached !== false) {
      throw new Error(`Expected cache miss on first schema request, got status ${schema1.statusCode}`);
    }
    if (!schema1.body.schema.collections['patients']) {
      throw new Error('Schema report missing patients collection!');
    }
    console.log('✓ First schema call inspected database and populated cache.');

    // Second fetch (cache hit)
    const schema2 = await makeRequest(`${baseUrl}/projects/proj_api_clinic/schema`, {
      headers: { 'x-user-id': 'user_dr_smith' }
    });
    if (schema2.statusCode !== 200 || schema2.body.cached !== true) {
      throw new Error('Expected cache hit on second schema request!');
    }
    console.log('✓ Second schema call served instantly from in-memory cache.');

    // Refresh schema
    const refreshRes = await makeRequest(`${baseUrl}/projects/proj_api_clinic/refresh-schema`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' }
    });
    if (refreshRes.statusCode !== 200 || refreshRes.body.refreshed !== true) {
      throw new Error('Failed to refresh and invalidate schema cache!');
    }
    console.log('✓ POST /refresh-schema successfully invalidated and reloaded schema.');

    // 5. Chat Endpoint Security & Execution
    console.log('\n[5] Testing POST /projects/:id/chat security and execution...');
    // Credential injection attempt
    const credentialAttempt = await makeRequest(`${baseUrl}/projects/proj_api_clinic/chat`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' },
      body: {
        message: 'Show patients',
        connectionUri: 'mongodb://malicious-host:27017'
      }
    });
    if (credentialAttempt.statusCode !== 400) {
      throw new Error('Security failure: Injected connectionUri was not blocked!');
    }
    console.log('✓ Blocked attempt to pass connectionUri in chat request body.');

    // Unauthorized user attempt
    const unauthorizedChat = await makeRequest(`${baseUrl}/projects/proj_api_clinic/chat`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_stranger' },
      body: { message: 'Tell me about Arthur Dent' }
    });
    if (unauthorizedChat.statusCode !== 403) {
      throw new Error(`Expected 430 Forbidden for unauthorized user, got ${unauthorizedChat.statusCode}`);
    }
    console.log('✓ Unauthorized chat attempt rejected with 403 Forbidden.');

    // Non-existent project
    const notFoundChat = await makeRequest(`${baseUrl}/projects/proj_non_existent/chat`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' },
      body: { message: 'Hello' }
    });
    if (notFoundChat.statusCode !== 404) {
      throw new Error(`Expected 404 Not Found for missing project, got ${notFoundChat.statusCode}`);
    }
    console.log('✓ Non-existent project rejected with 404 Not Found.');

    // Valid chat query
    const validChat = await makeRequest(`${baseUrl}/projects/proj_api_clinic/chat`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_dr_smith' },
      body: {
        message: 'What collections and patients do we have in this system?'
      }
    });

    if (validChat.statusCode !== 200 || !validChat.body.success || !validChat.body.response) {
      throw new Error(`Valid chat query failed: ${JSON.stringify(validChat.body)}`);
    }
    console.log(`✓ Agent successfully answered chat request: "${validChat.body.response.slice(0, 80)}..."`);
    console.log(`  (Provider: ${validChat.body.provider}, Session: ${validChat.body.sessionId})`);

    // 6. Rate Limiting Verification
    console.log('\n[6] Testing Rate Limiting...');
    const strictLimiter = new RateLimiter(3, 60000); // 3 requests max
    const rateLimitServer = createApiServer({ rateLimiter: strictLimiter });
    await new Promise<void>((resolve) => rateLimitServer.listen(0, resolve));
    const rlPort = (rateLimitServer.address() as AddressInfo).port;
    const rlUrl = `http://localhost:${rlPort}`;

    // Send 3 requests (allowed)
    for (let i = 0; i < 3; i++) {
      const res = await makeRequest(`${rlUrl}/health`, { headers: { 'x-user-id': 'spam_user' } });
      if (res.statusCode !== 200) throw new Error(`Request ${i + 1} failed unexpectedly`);
    }

    // 4th request must be rate limited
    const limitedRes = await makeRequest(`${rlUrl}/health`, { headers: { 'x-user-id': 'spam_user' } });
    if (limitedRes.statusCode !== 429) {
      throw new Error(`Expected 429 Too Many Requests, got ${limitedRes.statusCode}`);
    }
    console.log('✓ Rate limiter successfully triggered 429 Too Many Requests on threshold breach.');

    rateLimitServer.close();

    // 7. Cleanup
    console.log('\n[7] Cleaning up test server and dropping test database...');
    await db.dropDatabase();
    await connectionManager.closeAll();
    server.close();
    console.log('✓ Test databases dropped and servers cleanly terminated.');

    console.log('\n======================================================');
    console.log('✅ ALL PHASE 7 BACKEND API TESTS PASSED!');
    console.log('======================================================');
  } catch (err) {
    server.close();
    throw err;
  }
}

runBackendApiTests().catch(async (err) => {
  console.error('\n❌ Phase 7 API Test Failed:', err);
  process.exit(1);
});
