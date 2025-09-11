import express from "express";
import bodyParser from "body-parser";
import * as web3 from "@solana/web3.js";
import fetch from "node-fetch";
import http from "http";
import { Server as SocketIO } from "socket.io";
import crypto from "crypto";
import session from "express-session";

const { Connection, PublicKey } = web3;
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const JUPITER_API_URL = "https://lite-api.jup.ag/price/v3?ids=";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const JUPITER_BATCH_SIZE = 49;
const MAX_TOP_HOLDERS = 50;
const SPL_SCAN_INTERVAL = 6000;

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 10000;

// --- SESSION SETUP ---
const sessionMiddleware = session({
  secret: "solana-token-scan-" + crypto.randomBytes(16).toString("hex"),
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 2 * 3600 * 1000 } // 2h
});
app.use(sessionMiddleware);

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// --- STATIC FILES ---
app.use(express.static("public"));
app.use(bodyParser.json());

// --- IN-MEMORY USER STATE ---
const userStates = {}; // userId: { watchedTokens, scanningMint, ... }

// --- HELPERS ---
function getUserId(req) {
  if (req.session.userId) return req.session.userId;
  const id = crypto.randomBytes(12).toString("hex");
  req.session.userId = id;
  return id;
}
function getUserState(userId) {
  if (!userStates[userId]) {
    userStates[userId] = {
      watchedTokens: [
        { mint: SOL_MINT, added: Date.now() },
        { mint: JUP_MINT, added: Date.now() }
      ],
      scanningMint: SOL_MINT,
      registry: {},
      initialTop50: null,
      initialTop50Amounts: new Map(),
      previousTop50: new Set(),
      previousTop50MinAmount: 0,
      allTimeNewTop50: new Set(),
      scanning: false,
      latestData: null,
      pollInterval: null,
      startTime: null
    };
  }
  return userStates[userId];
}
function addWatchedToken(user, mint) {
  // Remove expired and deduplicate
  const now = Date.now();
  user.watchedTokens = user.watchedTokens.filter(
    t => now - t.added < 24 * 3600 * 1000
  );
  if (!user.watchedTokens.some(t => t.mint === mint)) {
    user.watchedTokens.push({ mint, added: now });
  }
}
function formatPrice(x) {
  if (!x && x !== 0) return "0.000000";
  return Number(x).toFixed(6);
}

// --- JUPITER PRICE CACHE ---
const globalPriceCache = {
  prices: {},
  lastUpdated: 0
};
async function fetchJupiterPrices(mints) {
  if (mints.length === 0) return {};
  let prices = {};
  for (let i = 0; i < mints.length; i += JUPITER_BATCH_SIZE) {
    const batch = mints.slice(i, i + JUPITER_BATCH_SIZE);
    try {
      const resp = await fetch(JUPITER_API_URL + batch.join(","));
      if (!resp.ok) continue;
      const json = await resp.json();
      for (const [mint, data] of Object.entries(json)) {
        prices[mint] = parseFloat(data?.usdPrice || 0);
      }
    } catch { }
  }
  return prices;
}
async function updateGlobalPriceCache(uniqueMints) {
  const prices = await fetchJupiterPrices(uniqueMints);
  globalPriceCache.prices = { ...globalPriceCache.prices, ...prices };
  globalPriceCache.lastUpdated = Date.now();
}
setInterval(() => {
  // Update price cache for all user watched tokens
  const allMints = new Set();
  Object.values(userStates).forEach(u => u.watchedTokens.forEach(t => allMints.add(t.mint)));
  updateGlobalPriceCache(Array.from(allMints));
}, 10000);

// --- API ROUTES ---
app.post("/api/start", async (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  const { mint } = req.body;
  if (!mint) return res.status(400).send("Missing token mint");
  user.scanningMint = mint;
  user.registry = {};
  user.initialTop50 = null;
  user.initialTop50Amounts = new Map();
  user.previousTop50 = new Set();
  user.previousTop50MinAmount = 0;
  user.allTimeNewTop50 = new Set();
  user.scanning = true;
  user.startTime = new Date();
  if (user.pollInterval) clearInterval(user.pollInterval);
  user.pollInterval = setInterval(() => pollDataForUser(userId), 1000);
  addWatchedToken(user, mint);
  pollDataForUser(userId);
  res.send("Scan started - polling every 1 second");
});

app.post("/api/stop", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  user.scanning = false;
  if (user.pollInterval) {
    clearInterval(user.pollInterval);
    user.pollInterval = null;
  }
  res.send("Scan stopped");
});

app.get("/api/status", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  let watched = user.watchedTokens.map(t => t.mint);
  let prices = {};
  watched.forEach(mint => { prices[mint] = globalPriceCache.prices[mint] || 0; });
  prices.lastUpdated = globalPriceCache.lastUpdated ? new Date(globalPriceCache.lastUpdated) : null;
  if (!user.latestData) {
    return res.json({
      message: "No data yet",
      prices,
      tokenMint: user.scanningMint,
      watchedTokens: watched
    });
  }
  user.latestData.tokenMint = user.scanningMint;
  user.latestData.prices = prices;
  user.latestData.watchedTokens = watched;
  res.json(user.latestData);
});

