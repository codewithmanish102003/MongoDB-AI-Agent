import { DatabaseAdapter } from '../../database/adapter.js';
import { MongoDatabaseAdapter } from '../../database/mongo-adapter.js';
import { logger } from '../../utils/logger.js';
import { Type, FunctionDeclaration } from '@google/genai';

let defaultAdapter: DatabaseAdapter = new MongoDatabaseAdapter();

export function setDefaultDatabaseAdapter(adapter: DatabaseAdapter) {
  defaultAdapter = adapter;
}

// 1. Tool Declarations for Gemini
export const queryAgentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'list_collections',
    description: 'Lists all available collections in the database. Use this to discover collections in an unfamiliar database.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'get_collection_schema',
    description: 'ESSENTIAL FIRST STEP: Introspects field names, nested paths (dot notation), data types, indexes, and sample document of any collection. Always call this BEFORE querying so you never guess field names.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The name of the collection to inspect.'
        }
      },
      required: ['collectionName']
    }
  },
  {
    name: 'find_documents',
    description: 'Executes a structured find query on a collection with optional filter, projection, sort, and limit. Leave projection empty unless necessary, so full document fields are returned without missing data.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to query.'
        },
        filter: {
          type: Type.STRING,
          description: 'JSON string for filter query (e.g. \'{"status": "Active"}\' or \'{"price": {"$gt": 100}}\'). Default is \'{}\'.'
        },
        projection: {
          type: Type.STRING,
          description: 'Optional JSON string for projection (e.g. \'{"name": 1, "email": 1}\'). Leave empty to retrieve all fields.'
        },
        sort: {
          type: Type.STRING,
          description: 'Optional JSON string for sorting (e.g. \'{"createdAt": -1}\').'
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
    description: 'Executes a multi-stage aggregation pipeline for calculations, grouping, summing, averages, statistical metrics, or multi-collection lookups.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name to run the aggregation on.'
        },
        pipeline: {
          type: Type.STRING,
          description: 'JSON string array of aggregation pipeline stages (e.g. \'[{"$match": {"status": "completed"}}, {"$group": {"_id": "$category", "total": {"$sum": "$amount"}}}]\').'
        },
        maxDocs: {
          type: Type.INTEGER,
          description: 'Maximum documents to return from the pipeline result (default 20, max 50).'
        }
      },
      required: ['collectionName', 'pipeline']
    }
  },
  {
    name: 'count_documents',
    description: 'Counts documents in a collection matching an optional filter.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        collectionName: {
          type: Type.STRING,
          description: 'The collection name.'
        },
        filter: {
          type: Type.STRING,
          description: 'Optional JSON string filter (e.g. \'{"status": "active"}\'). Default is \'{}\'.'
        }
      },
      required: ['collectionName']
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

// 2. Tool Implementations (Routed through DatabaseAdapter and Policy Layer)
export async function executeQueryTool(name: string, args: any, adapter?: DatabaseAdapter): Promise<any> {
  const currentAdapter = adapter || defaultAdapter;

  switch (name) {
    case 'list_collections': {
      logger.tool('list_collections');
      const names = await currentAdapter.listCollections();
      logger.result(`Found collections: [${names.join(', ')}]`);
      return { collections: names };
    }

    case 'get_collection_schema': {
      const { collectionName } = args;
      logger.tool('get_collection_schema', `Collection: "${collectionName}"`);

      const schemaInfo = await currentAdapter.getCollectionSchema(collectionName);

      logger.result(`Inferred ${Object.keys(schemaInfo.fields).length} fields for "${collectionName}"`);
      return {
        collection: collectionName,
        isEmpty: schemaInfo.isEmpty,
        totalDocuments: schemaInfo.totalDocumentEstimate,
        fields: schemaInfo.fields,
        indexes: schemaInfo.indexes,
        sampleDocument: schemaInfo.sampleDocument,
        schemaSummary: schemaInfo.schemaSummary
      };
    }

    case 'find_documents': {
      const { collectionName, limit = 10 } = args;
      const filter = safeParseJson(args.filter, {});
      const projection = safeParseJson(args.projection, {});
      const sort = safeParseJson(args.sort, {});

      logger.tool('find_documents', `Collection: "${collectionName}"`);
      logger.query('find', JSON.stringify({ filter, projection, sort, limit }, null, 2));

      const result = await currentAdapter.find({
        collection: collectionName,
        filter,
        projection,
        sort,
        limit: Number(limit) || 10
      });

      logger.result(`Returned ${result.documents.length} document(s)`);
      return {
        count: result.documents.length,
        documents: result.documents
      };
    }

    case 'run_aggregation': {
      const { collectionName, maxDocs = 20 } = args;
      const pipeline = safeParseJson(args.pipeline, []);

      if (!Array.isArray(pipeline)) {
        throw new Error('Aggregation pipeline must be a JSON array of pipeline stages.');
      }

      logger.tool('run_aggregation', `Collection: "${collectionName}"`);
      logger.query('aggregate', JSON.stringify(pipeline, null, 2));

      const result = await currentAdapter.aggregate({
        collection: collectionName,
        pipeline,
        limit: Number(maxDocs) || 20
      });

      logger.result(`Aggregation produced ${result.results.length} record(s)`);
      return {
        count: result.results.length,
        results: result.results
      };
    }

    case 'count_documents': {
      const { collectionName } = args;
      const filter = safeParseJson(args.filter, {});

      logger.tool('count_documents', `Collection: "${collectionName}"`);
      const count = await currentAdapter.count({
        collection: collectionName,
        filter
      });

      logger.result(`Counted ${count} document(s) in "${collectionName}"`);
      return {
        collection: collectionName,
        count
      };
    }

    default:
      throw new Error(`Unknown query tool: "${name}"`);
  }
}
