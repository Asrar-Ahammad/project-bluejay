# BlueJay — Architecture Diagram

> Runtime: Bun · Auth: Clerk · E2EE: Hybrid (content encrypted, embeddings plaintext)

---

## 1. High-Level System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Browser)                          │
│                                                                        │
│   ┌────────────┐   ┌──────────────┐   ┌─────────────────────────┐    │
│   │   Editor    │   │  Crypto Layer │   │    Agent Side Panel     │    │
│   │  (Tiptap)   │   │  (WebCrypto)  │   │  (WS suggestions UI)    │    │
│   └──────┬─────┘   └──────┬───────┘   └────────────┬────────────┘    │
│          │                │                          │                │
│   ┌──────┴────────────────┴──────────────────────────┴──────┐        │
│   │              Clerk SDK (session, JWT, user mgmt)          │        │
│   └────────────────────────┬───────────────────────────────┘        │
│                            │                                          │
│                  HTTPS (REST)  +  WSS (Socket.io)                     │
│                  Clerk session token attached                        │
└────────────────────────────┼──────────────────────────────────────────┘
                              │
┌─────────────────────────────┼──────────────────────────────────────────┐
│                  BACKEND (Bun + Express/Hono + TS)                      │
│                              │                                          │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐  │
│   │   REST API    │   │  WS Server    │   │      Agent Engine        │  │
│   │  /items       │   │  (Socket.io)  │   │  surface / connect /     │  │
│   │  /chunks      │   │  ACTIVITY     │   │  remind                  │  │
│   │  /search      │   │  SUGGESTIONS  │   │                          │  │
│   │  /projects    │   │  CONNECT      │   │                          │  │
│   │  /vault       │   │  DIGEST       │   │                          │  │
│   └──────┬───────┘   └──────┬────────┘   └────────────┬─────────────┘  │
│          │                  │                          │                │
│   ┌──────┴──────────────────┴──────────────────────────┴──────┐        │
│   │         Clerk middleware (verifies session JWT)             │        │
│   └──────────────────────────────────────────────────────────┘        │
│                              │                                          │
│        ┌─────────────────────┼───────────────────┬───────────────┐     │
│        ▼                     ▼                   ▼               ▼     │
│  ┌────────────┐      ┌──────────────┐    ┌─────────────┐  ┌──────────┐│
│  │ PostgreSQL │      │    BullMQ     │    │   OpenAI    │  │  Redis   ││
│  │ + pgvector │      │ (job queues)  │    │     API     │  │ (queues) ││
│  │  (Prisma)  │      │  embed/connect│    │ embed+digest│  │          ││
│  │            │      │  /digest      │    │             │  │          ││
│  └────────────┘      └───────┬──────┘    └─────────────┘  └──────────┘│
│                               │                                         │
│                               ▼                                         │
│                       ┌───────────────┐                                │
│                       │  Cloudflare R2 │                                │
│                       │  (attachments, │                                │
│                       │   PDFs)        │                                │
│                       └───────────────┘                                │
└──────────────────────────────────────────────────────────────────────┘

External: Clerk (clerk.com) — hosted identity provider
  - Sign up / sign in / session management / JWT issuance
  - Webhooks → sync user to local `users` table on creation
```

---

## 2. Auth Flow (Clerk) — Critical Change from Original Design

```
┌─────────┐   1. Sign up / Sign in    ┌──────────┐
│ Browser  │ ────────────────────────► │  Clerk     │
│          │ ◄──────────────────────── │  Hosted UI │
│          │   session JWT (cookie)     └──────────┘
└────┬────┘
     │ 2. Clerk webhook fires on user.created
     ▼
┌──────────────┐
│  Bun API       │ ── 3. INSERT INTO users (clerkId, email)
│  /webhooks/    │     NOTE: no passwordHash, no argonSalt —
│  clerk         │     Clerk owns identity entirely
└──────────────┘

