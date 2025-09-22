import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import express from "express";
import { WebSocketServer } from 'ws';
import http from 'http';
import fetch from 'node-fetch';

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "Gupf4N7c9WWr87naP2pC2m5JCwrs8QFBRB6yC1Xomxr7";
const POLL_INTERVAL_MS = 5000;
const ATH_BUY_MIN_SOL = 0.1;

// Game State
let allTimeHighPrice = 0;
let priceHistory = [];
let athPurchases = [];
let fullTransactions = [];
let consoleMessages = [];
const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });

// MMORPG Game Variables
let bossHealth = 1000;
let bossMaxHealth = 1000;
let bossPower = 100;
let bossLevel = 1;
let playerCharacters = new Map(); // wallet -> character data
let gameHistory = [];
let totalDamageDealt = 0;
let totalBossKills = 0;
let currentBossName = "PRICE DRAGON";
let bossPhase = "NORMAL";

const processedTransactions = new Set();
const recentHolders = new Set();

// WebSocket for real-time updates
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.send(JSON.stringify(getCurrentGameData()));
});

function broadcastUpdate() {
  const data = getCurrentGameData();
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  });
}

function getCurrentGameData() {
  const lastPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : { price: 0, priceChange24h: 0 };
  
  const athChad = athPurchases
    .filter(p => p.isATHPurchase && p.solAmount >= ATH_BUY_MIN_SOL)
    .sort((a, b) => b.marketPrice - a.marketPrice)[0] || null;

  const recentAthPurchases = athPurchases
    .filter(p => p.isATHPurchase)
    .sort((a, b) => b.txTime - a.txTime)
    .slice(0, 20);

  // Get top players by damage
  const topPlayers = Array.from(playerCharacters.entries())
    .sort((a, b) => b[1].totalDamage - a[1].totalDamage)
    .slice(0, 10)
    .map(([wallet, char], index) => ({ rank: index + 1, wallet, ...char }));

  return {
    priceHistory,
    allTimeHighPrice,
    athPurchases,
    fullTransactions,
    consoleMessages,
    
    // Game Data
    gameState: {
      bossHealth,
      bossMaxHealth,
      bossPower,
      bossLevel,
      bossName: currentBossName,
      bossPhase,
      totalDamageDealt,
      totalBossKills
    },
    
    playerCharacters: Object.fromEntries(playerCharacters),
    topPlayers,
    gameHistory: gameHistory.slice(-50), // Last 50 events
    
    stats: {
      totalATHPurchases: athPurchases.filter(p => p.isATHPurchase).length,
      uniqueBuyers: new Set(athPurchases.filter(p => p.isATHPurchase).map(p => p.wallet)).size,
      trackedTransactions: fullTransactions.length,
      lastPrice: lastPrice.price || 0,
      priceChange24h: lastPrice.priceChange24h || 0,
      activePlayers: playerCharacters.size
    },
    
    athChad,
    recentAthPurchases
  };
}

function logToConsole(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    message,
    type,
    id: Date.now() + Math.random()
  };
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
  consoleMessages.push(logEntry);
  if (consoleMessages.length > 500) consoleMessages.shift();
  broadcastUpdate();
}

