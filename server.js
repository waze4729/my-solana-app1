import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import express from "express";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { WebSocketServer } from 'ws';
import http from 'http';
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";

const TOKEN_MINT = "FwGQ5RSadrBpLRxuuaJdvsXX3q92bKe4Wuoz9FLYpump";
const POLL_INTERVAL_MS = 2500;
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 10000000;
const MAX_TOKENS_FOR_GUARANTEED_GREEN = 31000000; // 20 million to include those 10M holders
const GREEN_CHANCE = 0.33;
const creatorConnection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sdk = new OnlinePumpSdk(creatorConnection);
let creatorFees = 0;
let lastFeesCheck = 0;
// Get wallet from environment variable
const walletSecretKey = JSON.parse(process.env.WALLET_SECRET_KEY);
const SECRET_KEY = new Uint8Array(walletSecretKey);
const wallet = Keypair.fromSecretKey(SECRET_KEY);
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

async function distributeFees() {
    try {
        // 1. Get total creator fees
        const totalFeesLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
        const totalFeesSOL = Number(totalFeesLamports) / LAMPORTS_PER_SOL;
        
        logToConsole(`💰 Total fees to distribute: ${totalFeesSOL.toFixed(4)} SOL`, 'success');

        // 2. Calculate 1% value
        const onePercentSOL = totalFeesSOL * 0.001;
        const onePercentLamports = Math.floor(onePercentSOL * LAMPORTS_PER_SOL);

        logToConsole(`📊 1% value: ${onePercentSOL.toFixed(4)} SOL (${onePercentLamports} lamports)`, 'info');

        // 3. Group winners by wallet and count their green blocks
        const winnerMap = new Map();
        
        winningWallets.forEach(winner => {
            if (!winnerMap.has(winner.wallet)) {
                winnerMap.set(winner.wallet, {
                    wallet: winner.wallet,
                    greenBlocks: 0,
                    totalPercentage: 0
                });
            }
            const walletData = winnerMap.get(winner.wallet);
            walletData.greenBlocks += 1;
            walletData.totalPercentage = walletData.greenBlocks; // 1% per block
        });

        const uniqueWinners = Array.from(winnerMap.values());
        
        logToConsole(`🎯 Distributing to ${uniqueWinners.length} unique winners with ${winningWallets.length} total green blocks`, 'info');

        // 4. Create distribution transactions
        const transaction = new Transaction();
        let totalDistributed = 0;

        // Add fee collection instructions first
        const collectInstructions = await sdk.collectCoinCreatorFeeInstructions(wallet.publicKey);
        transaction.add(...collectInstructions);

        // Add transfer instructions for each winner
        for (const winner of uniqueWinners) {
            const winnerAmountLamports = onePercentLamports * winner.greenBlocks;
            const winnerAmountSOL = winnerAmountLamports / LAMPORTS_PER_SOL;
            
            if (winnerAmountLamports > 0) {
                const transferInstruction = SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: new PublicKey(winner.wallet),
                    lamports: winnerAmountLamports
                });
                
                transaction.add(transferInstruction);
                totalDistributed += winnerAmountSOL;
                
                logToConsole(`🎁 Sending ${winnerAmountSOL.toFixed(4)} SOL to ${winner.wallet.substring(0, 8)}... (${winner.greenBlocks} blocks = ${winner.totalPercentage}%)`, 'success');
            }
        }

        // 5. Send the transaction
        if (transaction.instructions.length > 1) { // More than just the collect instruction
            logToConsole(`🚀 Sending distribution transaction...`, 'info');
            
            const signature = await sendAndConfirmTransaction(
                connection, 
                transaction, 
                [wallet],
                { commitment: "confirmed" }
            );
            
            logToConsole(`✅ Distribution completed! TX: https://solscan.io/tx/${signature}`, 'success');
            logToConsole(`💰 Total distributed: ${totalDistributed.toFixed(4)} SOL`, 'success');
            
            // Reset fees counter
            creatorFees = 0;
        } else {
            logToConsole(`❌ No fees to distribute`, 'warning');
        }

    } catch (error) {
        logToConsole(`❌ Distribution failed: ${error.message}`, 'error');
    }
}
let cachedFees = 0;
let lastFeesFetchTime = 0;
const CACHE_DURATION = 30000; // 30 seconds

