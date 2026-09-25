# 🍃 MongoDB AI Super Agent 🤖 (v2.0 Generic Enterprise Edition)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.0+-47A248?style=flat&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Google Gemini](https://img.shields.io/badge/Gemini-3.6%20Flash-4285F4?style=flat&logo=google&logoColor=white)](https://ai.google.dev/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-Llama%203.3%2070B%20Fallback-6366F1?style=flat)](https://openrouter.ai/)
[![REST API](https://img.shields.io/badge/REST%20API-Production%20Hardened-green?style=flat)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An enterprise-grade, autonomous, **schema-agnostic AI database agent** for **MongoDB**. Query any MongoDB database in plain English, introspect arbitrary schemas on the fly, run high-dimensional vector search (RAG), execute write operations with cryptographic confirmation tokens and append-only audit logging, and serve multi-tenant users via a production-ready **REST API** — with zero-downtime **dual-LLM failover** between Google Gemini and OpenRouter.

Point it to **ANY MongoDB database** (from small apps to massive multi-collection databases like ERPs, CRMs, FinTech, Healthcare, or Construction systems) without any hardcoded collection names or pre-registered schemas.

---

## 🖥️ Live Terminal Interface Preview

```text
  ╔═══════════════════════════════════════════════════════╗
  ║            🍃 MongoDB AI Super Agent 🤖               ║
  ║     Database Analytics + Semantic Vector RAG          ║
  ║               Powered by Google Gemini                ║
  ╚═══════════════════════════════════════════════════════╝
  
ℹ Connecting to MongoDB at: mongodb://localhost:27017 (Database: construction_management)
✔ Connected to MongoDB successfully!
ℹ Detected 105 collections in "construction_management"
ℹ Primary LLM: gemini-3.6-flash
ℹ Fallback LLM: OpenRouter (meta-llama/llama-3.3-70b-instruct)
ℹ Active Session: SESSION-1740291438902-148
✔ Super Agent ready! (MQL, Vector Search, Actions & Long-Term Memory)

[SESSION-1740291438902-148] Ask Agent > What is the total sales revenue by category?
─────────────────────────────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🤖 Super Agent Response  ⚡ Gemini 3.6 Flash  (1.42s)                       │
├─────────────────────────────────────────────────────────────────────────────┘
  Category-wise sales revenue breakdown:

  • Structural Steel & Metal   : ₹ 48,25,000  (34 orders)
  • Ready-Mix Concrete         : ₹ 36,90,000  (28 orders)
  • Electrical & Wiring Units  : ₹ 19,45,000  (19 orders)
  • Safety & Protective Gear   : ₹  8,15,000  (12 orders)
  ────────────────────────────────────────────────────────
  Total Net Revenue            : ₹ 1,12,75,000
└─────────────────────────────────────────────────────────────────────────────
```

---

## ✨ Key Capabilities

- **🌐 Truly Generic & Schema-Agnostic:** Zero assumptions about collection names or schemas. The agent automatically inspects field names, nested dot-notation paths (`address.city`), mixed data types, arrays, and index definitions on demand.
- **🗣️ Natural Language Text-to-MQL & Aggregations:** Converts plain language questions into native MongoDB `find` filters and multi-stage aggregation pipelines (`$group`, `$lookup`, `$match`, `$sort`, `$project`) automatically.
- **🛡️ Multi-Layer Security & Policy Enforcement:** Prohibits hazardous JavaScript execution (`$where`, `$function`, `$accumulator`) and unauthorized writes through pipelines (`$out`, `$merge`). Query timeouts (`5000ms`), limit ceilings (`50` max docs), and pipeline stage ceilings (`20` max stages) prevent runaway load.
- **⚠️ Action-Bound Confirmation Protocol:** Destructive write operations (`insert`, `update`, `delete`) require a human confirmation step. Tokens are cryptographically bound to the staging user, target project, collection, action, and payload, preventing token hijacking, scope expansion, and replay attacks.
- **🔒 Race-Free Bounded Writes:** Multi-document updates and deletions target explicit verified document IDs (`{ _id: { $in: targetIds } }`), preventing time-of-check to time-of-use (TOCTOU) race conditions.
- **🏢 Multi-Tenant Project & Connection Management:** Supports multiple isolated projects. The server securely maps `userId + projectId` to isolated connection pools with RBAC (`readOnly` vs `readWrite`) and collection whitelists/blacklists. MongoDB credentials are never exposed to the LLM.
- **🔍 Hybrid Vector Search & RAG:** High-dimensional semantic search powered by `gemini-embedding-001` (3072 dimensions) with resilient offline fallback. Supports native **MongoDB Atlas `$vectorSearch`** with seamless fallback to in-memory cosine similarity for local instances.
- **🧠 Long-Term Memory & User Preferences:** Stores conversation history, active user sessions, and autonomously learned user preferences in isolated MongoDB collections scoped strictly by `userId + sessionId`.
- **🚀 Production REST API Server:** Built-in HTTP REST API with Bearer token authentication, sliding-window rate limiting (`60 req/min`), request tracing (`X-Request-Id`), and in-memory schema caching (`15-min TTL`).
- **🛡️ Enterprise Dual-LLM Redundancy:** When Google Gemini hits Free Tier rate limits (`429` / quota exhaustion), the agent **automatically fails over to OpenRouter (`meta-llama/llama-3.3-70b-instruct`)** with zero interruption.

---

## 🏛️ System Architecture

```text
User / HTTP Client
       ↓
Authenticated REST API (Bearer Auth, Rate Limiter, Sanitized Errors)
       ↓
Project & Connection Context (RBAC, Connection Pooling, Credential Shielding)
       ↓
AI Super Agent (Unified Orchestrator: Query, Task, RAG, Memory)
       ↓
Structured Tool Call (JSON Schema, safe JSON parser)
       ↓
Security & Policy Layer (Blocked Operators, Clamped Limits, Ceiling Guards)
       ↓
Confirmation Layer (Action-Bound, Single-Use Staging Tokens)
       ↓
DatabaseAdapter (Pure Generic Abstraction, Zero Raw Db Leaks)
       ↓
MongoDatabaseAdapter (ID-Bounded Race-Free Writes, Timeout Safeguards)
       ↓
Target Project MongoDB (Local or Atlas Cluster)
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v18+ 
- **MongoDB** v7.0+ (Local instance or MongoDB Atlas URI)
- **Google Gemini API Key** (from [Google AI Studio](https://aistudio.google.com/))
- *(Optional)* **OpenRouter API Key** (for automatic failover fallback)

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/codewithmanish102003/MongoDB-AI-Agent.git
cd MongoDB-AI-Agent

# Install dependencies
npm install
```

### 3. Configuration
Copy the example environment template:
```bash
cp .env.example .env
```
Configure `.env`:
```env
# MongoDB Connection
MONGO_URI=mongodb://localhost:27017
MONGO_DATABASE=construction_management

# LLM Providers
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash

# Optional: OpenRouter Fallback
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct

# API Server Port
PORT=3000
```

### 4. Seed Knowledge & Sample Data (Optional)
```bash
# Seed sample collections (if testing from scratch)
npm run seed

# Seed knowledge base with vector embeddings
npm run seed:vectors
```

### 5. Launch Terminal Interactive CLI
```bash
npm run dev
```

### 6. Start the REST API Server
```bash
npm run start:api
```
The server will start at `http://localhost:3000`.

---

## 🌐 REST API Reference

All requests accept and return JSON. In production (`NODE_ENV=production`), include header `Authorization: Bearer <userId>`. In development/testing, you can also pass `X-User-Id: <userId>`.

### 1. Healthcheck
```http
GET /health
```
**Response (200 OK):**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 124.5,
  "timestamp": "2026-09-25T18:00:00.000Z"
}
```

### 2. Register a Project
```http
POST /projects
Content-Type: application/json

{
  "projectId": "proj_crm",
  "name": "B2B CRM Pipeline",
  "connectionUri": "mongodb://localhost:27017",
  "databaseName": "crm_database",
  "defaultRole": "readWrite",
  "allowedCollections": ["leads", "deals", "contacts"]
}
```

### 3. List Authorized Projects
```http
GET /projects
```
Returns all projects accessible to the authenticated user (credentials and connection URIs are masked).

### 4. Inspect Project Schema (Cached)
```http
GET /projects/:id/schema
```
Returns discovered collections, fields, and approximate types. Served from the 15-minute in-memory cache.

### 5. Refresh Schema Cache
```http
POST /projects/:id/refresh-schema
```
Invalidates cached schema and re-introspects the target database.

### 6. Interactive Chat with Agent
```http
POST /projects/:id/chat
Content-Type: application/json

{
  "message": "Show me top deals in closed won stage",
  "sessionId": "SESSION-OPTIONAL-ID"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "projectId": "proj_crm",
  "sessionId": "SESSION-123456",
  "response": "Here are the top deals currently in Closed Won...",
  "provider": "gemini"
}
```

---

## 🧪 Comprehensive Automated Testing (11 Test Suites - 100% Pass)

The codebase includes an extensive suite of 11 dedicated test suites covering low-level drivers up to REST API endpoints:

```bash
# Run generic agent test pipeline
npm test

# Run individual test suites:
npx tsx tests/phase9-hardening-verification.test.ts  # Token tamper resistance & race-free writes
npx tsx tests/multi-schema-genericity.test.ts         # Blog, CRM, and School generic verification
npx tsx tests/comprehensive-agent-validation.test.ts  # End-to-end full system validation
npx tsx tests/backend-api.test.ts                    # REST API endpoints, auth & rate limiting
npx tsx tests/security-authorization.test.ts         # RBAC, whitelists, append-only audit
npx tsx tests/project-connection-manager.test.ts     # Multi-project connection pools
npx tsx tests/task-agent-generic.test.ts             # Generic CRUD & confirmation staging
npx tsx tests/query-agent-generic.test.ts            # Dynamic MQL generation & schema handoff
npx tsx tests/schema-inspector.test.ts               # Deep schema introspection & types
npx tsx tests/database-abstraction.test.ts           # DatabaseAdapter & Policy checks
```

---

## 🗂️ Project Directory Structure

```text
mongodb-ai-agent/
├── src/
│   ├── agents/
│   │   ├── memory-agent/          # Session management & user memory store
│   │   │   ├── store.ts           # Scoped MongoDB session store
│   │   │   └── tools.ts           # remember_user_fact, get_user_memories
│   │   ├── query-agent/           # Generic schema inspection & Text-to-MQL engine
│   │   │   ├── prompts.ts
│   │   │   ├── tools.ts           # list_collections, get_collection_schema, find, aggregate
│   │   │   └── index.ts
│   │   ├── rag-agent/             # Atlas Vector Search & cosine similarity RAG
│   │   │   ├── prompts.ts
│   │   │   ├── tools.ts           # semantic_search, add_knowledge_document
│   │   │   └── index.ts
│   │   ├── task-agent/            # Generic write actions & confirmation protocol
│   │   │   ├── prompts.ts
│   │   │   ├── tools.ts           # execute_task_operation (insert, update, delete)
│   │   │   └── index.ts
│   │   └── unified-agent.ts       # Central orchestrator & dual-LLM fallback logic
│   ├── api/                       # Production REST API layer
│   │   ├── middleware.ts          # Bearer auth, rate limiting, request tracing
│   │   ├── routes.ts              # Express-free native router (/projects, /chat, /schema)
│   │   ├── schema-cache.ts        # 15-minute in-memory schema cache
│   │   └── server.ts              # HTTP server entry point
│   ├── config/
│   │   ├── db.ts                  # Base MongoDB connection helper
│   │   └── env.ts                 # Type-safe environment validation (Zod)
│   ├── database/                  # Core Database Abstraction & Security Layer
│   │   ├── adapter.ts             # DatabaseAdapter generic interface
│   │   ├── confirmation.ts        # Action-bound confirmation manager
│   │   ├── mongo-adapter.ts       # Production MongoDatabaseAdapter implementation
│   │   ├── policy.ts              # Operator blocklist & query guardrails
│   │   └── schema-inspector.ts    # Dynamic MongoDB schema discovery engine
│   ├── projects/                  # Multi-Tenant Project & Connection Management
│   │   ├── connection-manager.ts  # Dynamic connection pooling per URI
│   │   ├── project-manager.ts     # Project registry & RBAC permission checks
│   │   └── types.ts               # Project interfaces & error definitions
│   ├── llm/
│   │   ├── embeddings.ts          # Gemini embedding service with resilient fallback
│   │   ├── gemini.ts              # Google GenAI SDK interface
│   │   └── openrouter.ts          # OpenRouter fallback caller
│   ├── utils/
│   │   └── logger.ts              # Colorized enterprise console logger
│   └── cli.ts                     # Terminal REPL interactive CLI
├── tests/                         # 11 Automated Test Suites
│   ├── backend-api.test.ts
│   ├── comprehensive-agent-validation.test.ts
│   ├── database-abstraction.test.ts
│   ├── generic-agent.test.ts
│   ├── multi-schema-genericity.test.ts
│   ├── phase9-hardening-verification.test.ts
│   ├── project-connection-manager.test.ts
│   ├── query-agent-generic.test.ts
│   ├── schema-inspector.test.ts
│   ├── security-authorization.test.ts
│   └── task-agent-generic.test.ts
├── .env.example                   # Environment configuration template
├── package.json                   # Scripts and project dependencies
├── tsconfig.json                  # TypeScript compiler configuration
└── README.md                      # Comprehensive documentation
```

---

## 🔒 Security & Guardrail Principles

1. **Zero Credential Leakage:** MongoDB connection strings and credentials are managed strictly in the application layer and never sent to LLM prompts.
2. **Prohibited Operators:** `$where`, `$function`, and `$accumulator` (arbitrary JavaScript execution) are strictly blocked across all queries, projections, and aggregations.
3. **Write Protection in Pipelines:** Aggregation pipeline stages `$out` and `$merge` are completely disallowed.
4. **Mandatory Filter Requirement:** Empty filters `{}` are strictly blocked on updates and deletes to prevent accidental entire-collection mutations.
5. **Confirmation Action Binding:** Confirmation tokens are cryptographically locked to the staging user, target project, collection, action type, and payload. Modified or replayed tokens are rejected immediately.
6. **Append-Only Audit Trail:** Direct mutation or deletion of internal system collections (`audit_logs`, `sessions`) is blocked. All mutations are logged with actor, timestamp, target ID, and reason.

---

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Run test suites (`npm test`)
4. Commit your Changes (`git commit -m 'feat: Add some AmazingFeature'`)
5. Push to the Branch (`git push origin feature/AmazingFeature`)
6. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.
