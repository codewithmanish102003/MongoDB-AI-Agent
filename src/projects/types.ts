/**
 * Project and Connection Management Types
 */

export type UserProjectRole = 'readOnly' | 'readWrite' | 'admin';

export interface ProjectSecurityContext {
  userId: string;
  projectId: string;
  role: UserProjectRole;
  allowedCollections?: string[];
  restrictedCollections?: string[];
}

export interface ProjectConfig {
  /** Unique project identifier */
  projectId: string;
  /** Human-readable display name */
  name: string;
  /** Optional project description */
  description?: string;
  /** Server-side MongoDB connection URI (NEVER exposed to LLM or public API) */
  connectionUri: string;
  /** Target MongoDB database name */
  databaseName: string;
  /** User ID who owns and manages the project */
  ownerId: string;
  /** List of user IDs permitted to access this project */
  allowedUserIds?: string[];
  /** Role assigned per user (e.g. { 'user_analyst': 'readOnly', 'user_lead': 'readWrite' }) */
  userRoles?: Record<string, UserProjectRole>;
  /** Default role for users in allowedUserIds if not explicitly defined in userRoles */
  defaultRole?: UserProjectRole;
  /** Optional collection whitelist: if set, ONLY these collections can be accessed */
  allowedCollections?: string[];
  /** Optional collection blacklist: these collections can never be accessed */
  restrictedCollections?: string[];
  /** Timestamp when project was registered */
  createdAt?: Date;
  /** Project status */
  status?: 'active' | 'suspended';
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  description?: string;
  databaseName: string;
  ownerId: string;
  isOwner: boolean;
  userRole?: UserProjectRole;
  status: 'active' | 'suspended';
  createdAt?: Date;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project "${projectId}" not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export class UnauthorizedProjectAccessError extends Error {
  constructor(userId: string, projectId: string) {
    super(`User "${userId}" is not authorized to access project "${projectId}".`);
    this.name = 'UnauthorizedProjectAccessError';
  }
}

export class ProjectPermissionError extends Error {
  constructor(message: string) {
    super(`[Security Permission Denied] ${message}`);
    this.name = 'ProjectPermissionError';
  }
}
