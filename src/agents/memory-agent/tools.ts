import { MongoMemoryStore } from './store.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

export const memoryAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'remember_user_fact',
    description: 'Permanently saves a user preference, personal constraint, habit, or instruction into MongoDB long-term memory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Short identifier for the fact (e.g. "preferred_payment_mode", "health_notes", "budget_limit", "user_city").'
        },
        value: {
          type: Type.STRING,
          description: 'The fact, preference, or detail to remember permanently.'
        },
        category: {
          type: Type.STRING,
          description: 'Category: "preference", "health", "budget", "lifestyle", or "general".'
        }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'get_user_memories',
    description: 'Retrieves all previously remembered facts, preferences, and details about the user from MongoDB.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'list_user_sessions',
    description: 'Lists all past chat sessions and conversations stored in the database.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  }
];

export async function executeMemoryTool(name: string, args: any, memoryStore: MongoMemoryStore): Promise<any> {
  switch (name) {
    case 'remember_user_fact': {
      const { key, value, category = 'general' } = args;
      logger.tool('remember_user_fact', `[${category}] ${key} -> "${value}"`);
      await memoryStore.saveUserFact(key, value, category);
      return {
        success: true,
        key,
        value,
        category,
        message: `Successfully stored long-term memory: "${key}" = "${value}".`
      };
    }

    case 'get_user_memories': {
      logger.tool('get_user_memories');
      const facts = await memoryStore.getUserFacts();
      logger.result(`Retrieved ${facts.length} remembered fact(s)`);
      return {
        count: facts.length,
        memories: facts.map((f) => ({
          key: f.key,
          value: f.value,
          category: f.category,
          updatedAt: f.updatedAt
        }))
      };
    }

    case 'list_user_sessions': {
      logger.tool('list_user_sessions');
      const sessions = await memoryStore.listSessions();
      logger.result(`Found ${sessions.length} session(s)`);
      return {
        count: sessions.length,
        sessions
      };
    }

    default:
      throw new Error(`Unknown memory tool: "${name}"`);
  }
}