async function fetchCreatorFees() {
    const now = Date.now();
    
    // Return cached value if within 30 seconds
    if (now - lastFeesFetchTime < CACHE_DURATION) {
        return cachedFees;
    }
    
    try {
        const balanceLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
        const balanceSol = Number(balanceLamports) / LAMPORTS_PER_SOL;
        
        // Update cache
        cachedFees = balanceSol;
        lastFeesFetchTime = now;
        creatorFees = balanceSol;
        
        return balanceSol;
    } catch (err) {
        console.error("Error fetching creator fees:", err);
        
        // Return cached value even if it's old when error occurs
        return cachedFees;
    }
}
function getCurrentDashboardData() {
    const revealedBlocks = gameBlocks.filter(block => block.status === 'revealed');
    const revealedGreenBlocks = revealedBlocks.filter(block => block.color === 'green').length;
    const totalOccupiedBlocks = revealedBlocks.length;
    
    const totalGreenBlocks = revealedGreenBlocks;
    const progress = Math.min(100, (totalOccupiedBlocks / TOTAL_BLOCKS) * 100);
    
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
        totalGreenBlocks: totalGreenBlocks,
        totalOccupiedBlocks: totalOccupiedBlocks
    },
    stats: {
        uniqueBuyers: new Set(winningWallets.map(p => p.wallet)).size,
        totalBlocksOpened: currentBlockIndex,
        currentPrice: currentPrice,
        priceChange24h: priceChange24h,
        creatorFees: creatorFees, // ← Changed from totalVolume
        millionTokenHolders,
        tokenSupply,
        greenChance: GREEN_CHANCE * 100,
        blocksRemaining: TOTAL_BLOCKS - currentBlockIndex,
        assignedGuaranteedBlocks: assignedHoldersThisGame.size,
        revealedGreenBlocks: revealedGreenBlocks,
        totalGreenBlocks: totalGreenBlocks,
        totalOccupiedBlocks: totalOccupiedBlocks
    }
};
}

