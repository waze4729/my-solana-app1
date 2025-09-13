import express from "express";
import bodyParser from "body-parser";
import * as web3 from "@solana/web3.js";
import fetch from "node-fetch";

const { Connection, PublicKey } = web3;
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const JUPITER_API_URL_V3 = "https://lite-api.jup.ag/price/v3?ids=";
const JUPITER_TOKENINFO_URL = "https://lite-api.jup.ag/tokens/v1/";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const JUPITER_BATCH_SIZE = 100;
const MAX_TOP_HOLDERS = 20;

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const app = express();
const PORT = process.env.PORT || 10000;
const HELIUS_API_KEY = "07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const HELIUS_POOL = "GhMtn6GQbyUHijhiLitGdSxR1FBTQ5XhXuYJUP15pWJn";
const HELIUS_TXS_URL = `https://api.helius.xyz/v0/addresses/${HELIUS_POOL}/transactions?api-key=${HELIUS_API_KEY}`;
app.use(bodyParser.json());
app.use(express.static("public"));
app.get("/api/pool-volume", async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 24 * 3600;
    let allTxs = [];
    let before = undefined;
    let keepGoing = true;
    let tries = 0;

    // Fetch up to 1000 recent txs (for demo, can optimize/paginate as needed)
    while (keepGoing && tries < 5) {
      let url = HELIUS_TXS_URL + "&limit=100" + (before ? `&before=${before}` : "");
      const resp = await fetch(url);
      if (!resp.ok) break;
      const txs = await resp.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      allTxs = allTxs.concat(txs);
      before = txs[txs.length - 1]?.signature;
      if (
        new Date(txs[txs.length - 1].timestamp * 1000).getTime() < since * 1000 ||
        txs.length < 100
      ) {
        keepGoing = false;
      }
      tries++;
    }
    // Only keep txs in the last 24h
    allTxs = allTxs.filter((tx) => tx.timestamp >= since);

    // Parse all swap instructions and sum USD value (if any)
    let usdVolume = 0;
    for (const tx of allTxs) {
      if (!tx?.events?.swap) continue;
      // Helius Enhanced API: swap event has .nativeInput and .nativeOutput
      // We'll use .nativeInput.amount or .nativeOutput.amount and .nativeInput.mint/USD value if available
      let usd = 0;
      if (tx.events.swap.nativeInput?.usd) usd = tx.events.swap.nativeInput.usd;
      else if (tx.events.swap.nativeOutput?.usd) usd = tx.events.swap.nativeOutput.usd;
      usdVolume += usd;
    }
    res.json({ pool: HELIUS_POOL, volume24h: usdVolume });
  } catch (e) {
    logError("pool-volume:", e.message || e);
    res.status(500).json({ error: "Failed to fetch pool volume" });
  }
});


const storage = {
  tokenMint: "",
  tokenName: "",
  tokenSymbol: "",
  registry: {},
  initialTop50: null,
  initialTop50Amounts: new Map(),
  previousTop50: new Set(),
  previousTop50MinAmount: 0,
  allTimeNewTop50: new Set(),
  goneFromTop50History: [],
  newTop50History: [],
  scanning: false,
  latestData: null,
  pollInterval: null,
  startTime: null,
  prices: {
    [SOL_MINT]: 0,
    [JUP_MINT]: 0,
    lastUpdated: null
  }
};

function logError(...args) {
  console.error("==> [ERROR]", ...args);
}
function logInfo(...args) {
  console.log("==>", ...args);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTokenMeta(mint) {
  try {
    const res = await fetch(JUPITER_TOKENINFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [mint] })
    });
    if (!res.ok) return {};
    const data = await res.json();
    if (data && data[mint]) {
      return { name: data[mint].name, symbol: data[mint].symbol };
    }
    return {};
  } catch (e) {
    return {};
  }
}

