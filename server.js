import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import express from "express";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { WebSocketServer } from 'ws';
import http from 'http';
let gameHistory = [];
const MAX_GAME_HISTORY = 10;
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "4xVsawMYeSK7dPo9acp62bDFaDmrsCrSVXmEEBZrpump";
const POLL_INTERVAL_MS = 3369;
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 10000000;
const MAX_TOKENS_FOR_GUARANTEED_GREEN = 50000000; // 20 million to include those 10M holders
const GREEN_CHANCE = 0.369;
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
let lastFeesCheckTime = 0;
const FEES_CHECK_INTERVAL = 30000; // 30 seconds

async function fetchCreatorFees() {
    try {
        // Rate limiting - only check every 30 seconds
        const now = Date.now();
        if (now - lastFeesCheckTime < FEES_CHECK_INTERVAL) {
            return creatorFees;
        }
        
        lastFeesCheckTime = now;
        
        const balanceLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
        const balanceSol = Number(balanceLamports) / LAMPORTS_PER_SOL;
        creatorFees = balanceSol;
        return balanceSol;
    } catch (err) {
        console.error("Error fetching creator fees:", err.message);
        // Don't throw error, just return cached value
        return creatorFees;
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
            gameHistory: gameHistory.slice(0, 10),
    currentPayoutPerBlock: creatorFees * 0.01,
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
        const largestAccounts = await connection.getTokenLargestAccounts(mintPublicKey);
        
        let purchases = [];
        const batchPromises = [];
        const accountsToProcess = [];

        // First pass: filter accounts that need processing
        for (const acct of largestAccounts.value) {
            const tokenAccountPubkey = acct.address;
            const tokenAccountKey = tokenAccountPubkey.toBase58();
            
            // Skip if already processed or doesn't meet minimum threshold
            if (processedTransactions.has(tokenAccountKey) || 
                acct.uiAmount < MIN_TOKENS_FOR_GUARANTEED_GREEN) {
                continue;
            }

            accountsToProcess.push({ acct, tokenAccountKey });
        }

        // Process accounts in batches of 5 to avoid rate limiting
        const BATCH_SIZE = 5;
        for (let i = 0; i < accountsToProcess.length; i += BATCH_SIZE) {
            const batch = accountsToProcess.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(({ acct, tokenAccountKey }) => 
                processAccountBatch(acct.address, acct.uiAmount, tokenAccountKey)
            );

            // Wait for batch to complete
            const batchResults = await Promise.allSettled(batchPromises);
            
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    purchases.push(result.value);
                }
            }

            // Add delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < accountsToProcess.length) {
                await new Promise(r => setTimeout(r, 1000)); // 1 second delay
            }
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
    return null;
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