function isHolderStillQualified(wallet) {
    const holderData = majorHolders.get(wallet);
    return holderData && 
           holderData.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN && 
           holderData.tokens <= MAX_TOKENS_FOR_GUARANTEED_GREEN;
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
        const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        
        // Get all token accounts for the mint
        const accounts = await connection.getParsedProgramAccounts(
            tokenProgramId,
            {
                filters: [
                    { dataSize: 165 }, // SPL Token Account size
                    { memcmp: { offset: 0, bytes: mintPublicKey.toBase58() } } // Mint address at offset 0
                ]
            }
        );
        
        const holders = new Map();
        for (const acc of accounts) {
            const info = acc.account.data.parsed.info;
            const tokens = Number(info.tokenAmount.uiAmount || 0);
            const owner = info.owner;
            const percentage = tokenSupply > 0 ? (tokens / tokenSupply) * 100 : 0;

            // Only add if balance > 0
            if (tokens > 0) {
                holders.set(owner, {
                    tokens,
                    percentage,
                    account: acc.pubkey.toBase58(),
                    lastUpdated: Date.now()
                });
            }
        }

        majorHolders = holders;
        return holders;
    } catch (e) {
        logToConsole(`Error in fetchMajorHolders: ${e.message}`, 'error');
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

function assignFreeGreenBlocks() {
    const qualifiedHolders = Array.from(majorHolders.entries())
        .filter(([wallet, data]) => 
            data.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN && 
            data.tokens <= MAX_TOKENS_FOR_GUARANTEED_GREEN
        );
    
    let newlyAssigned = 0;
    
    for (const [wallet, holderData] of qualifiedHolders) {
        if (!assignedHoldersThisGame.has(wallet)) {
            // Find first available hidden block
            for (let i = 0; i < TOTAL_BLOCKS; i++) {
                if (gameBlocks[i].status === 'hidden' && !gameBlocks[i].assignedHolder) {
                    // AUTO-REVEAL FREE GREEN BLOCK FOR HOLDER
                    gameBlocks[i] = {
                        status: 'revealed',
                        color: 'green',
                        purchase: null, // No purchase - FREE block
                        assignedHolder: wallet,
                        isGuaranteedGreen: true
                    };
                    
                    assignedHoldersThisGame.add(wallet);
                    newlyAssigned++;
                    
                    // Add to winning wallets for FREE
                    winningWallets.push({
                        wallet: wallet,
                        solAmount: 0,
                        totalPurchaseAmount: 0,
                        signature: 'FREE_GUARANTEED',
                        timestamp: new Date().toISOString(),
                        blockNumber: i + 1,
                        isMillionTokenHolder: true,
                        holderTokens: holderData.tokens,
                        isGuaranteed: true,
                        isFree: true
                    });
                    
                    logToConsole(`🎯 FREE GREEN BLOCK ${i + 1} for ${wallet.substring(0, 8)}... (${holderData.tokens.toLocaleString()} tokens)`, 'success');
                    break;
                }
            }
        }
    }
    
    if (newlyAssigned > 0) {
        logToConsole(`✅ Assigned ${newlyAssigned} FREE green blocks for 1M-3M token holders`, 'success');
    }
    
    return newlyAssigned;
}

function validateGuaranteedBlocks() {
    let invalidatedBlocks = 0;
    
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        const block = gameBlocks[i];
        if (block.assignedHolder && block.isGuaranteedGreen) {
            const holderWallet = block.assignedHolder;
            const holderData = majorHolders.get(holderWallet);
            
            const isStillQualified = holderData && 
                                   holderData.tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN && 
                                   holderData.tokens <= MAX_TOKENS_FOR_GUARANTEED_GREEN;
            
            if (!isStillQualified) {
                // Convert guaranteed green block to red
                gameBlocks[i] = {
                    status: 'revealed',
                    color: 'red',
                    purchase: null,
                    assignedHolder: null,
                    isGuaranteedGreen: false
                };
                
                // Remove from winning wallets
                winningWallets = winningWallets.filter(w => !(w.blockNumber === i + 1 && w.isFree));
                
                assignedHoldersThisGame.delete(holderWallet);
                invalidatedBlocks++;
                
                logToConsole(`❌ FREE green block ${i + 1} turned RED (holder no longer qualified)`, 'error');
            }
        }
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
}function calculateSolSpent(tx) {
    try {
        if (!tx?.meta || !tx.transaction) return { solSpent: 0, buyer: null };
        
        const meta = tx.meta;
        const accountKeys = tx.transaction.message.staticAccountKeys || 
                           tx.transaction.message.accountKeys || [];
        
        let solSpent = 0;
        let buyer = null;
        
        // Look for significant SOL decreases (more than just fee)
        for (let i = 0; i < accountKeys.length; i++) {
            if (meta.preBalances?.[i] !== undefined && meta.postBalances?.[i] !== undefined) {
                const balanceChange = (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS_PER_SOL;
                
                // Significant SOL spent (more than 0.05 SOL)
                if (balanceChange < -0.05) {
                    solSpent = Math.abs(balanceChange);
                    buyer = accountKeys[i]?.toString() || buyer;
                    break;
                }
            }
        }
        
        // If no significant change found, use fee as minimum
        if (solSpent === 0 && meta.fee) {
            solSpent = meta.fee / LAMPORTS_PER_SOL;
            buyer = accountKeys[0]?.toString() || null;
        }
        
        return { 
            solSpent: Math.max(solSpent, 0.0001), 
            buyer 
        };
    } catch (e) {
        return { solSpent: 0.0001, buyer: null };
    }
}
async function monitorNewTokenTransactions() {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);
        
        // Check recent transactions for the token mint (real-time purchases)
        const recentSignatures = await connection.getSignaturesForAddress(
            mintPublicKey, 
            { limit: 10 } // Check last 10 transactions
        );
        
        let purchases = [];

        // Process each transaction one by one
        for (const sigInfo of recentSignatures) {
            const signature = sigInfo.signature;
            
            // Skip if already processed
            if (processedTransactions.has(signature)) continue;
            
            const tx = await getTransactionDetails(signature);
            if (!tx) continue;

            // Analyze if this is a purchase transaction
            const purchase = await analyzeTokenPurchase(tx, signature);
            if (purchase) {
                purchases.push(purchase);
                processedTransactions.add(signature);
                logToConsole(`🛒 NEW PURCHASE: ${purchase.wallet.substring(0, 8)}... spent ${purchase.solAmount.toFixed(4)} SOL`, 'success');
            }
            
            // Small delay between processing transactions
            await new Promise(r => setTimeout(r, 500));
        }

        return purchases.length > 0 ? purchases : null;
    } catch (e) {
        logToConsole(`Error in monitorNewTokenTransactions: ${e.message}`, 'error');
        return null;
    }
}
// Process individual account in batch
async function processAccountBatch(tokenAccountPubkey, tokenAmount, tokenAccountKey) {
    try {
        const parsedAcct = await connection.getParsedAccountInfo(tokenAccountPubkey);
        const owner = parsedAcct.value?.data?.parsed?.info?.owner;
        
        if (owner && tokenAmount >= MIN_TOKENS_FOR_GUARANTEED_GREEN) {
            processedTransactions.add(tokenAccountKey);
            return {
                wallet: owner,
                signature: `HOLDER_${tokenAccountKey.substring(0, 8)}`,
                timestamp: new Date().toISOString(),
                txTime: Date.now(),
                solAmount: 0.1,
                tokenAmount: tokenAmount,
                isMillionTokenHolder: isHolderStillQualified(owner),
                holderTokens: majorHolders.has(owner) ? majorHolders.get(owner).tokens : tokenAmount
            };
        }
    } catch (e) {
        logToConsole(`Error processing account ${tokenAccountKey}: ${e.message}`, 'warning');
    }
    return null;
}
async function analyzeTokenPurchase(tx, signature) {
    try {
        if (!tx?.transaction || !tx.meta) return null;

        const { solSpent, buyer } = calculateSolSpent(tx);
        
        // Only consider purchases of 0.1 SOL or more (block purchases)
        if (solSpent < 0.09 || !buyer) return null;

        // Check if buyer is a major holder
        const isMillionTokenHolder = majorHolders.has(buyer) && 
                                   majorHolders.get(buyer).tokens >= MIN_TOKENS_FOR_GUARANTEED_GREEN;

        logToConsole(`🛒 Purchase detected: ${buyer.substring(0, 8)}... spent ${solSpent.toFixed(4)} SOL`, 'success');

        return {
            wallet: buyer,
            signature: signature,
            timestamp: new Date().toISOString(),
            txTime: Date.now(),
            solAmount: solSpent,
            isMillionTokenHolder: isMillionTokenHolder,
            holderTokens: isMillionTokenHolder ? majorHolders.get(buyer).tokens : 0
        };

    } catch (e) {
        logToConsole(`Error analyzing purchase: ${e.message}`, 'warning');
        return null;
    }
}

