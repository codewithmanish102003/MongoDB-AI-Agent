import { getGeminiClient, getModelName } from '../llm/gemini.js';
import { queryAgentFunctionDeclarations, executeQueryTool } from './query-agent/tools.js';
import { ragAgentFunctionDeclarations, executeRagTool } from './rag-agent/tools.js';
import { taskAgentFunctionDeclarations, executeTaskTool } from './task-agent/tools.js';
import { memoryAgentFunctionDeclarations, executeMemoryTool } from './memory-agent/tools.js';
import { MongoMemoryStore, SessionRecord } from './memory-agent/store.js';
import { logger } from '../utils/logger.js';
import { getDatabase } from '../config/db.js';
import { createPartFromFunctionResponse } from '@google/genai';
import { isOpenRouterConfigured, askOpenRouterFallback, setDefaultMemoryStore } from '../llm/openrouter.js';

const UNIFIED_AGENT_SYSTEM_PROMPT = `
You are an expert Enterprise AI Assistant and Database Analyst connected to MongoDB.
You serve as an intelligent data copilot for this database.

### Core Superpowers:
1. **Database Queries & Analytics**:
   - Inspect collection schemas using \`get_collection_schema\` before querying unfamiliar collections.
   - Run safe \`find_documents\` queries with filters, projections, and sorting.
   - Run \`run_aggregation\` for calculations, counts, sums, revenue, and statistical grouping.
2. **Semantic Search & RAG**:
   - Use \`semantic_search\` for conceptual searches or policy questions.
3. **Operational Workflows**:
   - Use \`update_order_status\`, \`adjust_product_inventory\`, \`create_new_order\`, \`view_audit_trail\`.
4. **Long-Term Memory**:
   - Use \`remember_user_fact\` when the user tells you personal preferences or constraints.

### Response Quality & Analytical Guidelines:
- **Be Thorough & Informative**: Never give dry, one-word, or incomplete answers. When asked about projects, orders, vendors, or expenses, provide structured details (e.g. names, IDs, statuses, clients, and financial values formatted clearly in INR ₹).
- **Inspect Schemas Before Assuming Fields**: Different databases use different field names (e.g., a project might have 'name' or 'projectName'; a work order might have 'woNo' and 'status: Pending / Approved'). Always verify field names and sample values using \`get_collection_schema\` rather than assuming standard field names like 'status: running'.
- **Language**: Respond in natural, professional language matching the user's inquiry (English, Hindi, or Hinglish).
`;

export class UnifiedAgent {
  private chat: any = null;
  public memoryStore: MongoMemoryStore;
  public currentSession: SessionRecord | null = null;
  public lastProviderUsed: 'gemini' | 'openrouter' = 'gemini';
  private userId: string;
  private sessionId?: string;

  constructor(userId: string = 'default_user', sessionId?: string) {
    this.userId = userId;
    this.sessionId = sessionId;
    this.memoryStore = new MongoMemoryStore(this.userId);
    setDefaultMemoryStore(this.memoryStore);
  }

  private async fetchDatabaseContext(): Promise<string> {
    try {
      const db = getDatabase();
      const collections = await db.listCollections().toArray();
      const valid = collections.filter((c) => !c.name.startsWith('system.'));

      if (valid.length === 0) return '';

      // Compact context: list collection names without dumping massive raw schemas
      return `\n### Database Collections Overview (${valid.length} collections):\n${valid.map((c) => c.name).join(', ')}\n(Call \`get_collection_schema\` to inspect fields for any specific collection before querying).\n`;
    } catch {
      return '';
    }
  }

  private async fetchMemoryContext(): Promise<string> {
    try {
      const facts = await this.memoryStore.getUserFacts();
      if (facts.length === 0) return '';
      let memorySummary = '\n### User Long-Term Memories & Preferences:\n';
      for (const f of facts) {
        memorySummary += `- [${f.category}] ${f.key}: "${f.value}"\n`;
      }
      return memorySummary;
    } catch {
      return '';
    }
  }

