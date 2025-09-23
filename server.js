import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import express from "express";
import { WebSocketServer } from 'ws';
import http from 'http';

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "AoedByk5vF5mxWF8jo4wWm9PXZZxFq729knEXQzhpump";
const POLL_INTERVAL_MS = 5000;
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 1000000;
const GREEN_CHANCE = 0.33;

// Simple in-memory storage
let allTimeHighPrice = 0;
let currentPrice = 0;
let priceChange24h = 0;
let consoleMessages = [];
let totalVolume = 0;
let gameBlocks = Array(TOTAL_BLOCKS).fill(null).map(() => ({ 
    status: 'hidden', 
    color: null, 
    purchase: null,
    assignedHolder: null,
    isGuaranteedGreen: false
}));
let currentBlockIndex = 0;
let gameCompleted = false;
let winningWallets = [];
let previousWinners = [];
let tokenSupply = 0;
let majorHolders = new Map();
const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });

const processedTransactions = new Set();
const recentHolders = new Set();
const assignedHoldersThisGame = new Set();

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
    const revealedGreenBlocks = gameBlocks.filter(block => 
        block.status === 'revealed' && block.color === 'green'
    ).length;
    
    const guaranteedGreenBlocks = gameBlocks.filter(block => 
        block.status === 'hidden' && 
        block.isGuaranteedGreen && 
        block.assignedHolder && 
        isHolderStillQualified(block.assignedHolder)
    ).length;
    
    const totalGreenBlocks = revealedGreenBlocks + guaranteedGreenBlocks;
    const progress = Math.min(100, (totalGreenBlocks / TOTAL_BLOCKS) * 100);
    
    const millionTokenHolders = Array.from(majorHolders.entries())
        .filter(([wallet, data]) => data.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN)
        .map(([wallet, data]) => ({
            wallet,
            tokens: data.tokens,
            percentage: data.percentage,
            hasGuaranteedBlock: assignedHoldersThisGame.has(wallet),
            assignedBlock: getAssignedBlockForHolder(wallet),
            stillQualified: isHolderStillQualified(wallet)
        }));
    
    return {
        currentPrice,
        allTimeHighPrice,
        priceChange24h,
        consoleMessages: consoleMessages.slice(-50),
        gameData: {
            blocks: gameBlocks,
            currentBlockIndex,
            totalBlocks: TOTAL_BLOCKS,
            progress,
            gameCompleted,
            winningWallets,
            previousWinners,
            revealedGreenBlocks,
            guaranteedGreenBlocks,
            totalGreenBlocks
        },
        stats: {
            uniqueBuyers: new Set(winningWallets.map(p => p.wallet)).size,
            totalBlocksOpened: currentBlockIndex,
            currentPrice: currentPrice,
            priceChange24h: priceChange24h,
            totalVolume,
            millionTokenHolders,
            tokenSupply,
            greenChance: GREEN_CHANCE * 100,
            blocksRemaining: TOTAL_BLOCKS - currentBlockIndex,
            assignedGuaranteedBlocks: assignedHoldersThisGame.size,
            validGuaranteedBlocks: guaranteedGreenBlocks,
            revealedGreenBlocks: revealedGreenBlocks,
            totalGreenBlocks: totalGreenBlocks
        }
    };
}

function isHolderStillQualified(wallet) {
    const holderData = majorHolders.get(wallet);
    return holderData && holderData.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN;
}

function getAssignedBlockForHolder(wallet) {
    for (let i = 0; i < gameBlocks.length; i++) {
        if (gameBlocks[i].assignedHolder === wallet && gameBlocks[i].isGuaranteedGreen) {
            return i + 1;
        }
    }
    return null;
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
    if (consoleMessages.length > 100) consoleMessages.shift();
    broadcastUpdate();
}

async function fetchTokenSupply() {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);
        const supplyInfo = await connection.getTokenSupply(mintPublicKey);
        if (supplyInfo && supplyInfo.value) {
            tokenSupply = supplyInfo.value.uiAmount || 0;
            return tokenSupply;
        }
        return 0;
    } catch (e) {
        logToConsole(`Error fetching token supply: ${e.message}`, 'error');
        return 0;
    }
}

async function fetchMajorHolders() {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);
        const largestAccounts = await connection.getTokenLargestAccounts(mintPublicKey);
        
        if (!largestAccounts || !largestAccounts.value) {
            return new Map();
        }
        
        const holders = new Map();
        
        for (const account of largestAccounts.value) {
            try {
                const accountInfo = await connection.getAccountInfo(account.address);
                if (!accountInfo) continue;
                
                if (accountInfo.data.length >= 64) {
                    const ownerPubkey = new PublicKey(accountInfo.data.subarray(32, 64));
                    const owner = ownerPubkey.toString();
                    
                    const balanceInfo = await connection.getTokenAccountBalance(account.address);
                    if (balanceInfo && balanceInfo.value) {
                        const tokens = balanceInfo.value.uiAmount || 0;
                        const percentage = tokenSupply > 0 ? (tokens / tokenSupply) * 100 : 0;
                        
                        holders.set(owner, {
                            tokens: tokens,
                            percentage: percentage,
                            account: account.address.toString(),
                            lastUpdated: Date.now()
                        });
                    }
                }
            } catch (e) {
                // Silent error for individual account failures
            }
            await new Promise(r => setTimeout(r, 50));
        }
        
        majorHolders = holders;
        return holders;
        
    } catch (e) {
        return new Map();
    }
}