function processGameBlock(purchase) {
    if (gameCompleted) return;
    let blocksToOpen = Math.floor(purchase.solAmount / MIN_SOL_FOR_BLOCK);
    if (purchase.isMillionTokenHolder) {
        blocksToOpen = Math.max(blocksToOpen, 1);
        logToConsole(`🏦 1M-3M HOLDER: ${purchase.wallet.substring(0, 8)}... buying ${blocksToOpen} blocks`, 'success');
    }
    const availableBlocks = [];
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        if (gameBlocks[i].status === 'hidden' && !gameBlocks[i].assignedHolder) {
            availableBlocks.push(i);
        }
        if (availableBlocks.length >= blocksToOpen) break;
    }
    const actualBlocksToOpen = Math.min(blocksToOpen, availableBlocks.length);
    if (actualBlocksToOpen > 0) {
        logToConsole(`💰 ${purchase.isMillionTokenHolder ? '🏦 ' : ''}${purchase.wallet.substring(0, 8)}... bought ${purchase.solAmount.toFixed(4)} SOL - Opening ${actualBlocksToOpen} blocks`, 'info');
        for (let i = 0; i < actualBlocksToOpen; i++) {
            const blockIndex = availableBlocks[i];
            if (blockIndex >= TOTAL_BLOCKS) break;
            const blockColor = Math.random() < GREEN_CHANCE ? 'green' : 'red';
            gameBlocks[blockIndex] = {
                status: 'revealed',
                color: blockColor,
                purchase: purchase,
                assignedHolder: null,
                isGuaranteedGreen: false,
                blockValue: MIN_SOL_FOR_BLOCK
            };
            if (blockColor === 'green') {
                winningWallets.push({
                    wallet: purchase.wallet,
                    solAmount: MIN_SOL_FOR_BLOCK,
                    totalPurchaseAmount: purchase.solAmount,
                    signature: purchase.signature,
                    timestamp: purchase.timestamp,
                    blockNumber: blockIndex + 1,
                    isMillionTokenHolder: purchase.isMillionTokenHolder,
                    holderTokens: purchase.holderTokens,
                    isGuaranteed: false,
                    isFree: false
                });
                logToConsole(`🎯 REGULAR GREEN at block ${blockIndex + 1}`, 'success');
            } else {
                logToConsole(`💥 RED BLOCK at block ${blockIndex + 1}`, 'info');
            }
            totalVolume += MIN_SOL_FOR_BLOCK;
        }
        currentBlockIndex = gameBlocks.filter(block => block.status === 'revealed').length;
        if (currentBlockIndex >= TOTAL_BLOCKS) {
            completeGame();
        }
        broadcastUpdate();
    }
}

// Modify your completeGame function to call distribution:
function completeGame() {
    gameCompleted = true;
    previousWinners = [...winningWallets];
    const dashboardData = getCurrentDashboardData();
    const totalGreenBlocks = dashboardData.stats.totalGreenBlocks;
    
    logToConsole(`🏆 GAME COMPLETED! ${winningWallets.length} winning blocks (${totalGreenBlocks} total green blocks)`, 'success');
    logToConsole(`💰 Starting fee distribution...`, 'info');
    
    // Call distribution function
    distributeFees().then(() => {
        logToConsole(`🔄 Starting new game in 3 seconds...`, 'info');
        setTimeout(() => {
            startNewGame();
        }, 3000);
    });
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
    logToConsole(`🎯 1M-3M holders get FREE GREEN blocks automatically`, 'info');
    logToConsole(`💰 Regular purchases: 0.1 SOL = 1 block, ${GREEN_CHANCE * 100}% green chance`, 'info');
    assignFreeGreenBlocks();
    broadcastUpdate();
}app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>BWANANA.FUN 🍌🍌🍌</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap');

:root {
    --neon-purple: #c084fc;
    --neon-blue: #60a5fa;
    --neon-green: #4ade80;
    --neon-pink: #f472b6;
    --neon-orange: #fb923c;
    --dark-bg: #0a0a0f;
    --card-bg: #1a1a2e;
    --border-glow: #2d2d44;
    --text-primary: #e2e8f0;
    --text-secondary: #94a3b8;
    --glass-bg: rgba(255, 255, 255, 0.03);
    --success-color: #10b981;
    --danger-color: #ef4444;
}

* { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box; 
}

body {
    background: var(--dark-bg);
    background-image: 
        radial-gradient(circle at 20% 50%, rgba(192, 132, 252, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(96, 165, 250, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 40% 80%, rgba(74, 222, 128, 0.1) 0%, transparent 50%);
    color: var(--text-primary);
    font-family: 'Space Grotesk', sans-serif;
    min-height: 100vh;
    font-size: 14px;
    line-height: 1.4;
}

.app-container {
    max-width: 1600px;
    margin: 0 auto;
    padding: 20px;
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 20px;
    min-height: 100vh;
}

/* GLASS EFFECT */
.glass-card {
    background: var(--glass-bg);
    backdrop-filter: blur(20px);
    border: 1px solid var(--border-glow);
    border-radius: 16px;
    padding: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

/* HEADER */
.app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 20px;
}

.brand-section {
    display: flex;
    align-items: center;
    gap: 16px;
}

.brand-logo {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, var(--neon-purple), var(--neon-pink));
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: 700;
    color: white;
    text-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
}

.brand-info h1 {
    font-size: 24px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--neon-purple), var(--neon-blue));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 4px;
}

