import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import fetch from 'node-fetch';

// === CONFIG ===
const CREATOR_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
const SCANNER_RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const PUMP_TOKEN_MINT = "Gupf4N7c9WWr87naP2pC2m5JCwrs8QFBRB6yC1Xomxr7";
const SECRET_KEY = new Uint8Array([

]);
const MIN_FEES_TO_COLLECT_SOL = 0.05;
const ATH_BUY_MIN_SOL = 0.1;
const VOLUME_THRESHOLD = 10; // 10 SOL volume threshold for Hall of Fame
const POLL_INTERVAL_MS = 2000;

const creatorConnection = new Connection(CREATOR_RPC_ENDPOINT, "confirmed");
const scannerConnection = new Connection(SCANNER_RPC_ENDPOINT, { commitment: "confirmed" });
const wallet = Keypair.fromSecretKey(SECRET_KEY);
const sdk = new OnlinePumpSdk(creatorConnection);

// Game State
let BOSS = {
  hp: 100,
  maxHp: 100,
  power: 50,
  name: "BEAR MARKET BOSS",
  lastAttack: 0
};

let PLAYERS = new Map();
let HALL_OF_FAME = new Map();
let ATH = { wallet: null, solAmount: 0, usdValue: 0, signature: "", timestamp: 0 };
let TOTAL_VOLUME = { buys: 0, sells: 0 };

