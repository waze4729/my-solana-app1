import express from "express";
import bodyParser from "body-parser";
import * as web3 from "@solana/web3.js";
import fetch from "node-fetch";

const { Connection, PublicKey } = web3;
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const JUPITER_API_URL_V3 = "https://lite-api.jup.ag/price/v3?ids=";
const JUPITER_API_URL_V2 = "https://lite-api.jup.ag/price/v2?ids=";
const JUPITER_TOKENINFO_URL = "https://lite-api.jup.ag/tokens/v1/";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const JUPITER_BATCH_SIZE = 100; // Increased batch size for Jupiter API
const MAX_TOP_HOLDERS = 20;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 1200;
const TOKEN_META_CACHE_TTL_MIN = 180;
const TOKEN_META_CACHE_TTL_MAX = 320;
const SPL_SCAN_INTERVAL = 6000;

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());
app.use(express.static("public"));

const storage = {
  tokenMint: "",
  registry: {},
  initialTop50: null,
  initialTop50Amounts: new Map(),
  previousTop50: new Set(),
  previousTop50MinAmount: 0,
  allTimeNewTop50: new Set(),
  scanning: false,
  latestData: null,
  pollInterval: null,
  splHoldingsInterval: null,
  startTime: null,
  prices: {
    SOL: 0,
    JUP: 0,
    lastUpdated: null
  },
  topHoldersCache: {},
  walletTokenCache: {},
  tokenMetaCache: {},
  topHolderAddresses: [],
};

function getRandomTTL() {
  return TOKEN_META_CACHE_TTL_MIN + Math.floor(Math.random() * (TOKEN_META_CACHE_TTL_MAX - TOKEN_META_CACHE_TTL_MIN));
}

async function fetchTokenMetasBatch(mints) {
  const now = Date.now();
  const mintsToFetch = [];
  const results = {};
  
  // Check cache first
  for (const mint of mints) {
    const cached = storage.tokenMetaCache[mint];
    if (cached && now - cached.updatedAt < cached.ttl * 1000) {
      results[mint] = cached;
    } else {
      mintsToFetch.push(mint);
    }
  }
  
  // Fetch remaining mints in batches
  if (mintsToFetch.length > 0) {
    try {
      const response = await fetch(JUPITER_TOKENINFO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mints: mintsToFetch })
      });
      
      if (response.ok) {
        const data = await response.json();
        
        for (const mint of mintsToFetch) {
          const tokenData = data[mint] || {};
          const meta = { 
            name: tokenData.name || "Unknown", 
            symbol: tokenData.symbol || "", 
            logoURI: tokenData.logoURI || null, 
            updatedAt: now, 
            ttl: getRandomTTL() 
          };
          
          storage.tokenMetaCache[mint] = meta;
          results[mint] = meta;
        }
      } else {
        // If batch request fails, fall back to individual requests
        for (const mint of mintsToFetch) {
          try {
            const resp = await fetch(JUPITER_TOKENINFO_URL + mint);
            if (resp.ok) {
              const data = await resp.json();
              const meta = { 
                name: data.name || "Unknown", 
                symbol: data.symbol || "", 
                logoURI: data.logoURI || null, 
                updatedAt: now, 
                ttl: getRandomTTL() 
              };
              storage.tokenMetaCache[mint] = meta;
              results[mint] = meta;
            } else {
              // Create default entry if fetch fails
              const meta = { name: "Unknown", symbol: "", logoURI: null, updatedAt: now, ttl: getRandomTTL() };
              storage.tokenMetaCache[mint] = meta;
              results[mint] = meta;
            }
          } catch (err) {
            const meta = { name: "Unknown", symbol: "", logoURI: null, updatedAt: now, ttl: getRandomTTL() };
            storage.tokenMetaCache[mint] = meta;
            results[mint] = meta;
          }
          await sleep(50); // Small delay between individual requests
        }
      }
    } catch (err) {
      // If batch request fails entirely, fall back to individual requests
      for (const mint of mintsToFetch) {
        try {
          const resp = await fetch(JUPITER_TOKENINFO_URL + mint);
          if (resp.ok) {
            const data = await resp.json();
            const meta = { 
              name: data.name || "Unknown", 
              symbol: data.symbol || "", 
              logoURI: data.logoURI || null, 
              updatedAt: now, 
              ttl: getRandomTTL() 
            };
            storage.tokenMetaCache[mint] = meta;
            results[mint] = meta;
          } else {
            // Create default entry if fetch fails
            const meta = { name: "Unknown", symbol: "", logoURI: null, updatedAt: now, ttl: getRandomTTL() };
            storage.tokenMetaCache[mint] = meta;
            results[mint] = meta;
          }
        } catch (err) {
          const meta = { name: "Unknown", symbol: "", logoURI: null, updatedAt: now, ttl: getRandomTTL() };
          storage.tokenMetaCache[mint] = meta;
          results[mint] = meta;
        }
        await sleep(50); // Small delay between individual requests
      }
    }
  }
  
  return results;
}