.brand-info .subtitle {
    color: var(--text-secondary);
    font-size: 14px;
    font-weight: 400;
}

.connection-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--glass-bg);
    border: 1px solid var(--border-glow);
    border-radius: 24px;
    font-size: 12px;
    font-weight: 500;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: pulse-glow 2s infinite;
}

.status-connected { 
    background: var(--success-color);
    box-shadow: 0 0 8px var(--success-color);
}

.status-disconnected { 
    background: var(--danger-color);
    box-shadow: 0 0 8px var(--danger-color);
}

@keyframes pulse-glow {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.1); }
}

/* STATS DASHBOARD */
.stats-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
}

.stat-card {
    background: linear-gradient(135deg, var(--card-bg), rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-glow);
    border-radius: 12px;
    padding: 20px;
    position: relative;
    overflow: hidden;
}

.stat-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--neon-purple), var(--neon-blue), var(--neon-green));
}

.stat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
}

.stat-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
}

.stat-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.stat-value {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
    background: linear-gradient(135deg, var(--text-primary), var(--text-secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.stat-trend {
    font-size: 12px;
    color: var(--text-secondary);
}

/* MAIN CONTENT AREA */
.main-content {
    display: grid;
    grid-template-columns: 1fr 400px;
    gap: 20px;
    height: 500px;
}

/* GAME BOARD */
.game-board {
    background: var(--card-bg);
    border: 1px solid var(--border-glow);
    border-radius: 16px;
    padding: 20px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.board-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
}

.board-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
}

.progress-section {
    display: flex;
    align-items: center;
    gap: 12px;
}

.progress-bar {
    width: 200px;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--neon-green), var(--neon-blue));
    width: 0%;
    transition: width 0.5s ease;
}

.progress-text {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    min-width: 80px;
}

.blocks-container {
    flex: 1;
    overflow: auto;
    padding: 12px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
}

.blocks-grid {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 6px;
    width: 100%;
    height: 100%;
    max-width: none;
    margin: 0;
}

.game-block {
    aspect-ratio: 1;
    min-height: 52px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.3s ease;
    position: relative;
    overflow: hidden;
    background: var(--card-bg);
    border: 1px solid var(--border-glow);
    width: 100%;
    height: 100%;
}

.game-block.hidden {
    background: linear-gradient(135deg, var(--card-bg), rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-glow);
    animation: gentle-pulse 3s ease-in-out infinite;
}

@keyframes gentle-pulse {
    0%, 100% { opacity: 0.8; }
    50% { opacity: 1; }
}

.game-block.revealed.green {
    background: linear-gradient(135deg, var(--success-color), #059669);
    border: 1px solid var(--success-color);
    box-shadow: 0 0 20px rgba(16, 185, 129, 0.3);
    color: white;
    transform: scale(1.02);
}

.game-block.revealed.red {
    background: linear-gradient(135deg, var(--danger-color), #dc2626);
    border: 1px solid var(--danger-color);
    box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
    color: white;
    transform: scale(1.02);
}

.block-number {
    font-weight: 700;
    z-index: 2;
}

.block-wallet {
    position: absolute;
    bottom: 3px;
    left: 3px;
    right: 3px;
    font-size: 9px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 2px 4px;
    text-align: center;
    border-radius: 4px;
    z-index: 1;
}

.block-sol {
    position: absolute;
    top: 3px;
    right: 3px;
    font-size: 9px;
    background: var(--neon-orange);
    color: white;
    padding: 2px 5px;
    border-radius: 4px;
    font-weight: 600;
}

.block-free {
    position: absolute;
    top: 3px;
    left: 3px;
    font-size: 9px;
    background: var(--neon-green);
    color: white;
    padding: 2px 5px;
    border-radius: 4px;
    font-weight: 600;
}

/* SIDEBAR */
.sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.info-panel {
    background: var(--card-bg);
    border: 1px solid var(--border-glow);
    border-radius: 12px;
    overflow: hidden;
    flex: 1;
}

.panel-header {
    padding: 16px;
    border-bottom: 1px solid var(--border-glow);
    display: flex;
    align-items: center;
    gap: 8px;
}

.panel-icon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
}

.panel-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
}

.panel-content {
    padding: 16px;
    max-height: 200px;
    overflow-y: auto;
}

.user-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: 8px;
    margin-bottom: 8px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid transparent;
    transition: all 0.2s ease;
}

.user-item:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: var(--border-glow);
    transform: translateX(2px);
}

.user-avatar {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, var(--neon-purple), var(--neon-pink));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    color: white;
}

.user-info {
    flex: 1;
}

.user-wallet {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 2px;
}

.user-details {
    font-size: 11px;
    color: var(--text-secondary);
}