async function fetchJupiterPricesV3(mints, maxBatchSize = JUPITER_BATCH_SIZE) {
  let prices = {};
  for (let i = 0; i < mints.length; i += maxBatchSize) {
    const batch = mints.slice(i, i + maxBatchSize);
    let tries = 0;
    let success = false;
    while (tries < 2 && !success) {
      try {
        const url = JUPITER_API_URL_V3 + batch.join(",");
        const response = await fetch(url);
        if (!response.ok) {
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
        for (const mint of batch) {
          if (priceData[mint] && typeof priceData[mint].usdPrice === "number") {
            prices[mint] = {
              usdPrice: priceData[mint].usdPrice
            };
          } else {
            prices[mint] = { usdPrice: 0 };
          }
        }
        success = true;
      } catch (err) {
        logError(`Jupiter V3 fetch error for batch:`, batch, err.message || err);
        tries++;
        await sleep(1200 * tries);
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

    const prices = await fetchJupiterPricesV3(MINTS, JUPITER_BATCH_SIZE);

    storage.prices[storage.tokenMint] = parseFloat(prices[storage.tokenMint]?.usdPrice || 0);
    storage.prices[SOL_MINT] = parseFloat(prices[SOL_MINT]?.usdPrice || 0);
    storage.prices[JUP_MINT] = parseFloat(prices[JUP_MINT]?.usdPrice || 0);

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

  const goneFromInitialTop50 = initialTop50.filter(owner => !currentTop50.includes(owner));
  const newInTop50 = currentTop50.filter(owner => !initialTop50.includes(owner));

  // Update notification histories for frontend
  if (goneFromInitialTop50.length > 0)
    storage.goneFromTop50History.push({ ts: Date.now(), count: goneFromInitialTop50.length });
  if (newInTop50.length > 0)
    storage.newTop50History.push({ ts: Date.now(), count: newInTop50.length });

  const stillInTop50 = initialTop50.filter(owner => currentTop50.includes(owner));
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
    goneFromInitialTop50,
    newInTop50,
    top50Sales,
    top50Buys,
  };
}

function getSecondsSinceStart() {
  if (!storage.startTime) return 0;
  const now = new Date();
  return Math.floor((now - storage.startTime) / 1000);
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

    storage.latestData = {
      fresh,
      registry: storage.registry,
      changes,
      top50Stats,
      top50Count: storage.initialTop50.length,
      timeRunning: getSecondsSinceStart(),
      startTime: storage.startTime,
      prices: { ...storage.prices },
      tokenMint: storage.tokenMint,
      tokenName: storage.tokenName,
      tokenSymbol: storage.tokenSymbol,
      goneFromTop50History: storage.goneFromTop50History,
      newTop50History: storage.newTop50History,
      topHolders: topHoldersRaw
    };
  } catch (error) {
    logError("pollData error:", error.message || error);
  }
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
  storage.goneFromTop50History = [];
  storage.newTop50History = [];
  storage.scanning = true;
  storage.startTime = new Date();

  // Fetch token meta for name/symbol display
  const meta = await fetchTokenMeta(mint);
  storage.tokenName = meta.name || "Token";
  storage.tokenSymbol = meta.symbol || "";

  if (storage.pollInterval) clearInterval(storage.pollInterval);

  await fetchPrices();
  storage.pollInterval = setInterval(pollData, 1000);
  setInterval(fetchPrices, 30000);
  pollData();

  res.send("Scan started - polling every 1 second");
});

app.post("/api/stop", (req, res) => {
  storage.scanning = false;

  if (storage.pollInterval) {
    clearInterval(storage.pollInterval);
    storage.pollInterval = null;
  }

  res.send("Scan stopped");
});

app.get("/api/status", (req, res) => {
  if (!storage.latestData) {
    return res.json({
      message: "No data yet",
      prices: { ...storage.prices },
      tokenMint: storage.tokenMint,
      tokenName: storage.tokenName,
      tokenSymbol: storage.tokenSymbol,
    });
  }

  storage.latestData.tokenMint = storage.tokenMint;
  storage.latestData.tokenName = storage.tokenName;
  storage.latestData.tokenSymbol = storage.tokenSymbol;
  storage.latestData.currentTokenPrice = storage.prices[storage.tokenMint] || 0;
  storage.latestData.solPrice = storage.prices[SOL_MINT] || 0;
  storage.latestData.jupPrice = storage.prices[JUP_MINT] || 0;

  storage.latestData.prices = {
    ...storage.prices,
    [storage.tokenMint]: storage.prices[storage.tokenMint] || 0,
    [SOL_MINT]: storage.prices[SOL_MINT] || 0,
    [JUP_MINT]: storage.prices[JUP_MINT] || 0,
    lastUpdated: storage.prices.lastUpdated
  };

  res.json(storage.latestData);
});

app.listen(PORT, () => {
  logInfo(`Server running on port ${PORT}`);
});