┌─────────┐   4. API request + Clerk session JWT   ┌──────────────┐
│ Browser  │ ──────────────────────────────────────► │  Clerk        │
│          │                                          │  middleware   │
│          │ ◄──────────────────────────────────────  │  verifies JWT │
└─────────┘                                          └──────────────┘
```

### ⚠️ The encryption key problem with Clerk

Clerk manages login — but it does **not** manage your E2EE master key. Original design derived the master key from the user's password via Argon2id. With Clerk, you don't control the password.

**Two options:**

| Option | How | Trade-off |
|---|---|---|
| **A. Separate Vault Passphrase** | On first login, user sets a *second* passphrase (vault PIN/passphrase), used only for key derivation. Stored nowhere — re-entered each session or cached in memory. | Extra step for user, but true E2EE preserved. **Recommended.** |
| **B. Derive from Clerk user ID** | Use Clerk's stable `userId` + a server-issued salt to derive key. | Server can reconstruct key context → breaks E2EE guarantee. Not recommended if E2EE is a hard requirement. |

**Go with Option A.** Add a `vaultSalt` column to `users` table (random, generated once, safe to store — salts aren't secret). User's vault passphrase + this salt → master key, derived client-side via PBKDF2/Argon2-WASM. Passphrase itself never sent to server.

```
Clerk login (identity) ──┐
                          ├──► App unlocked
Vault passphrase (E2EE) ──┘    (separate prompt, first time + per session)
```

---

## 3. Data Flow — Saving an Item (E2EE Write Path)

```
┌────────┐    1. encrypt(content, masterKey)   ┌─────────┐
│ Browser │ ───────────────────────────────────► │ Crypto  │
│         │ ◄─────────────────────────────────── │ Layer   │
│         │   { ciphertext, iv }                  │(WebCrypto)│
└───┬────┘                                       └─────────┘
    │ 2. POST /items { title, ciphertext, iv, type }
    │    Authorization: Clerk session JWT
    ▼
┌─────────────┐
│ Bun API       │ ── 3. Clerk middleware verifies JWT → req.userId
│              │
│              │ ── 4. INSERT INTO items (ciphertext, iv stored as-is)
│              │
│              │ ── 5. queue EmbedJob(itemId) → BullMQ
└──────┬───────┘
       │
       │ 6. POST /items/:id/chunks  [{ content, blockIndex, chunkType }]
       │    (plaintext chunks sent separately, for embedding only)
       ▼
┌─────────────┐
│ Bun API       │ ── INSERT INTO chunks (content plaintext, embedding NULL)
└──────┬───────┘
       │
       ▼
┌─────────────┐    7. embed(chunk.content)    ┌─────────┐
│ BullMQ Worker│ ──────────────────────────────► │ OpenAI  │
│ (Bun)        │ ◄────────────────────────────── │ Embed   │
│              │   embedding vector (1536-dim)   └─────────┘
│              │
│              │ 8. UPDATE chunks SET embedding = vector
└──────┬───────┘
       │
       ▼
┌─────────────┐
│ ConnectJob   │ ── 9. pgvector similarity search → related items
│ (BullMQ)     │
└──────┬───────┘
       │
       ▼
WS push → CONNECT { relatedItems }
```

---

## 4. Data Flow — Reading an Item

```
┌────────┐  1. GET /items/:id (Clerk JWT)  ┌─────────────┐
│ Browser │ ─────────────────────────────────► │ Bun API       │
│         │ ◄───────────────────────────────── │              │
│         │  { ciphertext, iv, title,...}       └─────────────┘
└───┬────┘
    │ 2. decrypt(ciphertext, iv, masterKey)
    ▼
┌─────────┐
│ Crypto   │ ── 3. AES-256-GCM decrypt (browser memory only)
│ Layer    │
└───┬─────┘
    │
    ▼
┌─────────┐
│ Tiptap   │ ── 4. render plaintext content
│ Editor   │
└─────────┘

Note: plaintext NEVER touches the network on read.
Master key derived once per session from vault passphrase, held in memory only.
```

---

## 5. Agent — Real-Time Surface Mode (WebSocket)

```
┌─────────┐                          ┌─────────────┐
│ Browser  │  user types in editor    │  WS Server   │
│ (Tiptap) │                          │ (Socket.io,  │
└────┬────┘                          │  Bun runtime)│
     │  debounce 1500ms              └──────┬──────┘
     │  { type: "ACTIVITY",                  │
     │    blockContent, itemId,              │
     │    clerkToken }                       │
     │ ──────────────────────────────────► │
     │                                       │
     │                              1. verify Clerk token
     │                                       │
     │                              2. embed(blockContent) → OpenAI
     │                                       │
     │                              3. pgvector similarity search
     │                                 (score > 0.82, exclude current item)
     │                                       │
     │  { type: "SUGGESTIONS",               │
     │    items: [...] }                     │
     │ ◄──────────────────────────────────  │
     ▼
