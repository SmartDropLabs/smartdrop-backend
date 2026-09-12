# SmartDrop backend

[![CI](https://github.com/SmartDropLabs/smartdrop-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SmartDropLabs/smartdrop-backend/actions/workflows/ci.yml)

HTTP APIs, webhooks, and **indexing** for SmartDrop. This repository contains Node.js services that talk to **Horizon**, **Soroban RPC**, and external APIs.

## API Versioning

The public HTTP API uses path-based versioning under `/api/v1`.

- Backward-compatible additions stay in the existing version.
- Breaking changes ship under a new path, such as `/api/v2`.
- Deprecated endpoints should include deprecation guidance in the changelog and OpenAPI docs, and may add `Deprecation` / `Sunset` headers when an endpoint is scheduled for removal.
- Consumers should treat `/api/v1` as stable until a newer version is explicitly documented.

## Related repositories

| Repository | Role |
|------------|------|
| [**smart-frontend**](https://github.com/SmartDropLabs/smart-frontend) | Next.js static app |
| [**smartdrop-contracts**](https://github.com/SmartDropLabs/smartdrop-contracts) | Soroban Rust contracts |
| [**SmartDrop**](https://github.com/SmartDropLabs/SmartDrop) | Original monorepo (reference) |

## Features

### Price Oracle Service

Multi-source price oracle that fetches and caches USD prices for Stellar assets.

**Data Sources:**
- Stellar DEX (orderbook prices)
- CoinGecko API
- CoinMarketCap API

**Features:**
- Median price aggregation from multiple sources
- Redis caching with configurable TTL (default: 60s)
- Background job refreshes prices every 30 seconds
- Stale price detection (>5 minutes)
- Price anomaly logging (>20% changes)
- Fallback chain: DEX → CoinGecko → CoinMarketCap → cached

### Soroban Event Indexer

Polls Soroban RPC for SmartDrop contract events and stores decoded event state in Redis so the API can answer claim-status queries without live RPC calls on every request.

**Indexed events:**
- `airdrop_created`
- `recipient_added`
- `token_claimed`
- `airdrop_expired`

**Features:**
- Configurable contract ID, RPC URL, poll interval, poll limit, and start ledger
- Last indexed ledger checkpoint persisted in Redis
- Raw XDR and decoded event data retained for each indexed event
- Aggregated airdrop status, recipient lists, recipient claim history, and indexer status endpoints
- RPC errors are logged and the poller continues on the next interval

## Setup
### Webhook Delivery System

Registers subscriber endpoints for SmartDrop lifecycle events and delivers signed JSON payloads with retry tracking.

**Events:**
- `airdrop.failed` — **(Active)** fired automatically when an airdrop expires (see below), in addition to any other failure path
- `airdrop.created` — *(Planned, not yet implemented)*
- `airdrop.executing` — *(Planned, not yet implemented)*
- `airdrop.completed` — *(Planned, not yet implemented)*
- `recipient.claimed` — *(Planned, not yet implemented)*

**Features:**
- Webhook endpoint CRUD with secrets kept out of list responses
- Timestamped HMAC-SHA256 request signatures
- At-least-once delivery attempts with exponential backoff
- Delivery logs with response code, error, duration, and attempt count
- Delivery records expire after 30 days to keep Redis usage bounded
- Dead-letter storage after retry exhaustion

### Airdrop Lifecycle & On-Chain Status

**Important:** `POST /api/v1/airdrops` creates an off-chain bookkeeping record
only — it does **not** submit any transaction to the Stellar network. The
Soroban contract that actually executes airdrops lives in a separate repository
(`smartdrop-contracts`). Once the on-chain airdrop ID is known, populate the
`contract_airdrop_id` field via `PATCH /api/v1/airdrops/:id` to link the REST
record with indexer-observed on-chain state.

The indexer (`src/indexer/eventStore.js`) independently tracks on-chain
airdrop events (`airdrop_created`, `recipient_added`, `token_claimed`,
`airdrop_expired`) keyed by the contract's own airdrop ID. Until the linking
field is set, the REST-managed airdrop and the indexer's view are
un correlated — `GET /airdrops/:id/recipients` reflects only the
originally-submitted intent and does **not** reflect on-chain claim status.

### Airdrop Expiry Reconciliation

Airdrops carry an `expiry_ledger`, validated as being in the future only at
creation/update time. A background job (`src/jobs/airdropExpiry.js`, same
`start()`/`stop()` pattern as the price-refresh and webhook-retry jobs)
periodically re-checks that condition against the live network:

- Every `AIRDROP_EXPIRY_CHECK_INTERVAL_SECONDS` (default 60s), fetches the
  current Horizon ledger sequence and scans every airdrop still in a
  non-terminal status (`draft`, `executing`).
- Any airdrop whose `expiry_ledger` has passed is atomically transitioned to
  `expired` and fires an `airdrop.failed` webhook event (`data.reason:
  "expired"`) to every subscriber registered for it — no client action
  required.
- The transition is idempotent: re-running the check against an
  already-expired airdrop is a guaranteed no-op, so the webhook fires
  exactly once per airdrop even if the job runs again before anything else
  changes its status.
- If Horizon is temporarily unreachable, the job logs a warning and skips
  that cycle rather than crashing — airdrops are simply re-checked on the
  next tick.

### Leader Election

Background jobs (price refresh, webhook retry worker, airdrop expiry) use
**Redis-based leader election** to ensure that across any number of horizontally-
scaled replicas, only one instance actively runs each job at any given time.

**Mechanism:**

Each job type has its own Redis lock key (e.g. `leader:price_refresh`,
`leader:webhook_retry`, `leader:airdrop_expiry`). On startup, every replica
attempts to acquire the lock via `SET key value NX PX <ttl_ms>`. The instance
that succeeds becomes the **leader** and runs the actual scheduled work. All
other replicas are **followers** — they stay ready to take over, running only a
periodic renewal check loop.

The current leader periodically renews the lease using an atomic Lua script
(`GET` + `PEXPIRE` in one round trip, keyed to only succeed if the stored value
still matches the leader's instance ID). If the leader process dies or becomes
unresponsive, the lease expires automatically after the TTL, and a follower
detects the expiry on its next renewal check and acquires leadership.

**Failover timing:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LEASE_TTL_MS` | 15000 (15s) | How long a lease is valid without renewal |
| `LEASE_RENEW_INTERVAL_MS` | 5000 (5s) | How often the leader renews (and followers attempt to acquire) |

- **Best-case failover** (leader stops gracefully): lease is released immediately
  via the Lua-based conditional `DEL`; a follower acquires within one renewal
  check interval (~5s).
- **Worst-case failover** (leader crashes without cleanup): lease expires after
  `LEASE_TTL_MS` (15s); the next follower renewal check detects it and acquires
  (up to `LEASE_TTL_MS + LEASE_RENEW_INTERVAL_MS` ≈ 20s total).

**Verifying leadership:**

Check the `GET /health` endpoint. Each job entry includes a `leader` field
(`true`/`false`) and `leader_instance_id` identifying which replica holds the
lock. The top-level `leader_election` object shows the local instance's identity
and lease configuration.

```bash
curl http://localhost:4000/health | jq '.jobs.price_refresh.leader'
```

To see which replica holds the lock from Redis directly:

```bash
redis-cli GET leader:price_refresh
redis-cli GET leader:webhook_retry
redis-cli GET leader:airdrop_expiry
```

**Graceful shutdown:**

When a leader receives `SIGTERM`/`SIGINT`, the shutdown sequence releases the
lease via the atomic conditional-DEL Lua script before closing the Redis
connection, minimizing the failover window for followers.

**Important caveat:**

Leader election ensures only one instance runs the scheduled job logic, but it
does not replace the need for atomic Redis operations within individual job ticks.
For example, `deliveryRepository.popDueRetries` uses its own Lua-based atomic
claim to prevent double-processing during any brief overlap during leadership
handoffs. This is a separate concern that leader election complements but does
not solve on its own.

---

## 🚀 Quick Start (Docker Development)

You can spin up the entire local development stack—including the API, PostgreSQL database, and Redis instance—using a single command.

### Prerequisites
* Ensure you have [Docker and Docker Compose](https://docs.docker.com/get-docker/) installed.

### Spin Up the Stack

1. **Clone and Navigate** to the project root directory.
2. **Set up Environment Variables**:
   ```bash
   cp .env.example .env

```

3. **Launch the Infrastructure**:
```bash
docker compose up --build

```



The API will stand up on [http://localhost:4000](https://www.google.com/search?q=http://localhost:4000).

* **Hot Reloading:** Any changes made to files within the `./src` directory will instantly trigger an application restart inside the container.
* **Database & Cache:** Health checks prevent the API from booting until Postgres and Redis are fully operational.
* **Teardown:** To stop the containers and maintain volume data, run `docker compose down`. To wipe database volumes completely during stop, use `docker compose down -v`.

---

## Configuration

The application reads configurations from the `.env` file at the root.

**Environment Variables:**

| Variable | Description | Default | Required |
| --- | --- | --- | --- |
| `PORT` | Server port | 4000 | No |
| `REDIS_HOST` | Redis server host | redis | No |
| `REDIS_PORT` | Redis server port | 6379 | No |
| `REDIS_PASSWORD` | Redis password | undefined | No |
| `REDIS_URL` | Redis connection string | redis://redis:6379 | No |
| `DATABASE_URL` | PostgreSQL connection string | postgres://smartdrop:smartdrop@postgres:5432/smartdrop | No |
| `STELLAR_HORIZON_URL` | Horizon API URL | https://horizon.stellar.org | No |
| `SOROBAN_RPC_URL` | Soroban RPC URL for contract event polling | https://soroban-rpc.mainnet.stellar.gateway.fm | No |
| `SMARTDROP_CONTRACT_ID` | SmartDrop contract ID to index | undefined | Yes, for indexer |
| `INDEXER_ENABLED` | Enable Soroban event polling | true | No |
| `INDEXER_POLL_INTERVAL_MS` | Soroban event polling interval in milliseconds | 5000 | No |
| `INDEXER_POLL_LIMIT` | Maximum events requested per poll | 100 | No |
| `INDEXER_START_LEDGER` | First ledger to scan when no checkpoint exists | 0 | No |
| `USDC_ISSUER` | USDC issuer address | GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA | No |
| `COINGECKO_API_KEY` | CoinGecko API key | undefined | No |
| `COINMARKETCAP_API_KEY` | CoinMarketCap API key | undefined | No |
| `PRICE_CACHE_TTL` | Cache TTL in seconds | 60 | No |
| `PRICE_REFRESH_INTERVAL` | Refresh interval in seconds | 30 | No |
| `PRICE_STALE_THRESHOLD` | Stale threshold in minutes | 5 | No |
| `PRICE_ANOMALY_THRESHOLD` | Anomaly detection threshold % | 10 | No |
| `ADMIN_API_KEY` | Bootstrap admin bearer token for API key management | undefined | Yes, for protected endpoints |
| `LOG_LEVEL` | Logging level | info | No |

| `WEBHOOK_MAX_ATTEMPTS` | Total delivery attempts (initial + retries) | 3 | No |
| `WEBHOOK_RETRY_BASE_MS` | Base backoff between retries (ms) | 30000 | No |
| `WEBHOOK_RETRY_FACTOR` | Exponential backoff multiplier | 2 | No |
| `WEBHOOK_TIMEOUT_MS` | HTTP timeout per delivery attempt | 5000 | No |
| `WEBHOOK_RETRY_POLL_MS` | Retry worker poll interval | 5000 | No |
| `WEBHOOK_RETRY_BATCH` | Max retries processed per tick | 25 | No |
| `WEBHOOK_RATELIMIT_WINDOW` | Mgmt rate-limit window (s) | 60 | No |
| `WEBHOOK_RATELIMIT_MAX` | Mgmt rate-limit max requests / window / IP | 60 | No |
| `WEBHOOK_TEST_RATELIMIT_WINDOW` | Test endpoint rate-limit window (s) | 60 | No |
| `WEBHOOK_TEST_RATELIMIT_MAX` | Test endpoint rate-limit max / window / IP | 5 | No |

| `CORS_ALLOWED_ORIGINS` | Allowed origins split by commas | http://localhost:4000,http://localhost:3001 | No |
|----------|-------------|---------|----------|
| `NODE_ENV` | Runtime environment: `development`, `test`, or `production` | development | No |
| `PORT` | Server port | 3000 | No |
| `REDIS_URL` | Redis connection URL | redis://localhost:6379 in development/test | Yes in production |
| `DATABASE_URL` | Database connection URL reserved for persistence-backed features | postgres://localhost/smartdrop in development, postgres://localhost/smartdrop_test in test | Yes in production |
| `STELLAR_HORIZON_URL` | Horizon API URL | https://horizon.stellar.org | No |
| `USDC_ISSUER` | USDC issuer address | GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA | No |
| `COINGECKO_API_KEY` | CoinGecko API key | empty | No |
| `COINMARKETCAP_API_KEY` | CoinMarketCap API key | empty | No |
| `PRICE_CACHE_TTL_SECONDS` | Cache TTL in seconds | 60 | No |
| `PRICE_REFRESH_INTERVAL_SECONDS` | Refresh interval in seconds | 30 | No |
| `PRICE_STALE_THRESHOLD_MINUTES` | Stale threshold in minutes | 5 | No |
| `PRICE_ANOMALY_THRESHOLD_PCT` | Anomaly detection threshold % | 20 | No |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | Source failures before opening a price-source circuit | 3 | No |
| `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | Half-open successes required to close a circuit | 1 | No |
| `CIRCUIT_BREAKER_TIMEOUT_MS` | Open-circuit cool-down before a half-open probe | 30000 | No |

Each price source (`stellar_dex`, `coingecko`, `coinmarketcap`) gets one circuit breaker shared across every watched asset. `CIRCUIT_BREAKER_FAILURE_THRESHOLD` only counts genuine failures for an asset a source is supposed to support (network errors, unexpected empty responses) — a source being asked about an asset it doesn't support at all (e.g. CoinGecko has no mapping for anything but XLM) is filtered out before it ever reaches the breaker, so it can't trip that source offline for the other assets it does support.
| `ADMIN_API_KEY` | Bootstrap admin bearer token for API key management | empty | Yes, for protected endpoints |
| `AIRDROP_CSV_MAX_BYTES` | Maximum recipient CSV upload size in bytes | 5242880 (5 MiB) | No |
| `AIRDROP_JSON_MAX_BYTES` | Maximum JSON request body size; 2 MiB accommodates 10,000 inline recipients | 2097152 (2 MiB) | No |
| `AIRDROP_RATELIMIT_WINDOW` | Per-IP airdrop mutation rate-limit window in seconds | 60 | No |
| `AIRDROP_RATELIMIT_MAX` | Maximum create or recipient-add requests per window and IP | 10 | No |
| `INSTANCE_ID` | Explicit instance identity for leader election; auto-generated from hostname+UUID if empty | auto | No |
| `LEASE_TTL_MS` | Leader lease TTL in milliseconds — how long a lease is valid without renewal | 15000 | No |
| `LEASE_RENEW_INTERVAL_MS` | How often the leader renews its lease (and followers check to acquire) | 5000 | No |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, or `error` | info | No |
| `API_KEY_RATELIMIT_WINDOW_SECONDS` | Per-API-key rate-limit window in seconds | 60 | No |
| `API_KEY_RATELIMIT_FREE_MAX` | Requests per window for `free`-tier keys | 100 | No |
| `API_KEY_RATELIMIT_PRO_MAX` | Requests per window for `pro`-tier keys | 1000 | No |
| `API_KEY_RATELIMIT_ADMIN_MAX` | Requests per window for `admin`-tier keys | 10000 | No |


---

## Observability

### Startup banner

On startup the server logs a single summary line so an operator can tell what is running without shelling in: application version, Node version, `NODE_ENV`, port, watched asset count and codes, whether the indexer is enabled, the leader-election instance id, and the configured log level.

Redis and database URLs are included with their credentials stripped — a URL that cannot be parsed is logged as `[unparseable]` rather than verbatim, since a URL we cannot parse is also one whose password we cannot locate and remove.

### Request ID correlation

Every request is assigned an id (or adopts an inbound `X-Request-Id`), returned to the caller in the `X-Request-ID` response header and included in JSON response bodies as `request_id`. The id flows through all layers via `AsyncLocalStorage`, so every log line emitted while handling that request carries it automatically — as both `requestId` and the snake_case `request_id` alias — with no manual threading through service and repository calls.

The id is also stamped onto webhook delivery records and forwarded to receivers as an `X-Request-Id` header. Because it is persisted on the delivery, a retry that fires hours later still reports the request that originally caused it. Deliveries originated by background jobs have no inbound request and carry `null`.

---

## Indexer Resilience

The Soroban event indexer polls for contract events on an interval. A
circuit breaker already guarded individual RPC calls, but the poll loop
itself woke at a fixed rate, so a struggling node kept being re-probed at
full speed regardless of how many calls were failing (issue #255).

The poll interval is now adaptive:

- Each consecutive failed cycle multiplies the interval by
  `INDEXER_BACKOFF_FACTOR` (default 2), capped at
  `INDEXER_MAX_POLL_INTERVAL_MS` (default 5 minutes) so a long outage cannot
  push the next attempt arbitrarily far out.
- The first successful cycle resets the interval to the configured base.
- While the circuit breaker is open the indexer pauses rather than calling
  the node at all, and the cycle is counted as skipped rather than attempted.

Lag against the chain tip is tracked and alerted on. Crossing
`INDEXER_LAG_ALERT_THRESHOLD` ledgers (default 100, roughly 8 minutes at
Stellar's ~5s ledger close time) logs an error once, and a matching recovery
line is logged once when lag falls back below it — edge-triggered, so a
persistently lagging indexer does not bury the moment the lag began under an
identical warning on every poll.

`GET /api/v1/indexer/status` reports the resulting state:

| Field | Description |
|-------|-------------|
| `circuit_state` | `closed`, `open`, or `half-open` |
| `paused` | `true` while the breaker is open and polling is suspended |
| `consecutive_failures` | Failed cycles since the last success |
| `current_poll_interval_ms` | Interval in effect, including any backoff |
| `ledger_lag` | Ledgers behind the chain tip, or `null` if unknown |
| `lag_alerting` | `true` while lag exceeds the threshold |
| `metrics.events_per_second` | Indexing throughput since start |
| `metrics.error_rate` | Failed cycles as a fraction of completed cycles |
| `metrics.polls_skipped` | Cycles skipped because the breaker was open |

Rates are `null` rather than `0` before there is anything to divide by, so
"no data yet" stays distinguishable from "genuinely zero".

---

## Error Codes

Every error response uses the same envelope. Clients should switch on
`error.code`, which is stable, rather than on `error.message`, which may be
reworded at any time (issue #253):

```json
{
  "error": {
    "code": "WEBHOOK_NOT_FOUND",
    "message": "Webhook not found",
    "request_id": "req_V1StGXR8Z5jdHi6BmyT",
    "details": { "webhook_id": "wh_123" }
  }
}
```

`details` is present only when an error carries structured context — the
columns a CSV was missing, the rows that failed validation, the limit that
was exceeded.

| Code | Status | Meaning |
|------|--------|---------|
| `VALIDATION_ERROR` | 400 | Request failed schema validation |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Generic resource miss |
| `CONFLICT` | 409 | Request conflicts with current state |
| `PAYLOAD_TOO_LARGE` | 413 | Request body or upload exceeds its limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Unsupported content type |
| `RATE_LIMITED` | 429 | Request rate exceeded; retry after the delay |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `UPSTREAM_ERROR` | 502 | An upstream dependency failed |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable |
| `AIRDROP_NOT_FOUND` | 404 | No airdrop with that id |
| `AIRDROP_NOT_INDEXED` | 404 | Airdrop exists on chain but is not indexed yet |
| `RECIPIENT_LIMIT_EXCEEDED` | 400 | Recipient count above the configured maximum |
| `CSV_INVALID_ENCODING` | 400 | Upload is not valid UTF-8 |
| `CSV_MISSING_COLUMNS` | 400 | Required `address` / `amount` columns absent |
| `CSV_MALFORMED` | 400 | One or more rows failed validation |
| `CSV_EMPTY` | 400 | Upload contained no data rows |
| `WEBHOOK_NOT_FOUND` | 404 | No webhook with that id |
| `WEBHOOK_LIMIT_EXCEEDED` | 429 | Subscriber's webhook quota is full |
| `ALERT_NOT_FOUND` | 404 | No alert with that id |
| `API_KEY_NOT_FOUND` | 404 | No API key with that id |
| `PRICE_UNAVAILABLE` | 503 | No price could be sourced |
| `INDEXER_UNAVAILABLE` | 503 | Indexer could not answer |

Note that `WEBHOOK_LIMIT_EXCEEDED` and `RATE_LIMITED` share a 429 status but
mean different things: the former is a standing quota on how many webhooks a
subscriber may own and will not clear by waiting, while the latter is a
request rate that will.

---

## Recipient CSV Uploads

`POST /api/v1/airdrops/:id/recipients` accepts a CSV with `address` and
`amount` columns. Column names are matched case-insensitively and ignore
surrounding whitespace.

Uploads are rejected rather than silently trimmed (issue #254). Previously a
file whose columns were misnamed, or whose amounts were unparseable, returned
`201` having imported nothing — indistinguishable from a successful import.
Now:

- Files above `AIRDROP_CSV_MAX_BYTES` are rejected with `413`.
- A missing `address` or `amount` column returns `CSV_MISSING_COLUMNS`,
  naming the columns that were absent and the ones that were found.
- A file with no data rows returns `CSV_EMPTY`.
- Any invalid row fails the whole upload with `CSV_MALFORMED`; nothing is
  partially imported. `details.invalid_rows` lists the offending line numbers
  (counting the header, so they match a text editor) and why each failed, up
  to 20 entries.
- More than `maxRecipients` rows returns `RECIPIENT_LIMIT_EXCEEDED`.

Parsing is streaming — rows are consumed as the parser produces them and an
oversized file is abandoned partway rather than fully materialized first.

---

## Database Migrations

Migrations live in `src/db/migrations` and run through knex (issue #252):

```bash
npm run migrate            # apply pending migrations
npm run migrate:dry-run    # preview without applying
npm run migrate:status     # show applied and pending migrations
npm run migrate:rollback   # roll back the last batch
```

### Safety rails

Before anything is applied, the migration SQL is scanned for destructive
patterns — `DROP TABLE`/`COLUMN`/`SCHEMA`/`INDEX`/`CONSTRAINT`, `TRUNCATE`,
`DELETE FROM`, column type changes, `SET NOT NULL`, and renames. Keywords
inside SQL comments are ignored.

Against `NODE_ENV=production`, a migration containing any of those is
**refused** unless `--allow-destructive` is passed:

```bash
NODE_ENV=production node src/db/migrate.js up --allow-destructive
```

The scan is a safety net, not a SQL parser: a migration that builds
statements dynamically at runtime can still evade it, which is why the
production path requires a human-supplied flag rather than trusting the scan
to be exhaustive.

`--dry-run` reports which migrations are pending and which destructive
operations each contains. It degrades to static analysis of all migration
files when no database is reachable, so "what would this drop?" is
answerable before pointing the CLI at a live database.

Every run is preceded by a pre-flight check that the database is reachable
and readable, and each attempt — applied, failed, or rolled back — appends a
row to `migration_audit_log`. That table is deliberately separate from knex's
own `knex_migrations`: the latter records only which migrations are currently
applied, while the audit log records every attempt, which is what is actually
needed when reconstructing what happened to a database.

CI exercises the full up → rollback → up cycle against a real PostgreSQL
service, and asserts that the production guard blocks destructive migrations.

---

## API Endpoints

### Pagination

Every list endpoint returns the same envelope shape:

```json
{
  "data": [ /* ... */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

Request pagination with `?page=<n>&limit=<n>` (`page` defaults to 1,
`limit` defaults to 20 and is clamped to 100). This is the canonical
shape `src/schemas/pagination.js`'s `paginatedResponseSchema` defines,
now applied consistently across every list endpoint (#131 — closed
issue #35 introduced the helper but didn't get every endpoint onto it).

List endpoints following this contract:

- `GET /api/v1/airdrops`
- `GET /api/v1/airdrops/:id/recipients`
- `GET /api/v1/alerts`
- `GET /api/v1/webhooks`
- `GET /api/v1/airdrops/:id/onchain-recipients`
- `GET /api/v1/recipients/:address/claims`

**Intentionally exempt:** `GET /api/v1/webhooks/:id/deliveries` takes
only `?limit=<n>` (default 50, max 100) — deliveries are naturally
most-recent-first and capped server-side, so a `page`/offset concept
doesn't add anything; forcing it onto the same envelope would just add
an always-`page: 1`, always-`has_prev: false` `pagination` object with
no real paging behavior behind it.

### Get Asset Price

```
GET /api/v1/prices/:asset_code?issuer=<issuer_address>

```

**Response:**

```json
{
  "asset_code": "XLM",
  "issuer": null,
  "price_usd": 0.1234,
  "source": "stellar_dex",
  "fetched_at": "2024-01-15T10:30:00.000Z",
  "is_stale": false,
  "stale_warning": null,
  "sources_attempted": ["stellar_dex", "coingecko"]
}

```

### Force Price Refresh

```
GET /api/v1/prices/:asset_code/refresh?issuer=<issuer_address>

```

Requires `Authorization: Bearer <api_key>`.

### API Keys

Protected endpoints use `Authorization: Bearer <api_key>`. Set `ADMIN_API_KEY` to a 32-byte hex token for bootstrap access, then create scoped API keys with the key-management endpoints.

The bootstrap admin key is compared using constant-time checks over fixed-length SHA-256 digests so invalid guesses cannot short-circuit on matching prefixes or raw string length.

```
GET /api/v1/keys
POST /api/v1/keys
DELETE /api/v1/keys/:id

```

`POST /api/v1/keys` returns the raw `api_key` only once. Stored keys are hashed with SHA-256 and listed with metadata only (`label`, `created_at`, `last_used_at`, `scopes`, `tier`, and `key_prefix`).

#### Per-key rate limit tiers

Every authenticated request is metered in a bucket keyed by the API key itself, not by IP, so one abusive key can no longer consume the capacity of every other key behind the same address. Each key carries a `tier` that sizes its bucket:

| Tier | Default limit | Environment variable |
|------|---------------|----------------------|
| `free` | 100 requests / minute | `API_KEY_RATELIMIT_FREE_MAX` |
| `pro` | 1000 requests / minute | `API_KEY_RATELIMIT_PRO_MAX` |
| `admin` | 10000 requests / minute | `API_KEY_RATELIMIT_ADMIN_MAX` |

The window is set by `API_KEY_RATELIMIT_WINDOW_SECONDS` (default 60). Pass `tier` when creating a key; omit it and the key gets `free`. Keys created before tiers existed also resolve to `free` rather than being locked out.

Every metered response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Tier`. Exceeding the limit returns `429` with a `Retry-After` header. As with the per-IP limiter, a Redis outage fails open — a cache problem must not lock every consumer out of the platform.

### Webhook Endpoints

```
POST   /api/v1/webhooks
GET    /api/v1/webhooks
DELETE /api/v1/webhooks/:id
POST   /api/v1/webhooks/:id/test
GET    /api/v1/webhooks/:id/deliveries

```

### Health Check

```
GET /health
```

Returns the overall health of the service and its dependencies.

**Response fields:**

| Field | Description |
|-------|-------------|
| `status` | Overall health: `ok`, `degraded`, or `unhealthy` |
| `timestamp` | ISO-8601 time of the response |
| `redis.connected` | `true` when the Redis client is connected |
| `jobs.price_refresh` | Health of the background price-refresh cron job |
| `jobs.webhook_retry_worker` | Health of the webhook retry worker |
| `database` | Reports `configured: true, checked: false, status: "unused"` — no active DB health probe |
| `price_source_circuits` | Per-source circuit-breaker state (open/closed) |

**Health states:**

| State | Meaning |
|-------|---------|
| `ok` | Redis connected; all jobs running normally |
| `degraded` | A job has not yet completed its first tick (startup grace period) |
| `unhealthy` | Redis is disconnected, or a job has stalled past its grace period |

**Job health fields** (`jobs.price_refresh` / `jobs.webhook_retry_worker`):

| Field | Description |
|-------|-------------|
| `healthy` | `true` while the job is running within its expected interval |
| `last_success_at` | ISO-8601 timestamp of the last successful tick, or `null` |
| `last_error` | Error message from the last failed tick, or `null` |
| `stalled` | `true` when no successful tick has occurred within 2× the job interval |

**Additional `jobs.webhook_retry_worker` fields** — queue depth, so operators can see retries backing up rather than only that the worker is alive:

| Field | Description |
|-------|-------------|
| `pending_retries` | Deliveries currently queued for retry. `null` means Redis could not be read, which is not the same as an empty queue |
| `last_batch_size` | Number of retries claimed on the most recent tick |
| `avg_delivery_latency_ms` | Mean time per retry attempt since process start, or `null` before the first attempt |
| `total_retries_processed` | Retry attempts made since process start |

**Example response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "redis": { "connected": true },
  "jobs": {
    "price_refresh": {
      "healthy": true,
      "last_success_at": "2024-01-15T10:29:55.000Z",
      "last_error": null,
      "stalled": false
    },
    "webhook_retry_worker": {
      "healthy": true,
      "last_success_at": "2024-01-15T10:29:58.000Z",
      "last_error": null,
      "stalled": false,
      "pending_retries": 4,
      "last_batch_size": 2,
      "avg_delivery_latency_ms": 12.5,
      "total_retries_processed": 91
    }
  },
  "database": { "configured": true, "checked": false, "status": "unused" },
  "price_source_circuits": [
    { "source": "coingecko", "open": false, "openUntil": null },
    { "source": "coinmarketcap", "open": false, "openUntil": null }
  ]
}
```

### Indexed Airdrop Data

```
GET /api/v1/airdrops/:id/status
GET /api/v1/airdrops/:id/onchain-recipients
GET /api/v1/recipients/:address/claims
GET /api/v1/indexer/status
```
---

## Usage Examples

### Fetch XLM Price

```bash
curl http://localhost:4000/api/v1/prices/XLM

```

### Fetch Custom Asset Price

```bash
curl "http://localhost:4000/api/v1/prices/USDC?issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA"

```

### Force Price Refresh

```bash
curl http://localhost:4000/api/v1/prices/XLM/refresh \
  -H "Authorization: Bearer $API_KEY"

```

### Create API Key

```bash
curl -X POST http://localhost:4000/api/v1/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"alerts worker","scopes":["alerts"]}'

```

### Check Service Health

```bash
curl http://localhost:4000/health

```


## Webhooks

Register endpoints that receive HTTP POST callbacks when SmartDrop indexes contract lifecycle events or price alerts.

### Supported event types

| Event | Description | Wired up? |
|-------|-------------|-----------|
| `pool.created` | A new farming pool was created on-chain | No — registered event type, no dispatch path yet |
| `pool.assets_locked` | Assets were locked into a pool | No — registered event type, no dispatch path yet |
| `pool.assets_unlocked` | Assets were unlocked from a pool | No — registered event type, no dispatch path yet |
| `pool.rewards_distributed` | Pool distributed rewards to participants | No — registered event type, no dispatch path yet |
| `pool.closed` | Pool was closed | No — registered event type, no dispatch path yet |
| `airdrop.created` | A new airdrop was created | No — registered event type, no dispatch path yet |
| `airdrop.executing` | An airdrop began execution | No — registered event type, no dispatch path yet |
| `airdrop.completed` | An airdrop completed successfully | No — registered event type, no dispatch path yet |
| `airdrop.failed` | An airdrop has failed or expired | **Yes** — dispatched by `airdropExpiry.js` on expiry |
| `recipient.claimed` | A recipient claimed an airdrop | No — registered event type, no dispatch path yet |
| `price.alert` | Existing price-alert event | **Yes** — dispatched by `alertsService` |
| `*` | Wildcard — subscribe to every known event | Only matches events with an active dispatch path |

> **Note:** `airdrop.created`, `airdrop.executing`, `airdrop.completed`, and
> `recipient.claimed` are defined as valid event types in `webhookEvents.js` but
> have no active dispatch path yet — only `airdrop.failed` is dispatched today.
> Support for the remaining airdrop lifecycle events will be added as a separate
> feature on top of the live webhook dispatcher.

### API

#### Register a webhook
```
POST /api/v1/webhooks
Content-Type: application/json

{
  "url": "https://example.com/webhooks/smartdrop",
  "events": ["pool.assets_locked", "pool.rewards_distributed"],
  "filters": { "pool_id": "pool_123" },   // optional
  "secret": "whsec_at_least_16_chars",     // optional, generated if omitted
  "description": "Production webhook"       // optional
}
```

The response includes the secret in plaintext **exactly once**. Subsequent reads only return `secret_preview`.
Wildcard subscriptions are supported as `["*"]`, but explicit event lists are capped at 25 known events.

#### Manage webhooks
```
GET    /api/v1/webhooks               # list
GET    /api/v1/webhooks/:id           # fetch one
PATCH  /api/v1/webhooks/:id           # update url / events / filters / active / description
DELETE /api/v1/webhooks/:id           # remove
```

#### Test endpoint
```
POST /api/v1/webhooks/:id/test
```
Sends a synthetic `pool.assets_locked` payload to the registered URL and returns the resulting delivery summary. Limited to 5 calls/min/IP by default.

> **SSRF protection.** Webhook targets are validated against private/internal
> network ranges (RFC-1918, loopback, link-local, IPv6 ULA/link-local, CGNAT,
> etc.) both when registered **and** again at delivery time — and the outbound
> connection is pinned to the validated public IP, with redirects disabled — so
> a `test` call (or any real dispatch) cannot be used as an internal-network
> reconnaissance oracle. A blocked target is refused up front with a `422
> WEBHOOK_TARGET_BLOCKED` error and is never delivered.
>
> **Reduced error detail.** The `last_error` field returned by the test endpoint
> is a coarse category (`unreachable` | `error_response` | `delivery_failed`),
> not the raw low-level network error string (e.g. `ECONNREFUSED`). The raw
> detail is still written to server-side logs for operators; only the public
> response is sanitized, to avoid turning the test endpoint into an information
> leak about internal reachability. See issue #96.

#### Inspect deliveries (admin dashboard feed)
```
GET /api/v1/webhooks/:id/deliveries?limit=50
GET /api/v1/webhooks/:id/deliveries?limit=50&status=failed
```
Returns the most recent delivery records: `status` (`success | pending | failed`), `attempts`, `response_status`, `last_error`, `next_retry_at`, and `trace_id`. Use `status=failed` to inspect dead-lettered deliveries.

### Outgoing request shape

Every delivery is a JSON POST with the following headers:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `User-Agent` | `SmartDrop-Webhooks/1.0` |
| `X-SmartDrop-Event` | event type (e.g. `pool.assets_locked`) |
| `X-SmartDrop-Delivery` | unique delivery id (`dlv_…`) |
| `X-SmartDrop-Signature` | `sha256=<hex hmac of the raw body>` |

Body:
```json
{
  "event": "pool.assets_locked",
  "event_id": "evt_…",
  "occurred_at": "2026-06-25T12:00:00.000Z",
  "data": { "...": "event-specific fields" }
}
```

### Verifying the signature (Node.js)

```js
const crypto = require('crypto');

function verifySmartDrop(req, secret) {
  const provided = req.header('X-SmartDrop-Signature') || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)        // verify against the RAW body, not re-stringified JSON
    .digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Express tip: capture the raw body via `express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } })` so the HMAC matches byte-for-byte.

### Retry & failure semantics

- Up to `WEBHOOK_MAX_ATTEMPTS` (default 3) total attempts per event.
- Retries are scheduled in Redis and processed by a background worker, so retries survive process restarts.
- Backoff is exponential with "equal jitter": `deterministic = base * factor^(attempts-1)`, then the actual delay is randomized within `[deterministic/2, deterministic)` (default deterministic values 30s → 60s → 120s, so e.g. attempt 1's actual delay lands somewhere in 15s–30s). This prevents deliveries that fail at the same attempt count around the same moment (e.g. every in-flight delivery to a subscriber whose endpoint just went down) from computing identical `nextRetryAt` values and arriving back at that endpoint in a synchronized burst.
- **Retryable**: network errors, HTTP 5xx, 408, 429.
- **Not retried**: HTTP 4xx (except 408/429). These are marked `failed` immediately so a misconfigured consumer cannot be retried into the ground.
- Each delivery is logged in `webhook_deliveries` (Redis-backed today, drop-in PG migration documented in `src/repositories/deliveryRepository.js`).
- **Safe for multiple replicas**: `webhookRetryWorker` claims due retries via `deliveryRepository.popDueRetries`, which uses a single atomic Redis Lua script (`ZRANGEBYSCORE` + `ZREM` in one round trip) rather than two separate calls. Running N instances of this backend against the same Redis is safe - each due retry is claimed by exactly one instance, so a delivery is never dispatched twice for the same retry. The worker's in-process `running` flag only guards against a single process overlapping with itself; cross-replica safety comes from the atomic claim, not from that flag.

### Storage model

The current implementation stores webhooks and delivery logs in Redis behind a repository abstraction. The repository files document the equivalent PostgreSQL schema verbatim — migrating to PG is a matter of swapping the repository implementation only; no caller code changes.

### Rate limiting

- Management endpoints under `/api/v1/webhooks`: 60 req/min/IP (configurable).
- `/test` endpoint: 5 req/min/IP (configurable) — prevents using SmartDrop as an outbound HTTP cannon.
- The limiter fails **open** if Redis is unreachable so a cache outage does not lock you out of management calls.

---


## Error Handling

The API returns appropriate HTTP status codes:

* `200` - Success
* `400` - Invalid request parameters
* `404` - Price not available
* `500` - Internal server error

**Error Response Format:**

```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "request_id": "req_…"
}
```

### `X-Request-ID` correlation header

Every response carries an `X-Request-ID` header, and every JSON response body
(and every error body) includes a `request_id` field, so you can correlate a
client request with the server's logs.

`X-Request-ID` is an **optional client hint**, not an authoritative or
guaranteed-unique identifier. A client may supply its own value via the
`X-Request-ID` request header to tie its own logs to SmartDrop's; if the value
is missing, malformed (contains characters outside `[A-Za-z0-9_-]`), or longer
than 128 characters, the server **ignores it and generates a fresh ID instead**.
Treat the returned `request_id` purely as a correlation aid — multiple unrelated
requests can share a client-chosen value, so it must not be used as a security
or uniqueness anchor. See issue #133.

---

## Development

### Project Structure

```
src/
├── index.js              # Express server entry point
├── config.js             # Configuration management
├── logger.js             # Winston logger setup
├── routes/
│   └── prices.js         # Price API endpoints
├── services/
│   ├── cache.js          # Redis cache wrapper
│   ├── priceOracle.js    # Core oracle aggregation logic
│   └── sources/
│       ├── stellarDex.js    # Stellar DEX price source
│       ├── coingecko.js     # CoinGecko API source
│       └── coinmarketcap.js # CoinMarketCap API source
└── jobs/
    └── priceRefresh.js   # Background price refresh job

```

### Adding New Price Sources

To add a new price source:

1. Create a new file in `src/services/sources/`
2. Implement a `fetchPrice(assetCode, issuer)` function that returns a price or `null`
3. Add the source to the `SOURCES` array in `src/services/priceOracle.js`

Example:

```javascript
// src/services/sources/customSource.js
const axios = require('axios');
const logger = require('../../logger');

async function fetchPrice(assetCode, issuer) {
  try {
    const response = await axios.get('[https://api.example.com/price](https://api.example.com/price)', {
      params: { asset: assetCode }
    });
    return response.data.price;
  } catch (err) {
    logger.warn('Custom source fetch failed', { assetCode, error: err.message });
    return null;
  }
}

module.exports = { fetchPrice };

```

---

## Troubleshooting

### Redis Connection Issues

If you see "Redis connection error" in logs:

* Verify containers are running: `docker compose ps`
* Check Redis logs: `docker compose logs redis`
* Ensure environmental parameters (`REDIS_HOST=redis`) reference the compose network alias rather than `localhost`.
- Verify Redis is running: `redis-cli ping`
- Check `REDIS_URL` in `.env`
- If Redis requires a password, include it in the connection URL

### Price Not Available

If prices return `null`:

* Check that at least one price source is configured
* Verify API keys for CoinGecko/CoinMarketCap if using those sources
* Check logs for specific source errors
* Stellar DEX may have no liquidity for the asset

### Rate Limiting

External APIs may rate limit requests:

* CoinGecko: Free tier has rate limits
* CoinMarketCap: Requires API key for production use
* The service handles rate limits gracefully and falls back to other sources

---

## Monitoring

The service logs important events:

* Price fetches from each source
* Price anomalies (>10% changes)
* Stale price warnings
* Cache refresh cycles
* API errors
- Price fetches from each source
- Price anomalies (>20% changes)
- Stale price warnings
- Cache refresh cycles
- API errors

Monitor logs for:

* Frequent source failures
* Price anomalies (may indicate market volatility or data issues)
* Stale prices (may indicate cache or source issues)

## License

MIT
