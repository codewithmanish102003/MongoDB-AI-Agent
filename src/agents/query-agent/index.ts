import { getGeminiClient, getModelName } from '../../llm/gemini.js';
import { queryAgentFunctionDeclarations, executeQueryTool } from './tools.js';
import { QUERY_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { logger } from '../../utils/logger.js';
import { getDatabase } from '../../config/db.js';
import { createPartFromFunctionResponse } from '@google/genai';

export class QueryAgent {
  private chat: any = null;

  private async fetchDatabaseContext(): Promise<string> {
    try {
      const db = getDatabase();
      const collections = await db.listCollections().toArray();
      const valid = collections.filter((c) => !c.name.startsWith('system.'));

      if (valid.length > 10) {
        return `\n### Database Collections Overview (${valid.length} collections):\n${valid.map((c) => c.name).join(', ')}\n(Call \`get_collection_schema\` to inspect fields for any specific collection before querying).\n`;
      }

      let schemaSummary = '\n### Current Database Schema Context:\n';
      for (const col of valid) {
        const samples = await db.collection(col.name).find({}).limit(1).toArray();
        if (samples.length > 0) {
          const sampleKeys = Object.entries(samples[0])
            .map(([k, v]) => `${k} (${Array.isArray(v) ? 'Array' : typeof v})`)
            .join(', ');
          schemaSummary += `- Collection \`${col.name}\`: Fields -> [${sampleKeys}]\n`;
        } else {
          schemaSummary += `- Collection \`${col.name}\`: (Empty collection)\n`;
        }
      }
      return schemaSummary;
    } catch {
      return '';
    }
  }

  public async initSession() {
    const ai = getGeminiClient();
    const model = getModelName();
    const dbContext = await this.fetchDatabaseContext();

    const enrichedSystemPrompt = `${QUERY_AGENT_SYSTEM_PROMPT}\n${dbContext}`;

    this.chat = ai.chats.create({
      model,
      config: {
        systemInstruction: enrichedSystemPrompt,
        tools: [
          {
            functionDeclarations: queryAgentFunctionDeclarations
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
        const isRateLimit = err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
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
    let maxSteps = 10;
    let stepCount = 0;

    while (response.functionCalls && response.functionCalls.length > 0 && stepCount < maxSteps) {
      stepCount++;
      const toolResponses = [];

      for (const call of response.functionCalls) {
        try {
          const result = await executeQueryTool(call.name, call.args || {});
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

      // Send tool results back to the model with retry
      response = await this.sendWithRetry(toolResponses);
    }

    return response.text || 'No response generated.';
  }
}