function secondsAgo(ts) {
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ${diff%60}s ago`;
  return `${Math.floor(diff/3600)}h ${Math.floor((diff%3600)/60)}m ago`;
}

// MMORPG Game Functions
function createPlayerCharacter(wallet, initialPurchase) {
  const character = {
    wallet: wallet,
    level: 1,
    health: 100,
    maxHealth: 100,
    power: 10,
    totalDamage: 0,
    kills: 0,
    class: getRandomClass(),
    joinDate: new Date().toISOString(),
    lastAction: Date.now(),
    items: [],
    title: "Novice Warrior"
  };
  
  // Give bonus based on purchase size
  if (initialPurchase.solAmount > 1) {
    character.power += Math.floor(initialPurchase.solAmount);
    character.title = "Whale Warrior";
  }
  
  playerCharacters.set(wallet, character);
  return character;
}

function getRandomClass() {
  const classes = ["Warrior", "Mage", "Rogue", "Archer", "Paladin", "Berserker"];
  return classes[Math.floor(Math.random() * classes.length)];
}

function calculateDamage(purchase, currentPrice) {
  const baseDamage = purchase.solAmount * 10;
  const priceMultiplier = currentPrice > 0.0001 ? Math.log10(currentPrice * 10000) : 1;
  const randomCrit = Math.random() < 0.1 ? 2 : 1; // 10% crit chance
  
  return Math.floor(baseDamage * priceMultiplier * randomCrit);
}

function bossAttack() {
  const damage = Math.floor(bossPower * (0.8 + Math.random() * 0.4));
  
  // Randomly select a player to attack
  const players = Array.from(playerCharacters.values());
  if (players.length > 0) {
    const target = players[Math.floor(Math.random() * players.length)];
    target.health -= damage;
    
    if (target.health <= 0) {
      target.health = target.maxHealth; // Respawn
      gameHistory.push({
        type: "BOSS_KILL",
        message: `💀 ${currentBossName} defeated ${target.wallet.slice(0, 8)}...!`,
        timestamp: Date.now()
      });
    }
    
    gameHistory.push({
      type: "BOSS_ATTACK",
      message: `⚡ ${currentBossName} hits ${target.wallet.slice(0, 8)}... for ${damage} damage!`,
      timestamp: Date.now()
    });
  }
  
  return damage;
}

function updateBossPhase() {
  const healthPercent = (bossHealth / bossMaxHealth) * 100;
  
  if (healthPercent <= 25 && bossPhase !== "ENRAGED") {
    bossPhase = "ENRAGED";
    bossPower *= 1.5;
    gameHistory.push({
      type: "BOSS_PHASE",
      message: `🔥 ${currentBossName} becomes ENRAGED! Power increased!`,
      timestamp: Date.now()
    });
  } else if (healthPercent <= 50 && bossPhase === "NORMAL") {
    bossPhase = "ANGRY";
    bossPower *= 1.2;
    gameHistory.push({
      type: "BOSS_PHASE",
      message: `😠 ${currentBossName} is getting ANGRY!`,
      timestamp: Date.now()
    });
  }
}

function checkBossDefeat() {
  if (bossHealth <= 0) {
    totalBossKills++;
    gameHistory.push({
      type: "BOSS_DEFEAT",
      message: `🎉 ${currentBossName} has been DEFEATED! Players victorious!`,
      timestamp: Date.now()
    });
    
    // Level up boss for next fight
    bossLevel++;
    bossMaxHealth = 1000 + (bossLevel * 200);
    bossHealth = bossMaxHealth;
    bossPower = 100 + (bossLevel * 20);
    bossPhase = "NORMAL";
    
    // Generate new boss name based on price movement
    const priceChange = priceHistory.length > 1 ? 
      priceHistory[priceHistory.length - 1].price - priceHistory[0].price : 0;
    
    if (priceChange > 0) {
      currentBossName = `BULL MARKET DRAGON Lv${bossLevel}`;
    } else {
      currentBossName = `BEAR MARKET BEAST Lv${bossLevel}`;
    }
    
    // Reward all players
    Array.from(playerCharacters.values()).forEach(player => {
      player.level++;
      player.maxHealth += 20;
      player.health = player.maxHealth;
      player.power += 5;
      player.kills++;
    });
    
    broadcastUpdate();
    return true;
  }
  return false;
}

async function fetchTokenPrice(mintAddress) {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintAddress}`);
    if (!res.ok) {
      logToConsole(`Failed to fetch price: HTTP ${res.status}`, 'error');
      return null;
    }
    const data = await res.json();
    if (data[mintAddress]) {
      const tokenData = data[mintAddress];
      const price = tokenData.usdPrice || 0;
      const isNewATH = price > allTimeHighPrice;
      
      if (isNewATH) {
        allTimeHighPrice = price;
        logToConsole(`🚀 NEW ALL-TIME HIGH: $${price.toFixed(8)}`, 'success');
        
        // Boss gets stronger at ATH
        bossPower += 10;
        gameHistory.push({
          type: "ATH_REACHED",
          message: `📈 ATH REACHED! ${currentBossName} grows stronger!`,
          timestamp: Date.now()
        });
      }
      
      logToConsole(`Price fetched: $${price.toFixed(8)} (24h: ${(tokenData.priceChange24h * 100).toFixed(2)}%)`, 'info');
      broadcastUpdate();
      return { 
        price, 
        timestamp: Date.now(), 
        isNewATH,
        blockId: tokenData.blockId,
        decimals: tokenData.decimals,
        priceChange24h: tokenData.priceChange24h
      };
    }
    return null;
  } catch (e) {
    logToConsole(`Error fetching token price: ${e.message}`, 'error');
    return null;
  }
}

