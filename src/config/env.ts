import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('meta-llama/llama-3.3-70b-instruct'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  MONGODB_DATABASE: z.string().default('mongodb_ai_agent_db')
});

export type EnvConfig = z.infer<typeof envSchema>;

export function getEnvConfig(): EnvConfig {
  dotenv.config();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('\n❌ Environment Configuration Error:');
    parsed.error.issues.forEach((issue) => {
      console.error(` - ${issue.path.join('.')}: ${issue.message}`);
    });
    console.error('\nPlease update your .env file with valid settings.\n');
    process.exit(1);
  }
  return parsed.data;
}
