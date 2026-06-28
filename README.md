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

### Webhook Delivery System

Registers subscriber endpoints for SmartDrop lifecycle events and delivers signed JSON payloads with retry tracking.

**Events:**
- `airdrop.created`
- `airdrop.executing`
- `airdrop.completed`
- `airdrop.failed`
- `recipient.claimed`

**Features:**
- Webhook endpoint CRUD with secrets kept out of list responses
- Timestamped HMAC-SHA256 request signatures
- At-least-once delivery attempts with exponential backoff
- Delivery logs with response code, error, duration, and attempt count
- Dead-letter storage after retry exhaustion

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
| `ADMIN_API_KEY` | Bootstrap admin bearer token for API key management | empty | Yes, for protected endpoints |
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

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}

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