async function getFullTransactionDetails(signature) {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;
    const meta = tx.meta || {};
    const transaction = tx.transaction || {};
    const message = transaction.message || {};
    const accountKeys = message.accountKeys || [];
    const fullDetails = {
      signature: signature,
      slot: tx.slot || 0,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
      timestamp: tx.blockTime ? tx.blockTime * 1000 : null,
      fee: meta.fee ? meta.fee / LAMPORTS_PER_SOL : 0,
      status: meta.err ? 'failed' : 'success',
      error: meta.err || null,
      accounts: accountKeys.map((account, index) => ({
        pubkey: account?.pubkey?.toString() || 'unknown',
        signer: account?.signer || false,
        writable: account?.writable || false,
        preBalance: meta.preBalances?.[index] ? meta.preBalances[index] / LAMPORTS_PER_SOL : 0,
        postBalance: meta.postBalances?.[index] ? meta.postBalances[index] / LAMPORTS_PER_SOL : 0,
        balanceChange: meta.preBalances?.[index] && meta.postBalances?.[index] 
          ? (meta.postBalances[index] - meta.preBalances[index]) / LAMPORTS_PER_SOL 
          : 0
      })),
    };
    return fullDetails;
  } catch (e) {
    logToConsole(`Error getting transaction details: ${e.message}`, 'error');
    return null;
  }
}

