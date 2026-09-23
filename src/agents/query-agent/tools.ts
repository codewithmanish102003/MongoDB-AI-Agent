import { getDatabase } from '../../config/db.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

// 1. Tool Declarations for Gemini
export const queryAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'list_collections',
    description: 'Lists all available collections in the MongoDB database.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'get_collection_schema',
    description: 'ESSENTIAL FIRST STEP: Inspects the exact field names, data types, and sample record of a collection. Always call this BEFORE find_documents or run_aggregation so you never guess field names.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The name of the collection to inspect (e.g., "projects", "workorders", "expenses", "vendors").'
        }
      },
      required: ['collectionName']
    }
  },
  {
    name: 'find_documents',
    description: 'Executes a MongoDB find query with optional filter, projection, sort, and limit. Leave projection empty unless necessary, so full document fields are returned without missing data.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to query.'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string for filter query (e.g. \'{"status": "Pending"}\'). Default is \'{}\'.'
        },
        projection: {
          type: Type.STRING,
          description: 'Optional JSON string for projection. Prefer leaving empty to avoid omitting required fields.'
        },
        sort: {
          type: Type.STRING,
          description: 'JSON string for sorting (e.g., \'{"createdAt": -1}\').'
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum documents to return (default 10, max 50).'
        }
      },
      required: ['collectionName']
    }
  },
  {
    name: 'run_aggregation',
    description: 'Executes a MongoDB aggregation pipeline for calculations, grouping, summing, filtering, or sorting.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to run the aggregation on.'
        },
        pipeline: {
          type: Type.STRING,
          description: 'JSON string array of aggregation pipeline stages (e.g. \'[{"$match": {"status": "delivered"}}, {"$group": {"_id": "$paymentMethod", "totalRevenue": {"$sum": "$totalAmount"}}}]\').'
        },
        maxDocs: {
          type: Type.INTEGER,
          description: 'Maximum documents to return from the pipeline result (default 20, max 50).'
        }
      },
      required: ['collectionName', 'pipeline']
    }
  }
];

// Helper to safely parse JSON arguments provided by LLM
function safeParseJson(jsonString: any, fallback: any = {}): any {
  if (typeof jsonString === 'object' && jsonString !== null) {
    return jsonString;
  }
  if (!jsonString || typeof jsonString !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    // Attempt cleanup if model enclosed with backticks
    const cleaned = jsonString.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(`Invalid JSON format: ${jsonString}`);
    }
  }
}

// 2. Tool Implementations
export async function executeQueryTool(name: string, args: any): Promise<any> {
  const db = getDatabase();

  switch (name) {
    case 'list_collections': {
      logger.tool('list_collections');
      const collections = await db.listCollections().toArray();
      const names = collections.map((c) => c.name).filter((n) => !n.startsWith('system.'));
      logger.result(`Found collections: [${names.join(', ')}]`);
      return { collections: names };
    }

    case 'get_collection_schema': {
      const { collectionName } = args;
      logger.tool('get_collection_schema', `Collection: "${collectionName}"`);
      const collection = db.collection(collectionName);
      const samples = await collection.find({}).limit(3).toArray();

      if (samples.length === 0) {
        return { message: `Collection "${collectionName}" exists but is currently empty.` };
      }

      // Infer fields and sample types
      const fieldsSummary: Record<string, string> = {};
      samples.forEach((doc) => {
        Object.entries(doc).forEach(([key, val]) => {
          if (!fieldsSummary[key]) {
            if (Array.isArray(val)) {
              fieldsSummary[key] = `Array<${typeof val[0] || 'any'}>`;
            } else if (val instanceof Date) {
              fieldsSummary[key] = 'Date';
            } else {
              fieldsSummary[key] = typeof val;
            }
          }
        });
      });

      logger.result(`Inferred ${Object.keys(fieldsSummary).length} fields for "${collectionName}"`);
      return {
        collection: collectionName,
        fields: fieldsSummary,
        sampleDocument: samples[0]
      };
    }

    case 'find_documents': {
      const { collectionName, limit = 10 } = args;
      const filter = safeParseJson(args.filter, {});
      const projection = safeParseJson(args.projection, {});
      const sort = safeParseJson(args.sort, {});

      // Safety check: block $where operator
      if (JSON.stringify(filter).includes('$where')) {
        throw new Error('Security violation: $where operator is strictly disallowed.');
      }

      const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
      logger.tool('find_documents', `Collection: "${collectionName}"`);
      logger.query('find', JSON.stringify({ filter, projection, sort, limit: safeLimit }, null, 2));

      let cursor = db.collection(collectionName).find(filter);
      if (Object.keys(projection).length > 0) cursor = cursor.project(projection);
      if (Object.keys(sort).length > 0) cursor = cursor.sort(sort);
      cursor = cursor.limit(safeLimit);

      const docs = await cursor.toArray();
      logger.result(`Returned ${docs.length} document(s)`);
      return {
        count: docs.length,
        documents: docs
      };
    }

    case 'run_aggregation': {
      const { collectionName, maxDocs = 20 } = args;
      const pipeline = safeParseJson(args.pipeline, []);

      if (!Array.isArray(pipeline)) {
        throw new Error('Aggregation pipeline must be a JSON array of pipeline stages.');
      }

      // Safety check: block $out or $merge to prevent accidental overwrite in read-only tool
      const stringified = JSON.stringify(pipeline);
      if (stringified.includes('$out') || stringified.includes('$merge')) {
        throw new Error('Security violation: $out and $merge stages are disallowed in read queries.');
      }

      const safeLimit = Math.min(Math.max(Number(maxDocs) || 20, 1), 50);
      logger.tool('run_aggregation', `Collection: "${collectionName}"`);
      logger.query('aggregate', JSON.stringify(pipeline, null, 2));

      const results = await db.collection(collectionName).aggregate(pipeline).toArray();
      const limitedResults = results.slice(0, safeLimit);

      logger.result(`Aggregation produced ${results.length} record(s) (returning ${limitedResults.length})`);
      return {
        count: limitedResults.length,
        results: limitedResults
      };
    }

    default:
      throw new Error(`Unknown tool: "${name}"`);
  }
}
