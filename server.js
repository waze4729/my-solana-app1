import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import express from "express";
import { WebSocketServer } from 'ws';
import http from 'http';

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "s5gUqwdD8d6JR8k8petVFYeYjsPgbkk6BF4Ndk7Z6uy";
const POLL_INTERVAL_MS = 2000;
const ATH_BUY_MIN_SOL = 0.1; // Only show ATH CHAD if purchase >= 0.1 SOL
const VOLUME_TARGET_SOL = 10; // Volume target for round rewards
const ROUND_REWARD_SOL_THRESHOLD = 10; // SOL threshold for round rewards

let allTimeHighPrice = 0;
let priceHistory = [];
let athPurchases = [];
let fullTransactions = [];
let consoleMessages = [];
let totalVolume = 0; // Total volume in SOL
let roundVolume = 0; // Current round volume
let roundRewards = []; // Stores top ATH buyers for each round
const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });

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
  ws.send(JSON.stringify(getCurrentDashboardData()));
});

function broadcastUpdate() {
  const data = getCurrentDashboardData();
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  });
}

function getCurrentDashboardData() {
  const lastPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : { price: 0, priceChange24h: 0 };
  // Only show ATH CHAD if >= 0.1 SOL, but show all recent ATH purchases in the list
  const athChad = athPurchases
    .filter(p => p.isATHPurchase && p.solAmount >= ATH_BUY_MIN_SOL)
    .sort((a, b) => b.marketPrice - a.marketPrice)[0] || null;
  const recentAthPurchases = athPurchases
    .filter(p => p.isATHPurchase)
    .sort((a, b) => b.txTime - a.txTime)
    .slice(0, 20);
  
  const volumeProgress = Math.min(100, (roundVolume / VOLUME_TARGET_SOL) * 100);
  const currentRound = roundRewards.length + 1;
  
  return {
    priceHistory,
    allTimeHighPrice,
    athPurchases,
    fullTransactions,
    consoleMessages,
    stats: {
      totalATHPurchases: athPurchases.filter(p => p.isATHPurchase).length,
      uniqueBuyers: new Set(athPurchases.filter(p => p.isATHPurchase).map(p => p.wallet)).size,
      trackedTransactions: fullTransactions.length,
      lastPrice: lastPrice.price || 0,
      priceChange24h: lastPrice.priceChange24h || 0,
      totalVolume,
      roundVolume,
      volumeProgress,
      currentRound,
      volumeTarget: VOLUME_TARGET_SOL
    },
    athChad,
    recentAthPurchases,
    roundRewards
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
// Function to check and update round rewards
function updateRoundRewards(newPurchase) {
  if (newPurchase.isATHPurchase && newPurchase.solAmount >= ATH_BUY_MIN_SOL) {
    // Add volume from this purchase
    roundVolume += newPurchase.solAmount;
    totalVolume += newPurchase.solAmount;
    
    logToConsole(`📈 Volume update: +${newPurchase.solAmount.toFixed(4)} SOL (Round: ${roundVolume.toFixed(4)}/${VOLUME_TARGET_SOL} SOL)`, 'info');
    
    // Check if we reached the volume target
    if (roundVolume >= VOLUME_TARGET_SOL) {
      const currentRound = roundRewards.length + 1;
      
      // Find the top ATH buyer for this round
      const roundAthPurchases = athPurchases.filter(p => 
        p.isATHPurchase && 
        p.solAmount >= ATH_BUY_MIN_SOL &&
        p.txTime >= (roundRewards.length > 0 ? roundRewards[roundRewards.length - 1].endTime : 0)
      );
      
      if (roundAthPurchases.length > 0) {
        const topAthBuyer = roundAthPurchases.sort((a, b) => b.marketPrice - a.marketPrice)[0];
        
        const roundReward = {
          round: currentRound,
          wallet: topAthBuyer.wallet,
          signature: topAthBuyer.signature,
          marketPrice: topAthBuyer.marketPrice,
          solAmount: topAthBuyer.solAmount,
          timestamp: topAthBuyer.timestamp,
          txTime: topAthBuyer.txTime,
          endTime: Date.now(),
          volumeReached: roundVolume
        };
        
        roundRewards.push(roundReward);
        
        logToConsole(`🎉 ROUND ${currentRound} COMPLETE! Top ATH Buyer: ${topAthBuyer.wallet} at $${topAthBuyer.marketPrice.toFixed(8)}`, 'success');
        logToConsole(`🏆 REWARD SAVED: Round ${currentRound} winner permanently stored`, 'success');
        
        // RESET ROUND VOLUME TO 0 FOR NEXT ROUND
        roundVolume = 0;
        
        // Broadcast update immediately to show reset progress bar
        broadcastUpdate();
      }
    } else {
      // If we haven't reached target, just broadcast normal update
      broadcastUpdate();
    }
  }
}
// ---- EXPRESS SERVER ----
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <title>TOP TERMINAL</title>
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
      .terminal-container {
        padding: 20px;
        max-width: 100%;
        background: rgba(0, 0, 0, 0.9);
        border: 2px solid #00ff41;
        margin: 10px;
        box-shadow: 0 0 20px #00ff4130, inset 0 0 20px #00ff4110;
      }
      .ascii-header {
        color: #ffff00;
        text-align: center;
        margin-bottom: 20px;
        white-space: pre;
        font-weight: 700;
        text-shadow: 0 0 15px #ffff0080;
        animation: flicker 2s infinite alternate;
      }
      @keyframes flicker { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
      
      /* VOLUME PROGRESS BAR */
      .volume-section {
        border: 2px solid #00ffff;
        margin: 15px 0;
        padding: 15px;
        background: rgba(0, 255, 255, 0.05);
        position: relative;
      }
      .volume-title {
        color: #00ffff;
        font-weight: 700;
        margin-bottom: 10px;
        text-transform: uppercase;
        letter-spacing: 2px;
        text-align: center;
        font-size: 14px;
      }
      .volume-bar-container {
        width: 100%;
        height: 30px;
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid #00ffff;
        position: relative;
        overflow: hidden;
      }
      .volume-bar {
        height: 100%;
        background: linear-gradient(90deg, #00ffff, #00ff41);
        width: 0%;
        transition: width 0.5s ease;
        position: relative;
      }
      .volume-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #00ffff, #00ff41);
        width: 0%;
        transition: width 0.5s ease;
        position: relative;
      }
      .volume-text {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #000;
        font-weight: 700;
        font-size: 12px;
        text-shadow: 0 0 3px #fff;
        z-index: 2;
      }
      .volume-stats {
        display: flex;
        justify-content: space-between;
        margin-top: 10px;
        font-size: 11px;
        color: #00ffff;
      }
      
      .section {
        border: 1px solid #00ff41;
        margin: 15px 0;
        padding: 10px;
        background: rgba(0, 255, 65, 0.05);
      }
      .section-title {
        color: #ff6b6b;
        font-weight: 700;
        margin-bottom: 10px;
        text-transform: uppercase;
        letter-spacing: 2px;
        border-bottom: 1px dashed #ff6b6b;
        padding-bottom: 5px;
      }
      
      /* ROUND REWARDS SECTION */
      .round-rewards-section {
        border: 2px solid #ff00ff;
        margin: 15px 0;
        padding: 15px;
        background: rgba(255, 0, 255, 0.05);
      }
      .round-reward {
        margin: 10px 0;
        padding: 10px;
        background: rgba(255, 0, 255, 0.1);
        border-left: 3px solid #ff00ff;
      }
      .round-number {
        color: #ff00ff;
        font-weight: 700;
        font-size: 14px;
      }
      .reward-wallet, .reward-signature {
        word-break: break-all;
        margin: 5px 0;
      }
      .reward-wallet a, .reward-signature a {
        color: #00ffff;
        text-decoration: none;
      }
      .reward-wallet a:hover, .reward-signature a:hover {
        text-decoration: underline;
      }
      
      .ath-hero {
        background: rgba(255, 107, 107, 0.1);
        border: 2px solid #ff6b6b;
        padding: 15px;
        margin: 20px 0;
        text-align: center;
        box-shadow: 0 0 15px #ff6b6b30;
        animation: pulse 3s infinite;
      }
      @keyframes pulse {
        0%, 100% { border-color: #ff6b6b; box-shadow: 0 0 15px #ff6b6b30; }
        50% { border-color: #ff4444; box-shadow: 0 0 25px #ff444450; }
      }
      .ath-hero .wallet { color: #00ffff; font-size: 14px; font-weight: 700; word-break: break-all; margin: 5px 0; }
      .ath-hero .price { color: #ffff00; font-size: 16px; font-weight: 700; margin: 5px 0; }
      .ath-hero .signature {
        color: #ff6b6b; font-size: 10px; word-break: break-all; margin: 10px 0; padding: 5px;
        background: rgba(0, 0, 0, 0.3); border: 1px dashed #ff6b6b;
      }
      .buyer-entry {
        margin: 8px 0;
        padding: 8px;
        background: rgba(0, 0, 0, 0.3);
        border-left: 3px solid #00ff41;
        font-size: 11px;
      }
      .buyer-entry:nth-child(odd) { background: rgba(0, 255, 65, 0.05); }
      .buyer-rank { color: #ffff00; font-weight: 700; margin-right: 8px; }
      .buyer-wallet { color: #00ffff; font-weight: 700; word-break: break-all; }
      .buyer-wallet a, .buyer-signature a {
        color: inherit;
        text-decoration: none;
      }
      .buyer-wallet a:hover, .buyer-signature a:hover {
        text-decoration: underline;
      }
      .buyer-signature { color: #ff6b6b; font-size: 9px; word-break: break-all; margin: 3px 0; font-family: 'JetBrains Mono', monospace; }
      .buyer-stats { color: #00ff41; font-size: 10px; margin-top: 3px; }
      .usd-value { color: #ffff00; font-weight: 700; }
      .console-section {
        background: rgba(0, 0, 0, 0.8);
        border: 2px solid #00ff41;
        height: 400px;
        overflow-y: auto;
        font-size: 10px;
      }
      .console-header {
        background: rgba(0, 255, 65, 0.2);
        padding: 5px 10px;
        border-bottom: 1px solid #00ff41;
        color: #ffff00;
        font-weight: 700;
        position: sticky;
        top: 0;
      }
      .console-content { padding: 10px; }
      .console-line { margin: 2px 0; word-break: break-all; }
      .console-timestamp { color: #666; margin-right: 5px; }
      .console-info { color: #00ff41; }
      .console-success { color: #ffff00; background: rgba(255, 255, 0, 0.1); padding: 1px 3px; }
      .console-error { color: #ff6b6b; background: rgba(255, 107, 107, 0.1); padding: 1px 3px; }
      .console-warn { color: #ffa500; background: rgba(255, 165, 0, 0.1); padding: 1px 3px; }
      .footer {
        text-align: center;
        margin-top: 20px;
        padding: 10px;
        border-top: 1px dashed #00ff41;
        color: #666;
        font-size: 9px;
      }
      .connection-status {
        position: fixed;
        top: 10px;
        right: 10px;
        padding: 5px 10px;
        background: rgba(0, 0, 0, 0.8);
        border: 1px solid #00ff41;
        font-size: 10px;
        z-index: 1000;
      }
      .status-connected { color: #00ff41; }
      .status-disconnected { color: #ff6b6b; }
      .blink { animation: blink 1s infinite; }
      @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
      @media (max-width: 768px) {
        body { font-size: 10px; }
        .terminal-container { margin: 5px; padding: 10px; }
        .ascii-header { font-size: 8px; }
        .console-section { height: 250px; }
        .ath-hero .signature { font-size: 8px; }
      }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: #000; }
      ::-webkit-scrollbar-thumb { background: #00ff41; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #00cc33; }
    </style>
  </head>
  <body>
    <div class="connection-status">
      <span id="connection-indicator">●</span> <span id="connection-text">CONNECTING...</span>
    </div>
    <div class="terminal-container">
      <div class="ascii-header">
BUY THE TOP AND GOT REWARDED - 50% CREATOR FEE EVERY ROUND
TOKEN: ${TOKEN_MINT}
      </div>
      
      <!-- VOLUME PROGRESS BAR -->
      <div class="volume-section">
        <div class="volume-title">🎯 VOLUME TARGET PROGRESS - ROUND <span id="current-round">1</span></div>
        <div class="volume-bar-container">
          <div class="volume-bar-fill" id="volume-bar"></div>
          <div class="volume-text" id="volume-text">0.00/10.00 SOL (0%)</div>
        </div>
        <div class="volume-stats">
          <span>Total Volume: <span id="total-volume">0.00</span> SOL</span>
          <span>Round Volume: <span id="round-volume">0.00</span> SOL</span>
          <span>Target: 10.00 SOL</span>
        </div>
      </div>
      
      <!-- ROUND REWARDS SECTION -->
      <div class="round-rewards-section" id="round-rewards-section" style="display: none;">
        <div class="section-title">🏆 ROUND REWARDS - PERMANENTLY SAVED WINNERS</div>
        <div id="round-rewards-list">
          <!-- Round rewards will be populated here -->
        </div>
      </div>
      
      <!-- ATH HERO SECTION -->
      <div id="ath-hero-section" style="display: none;">
        <div class="ath-hero">
          <div class="section-title">🎯 ULTIMATE ATH CHAD // BOUGHT AT PEAK MARKET CAP</div>
          <div>WALLET: <span class="wallet" id="hero-wallet">---</span></div>
          <div>PRICE PAID: <span class="price" id="hero-price">$---</span></div>
          <div>TIME: <span id="hero-time">---</span></div>
          <div class="signature">
            TXN SIGNATURE: <span id="hero-signature">---</span>
          </div>
        </div>
      </div>
      
      <!-- RECENT ATH PURCHASES -->
      <div class="section">
        <div class="section-title">📋 RECENT ATH TRANSACTIONS (ALL)</div>
        <div id="recent-purchases-list">
          <div style="text-align: center; color: #666; padding: 20px;">
            [NO ATH PURCHASES DETECTED YET...]<span class="blink">_</span>
          </div>
        </div>
      </div>
      
      <!-- LIVE CONSOLE -->
      <div class="section">
        <div class="section-title">💻 LIVE CONSOLE OUTPUT</div>
        <div class="console-section">
          <div class="console-header">
            [server.mjs] // REAL-TIME LOG STREAM
          </div>
          <div class="console-content" id="console-output">
            <div class="console-line console-info">
              <span class="console-timestamp">[INIT]</span> 
              ATH Buyer Tracker initializing...<span class="blink">_</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="footer">
        ═══════════════════════════════════════════════════════════════════════<br>
        TOP TERMINAL // DEV: SALAM47 //  ATH TRACKER v2.0 // VOLUME ROUNDS ACTIVATED<br>
        ═══════════════════════════════════════════════════════════════════════
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
          updateDashboard(data);
        };
        ws.onclose = () => {
          document.getElementById('connection-indicator').className = 'status-disconnected';
          document.getElementById('connection-text').textContent = 'RECONNECTING...';
          reconnectInterval = setInterval(connectWebSocket, 3000);
        };
        ws.onerror = (error) => {};
      }
      
      function updateDashboard(data) {
        const { athChad, recentAthPurchases, consoleMessages, stats, roundRewards } = data;
        
        // Update Volume Progress Bar
        document.getElementById('current-round').textContent = stats.currentRound;
        document.getElementById('volume-bar').style.width = stats.volumeProgress + '%';
        document.getElementById('volume-text').textContent = \`\${stats.roundVolume.toFixed(2)}/\${stats.volumeTarget.toFixed(2)} SOL (\${stats.volumeProgress.toFixed(1)}%)\`;
        document.getElementById('total-volume').textContent = stats.totalVolume.toFixed(2);
        document.getElementById('round-volume').textContent = stats.roundVolume.toFixed(2);
        
        // Update Round Rewards Section
        const rewardsSection = document.getElementById('round-rewards-section');
        const rewardsList = document.getElementById('round-rewards-list');
        if (roundRewards.length > 0) {
          rewardsSection.style.display = 'block';
          let rewardsHtml = '';
          roundRewards.forEach((reward, index) => {
            rewardsHtml += \`
              <div class="round-reward">
                <div class="round-number">ROUND \${reward.round} WINNER</div>
                <div class="reward-wallet">
                  🏆 Wallet: <a href="https://solscan.io/account/\${reward.wallet}" target="_blank">\${reward.wallet}</a>
                </div>
                <div class="reward-signature">
                  📝 TX: <a href="https://solscan.io/tx/\${reward.signature}" target="_blank">\${reward.signature}</a>
                </div>
                <div class="buyer-stats">
                  Price: $\${reward.marketPrice.toFixed(8)} | SOL: \${reward.solAmount.toFixed(4)} | 
                  Volume: \${reward.volumeReached.toFixed(2)} SOL | Time: \${secondsAgo(reward.txTime)}
                </div>
              </div>
            \`;
          });
          rewardsList.innerHTML = rewardsHtml;
        } else {
          rewardsSection.style.display = 'none';
        }
        
        // Update ATH HERO section (only if solAmount >= ATH_BUY_MIN_SOL)
        const heroSection = document.getElementById('ath-hero-section');
        if (athChad) {
          heroSection.style.display = 'block';
          document.getElementById('hero-wallet').innerHTML = \`<a href="https://solscan.io/account/\${athChad.wallet}" target="_blank">\${athChad.wallet}</a>\`;
          document.getElementById('hero-price').textContent = \`$\${athChad.marketPrice.toFixed(8)}\`;
          document.getElementById('hero-time').textContent = \`\${athChad.timestamp} (\${secondsAgo(athChad.txTime)})\`;
          document.getElementById('hero-signature').innerHTML = \`<a href="https://solscan.io/tx/\${athChad.signature}" target="_blank">\${athChad.signature}</a>\`;
        } else {
          heroSection.style.display = 'none';
        }
        
        // Update RECENT ATH PURCHASES (show all, not just >=0.1 SOL)
        let recentHtml = '';
        if (recentAthPurchases.length === 0) {
          recentHtml = \`<div style="text-align: center; color: #666; padding: 20px;">[NO ATH PURCHASES DETECTED YET...]<span class="blink">_</span></div>\`;
        } else {
          recentAthPurchases.forEach((purchase, i) => {
            const usdValue = purchase.solAmount * purchase.marketPrice;
            recentHtml += \`
              <div class="buyer-entry">
                <div>
                  <span class="buyer-rank">#\${i + 1}</span>
                  <span class="buyer-wallet"><a href="https://solscan.io/account/\${purchase.wallet}" target="_blank">\${purchase.wallet}</a></span>
                </div>
                <div class="buyer-signature"><a href="https://solscan.io/tx/\${purchase.signature}" target="_blank">\${purchase.signature}</a></div>
                <div class="buyer-stats">
                  SOL: \${purchase.solAmount.toFixed(6)} | 
                  Value: <span class="usd-value">$\${usdValue.toFixed(8)}</span> | 
                  Tokens: \${purchase.tokenAmount.toFixed(2)} | 
                  Price: $\${purchase.marketPrice.toFixed(8)}
                </div>
                <div class="buyer-stats">
                  Time: \${purchase.timestamp} (\${secondsAgo(purchase.txTime)})
                </div>
              </div>
            \`;
          });
        }
        document.getElementById('recent-purchases-list').innerHTML = recentHtml;
        
        // Update console
        const consoleOutput = document.getElementById('console-output');
        consoleOutput.innerHTML = '';
        consoleMessages.slice(-30).forEach(msg => {
          const line = document.createElement('div');
          line.className = \`console-line console-\${msg.type}\`;
          line.innerHTML = \`<span class="console-timestamp">[\${new Date(msg.timestamp).toLocaleTimeString()}]</span> \${msg.message}\`;
          consoleOutput.appendChild(line);
        });
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      }
      
      function secondsAgo(ts) {
        const now = Date.now();
        const diff = Math.floor((now - ts) / 1000);
        if (diff < 60) return \`\${diff}s ago\`;
        if (diff < 3600) return \`\${Math.floor(diff/60)}m \${diff%60}s ago\`;
        return \`\${Math.floor(diff/3600)}h \${Math.floor((diff%3600)/60)}m ago\`;
      }
      
      connectWebSocket();
    </script>
  </body>
  </html>
  `);
});

app.get("/api/stats", (req, res) => {
  res.json(getCurrentDashboardData());
});

const PORT = 1000;
server.listen(PORT, () => {
  logToConsole(`🚀 Server running on http://localhost:${PORT}`, 'success');
  logToConsole(`📊 Monitoring token: ${TOKEN_MINT}`, 'info');
  logToConsole(`⚡ WebSocket server initialized`, 'info');
  logToConsole(`🎯 Volume Round System Activated - Target: ${VOLUME_TARGET_SOL} SOL per round`, 'success');
});

// ---- BACKGROUND DATA LOOP ----
async function loop() {
  let currentPriceData = null;
  logToConsole('🔄 Starting monitoring loop...', 'info');
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
            
            // Update volume and check for round rewards
            updateRoundRewards(purchase);
            
            if (purchase.isATHPurchase) {
              logToConsole(`🎯 ATH PURCHASE! Wallet: ${purchase.wallet}, Price: ${currentPriceData.price.toFixed(8)}`, 'success');
            }
          }
        }
        broadcastUpdate();
      }
      if (processedTransactions.size > 10000) {
        const toRemove = Array.from(processedTransactions).slice(0, 5000);
        toRemove.forEach(sig => processedTransactions.delete(sig));
        logToConsole('🧹 Cleaned up old processed transactions', 'info');
      }
      if (recentHolders.size > 5000) {
        recentHolders.clear();
        logToConsole('🧹 Cleared recent holders cache', 'info');
      }
    } catch (e) {
      logToConsole(`❌ Error in main loop: ${e.message}`, 'error');
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}
loop().catch(e => {
  logToConsole(`💥 Fatal error: ${e.message}`, 'error');
  process.exit(1);
});