async function completeGame() {
    gameCompleted = true;
    
    // Collect and distribute fees
    const feesCollected = await collectAndDistributeFees();
    
    // Save game to history
    const gameResult = {
        timestamp: new Date().toISOString(),
        winners: [...winningWallets],
        totalGreenBlocks: winningWallets.length,
        feesCollected: feesCollected,
        blockDistribution: feesCollected > 0 ? (feesCollected * 0.01) : 0
    };
    
    gameHistory.unshift(gameResult);
    if (gameHistory.length > MAX_GAME_HISTORY) {
        gameHistory.pop();
    }
    
    previousWinners = [...winningWallets];
    const totalGreenBlocks = winningWallets.length;
    
    logToConsole(`🏆 GAME COMPLETED! ${winningWallets.length} winning blocks`, 'success');
    if (feesCollected > 0) {
        logToConsole(`💰 Collected ${feesCollected.toFixed(4)} SOL | ${(feesCollected * 0.01).toFixed(4)} SOL per green block`, 'success');
    }
    logToConsole(`🔄 Starting new game in 10 seconds...`, 'info');
    
    setTimeout(() => {
        startNewGame();
    }, 10000);
}
async function collectAndDistributeFees() {
    try {
        const availableFees = await fetchCreatorFees();
        
        if (availableFees < 0.01) {
            logToConsole(`💤 Not enough fees to collect (${availableFees.toFixed(4)} SOL)`, 'info');
            return 0;
        }
        
        logToConsole(`💰 Collecting ${availableFees.toFixed(4)} SOL creator fees...`, 'info');
        const signature = await sdk.collectCreatorFees(wallet);
        logToConsole(`✅ Fees collected! TX: ${signature}`, 'success');
        
        await creatorConnection.confirmTransaction(signature, "confirmed");
        await distributeFeesToWinners(availableFees);
        
        return availableFees;
        
    } catch (err) {
        logToConsole(`❌ Fee collection failed: ${err.message}`, 'error');
        return 0;
    }
}
async function distributeFeesToWinners(totalFees) {
    try {
        if (winningWallets.length === 0) {
            logToConsole(`💤 No winners to distribute fees to`, 'info');
            return;
        }
        
        const walletBlocks = {};
        winningWallets.forEach(winner => {
            walletBlocks[winner.wallet] = (walletBlocks[winner.wallet] || 0) + 1;
        });
        
        const distribution = [];
        const amountPerBlock = totalFees * 0.01;
        
        Object.entries(walletBlocks).forEach(([wallet, blockCount]) => {
            const amount = amountPerBlock * blockCount;
            distribution.push({
                wallet,
                blocks: blockCount,
                amount: amount,
                amountSol: amount.toFixed(6)
            });
        });
        
        logToConsole(`📊 Fee Distribution: ${totalFees.toFixed(4)} SOL total`, 'info');
        distribution.forEach(d => {
            logToConsole(`   ${d.wallet.substring(0, 8)}...: ${d.blocks} blocks = ${d.amountSol} SOL`, 'info');
        });
        
        await sendDistributionTransactions(distribution, totalFees);
        
    } catch (err) {
        logToConsole(`❌ Fee distribution failed: ${err.message}`, 'error');
    }
}
async function sendDistributionTransactions(distribution, totalFees) {
    try {
        logToConsole(`🚀 Sending distributions to ${distribution.length} winners...`, 'info');
        
        for (const dist of distribution) {
            if (dist.amount > 0.0001) {
                try {
                    const transaction = new Transaction().add(
                        SystemProgram.transfer({
                            fromPubkey: wallet.publicKey,
                            toPubkey: new PublicKey(dist.wallet),
                            lamports: Math.floor(dist.amount * LAMPORTS_PER_SOL)
                        })
                    );
                    
                    const signature = await sendAndConfirmTransaction(creatorConnection, transaction, [wallet]);
                    logToConsole(`✅ Sent ${dist.amountSol} SOL to ${dist.wallet.substring(0, 8)}... TX: ${signature}`, 'success');
                    
                    // Small delay between transactions
                    await new Promise(r => setTimeout(r, 2000));
                    
                } catch (err) {
                    logToConsole(`❌ Failed to send to ${dist.wallet.substring(0, 8)}...: ${err.message}`, 'error');
                }
            }
        }
        
        logToConsole(`🎉 Distribution completed! Total sent: ${totalFees.toFixed(4)} SOL`, 'success');
        
    } catch (err) {
        logToConsole(`❌ Distribution transactions failed: ${err.message}`, 'error');
    }
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
}