function getSecondsSinceStart() {
  if (!storage.startTime) return 0;
  const now = new Date();
  return Math.floor((now - storage.startTime) / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logError(...args) {
  console.error("==> [ERROR]", ...args);
}

function logInfo(...args) {
  console.log("==>", ...args);
}

async function fetchJupiterPricesBatched(mints, maxBatchSize = JUPITER_BATCH_SIZE) {
  let prices = {};
  
  // Try V3 API first
  for (let i = 0; i < mints.length; i += maxBatchSize) {
    const batch = mints.slice(i, i + maxBatchSize);
    let tries = 0;
    let success = false;
    
    while (tries < MAX_RETRIES && !success) {
      try {
        const url = JUPITER_API_URL_V3 + batch.join(",");
        const response = await fetch(url);
        
        if (!response.ok) {
          // If rate limited or error, try V2 API
          if (response.status === 429) {
            logInfo(`Rate limited on V3, trying V2 for batch`);
            return await fetchJupiterPricesV2(mints, maxBatchSize);
          }
          
          const body = await response.text();
          logError(`Jupiter V3 API HTTP ${response.status} for batch:`, batch, "Body:", body);
          break;
        }
        
        let priceData;
        try {
          priceData = await response.json();
        } catch (err) {
          logError(`Invalid JSON from Jupiter V3 for batch:`, batch, err.message);
          break;
        }
        
        // Process V3 response format
        if (priceData.data) {
          Object.keys(priceData.data).forEach(mint => {
            prices[mint] = {
              usdPrice: priceData.data[mint].price,
              price: priceData.data[mint].price
            };
          });
        }
        
        success = true;
      } catch (err) {
        logError(`Jupiter V3 fetch error for batch:`, batch, err.message || err);
        tries++;
        await sleep(RETRY_BASE_DELAY * tries);
      }
    }
    
    await sleep(100);
  }
  
  return prices;
}

async function fetchJupiterPricesV2(mints, maxBatchSize = JUPITER_BATCH_SIZE) {
  let prices = {};
  
  for (let i = 0; i < mints.length; i += maxBatchSize) {
    const batch = mints.slice(i, i + maxBatchSize);
    let tries = 0;
    let success = false;
    
    while (tries < MAX_RETRIES && !success) {
      try {
        const url = JUPITER_API_URL_V2 + batch.join(",");
        const response = await fetch(url);
        
        if (!response.ok) {
          const body = await response.text();
          if (response.status === 429 || body.includes("Rate limit")) {
            logError(`[JUPITER RATE LIMIT] HTTP 429 or rate-limit on batch:`, batch, `Skip updating SPL tokens for now`);
            break;
          }
          logError(`Jupiter V2 API HTTP ${response.status} for batch:`, batch, "Body:", body);
          break;
        }
        
        let priceData;
        try {
          priceData = await response.json();
        } catch (err) {
          logError(`Invalid JSON from Jupiter V2 for batch:`, batch, err.message);
          break;
        }
        
        // Process V2 response format
        if (priceData.data) {
          Object.keys(priceData.data).forEach(mint => {
            prices[mint] = {
              usdPrice: priceData.data[mint].price,
              price: priceData.data[mint].price
            };
          });
        }
        
        success = true;
      } catch (err) {
        logError(`Jupiter V2 fetch error for batch:`, batch, err.message || err);
        tries++;
        await sleep(RETRY_BASE_DELAY * tries);
      }
    }
    
    await sleep(100);
  }
  
  return prices;
}

async function fetchPrices() {
  if (!storage.tokenMint) return;
  try {
    const MINTS = [
      storage.tokenMint,
      SOL_MINT,
      JUP_MINT
    ].filter(Boolean);
    
    const prices = await fetchJupiterPricesBatched(MINTS, JUPITER_BATCH_SIZE);
    
    Object.keys(prices).forEach(mint => {
      storage.prices[mint] = parseFloat(prices[mint]?.usdPrice || 0);
    });
    
    storage.prices.lastUpdated = new Date();
  } catch (error) {
    logError("fetchPrices:", error.message || error);
  }
}

function calculateUSDValue(amount, tokenMint) {
  const price = storage.prices[tokenMint];
  if (price && amount) return amount * price;
  return 0;
}

async function fetchAllTokenAccounts(mintAddress) {
  const mintPublicKey = new PublicKey(mintAddress);
  try {
    const accounts = await connection.getParsedProgramAccounts(
      new PublicKey(TOKEN_PROGRAM_ID),
      {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: mintPublicKey.toBase58() } }
        ]
      }
    );
    
    return accounts.map((acc) => {
      const parsed = acc.account.data.parsed;
      const amount = Number(parsed.info.tokenAmount.amount) / Math.pow(10, parsed.info.tokenAmount.decimals);
      return {
        address: acc.pubkey.toBase58(),
        owner: parsed.info.owner,
        amount: amount,
        usdValue: calculateUSDValue(amount, mintAddress)
      };
    }).filter(a => a.amount > 0);
  } catch (e) {
    logError("fetchAllTokenAccounts:", e.message || e);
    return [];
  }
}