.activity-feed {
    background: var(--card-bg);
    border: 1px solid var(--border-glow);
    border-radius: 12px;
    height: 200px;
    display: flex;
    flex-direction: column;
}

.feed-header {
    padding: 16px;
    border-bottom: 1px solid var(--border-glow);
    display: flex;
    align-items: center;
    gap: 8px;
}

.feed-content {
    flex: 1;
    padding: 12px;
    overflow-y: auto;
    font-size: 11px;
    line-height: 1.4;
}

.log-entry {
    margin-bottom: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
}

.log-info { border-left: 2px solid var(--neon-blue); }
.log-success { border-left: 2px solid var(--success-color); }
.log-error { border-left: 2px solid var(--danger-color); }

.log-time {
    color: var(--text-secondary);
    font-size: 10px;
}

/* CUSTOM SCROLLBAR */
::-webkit-scrollbar {
    width: 6px;
}

::-webkit-scrollbar-track {
    background: var(--card-bg);
    border-radius: 3px;
}

::-webkit-scrollbar-thumb {
    background: var(--border-glow);
    border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
    background: var(--neon-purple);
}

/* RESPONSIVE DESIGN */
@media (max-width: 1200px) {
    .main-content {
        grid-template-columns: 1fr;
        gap: 16px;
    }
    
    .sidebar {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        grid-template-rows: auto;
        flex-direction: row;
    }
    
    .activity-feed {
        height: 150px;
    }
}

@media (max-width: 768px) {
    .app-container {
        padding: 12px;
        gap: 16px;
    }
    
    .app-header {
        flex-direction: column;
        text-align: center;
    }
    
    .stats-dashboard {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
    }
    
    .main-content {
        height: auto;
    }
    
    .sidebar {
        grid-template-columns: 1fr;
        flex-direction: column;
    }
    
    .blocks-grid {
        grid-template-columns: repeat(8, 1fr);
        gap: 3px;
    }
    
    .game-block {
        min-height: 36px;
        font-size: 10px;
    }
}
</style>
</head>
<body>
    <div class="app-container">
        <!-- HEADER -->
        <div class="glass-card app-header">
            <div class="brand-section">
                <div class="brand-logo">🍌</div>
                <div class="brand-info">
                    <div class="subtitle">Did you ever bought the TOP and got rewarded ? BWANANA.FUN rewards CHAD ATH BUYERS.<br>Be the wallet that bought TOP and get 50% rewards fee.<br>Not ATH levels , no problem ! HOLD 1% get 1 green block assigned every round or Buy 0.1SOL get 1 chance(50%) to get 1 green block into current round. 1 Green Block = 1% Creator FEE.</div>
                </div>
            </div>

        </div>

        <!-- STATS DASHBOARD -->
     <div class="stats-dashboard">
    <div class="stat-card">
        <div class="stat-header">
            <div class="stat-icon" style="background: linear-gradient(135deg, var(--neon-green), #059669);">💰</div>
            <div class="stat-title">Creator Fees</div>
        </div>
        <div class="stat-value" id="total-volume">0.000</div>
        <div class="stat-trend">SOL collected</div>
    </div>
    
    <div class="stat-card">
        <div class="stat-header">
            <div class="stat-icon" style="background: linear-gradient(135deg, var(--neon-blue), #0284c7);">📈</div>
            <div class="stat-title">Current Price</div>
        </div>
        <div class="stat-value" id="current-price">$0.000000</div>
        <div class="stat-trend">Per token</div>
    </div>
    
    <div class="stat-card">
        <div class="stat-header">
            <div class="stat-icon" style="background: linear-gradient(135deg, var(--success-color), #059669);">🟢</div>
            <div class="stat-title">Green Blocks</div>
        </div>
        <div class="stat-value" id="total-green">0</div>
        <div class="stat-trend">Winners found</div>
    </div>
    
    <div class="stat-card">
        <div class="stat-header">
            <div class="stat-icon" style="background: linear-gradient(135deg, var(--neon-purple), #7c3aed);">🎯</div>
            <div class="stat-title">Revealed</div>
        </div>
        <div class="stat-value" id="total-occupied">0</div>
        <div class="stat-trend">Out of 100 blocks</div>
    </div>
</div>

<style>
.stats-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
}

.stat-card {
    background: linear-gradient(135deg, var(--card-bg), rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-glow);
    border-radius: 10px;
    padding: 12px;
    position: relative;
    overflow: hidden;
    min-height: 80px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
}

.stat-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--neon-purple), var(--neon-blue), var(--neon-green));
}

.stat-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
}

.stat-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
}

.stat-title {
    font-size: 10px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.3px;
}

