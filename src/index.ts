/**
 * TIRE - Token Information Real-time Engine
 * Cloudflare Worker for PulseChain token tracking
 * 
 * Data Sources:
 * - Primary: PulseX Subgraph (https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex/graphql)
 * - Secondary: Dexscreener API (https://api.dexscreener.com/tokens/v1/pulsechain/{addresses})
 */

export interface Env {
  // Add KV namespace here if needed later
}

interface TokenRow {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  pairCreatedAt: number;
  poolCount: number;
  url: string;
  pairAddress: string;
  source: 'MIX' | 'SUBGRAPH_ONLY' | 'DS_ONLY';
}

interface ApiResponse {
  source: 'MIX' | 'SUBGRAPH' | 'DS';
  coverage: number;
  tokens: TokenRow[];
}

interface PairData {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  reserve0: string;
  reserve1: string;
  reserveUSD: string;
  volumeUSD: string;
  txCount: string;
  createdAtTimestamp: string;
  totalSupply: string;
}

interface TokenAggregation {
  address: string;
  symbol: string;
  name: string;
  totalLiquidity: number;
  totalVolume: number;
  weightedPrice: number;
  totalWeight: number;
  earliestCreated: number;
  poolCount: number;
  bestPool: {
    address: string;
    liquidity: number;
  };
  pools: Array<{
    address: string;
    liquidity: number;
    volume: number;
    created: number;
  }>;
}

interface DexscreenerTokenData {
  address: string;
  name: string;
  symbol: string;
  priceUsd: string;
  priceChange24h: number;
  liquidity?: {
    usd: number;
  };
  volume?: {
    24h: number;
  };
}

// Simple in-memory cache
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds

// GraphQL endpoints and queries
const PULSEX_SUBGRAPH_URL = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex/graphql';
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/tokens/v1/pulsechain';

const PAIRS_BY_VOLUME_QUERY = `
  query GetPairsByVolume($first: Int!, $skip: Int!) {
    pairs(
      first: $first,
      skip: $skip,
      orderBy: volumeUSD,
      orderDirection: desc,
      where: { volumeUSD_gt: "0" }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
      reserve0
      reserve1
      reserveUSD
      volumeUSD
      txCount
      createdAtTimestamp
      totalSupply
    }
  }
`;

const PAIRS_BY_LIQUIDITY_QUERY = `
  query GetPairsByLiquidity($first: Int!, $skip: Int!) {
    pairs(
      first: $first,
      skip: $skip,
      orderBy: reserveUSD,
      orderDirection: desc,
      where: { reserveUSD_gt: "0" }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
      reserve0
      reserve1
      reserveUSD
      volumeUSD
      txCount
      createdAtTimestamp
      totalSupply
    }
  }
`;

const NEW_PAIRS_QUERY = `
  query GetNewPairs($first: Int!, $skip: Int!, $timestamp: Int!) {
    pairs(
      first: $first,
      skip: $skip,
      orderBy: createdAtTimestamp,
      orderDirection: desc,
      where: { createdAtTimestamp_gte: $timestamp }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
      reserve0
      reserve1
      reserveUSD
      volumeUSD
      txCount
      createdAtTimestamp
      totalSupply
    }
  }
`;

