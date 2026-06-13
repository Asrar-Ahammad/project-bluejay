AGENTS.md

Project

BlueJay is an AI-powered personal knowledge management system that combines encrypted note-taking, semantic search, project organization, inbox management, and proactive AI assistance.

Core principle:

* User content is encrypted before storage.
* Semantic search is powered by pgvector embeddings.
* Authentication is handled by Clerk.
* Background processing uses BullMQ.
* Runtime is Bun.
* Frontend is Next.js.
* Backend is Bun + Express.
* Database is PostgreSQL + pgvector.
* Storage is Cloudflare R2.

⸻

Tech Stack

Frontend

* Next.js 16.2.9
* TypeScript
* Tailwind CSS
* Clerk
* Tiptap Editor
* Socket.io Client

Backend

* Bun
* Express
* Prisma
* PostgreSQL
* pgvector
* BullMQ
* Redis
* Socket.io
* OpenAI API

Infrastructure

* Vercel
* Render
* Supabase PostgreSQL
* Upstash Redis
* Cloudflare R2
* Clerk

⸻

Architecture Rules

Authentication

Authentication is fully delegated to Clerk.

Never implement:

* Password storage
* Password hashing
* Login endpoints
* Session tables
* Session management

Use Clerk JWT verification for all protected routes.

Webhook endpoint:

POST /webhooks/clerk

Used to sync Clerk users into the local database.

⸻

Encryption Model

BlueJay uses hybrid encryption.

Encrypted:

* Notes
* PDFs
* Articles
* Videos
* Inbox content
* Generated schedules

Visible to server:

* Metadata
* Titles
* Tags
* Timestamps
* Embeddings
* Chunk plaintext

Important:

Chunk content is intentionally stored plaintext to enable embedding generation and semantic search.

Do not attempt full E2EE search.

Current design prioritizes AI capabilities over strict zero-knowledge encryption.

⸻

Item System

Everything is an Item.

Supported types:

* NOTE
* CLIP
* CODE
* PDF
* VIDEO
* IMAGE
* SCHEDULE

Projects are not Items.

Projects organize Items through ProjectItem.

⸻

Semantic Search

Search is powered by pgvector.

Chunk embedding:

vector(1536)

OpenAI embedding model:

text-embedding-3-small

Never perform semantic search against Item content.

Always search against Chunk embeddings.

Typical flow:

1. Generate embedding
2. pgvector similarity search
3. Retrieve related chunks
4. Resolve parent Items

Use cosine similarity.

⸻

Background Jobs

BullMQ is used for:

* Embedding generation
* Similarity connection jobs
* Daily digests
* Gmail sync
* Video processing
* Image description

Workers must be idempotent.

A worker should safely retry multiple times.

⸻

Inbox Agent

Inbox sync uses Gmail OAuth.

Refresh tokens are encrypted before storage.

Never store OAuth credentials in plaintext.

Inbox priorities:

* HIGH
* MEDIUM
* LOW

Inbox statuses:

* UNREAD
* READ
* ACTIONED
* ARCHIVED

⸻

Realtime Agent

Socket.io is used for:

* Related item suggestions
* Activity events
* Digest notifications
* Schedule notifications

Realtime suggestions must be debounced.

Target debounce:

1500ms

Avoid embedding requests on every keystroke.

⸻

Database Rules

Use Prisma.

Avoid raw SQL except:

* pgvector similarity search
* pgvector index creation
* specialized performance queries

Required extension:

CREATE EXTENSION IF NOT EXISTS vector;

Required vector index:

CREATE INDEX chunks_embedding_idx
ON chunks
USING hnsw (embedding vector_cosine_ops);

⸻

API Design

Use REST.

Examples:

GET    /items
POST   /items
PATCH  /items/:id
DELETE /items/:id

Avoid RPC-style route naming.

Prefer:

POST /items/video

instead of:

POST /createVideoItem

⸻

File Storage

Cloudflare R2 stores:

* PDFs
* Images
* Attachments

Database stores only:

* r2Key
* metadata

Never store binary files in PostgreSQL.

⸻

Performance Targets

Item retrieval:

< 100ms

Semantic search:

< 500ms

Realtime suggestions:

< 1s

Embedding jobs:

asynchronous only

Never block user actions on embedding generation.

⸻

Coding Standards

TypeScript strict mode.

Prefer:

* explicit types
* service layer abstraction
* dependency injection where useful

Avoid:

* any
* massive controller files
* business logic inside routes

Structure:

routes/
controllers/
services/
workers/
lib/

⸻

Security Requirements

Always verify:

* Clerk JWTs
* Clerk webhooks via Svix

Never trust client-provided user IDs.

Use authenticated user identity from Clerk only.

All database queries must be scoped by user ownership.

Example:

Bad:

prisma.item.findUnique({
  where: { id }
})

Good:

prisma.item.findFirst({
  where: {
    id,
    userId: authUserId
  }
})

⸻

Agent Behavior

When implementing features:

1. Reuse existing architecture.
2. Prefer consistency over cleverness.
3. Maintain encryption boundaries.
4. Preserve multi-tenant isolation.
5. Keep AI operations asynchronous.
6. Optimize for semantic search scale.
7. Minimize OpenAI calls when caching is possible.
8. Do not introduce new infrastructure unless necessary.

When uncertain, align with the existing architecture rather than inventing a new pattern.