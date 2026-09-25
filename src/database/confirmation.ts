/**
 * Confirmation & Guardrail Layer for Destructive Operations
 * 
 * Ensures write and delete operations require explicit user intent and confirmation
 * before modifying the target MongoDB database.
 */

export interface ConfirmationVerificationContext {
  userId?: string;
  projectId?: string;
  action?: 'insert' | 'update' | 'delete';
  collection?: string;
  filter?: Record<string, any>;
  update?: Record<string, any>;
  document?: Record<string, any>;
}

export interface PendingOperation {
  confirmationId: string;
  userId?: string;
  projectId?: string;
  action: 'insert' | 'update' | 'delete';
  collection: string;
  filter?: Record<string, any>;
  update?: Record<string, any>;
  document?: Record<string, any>;
  multi?: boolean;
  matchedCount: number;
  previewDocuments: any[];
  reason?: string;
  createdAt: Date;
  expiresAt: Date;
}

export class ConfirmationManager {
  private static instance: ConfirmationManager;
  private pendingOps: Map<string, PendingOperation> = new Map();
  private ttlMs: number = 10 * 60 * 1000; // 10 minutes

  public static getInstance(): ConfirmationManager {
    if (!ConfirmationManager.instance) {
      ConfirmationManager.instance = new ConfirmationManager();
    }
    return ConfirmationManager.instance;
  }

  /**
   * Generates a unique confirmation ID and stores the staged operation with its preview.
   */
  public stageOperation(op: Omit<PendingOperation, 'confirmationId' | 'createdAt' | 'expiresAt'>): PendingOperation {
    this.cleanExpired();

    const confirmationId = `CONF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    const pending: PendingOperation = {
      ...op,
      confirmationId,
      createdAt: now,
      expiresAt
    };

    this.pendingOps.set(confirmationId, pending);
    return pending;
  }

  /**
   * Retrieves and consumes a staged operation for execution.
   * Validates that the executing user, project, collection, action, and parameters match the staged operation.
   */
  public getAndConsume(confirmationId: string, context?: ConfirmationVerificationContext): PendingOperation | null {
    this.cleanExpired();
    const op = this.pendingOps.get(confirmationId);
    if (!op) return null;

    if (context) {
      if (context.userId && op.userId && context.userId !== op.userId) {
        throw new Error(`Security violation: User "${context.userId}" is not authorized to redeem this confirmation token.`);
      }
      if (context.projectId && op.projectId && context.projectId !== op.projectId) {
        throw new Error(`Security violation: Confirmation token was issued for project "${op.projectId}", not "${context.projectId}".`);
      }
      if (context.action && context.action !== op.action) {
        throw new Error(`Security violation: Confirmation token action mismatch: expected "${op.action}", got "${context.action}".`);
      }
      if (context.collection && context.collection !== op.collection) {
        throw new Error(`Security violation: Confirmation token was issued for collection "${op.collection}", not "${context.collection}".`);
      }
      if (context.filter && op.filter) {
        if (JSON.stringify(context.filter) !== JSON.stringify(op.filter)) {
          throw new Error('Security violation: Operation filter does not match the staged operation parameters.');
        }
      }
      if (context.update && op.update) {
        if (JSON.stringify(context.update) !== JSON.stringify(op.update)) {
          throw new Error('Security violation: Update payload does not match the staged operation parameters.');
        }
      }
      if (context.document && op.document) {
        if (JSON.stringify(context.document) !== JSON.stringify(op.document)) {
          throw new Error('Security violation: Document payload does not match the staged operation parameters.');
        }
      }
    }

    this.pendingOps.delete(confirmationId);
    return op;
  }

  /**
   * Discards a pending operation.
   */
  public cancelOperation(confirmationId: string): boolean {
    return this.pendingOps.delete(confirmationId);
  }

  private cleanExpired(): void {
    const now = new Date();
    for (const [id, op] of this.pendingOps.entries()) {
      if (op.expiresAt < now) {
        this.pendingOps.delete(id);
      }
    }
  }
}

export const confirmationManager = ConfirmationManager.getInstance();