async function fetchGraphQL(query: string, variables: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(PULSEX_SUBGRAPH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.errors) {
        throw new Error(`GraphQL Error: ${JSON.stringify(result.errors)}`);
      }

      return result.data;
    } catch (error) {
      console.error(`GraphQL fetch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, 250 * Math.pow(3, i)));
    }
  }
}

async function fetchAllPairs(queryType: 'volume' | 'liquidity' | 'new', pages: number, ageDays?: number): Promise<PairData[]> {
  const allPairs: PairData[] = [];
  const pageSize = 1000; // Max allowed by The Graph
  
  let query: string;
  let baseVariables: any = {};
  
  switch (queryType) {
    case 'volume':
      query = PAIRS_BY_VOLUME_QUERY;
      break;
    case 'liquidity':
      query = PAIRS_BY_LIQUIDITY_QUERY;
      break;
    case 'new':
      query = NEW_PAIRS_QUERY;
      const cutoffTimestamp = Math.floor(Date.now() / 1000) - (ageDays || 30) * 24 * 60 * 60;
      baseVariables.timestamp = cutoffTimestamp;
      break;
  }

  for (let page = 0; page < pages; page++) {
    const variables = {
      ...baseVariables,
      first: pageSize,
      skip: page * pageSize,
    };

    try {
      const data = await fetchGraphQL(query, variables);
      const pairs = data.pairs || [];
      
      if (pairs.length === 0) break; // No more data
      
      allPairs.push(...pairs);
      
      if (pairs.length < pageSize) break; // Last page
    } catch (error) {
      console.error(`Failed to fetch page ${page}:`, error);
      break;
    }
  }

  return allPairs;
}

function aggregateByToken(pairs: PairData[]): Map<string, TokenAggregation> {
  const tokenMap = new Map<string, TokenAggregation>();

  for (const pair of pairs) {
    const reserveUSD = parseFloat(pair.reserveUSD || '0');
    const volumeUSD = parseFloat(pair.volumeUSD || '0');
    const createdAt = parseInt(pair.createdAtTimestamp) * 1000;

    if (reserveUSD <= 0 && volumeUSD <= 0) continue;

    // Determine base token (use token with higher liquidity value)
    const reserve0USD = reserveUSD * 0.5; // Approximate split
    const reserve1USD = reserveUSD * 0.5;
    
    const tokens = [
      {
        address: pair.token0.id,
        symbol: pair.token0.symbol,
        name: pair.token0.name,
        reserveUSD: reserve0USD,
      },
      {
        address: pair.token1.id,
        symbol: pair.token1.symbol,
        name: pair.token1.name,
        reserveUSD: reserve1USD,
      }
    ];

    // Process both tokens in the pair
    for (const token of tokens) {
      if (!token.address || token.symbol === 'WETH' || token.symbol === 'WPLS') continue;

      const existing = tokenMap.get(token.address) || {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        totalLiquidity: 0,
        totalVolume: 0,
        weightedPrice: 0,
        totalWeight: 0,
        earliestCreated: createdAt,
        poolCount: 0,
        bestPool: { address: pair.id, liquidity: 0 },
        pools: [],
      };

      existing.totalLiquidity += token.reserveUSD;
      existing.totalVolume += volumeUSD / 2; // Split volume between tokens
      existing.earliestCreated = Math.min(existing.earliestCreated, createdAt);
      existing.poolCount += 1;

      if (token.reserveUSD > existing.bestPool.liquidity) {
        existing.bestPool = {
          address: pair.id,
          liquidity: token.reserveUSD,
        };
      }

      existing.pools.push({
        address: pair.id,
        liquidity: token.reserveUSD,
        volume: volumeUSD / 2,
        created: createdAt,
      });

      tokenMap.set(token.address, existing);
    }
  }

  return tokenMap;
}

async function enrichWithDexscreener(tokens: TokenRow[]): Promise<TokenRow[]> {
  const BATCH_SIZE = 30; // Dexscreener limit
  const CONCURRENCY_LIMIT = 4;
  
  const batches: string[][] = [];
  const addresses = tokens.map(t => t.address);
  
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    batches.push(addresses.slice(i, i + BATCH_SIZE));
  }

  const enrichedData = new Map<string, DexscreenerTokenData>();
  
  // Process batches with concurrency control
  const semaphore = new Array(CONCURRENCY_LIMIT).fill(0);
  
  await Promise.all(batches.map(async (batch, batchIndex) => {
    // Wait for semaphore
    while (semaphore.filter(s => s === 0).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    const semIndex = semaphore.findIndex(s => s === 0);
    semaphore[semIndex] = 1;
    
    try {
      const addressString = batch.join(',');
      const url = `${DEXSCREENER_BASE_URL}/${addressString}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'TIRE/1.0',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.pairs && Array.isArray(data.pairs)) {
          for (const pair of data.pairs) {
            if (pair.baseToken && pair.baseToken.address) {
              enrichedData.set(pair.baseToken.address.toLowerCase(), {
                address: pair.baseToken.address,
                name: pair.baseToken.name || '',
                symbol: pair.baseToken.symbol || '',
                priceUsd: pair.priceUsd || '0',
                priceChange24h: pair.priceChange?.h24 || 0,
                liquidity: pair.liquidity,
                volume: pair.volume,
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(`Dexscreener batch ${batchIndex} failed:`, error);
    } finally {
      semaphore[semIndex] = 0;
    }
  }));

  // Apply enrichments
  return tokens.map(token => {
    const dsData = enrichedData.get(token.address.toLowerCase());
    if (!dsData) return { ...token, source: 'SUBGRAPH_ONLY' as const };

    const price = parseFloat(dsData.priceUsd) || token.price;
    const liquidity = dsData.liquidity?.usd || token.liquidity;
    const volume24h = dsData.volume?.['24h'] || token.volume24h;
    
    return {
      ...token,
      price,
      priceChange24h: dsData.priceChange24h || 0,
      volume24h,
      liquidity,
      source: 'MIX' as const,
    };
  });
}

function tokenAggregationToTokenRow(agg: TokenAggregation): TokenRow {
  const price = agg.totalWeight > 0 ? agg.weightedPrice / agg.totalWeight : 0;
  
  return {
    address: agg.address,
    symbol: agg.symbol || 'Unknown',
    name: agg.name || 'Unknown Token',
    price: isNaN(price) ? 0 : price,
    priceChange24h: 0, // Will be filled by Dexscreener
    volume24h: isNaN(agg.totalVolume) ? 0 : agg.totalVolume,
    liquidity: isNaN(agg.totalLiquidity) ? 0 : agg.totalLiquidity,
    pairCreatedAt: agg.earliestCreated,
    poolCount: agg.poolCount,
    url: `https://dexscreener.com/pulsechain/${agg.bestPool.address}`,
    pairAddress: agg.bestPool.address,
    source: 'SUBGRAPH_ONLY',
  };
}

function getCacheKey(view: string, pages: number, ageDays: number, limit: number): string {
  return `tokens_${view}_${pages}_${ageDays}_${limit}`;
}

function getFromCache(key: string): any | null {
  const cached = cache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, timestamp: Date.now() });
}

