# DBA Utility

A production-ready web application for managing **Manual Indexes** with a complete, tamper-resistant **Audit Logging** system.

An ACTIVE Manual Index is not just a record: the backend runs `createIndex()` on the target
database, so the index really exists in MongoDB. Editing one drops and recreates it, deleting one
drops it, and every page shows whether the definition and the database actually agree.

DBA Utility keeps its own records (index definitions, audit logs) in the database from the
connection string, but **manages indexes on any database on the same server** — pick the database
and collection from dropdowns. An optimization dashboard reports what that work bought, per cluster
and per date range.

- **Frontend** — React 18 + Vite + React Router (separate app, `frontend/`)
- **Backend** — Node.js + Express REST API (separate app, `backend/`)
- **Database** — MongoDB with Mongoose

The two applications are fully decoupled: the frontend talks to the backend only over HTTP, so they can be deployed to different hosts.

---

## Quick start

You need Node.js 18+ and a MongoDB instance (local or Atlas).

### 1. Backend

```bash
cd backend
cp .env.example .env          # then edit MONGODB_URI if needed
npm install
npm run seed                  # optional: loads 5 sample indexes + audit history
npm run dev                   # http://localhost:5000
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:5000`, so no CORS setup is needed in development.

---

## Project structure

```
dba-utility/
├── backend/
│   ├── .env.example
│   └── src/
│       ├── app.js                  Express app: middleware, routes, error handling
│       ├── server.js               Boot, DB connection, graceful shutdown
│       ├── config/
│       │   ├── env.js              Typed, validated environment configuration
│       │   └── db.js               Mongoose connection lifecycle
│       ├── models/
│       │   ├── ManualIndex.js      Manual index schema + audit snapshot helper
│       │   └── AuditLog.js         Append-only audit schema (mutation hooks blocked)
│       ├── controllers/
│       │   ├── manualIndexController.js
│       │   └── auditLogController.js
│       ├── routes/
│       │   ├── index.js            /api router
│       │   ├── manualIndexRoutes.js
│       │   └── auditLogRoutes.js
│       ├── services/
│       │   ├── auditService.js     The ONLY writer of audit entries
│       │   ├── indexService.js     createIndex / dropIndex against any database
│       │   ├── dashboardService.js Optimization dashboard aggregations
│       │   └── optimizationService.js  The ONLY writer of optimization activities
│       ├── middleware/
│       │   ├── userContext.js      Resolves req.user (swap point for real auth)
│       │   ├── validate.js         Validator runner + ObjectId guard
│       │   └── errorHandler.js     404 + centralised error handling
│       ├── validators/
│       │   └── manualIndexValidator.js
│       ├── utils/                  ApiError, asyncHandler, apiResponse, query
│       └── scripts/seed.js
└── frontend/
    ├── .env.example
    └── src/
        ├── main.jsx / App.jsx      Entry point and routes
        ├── api/                    axios client + one service per resource
        ├── context/                UserContext (acting user), ToastContext
        ├── components/
        │   ├── layout/             AppLayout, Sidebar, Header
        │   └── ui/                 Button, Card, Modal, Badge, Field, Pagination…
        ├── pages/                  Dashboard, list, form, detail, audit logs
        ├── utils/format.js
        └── styles/global.css       Design tokens + responsive design system
```

---

## API reference

All responses share one envelope:

```jsonc
// success
{ "success": true, "message": "…", "data": …, "meta": { …pagination… } }
// failure
{ "success": false, "message": "…", "errors": [{ "field": "indexName", "message": "…" }] }
```

### Manual Indexes

