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

let allTimeHighPrice = 0;
let priceHistory = [];
let athPurchases = [];
let fullTransactions = [];
let consoleMessages = [];
let totalVolume = 0;
let gameBlocks = Array(TOTAL_BLOCKS).fill(null).map(() => ({ 
    status: 'hidden', 
    color: null, 
    purchase: null 
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
    const progress = Math.min(100, (currentBlockIndex / TOTAL_BLOCKS) * 100);
    
    const millionTokenHolders = Array.from(majorHolders.entries())
        .filter(([wallet, data]) => data.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN)
        .map(([wallet, data]) => ({
            wallet,
            tokens: data.tokens,
            percentage: data.percentage,
            guaranteedBlocks: 1
        }));
    
    return {
        priceHistory,
        allTimeHighPrice,
        athPurchases,
        fullTransactions,
        consoleMessages,
        gameData: {
            blocks: gameBlocks,
            currentBlockIndex,
            totalBlocks: TOTAL_BLOCKS,
            progress,
            gameCompleted,
            winningWallets,
            previousWinners
        },
        stats: {
            totalATHPurchases: athPurchases.filter(p => p.isATHPurchase).length,
            uniqueBuyers: new Set(athPurchases.filter(p => p.isATHPurchase).map(p => p.wallet)).size,
            trackedTransactions: fullTransactions.length,
            lastPrice: lastPrice.price || 0,
            priceChange24h: lastPrice.priceChange24h || 0,
            totalVolume,
            millionTokenHolders,
            tokenSupply,
            greenChance: GREEN_CHANCE * 100
        }
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

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429) {
                const waitTime = delay * Math.pow(2, i);
                logToConsole(`Rate limited, waiting ${waitTime}ms before retry ${i + 1}/${retries}`, 'info');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response;
        } catch (error) {
            if (i === retries - 1) throw error;
            const waitTime = delay * Math.pow(2, i);
            logToConsole(`Request failed, retrying in ${waitTime}ms: ${error.message}`, 'error');
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
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
            logToConsole('No token accounts found', 'error');
            return;
        }
        
        const holders = new Map();
        let millionTokenHolderCount = 0;
        
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
                            account: account.address.toString()
                        });
                        
                        if (tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN) {
                            millionTokenHolderCount++;
                            logToConsole(`🏦 1M+ Holder: ${owner.substring(0, 8)}... holds ${tokens.toLocaleString()} tokens (${percentage.toFixed(2)}%)`, 'info');
                        }
                    }
                }
            } catch (e) {
                logToConsole(`Error processing account ${account.address}: ${e.message}`, 'error');
            }
            await new Promise(r => setTimeout(r, 200));
        }
        
        majorHolders = holders;
        logToConsole(`📊 Found ${millionTokenHolderCount} holders with 1M+ tokens`, 'success');
        return holders;
        
    } catch (e) {
        logToConsole(`Error fetching major holders: ${e.message}`, 'error');
        return new Map();
    }
}