┌─────────────────┐
│ Agent Side Panel  │
│ "Related: ..."     │
└──────────────────┘
```

---

## 6. Agent — Daily Digest Mode (Cron + BullMQ)

```
┌──────────┐
│  Cron      │  triggers at 8:00 AM user local time
│ (BullMQ    │
│ repeatable)│
└─────┬─────┘
      │
      ▼
┌──────────────┐
│ DigestWorker  │ ── 1. fetch user's active projects
│ (Bun)         │
└─────┬────────┘
      │
      ▼  for each project:
┌──────────────┐
│  embed(name + │ ── 2. embed project description
│  description) │
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  pgvector     │ ── 3. top 10 items, score > 0.80,
│  search       │    saved in last 30 days
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  GPT-4o-mini   │ ── 4. "Write a 3-sentence digest
│  summarize     │    for project [name]"
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  Store as      │ ── 5. INSERT INTO items
│  Item (NOTE)   │    (type: NOTE, title: "Daily Digest")
└─────┬────────┘
      │
      ▼
WS push on next login → DIGEST { digestItemId }
```

---

## 7. Database Schema Relationships (ERD)

```
┌──────────────────┐
│       User         │
│──────────────────│
│ id                 │
│ clerkId  (unique)  │  ← from Clerk, no passwordHash
│ email              │
│ vaultSalt          │  ← for E2EE key derivation (Option A)
│ createdAt          │
└──────┬────────────┘
       │ 1:N
       ├────────────────────────┬─────────────────────┐
       ▼                        ▼                      
┌──────────────┐        ┌──────────────┐      
│    Item       │        │   Project     │      
│──────────────│        │──────────────│      
│ id            │        │ id            │      
│ userId        │        │ userId        │      
│ type          │        │ name          │      
│ title         │        │ description   │      
│ ciphertext    │        └──────┬───────┘      
│ iv            │               │
│ sourceUrl     │               │ N:M
│ r2Key         │               ▼
│ isPinned      │        ┌──────────────┐
│ isArchived    │ ◄──────│ ProjectItem   │
└──────┬────────┘  N:M   │──────────────│
       │                  │ projectId     │
       │ 1:N              │ itemId        │
       ▼                  └──────────────┘
┌──────────────┐
│    Chunk       │               ┌──────────────┐
│──────────────│        N:M      │     Tag        │
│ id            │ ◄──────────────│──────────────│
│ itemId        │   ItemTag       │ id            │
│ content       │                 │ name          │
│ embedding     │                 └──────────────┘
│ blockIndex    │
│ chunkType     │
│ tokenCount    │
└──────────────┘

┌──────────────┐
│   EmbedJob     │  (job status tracking, itemId reference only)
│──────────────│
│ id            │
│ itemId        │
│ status        │
│ attempts      │
│ error         │
└──────────────┘

NOTE: Removed `Session` model entirely — Clerk handles sessions.
```

---

## 8. Deployment Topology

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐
│   Vercel      │      │    Render      │      │   Supabase     │
│──────────────│      │──────────────│      │──────────────│
│ Next.js Web   │ ───► │  Bun API      │ ───► │  PostgreSQL    │
│ (apps/web)    │ HTTPS│  (apps/api)   │      │  + pgvector    │
│ Clerk SDK     │      │  Clerk verify │      │  (Prisma)      │
└─────────────┘      └──────┬───────┘      └──────────────┘
                              │
                ┌─────────────┼─────────────┬─────────────┐
                ▼             ▼             ▼             ▼
        ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐
        │   Upstash      │ │  OpenAI    │ │  Cloudflare    │ │  Clerk   │
        │   Redis        │ │   API      │ │  R2            │ │ (auth)   │
        │  (BullMQ)      │ │ (embed +   │ │ (PDFs,         │ │ hosted   │
        │                │ │  digest)   │ │  attachments)  │ │          │
        └──────────────┘ └──────────┘ └──────────────┘ └─────────┘
```

