import { GoogleGenAI } from '@google/genai';
import { getEnvConfig } from '../config/env.js';

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const config = getEnvConfig();
    aiClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return aiClient;
}

export function getModelName(): string {
  const config = getEnvConfig();
  return config.GEMINI_MODEL || 'gemini-2.5-flash';
}