function makeStepBuckets() {
  const buckets = {};
  for (let pct = 10; pct <= 100; pct += 10) {
    buckets[`bought${pct}`] = 0;
    buckets[`sold${pct}`] = 0;
  }
  buckets.sold100 = 0;
  buckets.unchanged = 0;
  buckets.current = 0;
  buckets.total = 0;
  return buckets;
}

function analyze(registry, fresh) {
  const now = Date.now();
  const freshMap = new Map(fresh.map(h => [h.owner, h.amount]));
  const changes = makeStepBuckets();
  
  for (const [owner, info] of Object.entries(registry)) {
    const freshAmount = freshMap.get(owner);
    if (freshAmount !== undefined) {
      info.current = freshAmount;
      info.lastSeen = now;
      const changePct = ((freshAmount - info.baseline) / info.baseline) * 100;
      let matched = false;
      
      if (Math.abs(changePct) < 10) changes.unchanged++;
      else if (changePct > 0) {
        for (let pct = 100; pct >= 10; pct -= 10) {
          if (changePct >= pct) { changes[`bought${pct}`]++; matched = true; break; }
        }
        if (!matched) changes.unchanged++;
      } else {
        for (let pct = 100; pct >= 10; pct -= 10) {
          if (changePct <= -pct) { changes[`sold${pct}`]++; matched = true; break; }
        }
        if (!matched) changes.unchanged++;
      }
      changes.current++;
    } else {
      if (info.baseline > 0 && info.current !== 0) info.current = 0;
      if (info.baseline > 0 && info.current === 0) changes.sold100++;
    }
    changes.total++;
  }
  
  for (const { owner, amount } of fresh) {
    if (!registry[owner]) {
      registry[owner] = { baseline: amount, current: amount, lastSeen: now };
      changes.total++;
      changes.current++;
      changes.unchanged++;
    }
  }
  
  return changes;
}