---

## 9. Folder Structure (Monorepo, Bun)

```
bluejay/
├── package.json                 (Bun workspaces root)
├── bunfig.toml
├── apps/
│   ├── web/                     (Next.js 14)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/       (Clerk sign-in/sign-up pages)
│   │   │   │   └── (app)/        (main app, protected by Clerk middleware)
│   │   │   ├── components/
│   │   │   │   ├── editor/        (Tiptap)
│   │   │   │   ├── agent/         (side panel, suggestions)
│   │   │   │   └── vault/         (passphrase unlock modal)
│   │   │   ├── lib/
│   │   │   │   └── crypto.ts      (WebCrypto: encrypt/decrypt, key derivation)
│   │   │   ├── middleware.ts      (Clerk middleware)
│   │   │   └── hooks/
│   │   │       └── useSocket.ts
│   │   └── package.json
│   │
│   └── api/                      (Bun + Express/Hono)
│       ├── src/
│       │   ├── index.ts
│       │   ├── routes/            (/items, /chunks, /search, /projects, /webhooks)
│       │   ├── controllers/
│       │   ├── middleware/        (clerkAuth, error handling)
│       │   ├── agent/
│       │   │   ├── index.ts       (AgentEngine)
│       │   │   ├── surface.ts
│       │   │   ├── connect.ts
│       │   │   ├── remind.ts
│       │   │   ├── embed.ts
│       │   │   └── search.ts      (pgvector queries)
│       │   ├── workers/           (BullMQ: embed, connect, digest)
│       │   ├── lib/                (db, redis, r2, openai, clerk clients)
│       │   └── types/
│       ├── prisma/
│       │   └── schema.prisma
│       └── package.json
│
└── packages/
    └── types/                     (shared TS types between web & api)
```

---

## 10. Security Boundary Map

```
┌────────────────────────────────────────────────────────────┐
│                     TRUST BOUNDARY                          │
│                                                              │
│   INSIDE (never leaves browser):                            │
│     - Vault passphrase                                        │
│     - Master encryption key                                  │
│     - Plaintext item content (notes, clips, PDFs, code)      │
│                                                              │
│  ═══════════════════ network boundary ═══════════════════  │
│                                                              │
│   OUTSIDE (server/Clerk can see):                            │
│     - Clerk identity (email, login state)                    │
│     - Ciphertext + IV (item.content)                          │
│     - Plaintext chunk.content (for embedding/agent)           │
│     - Embeddings (1536-dim vectors)                           │
│     - Titles, tags, timestamps, metadata, vaultSalt           │
│                                                              │
└────────────────────────────────────────────────────────────┘

NOTE: Clerk never sees the vault passphrase or master key —
those exist purely client-side and are unrelated to Clerk's auth.
```


---

## 11. New Features — Inbox Agent, Article/Video/Image Agents

### 11.1 Security Model Update — Session-Cached Key (Option B)

```
┌────────────────────────────────────────────────────────────┐
│  REVISED TRUST MODEL FOR BACKGROUND JOBS                     │
│                                                              │
│  On login + vault unlock:                                    │
│    1. Client derives masterKey (as before, from passphrase)  │
│    2. Client sends masterKey to server ONCE over TLS,         │
│       server encrypts it with a server-side KMS key           │
│       and caches in Redis with TTL (e.g. 12 hours)            │
│    3. Background workers (inbox sync, morning agent) can       │
│       decrypt masterKey from Redis to encrypt/decrypt          │
│       items during that session window                        │
│    4. On logout / TTL expiry → Redis entry deleted             │
│                                                              │
│  TRADE-OFF: server has transient access to masterKey during   │
│  active sessions. Not "true" E2EE, but ciphertext at rest in   │
│  DB is still opaque without Redis cache + KMS key both alive.  │
│  Document this clearly to user in privacy policy.              │
└────────────────────────────────────────────────────────────┘
```

---

### 11.2 Gmail Inbox Agent

