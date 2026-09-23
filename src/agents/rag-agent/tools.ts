import { getDatabase } from '../../config/db.js';
import { generateEmbedding, cosineSimilarity } from '../../llm/embeddings.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

export const ragAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'semantic_search',
    description: 'Performs semantic vector search across any collection or knowledge base in the MongoDB database to find relevant documents by meaning and context.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The natural language search query, concept, or question.'
        },
        collectionName: {
          type: Type.STRING,
          description: 'The collection to search (e.g. "knowledge_base", "documents", "articles", "products", or any custom collection). Default is "knowledge_base".'
        },
        vectorField: {
          type: Type.STRING,
          description: 'The document field containing vector embeddings (default is "embedding").'
        },
        limit: {
          type: Type.INTEGER,
          description: 'Number of top similar documents to return (default 3, max 10).'
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
          description: 'Category (e.g., "Policy", "Technical Support", "Offers", "Guidelines").'
        },
        content: {
          type: Type.STRING,
          description: 'Full textual content of the document.'
        },
        collectionName: {
          type: Type.STRING,
          description: 'Target collection name (default is "knowledge_base").'
        }
      },
      required: ['title', 'category', 'content']
    }
  }
];

import { Db } from 'mongodb';

export async function executeRagTool(name: string, args: any, dbInstance?: Db): Promise<any> {
  const db = dbInstance || getDatabase();

  switch (name) {
    case 'semantic_search': {
      const { query, collectionName = 'knowledge_base', vectorField = 'embedding', limit = 3 } = args;
      const targetCol = collectionName.trim() || 'knowledge_base';
      const vField = vectorField.trim() || 'embedding';
      const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 10);

      logger.tool('semantic_search', `Target: "${targetCol}", Field: "${vField}", Query: "${query}"`);

      // 1. Generate query embedding
      const queryVector = await generateEmbedding(query);

      // 2. Try Atlas $vectorSearch if available
      try {
        const atlasPipeline = [
          {
            $vectorSearch: {
              index: 'vector_index',
              path: vField,
              queryVector,
              numCandidates: 20,
              limit: safeLimit
            }
          },
          {
            $project: {
              [vField]: 0,
              score: { $meta: 'vectorSearchScore' }
            }
          }
        ];

        const atlasResults = await db.collection(targetCol).aggregate(atlasPipeline).toArray();
        if (atlasResults.length > 0) {
          logger.result(`Atlas $vectorSearch matched ${atlasResults.length} document(s) in "${targetCol}"`);
          return {
            query,
            collection: targetCol,
            matches: atlasResults
          };
        }
      } catch {
        // Fall back to direct cosine similarity (expected for local MongoDB or unindexed collections)
      }

      // 3. Fallback: In-database cosine similarity matching
      const docs = await db.collection(targetCol).find({ [vField]: { $exists: true } }).toArray();

      if (docs.length === 0) {
        // Check if there are collections that DO have embeddings
        const allCols = await db.listCollections().toArray();
        const candidateCols: string[] = [];
        for (const c of allCols) {
          if (!c.name.startsWith('system.')) {
            const hasVec = await db.collection(c.name).findOne({ [vField]: { $exists: true } });
            if (hasVec) candidateCols.push(c.name);
          }
        }

        const candidateNote =
          candidateCols.length > 0
            ? ` Collections with vector embeddings detected: [${candidateCols.join(', ')}].`
            : ` No collections found with field "${vField}".`;

        return {
          message: `No documents with vector embeddings found in "${targetCol}".${candidateNote}`
        };
      }

      const scoredDocs = docs
        .filter((doc) => Array.isArray(doc[vField]))
        .map((doc) => {
          const similarity = cosineSimilarity(queryVector, doc[vField] as number[]);
          // Omit large embedding vector from output to save context window
          const { [vField]: _emb, ...rest } = doc;
          return {
            ...rest,
            similarityScore: `${(similarity * 100).toFixed(1)}%`,
            rawScore: similarity
          };
        })
        .sort((a, b) => b.rawScore - a.rawScore)
        .slice(0, safeLimit);

      logger.result(`Matched top ${scoredDocs.length} document(s) in "${targetCol}" (Highest match: ${scoredDocs[0]?.similarityScore})`);

      return {
        query,
        collection: targetCol,
        matches: scoredDocs
      };
    }

    case 'add_knowledge_document': {
      const { title, category, content, collectionName = 'knowledge_base' } = args;
      const targetCol = collectionName.trim() || 'knowledge_base';
      logger.tool('add_knowledge_document', `Title: "${title}", Collection: "${targetCol}"`);

      const textToEmbed = `${title}\nCategory: ${category}\n${content}`;
      const embedding = await generateEmbedding(textToEmbed);

      const docId = `DOC-${Date.now().toString().slice(-4)}`;
      await db.collection(targetCol).insertOne({
        docId,
        title,
        category,
        content,
        embedding,
        createdAt: new Date()
      });

      logger.result(`Added document with ID: ${docId} to "${targetCol}"`);
      return {
        success: true,
        docId,
        collection: targetCol,
        message: `Successfully indexed document "${title}" into "${targetCol}".`
      };
    }

    default:
      throw new Error(`Unknown RAG tool: "${name}"`);
  }
}
