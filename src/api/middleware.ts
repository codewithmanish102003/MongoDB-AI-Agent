import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface RequestContext {
  requestId: string;
  userId: string;
  startTime: number;
}

/**
 * Sliding-Window Rate Limiter
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 60, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public isRateLimited(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Filter out timestamps outside window
    const valid = timestamps.filter((t) => now - t < this.windowMs);

    if (valid.length >= this.maxRequests) {
      this.requests.set(key, valid);
      return true;
    }

    valid.push(now);
    this.requests.set(key, valid);
    return false;
  }

  public reset(): void {
    this.requests.clear();
  }
}

export const defaultRateLimiter = new RateLimiter(60, 60000);

/**
 * Helper to parse and buffer JSON request body safely with a size ceiling
 */
export async function parseJsonBody(req: IncomingMessage, maxSizeBytes: number = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytesReceived = 0;

    req.on('data', (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > maxSizeBytes) {
        reject(new Error(`Payload too large. Maximum allowed size is ${maxSizeBytes / 1024} KB.`));
        req.destroy();
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (!raw || !raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        reject(new Error('Invalid JSON payload format.'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

/**
 * Resolves authenticated user ID from request headers.
 * In production: strictly enforces 'authorization: Bearer <userId>'.
 * In development/test: also accepts 'x-user-id' or falls back to 'default_user'.
 */
export function resolveUserId(req: IncomingMessage): string {
  const isProduction = process.env.NODE_ENV === 'production';

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  // Allow x-user-id header only in non-production environments for local testing/development
  if (!isProduction) {
    const headerUserId = req.headers['x-user-id'];
    if (typeof headerUserId === 'string' && headerUserId.trim()) {
      return headerUserId.trim();
    }
    return 'default_user';
  }

  throw new Error('Authentication required: Missing or invalid Bearer token.');
}

/**
 * Safely sends a JSON response with security headers and request tracing.
 */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: any,
  requestId: string
): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(payload);
}

/**
 * Sanitizes error messages to prevent leakage of credentials, passwords, or connection strings.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb://***:***@')
    .replace(/(password|secret|key|token)=["']?[^"'\s&]+/gi, '$1=***');
}

/**
 * Safely sends an error response without leaking stack traces or sensitive credentials.
 */
export function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  requestId: string
): void {
  const safeMessage = sanitizeErrorMessage(message);
  sendJson(
    res,
    statusCode,
    {
      success: false,
      error: safeMessage,
      statusCode,
      requestId
    },
    requestId
  );
}
