import { getGeminiClient, getModelName } from '../../llm/gemini.js';
import { taskAgentFunctionDeclarations, executeTaskTool } from './tools.js';
import { TASK_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { DatabaseAdapter } from '../../database/adapter.js';
import { MongoDatabaseAdapter } from '../../database/mongo-adapter.js';
import { logger } from '../../utils/logger.js';
import { createPartFromFunctionResponse } from '@google/genai';

export class TaskAgent {
  private chat: any = null;
  private adapter: DatabaseAdapter;

  constructor(adapter?: DatabaseAdapter) {
    this.adapter = adapter || new MongoDatabaseAdapter();
  }

  private async fetchDatabaseContext(): Promise<string> {
    try {
      const collections = await this.adapter.listCollections();
      if (collections.length === 0) return '';

      if (collections.length > 10) {
        return `\n### Database Collections Overview (${collections.length} collections):\n${collections.join(', ')}\n(Call \`get_collection_schema\` to inspect fields for any specific collection before modifying).\n`;
      }

      const schemaRecord = await this.adapter.getDatabaseSchema();
      return `\n### Discovered Database Schema Context:\n` + this.adapter.formatSchemaForLLM(schemaRecord);
    } catch {
      return '';
    }
  }

  public async initSession() {
    const ai = getGeminiClient();
    const model = getModelName();
    const dbContext = await this.fetchDatabaseContext();

    const enrichedSystemPrompt = `${TASK_AGENT_SYSTEM_PROMPT}\n${dbContext}`;

    this.chat = ai.chats.create({
      model,
      config: {
        systemInstruction: enrichedSystemPrompt,
        tools: [
          {
            functionDeclarations: taskAgentFunctionDeclarations
          }
        ]
      }
    });
  }

  private async sendWithRetry(message: any, maxRetries = 2): Promise<any> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.chat.sendMessage({ message });
      } catch (err: any) {
        const isRateLimit =
          err?.status === 429 ||
          err?.message?.includes('429') ||
          err?.message?.includes('RESOURCE_EXHAUSTED');

        if (isRateLimit && attempt < maxRetries) {
          logger.warn(`Rate limit reached on Gemini Free Tier. Waiting 20 seconds before retry...`);
          await new Promise((res) => setTimeout(res, 20000));
          continue;
        }
        throw err;
      }
    }
  }

  public async ask(userQuery: string): Promise<string> {
    if (!this.chat) {
      await this.initSession();
    }

    let response = await this.sendWithRetry(userQuery);
    let maxSteps = 6;
    let stepCount = 0;

    while (response.functionCalls && response.functionCalls.length > 0 && stepCount < maxSteps) {
      stepCount++;
      const toolResponses = [];

      for (const call of response.functionCalls) {
        try {
          const result = await executeTaskTool(call.name, call.args || {}, this.adapter);
          toolResponses.push(
            createPartFromFunctionResponse(call.id || '', call.name, {
              success: true,
              data: result
            })
          );
        } catch (toolErr: any) {
          logger.warn(`Tool execution error for "${call.name}": ${toolErr.message}`);
          toolResponses.push(
            createPartFromFunctionResponse(call.id || '', call.name, {
              success: false,
              error: toolErr.message
            })
          );
        }
      }

      response = await this.sendWithRetry(toolResponses);
    }

    return response.text || 'No response generated.';
  }
}