app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>MINESWEEPER ATH - FREE GREEN BLOCKS</title>
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
        .block-free {
            font-size: 11px;
            position: absolute;
            top: 2px;
            right: 2px;
            background: rgba(0, 0, 0, 0.7);
            padding: 2px 4px;
            border-radius: 3px;
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
        .winner-item.free {
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
    


        
        <div class="progress-section">
            <div class="progress-title">CURRENT ROUND BLOCKS PROGRESS  <div class="progress-text" id="progress-text">0/100 Blocks (0%)</div></div>
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill">           </div>
            </div>

            <div class="progress-details" id="progress-details">Loading progress details...</div><CENTER>
                            • 1% token holders: +1 GREEN block (automatically assigned every round)<br>
                • Regular purchases: 0.1 SOL = 1 block, 0.5 SOL = 5 blocks, 0.72 SOL = 7 blocks<br>
                • HOLDER blocks turn RED if holder drops below 1M tokens<br>
                • Every green block = 1% Reward from Creator Fees</CENTER>
        </div>
                <div class="stats-section">
            <div class="stat-card">
    <div class="stat-label">CREATOR FEES AVAILABLE</div>
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
    <div class="stat-label">CURRENT PAYOUT PER BLOCK</div>
    <div class="stat-value" id="payout-per-block">0.00 SOL</div>
</div>
        </div>
        <div class="minesweeper-grid" id="minesweeper-grid"></div>
        
        <div class="holders-section" id="holders-section" style="display: none;">
            <div class="holders-title">🏦 1% HOLDERS BLOCKS 🏦</div>
            <div class="holders-list" id="holders-list"></div>
        </div>
        
        <div class="winners-section" id="winners-section" style="display: none;">
            <div class="winners-title">🏆 CURRENT ROUND BUYERS 🏆</div>
            <div class="winner-list" id="winner-list"></div>
        </div>
        
        <div class="previous-winners-section" id="previous-winners-section" style="display: none;">
            <div class="previous-winners-title">📋 PREVIOUS ROUND WINNERS 📋</div>
            <div class="winner-list" id="previous-winner-list"></div>
        </div>
        

        
        <div class="console-section" id="console-output">
            <div class="console-line console-info">Initializing Game System...</div>
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
                \`\${stats.totalOccupiedBlocks}/100 Blocks (\${gameData.progress.toFixed(1)}%)\`;
document.getElementById('payout-per-block').textContent = stats.currentPayoutPerBlock.toFixed(4) + ' SOL';
document.getElementById('total-volume').textContent = stats.creatorFees.toFixed(4) + ' SOL';
            document.getElementById('current-price').textContent = '\$' + stats.currentPrice.toFixed(8);
            document.getElementById('total-green').textContent = stats.totalGreenBlocks;
            document.getElementById('total-occupied').textContent = stats.totalOccupiedBlocks;
            
            // Update blocks grid
            gameData.blocks.forEach((block, index) => {
                const blockElement = document.getElementById('block-' + index);
                if (!blockElement) return;
                
                let blockClass = 'block';
                if (block.status === 'revealed') {
                    blockClass += ' revealed ' + block.color;
                    if (block.isGuaranteedGreen) blockClass += ' guaranteed';
                    
                    let blockContent = \`
                        <span class="block-number">\${index + 1}</span>
                        \${block.color === 'green' ? '💸 ' : '🍌'}
                    \`;
                    
                    if (block.isGuaranteedGreen && !block.purchase) {
                        // FREE block for holder
                        const shortWallet = block.assignedHolder ? block.assignedHolder.substring(0, 6) + '...' + block.assignedHolder.substring(block.assignedHolder.length - 4) : 'Holder';
                        blockContent += \`
                            <div class="block-wallet" title="\${block.assignedHolder || 'Holder'}">\${shortWallet}</div>
                            <BR><BR>
                            <div class="block-free" title="Free Green Block">🎁 HOLDER</div>
                        \`;
                    } else if (block.purchase) {
                        // Purchased block
                        const shortWallet = block.purchase.wallet.substring(0, 6) + '...' + block.purchase.wallet.substring(block.purchase.wallet.length - 4);
                        const solAmount = block.blockValue ? block.blockValue.toFixed(4) : '0.1000';
                        blockContent += \`
                            <div class="block-wallet" title="\${block.purchase.wallet}">\${shortWallet}</div>
                            <div class="block-sol" title="\${solAmount} SOL">\${solAmount} SOL</div>
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
                            \${holder.assignedBlock ? \` | Block #\${holder.assignedBlock} \${holder.stillQualified ? '(FREE GREEN)' : '(Invalid)'}\` : ' | No block assigned'}
                        </div>
                    </div>
                \`).join('');
            }
            
            // Update winners lists
            if (gameData.winningWallets.length > 0) {
                document.getElementById('winners-section').style.display = 'block';
                const winnerList = document.getElementById('winner-list');
                winnerList.innerHTML = gameData.winningWallets.map(winner => \`
                    <div class="winner-item \${winner.isMillionTokenHolder ? 'million-holder' : ''} \${winner.isFree ? 'free' : ''}">
                        <div class="winner-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">
                                \${winner.wallet}\${winner.isMillionTokenHolder ? ' 🏦' : ''}\${winner.isFree ? ' 🎁' : ''}
                            </a>
                        </div>
                        <div class="winner-details">
                            Block: \${winner.blockNumber} | \${winner.isFree ? 'FREE GREEN BLOCK' : 'SOL: ' + winner.solAmount.toFixed(4)}
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
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">\${winner.wallet}\${winner.isMillionTokenHolder ? ' 🏦' : ''}\${winner.isFree ? ' 🎁' : ''}</a>
                        </div>
                        <div class="winner-details">
                            Block: \${winner.blockNumber} | \${winner.isFree ? 'FREE' : 'SOL: ' + winner.solAmount.toFixed(4)}
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

    while (true) {
        try {
            // Check creator fees every 10 iterations (about every 30 seconds)
            if (feesCheckCounter % 10 === 0) {
                await fetchCreatorFees();
                feesCheckCounter = 0;
            }

            if (holderCheckCounter % 5 === 0) {
                await fetchMajorHolders();
                const newlyAssigned = assignFreeGreenBlocks();
                const invalidated = validateGuaranteedBlocks();
                if (newlyAssigned > 0 || invalidated > 0) {
                    broadcastUpdate();
                }
                holderCheckCounter = 0;
            }

            if (holderCheckCounter % 2 === 0) {
                await fetchTokenPrice();
            }

            const newPurchase = await monitorNewTokenTransactions();
            if (newPurchase) {
                for (const purchase of newPurchase) {
                    processGameBlock(purchase);
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


