// --- SOCKET.IO ---
io.on("connection", socket => {
  const req = socket.request;
  const userId = getUserId(req);
  const user = getUserState(userId);

  // Send initial price and status
  socket.emit("watchedTokens", user.watchedTokens.map(t => t.mint));
  socket.emit("priceUpdate", getSocketPrices(user));
  sendStatusUpdate(socket, user);

  socket.on("watchToken", async mint => {
    addWatchedToken(user, mint);
    await updateGlobalPriceCache(user.watchedTokens.map(t => t.mint));
    io.to(socket.id).emit("watchedTokens", user.watchedTokens.map(t => t.mint));
    io.to(socket.id).emit("priceUpdate", getSocketPrices(user));
  });
  socket.on("startScan", mint => {
    user.scanningMint = mint;
    user.scanning = true;
    user.startTime = new Date();
    addWatchedToken(user, mint);
    if (user.pollInterval) clearInterval(user.pollInterval);
    user.pollInterval = setInterval(() => pollDataForUser(userId), 1000);
    pollDataForUser(userId);
    io.to(socket.id).emit("watchedTokens", user.watchedTokens.map(t => t.mint));
    sendStatusUpdate(socket, user);
  });
  socket.on("stopScan", () => {
    user.scanning = false;
    if (user.pollInterval) clearInterval(user.pollInterval);
    sendStatusUpdate(socket, user);
  });
});

function getSocketPrices(user) {
  let out = {};
  user.watchedTokens.forEach(t => {
    out[t.mint] = formatPrice(globalPriceCache.prices[t.mint]);
  });
  out.lastUpdated = globalPriceCache.lastUpdated ? new Date(globalPriceCache.lastUpdated) : null;
  return out;
}
function sendStatusUpdate(socket, user) {
  if (!user.latestData) {
    socket.emit("statusUpdate", { message: "No data yet" });
    return;
  }
  socket.emit("statusUpdate", user.latestData);
}

// --- SCAN LOGIC ---
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
        amount: amount
      };
    }).filter(a => a.amount > 0);
  } catch (e) {
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
async function analyzeTop50(fresh, initialTop50, initialTop50Amounts, previousTop50, previousTop50MinAmount, allTimeNewTop50) {
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
    allTimeNewTop50.has(owner)
  ).length;
  newSinceLastFetch.forEach(owner => {
    allTimeNewTop50.add(owner);
  });
  const stillInTop50 = initialTop50.filter(owner => currentTop50.includes(owner));
  const goneFromInitialTop50 = initialTop50.filter(owner => !currentTop50.includes(owner));
  const newInTop50 = currentTop50.filter(owner => !initialTop50.includes(owner));
  return {
    currentTop50Count: currentTop50.length,
    stillInTop50Count: stillInTop50.length,
    goneFromInitialTop50Count: goneFromInitialTop50.length,
    newInTop50Count: newInTop50.length,
    completelyNewSinceLastFetch: newSinceLastFetch.length,
    completelyNewSinceFirstFetch: newSinceFirstFetch
  };
}
async function pollDataForUser(userId) {
  const user = getUserState(userId);
  const mint = user.scanningMint;
  if (!mint || !user.scanning) return;
  const fresh = await fetchAllTokenAccounts(mint);
  if (!user.initialTop50) {
    const sorted = fresh.slice().sort((a, b) => b.amount - a.amount);
    user.initialTop50 = sorted.slice(0, 50).map(h => h.owner);
    sorted.slice(0, 50).forEach(h => user.initialTop50Amounts.set(h.owner, h.amount));
    user.previousTop50 = new Set(user.initialTop50);
    user.previousTop50MinAmount = sorted[49]?.amount || 0;
  }
  const changes = analyze(user.registry, fresh);
  const top50Stats = await analyzeTop50(
    fresh,
    user.initialTop50,
    user.initialTop50Amounts,
    user.previousTop50,
    user.previousTop50MinAmount,
    user.allTimeNewTop50
  );
  const topHolders = [...fresh].sort((a, b) => b.amount - a.amount).slice(0, MAX_TOP_HOLDERS);
  user.latestData = {
    fresh,
    registry: user.registry,
    changes,
    top50Stats,
    top50Count: user.initialTop50.length,
    timeRunning: user.startTime ? Math.floor((Date.now() - user.startTime) / 1000) : 0,
    startTime: user.startTime,
    tokenMint: mint,
    topHolders
  };
  // Socket update
  Object.entries(io.sockets.sockets).forEach(([id, sock]) => {
    if (sock.request.session.userId === userId) {
      sendStatusUpdate(sock, user);
      sock.emit("priceUpdate", getSocketPrices(user));
    }
  });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