async function handleTokensRequest(
  view: string,
  pages: number,
  ageDays: number,
  limit: number
): Promise<ApiResponse> {
  const cacheKey = getCacheKey(view, pages, ageDays, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  console.log(`Fetching ${view} tokens, pages: ${pages}, ageDays: ${ageDays}, limit: ${limit}`);

  let pairs: PairData[] = [];
  let queryType: 'volume' | 'liquidity' | 'new';

  switch (view) {
    case 'volume':
      queryType = 'volume';
      break;
    case 'liquidity':
      queryType = 'liquidity';
      break;
    case 'new':
      queryType = 'new';
      break;
    default:
      queryType = 'volume';
  }

  pairs = await fetchAllPairs(queryType, pages, ageDays);
  
  if (pairs.length === 0) {
    const emptyResponse: ApiResponse = {
      source: 'SUBGRAPH',
      coverage: 0,
      tokens: [],
    };
    setCache(cacheKey, emptyResponse);
    return emptyResponse;
  }

  console.log(`Fetched ${pairs.length} pairs from subgraph`);

  // Aggregate by token
  const tokenMap = aggregateByToken(pairs);
  let tokens = Array.from(tokenMap.values())
    .map(tokenAggregationToTokenRow)
    .slice(0, limit);

  // Sort according to view
  if (view === 'volume') {
    tokens.sort((a, b) => b.volume24h - a.volume24h);
  } else if (view === 'liquidity') {
    tokens.sort((a, b) => b.liquidity - a.liquidity);
  } else if (view === 'new') {
    tokens.sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);
  }

  console.log(`Aggregated to ${tokens.length} tokens, enriching with Dexscreener...`);

  // Enrich with Dexscreener
  try {
    tokens = await enrichWithDexscreener(tokens);
    console.log(`Enrichment completed`);
  } catch (error) {
    console.error('Dexscreener enrichment failed:', error);
  }

  const response: ApiResponse = {
    source: 'MIX',
    coverage: pairs.length,
    tokens,
  };

  setCache(cacheKey, response);
  return response;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=30',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        headers: corsHeaders(),
        status: 200,
      });
    }

    try {
      // Health check
      if (url.pathname === '/api/health') {
        return new Response(JSON.stringify({ 
          ok: true, 
          ts: Math.floor(Date.now() / 1000),
          cache_size: cache.size,
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(),
          },
        });
      }

      // Tokens API
      if (url.pathname === '/api/tokens') {
        const view = url.searchParams.get('view') || 'volume';
        const pages = Math.min(parseInt(url.searchParams.get('pages') || '10'), 20);
        const ageDays = Math.max(1, parseInt(url.searchParams.get('ageDays') || '30'));
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 1000);

        if (!['volume', 'liquidity', 'new'].includes(view)) {
          return new Response(JSON.stringify({ 
            error: 'Invalid view', 
            message: 'View must be one of: volume, liquidity, new' 
          }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders(),
            },
          });
        }

        const result = await handleTokensRequest(view, pages, ageDays, limit);
        
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(),
          },
        });
      }

      return new Response('Not Found', { 
        status: 404,
        headers: corsHeaders(),
      });

    } catch (error) {
      console.error('Request failed:', error);
      
      return new Response(JSON.stringify({ 
        error: 'Internal Server Error', 
        message: error instanceof Error ? error.message : 'Unknown error' 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(),
        },
      });
    }
  },
};