```
┌─────────┐  1. Connect Gmail (OAuth2)   ┌──────────┐
│ Browser  │ ────────────────────────────► │  Google    │
│          │ ◄──────────────────────────── │  OAuth     │
│          │   refresh token                └──────────┘
└────┬────┘
     │ 2. POST /integrations/gmail { refreshToken (encrypted) }
     ▼
┌──────────────┐
│  Bun API       │ ── 3. store encrypted refreshToken in `integrations` table
└──────────────┘

────────────────────── Morning Cron (per user, e.g. 7:00 AM) ──────────────────────

┌──────────────┐
│ InboxWorker    │ ── 1. decrypt refreshToken (using cached masterKey, §11.1)
│ (BullMQ, Bun)  │
└─────┬────────┘
      │ 2. fetch unread/recent emails via Gmail API
      ▼
┌──────────────┐
│  Gmail API     │ ── returns: subject, sender, snippet, body, threadId
└─────┬────────┘
      │ 3. encrypt(subject + snippet + body) using cached masterKey
      ▼
┌──────────────┐
│  INSERT INTO   │ ── InboxItem { ciphertext, iv, externalId (Gmail msgId) }
│  inbox_items   │
└─────┬────────┘
      │ 4. for each email: embed(subject + snippet) → pgvector (existing pipeline)
      ▼
┌──────────────┐
│  GPT-4o-mini   │ ── 5. batch classify: "Given these N email subjects/snippets,
│  Prioritizer   │    categorize each as HIGH / MEDIUM / LOW priority"
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  UPDATE        │ ── 6. SET priority = 'HIGH'/'MEDIUM'/'LOW' per InboxItem
│  inbox_items   │
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  Generate      │ ── 7. GPT-4o-mini: "Given today's HIGH/MEDIUM tasks,
│  Daily Schedule│    create a prioritized schedule"
└─────┬────────┘
      │
      ▼
┌──────────────┐
│  Store as Item │ ── 8. type: SCHEDULE, encrypted, title "Today's Schedule"
└─────┬────────┘
      │
      ▼
WS push → SCHEDULE_READY { itemId }
```

#### On-demand: "Suggest reply / next action"

```
User opens InboxItem in UI
    │
    ▼
Client decrypts inbox item (body) using masterKey (in-session, browser)
    │
    ▼  POST /agent/suggest-action { itemId, decryptedBody }
       (sent over TLS, used transiently, not stored as plaintext)
    ▼
┌──────────────┐
│  GPT-4o-mini   │ ── "Given this email, suggest a reply OR
│                │     suggest the next action (task, calendar event, etc.)"
└─────┬────────┘
      │
      ▼
Return suggestion → client displays, never persisted server-side
```

---

### 11.3 Article Agent (extends existing Clip ingestion)

```
User submits URL
    │
    ▼
Readability.js → extract article text (client-side or server-side)
    │
    ▼
Client encrypts full text → POST /items (type: CLIP)
Client sends plaintext chunks → POST /items/:id/chunks
    │
    ▼
EmbedWorker: 
    1. embed chunks (existing pipeline)
    2. GPT-4o-mini: summarize full text → 2-3 sentences
    3. encrypt(summary) using cached masterKey → store in item.summaryCiphertext
    │
    ▼
Item now has: ciphertext (full article), summaryCiphertext (quick recall),
chunks + embeddings (search)
```

**Schema addition:** `Item.summaryCiphertext`, `Item.summaryIv` (nullable, populated post-ingest)

---

### 11.4 Video Agent (YouTube)

```
User submits YouTube URL
    │
    ▼
┌──────────────┐
│ VideoWorker    │ ── 1. fetch transcript via youtube-transcript / Innertube API
│ (BullMQ, Bun)  │
└─────┬────────┘
      │
      ▼  if no transcript available → mark item as FAILED, notify user
      │  (no Whisper fallback per scope decision)
      │
      ▼
┌──────────────┐
│  GPT-4o-mini   │ ── 2. summarize transcript (2-3 sentences)
└─────┬────────┘
      │ 3. encrypt(transcript + summary) using cached masterKey
      ▼
┌──────────────┐
│  UPDATE item   │ ── ciphertext = encrypted transcript
│                │    summaryCiphertext = encrypted summary
└─────┬────────┘
      │ 4. chunk transcript (sliding window, same as PDF) → embed
      ▼
pgvector search now includes video transcript chunks
```