async function fetchTokenPrice() {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
        if (!response.ok) return false;
        
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            const pair = data.pairs[0];
            const price = parseFloat(pair.priceUsd) || 0;
            const isNewATH = price > allTimeHighPrice;
            
            if (isNewATH && price > 0) {
                allTimeHighPrice = price;
                logToConsole(`🚀 NEW ALL-TIME HIGH: $${price.toFixed(8)}`, 'success');
            }
            
            currentPrice = price;
            priceChange24h = pair.priceChange?.h24 || 0;
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function assignGuaranteedGreenBlocks() {
    const millionHolders = Array.from(majorHolders.entries())
        .filter(([wallet, data]) => data.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN);
    
    let newlyAssigned = 0;
    
    // Assign new guaranteed blocks for holders who don't have one yet
    for (const [wallet, holderData] of millionHolders) {
        if (!assignedHoldersThisGame.has(wallet)) {
            // Find first available hidden block
            for (let i = 0; i < TOTAL_BLOCKS; i++) {
                if (gameBlocks[i].status === 'hidden' && !gameBlocks[i].assignedHolder) {
                    gameBlocks[i].assignedHolder = wallet;
                    gameBlocks[i].isGuaranteedGreen = true;
                    assignedHoldersThisGame.add(wallet);
                    newlyAssigned++;
                    logToConsole(`🎯 Assigned guaranteed GREEN block ${i + 1} to ${wallet.substring(0, 8)}...`, 'success');
                    break;
                }
            }
        }
    }
    
    if (newlyAssigned > 0) {
        logToConsole(`✅ Assigned ${newlyAssigned} new guaranteed GREEN blocks`, 'success');
    }
    
    return newlyAssigned;
}

function validateGuaranteedBlocks() {
    let invalidatedBlocks = 0;
    
    // Check all assigned guaranteed blocks
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        const block = gameBlocks[i];
        if (block.assignedHolder && block.isGuaranteedGreen) {
            const holderWallet = block.assignedHolder;
            
            if (!isHolderStillQualified(holderWallet)) {
                if (block.status === 'hidden') {
                    // Block not yet revealed - remove assignment
                    block.assignedHolder = null;
                    block.isGuaranteedGreen = false;
                    assignedHoldersThisGame.delete(holderWallet);
                    invalidatedBlocks++;
                    logToConsole(`❌ Removed guaranteed block ${i + 1} from ${holderWallet.substring(0, 8)}... (no longer 1M+ holder)`, 'error');
                } else if (block.status === 'revealed') {
                    // Block already revealed - mark guaranteed status as invalid
                    block.isGuaranteedGreen = false;
                }
            }
        }
    }
    
    if (invalidatedBlocks > 0) {
        logToConsole(`🔄 Freed ${invalidatedBlocks} guaranteed blocks from former 1M+ holders`, 'info');
    }
    
    return invalidatedBlocks;
}

async function getTransactionDetails(signature) {
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        return tx;
    } catch (e) {
        return null;
    }
}

function calculateSolSpent(tx) {
    try {
        if (!tx?.meta || !tx.transaction) return { solSpent: 0, buyer: null };
        
        const meta = tx.meta;
        const accountKeys = tx.transaction.message.accountKeys || [];
        
        let solSpent = 0;
        let buyer = null;
        
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
        
        if (solSpent === 0 && meta.fee) {
            solSpent = meta.fee / LAMPORTS_PER_SOL;
            buyer = accountKeys[0]?.pubkey?.toString() || null;
        }
        
        return { solSpent: Math.max(solSpent, 0.0001), buyer };
    } catch (e) {
        return { solSpent: 0.0001, buyer: null };
    }
}