async function fetchTokenPrice(mintAddress) {
    try {
        // Use a more reliable price API with fallback
        const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const data = await res.json();
        
        if (data.pairs && data.pairs.length > 0) {
            const pair = data.pairs[0];
            const price = parseFloat(pair.priceUsd) || 0;
            const isNewATH = price > allTimeHighPrice;
            
            if (isNewATH) {
                allTimeHighPrice = price;
                logToConsole(`🚀 NEW ALL-TIME HIGH: $${price.toFixed(8)}`, 'success');
            }
            
            return { 
                price, 
                timestamp: Date.now(), 
                isNewATH,
                priceChange24h: pair.priceChange?.h24 || 0
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
        
        let solSpent = 0;
        let buyer = null;
        
        const feePayerIndex = 0;
        if (meta.preBalances && meta.postBalances && meta.preBalances.length > feePayerIndex) {
            const preBalance = meta.preBalances[feePayerIndex] / LAMPORTS_PER_SOL;
            const postBalance = meta.postBalances[feePayerIndex] / LAMPORTS_PER_SOL;
            const fee = meta.fee / LAMPORTS_PER_SOL;
            const spent = preBalance - postBalance - fee;
            
            if (spent > 0.001) {
                solSpent = spent;
                buyer = accountKeys[feePayerIndex]?.pubkey?.toString() || null;
            }
        }
        
        if (solSpent === 0) {
            for (let i = 0; i < accountKeys.length; i++) {
                if (meta.preBalances?.[i] && meta.postBalances?.[i]) {
                    const balanceChange = (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS_PER_SOL;
                    
                    if (balanceChange < -0.005) {
                        solSpent = Math.abs(balanceChange);
                        buyer = accountKeys[i]?.pubkey?.toString() || buyer;
                        break;
                    }
                }
            }
        }
        
        if (solSpent === 0 && meta.postTokenBalances) {
            solSpent = meta.fee ? meta.fee / LAMPORTS_PER_SOL : 0.0001;
            buyer = accountKeys[0]?.pubkey?.toString() || null;
        }
        
        return { solSpent: Math.max(solSpent, 0.0001), buyer };
    } catch (e) {
        logToConsole(`Error calculating SOL spent: ${e.message}`, 'error');
        return { solSpent: 0.0001, buyer: null };
    }
}

async function monitorNewTokenTransactions() {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);
        const signatures = await connection.getSignaturesForAddress(mintPublicKey, { limit: 10 });
        const newPurchases = [];
        
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
            if (solSpent > 0 && tokenAmount > 0) {
                pricePerToken = solSpent / tokenAmount;
            }
            
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
                isMillionTokenHolder: majorHolders.has(wallet) && majorHolders.get(wallet).tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN,
                holderTokens: majorHolders.has(wallet) ? majorHolders.get(wallet).tokens : 0
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

function processGameBlock(purchase) {
    if (gameCompleted || currentBlockIndex >= TOTAL_BLOCKS) return;
    
    let blocksToOpen = Math.floor(purchase.solAmount / MIN_SOL_FOR_BLOCK);
    
    // 1M+ token holders get 1 guaranteed green block
    if (purchase.isMillionTokenHolder) {
        blocksToOpen = Math.max(blocksToOpen, 1);
        logToConsole(`🏦 1M+ TOKEN HOLDER: ${purchase.wallet} (${purchase.holderTokens.toLocaleString()} tokens) gets 1 guaranteed green block`, 'success');
    }
    
    const actualBlocksToOpen = Math.min(blocksToOpen, TOTAL_BLOCKS - currentBlockIndex);
    
    if (actualBlocksToOpen > 0 && purchase.solAmount >= MIN_SOL_FOR_BLOCK) {
        logToConsole(`💰 ${purchase.isMillionTokenHolder ? '🏦 1M+ HOLDER ' : ''}Wallet ${purchase.wallet} bought ${purchase.solAmount.toFixed(4)} SOL - Opening ${actualBlocksToOpen} blocks`, 'info');
        
        for (let i = 0; i < actualBlocksToOpen; i++) {
            if (currentBlockIndex >= TOTAL_BLOCKS) break;
            
            let blockColor = 'red';
            if (purchase.isMillionTokenHolder && i === 0) {
                blockColor = 'green';
            } else {
                blockColor = Math.random() < GREEN_CHANCE ? 'green' : 'red';
            }
            
            gameBlocks[currentBlockIndex] = {
                status: 'revealed',
                color: blockColor,
                purchase: purchase,
                blockValue: MIN_SOL_FOR_BLOCK,
                isGuaranteedGreen: purchase.isMillionTokenHolder && i === 0
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
                    holderTokens: purchase.holderTokens
                });
                
                if (purchase.isMillionTokenHolder && i === 0) {
                    logToConsole(`🎯 GUARANTEED GREEN BLOCK! 1M+ Holder ${purchase.wallet} won at block ${currentBlockIndex + 1}`, 'success');
                } else {
                    logToConsole(`🎯 GREEN BLOCK! Wallet: ${purchase.wallet} won at block ${currentBlockIndex + 1}`, 'success');
                }
            } else {
                logToConsole(`💥 RED BLOCK! Wallet: ${purchase.wallet} at block ${currentBlockIndex + 1}`, 'error');
            }
            
            currentBlockIndex++;
            totalVolume += MIN_SOL_FOR_BLOCK;
            
            if (currentBlockIndex >= TOTAL_BLOCKS) {
                gameCompleted = true;
                previousWinners = [...winningWallets];
                logToConsole(`🏆 GAME COMPLETED! ${winningWallets.length} winning wallets`, 'success');
                logToConsole(`📋 Saving winners list and starting new game in 10 seconds...`, 'info');
                
                setTimeout(() => {
                    startNewGame();
                }, 10000);
                break;
            }
        }
        
        broadcastUpdate();
    }
}

function assignGuaranteedGreenBlocks() {
    const millionHolders = Array.from(majorHolders.entries())
        .filter(([wallet, data]) => data.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN);
    
    if (millionHolders.length === 0) {
        logToConsole(`🔄 No 1M+ holders found yet, will retry in 5 seconds...`, 'info');
        setTimeout(assignGuaranteedGreenBlocks, 5000);
        return;
    }
    
    logToConsole(`🎯 Assigned ${millionHolders.length} guaranteed green blocks for 1M+ token holders`, 'success');
}

function startNewGame() {
    gameBlocks = Array(TOTAL_BLOCKS).fill(null).map(() => ({ 
        status: 'hidden', 
        color: null, 
        purchase: null 
    }));
    currentBlockIndex = 0;
    gameCompleted = false;
    winningWallets = [];
    
    // Assign guaranteed green blocks for 1M+ holders at game start
    assignGuaranteedGreenBlocks();
    
    logToConsole(`🔄 NEW GAME STARTED! 100 blocks ready`, 'success');
    logToConsole(`🎯 1M+ token holders get 1 guaranteed green block per game`, 'info');
    logToConsole(`📊 Regular blocks: 33% green chance, 67% red chance`, 'info');
    broadcastUpdate();
}

app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>MINESWEEPER ATH GAME</title>
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
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff41, #00ffff);
            width: 0%;
            transition: width 0.5s ease;
        }
        .progress-text {
            text-align: center;
            font-weight: 700;
            color: #00ffff;
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
        }
        .block.hidden {
            background: #2a2a2a;
            border-color: #666;
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
        }
        .block.revealed.red {
            background: #ff4444;
            color: #000;
            border-color: #cc3333;
            box-shadow: 0 0 15px #ff4444;
        }
        .block.revealed.green.guaranteed {
            background: linear-gradient(45deg, #00ff41, #ffff00);
            box-shadow: 0 0 20px #ffff00;
        }
        .block-number {
            font-size: 10px;
            opacity: 0.7;
        }
        .block-wallet {
            font-size: 8px;
            position: absolute;
            bottom: 2px;
            left: 2px;
            right: 2px;
            text-align: center;
            background: rgba(0, 0, 0, 0.7);
            padding: 1px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .block-sol {
            font-size: 9px;
            position: absolute;
            top: 2px;
            right: 2px;
            background: rgba(0, 0, 0, 0.7);
            padding: 1px 3px;
            border-radius: 3px;
        }
        .block-multiplier {
            font-size: 8px;
            position: absolute;
            top: 2px;
            left: 2px;
            background: rgba(0, 0, 0, 0.7);
            padding: 1px 3px;
            border-radius: 3px;
            color: #ffff00;
        }
        .block-guaranteed {
            font-size: 8px;
            position: absolute;
            bottom: 12px;
            left: 2px;
            right: 2px;
            text-align: center;
            background: rgba(255, 255, 0, 0.8);
            color: #000;
            padding: 1px;
            font-weight: 700;
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
        .winner-wallet, .holder-wallet {
            font-weight: 700;
            margin-bottom: 5px;
            word-break: break-all;
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
            🎮 MINESWEEPER ATH GAME 🎮
        </div>
        
        <div class="game-rules">
            <div class="rules-title">🎯 GAME RULES</div>
            <div class="rules-list">
                • Each 0.1 SOL spent opens 1 block<br>
                • 1M+ token holders get 1 GUARANTEED green block per game<br>
                • Regular blocks: 33% green chance, 67% red chance<br>
                • Green blocks = WIN! Red blocks = LOSE<br>
                • Game completes when all 100 blocks are opened<br>
                • 1M+ holders: automatically assigned green block at game start<br>
                • If no holder data, system retries every 5 seconds
            </div>
        </div>
        
        <div class="progress-section">
            <div class="progress-title">GAME PROGRESS</div>
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill"></div>
            </div>
            <div class="progress-text" id="progress-text">0/100 Blocks (0%)</div>
        </div>
        
        <div class="minesweeper-grid" id="minesweeper-grid"></div>
        
        <div class="holders-section" id="holders-section" style="display: none;">
            <div class="holders-title">🏦 1M+ TOKEN HOLDERS 🏦</div>
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
                <div class="stat-label">GREEN CHANCE</div>
                <div class="stat-value" id="green-chance">33%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">1M+ HOLDERS</div>
                <div class="stat-value" id="million-holders">0</div>
            </div>
        </div>
        
        <div class="console-section" id="console-output">
            <div class="console-line console-info">Initializing Minesweeper ATH Game...</div>
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
                \`\${gameData.currentBlockIndex}/\${gameData.totalBlocks} Blocks (\${gameData.progress.toFixed(1)}%)\`;
            
            document.getElementById('total-volume').textContent = stats.totalVolume.toFixed(2) + ' SOL';
            document.getElementById('current-price').textContent = '\$' + stats.lastPrice.toFixed(8);
            document.getElementById('green-chance').textContent = stats.greenChance + '%';
            document.getElementById('million-holders').textContent = stats.millionTokenHolders.length;
            
            gameData.blocks.forEach((block, index) => {
                const blockElement = document.getElementById('block-' + index);
                if (!blockElement) return;
                
                if (block.status === 'revealed' && block.purchase) {
                    const blockClass = 'block revealed ' + block.color + (block.isGuaranteedGreen ? ' guaranteed' : '');
                    blockElement.className = blockClass;
                    
                    const shortWallet = block.purchase.wallet.substring(0, 4) + '...' + block.purchase.wallet.substring(block.purchase.wallet.length - 4);
                    const solAmount = block.blockValue ? block.blockValue.toFixed(4) : '0.1000';
                    
                    let blockContent = \`
                        <span class="block-number">\${index + 1}</span>
                        <div class="block-wallet" title="\${block.purchase.wallet}">\${shortWallet}</div>
                        <div class="block-sol" title="\${solAmount} SOL">\${solAmount} SOL</div>
                        <div class="block-multiplier" title="Part of \${block.purchase.solAmount.toFixed(4)} SOL purchase">×\${Math.floor(block.purchase.solAmount / 0.1)}</div>
                        \${block.color === 'green' ? '🎯' : '💥'}
                    \`;
                    
                    if (block.isGuaranteedGreen) {
                        blockContent += \`<div class="block-guaranteed" title="1M+ Token Holder">🏦 1M+</div>\`;
                    }
                    
                    blockElement.innerHTML = blockContent;
                    
                    blockElement.onclick = () => {
                        window.open(\`https://solscan.io/tx/\${block.purchase.signature}\`, '_blank');
                    };
                    blockElement.style.cursor = 'pointer';
                    blockElement.title = \`Click to view transaction\\nWallet: \${block.purchase.wallet}\\nBlock Value: \${solAmount} SOL\\nTotal Purchase: \${block.purchase.solAmount.toFixed(4)} SOL\\nBlock: \${index + 1}\${block.isGuaranteedGreen ? '\\n🏦 GUARANTEED GREEN (1M+ holder)' : ''}\`;
                } else {
                    blockElement.className = 'block hidden';
                    blockElement.innerHTML = '<span class="block-number">' + (index + 1) + '</span>';
                    blockElement.onclick = null;
                    blockElement.style.cursor = 'default';
                    blockElement.title = 'Hidden Block';
                }
            });
            
            if (stats.millionTokenHolders && stats.millionTokenHolders.length > 0) {
                document.getElementById('holders-section').style.display = 'block';
                const holdersList = document.getElementById('holders-list');
                holdersList.innerHTML = stats.millionTokenHolders.map(holder => \`
                    <div class="holder-item">
                        <div class="holder-wallet">
                            <a href="https://solscan.io/account/\${holder.wallet}" target="_blank">\${holder.wallet}</a>
                        </div>
                        <div class="holder-details">
                            <span style="color: #ff00ff">\${holder.tokens.toLocaleString()} Tokens</span> | 
                            \${holder.percentage.toFixed(2)}% Supply | 
                            Guaranteed: 1 Green Block
                        </div>
                    </div>
                \`).join('');
            } else {
                document.getElementById('holders-section').style.display = 'none';
            }
            
            if (gameData.winningWallets.length > 0) {
                document.getElementById('winners-section').style.display = 'block';
                const winnerList = document.getElementById('winner-list');
                winnerList.innerHTML = gameData.winningWallets.map(winner => \`
                    <div class="winner-item \${winner.isMillionTokenHolder ? 'million-holder' : ''}">
                        <div class="winner-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">\${winner.wallet}\${winner.isMillionTokenHolder ? ' 🏦' : ''}</a>
                        </div>
                        <div class="winner-details">
                            <a href="https://solscan.io/tx/\${winner.signature}" target="_blank" title="View Transaction">📝 TX</a>
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank" title="View Account">👤 Account</a>
                            Block SOL: \${winner.solAmount.toFixed(4)} | Total Purchase: \${winner.totalPurchaseAmount.toFixed(4)} SOL | Block: \${winner.blockNumber} | Time: \${new Date(winner.timestamp).toLocaleTimeString()}
                            \${winner.isMillionTokenHolder ? \` | 🏦 \${winner.holderTokens.toLocaleString()} tokens\` : ''}
                        </div>
                    </div>
                \`).join('');
            } else {
                document.getElementById('winners-section').style.display = 'none';
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
                            SOL: \${winner.solAmount.toFixed(4)} | Total: \${winner.totalPurchaseAmount.toFixed(4)} SOL | Block: \${winner.blockNumber}
                        </div>
                    </div>
                \`).join('');
            } else {
                document.getElementById('previous-winners-section').style.display = 'none';
            }
            
            if (gameData.gameCompleted) {
                document.getElementById('progress-text').innerHTML += ' <span style="color:#ffff00">🏆 GAME COMPLETED!</span>';
            }
            
            const consoleOutput = document.getElementById('console-output');
            consoleOutput.innerHTML = '';
            consoleMessages.slice(-15).forEach(msg => {
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
    logToConsole(`🎮 Minesweeper ATH Game Started - ${TOTAL_BLOCKS} blocks`, 'info');
    logToConsole(`⚡ Each 0.1 SOL opens 1 block`, 'info');
    logToConsole(`🏦 1M+ token holders get 1 guaranteed green block per game`, 'info');
    logToConsole(`🎯 Regular blocks: 33% green chance, 67% red chance`, 'info');
});

async function initializeTokenData() {
    try {
        logToConsole(`📊 Fetching token supply and 1M+ token holders...`, 'info');
        await fetchTokenSupply();
        await fetchMajorHolders();
        logToConsole(`✅ Token data initialized - Supply: ${tokenSupply.toLocaleString()} tokens`, 'success');
    } catch (e) {
        logToConsole(`Error initializing token data: ${e.message}`, 'error');
    }
}

async function loop() {
    await initializeTokenData();
    
    // Refresh token data every 30 minutes
    setInterval(async () => {
        await fetchTokenSupply();
        await fetchMajorHolders();
    }, 30 * 60 * 1000);
    
    let currentPriceData = null;
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
                        purchase.isMillionTokenHolder = majorHolders.has(purchase.wallet) && majorHolders.get(purchase.wallet).tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN;
                        purchase.holderTokens = majorHolders.has(purchase.wallet) ? majorHolders.get(purchase.wallet).tokens : 0;
                        athPurchases.push(purchase);
                        
                        processGameBlock(purchase);
                        
                        if (purchase.isATHPurchase) {
                            logToConsole(`🎯 ATH Purchase: ${purchase.wallet} - ${purchase.solAmount.toFixed(4)} SOL`, 'success');
                        }
                    }
                }
                broadcastUpdate();
            }
            
            if (processedTransactions.size > 10000) {
                const toRemove = Array.from(processedTransactions).slice(0, 5000);
                toRemove.forEach(sig => processedTransactions.delete(sig));
            }
            if (recentHolders.size > 5000) {
                recentHolders.clear();
            }
        } catch (e) {
            logToConsole(`Error in main loop: ${e.message}`, 'error');
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

loop().catch(e => {
    logToConsole(`Fatal error: ${e.message}`, 'error');
    process.exit(1);
});
