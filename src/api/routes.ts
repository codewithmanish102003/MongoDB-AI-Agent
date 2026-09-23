import { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { projectManager } from '../projects/project-manager.js';
import {
  ProjectNotFoundError,
  UnauthorizedProjectAccessError,
  ProjectPermissionError
} from '../projects/types.js';
import { SchemaInspector } from '../database/schema-inspector.js';
import { MongoDatabaseAdapter } from '../database/mongo-adapter.js';
import { PolicyViolationError } from '../database/policy.js';
import { UnifiedAgent } from '../agents/unified-agent.js';
import { schemaCache } from './schema-cache.js';
import { parseJsonBody, sendJson, sendError, RequestContext } from './middleware.js';
import { logger } from '../utils/logger.js';

// --- Zod Validation Schemas ---
const RegisterProjectSchema = z.object({
  projectId: z.string().min(1, 'projectId is required').max(64),
  name: z.string().min(1, 'name is required').max(128),
  description: z.string().max(500).optional(),
  connectionUri: z.string().min(1, 'connectionUri is required'),
  databaseName: z.string().min(1, 'databaseName is required').max(64),
  allowedUserIds: z.array(z.string()).optional(),
  userRoles: z.record(z.string(), z.enum(['readOnly', 'readWrite', 'admin'])).optional(),
  defaultRole: z.enum(['readOnly', 'readWrite', 'admin']).optional(),
  allowedCollections: z.array(z.string()).optional(),
  restrictedCollections: z.array(z.string()).optional()
});

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'message cannot be empty').max(10000, 'message is too long'),
  sessionId: z.string().max(128).optional()
});

/**
 * Dispatches matched route handlers based on HTTP method and URL path.
 */
export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  // --- GET /health ---
  if (method === 'GET' && pathname === '/health') {
    sendJson(
      res,
      200,
      {
        status: 'ok',
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      },
      ctx.requestId
    );
    return;
  }

  // --- GET /projects ---
  if (method === 'GET' && pathname === '/projects') {
    const projects = projectManager.listUserProjects(ctx.userId);
    sendJson(
      res,
      200,
      {
        success: true,
        count: projects.length,
        projects
      },
      ctx.requestId
    );
    return;
  }

  // --- POST /projects ---
  if (method === 'POST' && pathname === '/projects') {
    try {
      const rawBody = await parseJsonBody(req);
      const parseResult = RegisterProjectSchema.safeParse(rawBody);

      if (!parseResult.success) {
        const errorMessages = parseResult.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
        sendError(res, 400, `Validation failed: ${errorMessages}`, ctx.requestId);
        return;
      }

      const data = parseResult.data;
      projectManager.registerProject({
        ...data,
        ownerId: ctx.userId
      });

      const summary = projectManager
        .listUserProjects(ctx.userId)
        .find((p) => p.projectId === data.projectId);

      sendJson(
        res,
        201,
        {
          success: true,
          message: `Project "${data.name}" registered successfully.`,
          project: summary
        },
        ctx.requestId
      );
      return;
    } catch (err: any) {
      sendError(res, 400, err.message, ctx.requestId);
      return;
    }
  }

  // --- Parametric Routes: /projects/:id/... ---
  const projectMatch = pathname.match(/^\/projects\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const subPath = projectMatch[2] || '';

    // Verify project exists
    const project = projectManager.getProject(projectId);
    if (!project) {
      sendError(res, 404, `Project "${projectId}" not found.`, ctx.requestId);
      return;
    }

    // Verify access
    if (!projectManager.hasAccess(ctx.userId, projectId)) {
      sendError(res, 403, `Access denied: You are not authorized to access project "${projectId}".`, ctx.requestId);
      return;
    }

    // --- GET /projects/:id/schema ---
    if (method === 'GET' && subPath === '/schema') {
      try {
        const cached = schemaCache.get(projectId);
        if (cached) {
          sendJson(res, 200, { success: true, cached: true, schema: cached }, ctx.requestId);
          return;
        }

        const adapter = await projectManager.getAdapter(ctx.userId, projectId);
        const mongoAdapter = adapter as MongoDatabaseAdapter;
        const inspector = new SchemaInspector(mongoAdapter.getDb());
        const report = await inspector.inspectDatabase();

        schemaCache.set(projectId, report);
        sendJson(res, 200, { success: true, cached: false, schema: report }, ctx.requestId);
        return;
      } catch (err: any) {
        logger.error(`[API] Schema inspection error for "${projectId}": ${err.message}`);
        sendError(res, 500, `Failed to inspect schema: ${err.message}`, ctx.requestId);
        return;
      }
    }

    // --- POST /projects/:id/refresh-schema ---
    if (method === 'POST' && subPath === '/refresh-schema') {
      try {
        schemaCache.invalidate(projectId);
        const adapter = await projectManager.getAdapter(ctx.userId, projectId);
        const mongoAdapter = adapter as MongoDatabaseAdapter;
        const inspector = new SchemaInspector(mongoAdapter.getDb());
        const report = await inspector.inspectDatabase();

        schemaCache.set(projectId, report);
        sendJson(res, 200, { success: true, refreshed: true, schema: report }, ctx.requestId);
        return;
      } catch (err: any) {
        logger.error(`[API] Refresh schema error for "${projectId}": ${err.message}`);
        sendError(res, 500, `Failed to refresh schema: ${err.message}`, ctx.requestId);
        return;
      }
    }

    // --- POST /projects/:id/chat ---
    if (method === 'POST' && subPath === '/chat') {
      try {
        const rawBody = await parseJsonBody(req);

        // Security check: Block clients trying to pass connection credentials or raw database parameters
        if (rawBody.connectionUri || rawBody.database || rawBody.databaseName) {
          sendError(res, 400, 'Security violation: Database connection parameters are not permitted in chat requests.', ctx.requestId);
          return;
        }

        const parseResult = ChatRequestSchema.safeParse(rawBody);
        if (!parseResult.success) {
          const errors = parseResult.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
          sendError(res, 400, `Validation failed: ${errors}`, ctx.requestId);
          return;
        }

        const { message, sessionId } = parseResult.data;

        // Resolve project-bound adapter
        const adapter = await projectManager.getAdapter(ctx.userId, projectId);

        // Cache schema if not yet cached
        if (!schemaCache.get(projectId)) {
          try {
            const mongoAdapter = adapter as MongoDatabaseAdapter;
            const inspector = new SchemaInspector(mongoAdapter.getDb());
            const report = await inspector.inspectDatabase();
            schemaCache.set(projectId, report);
          } catch {}
        }

        logger.info(`[API] User "${ctx.userId}" chatting with project "${projectId}" (Session: ${sessionId || 'new'})`);

        // Initialize agent with bound adapter and scoped session
        const agent = new UnifiedAgent(ctx.userId, sessionId, adapter);
        const responseText = await agent.ask(message);

        sendJson(
          res,
          200,
          {
            success: true,
            projectId,
            sessionId: agent.currentSession?.sessionId,
            response: responseText,
            provider: agent.lastProviderUsed
          },
          ctx.requestId
        );
        return;
      } catch (err: any) {
        logger.error(`[API] Agent execution error: ${err.message}`);
        if (err instanceof PolicyViolationError || err instanceof ProjectPermissionError) {
          sendError(res, 403, err.message, ctx.requestId);
          return;
        }
        sendError(res, 500, `Agent execution failed: ${err.message}`, ctx.requestId);
        return;
      }
    }
  }

  // --- 404 Route Not Found ---
  sendError(res, 404, `Endpoint "${method} ${pathname}" not found.`, ctx.requestId);
}
