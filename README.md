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
- Price anomaly logging (>10% changes)
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

## Setup

### Prerequisites

- Node.js >= 20.9.0
- Redis server (local or remote)

### Installation

```bash
npm install
```

### Redis Setup

**macOS (Homebrew):**
```bash
brew install redis
brew services start redis
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

**Docker:**
```bash
docker run -d -p 6379:6379 redis:alpine
```

**Verify Redis is running:**
```bash
redis-cli ping
# Should return: PONG
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

**Environment Variables:**

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 3000 | No |
| `REDIS_HOST` | Redis server host | localhost | No |
| `REDIS_PORT` | Redis server port | 6379 | No |
| `REDIS_PASSWORD` | Redis password | undefined | No |
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

### Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

The server will start on the configured port (default: 3000) and automatically begin the background price refresh job.

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

Protected endpoints use `Authorization: Bearer <api_key>`. Set `ADMIN_API_KEY`
to a 32-byte hex token for bootstrap access, then create scoped API keys with
the key-management endpoints.

```
GET /api/v1/keys
POST /api/v1/keys
DELETE /api/v1/keys/:id
```

`POST /api/v1/keys` returns the raw `api_key` only once. Stored keys are hashed
with SHA-256 and listed with metadata only (`label`, `created_at`,
`last_used_at`, `scopes`, and `key_prefix`).

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

## Usage Examples

### Fetch XLM Price
```bash
curl http://localhost:3000/api/v1/prices/XLM
```

### Fetch Custom Asset Price
```bash
curl "http://localhost:3000/api/v1/prices/USDC?issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA"
```

### Force Price Refresh
```bash
curl http://localhost:3000/api/v1/prices/XLM/refresh \
  -H "Authorization: Bearer $API_KEY"
```

### Create API Key
```bash
curl -X POST http://localhost:3000/api/v1/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"alerts worker","scopes":["alerts"]}'
```

### Check Service Health
```bash
curl http://localhost:3000/health
```

## Error Handling

The API returns appropriate HTTP status codes:

- `200` - Success
- `400` - Invalid request parameters
- `404` - Price not available
- `500` - Internal server error

**Error Response Format:**
```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

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
    // Fetch price from your source
    const response = await axios.get('https://api.example.com/price', {
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

## Troubleshooting

### Redis Connection Issues

If you see "Redis connection error" in logs:
- Verify Redis is running: `redis-cli ping`
- Check Redis host and port in `.env`
- If using a password, ensure `REDIS_PASSWORD` is set correctly

### Price Not Available

If prices return `null`:
- Check that at least one price source is configured
- Verify API keys for CoinGecko/CoinMarketCap if using those sources
- Check logs for specific source errors
- Stellar DEX may have no liquidity for the asset

### Rate Limiting

External APIs may rate limit requests:
- CoinGecko: Free tier has rate limits
- CoinMarketCap: Requires API key for production use
- The service handles rate limits gracefully and falls back to other sources

## Monitoring

The service logs important events:
- Price fetches from each source
- Price anomalies (>10% changes)
- Stale price warnings
- Cache refresh cycles
- API errors

Monitor logs for:
- Frequent source failures
- Price anomalies (may indicate market volatility or data issues)
- Stale prices (may indicate cache or source issues)

## License

MIT
