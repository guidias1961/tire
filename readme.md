# TIRE - Token Information Real-time Engine

A production-grade web application for tracking PulseChain tokens in near real-time. TIRE aggregates on-chain data from the PulseX subgraph, enriches it with Dexscreener prices/liquidity, and provides a fast, mobile-first frontend.

## Architecture

### Backend (Cloudflare Worker)
- **Primary Data**: PulseX Subgraph GraphQL API for comprehensive on-chain data
- **Secondary Data**: Dexscreener API for USD pricing and liquidity enrichment
- **Caching**: In-memory LRU cache with 30s TTL
- **Performance**: Concurrent processing, exponential backoff, graceful error handling

### Frontend (Single HTML File)
- **Design**: Dark theme, mobile-first responsive design
- **Features**: Real-time updates, search, filtering, sorting
- **Performance**: Auto-refresh, localStorage state persistence, zero console errors

## Data Sources

### Verified Endpoints Used
- **PulseX Subgraph**: `https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex/graphql`
- **Dexscreener API**: `https://api.dexscreener.com/tokens/v1/pulsechain/{addresses}` (max 30 addresses per batch)

### Data Flow
1. **Subgraph Query**: Fetch pairs by volume/liquidity/age with pagination
2. **Token Aggregation**: Group pairs by base token, calculate weighted averages
3. **Dexscreener Enrichment**: Batch enrich with USD prices and liquidity data
4. **Response**: Clean, normalized token data with source attribution

## API Endpoints

### `GET /api/health`
Health check endpoint.

**Response:**
```json
{
  "ok": true,
  "ts": 1691234567,
  "cache_size": 3
}
```

### `GET /api/tokens`
Main token data endpoint.

**Query Parameters:**
- `view` (string): `volume` | `liquidity` | `new` (default: `volume`)
- `pages` (number): Number of subgraph pages to fetch, 1-20 (default: `10`)
- `ageDays` (number): For `new` view, filter tokens newer than X days (default: `30`)
- `limit` (number): Maximum tokens to return, max 1000 (default: `500`)

**Response:**
```json
{
  "source": "MIX|SUBGRAPH|DS",
  "coverage": 1500,
  "tokens": [
    {
      "address": "0x...",
      "symbol": "TOKEN",
      "name": "Token Name",
      "price": 0.0123,
      "priceChange24h": 3.21,
      "volume24h": 12345.67,
      "liquidity": 89012.34,
      "pairCreatedAt": 1712345678000,
      "poolCount": 3,
      "url": "https://dexscreener.com/pulsechain/0x...",
      "pairAddress": "0x...",
      "source": "MIX"
    }
  ]
}
```

## Setup & Deployment

### Prerequisites
- Node.js 18+ 
- Cloudflare account
- Wrangler CLI installed globally

### Local Development

1. **Clone and setup:**
```bash
git clone <repository>
cd tire
npm install
```

2. **Start the worker:**
```bash
npm run dev
```

3. **Open frontend:**
- Open `index.html` in your browser
- Update the `API_BASE` constant to `http://localhost:8787` for local development

### Production Deployment

1. **Deploy the worker:**
```bash
npm run deploy
```

2. **Update frontend configuration:**
- Edit `index.html` and change `API_BASE` to your deployed worker URL
- Example: `https://tire-api.your-subdomain.workers.dev`

3. **Host the frontend:**

#### Option A: Cloudflare Pages
```bash
# Upload index.html to Cloudflare Pages dashboard
# Or connect your Git repository
```

#### Option B: GitHub Pages
```bash
# Push index.html to a GitHub repository
# Enable GitHub Pages in repository settings
```

#### Option C: Any Static Host
- Upload `index.html` to any static hosting provider
- No build step required

## Configuration

### Worker Configuration (wrangler.toml)
- `compatibility_date`: Set to current date
- `compatibility_flags`: nodejs_compat for better Node.js compatibility

### Performance Tuning
Key constants in `src/index.ts`:
- `CACHE_TTL`: Cache duration in milliseconds (default: 30s)
- `DEXSCREENER_BATCH_SIZE`: Addresses per Dexscreener request (default: 30)
- `CONCURRENCY_LIMIT`: Max concurrent Dexscreener requests (default: 4)

### Frontend Configuration
Constants in `index.html`:
- `API_BASE`: Your deployed worker URL
- `REFRESH_INTERVAL`: Auto-refresh interval in ms (default: 30s)
- `SEARCH_DEBOUNCE`: Search input debounce in ms (default: 200ms)

## Features

### Three Main Views
1. **Top Volume 24h**: Tokens sorted by 24h trading volume
2. **Top Liquidity**: Tokens sorted by total liquidity across pools
3. **New Tokens**: Recently created tokens (last 30 days)

### Frontend Features