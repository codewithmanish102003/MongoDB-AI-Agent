import readline from 'readline';
import chalk from 'chalk';
import { connectToDatabase, closeDatabase } from './config/db.js';
import { UnifiedAgent } from './agents/unified-agent.js';
import { seedDatabase } from './data/seed.js';
import { seedKnowledgeAndEmbeddings } from './data/seed-knowledge.js';
import { logger } from './utils/logger.js';
import { getEnvConfig } from './config/env.js';

async function main() {
  console.clear();
  console.log(chalk.bold.hex('#10b981')(`
  ╔═══════════════════════════════════════════════════════╗
  ║            🍃 MongoDB AI Super Agent 🤖               ║
  ║     Database Analytics + Semantic Vector RAG          ║
  ║               Powered by Google Gemini                ║
  ╚═══════════════════════════════════════════════════════╝
  `));

  // 1. Check configuration
  const config = getEnvConfig();
  if (!config.GEMINI_API_KEY || config.GEMINI_API_KEY.includes('your_gemini_api_key_here')) {
    logger.error('GEMINI_API_KEY is not configured in .env file!');
    console.log(chalk.yellow('\nPlease open .env and add your Gemini API key:'));
    console.log(chalk.cyan('GEMINI_API_KEY=AIzaSy...\n'));
    process.exit(1);
  }

  // 2. Connect to MongoDB
  let dbInstance;
  try {
    const { db } = await connectToDatabase();
    dbInstance = db;
  } catch (err: any) {
    logger.error('Could not connect to MongoDB. Please make sure MongoDB is running.', err);
    process.exit(1);
  }

  // 3. Check existing collections in the database
  const collections = await dbInstance.listCollections().toArray();
  const validCollections = collections.filter((c) => !c.name.startsWith('system.'));
  logger.info(`Detected ${validCollections.length} collections in "${dbInstance.databaseName}": ${validCollections.map((c) => chalk.cyan(c.name)).join(', ')}`);

  // 4. Initialize Unified Agent
  logger.info(`Primary LLM: ${chalk.bold.magenta(config.GEMINI_MODEL)}`);
  if (config.OPENROUTER_API_KEY) {
    logger.info(`Fallback LLM: ${chalk.bold.cyan(`OpenRouter (${config.OPENROUTER_MODEL})`)}`);
  }
  const agent = new UnifiedAgent();
  await agent.initSession();
  logger.info(`Active Session: ${chalk.bold.yellow(agent.currentSession?.sessionId || 'SESSION-DEFAULT')}`);
  logger.success('Super Agent ready! (MQL, Vector Search, Actions & Long-Term Memory)\n');

  console.log(chalk.dim('Example prompts to try:'));
  console.log(chalk.gray(' • Analytics: "Total sales revenue kitna h category wise?"'));
  console.log(chalk.gray(' • Vector Search: "Back pain ke liye suitable desk ya chair suggest karo"'));
  console.log(chalk.gray(' • Policy RAG: "Damaged item receive hone par return policy kya h?"'));
  console.log(chalk.gray(' • Autonomous Task: "Order ORD-5003 cancel kardo aur reason me likho customer request"'));
  console.log(chalk.gray(' • Long-Term Memory: "Yaad rakhna mera favorite payment mode UPI hai aur main Mumbai se hoon"'));
  console.log(chalk.gray(' • Recall Memory: "Mere baare me kya-kya jante ho?"'));
  console.log(chalk.dim('\nSpecial commands:'));
  console.log(chalk.dim(' • "memory" -> View all stored long-term facts'));
  console.log(chalk.dim(' • "sessions" -> List past chat sessions'));
  console.log(chalk.dim(' • "new" -> Start a new conversation session'));
  console.log(chalk.dim(' • "seed" -> Re-seed e-commerce data'));
  console.log(chalk.dim(' • "seed:vectors" -> Re-generate vector embeddings'));
  console.log(chalk.dim(' • "clear" -> Clear screen'));
  console.log(chalk.dim(' • "exit" -> Exit\n'));

  // 5. Interactive Readline Loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const promptUser = () => {
    rl.question(chalk.bold.hex('#38bdf8')(`\n[${agent.currentSession?.sessionId || 'CLI'}] Ask Agent > `), async (input) => {
      const query = input.trim();

      if (!query) {
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit') {
        logger.info('Shutting down...');
        rl.close();
        await closeDatabase();
        process.exit(0);
      }

      if (query.toLowerCase() === 'clear') {
        console.clear();
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'memory') {
        const facts = await agent.memoryStore.getUserFacts();
        logger.divider();
        console.log(chalk.bold.magenta(`🧠 Stored Long-Term Memories (${facts.length}):`));
        if (facts.length === 0) {
          console.log(chalk.dim('  (No memories recorded yet. Tell the agent facts about yourself!)'));
        } else {
          facts.forEach((f) => {
            console.log(chalk.cyan(` • [${f.category}] ${chalk.bold(f.key)}: `) + chalk.white(f.value));
          });
        }
        logger.divider();
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'sessions') {
        const sessionsList = await agent.memoryStore.listSessions();
        logger.divider();
        console.log(chalk.bold.yellow(`🗂️ Stored Conversation Sessions (${sessionsList.length}):`));
        sessionsList.forEach((s) => {
          console.log(
            chalk.cyan(` • ${chalk.bold(s.sessionId)}: `) +
            chalk.white(`${s.messageCount} messages | Last active: ${new Date(s.lastActive).toLocaleTimeString()}`)
          );
        });
        logger.divider();
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'new') {
        await agent.initSession();
        logger.success(`Started new session: ${chalk.bold.yellow(agent.currentSession?.sessionId)}`);
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'seed') {
        await seedDatabase();
        promptUser();
        return;
      }

      if (query.toLowerCase() === 'seed:vectors') {
        await seedKnowledgeAndEmbeddings();
        promptUser();
        return;
      }

      try {
        logger.divider();
        const startTime = Date.now();
        const answer = await agent.ask(query);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        const providerBadge =
          agent.lastProviderUsed === 'gemini'
            ? chalk.bold.bgHex('#2563eb').white(' ⚡ Gemini 3.6 Flash ')
            : chalk.bold.bgHex('#7c3aed').white(' 🛡️ OpenRouter (Llama 3.3 70B) ');

        console.log('');
        console.log(chalk.hex('#10b981')('┌─────────────────────────────────────────────────────────────────────────────┐'));
        console.log(chalk.hex('#10b981')('│ ') + chalk.bold.white('🤖 Super Agent Response') + ' ' + providerBadge + chalk.hex('#64748b')(` (${duration}s)`) + chalk.hex('#10b981')(''.padStart(14, ' ') + '│'));
        console.log(chalk.hex('#10b981')('├─────────────────────────────────────────────────────────────────────────────┘'));
        console.log(chalk.white(answer));
        console.log(chalk.hex('#10b981')('└─────────────────────────────────────────────────────────────────────────────\n'));
      } catch (err: any) {
        logger.error('Error answering question:', err);
      }

      promptUser();
    });
  };

  promptUser();
}

main().catch((err) => {
  logger.error('Fatal CLI Error', err);
  process.exit(1);
});