| Method | Endpoint | Description | Audit entry |
|---|---|---|---|
| `POST` | `/api/manual-indexes` | Create a manual index | **CREATE** |
| `GET` | `/api/manual-indexes` | List (search, filter, sort, paginate) | — |
| `GET` | `/api/manual-indexes/:id` | Get details | **VIEW** |
| `PUT` | `/api/manual-indexes/:id` | Update | **UPDATE** (with previous + new values) |
| `DELETE` | `/api/manual-indexes/:id` | Delete | **DELETE** (preserves final values) |
| `GET` | `/api/manual-indexes/:id/db-status` | Live comparison of the definition against MongoDB | — |
| `POST` | `/api/manual-indexes/:id/sync` | Force MongoDB to match the definition | **UPDATE** |
| `GET` | `/api/manual-indexes/meta/databases` | Databases on the server, for the dropdown | — |
| `GET` | `/api/manual-indexes/meta/collections?database=` | Collections in a database with their real indexes | — |
| `GET` | `/api/manual-indexes/stats/summary` | Dashboard aggregates | — |

List query parameters: `page`, `limit`, `search`, `status`, `indexType`, `sortBy`, `sortOrder`.

### Audit Logs (read-only)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/audit-logs` | List with filters (`excludeAction=VIEW` hides the noisiest action) |
| `GET` | `/api/audit-logs/:id` | Single entry |
| `GET` | `/api/audit-logs/filters/options` | Distinct users + action list for the filter dropdowns |
| `GET` | `/api/audit-logs/export?format=csv\|json` | Stream the filtered log as a download |
| `GET` | `/api/audit-logs/purge/preview?olderThanDays=90` | How many entries a purge would remove — deletes nothing |
| `GET` | `/api/audit-logs/purge/preview?mode=views` | How many VIEW entries are stored |
| `POST` | `/api/audit-logs/purge` | Remove entries older than the cut-off (**admin only**) |
| `POST` | `/api/audit-logs/purge` with `mode: "views"` | Remove every VIEW entry (**admin only**) |

List query parameters: `page`, `limit`, `search`, `action`, `userId`, `indexId`, `startDate`, `endDate`, `sortBy`, `sortOrder`.

Every other `POST`, `PUT`, `PATCH` and `DELETE` on `/api/audit-logs/*` returns **403**.

### Optimization Dashboard

Served under `/api/dashboard/dba` — the paths the frontend already calls. Every read takes the same
scope, so changing the date filter or the cluster in the UI is one parameter change applied
uniformly rather than a different contract per panel:

- `?from=` / `?to=` — ISO instants. **Either may be omitted**; "all time" has neither. They are
  sent as instants rather than a preset name because the browser resolved them in the reader's
  timezone, and a server recomputing "this week" from the word could disagree by a day.