function calculateSolSpent(tx) {
  try {
    if (!tx?.meta || !tx.transaction) return { solSpent: 0, buyer: null };
    const meta = tx.meta;
    const accountKeys = tx.transaction.message.accountKeys || [];
    const feePayerIndex = 0;
    let solSpent = 0;
    let buyer = accountKeys[feePayerIndex]?.pubkey?.toString() || null;
    if (meta.preBalances && meta.postBalances && meta.preBalances.length > feePayerIndex) {
      const preBalance = meta.preBalances[feePayerIndex] / LAMPORTS_PER_SOL;
      const postBalance = meta.postBalances[feePayerIndex] / LAMPORTS_PER_SOL;
      const fee = meta.fee / LAMPORTS_PER_SOL;
      solSpent = Math.max(0, preBalance - postBalance - fee);
    }
    if (solSpent === 0) {
      for (let i = 0; i < accountKeys.length; i++) {
        if (meta.preBalances?.[i] && meta.postBalances?.[i]) {
          const balanceChange = (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS_PER_SOL;
          if (balanceChange < -0.001) {
            solSpent = Math.abs(balanceChange);
            buyer = accountKeys[i]?.pubkey?.toString() || buyer;
            break;
          }
        }
      }
    }
    return { solSpent, buyer };
  } catch (e) {
    logToConsole(`Error calculating SOL spent: ${e.message}`, 'error');
    return { solSpent: 0, buyer: null };
  }
}

async function monitorNewTokenTransactions() {
  try {
    const mintPublicKey = new PublicKey(TOKEN_MINT);
    const signatures = await connection.getSignaturesForAddress(mintPublicKey, { limit: 10 });
    const newPurchases = [];
    logToConsole(`Monitoring ${signatures.length} new signatures`, 'info');
    for (const sig of signatures) {
      if (processedTransactions.has(sig.signature)) continue;
      try {
        const tx = await connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (!tx || !tx.meta || tx.meta.err) {
          processedTransactions.add(sig.signature);
          continue;
        }
        const txTime = tx.blockTime ? tx.blockTime * 1000 : 0;
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        if (txTime < fiveMinutesAgo) {
          processedTransactions.add(sig.signature);
          continue;
        }
        const fullTxDetails = await getFullTransactionDetails(sig.signature);
        if (fullTxDetails) fullTransactions.push(fullTxDetails);
        const purchase = await analyzeTokenPurchase(tx, sig.signature, fullTxDetails);
        if (purchase) {
          processedTransactions.add(sig.signature);
          newPurchases.push(purchase);
          logToConsole(`📊 New purchase detected: ${sig.signature}`, 'success');
        } else {
          processedTransactions.add(sig.signature);
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        logToConsole(`Error processing transaction ${sig.signature}: ${e.message}`, 'error');
        processedTransactions.add(sig.signature);
      }
    }
    if (newPurchases.length > 0) broadcastUpdate();
    return newPurchases;
  } catch (e) {
    logToConsole(`Error monitoring transactions: ${e.message}`, 'error');
    return [];
  }
}

async function analyzeTokenPurchase(tx, signature, fullTxDetails = null) {
  try {
    if (!tx?.meta || !tx?.transaction) return null;
    const postTokenBalances = tx.meta?.postTokenBalances || [];
    const tokenTransfers = postTokenBalances.filter(balance =>
      balance?.mint === TOKEN_MINT &&
      balance?.uiTokenAmount?.uiAmount > 0
    );
    if (tokenTransfers.length === 0) return null;
    const { solSpent, buyer } = calculateSolSpent(tx);
    const accountKeys = tx.transaction.message?.accountKeys || [];
    const accountAddresses = accountKeys.map(account => ({
      pubkey: account?.pubkey?.toString() || 'unknown',
      signer: account?.signer || false,
      writable: account?.writable || false
    }));
    const purchases = [];
    for (const transfer of tokenTransfers) {
      const wallet = transfer.owner || 'unknown';
      const tokenAmount = transfer.uiTokenAmount?.uiAmount || 0;
      if (recentHolders.has(wallet)) continue;
      let pricePerToken = 0;
      if (solSpent > 0 && tokenAmount > 0) pricePerToken = solSpent / tokenAmount;
      const purchaseDetails = {
        wallet: wallet,
        buyerAddress: buyer,
        signature: signature,
        timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown",
        txTime: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
        solAmount: solSpent,
        tokenAmount: tokenAmount,
        pricePerToken: pricePerToken,
        marketPrice: 0,
        isATHPurchase: false,
        allAddresses: accountAddresses,
        slot: tx.slot || 0,
        fee: tx.meta.fee ? tx.meta.fee / LAMPORTS_PER_SOL : 0,
        computeUnits: tx.meta.computeUnitsConsumed || null
      };
      if (fullTxDetails) purchaseDetails.fullTransaction = fullTxDetails;
      purchases.push(purchaseDetails);
      recentHolders.add(wallet);
    }
    return purchases.length > 0 ? purchases : null;
  } catch (e) {
    logToConsole(`Error analyzing purchase: ${e.message}`, 'error');
    return null;
  }
}

// ---- EXPRESS SERVER ----
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <title>TOKEN MMORPG BATTLE</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        background: #0a0a0a;
        color: #00ff41;
        font-family: 'JetBrains Mono', 'Courier New', monospace;
        min-height: 100vh;
        overflow-x: auto;
        font-size: 12px;
        line-height: 1.4;
        text-shadow: 0 0 10px #00ff4150;
      }
      body::before {
        content: '';
        position: fixed;
        top: 0; left: 0; width: 100vw; height: 100vh;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(0, 255, 65, 0.03) 2px,
          rgba(0, 255, 65, 0.03) 4px
        );
        pointer-events: none;
        z-index: 999;
      }
      .game-container {
        display: grid;
        grid-template-columns: 1fr 300px;
        gap: 10px;
        padding: 10px;
        min-height: 100vh;
      }
      .main-content {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .sidebar {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .terminal-container {
        padding: 15px;
        background: rgba(0, 0, 0, 0.9);
        border: 2px solid #00ff41;
        box-shadow: 0 0 20px #00ff4130, inset 0 0 20px #00ff4110;
      }
      .ascii-header {
        color: #ffff00;
        text-align: center;
        margin-bottom: 15px;
        white-space: pre;
        font-weight: 700;
        text-shadow: 0 0 15px #ffff0080;
        animation: flicker 2s infinite alternate;
      }
      @keyframes flicker { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
      .section {
        border: 1px solid #00ff41;
        margin: 10px 0;
        padding: 8px;
        background: rgba(0, 255, 65, 0.05);
      }
      .section-title {
        color: #ff6b6b;
        font-weight: 700;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 1px;
        border-bottom: 1px dashed #ff6b6b;
        padding-bottom: 3px;
        font-size: 11px;
      }
      .boss-container {
        background: linear-gradient(45deg, #ff000020, #ff6b6b20);
        border: 3px solid #ff4444;
        padding: 15px;
        text-align: center;
        box-shadow: 0 0 30px #ff000040;
        animation: bossGlow 3s infinite;
      }
      @keyframes bossGlow {
        0%, 100% { box-shadow: 0 0 30px #ff000040; }
        50% { box-shadow: 0 0 50px #ff6b6b60; }
      }
      .boss-health-bar {
        width: 100%;
        height: 20px;
        background: #333;
        border: 2px solid #ff4444;
        margin: 10px 0;
        position: relative;
      }
      .boss-health-fill {
        height: 100%;
        background: linear-gradient(90deg, #ff0000, #ff6b6b);
        transition: width 0.5s ease;
      }
      .boss-health-text {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: white;
        font-weight: bold;
        text-shadow: 0 0 5px black;
      }
      .player-card {
        background: rgba(0, 255, 65, 0.1);
        border: 1px solid #00ff41;
        padding: 8px;
        margin: 5px 0;
        border-radius: 3px;
      }
      .player-health-bar {
        width: 100%;
        height: 8px;
        background: #333;
        margin: 3px 0;
      }
      .player-health-fill {
        height: 100%;
        background: linear-gradient(90deg, #00ff41, #00cc33);
        transition: width 0.3s ease;
      }
      .ath-hero {
        background: rgba(255, 107, 107, 0.1);
        border: 2px solid #ff6b6b;
        padding: 10px;
        margin: 10px 0;
        text-align: center;
        box-shadow: 0 0 15px #ff6b6b30;
        animation: pulse 3s infinite;
      }
      @keyframes pulse {
        0%, 100% { border-color: #ff6b6b; box-shadow: 0 0 15px #ff6b6b30; }
        50% { border-color: #ff4444; box-shadow: 0 0 25px #ff444450; }
      }
      .game-event {
        padding: 5px;
        margin: 3px 0;
        border-left: 3px solid;
        background: rgba(0, 0, 0, 0.5);
      }
      .event-boss { border-color: #ff4444; }
      .event-player { border-color: #00ff41; }
      .event-system { border-color: #ffff00; }
      .buyer-entry {
        margin: 5px 0;
        padding: 5px;
        background: rgba(0, 0, 0, 0.3);
        border-left: 2px solid #00ff41;
        font-size: 10px;
      }
      .console-section {
        background: rgba(0, 0, 0, 0.8);
        border: 2px solid #00ff41;
        height: 200px;
        overflow-y: auto;
        font-size: 9px;
      }
      .console-header {
        background: rgba(0, 255, 65, 0.2);
        padding: 3px 8px;
        border-bottom: 1px solid #00ff41;
        color: #ffff00;
        font-weight: 700;
        font-size: 10px;
      }
      .console-content { padding: 5px; }
      .console-line { margin: 1px 0; word-break: break-all; }
      .connection-status {
        position: fixed;
        top: 5px;
        right: 5px;
        padding: 3px 8px;
        background: rgba(0, 0, 0, 0.9);
        border: 1px solid #00ff41;
        font-size: 9px;
        z-index: 1000;
      }
      .status-connected { color: #00ff41; }
      .status-disconnected { color: #ff6b6b; }
      .blink { animation: blink 1s infinite; }
      @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
      @media (max-width: 1024px) {
        .game-container { grid-template-columns: 1fr; }
        .sidebar { order: -1; }
      }
    </style>
  </head>
  <body>
    <div class="connection-status">
      <span id="connection-indicator">●</span> <span id="connection-text">CONNECTING...</span>
    </div>
    
    <div class="game-container">
      <div class="main-content">
        <!-- BOSS BATTLE SECTION -->
        <div class="terminal-container">
          <div class="ascii-header">
╔══════════════════════════════════════════════════════════════════════╗
║                         TOKEN MMORPG BATTLE                          ║
║                  EVERY HOLDER IS A CHARACTER                         ║
║                   PRICE IS THE BOSS                                  ║
╚══════════════════════════════════════════════════════════════════════╝
          </div>
          
          <div class="boss-container">
            <div class="section-title" id="boss-name">PRICE DRAGON Lv1</div>
            <div id="boss-phase">Phase: NORMAL</div>
            <div class="boss-health-bar">
              <div class="boss-health-fill" id="boss-health-bar" style="width: 100%"></div>
              <div class="boss-health-text" id="boss-health-text">1000/1000 HP</div>
            </div>
            <div>Power: <span id="boss-power">100</span> | Level: <span id="boss-level">1</span></div>
            <div>Total Kills: <span id="total-kills">0</span> | Total Damage: <span id="total-damage">0</span></div>
          </div>

          <!-- GAME EVENTS -->
          <div class="section">
            <div class="section-title">⚔️ LIVE BATTLE EVENTS</div>
            <div id="game-events" style="height: 150px; overflow-y: auto;">
              <div class="game-event event-system">Battle begins! Players vs Price Dragon!</div>
            </div>
          </div>

          <!-- PLAYER CHARACTERS -->
          <div class="section">
            <div class="section-title">🎮 ACTIVE PLAYERS (Top 10 by Damage)</div>
            <div id="players-list">
              <div style="text-align: center; color: #666; padding: 10px;">
                [NO PLAYERS YET... BUY TOKEN TO JOIN BATTLE!]<span class="blink">_</span>
              </div>
            </div>
          </div>
        </div>

        <!-- LIVE CONSOLE -->
        <div class="terminal-container">
          <div class="section">
            <div class="section-title">💻 LIVE CONSOLE OUTPUT</div>
            <div class="console-section">
              <div class="console-header">[server.mjs] // REAL-TIME LOG STREAM</div>
              <div class="console-content" id="console-output">
                <div class="console-line console-info">
                  <span class="console-timestamp">[INIT]</span> 
                  Token MMORPG initializing...<span class="blink">_</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sidebar">
        <!-- ATH HERO -->
        <div class="terminal-container">
          <div id="ath-hero-section" style="display: none;">
            <div class="ath-hero">
              <div class="section-title">🎯 ULTIMATE ATH CHAD</div>
              <div>WALLET: <span class="wallet" id="hero-wallet">---</span></div>
              <div>PRICE PAID: <span class="price" id="hero-price">$---</span></div>
              <div class="signature">TXN: <span id="hero-signature">---</span></div>
            </div>
          </div>

          <!-- RECENT ATH PURCHASES -->
          <div class="section">
            <div class="section-title">📋 RECENT ATH TRANSACTIONS</div>
            <div id="recent-purchases-list">
              <div style="text-align: center; color: #666; padding: 10px; font-size: 9px;">
                [NO ATH PURCHASES YET...]<span class="blink">_</span>
              </div>
            </div>
          </div>

          <!-- GAME STATS -->
          <div class="section">
            <div class="section-title">📊 GAME STATISTICS</div>
            <div id="game-stats">
              <div>Active Players: <span id="stat-players">0</span></div>
              <div>ATH Purchases: <span id="stat-ath">0</span></div>
              <div>Current Price: $<span id="stat-price">0.00000000</span></div>
              <div>24h Change: <span id="stat-change">0.00%</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      let ws;
      let reconnectInterval;
      
      function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
        
        ws.onopen = () => {
          document.getElementById('connection-indicator').className = 'status-connected';
          document.getElementById('connection-text').textContent = 'CONNECTED';
          clearInterval(reconnectInterval);
        };
        
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          updateGameInterface(data);
        };
        
        ws.onclose = () => {
          document.getElementById('connection-indicator').className = 'status-disconnected';
          document.getElementById('connection-text').textContent = 'RECONNECTING...';
          reconnectInterval = setInterval(connectWebSocket, 3000);
        };
        
        ws.onerror = (error) => {};
      }

      function updateGameInterface(data) {
        const { gameState, topPlayers, gameHistory, athChad, recentAthPurchases, stats } = data;
        
        // Update Boss Info
        document.getElementById('boss-name').textContent = \`\${gameState.bossName} Lv\${gameState.bossLevel}\`;
        document.getElementById('boss-phase').textContent = \`Phase: \${gameState.bossPhase}\`;
        document.getElementById('boss-health-bar').style.width = \`\${(gameState.bossHealth / gameState.bossMaxHealth) * 100}%\`;
        document.getElementById('boss-health-text').textContent = \`\${gameState.bossHealth}/\${gameState.bossMaxHealth} HP\`;
        document.getElementById('boss-power').textContent = gameState.bossPower;
        document.getElementById('boss-level').textContent = gameState.bossLevel;
        document.getElementById('total-kills').textContent = gameState.totalBossKills;
        document.getElementById('total-damage').textContent = gameState.totalDamageDealt;
        
        // Update Game Events
        const eventsContainer = document.getElementById('game-events');
        eventsContainer.innerHTML = '';
        gameHistory.slice(-10).reverse().forEach(event => {
          const eventDiv = document.createElement('div');
          eventDiv.className = \`game-event event-\${event.type.includes('BOSS') ? 'boss' : event.type.includes('PLAYER') ? 'player' : 'system'}\`;
          eventDiv.textContent = \`[\${new Date(event.timestamp).toLocaleTimeString()}] \${event.message}\`;
          eventsContainer.appendChild(eventDiv);
        });
        eventsContainer.scrollTop = eventsContainer.scrollHeight;
        
        // Update Player List
        const playersContainer = document.getElementById('players-list');
        if (topPlayers.length === 0) {
          playersContainer.innerHTML = '<div style="text-align: center; color: #666; padding: 10px;">[NO PLAYERS YET... BUY TOKEN TO JOIN BATTLE!]<span class="blink">_</span></div>';
        } else {
          playersContainer.innerHTML = topPlayers.map(player => \`
            <div class="player-card">
              <div><strong>#\${player.rank} \${player.wallet.slice(0, 8)}...</strong> [Lv\${player.level} \${player.class}]</div>
              <div>\${player.title} | Damage: \${player.totalDamage}</div>
              <div class="player-health-bar">
                <div class="player-health-fill" style="width: \${(player.health / player.maxHealth) * 100}%"></div>
              </div>
              <div style="font-size: 9px;">HP: \${player.health}/\${player.maxHealth} | Power: \${player.power}</div>
            </div>
          \`).join('');
        }
        
        // Update ATH Hero
        const heroSection = document.getElementById('ath-hero-section');
        if (athChad) {
          heroSection.style.display = 'block';
          document.getElementById('hero-wallet').textContent = athChad.wallet.slice(0, 12) + '...';
          document.getElementById('hero-price').textContent = \`$\${athChad.marketPrice.toFixed(8)}\`;
          document.getElementById('hero-signature').textContent = athChad.signature.slice(0, 16) + '...';
        } else {
          heroSection.style.display = 'none';
        }
        
        // Update Recent ATH Purchases
        const recentContainer = document.getElementById('recent-purchases-list');
        if (recentAthPurchases.length === 0) {
          recentContainer.innerHTML = '<div style="text-align: center; color: #666; padding: 10px; font-size: 9px;">[NO ATH PURCHASES YET...]<span class="blink">_</span></div>';
        } else {
          recentContainer.innerHTML = recentAthPurchases.slice(0, 5).map(purchase => \`
            <div class="buyer-entry">
              <div><strong>\${purchase.wallet.slice(0, 8)}...</strong></div>
              <div>Price: $\${purchase.marketPrice.toFixed(8)}</div>
              <div>SOL: \${purchase.solAmount.toFixed(4)}</div>
            </div>
          \`).join('');
        }
        
        // Update Stats
        document.getElementById('stat-players').textContent = stats.activePlayers;
        document.getElementById('stat-ath').textContent = stats.totalATHPurchases;
        document.getElementById('stat-price').textContent = stats.lastPrice.toFixed(8);
        document.getElementById('stat-change').textContent = \`\${(stats.priceChange24h * 100).toFixed(2)}%\`;
        document.getElementById('stat-change').style.color = stats.priceChange24h >= 0 ? '#00ff41' : '#ff4444';
        
        // Update Console
        const consoleOutput = document.getElementById('console-output');
        consoleOutput.innerHTML = '';
        data.consoleMessages.slice(-20).forEach(msg => {
          const line = document.createElement('div');
          line.className = \`console-line console-\${msg.type}\`;
          line.innerHTML = \`<span class="console-timestamp">[\${new Date(msg.timestamp).toLocaleTimeString()}]</span> \${msg.message}\`;
          consoleOutput.appendChild(line);
        });
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      }

      connectWebSocket();
    </script>
  </body>
  </html>
  `);
});

app.get("/api/stats", (req, res) => {
  res.json(getCurrentGameData());
});

const PORT = process.env.PORT || 1000;
server.listen(PORT, () => {
  logToConsole(`🚀 Token MMORPG Server running on http://localhost:${PORT}`, 'success');
  logToConsole(`🎮 Game initialized: ${currentBossName} awaits challengers!`, 'info');
  logToConsole(`📊 Monitoring token: ${TOKEN_MINT}`, 'info');
});

// ---- GAME LOOP ----
async function gameLoop() {
  let currentPriceData = null;
  
  // Game tick every 10 seconds
  setInterval(() => {
    // Boss attacks randomly
    if (Math.random() < 0.3) { // 30% chance per tick
      bossAttack();
      broadcastUpdate();
    }
    
    // Check boss phase
    updateBossPhase();
    
    // Check for boss defeat
    checkBossDefeat();
    
  }, 10000);

  // Main monitoring loop
  while (true) {
    try {
      const priceResult = await fetchTokenPrice(TOKEN_MINT);
      if (priceResult) {
        currentPriceData = priceResult;
        priceHistory.push(priceResult);
        if (priceHistory.length > 1000) priceHistory.shift();
        broadcastUpdate();
      }

      const newPurchases = await monitorNewTokenTransactions();
      if (newPurchases.length > 0 && currentPriceData) {
        for (const purchaseGroup of newPurchases) {
          if (!purchaseGroup) continue;
          for (const purchase of purchaseGroup) {
            purchase.marketPrice = currentPriceData.price;
            purchase.isATHPurchase = currentPriceData.isNewATH;
            athPurchases.push(purchase);

            // MMORPG GAME LOGIC
            if (!playerCharacters.has(purchase.wallet)) {
              createPlayerCharacter(purchase.wallet, purchase);
              gameHistory.push({
                type: "PLAYER_JOIN",
                message: `🎮 New player joined: ${purchase.wallet.slice(0, 8)}... the ${playerCharacters.get(purchase.wallet).class}!`,
                timestamp: Date.now()
              });
            }

            const player = playerCharacters.get(purchase.wallet);
            player.lastAction = Date.now();

            // Calculate damage to boss
            const damage = calculateDamage(purchase, currentPriceData.price);
            bossHealth = Math.max(0, bossHealth - damage);
            player.totalDamage += damage;
            totalDamageDealt += damage;

            gameHistory.push({
              type: "PLAYER_ATTACK",
              message: `⚔️ ${purchase.wallet.slice(0, 8)}... attacks ${currentBossName} for ${damage} damage!`,
              timestamp: Date.now()
            });

            if (purchase.isATHPurchase) {
              logToConsole(`🎯 ATH PURCHASE! ${purchase.wallet.slice(0, 8)}... dealt ${damage} damage at $${currentPriceData.price.toFixed(8)}`, 'success');
            }

            // Level up player based on purchase size
            if (purchase.solAmount > 0.5) {
              player.level++;
              player.maxHealth += 10;
              player.power += 2;
              gameHistory.push({
                type: "PLAYER_LEVEL_UP",
                message: `🌟 ${purchase.wallet.slice(0, 8)}... leveled up to Lv${player.level}!`,
                timestamp: Date.now()
              });
            }
          }
        }
        broadcastUpdate();
      }

      // Cleanup
      if (processedTransactions.size > 10000) {
        const toRemove = Array.from(processedTransactions).slice(0, 5000);
        toRemove.forEach(sig => processedTransactions.delete(sig));
      }
      if (recentHolders.size > 5000) {
        recentHolders.clear();
      }

      // Remove inactive players (24h no activity)
      const now = Date.now();
      Array.from(playerCharacters.entries()).forEach(([wallet, player]) => {
        if (now - player.lastAction > 24 * 60 * 60 * 1000) {
          playerCharacters.delete(wallet);
          gameHistory.push({
            type: "PLAYER_LEAVE",
            message: `👋 ${wallet.slice(0, 8)}... has left the battle.`,
            timestamp: now
          });
        }
      });

    } catch (e) {
      logToConsole(`❌ Error in game loop: ${e.message}`, 'error');
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

gameLoop().catch(e => {
  logToConsole(`💥 Fatal game error: ${e.message}`, 'error');
  process.exit(1);
});
