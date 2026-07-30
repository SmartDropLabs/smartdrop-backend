# SmartDrop backend

[![CI](https://github.com/SmartDropLabs/smartdrop-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SmartDropLabs/smartdrop-backend/actions/workflows/ci.yml)

HTTP APIs, webhooks, and **indexing** for SmartDrop. This repository contains Node.js services that talk to **Horizon**, **Soroban RPC**, and external APIs.

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
- `airdrop.created`
- `airdrop.executing`
- `airdrop.completed`
- `airdrop.failed` — fired automatically when an airdrop expires (see below), in addition to any other failure path
- `recipient.claimed`

**Features:**
- Webhook endpoint CRUD with secrets kept out of list responses
- Timestamped HMAC-SHA256 request signatures
- At-least-once delivery attempts with exponential backoff
- Delivery logs with response code, error, duration, and attempt count
- Dead-letter storage after retry exhaustion

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

### Quick Start With Docker

Run the local API, Redis, and Postgres stack with Docker Compose:

```bash
docker compose up --build
```

The API listens on port `4000` in the compose environment:

```bash
curl http://localhost:4000/health
```

The compose stack mounts `./src` into the API container and runs
`npm run dev`, so source changes restart the Node process automatically. Redis
and Postgres include health checks, and `docker-compose.override.yml` is ignored
for local-only secrets or service tweaks.

To remove containers and the local Postgres volume:

```bash
docker compose down -v
```

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
| `ADMIN_API_KEY` | Bootstrap admin bearer token for API key management | empty | Yes, for protected endpoints |
| `AIRDROP_CSV_MAX_BYTES` | Maximum recipient CSV upload size in bytes | 5242880 (5 MiB) | No |
| `AIRDROP_JSON_MAX_BYTES` | Maximum JSON request body size; 2 MiB accommodates 10,000 inline recipients | 2097152 (2 MiB) | No |
| `AIRDROP_RATELIMIT_WINDOW` | Per-IP airdrop mutation rate-limit window in seconds | 60 | No |
| `AIRDROP_RATELIMIT_MAX` | Maximum create or recipient-add requests per window and IP | 10 | No |
| `INSTANCE_ID` | Explicit instance identity for leader election; auto-generated from hostname+UUID if empty | auto | No |
| `LEASE_TTL_MS` | Leader lease TTL in milliseconds — how long a lease is valid without renewal | 15000 | No |
| `LEASE_RENEW_INTERVAL_MS` | How often the leader renews its lease (and followers check to acquire) | 5000 | No |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, or `error` | info | No |


---

## API Endpoints

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

`POST /api/v1/keys` returns the raw `api_key` only once. Stored keys are hashed with SHA-256 and listed with metadata only (`label`, `created_at`, `last_used_at`, `scopes`, and `key_prefix`).

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
      "stalled": false
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
GET /api/v1/airdrops/:id/recipients
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

Register endpoints that receive HTTP POST callbacks when SmartDrop indexes farming/pool events.

### Supported event types

| Event | Description |
|-------|-------------|
| `pool.created` | A new farming pool was created on-chain |
| `pool.assets_locked` | Assets were locked into a pool |
| `pool.assets_unlocked` | Assets were unlocked from a pool |
| `pool.rewards_distributed` | Pool distributed rewards to participants |
| `pool.closed` | Pool was closed |
| `price.alert` | Existing price-alert event |
| `*` | Wildcard — subscribe to every known event |

### API

#### Register a webhook
```
POST /api/v1/webhooks
Content-Type: application/json

{
  "url": "https://example.com/webhooks/smartdrop",
  "events": ["pool.assets_locked", "pool.rewards_distributed"],
  "secret": "whsec_at_least_16_chars",     // optional, generated if omitted
  "description": "Production webhook"       // optional
}
```

The response includes the secret in plaintext **exactly once**. Subsequent reads only return `secret_preview`.

#### Manage webhooks
```
GET    /api/v1/webhooks               # list
GET    /api/v1/webhooks/:id           # fetch one
PATCH  /api/v1/webhooks/:id           # update url / events / active / description
DELETE /api/v1/webhooks/:id           # remove
```

#### Test endpoint
```
POST /api/v1/webhooks/:id/test
```
Sends a synthetic `pool.assets_locked` payload to the registered URL and returns the resulting delivery summary. Limited to 5 calls/min/IP by default.

#### Inspect deliveries (admin dashboard feed)
```
GET /api/v1/webhooks/:id/deliveries?limit=50
```
Returns the most recent delivery records: `status` (`success | pending | failed`), `attempts`, `response_status`, `last_error`, `next_retry_at`.

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
- Backoff is exponential: `base * factor^(attempts-1)` (default 30s → 60s → 120s).
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
  "message": "Detailed error message"
}

```

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
