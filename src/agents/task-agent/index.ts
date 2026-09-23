import { getGeminiClient, getModelName } from '../../llm/gemini.js';
import { taskAgentFunctionDeclarations, executeTaskTool } from './tools.js';
import { TASK_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { logger } from '../../utils/logger.js';
import { createPartFromFunctionResponse } from '@google/genai';

export class TaskAgent {
  private chat: any = null;

  public async initSession() {
    const ai = getGeminiClient();
    const model = getModelName();

    this.chat = ai.chats.create({
      model,
      config: {
        systemInstruction: TASK_AGENT_SYSTEM_PROMPT,
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
          const result = await executeTaskTool(call.name, call.args || {});
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
