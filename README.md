# SmartDrop backend

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

## Setup

### Prerequisites

- Node.js >= 20.9.0
- Redis server

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:
- `REDIS_HOST` - Redis server host (default: localhost)
- `COINMARKETCAP_API_KEY` - API key for CoinMarketCap (optional)

### Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

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

### Health Check

```
GET /health
```

## Architecture

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

## License

MIT