- `?cluster=<key>` — omitted or `all` means **every cluster**, which is the view the dashboard
  opens on. `unassigned` selects entries belonging to no cluster.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/dashboard/dba/summary` | KPI totals, the same totals for the preceding period, and the performance panel |
| `GET` | `/api/dashboard/dba/activities` | The recent-activity table; `?activityType=` is the drill-down a KPI card opens |
| `POST` | `/api/dashboard/dba/activities` | Record a query rewrite or API optimisation (see below) |
| `GET` | `/api/dashboard/dba/range-counts` | The count behind each date card, in one request |
| `GET` | `/api/dashboard/dba/cluster-counts` | How much of the range sits on each cluster — the chip numbers |
| `GET` | `/api/dashboard/dba/filters/options` | The databases, collections and statuses actually recorded |

`summary` also takes `?previousFrom=` / `?previousTo=`; without them `previous` is null and the
cards show no change rather than a made-up one. `range-counts` takes
`?ranges=[{"key","from","to"}]` — one request rather than one per preset, so opening the dashboard
does not fan out into five near-identical count queries. Activity parameters: `page`, `limit`,
`activityType`, `database`, `collection`, `status`.

#### All clusters at once

This is the one part of the API that deliberately reaches past the cluster the session is pinned to,
and the only place it *can* happen: a session token names exactly one cluster, so the browser cannot
assemble a cross-cluster total without swapping tokens and thrashing the session. It is safe here
because **sign-in is not cluster-wise** — one account signs in once for the whole deployment and
then picks a cluster, so a user who can see the all-cluster total can already reach every one of
those clusters by switching to it. The routes still carry the full
`requireDatabase + requireAuth + requireCluster` guard.

Every configured cluster appears in `cluster-counts` whether or not it has activity: a cluster
missing from the chip strip reads as "not configured" rather than "quiet this week". An unknown
`?cluster=` is a **400**, not a silently empty dashboard that looks like a quiet week.

#### Where the numbers come from

The dashboard reads `optimizationactivities`, a central collection beside the audit trail with the
cluster recorded on each entry. It is separate from the audit log on purpose: the audit log is
evidence of who changed which record and knows nothing about execution times, while a slow query
rewritten in application code changes no record at all yet is exactly the work the dashboard exists
to count.

Two of the four activity types are recorded automatically, from the paths that perform them —
`INDEX_CREATED` when a Manual Index is really applied to MongoDB (never for a `DRAFT`), and
`INDEX_DROPPED` from all three drop paths: Manual Index delete, Manual Index drop, and a
`dropIndex` typed into the Query Executor. Posting either type to
`POST /api/dashboard/dba/activities` is rejected with **400**, because it would count the same
change twice.

The other two have no database event to catch, so they are reported by whoever did the work:

```jsonc
POST /api/dashboard/dba/activities
{
  "activityType": "LONG_QUERY",          // or API_OPTIMIZATION
  "databaseName": "shop",
  "collectionName": "orders",
  "subject": "{ status: 1, createdAt: -1 }",
  "before": { "executionTimeMs": 850, "documentsExamined": 120000, "planStage": "COLLSCAN" },
  "after":  { "executionTimeMs": 120, "documentsExamined": 900, "indexUsed": "status_1_createdAt_-1" }
}
```

`improvementPercent` (85.88 here) is derived from `before`/`after` on save and never accepted from
the caller, so the headline can never disagree with the measurements printed beside it.

#### Backfilling the history

`optimizationactivities` is only written from the moment the recording hooks shipped, so a
deployment with real history opens on a dashboard of zeros — the work happened, it simply was not
counted. Every index created or dropped before that is in `auditlogs` and nowhere else:

```bash
npm run backfill:dashboard -- --dry-run   # report what it would write, change nothing
npm run backfill:dashboard                # write it
```

Safe to run twice — each activity records the `auditLogId` it came from, and an audit entry that
already has one is skipped. Nothing in `auditlogs` is modified; it is append-only and this only
reads it. Rows it writes are tagged `notes: "Backfilled from the audit trail"`, so they can be
identified or removed without touching anything recorded live.

It deliberately skips **UPDATE** entries (an update that re-applies an index drops and recreates the
same one, so counting it would double-count the original CREATE) and any CREATE or DELETE whose
`mongoCommand` is empty — that emptiness is exactly the test for "did this ever touch MongoDB",
so a DRAFT definition or a delete with no applied index behind it is correctly not counted.

Backfilled rows carry **no before/after figures**: the audit trail holds field snapshots, not query
plans, and never recorded execution times. The KPI cards, cluster chips and activity table become
correct immediately; the performance panel stays blank until measured optimisations are recorded.
Inventing a plausible "850ms → 120ms" for these rows was the alternative, and a fabricated
improvement figure is worse than an honest blank.

#### What the performance panel counts

Only `APPLIED` work is averaged. A pending or failed optimisation has not changed how the database
behaves, and averaging its intended "after" in would overstate the gain.

Index drops are excluded from the **improvement** figure specifically. They trade read speed for
write throughput and storage, so their "after" is legitimately slower — counting them as
regressions would misread the intent. They still count towards the execution-time and
documents-examined averages, which describe what the database is doing rather than whether it got
faster.

Every measurement field is optional and defaults to **null**, not 0 — an unmeasured optimisation
must not report "0 ms" and drag every average towards zero. The aggregations skip nulls, and
`queriesOptimized` says how many rows the averages actually rest on.

`memoryImpactPct` and `cpuImpactPct` are **always null**: nothing measures them. The record holds
execution time and documents examined, both taken from the query plan; memory residency and CPU are
properties of the server over time, not of one optimisation, and MongoDB does not attribute either
to the change that caused it. The panel renders null as "not measured" — a 0 there would read as
"measured, and it made no difference", which is a different claim and an unfounded one.

### Index types

| Type | Key shape | Notes |
|---|---|---|
| `SINGLE` | one field, `1`/`-1` | |
| `COMPOUND` | two or more fields | order matters — most selective first |
| `UNIQUE` | any ordered key | rejects duplicates; existing duplicates make creation fail |
| `PARTIAL` | any ordered key | requires a condition |
| `TTL` | one date field | requires `expireAfterSeconds` |
| `TEXT` | every key `text` | one text index per collection |
| `HASHED` | one key, `hashed` | hashed sharding, even key distribution |
| `WILDCARD` | `$**` or `path.$**` | indexes fields without naming them |
| `GEO2DSPHERE` | key(s) `2dsphere` | GeoJSON |
| `GEO2D` | one key, `2d` | legacy coordinate pairs |

A **condition** (`partialFilterExpression`) is an *option*, not a type — it can be attached to any
index except `TEXT`, and cannot be combined with `sparse`. MongoDB only accepts `$eq`, `$gt`, `$gte`,
`$lt`, `$lte`, `$exists`, `$type` and `$and` inside it; the form offers exactly those, and the
backend rejects anything else with an explanation rather than letting `createIndex` fail.

---

## Data model

**`manualindexes`**

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `indexName` | String | required, unique, 3–120 chars |
| `description` | String | ≤ 1000 chars |
| `databaseName` | String | database the index is created on; blank = the default target |
| `collectionName` | String | required — the collection the index is created on |
| `keys` | `[{ field, direction }]` | the real key spec; direction is `1`, `-1` or `"text"` |
| `options` | Object | `unique`, `sparse`, `expireAfterSeconds` (TTL), `partialFilterExpression` (PARTIAL) |
| `applied` / `appliedIndexName` / `appliedAt` | Boolean / String / Date | what was actually created in MongoDB |
| `indexType` | String | `SINGLE` \| `COMPOUND` \| `UNIQUE` \| `PARTIAL` \| `TTL` \| `TEXT` \| `HASHED` \| `WILDCARD` \| `GEO2DSPHERE` \| `GEO2D` |
| `status` | String | `ACTIVE` \| `INACTIVE` \| `DRAFT` |
| `createdBy` / `createdByUserId` | String | acting user at creation |
| `updatedBy` | String | acting user at last update |
| `createdAt` / `updatedAt` | Date | managed by Mongoose |

**`auditlogs`**

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `action` | String | `CREATE` \| `VIEW` \| `UPDATE` \| `DELETE`, plus two system actions: `DROP` (an index removed directly) and `PURGE` (retention) |
| `indexId` / `indexName` | ObjectId / String | subject of the action |
| `userId` / `userName` | String | who performed it |
| `previousValues` | Mixed | UPDATE and DELETE |
| `newValues` | Mixed | CREATE and UPDATE |
| `changedFields` | [String] | computed diff for UPDATE |
| `details` | String | human-readable summary |
| `metadata` | Object | method, endpoint, IP, user agent |
| `timestamp` | Date | server time of the action |

Indexes are declared on `timestamp`, `action + timestamp`, `userId + timestamp` and `indexId + timestamp` to keep the audit page fast as the collection grows.

---

## VIEW entries

Opening an index's details page is recorded, as the specification requires — and it is by far the
most frequent event, easily ten VIEW entries for every change. Left unfiltered it buries the CREATE,
UPDATE and DELETE entries that people actually come to the log to find.

So the Audit Logs page **hides VIEW by default**, with a "Show view events" toggle, and the dashboard
activity feed shows only actions that changed something. Selecting VIEW in the action filter
overrides the toggle. The exclusion is applied server-side through `excludeAction`, not by discarding
rows in the browser — filtering a page of results client-side would leave the totals and page count
wrong.

Nothing is lost: the entries are still written, still counted on the dashboard, still exportable, and
still there per-index on each index's own detail page, where "who looked at this" is the point.

To stop recording them at all, set `LOG_VIEW_ACTIONS=false`. Opening a details page then writes
nothing, CREATE / UPDATE / DELETE keep their full trail, and the interface adapts: the "Show view
events" toggle and the VIEW filter option both disappear rather than sitting there inert.

VIEW entries already collected can be cleared from the purge dialog, regardless of age. That bulk
removal is **restricted to VIEW** — the one action that records no change. CREATE, UPDATE, DELETE,
DROP and PURGE can only ever age out through the retention cut-off, so nothing that altered anything
can be erased by class. The clearance is itself recorded as a PURGE entry.

## Audit retention

Audit entries cannot be created, edited, or deleted one at a time — that restriction is the whole
point of the log, and it is enforced at four layers (see below).

What an administrator *can* do is apply a **retention policy**: remove entries older than a chosen
age. That is a different thing from deleting an inconvenient record, and it is built to stay that way:

- **Preview first.** The dialog says exactly how many entries the cut-off matches before anything goes.
- **Export first.** CSV and JSON downloads stream the filtered log, so a copy can be kept.
- **Admin only.** Enforced server-side on `req.user.role`, not just hidden in the UI.
- **Confirmation required.** The request is rejected without an explicit `confirm: true`.
- **The purge is itself recorded** as a `PURGE` entry naming who ran it, the cut-off, and how many
  entries went.
- **`PURGE` entries are never purged.** A later purge always skips them, so the history of what was
  removed cannot itself be removed.

With the mock user context the role arrives in a header, which makes it a UI-level guard rather than
real security. Replacing `middleware/userContext.js` with genuine authentication makes it enforceable
without touching anything else.

## How definitions reach MongoDB

`services/indexService.js` is the only place that talks to MongoDB's index commands.

**Status decides everything.** `ACTIVE` means a real index exists; `DRAFT` and `INACTIVE` mean the
definition is stored but nothing was applied. Moving between them creates or drops the real index.

| Action | What happens in MongoDB |
|---|---|
| Create an ACTIVE index | `createIndex()` runs **first**. If MongoDB rejects it, nothing is saved. |
| Create a DRAFT/INACTIVE index | Nothing — the definition is stored only. |
| Edit keys, options or name | The old index is dropped and the new one created. If the new one is rejected, the old one is restored and nothing changes. |
| ACTIVE → DRAFT/INACTIVE | The real index is dropped. |
| Delete | The real index is dropped, then the record is removed. The audit entry survives. |

**Per-type rules are validated before anything runs**, so MongoDB rarely has to reject a definition:
SINGLE takes exactly one key, COMPOUND at least two, TTL exactly one key plus `expireAfterSeconds`,
TEXT requires every key to use direction `text`, and PARTIAL requires a JSON filter expression.

**Safety guards.** System collections are refused. The `_id_` index can never be dropped. An index is
only ever dropped when this application created it, tracked through `appliedIndexName` — indexes
created outside DBA Utility are never touched.

**Drift is visible, not assumed.** `GET /:id/db-status` compares the stored definition against the
live database on every detail page. If someone drops an index in the shell, the page says so and the
Sync button puts it back.

## Which database indexes land on

This is worth being precise about, because getting it wrong is silent.

The connection string decides where DBA Utility stores *its own* data — `manualindexes` and
`auditlogs`. It does **not** decide where indexes are created. Each Manual Index carries a
`databaseName`; when blank, the target is `TARGET_DB` if set, and otherwise the database from the
connection string.

So an application whose data lives in `app_data` while DBA Utility stores its records in
`dba_utility` simply picks `app_data` in the form. Changing a record's database drops the index from
the old one and creates it on the new one.

Reserved databases (`admin`, `local`, `config`) and `system.*` collections are refused outright.

## How audit integrity is enforced

Four layers, so no single mistake can corrupt the trail:

1. **One writer.** Only `services/auditService.js` creates entries, and it is called from inside the controllers that perform the actions. There is no request payload that can shape an entry directly.
2. **No write API.** Every non-`GET` verb under `/api/audit-logs` returns 403 with an explanatory message.
3. **Schema immutability.** Every field is `immutable: true`, and pre-hooks on `updateOne`, `findOneAndUpdate`, `deleteOne`, `deleteMany` (and the rest) throw. Re-saving an existing document throws too. Even application code written later cannot modify an entry through Mongoose.
4. **Server-side identity and time.** `userId`, `userName` and `timestamp` come from `req.user` and the server clock, never from the client body.

Audit writes are also non-blocking for correctness: if the log write fails, the error is recorded to stderr rather than rolling back a successful user action, and the failure stays visible to operators.

A `VIEW` entry is written by `GET /api/manual-indexes/:id`, so opening an index's detail page in the UI is recorded automatically. Note that the edit form loads the record through the same endpoint, so opening the editor also produces a VIEW entry — which is usually the desired audit behaviour.

---

## User identity

This build ships **without authentication**, per the project scope. The roster lives in
`frontend/src/context/UserContext.jsx` and currently holds one person, System Administrator, whose
identity is sent as `x-user-id` / `x-user-name` / `x-user-role` headers by an axios interceptor;
adding entries to that array brings back a switcher in the header automatically. The role gates
admin-only actions (the audit retention purge and dropping an unused index); `middleware/userContext.js` resolves them into `req.user`, falling back to `DEFAULT_USER_ID` / `DEFAULT_USER_NAME`.

To move to real authentication, replace `userContext.js` with your JWT/session middleware so it populates `req.user` with the same `{ userId, userName }` shape. Nothing else in the backend needs to change.

---

## Environment variables

**`backend/.env`**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `NODE_ENV` | `development` | Enables request logging and stack traces when not `production` |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/dba_utility` | Connection string |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `TARGET_DB` | *(empty)* | Default database indexes are created on. Empty = the database in `MONGODB_URI`. |
| `LOG_VIEW_ACTIONS` | `true` | Set to `false` to stop recording VIEW entries altogether. |
| `ALLOW_INMEMORY_FALLBACK` | `true` | Start on a temporary in-memory database when MongoDB is unreachable (development only). |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `900000` / `1000` | Rate limiting |
| `DEFAULT_USER_ID` / `DEFAULT_USER_NAME` | `u-1001` / `System Administrator` | Fallback identity |

**`frontend/.env`**

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | Backend base URL. Use the full URL when deploying separately. |

---

## Production build

```bash
cd backend  && NODE_ENV=production npm start
cd frontend && npm run build          # emits frontend/dist — serve with any static host
```

When the frontend is served from a different origin, set `VITE_API_BASE_URL` to the backend's public URL **and** add that frontend origin to the backend's `CORS_ORIGIN`.

---

## What's included beyond the brief

- A live command preview in the form, showing the exact `createIndex()` call before you save
- Dashboard aggregates (`/stats/summary`) with status and type breakdowns
- Per-index audit timeline on the detail page, deep-linking into the filtered Audit Logs
- Card-stacked tables below 720px so every column stays readable on a phone
- Debounced search, stale-response guards, request metadata (IP, user agent, endpoint) on every entry
- Helmet, gzip compression, rate limiting, graceful shutdown, and a React error boundary
#   D b a u t i l i t y  
 #   D b a u t i l i t y  
 #   D b a u t i l i t y  
 #   D b a u t i l i t y  
 