async function analyzeTop50(fresh, initialTop50, initialTop50Amounts, previousTop50, previousTop50MinAmount) {
  if (!initialTop50 || initialTop50.length === 0) return null;
  
  const sorted = fresh.slice().sort((a, b) => b.amount - a.amount);
  const currentTop50 = sorted.slice(0, 50).map(h => h.owner);
  const currentTop50Map = new Map(sorted.slice(0, 50).map(h => [h.owner, h.amount]));
  const currentTop50MinAmount = sorted[49]?.amount || 0;
  
  const newSinceLastFetch = currentTop50.filter(owner =>
    !previousTop50.has(owner) &&
    (currentTop50Map.get(owner) > previousTop50MinAmount)
  );
  
  const newSinceFirstFetch = currentTop50.filter(owner =>
    storage.allTimeNewTop50.has(owner)
  ).length;
  
  newSinceLastFetch.forEach(owner => {
    storage.allTimeNewTop50.add(owner);
  });
  
  const stillInTop50 = initialTop50.filter(owner => currentTop50.includes(owner));
  const goneFromInitialTop50 = initialTop50.filter(owner => !currentTop50.includes(owner));
  const newInTop50 = currentTop50.filter(owner => !initialTop50.includes(owner));
  
  const top50Sales = { sold100: 0, sold50: 0, sold25: 0, };
  const top50Buys = { bought100: 0, bought50: 0, bought25: 0, bought10: 0, };
  
  for (const owner of initialTop50) {
    const initialAmount = initialTop50Amounts.get(owner);
    const currentAmount = currentTop50Map.get(owner) || 0;
    
    if (currentAmount === 0) {
      top50Sales.sold100++;
    } else {
      const changePct = ((currentAmount - initialAmount) / initialAmount) * 100;
      if (changePct <= -50) {
        top50Sales.sold50++;
      } else if (changePct <= -25) {
        top50Sales.sold25++;
      } else if (changePct >= 100) {
        top50Buys.bought100++;
      } else if (changePct >= 50) {
        top50Buys.bought50++;
      } else if (changePct >= 25) {
        top50Buys.bought25++;
      } else if (changePct >= 10) {
        top50Buys.bought10++;
      }
    }
  }
  
  storage.previousTop50 = new Set(currentTop50);
  storage.previousTop50MinAmount = currentTop50MinAmount;
  
  return {
    currentTop50Count: currentTop50.length,
    stillInTop50Count: stillInTop50.length,
    goneFromInitialTop50Count: goneFromInitialTop50.length,
    newInTop50Count: newInTop50.length,
    completelyNewSinceLastFetch: newSinceLastFetch.length,
    completelyNewSinceFirstFetch: newSinceFirstFetch,
    top50Sales,
    top50Buys,
  };
}

async function fetchHolderValuableTokens(owner) {
  const now = Date.now();
  if (!storage.walletTokenCache[owner]) storage.walletTokenCache[owner] = {};
  const cache = storage.walletTokenCache[owner];
  const validTokens = [];
  
  for (const [mint, entry] of Object.entries(cache)) {
    if (now - entry.updatedAt < entry.ttl * 1000) {
      validTokens.push(...entry.valuableTokens);
    }
  }
  
  return validTokens.sort((a, b) => b.usdValue - a.usdValue);
}

async function updateAllHoldersValuableTokens(owners) {
  if (!owners || owners.length === 0) return;
  
  // Get all tokens from all holders
  const allTokens = [];
  const ownerTokenMap = new Map();
  
  for (const owner of owners) {
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(owner),
        { programId: new PublicKey(TOKEN_PROGRAM_ID) }
      );
      
      const tokens = tokenAccounts.value.map(acc => {
        const parsed = acc.account.data.parsed;
        const info = parsed.info;
        const mint = info.mint;
        const decimals = info.tokenAmount.decimals;
        const amount = Number(info.tokenAmount.amount) / Math.pow(10, decimals);
        return { owner, mint, amount };
      }).filter(t => t.amount > 0);
      
      allTokens.push(...tokens);
      
      // Initialize owner token map
      if (!ownerTokenMap.has(owner)) {
        ownerTokenMap.set(owner, []);
      }
      ownerTokenMap.get(owner).push(...tokens);
    } catch (e) {
      logError(`Error fetching tokens for owner ${owner}:`, e.message);
    }
    
    // Add a small delay to avoid rate limiting
    await sleep(50);
  }
  
  // Get all unique mints
  const uniqueMints = [...new Set(allTokens.map(t => t.mint))];
  
  // Batch fetch prices and metadata
  let prices = {};
  let tokenMetas = {};
  
  if (uniqueMints.length > 0) {
    prices = await fetchJupiterPricesBatched(uniqueMints, JUPITER_BATCH_SIZE);
    tokenMetas = await fetchTokenMetasBatch(uniqueMints);
  }
  
  const now = Date.now();
  
  // Update cache for each owner
  for (const [owner, tokens] of ownerTokenMap.entries()) {
    if (!storage.walletTokenCache[owner]) storage.walletTokenCache[owner] = {};
    const cache = storage.walletTokenCache[owner];
    
    for (const token of tokens) {
      const price = prices[token.mint]?.usdPrice;
      if (!price) continue;
      
      const meta = tokenMetas[token.mint] || { name: "Unknown", symbol: "", logoURI: null };
      const usdValue = token.amount * price;
      
      if (usdValue > 500) {
        cache[token.mint] = {
          valuableTokens: [{
            name: meta.name,
            symbol: meta.symbol,
            logoURI: meta.logoURI,
            usdValue,
          }],
          updatedAt: now,
          ttl: getRandomTTL()
        };
      }
    }
  }
}

