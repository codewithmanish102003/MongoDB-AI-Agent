import { getDatabase } from '../../config/db.js';
import { generateEmbedding, cosineSimilarity } from '../../llm/embeddings.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

export const ragAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'semantic_search',
    description: 'Performs semantic vector search across products or knowledge base to find relevant items by meaning and context.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The natural language search query or concept (e.g., "office chair for back support", "return damaged package policy").'
        },
        collectionName: {
          type: Type.STRING,
          description: 'Which collection to search: "products" or "knowledge_base". Default is "knowledge_base".'
        },
        limit: {
          type: Type.INTEGER,
          description: 'Number of top similar documents to return (default 3, max 5).'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'add_knowledge_document',
    description: 'Adds a new article, policy, or FAQ into the knowledge base and indexes its vector embedding.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: 'Title of the knowledge document.'
        },
        category: {
          type: Type.STRING,
          description: 'Category (e.g., "Policy", "Technical Support", "Offers").'
        },
        content: {
          type: Type.STRING,
          description: 'Full textual content of the document.'
        }
      },
      required: ['title', 'category', 'content']
    }
  }
];

export async function executeRagTool(name: string, args: any): Promise<any> {
  const db = getDatabase();

  switch (name) {
    case 'semantic_search': {
      const { query, collectionName = 'knowledge_base', limit = 3 } = args;
      const targetCol = collectionName === 'products' ? 'products' : 'knowledge_base';
      const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 5);

      logger.tool('semantic_search', `Target: "${targetCol}", Query: "${query}"`);

      // 1. Generate query embedding
      const queryVector = await generateEmbedding(query);

      // 2. Try Atlas $vectorSearch if available
      try {
        const atlasPipeline = [
          {
            $vectorSearch: {
              index: 'vector_index',
              path: 'embedding',
              queryVector,
              numCandidates: 20,
              limit: safeLimit
            }
          },
          {
            $project: {
              embedding: 0,
              score: { $meta: 'vectorSearchScore' }
            }
          }
        ];

        const atlasResults = await db.collection(targetCol).aggregate(atlasPipeline).toArray();
        if (atlasResults.length > 0) {
          logger.result(`Atlas $vectorSearch matched ${atlasResults.length} document(s)`);
          return { matches: atlasResults };
        }
      } catch {
        // Fall back to direct cosine similarity (expected for local MongoDB)
      }

      // 3. Fallback: In-database cosine similarity matching
      const docs = await db.collection(targetCol).find({ embedding: { $exists: true } }).toArray();

      if (docs.length === 0) {
        return {
          message: `No documents with vector embeddings found in "${targetCol}". Please run "npm run seed:vectors" to generate embeddings.`
        };
      }

      const scoredDocs = docs
        .map((doc) => {
          const similarity = cosineSimilarity(queryVector, doc.embedding as number[]);
          // Omit large embedding vector from output
          const { embedding, ...rest } = doc;
          return {
            ...rest,
            similarityScore: `${(similarity * 100).toFixed(1)}%`,
            rawScore: similarity
          };
        })
        .sort((a, b) => b.rawScore - a.rawScore)
        .slice(0, safeLimit);

      logger.result(`Matched top ${scoredDocs.length} document(s) (Highest match: ${scoredDocs[0]?.similarityScore})`);

      return {
        query,
        collection: targetCol,
        matches: scoredDocs
      };
    }

    case 'add_knowledge_document': {
      const { title, category, content } = args;
      logger.tool('add_knowledge_document', `Title: "${title}"`);

      const textToEmbed = `${title}\nCategory: ${category}\n${content}`;
      const embedding = await generateEmbedding(textToEmbed);

      const docId = `KB-${Date.now().toString().slice(-4)}`;
      await db.collection('knowledge_base').insertOne({
        docId,
        title,
        category,
        content,
        embedding,
        createdAt: new Date()
      });

      logger.result(`Added knowledge document with ID: ${docId}`);
      return {
        success: true,
        docId,
        message: `Successfully indexed document "${title}" into knowledge_base.`
      };
    }

    default:
      throw new Error(`Unknown RAG tool: "${name}"`);
  }
}