// HTML Elements
function createGameInterface() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PUMP MMORPG - Token Battle</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Arial', sans-serif; 
            background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
            color: #fff; min-height: 100vh; overflow-x: hidden;
        }
        .container { 
            max-width: 1400px; margin: 0 auto; padding: 20px;
            display: grid; grid-template-columns: 1fr 400px; gap: 20px;
        }
        .game-area { background: rgba(0,0,0,0.6); border-radius: 15px; padding: 20px; }
        .sidebar { background: rgba(0,0,0,0.4); border-radius: 15px; padding: 20px; }
        
        .boss-container { text-align: center; margin-bottom: 30px; }
        .boss-health { 
            background: #333; height: 30px; border-radius: 15px; 
            margin: 10px 0; overflow: hidden; position: relative;
        }
        .boss-health-bar { 
            background: linear-gradient(90deg, #ff0000, #ff6a00); 
            height: 100%; width: ${BOSS.hp}%; transition: width 0.5s;
        }
        .boss-image {
            font-size: 80px; margin: 20px 0; text-shadow: 0 0 20px red;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }
        
        .players-grid { 
            display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); 
            gap: 15px; margin-top: 20px;
        }
        .player-card {
            background: rgba(255,255,255,0.1); padding: 10px; border-radius: 10px;
            text-align: center; transition: transform 0.3s;
        }
        .player-card:hover { transform: translateY(-5px); }
        .player-avatar { font-size: 24px; margin-bottom: 5px; }
        .player-health { 
            background: #333; height: 6px; border-radius: 3px; 
            margin: 5px 0; overflow: hidden;
        }
        .player-health-bar { background: #00ff00; height: 100%; }
        
        .hall-of-fame { margin-top: 30px; }
        .hof-entry {
            background: rgba(255,215,0,0.2); padding: 10px; margin: 10px 0;
            border-radius: 8px; border-left: 3px solid gold;
        }
        
        .battle-log {
            background: rgba(0,0,0,0.8); height: 200px; overflow-y: auto;
            padding: 10px; border-radius: 5px; margin-top: 20px;
            font-family: monospace; font-size: 12px;
        }
        .log-entry { margin: 5px 0; }
        .log-buy { color: #00ff00; }
        .log-sell { color: #ff4444; }
        .log-boss { color: #ff6a00; }
        .log-ath { color: gold; font-weight: bold; }
        
        .stats-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
            margin: 20px 0;
        }
        .stat-card {
            background: rgba(255,255,255,0.1); padding: 15px; border-radius: 10px;
            text-align: center;
        }
        .stat-value { font-size: 24px; font-weight: bold; margin: 5px 0; }
        
        .attack-animation {
            position: absolute; font-size: 30px; pointer-events: none;
            animation: floatUp 1s forwards;
        }
        @keyframes floatUp {
            0% { transform: translateY(0); opacity: 1; }
            100% { transform: translateY(-50px); opacity: 0; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="game-area">
            <div class="boss-container">
                <h1>🎯 PUMP TOKEN MMORPG BATTLE</h1>
                <div class="boss-health">
                    <div class="boss-health-bar"></div>
                </div>
                <div class="boss-image">🐻 BEAR BOSS</div>
                <div>HP: ${BOSS.hp.toFixed(1)}/${BOSS.maxHp} | POWER: ${BOSS.power}</div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div>Total Buy Volume</div>
                    <div class="stat-value" id="total-buys">${TOTAL_VOLUME.buys.toFixed(2)} SOL</div>
                </div>
                <div class="stat-card">
                    <div>Total Sell Volume</div>
                    <div class="stat-value" id="total-sells">${TOTAL_VOLUME.sells.toFixed(2)} SOL</div>
                </div>
                <div class="stat-card">
                    <div>ATH Champion</div>
                    <div class="stat-value" id="ath-wallet">${ATH.wallet ? ATH.wallet.substring(0,8)+'...' : 'None'}</div>
                </div>
                <div class="stat-card">
                    <div>ATH Buy Amount</div>
                    <div class="stat-value" id="ath-amount">${ATH.solAmount.toFixed(2)} SOL</div>
                </div>
            </div>
            
            <h3>🎮 Players/Holders</h3>
            <div class="players-grid" id="players-container">
                <!-- Player cards will be dynamically inserted here -->
            </div>
            
            <div class="battle-log" id="battle-log">
                <div class="log-entry">🚀 Game started! Waiting for transactions...</div>
            </div>
        </div>
        
        <div class="sidebar">
            <h3>🏆 Hall of Fame</h3>
            <div id="hall-of-fame">
                <!-- Hall of Fame entries will appear here -->
            </div>
            
            <h3 style="margin-top: 30px;">📊 Live Stats</h3>
            <div id="live-stats">
                <div>Active Players: <span id="active-players">0</span></div>
                <div>Boss HP: <span id="boss-hp">100</span></div>
                <div>Total Transactions: <span id="total-txs">0</span></div>
            </div>
        </div>
    </div>

    <script>
        function updateGameState(data) {
            // Update boss HP
            document.querySelector('.boss-health-bar').style.width = data.boss.hp + '%';
            document.querySelector('#boss-hp').textContent = data.boss.hp.toFixed(1);
            
            // Update stats
            document.querySelector('#total-buys').textContent = data.totalVolume.buys.toFixed(2) + ' SOL';
            document.querySelector('#total-sells').textContent = data.totalVolume.sells.toFixed(2) + ' SOL';
            document.querySelector('#ath-wallet').textContent = data.ath.wallet ? 
                data.ath.wallet.substring(0,8) + '...' : 'None';
            document.querySelector('#ath-amount').textContent = data.ath.solAmount.toFixed(2) + ' SOL';
            document.querySelector('#active-players').textContent = data.players.size;
            document.querySelector('#total-txs').textContent = data.totalTxs;
            
            // Update players grid
            const playersContainer = document.querySelector('#players-container');
            playersContainer.innerHTML = '';
            data.players.forEach((player, wallet) => {
                const playerCard = document.createElement('div');
                playerCard.className = 'player-card';
                playerCard.innerHTML = \`
                    <div class="player-avatar">👤</div>
                    <div style="font-size: 10px; word-break: break-all;">\${wallet.substring(0,6)}...\${wallet.substring(wallet.length-4)}</div>
                    <div style="font-size: 12px; margin: 5px 0;">\${player.solAmount.toFixed(2)} SOL</div>
                    <div class="player-health">
                        <div class="player-health-bar" style="width: \${player.hp}%"></div>
                    </div>
                \`;
                playersContainer.appendChild(playerCard);
            });
            
            // Update Hall of Fame
            const hofContainer = document.querySelector('#hall-of-fame');
            hofContainer.innerHTML = '';
            data.hallOfFame.forEach((entry, wallet) => {
                const hofEntry = document.createElement('div');
                hofEntry.className = 'hof-entry';
                hofEntry.innerHTML = \`
                    <div style="font-weight: bold;">🏆 \${wallet.substring(0,8)}...</div>
                    <div>Amount: \${entry.solAmount.toFixed(2)} SOL</div>
                    <div>USD: $\${entry.usdValue.toFixed(2)}</div>
                    <div style="font-size: 10px; opacity: 0.7;">\${new Date(entry.timestamp).toLocaleDateString()}</div>
                \`;
                hofContainer.appendChild(hofEntry);
            });
        }
        
        function addBattleLog(message, type) {
            const log = document.querySelector('#battle-log');
            const entry = document.createElement('div');
            entry.className = \`log-entry log-\${type}\`;
            entry.textContent = \`[\${new Date().toLocaleTimeString()}] \${message}\`;
            log.appendChild(entry);
            log.scrollTop = log.scrollHeight;
            
            // Keep only last 50 entries
            const entries = log.querySelectorAll('.log-entry');
            if (entries.length > 50) {
                entries[0].remove();
            }
        }
        
        function createAttackAnimation(x, y, damage) {
            const anim = document.createElement('div');
            anim.className = 'attack-animation';
            anim.textContent = \`-\${damage}\`;
            anim.style.left = x + 'px';
            anim.style.top = y + 'px';
            document.body.appendChild(anim);
            setTimeout(() => anim.remove(), 1000);
        }
        
        // WebSocket connection for real-time updates
        const ws = new WebSocket('ws://localhost:8080'); // You'd need to set up a WebSocket server
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            updateGameState(data);
            
            if (data.newLog) {
                addBattleLog(data.newLog.message, data.newLog.type);
                
                if (data.newLog.type === 'buy' && data.newLog.damage) {
                    createAttackAnimation(400, 300, data.newLog.damage);
                }
            }
        };
        
        // Simulate some initial data for demo
        setTimeout(() => {
            updateGameState({
                boss: { hp: 85, maxHp: 100, power: 50 },
                totalVolume: { buys: 15.67, sells: 8.23 },
                ath: { wallet: 'HxY8s3...aBc9', solAmount: 2.5, usdValue: 450 },
                players: new Map([
                    ['HxY8s3...aBc9', { solAmount: 2.5, hp: 100 }],
                    ['KwT5r2...XzY7', { solAmount: 1.2, hp: 85 }],
                    ['MnP9s1...QwE3', { solAmount: 0.8, hp: 92 }]
                ]),
                hallOfFame: new Map([
                    ['HxY8s3...aBc9', { solAmount: 2.5, usdValue: 450, timestamp: Date.now() }]
                ]),
                totalTxs: 47
            });
            
            addBattleLog('👤 Player HxY8s3... bought 2.5 SOL! Boss takes -15 damage!', 'buy');
            addBattleLog('🐻 Bear Boss attacks back! All players take -8 damage!', 'boss');
            addBattleLog('🏆 New ATH Champion: HxY8s3... with 2.5 SOL purchase!', 'ath');
        }, 1000);
    </script>
</body>
</html>
`;
}

// Enhanced game logic
async function analyzeTransaction(tx, signature) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  
  const meta = tx.meta;
  const accountKeys = tx.transaction.message.staticAccountKeys || [];
  if (accountKeys.length === 0) return null;

  // Calculate SOL spent/received
  const preBalance = meta.preBalances[0] / LAMPORTS_PER_SOL;
  const postBalance = meta.postBalances[0] / LAMPORTS_PER_SOL;
  const fee = meta.fee / LAMPORTS_PER_SOL;
  const netChange = preBalance - postBalance - fee;
  
  if (Math.abs(netChange) < 0.01) return null; // Ignore tiny transactions

  const isBuy = netChange > 0;
  const solAmount = Math.abs(netChange);
  const walletAddress = accountKeys[0].toBase58();

  // Update player stats
  if (!PLAYERS.has(walletAddress)) {
    PLAYERS.set(walletAddress, {
      solAmount: 0,
      hp: 100,
      lastAction: Date.now(),
      totalBuys: 0,
      totalSells: 0
    });
  }

  const player = PLAYERS.get(walletAddress);
  
  if (isBuy) {
    player.solAmount += solAmount;
    player.totalBuys += solAmount;
    TOTAL_VOLUME.buys += solAmount;
    
    // Players heal when buying
    player.hp = Math.min(100, player.hp + 5);
    
    // Boss takes damage from buys
    const damage = Math.min(solAmount * 2, 20);
    BOSS.hp = Math.max(0, BOSS.hp - damage);
    
    return {
      type: 'buy',
      wallet: walletAddress,
      solAmount,
      damage,
      signature,
      timestamp: Date.now()
    };
  } else {
    player.solAmount = Math.max(0, player.solAmount - solAmount);
    player.totalSells += solAmount;
    TOTAL_VOLUME.sells += solAmount;
    
    // Players take damage when selling
    player.hp = Math.max(0, player.hp - 10);
    
    // Boss gains power from sells
    BOSS.power = Math.min(100, BOSS.power + solAmount);
    BOSS.hp = Math.min(BOSS.maxHp, BOSS.hp + solAmount);
    
    // Boss attacks back periodically
    const now = Date.now();
    if (now - BOSS.lastAttack > 30000) { // Every 30 seconds
      BOSS.lastAttack = now;
      attackAllPlayers();
    }
    
    return {
      type: 'sell', 
      wallet: walletAddress,
      solAmount,
      signature,
      timestamp: Date.now()
    };
  }
}

function attackAllPlayers() {
  const damage = Math.floor(BOSS.power * 0.1);
  PLAYERS.forEach(player => {
    player.hp = Math.max(0, player.hp - damage);
  });
  
  return {
    type: 'boss_attack',
    damage,
    message: `🐻 Bear Boss attacks all players for ${damage} damage!`
  };
}

async function scanTransactions(maxTx = 50) {
  try {
    const mintPubkey = new PublicKey(PUMP_TOKEN_MINT);
    const signatures = await scannerConnection.getSignaturesForAddress(mintPubkey, { limit: maxTx });
    let transactions = [];

    for (const siginfo of signatures) {
      try {
        const tx = await scannerConnection.getTransaction(siginfo.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        
        const analysis = await analyzeTransaction(tx, siginfo.signature);
        if (analysis) {
          transactions.push(analysis);
          
          // Check for ATH potential
          if (analysis.type === 'buy' && analysis.solAmount >= ATH_BUY_MIN_SOL) {
            const jupRes = await fetch(`https://lite-api.jup.ag/price/v3?ids=${PUMP_TOKEN_MINT}`);
            const jupData = await jupRes.json();
            const tokenPrice = jupData[PUMP_TOKEN_MINT]?.usdPrice || 0;
            const usdValue = analysis.solAmount * tokenPrice;
            
            if (usdValue > ATH.usdValue) {
              ATH = {
                wallet: analysis.wallet,
                solAmount: analysis.solAmount,
                usdValue: usdValue,
                signature: analysis.signature,
                timestamp: analysis.timestamp
              };
              
              // Add to Hall of Fame if volume threshold met
              if (TOTAL_VOLUME.buys + TOTAL_VOLUME.sells >= VOLUME_THRESHOLD) {
                HALL_OF_FAME.set(analysis.wallet, {
                  solAmount: analysis.solAmount,
                  usdValue: usdValue,
                  timestamp: analysis.timestamp,
                  signature: analysis.signature
                });
              }
            }
          }
        }
      } catch (e) {
        console.error('Error analyzing transaction:', e);
      }
    }
    
    return transactions;
  } catch (e) {
    console.error('Error scanning transactions:', e);
    return [];
  }
}

// Server setup for web interface
import http from 'http';
import fs from 'fs';
import path from 'path';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(createGameInterface());
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(3000, () => {
  console.log('🎮 Game server running at http://localhost:3000');
});

async function collectCreatorFeesIfNeeded() {
  try {
    const balanceLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
    const balanceSol = Number(balanceLamports) / LAMPORTS_PER_SOL;
    console.log("💰 Uncollected creator fees available:", balanceSol, "SOL");
    if (balanceSol > MIN_FEES_TO_COLLECT_SOL) {
      console.log("🔔 Attempting to collect creator fees...");
      try {
        const sig = await sdk.collectCreatorFees(wallet);
        console.log("✅ Collected creator fees! Transaction signature:", sig);
        await creatorConnection.confirmTransaction(sig, "confirmed");
        return balanceSol;
      } catch (err) {
        console.error("❌ Failed to collect creator fees:", err);
        return 0;
      }
    } else {
      console.log("ℹ️ Not enough fees to collect (need >", MIN_FEES_TO_COLLECT_SOL, "SOL).");
      return 0;
    }
  } catch (err) {
    console.error("❌ Failed to fetch creator fees:", err);
    return 0;
  }
}

async function sendATHReward(athWallet, amountSol) {
  try {
    if (!athWallet) throw new Error("ATH wallet address missing");
    const recipient = new PublicKey(athWallet);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: recipient,
        lamports: Math.floor(amountSol * LAMPORTS_PER_SOL)
      })
    );
    const sig = await creatorConnection.sendTransaction(tx, [wallet]);
    console.log(`🎁 Sent ${amountSol} SOL to ATH wallet: ${athWallet} | TX: ${sig}`);
    return sig;
  } catch (e) {
    console.error("❌ Failed to send ATH reward:", e);
    return null;
  }
}

async function mainLoop() {
  let totalTransactions = 0;
  
  while (true) {
    try {
      // 1. Check/collect creator fees
      const collectedSol = await collectCreatorFeesIfNeeded();
      
      // 2. Scan and process transactions
      const transactions = await scanTransactions(50);
      totalTransactions += transactions.length;
      
      // 3. Update game state and log actions
      transactions.forEach(tx => {
        if (tx.type === 'buy') {
          console.log(`🎯 BUY: ${tx.wallet.substring(0,8)}... bought ${tx.solAmount.toFixed(2)} SOL | Boss HP: ${BOSS.hp.toFixed(1)}`);
        } else if (tx.type === 'sell') {
          console.log(`💔 SELL: ${tx.wallet.substring(0,8)}... sold ${tx.solAmount.toFixed(2)} SOL | Boss Power: ${BOSS.power.toFixed(1)}`);
        }
      });
      
      // 4. If fees were collected and ATH exists, send 40% of collected to ATH
      if (collectedSol > 0 && ATH.wallet) {
        const rewardSol = collectedSol * 0.4;
        await sendATHReward(ATH.wallet, rewardSol);
      }
      
      // 5. Clean up inactive players (older than 1 hour)
      const now = Date.now();
      PLAYERS.forEach((player, wallet) => {
        if (now - player.lastAction > 3600000) { // 1 hour
          PLAYERS.delete(wallet);
        }
      });
      
      // 6. Log current game state
      console.log(`🎮 Game State: ${PLAYERS.size} active players | Boss HP: ${BOSS.hp.toFixed(1)} | Volume: ${(TOTAL_VOLUME.buys + TOTAL_VOLUME.sells).toFixed(2)} SOL`);
      
    } catch (e) {
      console.error("Loop error:", e);
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Start the game
console.log("🚀 Starting PUMP MMORPG Game...");
console.log("🎮 Game interface available at: http://localhost:3000");
mainLoop();
