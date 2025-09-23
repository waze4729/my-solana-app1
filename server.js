import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import express from "express";
import { WebSocketServer } from 'ws';
import http from 'http';

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "s5gUqwdD8d6JR8k8petVFYeYjsPgbkk6BF4Ndk7Z6uy";
const POLL_INTERVAL_MS = 5000; // Increased to reduce rate limiting
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 1000000; // 1M tokens
const GREEN_CHANCE = 0.33; // 33% chance for green

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
                // Rate limited - wait with exponential backoff
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
                // Get token account info to find the owner
                const accountInfo = await connection.getAccountInfo(account.address);
                if (!accountInfo) continue;
                
                // Token account layout: mint (32) + owner (32) + ...
                if (accountInfo.data.length >= 64) {
                    const ownerPubkey = new PublicKey(accountInfo.data.subarray(32, 64));
                    const owner = ownerPubkey.toString();
                    
                    // Get token balance
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
            await new Promise(r => setTimeout(r, 200)); // Rate limiting
        }
        
        majorHolders = holders;
        logToConsole(`📊 Found ${millionTokenHolderCount} holders with 1M+ tokens`, 'success');
        
    } catch (e) {
        logToConsole(`Error fetching major holders: ${e.message}`, 'error');
    }
}

async function fetchTokenPrice(mintAddress) {
    try {
        const res = await fetchWithRetry(`https://api.jup.ag/price/v3?ids=${mintAddress}`);
        const data = await res.json();
        
        if (data.data && data.data[mintAddress]) {
            const tokenData = data.data[mintAddress];
            const price = tokenData.price || 0;
            const isNewATH = price > allTimeHighPrice;
            
            if (isNewATH) {
                allTimeHighPrice = price;
                logToConsole(`🚀 NEW ALL-TIME HIGH: $${price.toFixed(8)}`, 'success');
            }
            
            return { 
                price, 
                timestamp: Date.now(), 
                isNewATH,
                priceChange24h: tokenData.priceChange24h || 0
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
        
        // Find the buyer by looking for the account that spent SOL
        let solSpent = 0;
        let buyer = null;
        
        // Method 1: Check fee payer first
        const feePayerIndex = 0;
        if (meta.preBalances && meta.postBalances && meta.preBalances.length > feePayerIndex) {
            const preBalance = meta.preBalances[feePayerIndex] / LAMPORTS_PER_SOL;
            const postBalance = meta.postBalances[feePayerIndex] / LAMPORTS_PER_SOL;
            const fee = meta.fee / LAMPORTS_PER_SOL;
            const spent = preBalance - postBalance - fee;
            
            if (spent > 0.001) { // Minimum threshold to avoid false positives
                solSpent = spent;
                buyer = accountKeys[feePayerIndex]?.pubkey?.toString() || null;
            }
        }
        
        // Method 2: Check all accounts for significant SOL decreases
        if (solSpent === 0) {
            for (let i = 0; i < accountKeys.length; i++) {
                if (meta.preBalances?.[i] && meta.postBalances?.[i]) {
                    const balanceChange = (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS_PER_SOL;
                    
                    // Look for significant SOL outflow (more than just fees)
                    if (balanceChange < -0.005) {
                        solSpent = Math.abs(balanceChange);
                        buyer = accountKeys[i]?.pubkey?.toString() || buyer;
                        break;
                    }
                }
            }
        }
        
        // Method 3: If still no SOL spent detected, use token transfer as indicator
        if (solSpent === 0 && meta.postTokenBalances) {
            // If there are token transfers but no SOL spent, it might be a transfer or other operation
            // Set a minimum value based on transaction fee
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
                
                await new Promise(r => setTimeout(r, 500)); // Rate limiting
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

function startNewGame() {
    gameBlocks = Array(TOTAL_BLOCKS).fill(null).map(() => ({ 
        status: 'hidden', 
        color: null, 
        purchase: null 
    }));
    currentBlockIndex = 0;
    gameCompleted = false;
    winningWallets = [];
    
    logToConsole(`🔄 NEW GAME STARTED! 100 blocks ready`, 'success');
    logToConsole(`🎯 1M+ token holders get 1 guaranteed green block per game`, 'info');
    logToConsole(`📊 Regular blocks: 33% green chance, 67% red chance`, 'info');
    broadcastUpdate();
}

// ... (HTML and Express setup remains the same as previous version)
// [The HTML and Express setup code would go here - it's identical to your previous version]

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
        /* ... (same CSS as before) ... */
    </style>
</head>
<body>
    <!-- ... (same HTML as before) ... -->
</body>
</html>
    `);
});

app.get("/api/stats", (req, res) => {
    res.json(getCurrentDashboardData());
});

const PORT = process.env.PORT || 1000;
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