async function monitorNewTokenTransactions() {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);
        const signatures = await connection.getSignaturesForAddress(mintPublicKey, { limit: 5 });
        
        for (const sig of signatures) {
            if (processedTransactions.has(sig.signature)) continue;
            
            try {
                const tx = await getTransactionDetails(sig.signature);
                if (!tx || !tx.meta || tx.meta.err) {
                    processedTransactions.add(sig.signature);
                    continue;
                }
                
                const txTime = tx.blockTime ? tx.blockTime * 1000 : 0;
                const threeMinutesAgo = Date.now() - 3 * 60 * 1000;
                
                if (txTime < threeMinutesAgo) {
                    processedTransactions.add(sig.signature);
                    continue;
                }
                
                const purchase = await analyzeTokenPurchase(tx, sig.signature);
                if (purchase) {
                    processedTransactions.add(sig.signature);
                    return purchase;
                } else {
                    processedTransactions.add(sig.signature);
                }
                
            } catch (e) {
                processedTransactions.add(sig.signature);
            }
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

async function analyzeTokenPurchase(tx, signature) {
    try {
        if (!tx?.meta || !tx?.transaction) return null;
        
        const postTokenBalances = tx.meta?.postTokenBalances || [];
        const tokenTransfers = postTokenBalances.filter(balance =>
            balance?.mint === TOKEN_MINT &&
            balance?.uiTokenAmount?.uiAmount > 0
        );
        
        if (tokenTransfers.length === 0) return null;
        
        const { solSpent, buyer } = calculateSolSpent(tx);
        if (solSpent < 0.0005) return null;
        
        const purchases = [];
        for (const transfer of tokenTransfers) {
            const wallet = transfer.owner || 'unknown';
            const tokenAmount = transfer.uiTokenAmount?.uiAmount || 0;
            
            if (recentHolders.has(wallet)) continue;
            
            const purchaseDetails = {
                wallet: wallet,
                signature: signature,
                timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
                txTime: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                solAmount: solSpent,
                tokenAmount: tokenAmount,
                isMillionTokenHolder: isHolderStillQualified(wallet),
                holderTokens: majorHolders.has(wallet) ? majorHolders.get(wallet).tokens : 0
            };
            
            purchases.push(purchaseDetails);
            recentHolders.add(wallet);
        }
        
        return purchases.length > 0 ? purchases : null;
    } catch (e) {
        return null;
    }
}

function processGameBlock(purchase) {
    if (gameCompleted || currentBlockIndex >= TOTAL_BLOCKS) return;
    
    // Calculate how many blocks to open based on SOL spent (0.1 SOL = 1 block)
    let blocksToOpen = Math.floor(purchase.solAmount / MIN_SOL_FOR_BLOCK);
    
    // 1M+ token holders get at least 1 block
    if (purchase.isMillionTokenHolder) {
        blocksToOpen = Math.max(blocksToOpen, 1);
        logToConsole(`🏦 1M+ HOLDER: ${purchase.wallet.substring(0, 8)}... buying ${blocksToOpen} blocks`, 'success');
    }
    
    const actualBlocksToOpen = Math.min(blocksToOpen, TOTAL_BLOCKS - currentBlockIndex);
    
    if (actualBlocksToOpen > 0) {
        logToConsole(`💰 ${purchase.isMillionTokenHolder ? '🏦 ' : ''}${purchase.wallet.substring(0, 8)}... bought ${purchase.solAmount.toFixed(4)} SOL - Opening ${actualBlocksToOpen} blocks`, 'info');
        
        for (let i = 0; i < actualBlocksToOpen; i++) {
            if (currentBlockIndex >= TOTAL_BLOCKS) break;
            
            const currentBlock = gameBlocks[currentBlockIndex];
            let blockColor = 'red';
            let isGuaranteed = false;
            
            // Check if this block is guaranteed for this wallet
            if (currentBlock.assignedHolder === purchase.wallet && currentBlock.isGuaranteedGreen) {
                blockColor = 'green'; // Guaranteed green for the assigned holder
                isGuaranteed = true;
                assignedHoldersThisGame.delete(purchase.wallet);
                logToConsole(`🎯 GUARANTEED GREEN! ${purchase.wallet.substring(0, 8)}... claimed their block ${currentBlockIndex + 1}`, 'success');
            } else {
                // Regular block - calculate random chance at the moment of purchase
                blockColor = Math.random() < GREEN_CHANCE ? 'green' : 'red';
            }
            
            gameBlocks[currentBlockIndex] = {
                status: 'revealed',
                color: blockColor,
                purchase: purchase,
                blockValue: MIN_SOL_FOR_BLOCK,
                assignedHolder: currentBlock.assignedHolder,
                isGuaranteedGreen: isGuaranteed
            };
            
            if (blockColor === 'green') {
                winningWallets.push({
                    wallet: purchase.wallet,
                    solAmount: MIN_SOL_FOR_BLOCK,
                    totalPurchaseAmount: purchase.solAmount,
                    signature: purchase.signature,
                    timestamp: purchase.timestamp,
                    blockNumber: currentBlockIndex + 1,
                    isMillionTokenHolder: purchase.isMillionTokenHolder,
                    holderTokens: purchase.holderTokens,
                    isGuaranteed: isGuaranteed
                });
                
                if (isGuaranteed) {
                    logToConsole(`✅ GUARANTEED GREEN at block ${currentBlockIndex + 1}`, 'success');
                } else {
                    logToConsole(`🎯 REGULAR GREEN at block ${currentBlockIndex + 1}`, 'success');
                }
            } else {
                logToConsole(`💥 RED BLOCK at block ${currentBlockIndex + 1}`, 'info');
            }
            
            currentBlockIndex++;
            totalVolume += MIN_SOL_FOR_BLOCK;
            
            if (currentBlockIndex >= TOTAL_BLOCKS) {
                completeGame();
                break;
            }
        }
        
        broadcastUpdate();
    }
}

function completeGame() {
    gameCompleted = true;
    previousWinners = [...winningWallets];
    
    const dashboardData = getCurrentDashboardData();
    const totalGreenBlocks = dashboardData.stats.totalGreenBlocks;
    
    logToConsole(`🏆 GAME COMPLETED! ${winningWallets.length} winning blocks (${totalGreenBlocks} total green blocks)`, 'success');
    logToConsole(`🔄 Starting new game in 10 seconds...`, 'info');
    
    setTimeout(() => {
        startNewGame();
    }, 10000);
}

function startNewGame() {
    gameBlocks = Array(TOTAL_BLOCKS).fill(null).map(() => ({ 
        status: 'hidden', 
        color: null, 
        purchase: null,
        assignedHolder: null,
        isGuaranteedGreen: false
    }));
    currentBlockIndex = 0;
    gameCompleted = false;
    winningWallets = [];
    totalVolume = 0;
    assignedHoldersThisGame.clear();
    
    consoleMessages = consoleMessages.slice(-20);
    processedTransactions.clear();
    recentHolders.clear();
    
    logToConsole(`🔄 NEW GAME STARTED! 100 blocks ready`, 'success');
    logToConsole(`🎯 1M+ holders get guaranteed GREEN blocks assigned automatically`, 'info');
    logToConsole(`📊 Regular blocks: ${GREEN_CHANCE * 100}% green chance (calculated at purchase time)`, 'info');
    
    // Assign guaranteed blocks for current 1M+ holders
    assignGuaranteedGreenBlocks();
    broadcastUpdate();
}

app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>MINESWEEPER ATH - REAL-TIME BLOCK SYSTEM</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0a0a;
            color: #00ff41;
            font-family: 'JetBrains Mono', monospace;
            min-height: 100vh;
            overflow-x: auto;
            font-size: 12px;
            line-height: 1.4;
        }
        .terminal-container {
            padding: 20px;
            max-width: 1400px;
            margin: 0 auto;
            background: rgba(0, 0, 0, 0.9);
            border: 2px solid #00ff41;
            box-shadow: 0 0 20px #00ff4130;
        }
        .game-header {
            text-align: center;
            margin-bottom: 30px;
            color: #ffff00;
            font-size: 24px;
            font-weight: 700;
            text-shadow: 0 0 10px #ffff0080;
        }
        .progress-section {
            margin: 20px 0;
            padding: 20px;
            border: 2px solid #00ffff;
            background: rgba(0, 255, 255, 0.05);
        }
        .progress-title {
            color: #00ffff;
            font-weight: 700;
            margin-bottom: 15px;
            text-align: center;
            font-size: 16px;
        }
        .progress-bar {
            width: 100%;
            height: 30px;
            background: #000;
            border: 2px solid #00ff41;
            position: relative;
            margin-bottom: 10px;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff41, #00ffff);
            width: 0%;
            transition: width 0.5s ease;
            position: relative;
        }
        .progress-fill::after {
            content: '';
            position: absolute;
            top: 0;
            right: 0;
            bottom: 0;
            width: 20%;
            background: linear-gradient(90deg, transparent, #ffff00, transparent);
            animation: shimmer 2s infinite;
        }
        @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }
        .progress-text {
            text-align: center;
            font-weight: 700;
            color: #00ffff;
            font-size: 14px;
        }
        .progress-details {
            text-align: center;
            font-size: 12px;
            color: #00ff41;
            opacity: 0.8;
            margin-top: 5px;
        }
        .minesweeper-grid {
            display: grid;
            grid-template-columns: repeat(10, 1fr);
            gap: 8px;
            margin: 20px 0;
            padding: 20px;
            border: 2px solid #ff00ff;
            background: rgba(255, 0, 255, 0.05);
        }
        .block {
            aspect-ratio: 1;
            border: 2px solid #444;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            background: #1a1a1a;
            position: relative;
            overflow: hidden;
            font-size: 14px;
        }
        .block.hidden {
            background: #2a2a2a;
            border-color: #666;
        }
        .block.hidden.assigned {
            background: linear-gradient(45deg, #1a1a1a, #004400);
            border-color: #00ff00;
            box-shadow: 0 0 15px #00ff0030;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { box-shadow: 0 0 5px #00ff0030; }
            50% { box-shadow: 0 0 20px #00ff0060; }
            100% { box-shadow: 0 0 5px #00ff0030; }
        }
        .block.hidden:hover {
            background: #3a3a3a;
            transform: scale(1.05);
        }
        .block.revealed.green {
            background: #00ff41;
            color: #000;
            border-color: #00cc33;
            box-shadow: 0 0 15px #00ff41;
            font-size: 16px;
            font-weight: bold;
        }
        .block.revealed.red {
            background: #ff4444;
            color: #000;
            border-color: #cc3333;
            box-shadow: 0 0 15px #ff4444;
            font-size: 16px;
            font-weight: bold;
        }
        .block.revealed.green.guaranteed {
            background: linear-gradient(45deg, #00ff41, #ffff00);
            box-shadow: 0 0 20px #ffff00;
            border-color: #ffff00;
            font-size: 16px;
            font-weight: bold;
        }
        .block-number {
            font-size: 12px;
            opacity: 0.7;
            font-weight: bold;
        }
        .block-wallet {
            font-size: 10px;
            position: absolute;
            bottom: 2px;
            left: 2px;
            right: 2px;
            text-align: center;
            background: rgba(0, 0, 0, 0.7);
            padding: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: bold;
        }
        .block-sol {
            font-size: 11px;
            position: absolute;
            top: 2px;
            right: 2px;
            background: rgba(0, 0, 0, 0.7);
            padding: 2px 4px;
            border-radius: 3px;
            font-weight: bold;
        }
        .block-guaranteed {
            font-size: 10px;
            position: absolute;
            bottom: 12px;
            left: 2px;
            right: 2px;
            text-align: center;
            background: rgba(255, 255, 0, 0.9);
            color: #000;
            padding: 2px;
            font-weight: bold;
        }
        .block-assigned {
            font-size: 8px;
            position: absolute;
            top: 2px;
            left: 2px;
            background: rgba(0, 255, 0, 0.9);
            color: #000;
            padding: 2px 3px;
            border-radius: 2px;
            font-weight: bold;
        }
        .block-holder {
            font-size: 9px;
            position: absolute;
            bottom: 15px;
            left: 2px;
            right: 2px;
            text-align: center;
            background: rgba(0, 0, 0, 0.8);
            padding: 1px;
            font-weight: bold;
        }
        .winners-section {
            margin: 20px 0;
            padding: 20px;
            border: 2px solid #ffff00;
            background: rgba(255, 255, 0, 0.05);
        }
        .previous-winners-section {
            margin: 20px 0;
            padding: 20px;
            border: 2px solid #00ffff;
            background: rgba(0, 255, 255, 0.05);
        }
        .holders-section {
            margin: 20px 0;
            padding: 20px;
            border: 2px solid #ff00ff;
            background: rgba(255, 0, 255, 0.05);
        }
        .winners-title {
            color: #ffff00;
            font-weight: 700;
            margin-bottom: 15px;
            text-align: center;
            font-size: 16px;
        }
        .previous-winners-title {
            color: #00ffff;
            font-weight: 700;
            margin-bottom: 15px;
            text-align: center;
            font-size: 16px;
        }
        .holders-title {
            color: #ff00ff;
            font-weight: 700;
            margin-bottom: 15px;
            text-align: center;
            font-size: 16px;
        }
        .winner-list, .holders-list {
            max-height: 200px;
            overflow-y: auto;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 10px;
        }
        .winner-item {
            padding: 10px;
            background: rgba(255, 255, 0, 0.1);
            border-left: 3px solid #ffff00;
            font-size: 11px;
        }
        .winner-item.million-holder {
            background: rgba(255, 255, 0, 0.3);
            border-left: 3px solid #ff00ff;
        }
        .winner-item.guaranteed {
            background: rgba(0, 255, 0, 0.2);
            border-left: 3px solid #00ff00;
        }
        .previous-winner-item {
            padding: 8px;
            background: rgba(0, 255, 255, 0.1);
            border-left: 3px solid #00ffff;
            font-size: 10px;
            opacity: 0.8;
        }
        .holder-item {
            padding: 10px;
            background: rgba(255, 0, 255, 0.1);
            border-left: 3px solid #ff00ff;
            font-size: 11px;
        }
        .holder-item.assigned {
            background: rgba(0, 255, 0, 0.2);
            border-left: 3px solid #00ff00;
        }
        .holder-item.invalid {
            background: rgba(255, 0, 0, 0.1);
            border-left: 3px solid #ff0000;
            opacity: 0.6;
        }
        .winner-wallet, .holder-wallet {
            font-weight: 700;
            margin-bottom: 5px;
            word-break: break-all;
            font-size: 12px;
        }
        .winner-wallet a, .holder-wallet a {
            color: inherit;
            text-decoration: none;
        }
        .winner-wallet a:hover, .holder-wallet a:hover {
            text-decoration: underline;
        }
        .winner-details, .holder-details {
            font-size: 10px;
            color: #ccc;
        }
        .winner-details a, .holder-details a {
            color: #00ff41;
            text-decoration: none;
            margin-right: 10px;
        }
        .winner-details a:hover, .holder-details a:hover {
            text-decoration: underline;
        }
        .stats-section {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .stat-card {
            padding: 15px;
            border: 1px solid #00ff41;
            background: rgba(0, 255, 65, 0.05);
            text-align: center;
        }
        .stat-value {
            font-size: 18px;
            font-weight: 700;
            color: #ffff00;
            margin: 5px 0;
        }
        .stat-label {
            font-size: 11px;
            color: #00ff41;
            opacity: 0.8;
        }
        .console-section {
            background: #000;
            border: 2px solid #00ff41;
            height: 200px;
            overflow-y: auto;
            margin: 20px 0;
            padding: 10px;
            font-size: 10px;
        }
        .console-line {
            margin: 2px 0;
            word-break: break-all;
        }
        .console-info { color: #00ff41; }
        .console-success { color: #ffff00; }
        .console-error { color: #ff4444; }
        .console-warning { color: #ffaa00; }
        .connection-status {
            position: fixed;
            top: 10px;
            right: 10px;
            padding: 5px 10px;
            background: #000;
            border: 1px solid #00ff41;
            font-size: 10px;
        }
        .status-connected { color: #00ff41; }
        .status-disconnected { color: #ff4444; }
        .game-rules {
            margin: 20px 0;
            padding: 15px;
            border: 2px solid #00ff41;
            background: rgba(0, 255, 65, 0.05);
        }
        .rules-title {
            color: #00ff41;
            font-weight: 700;
            margin-bottom: 10px;
            text-align: center;
        }
        .rules-list {
            font-size: 11px;
            line-height: 1.6;
        }
        @media (max-width: 768px) {
            .minesweeper-grid {
                grid-template-columns: repeat(5, 1fr);
            }
            .terminal-container {
                padding: 10px;
                margin: 5px;
            }
            .winner-list, .holders-list {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="connection-status">
        <span id="connection-indicator">●</span> 
        <span id="connection-text">CONNECTING...</span>
    </div>
    
    <div class="terminal-container">
        <div class="game-header">
            🎮 MINESWEEPER ATH - REAL-TIME BLOCK SYSTEM 🎮
        </div>
        
        <div class="game-rules">
            <div class="rules-title">🎯 REAL-TIME BLOCK SYSTEM</div>
            <div class="rules-list">
                • Each 0.1 SOL spent opens 1 block (0.5 SOL = 5 blocks, 0.72 SOL = 7 blocks)<br>
                • 1M+ token holders: GUARANTEED GREEN blocks assigned automatically<br>
                • Regular blocks: ${GREEN_CHANCE * 100}% green chance (calculated at purchase time)<br>
                • Guaranteed blocks show assigned wallet address clearly<br>
                • Real-time holder validation - blocks turn red if holder loses tokens<br>
                • Progress counts: Revealed + Valid Guaranteed green blocks
            </div>
        </div>
        
        <div class="progress-section">
            <div class="progress-title">GREEN BLOCKS PROGRESS (Revealed + Guaranteed)</div>
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill"></div>
            </div>
            <div class="progress-text" id="progress-text">0/100 Green Blocks (0%)</div>
            <div class="progress-details" id="progress-details">Loading progress details...</div>
        </div>
        
        <div class="minesweeper-grid" id="minesweeper-grid"></div>
        
        <div class="holders-section" id="holders-section" style="display: none;">
            <div class="holders-title">🏦 1M+ TOKEN HOLDERS - REAL-TIME STATUS 🏦</div>
            <div class="holders-list" id="holders-list"></div>
        </div>
        
        <div class="winners-section" id="winners-section" style="display: none;">
            <div class="winners-title">🏆 CURRENT GAME WINNERS 🏆</div>
            <div class="winner-list" id="winner-list"></div>
        </div>
        
        <div class="previous-winners-section" id="previous-winners-section" style="display: none;">
            <div class="previous-winners-title">📋 PREVIOUS GAME WINNERS 📋</div>
            <div class="winner-list" id="previous-winner-list"></div>
        </div>
        
        <div class="stats-section">
            <div class="stat-card">
                <div class="stat-label">TOTAL VOLUME</div>
                <div class="stat-value" id="total-volume">0.00 SOL</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">CURRENT PRICE</div>
                <div class="stat-value" id="current-price">$0.00000000</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">TOTAL GREEN BLOCKS</div>
                <div class="stat-value" id="total-green">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">VALID GUARANTEED</div>
                <div class="stat-value" id="valid-guaranteed">0</div>
            </div>
        </div>
        
        <div class="console-section" id="console-output">
            <div class="console-line console-info">Initializing Real-Time Block System...</div>
        </div>
    </div>

    <script>
        let ws;
        
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
            
            ws.onopen = () => {
                document.getElementById('connection-indicator').className = 'status-connected';
                document.getElementById('connection-text').textContent = 'CONNECTED';
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                updateGame(data);
            };
            
            ws.onclose = () => {
                document.getElementById('connection-indicator').className = 'status-disconnected';
                document.getElementById('connection-text').textContent = 'RECONNECTING...';
                setTimeout(connectWebSocket, 3000);
            };
        }
        
        function createBlocksGrid() {
            const grid = document.getElementById('minesweeper-grid');
            grid.innerHTML = '';
            for (let i = 0; i < 100; i++) {
                const block = document.createElement('div');
                block.className = 'block hidden';
                block.id = 'block-' + i;
                block.innerHTML = '<span class="block-number">' + (i + 1) + '</span>';
                grid.appendChild(block);
            }
        }
        
        function updateGame(data) {
            const { gameData, stats, consoleMessages } = data;
            
            document.getElementById('progress-fill').style.width = gameData.progress + '%';
            document.getElementById('progress-text').textContent = 
                \`\${gameData.totalGreenBlocks}/100 Green Blocks (\${gameData.progress.toFixed(1)}%)\`;
            document.getElementById('progress-details').textContent = 
                \`\${gameData.revealedGreenBlocks} Revealed Green + \${gameData.guaranteedGreenBlocks} Guaranteed Green = \${gameData.totalGreenBlocks} Total Green Blocks\`;
            
            document.getElementById('total-volume').textContent = stats.totalVolume.toFixed(2) + ' SOL';
            document.getElementById('current-price').textContent = '\$' + stats.currentPrice.toFixed(8);
            document.getElementById('total-green').textContent = stats.totalGreenBlocks;
            document.getElementById('valid-guaranteed').textContent = stats.validGuaranteedBlocks;
            
            // Update blocks grid
            gameData.blocks.forEach((block, index) => {
                const blockElement = document.getElementById('block-' + index);
                if (!blockElement) return;
                
                let blockClass = 'block';
                if (block.status === 'revealed') {
                    blockClass += ' revealed ' + block.color;
                    if (block.isGuaranteedGreen) blockClass += ' guaranteed';
                    
                    const shortWallet = block.purchase?.wallet ? block.purchase.wallet.substring(0, 6) + '...' + block.purchase.wallet.substring(block.purchase.wallet.length - 4) : 'Unknown';
                    const solAmount = block.blockValue ? block.blockValue.toFixed(4) : '0.1000';
                    
                    let blockContent = \`
                        <span class="block-number">\${index + 1}</span>
                        <div class="block-wallet" title="\${block.purchase?.wallet || 'Unknown'}">\${shortWallet}</div>
                        <div class="block-sol" title="\${solAmount} SOL">\${solAmount} SOL</div>
                        \${block.color === 'green' ? '🎯 GREEN' : '💥 RED'}
                    \`;
                    
                    if (block.isGuaranteedGreen) {
                        blockContent += \`<div class="block-guaranteed" title="Guaranteed Green Block">✅ GUARANTEED</div>\`;
                    }
                    
                    blockElement.innerHTML = blockContent;
                    blockElement.onclick = () => {
                        if (block.purchase?.signature) {
                            window.open(\`https://solscan.io/tx/\${block.purchase.signature}\`, '_blank');
                        }
                    };
                    blockElement.style.cursor = 'pointer';
                } else {
                    blockClass += ' hidden';
                    if (block.assignedHolder && block.isGuaranteedGreen) {
                        blockClass += ' assigned';
                        const shortWallet = block.assignedHolder.substring(0, 6) + '...' + block.assignedHolder.substring(block.assignedHolder.length - 4);
                        blockElement.innerHTML = \`
                            <span class="block-number">\${index + 1}</span>
                            <div class="block-assigned" title="Guaranteed Green Block">🏦 GUARANTEED</div>
                            <div class="block-holder" title="Assigned to \${block.assignedHolder}">\${shortWallet}</div>
                            <div style="color: #00ff00; font-size: 12px; margin-top: 5px; font-weight: bold;">GREEN</div>
                        \`;
                    } else {
                        blockElement.innerHTML = \`
                            <span class="block-number">\${index + 1}</span>
                            <div style="color: #666; font-size: 10px; margin-top: 5px;">HIDDEN</div>
                        \`;
                    }
                    blockElement.onclick = null;
                    blockElement.style.cursor = 'default';
                }
                
                blockElement.className = blockClass;
            });
            
            // Update holders list
            if (stats.millionTokenHolders && stats.millionTokenHolders.length > 0) {
                document.getElementById('holders-section').style.display = 'block';
                const holdersList = document.getElementById('holders-list');
                holdersList.innerHTML = stats.millionTokenHolders.map(holder => \`
                    <div class="holder-item \${holder.hasGuaranteedBlock ? 'assigned' : ''} \${!holder.stillQualified ? 'invalid' : ''}">
                        <div class="holder-wallet">
                            <a href="https://solscan.io/account/\${holder.wallet}" target="_blank">
                                \${holder.wallet} \${holder.hasGuaranteedBlock ? (holder.stillQualified ? ' ✅' : ' ❌') : ' ⏳'}
                            </a>
                        </div>
                        <div class="holder-details">
                            \${holder.tokens.toLocaleString()} Tokens | \${holder.percentage.toFixed(2)}% Supply
                            \${holder.assignedBlock ? \` | Block #\${holder.assignedBlock} \${holder.stillQualified ? '(Valid)' : '(Invalid)'}\` : ' | No block assigned'}
                        </div>
                    </div>
                \`).join('');
            }
            
            // Update winners lists
            if (gameData.winningWallets.length > 0) {
                document.getElementById('winners-section').style.display = 'block';
                const winnerList = document.getElementById('winner-list');
                winnerList.innerHTML = gameData.winningWallets.map(winner => \`
                    <div class="winner-item \${winner.isMillionTokenHolder ? 'million-holder' : ''} \${winner.isGuaranteed ? 'guaranteed' : ''}">
                        <div class="winner-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">
                                \${winner.wallet}\${winner.isMillionTokenHolder ? ' 🏦' : ''}\${winner.isGuaranteed ? ' ✅' : ''}
                            </a>
                        </div>
                        <div class="winner-details">
                            Block: \${winner.blockNumber} | SOL: \${winner.solAmount.toFixed(4)}
                            \${winner.isGuaranteed ? ' | 🎯 GUARANTEED GREEN' : ' | 🎯 REGULAR GREEN'}
                        </div>
                    </div>
                \`).join('');
            }
            
            if (gameData.previousWinners.length > 0) {
                document.getElementById('previous-winners-section').style.display = 'block';
                const previousWinnerList = document.getElementById('previous-winner-list');
                previousWinnerList.innerHTML = gameData.previousWinners.map(winner => \`
                    <div class="previous-winner-item">
                        <div class="winner-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">\${winner.wallet}\${winner.isMillionTokenHolder ? ' 🏦' : ''}</a>
                        </div>
                        <div class="winner-details">
                            Block: \${winner.blockNumber} | SOL: \${winner.solAmount.toFixed(4)}
                        </div>
                    </div>
                \`).join('');
            }
            
            // Update console
            const consoleOutput = document.getElementById('console-output');
            consoleOutput.innerHTML = '';
            consoleMessages.forEach(msg => {
                const line = document.createElement('div');
                line.className = 'console-line console-' + msg.type;
                line.textContent = '[' + new Date(msg.timestamp).toLocaleTimeString() + '] ' + msg.message;
                consoleOutput.appendChild(line);
            });
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }
        
        createBlocksGrid();
        connectWebSocket();
    </script>
</body>
</html>
    `);
});

app.get("/api/stats", (req, res) => {
    res.json(getCurrentDashboardData());
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    logToConsole(`🚀 Server running on port ${PORT}`, 'success');
    logToConsole(`🎮 Minesweeper ATH with Real-Time Block System Started`, 'info');
    logToConsole(`💰 0.1 SOL = 1 block | 0.5 SOL = 5 blocks | 0.72 SOL = 7 blocks`, 'info');
    logToConsole(`🏦 1M+ holders get guaranteed GREEN blocks`, 'info');
    logToConsole(`🎯 Regular blocks: ${GREEN_CHANCE * 100}% green chance (calculated at purchase)`, 'info');
});

async function initialize() {
    try {
        logToConsole(`📊 Initializing token data...`, 'info');
        await fetchTokenSupply();
        await fetchMajorHolders();
        logToConsole(`✅ Token data initialized`, 'success');
        
        const assigned = assignGuaranteedGreenBlocks();
        if (assigned > 0) {
            logToConsole(`🎯 Initially assigned ${assigned} guaranteed GREEN blocks to 1M+ holders`, 'success');
        }
    } catch (e) {
        logToConsole(`Error initializing: ${e.message}`, 'error');
    }
}

async function mainLoop() {
    await initialize();
    
    let holderCheckCounter = 0;
    
    while (true) {
        try {
            // Check holders every 5 cycles (25 seconds)
            if (holderCheckCounter % 5 === 0) {
                await fetchMajorHolders();
                const newlyAssigned = assignGuaranteedGreenBlocks();
                const invalidated = validateGuaranteedBlocks();
                
                if (newlyAssigned > 0 || invalidated > 0) {
                    broadcastUpdate();
                }
                holderCheckCounter = 0;
            }
            
            // Update price every 2 cycles (10 seconds)
            if (holderCheckCounter % 2 === 0) {
                await fetchTokenPrice();
            }
            
            // Check for new transactions
            const newPurchase = await monitorNewTokenTransactions();
            if (newPurchase) {
                for (const purchase of newPurchase) {
                    processGameBlock(purchase);
                }
            }
            
            holderCheckCounter++;
            
        } catch (e) {
            // Silent error
        }
        
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

mainLoop().catch(e => {
    logToConsole(`Fatal error: ${e.message}`, 'error');
    process.exit(1);
});