  public async initSession() {
    const ai = getGeminiClient();
    const model = getModelName();

    this.currentSession = await this.memoryStore.getOrCreateSession(this.sessionId);
    const dbContext = await this.fetchDatabaseContext();
    const memoryContext = await this.fetchMemoryContext();

    const allTools = [
      ...queryAgentFunctionDeclarations,
      ...ragAgentFunctionDeclarations,
      ...taskAgentFunctionDeclarations,
      ...memoryAgentFunctionDeclarations
    ];

    this.chat = ai.chats.create({
      model,
      config: {
        systemInstruction: `${UNIFIED_AGENT_SYSTEM_PROMPT}\n${dbContext}\n${memoryContext}`,
        tools: [{ functionDeclarations: allTools }]
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

        if (isRateLimit) {
          if (isOpenRouterConfigured()) {
            throw err;
          }
          if (attempt < maxRetries) {
            let delayMs = 30000;
            const match = err?.message?.match(/retryDelay":"(\d+)s"/);
            if (match && match[1]) {
              delayMs = (parseInt(match[1], 10) + 2) * 1000;
            }
            logger.warn(`Rate limit reached on Gemini Free Tier. Waiting ${Math.round(delayMs / 1000)}s before retry...`);
            await new Promise((res) => setTimeout(res, delayMs));
            continue;
          }
        }
        throw err;
      }
    }
  }

  public async ask(userQuery: string): Promise<string> {
    if (!this.chat || !this.currentSession) {
      await this.initSession();
    }

    const currentSessionId = this.currentSession?.sessionId || 'SESSION-DEFAULT';

    // 1. Fetch previous conversation history for multi-turn context
    const recentHistory = await this.memoryStore.getRecentMessages(currentSessionId, 6);

    // 2. Record user message in MongoDB
    await this.memoryStore.saveMessage(currentSessionId, 'user', userQuery);

    let answer = '';

    try {
      this.lastProviderUsed = 'gemini';
      answer = await this.askGemini(userQuery);
    } catch (err: any) {
      if (isOpenRouterConfigured()) {
        this.lastProviderUsed = 'openrouter';
        logger.warn(`Gemini issue detected: ${err.message}. Seamlessly switching to OpenRouter...`);
        const dbContext = await this.fetchDatabaseContext();
        const memoryContext = await this.fetchMemoryContext();

        // Build messages array with conversation history
        const convoMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: `${UNIFIED_AGENT_SYSTEM_PROMPT}\n${dbContext}\n${memoryContext}` }
        ];

        // Append recent chat history
        recentHistory.forEach((msg) => {
          if (msg.role === 'user' || msg.role === 'assistant') {
            convoMessages.push({ role: msg.role, content: msg.content });
          }
        });

        // Append current user message
        convoMessages.push({ role: 'user', content: userQuery });

        answer = await askOpenRouterFallback(convoMessages);
      } else {
        throw err;
      }
    }

    // 3. Record assistant answer in MongoDB
    if (answer) {
      await this.memoryStore.saveMessage(currentSessionId, 'assistant', answer);
    }

    return answer;
  }

  private async askGemini(userQuery: string): Promise<string> {
    let response = await this.sendWithRetry(userQuery);
    let maxSteps = 8;
    let stepCount = 0;

    while (response.functionCalls && response.functionCalls.length > 0 && stepCount < maxSteps) {
      stepCount++;
      const toolResponses = [];

      for (const call of response.functionCalls) {
        try {
          let result: any;
          if (queryAgentFunctionDeclarations.some((d) => d.name === call.name)) {
            result = await executeQueryTool(call.name, call.args || {});
          } else if (ragAgentFunctionDeclarations.some((d) => d.name === call.name)) {
            result = await executeRagTool(call.name, call.args || {});
          } else if (taskAgentFunctionDeclarations.some((d) => d.name === call.name)) {
            result = await executeTaskTool(call.name, call.args || {});
          } else {
            result = await executeMemoryTool(call.name, call.args || {}, this.memoryStore);
          }

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
