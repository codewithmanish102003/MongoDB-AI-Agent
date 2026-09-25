import { DatabaseAdapter } from '../../database/adapter.js';
import { MongoDatabaseAdapter } from '../../database/mongo-adapter.js';
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

let defaultRagAdapter: DatabaseAdapter = new MongoDatabaseAdapter();

export function setDefaultRagDatabaseAdapter(adapter: DatabaseAdapter) {
  defaultRagAdapter = adapter;
}

export async function executeRagTool(name: string, args: any, adapter?: DatabaseAdapter): Promise<any> {
  const currentAdapter = adapter || defaultRagAdapter;

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

        const atlasResults = await currentAdapter.aggregate({
          collection: targetCol,
          pipeline: atlasPipeline,
          limit: safeLimit
        });
        if (atlasResults.results.length > 0) {
          logger.result(`Atlas $vectorSearch matched ${atlasResults.results.length} document(s) in "${targetCol}"`);
          return {
            query,
            collection: targetCol,
            matches: atlasResults.results
          };
        }
      } catch {
        // Fall back to direct cosine similarity (expected for local MongoDB or unindexed collections)
      }

      // 3. Fallback: In-database cosine similarity matching
      const findRes = await currentAdapter.find({
        collection: targetCol,
        filter: { [vField]: { $exists: true } },
        limit: 100
      });
      const docs = findRes.documents;

      if (docs.length === 0) {
        // Check if there are collections that DO have embeddings
        const allCols = await currentAdapter.listCollections();
        const candidateCols: string[] = [];
        for (const c of allCols) {
          if (!c.startsWith('system.')) {
            try {
              const sample = await currentAdapter.find({
                collection: c,
                filter: { [vField]: { $exists: true } },
                limit: 1
              });
              if (sample.documents.length > 0) candidateCols.push(c);
            } catch {}
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
      await currentAdapter.insert({
        collection: targetCol,
        document: {
          docId,
          title,
          category,
          content,
          embedding,
          createdAt: new Date()
        }
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
