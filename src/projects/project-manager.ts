import { DatabaseAdapter } from '../database/adapter.js';
import { MongoDatabaseAdapter } from '../database/mongo-adapter.js';
import { ConnectionManager, connectionManager as defaultConnectionManager } from './connection-manager.js';
import {
  ProjectConfig,
  ProjectSummary,
  ProjectNotFoundError,
  UnauthorizedProjectAccessError,
  UserProjectRole
} from './types.js';
import { getEnvConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Project Management & Multi-Tenant Access Controller
 * 
 * Regulates which users have access to which MongoDB projects/databases.
 * The LLM never selects connection strings or credentials; the application server
 * resolves userId + projectId into an authorized DatabaseAdapter.
 */
export class ProjectManager {
  private projects: Map<string, ProjectConfig> = new Map();
  private connectionManager: ConnectionManager;

  constructor(cm?: ConnectionManager) {
    this.connectionManager = cm || defaultConnectionManager;
    this.registerDefaultProjectFromEnv();
  }

  /**
   * Registers the primary application database from environment as default project
   */
  private registerDefaultProjectFromEnv() {
    try {
      const config = getEnvConfig();
      if (config.MONGODB_URI && config.MONGODB_DATABASE) {
        this.registerProject({
          projectId: 'default',
          name: 'Primary Environment Database',
          description: 'Default database configured via environment variables',
          connectionUri: config.MONGODB_URI,
          databaseName: config.MONGODB_DATABASE,
          ownerId: 'system',
          allowedUserIds: ['*'], // Accessible by all users in single-tenant mode
          createdAt: new Date(),
          status: 'active'
        });
      }
    } catch {
      // Ignored if env is not loaded yet
    }
  }

  /**
   * Registers or updates a project configuration in the registry.
   */
  public registerProject(config: ProjectConfig): void {
    if (!config.projectId || !config.connectionUri || !config.databaseName) {
      throw new Error('Project registration requires projectId, connectionUri, and databaseName.');
    }

    this.projects.set(config.projectId, {
      ...config,
      createdAt: config.createdAt || new Date(),
      status: config.status || 'active'
    });

    logger.info(`[ProjectManager] Registered project "${config.projectId}" (${config.name}) -> DB: ${config.databaseName}`);
  }

  /**
   * Unregisters a project.
   */
  public unregisterProject(projectId: string): boolean {
    return this.projects.delete(projectId);
  }

  /**
   * Retrieves full project configuration (server-side only).
   */
  public getProject(projectId: string): ProjectConfig | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Checks whether a user is authorized to access a given project.
   */
  public hasAccess(userId: string, projectId: string): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;
    if (project.status === 'suspended') return false;

    // Project owner or superadmin
    if (project.ownerId === userId || userId === 'admin' || project.ownerId === 'system') {
      return true;
    }

    // Wildcard access
    if (project.allowedUserIds?.includes('*')) {
      return true;
    }

    // Explicitly permitted users
    return project.allowedUserIds?.includes(userId) ?? false;
  }

  /**
   * Resolves the user's role on a given project.
   */
  public getUserRole(userId: string, projectId: string): UserProjectRole {
    const project = this.projects.get(projectId);
    if (!project) return 'readOnly';

    if (userId === 'admin' || project.ownerId === userId || project.ownerId === 'system') {
      return 'admin';
    }

    if (project.userRoles && project.userRoles[userId]) {
      return project.userRoles[userId];
    }

    return project.defaultRole || 'readWrite';
  }

  /**
   * Lists safe project summaries for a given user.
   * Strips all connection URIs and credentials to prevent exposure.
   */
  public listUserProjects(userId: string): ProjectSummary[] {
    const results: ProjectSummary[] = [];

    for (const project of this.projects.values()) {
      if (this.hasAccess(userId, project.projectId)) {
        results.push({
          projectId: project.projectId,
          name: project.name,
          description: project.description,
          databaseName: project.databaseName,
          ownerId: project.ownerId,
          isOwner: project.ownerId === userId,
          userRole: this.getUserRole(userId, project.projectId),
          status: project.status || 'active',
          createdAt: project.createdAt
        });
      }
    }

    return results;
  }

  /**
   * Core Access Gateway:
   * 1. Verifies that the user has access to the project.
   * 2. Resolves user role and collection security policies.
   * 3. Resolves the project's MongoDB connection.
   * 4. Returns the appropriate DatabaseAdapter bound to that project and security context.
   * 
   * @throws {ProjectNotFoundError} If projectId does not exist
   * @throws {UnauthorizedProjectAccessError} If userId is not permitted to access this project
   */
  public async getAdapter(userId: string, projectId: string): Promise<DatabaseAdapter> {
    const project = this.projects.get(projectId);

    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    if (project.status === 'suspended') {
      throw new Error(`Project "${projectId}" is suspended and cannot be accessed.`);
    }

    if (!this.hasAccess(userId, projectId)) {
      throw new UnauthorizedProjectAccessError(userId, projectId);
    }

    const role = this.getUserRole(userId, projectId);

    // Resolve connection through server-side ConnectionManager
    const db = await this.connectionManager.getConnection(project.connectionUri, project.databaseName);

    // Return bound MongoDatabaseAdapter with security context
    return new MongoDatabaseAdapter(db, {
      securityContext: {
        userId,
        projectId,
        role,
        allowedCollections: project.allowedCollections,
        restrictedCollections: project.restrictedCollections
      }
    });
  }

  /**
   * Total number of registered projects.
   */
  public get totalProjects(): number {
    return this.projects.size;
  }
}

export const projectManager = new ProjectManager();