async function pollData() {
  if (!storage.tokenMint || !storage.scanning) return;
  
  try {
    const fresh = await fetchAllTokenAccounts(storage.tokenMint);
    
    if (!storage.initialTop50) {
      const sorted = fresh.slice().sort((a, b) => b.amount - a.amount);
      storage.initialTop50 = sorted.slice(0, 50).map(h => h.owner);
      sorted.slice(0, 50).forEach(h => storage.initialTop50Amounts.set(h.owner, h.amount));
      storage.previousTop50 = new Set(storage.initialTop50);
      storage.previousTop50MinAmount = sorted[49]?.amount || 0;
    }
    
    const changes = analyze(storage.registry, fresh);
    const top50Stats = await analyzeTop50(
      fresh,
      storage.initialTop50,
      storage.initialTop50Amounts,
      storage.previousTop50,
      storage.previousTop50MinAmount
    );
    
    const topHoldersRaw = [...fresh].sort((a, b) => b.amount - a.amount).slice(0, MAX_TOP_HOLDERS);
    storage.topHolderAddresses = topHoldersRaw.map(h => h.owner);
    
    const nowCache = {};
    const topHolders = [];
    
    for (const holder of topHoldersRaw) {
      let cached = storage.topHoldersCache[holder.owner];
      let valuableTokens;
      
      if (cached && cached.amount === holder.amount) {
        valuableTokens = cached.valuableTokens;
      } else {
        valuableTokens = await fetchHolderValuableTokens(holder.owner);
      }
      
      const holderData = { ...holder, valuableTokens };
      topHolders.push(holderData);
      nowCache[holder.owner] = holderData;
    }
    
    storage.topHoldersCache = nowCache;
    
    storage.latestData = {
      fresh,
      registry: storage.registry,
      changes,
      top50Stats,
      top50Count: storage.initialTop50.length,
      timeRunning: getSecondsSinceStart(),
      startTime: storage.startTime,
      prices: storage.prices,
      tokenMint: storage.tokenMint,
      topHolders
    };
  } catch (error) {
    logError("pollData error:", error.message || error);
  }
}

async function pollTopHolderSplTokens() {
  if (!storage.tokenMint || !storage.scanning || !storage.topHolderAddresses.length) return;
  
  // Batch update all holders' tokens at once
  await updateAllHoldersValuableTokens(storage.topHolderAddresses);
}

app.post("/api/start", async (req, res) => {
  const { mint } = req.body;
  if (!mint) return res.status(400).send("Missing token mint");
  
  storage.tokenMint = mint;
  storage.registry = {};
  storage.initialTop50 = null;
  storage.initialTop50Amounts = new Map();
  storage.previousTop50 = new Set();
  storage.previousTop50MinAmount = 0;
  storage.allTimeNewTop50 = new Set();
  storage.scanning = true;
  storage.startTime = new Date();
  storage.topHoldersCache = {};
  storage.topHolderAddresses = [];
  
  if (storage.pollInterval) clearInterval(storage.pollInterval);
  if (storage.splHoldingsInterval) clearInterval(storage.splHoldingsInterval);
  
  await fetchPrices();
  storage.pollInterval = setInterval(pollData, 1000);
  setInterval(fetchPrices, 30000);
  pollData();
  
  storage.splHoldingsInterval = setInterval(pollTopHolderSplTokens, SPL_SCAN_INTERVAL);
  
  res.send("Scan started - polling every 1 second");
});

app.post("/api/stop", (req, res) => {
  storage.scanning = false;
  
  if (storage.pollInterval) {
    clearInterval(storage.pollInterval);
    storage.pollInterval = null;
  }
  
  if (storage.splHoldingsInterval) {
    clearInterval(storage.splHoldingsInterval);
    storage.splHoldingsInterval = null;
  }
  
  res.send("Scan stopped");
});

app.get("/api/status", (req, res) => {
  if (!storage.latestData) {
    return res.json({
      message: "No data yet",
      prices: storage.prices,
      tokenMint: storage.tokenMint
    });
  }
  
  storage.latestData.tokenMint = storage.tokenMint;
  storage.latestData.currentTokenPrice = storage.prices[storage.tokenMint] || 0;
  storage.latestData.solPrice = storage.prices[SOL_MINT] || 0;
  storage.latestData.jupPrice = storage.prices[JUP_MINT] || 0;
  
  res.json(storage.latestData);
});

app.listen(PORT, () => {
  logInfo(`Server running on port ${PORT}`);
});
