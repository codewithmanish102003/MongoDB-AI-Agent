import { getGeminiClient, getModelName } from '../llm/gemini.js';
import { queryAgentFunctionDeclarations, executeQueryTool } from './query-agent/tools.js';
import { ragAgentFunctionDeclarations, executeRagTool } from './rag-agent/tools.js';
import { taskAgentFunctionDeclarations, executeTaskTool } from './task-agent/tools.js';
import { memoryAgentFunctionDeclarations, executeMemoryTool } from './memory-agent/tools.js';
import { MongoMemoryStore, SessionRecord } from './memory-agent/store.js';
import { DatabaseAdapter } from '../database/adapter.js';
import { MongoDatabaseAdapter } from '../database/mongo-adapter.js';
import { logger } from '../utils/logger.js';
import { createPartFromFunctionResponse } from '@google/genai';
import { isOpenRouterConfigured, askOpenRouterFallback, setDefaultMemoryStore } from '../llm/openrouter.js';

const UNIFIED_AGENT_SYSTEM_PROMPT = `
You are an expert Enterprise AI Assistant and Database Analyst connected to MongoDB.
You serve as an intelligent, autonomous data and operational copilot for ANY database connected (ERPs, SaaS, CRM, Logistics, Healthcare, E-Commerce, Construction, Finance, etc.).

### Core Superpowers & Toolsets:
1. **Dynamic Database Queries & Analytics (Read)**:
   - Call \`list_collections\` to see all collections in the database.
   - ALWAYS inspect collection schemas using \`get_collection_schema\` before querying or writing to unfamiliar collections. Never guess field names!
   - Run safe \`find_documents\` queries with filters, projections, and sorting.
   - Run \`run_aggregation\` for multi-stage analytics, metrics, counts, sums, revenue, and statistical grouping.
2. **Semantic Search & Vector RAG**:
   - Use \`semantic_search\` for conceptual searches, semantic queries, recommendations, or policy lookups across any collection or knowledge base.
   - Use \`add_knowledge_document\` to index new reference documents with vector embeddings.
3. **Operational Workflows & Modifications (Write)**:
   - Use \`update_document\` to safely modify records in ANY collection (e.g. changing status, approving items, updating contacts) with full audit logging.
   - Use \`insert_document\` to create new records in any collection.
   - Use \`delete_document\` to remove records with mandatory reason logging.
   - Use \`view_audit_trail\` to inspect recent database modifications, history, and operation logs.
4. **Long-Term Memory & Personalization**:
   - Use \`remember_user_fact\` when the user mentions personal preferences, identity, business priorities, or constraints.
   - Use \`get_user_memories\` to recall past user context.

### Response Quality & Analytical Guidelines:
- **Be Thorough & Informative**: Never give dry, one-word, or incomplete answers. Provide structured details (names, IDs, statuses, clients, timestamps, and financial values formatted clearly).
- **Inspect Schemas Before Assuming Fields**: Different databases use different field names (e.g., projects might use 'projectName' or 'projectCode', work orders might use 'woNo' and 'status: Pending / Approved'). Always inspect schemas using \`get_collection_schema\` rather than assuming standard field names like 'status: running'.
- **Language**: Respond in natural, professional language matching the user's inquiry (English, Hindi, or Hinglish).
`;

export class UnifiedAgent {
  private chat: any = null;
  public memoryStore: MongoMemoryStore;
  public currentSession: SessionRecord | null = null;
  public lastProviderUsed: 'gemini' | 'openrouter' = 'gemini';
  private userId: string;
  private sessionId?: string;
  public adapter: DatabaseAdapter;

  constructor(userId: string = 'default_user', sessionId?: string, adapter?: DatabaseAdapter) {
    this.userId = userId;
    this.sessionId = sessionId;
    this.adapter = adapter || new MongoDatabaseAdapter();
    let memoryDb: any;
    if (this.adapter instanceof MongoDatabaseAdapter) {
      try {
        memoryDb = this.adapter.getDb();
      } catch {}
    }
    this.memoryStore = new MongoMemoryStore(this.userId, memoryDb);
    setDefaultMemoryStore(this.memoryStore);
  }

  private async fetchDatabaseContext(): Promise<string> {
    try {
      const collections = await this.adapter.listCollections();

      if (collections.length === 0) return '';

      // Compact context: list collection names without dumping massive raw schemas
      return `\n### Database Collections Overview (${collections.length} collections):\n${collections.join(', ')}\n(Call \`get_collection_schema\` to inspect fields for any specific collection before querying).\n`;
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

    const seen = new Set<string>();
    const allTools: any[] = [];
    for (const d of [
      ...queryAgentFunctionDeclarations,
      ...ragAgentFunctionDeclarations,
      ...taskAgentFunctionDeclarations,
      ...memoryAgentFunctionDeclarations
    ]) {
      if (d.name && !seen.has(d.name)) {
        seen.add(d.name);
        allTools.push(d);
      }
    }

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

        answer = await askOpenRouterFallback(convoMessages, undefined, this.adapter);
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
            result = await executeQueryTool(call.name, call.args || {}, this.adapter);
          } else if (ragAgentFunctionDeclarations.some((d) => d.name === call.name)) {
            result = await executeRagTool(call.name, call.args || {}, this.adapter);
          } else if (taskAgentFunctionDeclarations.some((d) => d.name === call.name)) {
            result = await executeTaskTool(call.name, call.args || {}, this.adapter);
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