**New ItemType:** `VIDEO`. **New field:** `Item.sourceUrl` already exists — reused for YouTube URL.

---

### 11.5 Image Agent (Vision → Searchable Context)

```
User uploads image
    │
    ▼
┌──────────────┐
│  Upload to R2  │ ── 1. presigned URL (existing /attachments/upload)
└─────┬────────┘
      │
      ▼
┌──────────────┐
│ ImageWorker    │ ── 2. GPT-4o (vision): "Describe this image in detail:
│ (BullMQ, Bun)  │    objects, scene, text visible, mood, colors"
└─────┬────────┘
      │ 3. encrypt(description) using cached masterKey
      ▼
┌──────────────┐
│  UPDATE item   │ ── ciphertext = encrypted description
│                │    r2Key = image location
└─────┬────────┘
      │ 4. chunk description (single chunk) → embed
      ▼
pgvector search: "beach sunset photos" matches description embedding
→ returns image item → client decrypts description, displays image from R2
```

**New ItemType:** `IMAGE`.

---

### 11.6 Updated Database Schema Additions

```prisma
model Integration {
  id            String   @id @default(cuid())
  userId        String
  provider      String   // "gmail"
  refreshToken  String   // encrypted with masterKey
  refreshTokenIv String
  connectedAt   DateTime @default(now())

  @@unique([userId, provider])
  @@map("integrations")
}

model InboxItem {
  id          String       @id @default(cuid())
  userId      String
  externalId  String       // Gmail message ID
  ciphertext  String        // subject + snippet + body, encrypted
  iv          String
  priority    Priority?
  status      InboxStatus  @default(UNREAD)
  threadId    String?
  receivedAt  DateTime
  createdAt   DateTime     @default(now())

  @@unique([userId, externalId])
  @@index([userId, priority])
  @@map("inbox_items")
}

enum Priority {
  HIGH
  MEDIUM
  LOW
}

enum InboxStatus {
  UNREAD
  READ
  ACTIONED
  ARCHIVED
}

// Additions to existing Item model:
//   summaryCiphertext String?
//   summaryIv         String?
//
// Additions to ItemType enum:
//   VIDEO
//   IMAGE
//   SCHEDULE
```

---

### 11.7 Updated Folder Structure (additions)

```
apps/api/src/
  agent/
    inbox.ts          ← Gmail sync + prioritization + schedule generation
    article.ts        ← summarization for clips
    video.ts          ← YouTube transcript fetch + summarize
    image.ts          ← GPT-4o vision description
    suggestAction.ts  ← on-demand reply/next-action suggestion
  workers/
    inboxSync.ts      ← BullMQ cron worker
    videoTranscript.ts
    imageDescribe.ts
  lib/
    gmail.ts          ← Gmail API client
    youtubeTranscript.ts
    kms.ts            ← masterKey cache encrypt/decrypt (Redis + KMS key)
```

---

### 11.8 New API Routes

```
Integrations
  POST   /integrations/gmail/connect    (OAuth flow)
  DELETE /integrations/gmail/disconnect
  POST   /integrations/gmail/sync       (manual trigger, also runs on cron)

Inbox
  GET    /inbox                          ?priority=&status=
  GET    /inbox/:id
  PATCH  /inbox/:id                      { status }
  GET    /inbox/schedule/today           → today's generated schedule item

Agent (additions)
  POST   /agent/suggest-action           { itemId, decryptedBody }

Items (additions)
  POST   /items/video                    { youtubeUrl }
  POST   /items/image                    { r2Key }  (after upload)
```

---

### 11.9 Cost Considerations

| Feature | Cost driver | Mitigation |
|---|---|---|
| Inbox sync | Gmail API (free) + GPT-4o-mini classification (batch) | Batch all emails in one prompt, not per-email |
| Article summary | GPT-4o-mini, 1 call per article | Negligible |
| Video transcript | YouTube Transcript API (free), GPT-4o-mini summary | Negligible — no Whisper |
| Image description | GPT-4o vision, ~$0.01-0.02/image | Could add user-configurable: auto-describe on upload vs on-demand |