.stat-value {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 2px;
    background: linear-gradient(135deg, var(--text-primary), var(--text-secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    line-height: 1.2;
}

.stat-trend {
    font-size: 9px;
    color: var(--text-secondary);
    line-height: 1.1;
}

/* Responsive adjustments */
@media (max-width: 768px) {
    .stats-dashboard {
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
    }
    
    .stat-card {
        padding: 10px;
        min-height: 70px;
    }
    
    .stat-value {
        font-size: 18px;
    }
    
    .stat-title {
        font-size: 9px;
    }
}

@media (max-width: 480px) {
    .stats-dashboard {
        grid-template-columns: 1fr;
        gap: 6px;
    }
    
    .stat-card {
        min-height: 65px;
        padding: 8px;
    }
    
    .stat-value {
        font-size: 16px;
    }
}
</style>

        <!-- MAIN CONTENT -->
        <div class="main-content">
            <!-- GAME BOARD -->
            <div class="game-board">
                <div class="board-header">
                    <div class="board-title">🎮 Game Board</div>
                    <div class="progress-section">
                        <div class="progress-bar">
                            <div class="progress-fill" id="progress-fill"></div>
                        </div>
                        <div class="progress-text" id="progress-text">0/100</div>
                    </div>
                </div>
                
                <div class="blocks-container">
                    <div class="blocks-grid" id="minesweeper-grid"></div>
                </div>
            </div>

            <!-- SIDEBAR -->
            <div class="sidebar">
                <div class="activity-feed">
                    <div class="feed-header">
                        <div class="panel-icon" style="background: var(--neon-blue);">📡</div>
                        <div class="panel-title">Live Activity</div>
                    </div>
                    <div class="feed-content" id="console-output"></div>
                </div>
                <div class="info-panel">
                    <div class="panel-header">
                        <div class="panel-icon" style="background: var(--neon-purple);">🏦</div>
                        <div class="panel-title">Top Holders</div>
                    </div>
                    <div class="panel-content" id="holders-list"></div>
                </div>

                <div class="info-panel">
                    <div class="panel-header">
                        <div class="panel-icon" style="background: var(--neon-green);">🏆</div>
                        <div class="panel-title">Recent Winners</div>
                    </div>
                    <div class="panel-content" id="winner-list"></div>
                </div>


            </div>
        </div>
    </div>

    <script>
        let ws;
        
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
            
            ws.onopen = () => {
                document.getElementById('connection-indicator').className = 'status-dot status-connected';
                document.getElementById('connection-text').textContent = 'CONNECTED';
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                updateGame(data);
            };
            
            ws.onclose = () => {
                document.getElementById('connection-indicator').className = 'status-dot status-disconnected';
                document.getElementById('connection-text').textContent = 'RECONNECTING';
                setTimeout(connectWebSocket, 2000);
            };
        }
        
        function createBlocksGrid() {
            const grid = document.getElementById('minesweeper-grid');
            grid.innerHTML = '';
            for (let i = 0; i < 100; i++) {
                const block = document.createElement('div');
                block.className = 'game-block hidden';
                block.id = 'block-' + i;
                block.innerHTML = '<span class="block-number">' + (i + 1) + '</span>';
                grid.appendChild(block);
            }
        }
        
        function updateGame(data) {
            const { gameData, stats, consoleMessages } = data;
            
            // Update progress
            document.getElementById('progress-fill').style.width = gameData.progress + '%';
            document.getElementById('progress-text').textContent = 
                \`\${stats.totalOccupiedBlocks}/100\`;
            
            // Update stats
            document.getElementById('total-volume').textContent = stats.creatorFees.toFixed(3);
            document.getElementById('current-price').textContent = '$' + stats.currentPrice.toFixed(6);
            document.getElementById('total-green').textContent = stats.totalGreenBlocks;
            document.getElementById('total-occupied').textContent = stats.totalOccupiedBlocks;
            
            // Update blocks grid
            gameData.blocks.forEach((block, index) => {
                const blockElement = document.getElementById('block-' + index);
                if (!blockElement) return;
                
                let blockClass = 'game-block';
                if (block.status === 'revealed') {
                    blockClass += ' revealed ' + block.color;
                    
                    let blockContent = \`<span class="block-number">\${index + 1}</span>\`;
                    
                    if (block.isGuaranteedGreen && !block.purchase) {
                        const shortWallet = block.assignedHolder ? block.assignedHolder.substring(0, 4) + '...' : 'HOLDER';
                        blockContent += \`
                            <div class="block-wallet" title="\${block.assignedHolder || 'Holder'}">\${shortWallet}</div>
                            <div class="block-free">FREE</div>
                        \`;
                    } else if (block.purchase) {
                        const shortWallet = block.purchase.wallet.substring(0, 4) + '...';
                        const solAmount = block.blockValue ? block.blockValue.toFixed(2) : '0.10';
                        blockContent += \`
                            <div class="block-wallet" title="\${block.purchase.wallet}">\${shortWallet}</div>
                            <div class="block-sol">\${solAmount}S</div>
                        \`;
                    }
                    
                    blockElement.innerHTML = blockContent;
                    blockElement.onclick = () => {
                        if (block.purchase?.signature) {
                            window.open(\`https://solscan.io/tx/\${block.purchase.signature}\`, '_blank');
                        }
                    };
                    blockElement.style.cursor = block.purchase?.signature ? 'pointer' : 'default';
                } else {
                    blockClass += ' hidden';
                    blockElement.innerHTML = '<span class="block-number">' + (index + 1) + '</span>';
                    blockElement.onclick = null;
                    blockElement.style.cursor = 'default';
                }
                
                blockElement.className = blockClass;
            });
            
            // Update holders list
            if (stats.millionTokenHolders && stats.millionTokenHolders.length > 0) {
                const holdersList = document.getElementById('holders-list');
                holdersList.innerHTML = stats.millionTokenHolders.slice(0, 6).map(holder => \`
                    <div class="user-item">
                        <div class="user-avatar">\${holder.wallet.substring(0, 2)}</div>
                        <div class="user-info">
                            <div class="user-wallet">
                                \${holder.wallet.substring(0, 8)}...\${holder.hasGuaranteedBlock ? (holder.stillQualified ? ' ✅' : ' ❌') : ' ⏳'}
                            </div>
                            <div class="user-details">
                                \${holder.tokens.toLocaleString()} tokens • Block \${holder.assignedBlock || '?'}
                            </div>
                        </div>
                    </div>
                \`).join('');
            }
            
            // Update winners list
            const allWinners = [...gameData.winningWallets, ...gameData.previousWinners].slice(0, 8);
            if (allWinners.length > 0) {
                const winnerList = document.getElementById('winner-list');
                winnerList.innerHTML = allWinners.map(winner => \`
                    <div class="user-item">
                        <div class="user-avatar">\${winner.wallet.substring(0, 2)}</div>
                        <div class="user-info">
                            <div class="user-wallet">
                                \${winner.wallet.substring(0, 8)}...\${winner.isFree ? ' 🎁' : ''}
                            </div>
                            <div class="user-details">
                                Block \${winner.blockNumber} • \${winner.isFree ? 'FREE' : winner.solAmount.toFixed(2) + ' SOL'}
                            </div>
                        </div>
                    </div>
                \`).join('');
            }
            
            // Update activity feed
            const consoleOutput = document.getElementById('console-output');
            consoleOutput.innerHTML = '';
            consoleMessages.slice(-10).forEach(msg => {
                const entry = document.createElement('div');
                entry.className = 'log-entry log-' + msg.type;
                entry.innerHTML = \`
                    <div class="log-time">[\${new Date(msg.timestamp).toLocaleTimeString()}]</div>
                    <div>\${msg.message}</div>
                \`;
                consoleOutput.appendChild(entry);
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
    logToConsole(`🎮 Minesweeper ATH with FREE Green Blocks Started`, 'info');
    logToConsole(`🎯 1M-3M holders: FREE GREEN blocks (automatically assigned)`, 'info');
    logToConsole(`💰 Regular purchases: 0.1 SOL = 1 block, ${GREEN_CHANCE * 100}% green chance`, 'info');
});
async function initialize() {
    try {
        logToConsole(`📊 Initializing token data...`, 'info');
        await fetchTokenSupply();
        await fetchMajorHolders();
        logToConsole(`✅ Token data initialized`, 'success');
        const assigned = assignFreeGreenBlocks();
        if (assigned > 0) {
            logToConsole(`🎯 Assigned ${assigned} green blocks for 1% HOLDERS`, 'success');
        }
    } catch (e) {
        logToConsole(`Error initializing: ${e.message}`, 'error');
    }
}

let tick = 0;

async function mainLoop() {
    await initialize();
    let holderCheckCounter = 0;
    let feesCheckCounter = 0;
    let lastFetchCreatorFees = 0;
    let lastFetchMajorHolders = 0;
    let lastMonitorTransactions = 0;

    while (true) {
        try {
            const now = Date.now();

            // Check creator fees every 10 iterations (about every 30 seconds) with minimum 2 second gap
            if (feesCheckCounter % 10 === 0 && now - lastFetchCreatorFees >= 2000) {
                await fetchCreatorFees();
                lastFetchCreatorFees = Date.now();
                feesCheckCounter = 0;
            }

            // Check major holders every 5 iterations with minimum 2 second gap
            if (holderCheckCounter % 5 === 0 && now - lastFetchMajorHolders >= 2000) {
                await fetchMajorHolders();
                lastFetchMajorHolders = Date.now();
                
                const newlyAssigned = assignFreeGreenBlocks();
                const invalidated = validateGuaranteedBlocks();
                if (newlyAssigned > 0 || invalidated > 0) {
                    broadcastUpdate();
                }
                holderCheckCounter = 0;
            }

            // Check token price every 2 iterations
            if (holderCheckCounter % 2 === 0) {
                await fetchTokenPrice();
            }

            // Monitor transactions with minimum 2 second gap
            if (now - lastMonitorTransactions >= 2000) {
                const newPurchase = await monitorNewTokenTransactions();
                lastMonitorTransactions = Date.now();
                
                if (newPurchase) {
                    for (const purchase of newPurchase) {
                        processGameBlock(purchase);
                    }
                }
            }

            holderCheckCounter++;
            feesCheckCounter++;
        } catch (e) {
            logToConsole(`Error in main loop: ${e.message}`, 'error');
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}
// Start the loop
mainLoop().catch(e => {
    logToConsole(`Fatal error: ${e.message}`, 'error');
    process.exit(1);
});




