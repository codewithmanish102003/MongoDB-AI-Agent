import OpenAI from 'openai';
import { getEnvConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { executeQueryTool, queryAgentFunctionDeclarations } from '../agents/query-agent/tools.js';
import { executeRagTool, ragAgentFunctionDeclarations } from '../agents/rag-agent/tools.js';
import { executeTaskTool, taskAgentFunctionDeclarations } from '../agents/task-agent/tools.js';
import { executeMemoryTool, memoryAgentFunctionDeclarations } from '../agents/memory-agent/tools.js';
import { MongoMemoryStore } from '../agents/memory-agent/store.js';

import { DatabaseAdapter } from '../database/adapter.js';

let defaultMemoryStore = new MongoMemoryStore('default_user');

export function setDefaultMemoryStore(store: MongoMemoryStore) {
  defaultMemoryStore = store;
}

let client: OpenAI | null = null;

export function getOpenRouterClient(): OpenAI {
  if (!client) {
    const config = getEnvConfig();
    if (!config.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is not configured in .env');
    }
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/mongodb-ai-agent',
        'X-Title': 'MongoDB AI Agent'
      }
    });
  }
  return client;
}

export function isOpenRouterConfigured(): boolean {
  const config = getEnvConfig();
  return Boolean(config.OPENROUTER_API_KEY && config.OPENROUTER_API_KEY.trim().length > 0);
}

// Convert tool declarations into OpenAI-compatible tools
function getOpenAITools() {
  const allDeclarations = [
    ...queryAgentFunctionDeclarations,
    ...ragAgentFunctionDeclarations,
    ...taskAgentFunctionDeclarations,
    ...memoryAgentFunctionDeclarations
  ];

  const seen = new Set<string>();
  const uniqueDeclarations = [];
  for (const d of allDeclarations) {
    if (d.name && !seen.has(d.name)) {
      seen.add(d.name);
      uniqueDeclarations.push(d);
    }
  }

  return uniqueDeclarations.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name || '',
      description: d.description || '',
      parameters: (d.parameters as Record<string, any>) || { type: 'object', properties: {} }
    }
  }));
}

async function executeAnyTool(name: string, args: any, adapter?: DatabaseAdapter): Promise<any> {
  if (queryAgentFunctionDeclarations.some((d) => d.name === name)) {
    return await executeQueryTool(name, args, adapter);
  } else if (ragAgentFunctionDeclarations.some((d) => d.name === name)) {
    return await executeRagTool(name, args, (adapter as any)?.getDb?.());
  } else if (taskAgentFunctionDeclarations.some((d) => d.name === name)) {
    return await executeTaskTool(name, args, adapter);
  } else {
    return await executeMemoryTool(name, args, defaultMemoryStore);
  }
}

export async function askOpenRouterFallback(
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; tool_call_id?: string }>,
  modelName?: string,
  adapter?: DatabaseAdapter
): Promise<string> {
  const openai = getOpenRouterClient();
  const config = getEnvConfig();
  const model = modelName || config.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';
  const tools = getOpenAITools();

  logger.warn(`🔄 [Fallback Activated]: Routing query through OpenRouter (${model})...`);

  const convo: any[] = [...messages];
  let maxSteps = 6;
  let step = 0;

  while (step < maxSteps) {
    step++;
    const response = await openai.chat.completions.create({
      model,
      messages: convo,
      tools: tools.length > 0 ? tools : undefined
    });

    const choice = response.choices[0];
    const message = choice.message;
    convo.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls as any[]) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }

        try {
          const result = await executeAnyTool(call.function?.name, args, adapter);
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ success: true, data: result })
          });
        } catch (err: any) {
          logger.warn(`Tool error in OpenRouter execution: ${err.message}`);
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ success: false, error: err.message })
          });
        }
      }
    } else {
      return message.content || 'No response from OpenRouter.';
    }
  }

  return 'Execution exceeded maximum steps.';
}
