import http, { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleApiRoute } from './routes.js';
import {
  resolveUserId,
  defaultRateLimiter,
  sendError,
  RequestContext
} from './middleware.js';
import { logger } from '../utils/logger.js';
import { connectionManager } from '../projects/connection-manager.js';

export interface ApiServerOptions {
  port?: number;
  rateLimiter?: typeof defaultRateLimiter;
}

/**
 * Creates the HTTP request listener with security middlewares.
 */
export function createRequestListener(rateLimiter = defaultRateLimiter) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const startTime = Date.now();
    const requestId = (req.headers['x-request-id'] as string) || `req_${randomUUID().slice(0, 8)}`;
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    let userId: string;
    try {
      userId = resolveUserId(req);
    } catch (authErr: any) {
      sendError(res, 401, authErr.message || 'Unauthorized', requestId);
      return;
    }

    const ctx: RequestContext = {
      requestId,
      userId,
      startTime
    };

    // Structured completion logger
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const status = res.statusCode;
      const logMsg = `[API] ${req.method} ${req.url} -> ${status} (${duration}ms) [User: ${userId}, ReqId: ${requestId}]`;
      if (status >= 500) {
        logger.error(logMsg);
      } else if (status >= 400) {
        logger.warn(logMsg);
      } else {
        logger.info(logMsg);
      }
    });

    // CORS & Security headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id, X-Request-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate Limiting (keyed by IP or authenticated userId)
    const rateLimitKey = `${userId}:${clientIp}`;
    if (rateLimiter.isRateLimited(rateLimitKey)) {
      sendError(res, 429, 'Too many requests. Please slow down and try again later.', requestId);
      return;
    }

    try {
      await handleApiRoute(req, res, ctx);
    } catch (err: any) {
      logger.error(`[API] Uncaught handler error [${requestId}]: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error occurred.', requestId);
      }
    }
  };
}

/**
 * Creates the HTTP API Server instance.
 */
export function createApiServer(options: ApiServerOptions = {}): http.Server {
  const listener = createRequestListener(options.rateLimiter);
  return http.createServer(listener);
}

/**
 * Starts the standalone API Server.
 */
export async function startServer(port: number = Number(process.env.PORT) || 3000): Promise<http.Server> {
  const server = createApiServer();

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.success(`🚀 MongoDB AI Agent REST API listening on http://localhost:${port}`);
      logger.info(`   Endpoints available:`);
      logger.info(`   - GET  /health`);
      logger.info(`   - GET  /projects`);
      logger.info(`   - POST /projects`);
      logger.info(`   - GET  /projects/:id/schema`);
      logger.info(`   - POST /projects/:id/refresh-schema`);
      logger.info(`   - POST /projects/:id/chat`);
      resolve(server);
    });

    // Graceful shutdown handling
    const gracefulShutdown = async () => {
      logger.info('Shutting down API server gracefully...');
      server.close(async () => {
        await connectionManager.closeAll();
        logger.info('API server and all connection pools closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  });
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer();
}
