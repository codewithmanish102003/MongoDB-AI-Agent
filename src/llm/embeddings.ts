import { getGeminiClient } from './gemini.js';
import { logger } from '../utils/logger.js';

export async function generateEmbedding(text: string): Promise<number[]> {
  const ai = getGeminiClient();
  const cleanedText = text.trim();

  if (!cleanedText) {
    throw new Error('Cannot generate embedding for empty text.');
  }

  try {
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: cleanedText
    });

    const values = response.embeddings?.[0]?.values || (response as any).embedding?.values;

    if (!values || values.length === 0) {
      throw new Error('No embedding values returned by Gemini API.');
    }

    return values;
  } catch (error: any) {
    logger.error(`Error generating embedding: ${error.message}`);
    throw error;
  }
}

/**
 * Calculates Cosine Similarity between two numerical vectors.
 * Returns a value between -1.0 and 1.0 (1.0 means identical angle/direction).
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error(`Vector dimension mismatch: ${vecA.length} vs ${vecB.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
