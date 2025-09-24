import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import express from "express";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { WebSocketServer } from 'ws';
import http from 'http';
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";

const TOKEN_MINT = "AG6PqNvjrPEA46URPPvxrCZwuZv7zVuLbvbwVBGsyoRh";
const POLL_INTERVAL_MS = 2500;
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 10000000;
const MAX_TOKENS_FOR_GUARANTEED_GREEN = 31000000; // 20 million to include those 10M holders
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

async function distributeFees() {
    try {
        // 1. Get total creator fees
        const totalFeesLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
        const totalFeesSOL = Number(totalFeesLamports) / LAMPORTS_PER_SOL;
        
        logToConsole(`💰 Total fees to distribute: ${totalFeesSOL.toFixed(4)} SOL`, 'success');

        // 2. Calculate 1% value
        const onePercentSOL = totalFeesSOL * 0.01;
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
}
app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>BWANANA.FUN - Redesigned</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

* { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box; 
}

body {
    background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
    color: #e0e6ed;
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
    font-size: 14px;
    line-height: 1.5;
}

.app-container {
    max-width: 1600px;
    margin: 0 auto;
    padding: 20px;
    background: rgba(15, 15, 35, 0.95);
    min-height: 100vh;
    backdrop-filter: blur(10px);
}

.header {
    text-align: center;
    margin-bottom: 30px;
    padding: 20px 0;
    border-bottom: 1px solid rgba(64, 224, 208, 0.3);
}

.title {
    font-size: 2.5rem;
    font-weight: 700;
    color: #40e0d0;
    margin-bottom: 8px;
    text-shadow: 0 0 20px rgba(64, 224, 208, 0.5);
    letter-spacing: 2px;
}

.subtitle {
    color: #9ca3af;
    font-size: 1rem;
    font-weight: 400;
}

.status-bar {
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 8px 16px;
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(64, 224, 208, 0.3);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 500;
    z-index: 1000;
    backdrop-filter: blur(10px);
}

.status-connected { color: #10b981; }
.status-disconnected { color: #ef4444; }

.progress-section {
    margin-bottom: 25px;
    padding: 20px;
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8));
    border: 1px solid rgba(64, 224, 208, 0.2);
    border-radius: 12px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.progress-title {
    color: #40e0d0;
    font-weight: 600;
    font-size: 1.1rem;
    margin-bottom: 15px;
    text-align: center;
}

.token-info {
    text-align: center;
    color: #fbbf24;
    margin-bottom: 15px;
    font-size: 0.9rem;
    font-weight: 500;
}

.progress-text {
    text-align: center;
    font-weight: 600;
    color: #e0e6ed;
    font-size: 1rem;
    margin-bottom: 12px;
}

.progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(30, 41, 59, 0.8);
    border: 1px solid rgba(64, 224, 208, 0.3);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 12px;
}

.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #40e0d0, #06b6d4, #40e0d0);
    background-size: 200% 100%;
    width: 0%;
    transition: width 0.6s ease;
    animation: shimmer 3s ease-in-out infinite;
}

@keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
}

.progress-details {
    text-align: center;
    font-size: 0.85rem;
    color: #9ca3af;
    margin-bottom: 15px;
}

.game-rules {
    text-align: center;
    font-size: 0.8rem;
    line-height: 1.6;
    color: #d1d5db;
}

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
    margin-bottom: 30px;
}

.stat-card {
    padding: 20px;
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.6), rgba(15, 23, 42, 0.6));
    border: 1px solid rgba(64, 224, 208, 0.2);
    border-radius: 10px;
    text-align: center;
    transition: all 0.3s ease;
    backdrop-filter: blur(5px);
}

.stat-card:hover {
    transform: translateY(-2px);
    border-color: rgba(64, 224, 208, 0.4);
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: #40e0d0;
    margin-bottom: 8px;
    display: block;
}

.stat-label {
    font-size: 0.8rem;
    color: #9ca3af;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.main-layout {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 30px;
    align-items: start;
}

/* Game Grid - Smaller 32px blocks */
.game-grid {
    display: grid;
    grid-template-columns: repeat(10, 32px);
    grid-template-rows: repeat(10, 32px);
    gap: 2px;
    padding: 15px;
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8));
    border: 1px solid rgba(64, 224, 208, 0.2);
    border-radius: 12px;
    justify-content: center;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.block {
    width: 32px;
    height: 32px;
    border: 1px solid rgba(100, 116, 139, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 8px;
    cursor: pointer;
    transition: all 0.3s ease;
    background: linear-gradient(145deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
    border-radius: 4px;
    position: relative;
    overflow: hidden;
}

.block.hidden {
    background: linear-gradient(145deg, rgba(51, 65, 85, 0.6), rgba(71, 85, 105, 0.6));
    border-color: rgba(100, 116, 139, 0.4);
}

.block.hidden:hover {
    background: linear-gradient(145deg, rgba(71, 85, 105, 0.8), rgba(100, 116, 139, 0.8));
}

.block.revealed.green {
    background: linear-gradient(145deg, #10b981, #059669);
    color: white;
    border-color: #10b981;
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
    font-weight: 700;
}

.block.revealed.red {
    background: linear-gradient(145deg, #ef4444, #dc2626);
    color: white;
    border-color: #ef4444;
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
    font-weight: 700;
}

.block.revealed.green.guaranteed {
    background: linear-gradient(145deg, #fbbf24, #f59e0b);
    color: #1f2937;
    border-color: #fbbf24;
    box-shadow: 0 0 12px rgba(251, 191, 36, 0.6);
    animation: pulse-gold 2s ease-in-out infinite;
}

@keyframes pulse-gold {
    0%, 100% { box-shadow: 0 0 8px rgba(251, 191, 36, 0.4); }
    50% { box-shadow: 0 0 16px rgba(251, 191, 36, 0.8); }
}

.block-tooltip {
    position: absolute;
    bottom: -2px;
    left: -2px;
    right: -2px;
    background: rgba(0, 0, 0, 0.9);
    font-size: 6px;
    padding: 1px;
    border-radius: 2px;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease;
}

.block:hover .block-tooltip {
    opacity: 1;
}

.right-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 600px;
}

/* Console First */
.console-section {
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95));
    border: 1px solid rgba(64, 224, 208, 0.3);
    border-radius: 12px;
    height: 300px;
    overflow: hidden;
    padding: 0;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(10px);
}

.console-header {
    padding: 12px 16px;
    background: rgba(64, 224, 208, 0.1);
    border-bottom: 1px solid rgba(64, 224, 208, 0.2);
    font-weight: 600;
    color: #40e0d0;
    font-size: 0.9rem;
}

.console-content {
    height: calc(100% - 45px);
    overflow-y: auto;
    padding: 12px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
}

.console-line {
    margin-bottom: 4px;
    word-break: break-all;
    padding: 2px 4px;
    border-radius: 3px;
    transition: all 0.2s ease;
}

.console-line:hover {
    background: rgba(64, 224, 208, 0.05);
}

.console-info { color: #40e0d0; }
.console-success { color: #10b981; }
.console-error { color: #ef4444; }
.console-warning { color: #f59e0b; }

/* Info Panels */
.info-panels {
    display: grid;
    grid-template-columns: 1fr;
    gap: 15px;
}

.info-panel {
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.6), rgba(15, 23, 42, 0.6));
    border: 1px solid rgba(64, 224, 208, 0.2);
    border-radius: 12px;
    overflow: hidden;
    backdrop-filter: blur(5px);
    max-height: 250px;
}

.panel-header {
    padding: 12px 16px;
    font-weight: 600;
    font-size: 0.9rem;
    border-bottom: 1px solid rgba(64, 224, 208, 0.2);
}

.panel-content {
    max-height: 200px;
    overflow-y: auto;
    padding: 0;
}

.holders-panel .panel-header { background: rgba(251, 191, 36, 0.1); color: #fbbf24; }
.winners-panel .panel-header { background: rgba(16, 185, 129, 0.1); color: #10b981; }
.previous-panel .panel-header { background: rgba(64, 224, 208, 0.1); color: #40e0d0; }

.panel-item {
    padding: 10px 16px;
    border-bottom: 1px solid rgba(64, 224, 208, 0.1);
    font-size: 0.8rem;
    transition: all 0.2s ease;
}

.panel-item:last-child {
    border-bottom: none;
}

.panel-item:hover {
    background: rgba(64, 224, 208, 0.05);
}

.item-wallet {
    font-weight: 600;
    margin-bottom: 4px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.item-wallet a {
    color: inherit;
    text-decoration: none;
    transition: all 0.2s ease;
}

.item-wallet a:hover {
    color: #40e0d0;
    text-shadow: 0 0 4px rgba(64, 224, 208, 0.4);
}

.item-details {
    font-size: 0.75rem;
    color: #9ca3af;
    line-height: 1.3;
}

.item-details a {
    color: #40e0d0;
    text-decoration: none;
    margin-right: 8px;
}

.item-details a:hover {
    text-decoration: underline;
}

/* Special item states */
.panel-item.holder-assigned {
    background: linear-gradient(90deg, rgba(16, 185, 129, 0.1), transparent);
    border-left: 3px solid #10b981;
}

.panel-item.holder-invalid {
    background: linear-gradient(90deg, rgba(239, 68, 68, 0.1), transparent);
    border-left: 3px solid #ef4444;
    opacity: 0.7;
}

.panel-item.winner-free {
    background: linear-gradient(90deg, rgba(251, 191, 36, 0.1), transparent);
    border-left: 3px solid #fbbf24;
}

.panel-item.winner-holder {
    background: linear-gradient(90deg, rgba(168, 85, 247, 0.1), transparent);
    border-left: 3px solid #a855f7;
}

/* Scrollbar styling */
::-webkit-scrollbar {
    width: 6px;
}

::-webkit-scrollbar-track {
    background: rgba(30, 41, 59, 0.4);
    border-radius: 3px;
}

::-webkit-scrollbar-thumb {
    background: rgba(64, 224, 208, 0.4);
    border-radius: 3px;
    transition: all 0.2s ease;
}

::-webkit-scrollbar-thumb:hover {
    background: rgba(64, 224, 208, 0.6);
}

/* Responsive Design */
@media (max-width: 1200px) {
    .main-layout {
        grid-template-columns: 1fr;
        gap: 20px;
    }
    
    .game-grid {
        justify-self: center;
        margin: 0 auto;
    }
}

@media (max-width: 768px) {
    .app-container {
        padding: 10px;
    }
    
    .title {
        font-size: 2rem;
    }
    
    .stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
    }
    
    .console-section {
        height: 250px;
    }
    
    .info-panel {
        max-height: 200px;
    }
}

@media (max-width: 480px) {
    .game-grid {
        grid-template-columns: repeat(10, 28px);
        grid-template-rows: repeat(10, 28px);
        gap: 1px;
    }
    
    .block {
        width: 28px;
        height: 28px;
        font-size: 7px;
    }
    
    .stats-grid {
        grid-template-columns: 1fr;
    }
}
</style>
</head>
<body>
    <div class="status-bar">
        <span id="connection-indicator">●</span> 
        <span id="connection-text">CONNECTING...</span>
    </div>

    <div class="app-container">
        <div class="header">
            <div class="title">BWANANA.FUN</div>
            <div class="subtitle">Next-Gen Blockchain Gaming Experience</div>
        </div>

        <div class="progress-section">
            <div class="progress-title">Game Progress & Rules</div>
            <div class="token-info">TOKEN: ${TOKEN_MINT}</div>
            <div class="progress-text" id="progress-text">0/100 Blocks (0%)</div>
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill"></div>
            </div>
            <div class="progress-details" id="progress-details">Loading progress details...</div>
            <div class="game-rules">
                • 1% token holders: +1 GREEN block (automatically assigned every round)<br>
                • Regular purchases: 0.1 SOL = 1 block, 0.5 SOL = 5 blocks, 0.72 SOL = 7 blocks<br>
                • HOLDER blocks turn RED if holder drops below 1M tokens<br>
                • Every green block = 1% Reward from Creator Fees
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <span class="stat-value" id="total-volume">0.00</span>
                <div class="stat-label">Creator Fees (SOL)</div>
            </div>
            <div class="stat-card">
                <span class="stat-value" id="current-price">$0.00000000</span>
                <div class="stat-label">Current Price</div>
            </div>
            <div class="stat-card">
                <span class="stat-value" id="total-green">0</span>
                <div class="stat-label">Total Green Blocks</div>
            </div>
            <div class="stat-card">
                <span class="stat-value" id="total-occupied">0</span>
                <div class="stat-label">Total Revealed</div>
            </div>
        </div>

        <div class="main-layout">
            <div class="game-grid" id="game-grid"></div>
            
            <div class="right-panel">
                <!-- Console First -->
                <div class="console-section">
                    <div class="console-header">System Console</div>
                    <div class="console-content" id="console-output">
                        <div class="console-line console-info">Initializing Game System...</div>
                    </div>
                </div>
                
                <!-- Info Panels -->
                <div class="info-panels">
                    <div class="info-panel holders-panel" id="holders-panel">
                        <div class="panel-header">1% Token Holders</div>
                        <div class="panel-content" id="holders-list"></div>
                    </div>
                    
                    <div class="info-panel winners-panel" id="winners-panel">
                        <div class="panel-header">Current Round Winners</div>
                        <div class="panel-content" id="winner-list"></div>
                    </div>
                    
                    <div class="info-panel previous-panel" id="previous-panel">
                        <div class="panel-header">Previous Round</div>
                        <div class="panel-content" id="previous-winner-list"></div>
                    </div>
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
        
        function createGameGrid() {
            const grid = document.getElementById('game-grid');
            grid.innerHTML = '';
            for (let i = 0; i < 100; i++) {
                const block = document.createElement('div');
                block.className = 'block hidden';
                block.id = 'block-' + i;
                block.innerHTML = \`
                    \${i + 1}
                    <div class="block-tooltip">#\${i + 1}</div>
                \`;
                grid.appendChild(block);
            }
        }
        
        function updateGame(data) {
            const { gameData, stats, consoleMessages } = data;
            
            // Update progress
            document.getElementById('progress-fill').style.width = gameData.progress + '%';
            document.getElementById('progress-text').textContent = 
                \`\${stats.totalOccupiedBlocks}/100 Blocks (\${gameData.progress.toFixed(1)}%)\`;
            document.getElementById('progress-details').textContent = 
                \`\${gameData.revealedGreenBlocks} Green + \${stats.totalOccupiedBlocks - gameData.revealedGreenBlocks} Red = \${stats.totalOccupiedBlocks} Total Revealed\`;
            
            // Update stats
            document.getElementById('total-volume').textContent = stats.creatorFees.toFixed(4);
            document.getElementById('current-price').textContent = '$' + stats.currentPrice.toFixed(8);
            document.getElementById('total-green').textContent = stats.totalGreenBlocks;
            document.getElementById('total-occupied').textContent = stats.totalOccupiedBlocks;
            
            // Update game blocks
            gameData.blocks.forEach((block, index) => {
                const blockElement = document.getElementById('block-' + index);
                if (!blockElement) return;
                
                let blockClass = 'block';
                if (block.status === 'revealed') {
                    blockClass += ' revealed ' + block.color;
                    if (block.isGuaranteedGreen) blockClass += ' guaranteed';
                    
                    let blockContent = \`\${index + 1}\`;
                    
                    if (block.isGuaranteedGreen && !block.purchase) {
                        // FREE block for holder
                        const shortWallet = block.assignedHolder ? 
                            block.assignedHolder.substring(0, 4) + '...' + block.assignedHolder.substring(-2) : 'FREE';
                        blockContent = \`
                            \${index + 1}
                            <div class="block-tooltip">FREE: \${shortWallet}</div>
                        \`;
                    } else if (block.purchase) {
                        // Purchased block
                        const shortWallet = block.purchase.wallet.substring(0, 4) + '...' + block.purchase.wallet.substring(-2);
                        const solAmount = block.blockValue ? block.blockValue.toFixed(2) : '0.10';
                        blockContent = \`
                            \${index + 1}
                            <div class="block-tooltip">\${shortWallet} • \${solAmount} SOL</div>
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
                    blockElement.innerHTML = \`
                        \${index + 1}
                        <div class="block-tooltip">#\${index + 1}</div>
                    \`;
                    blockElement.onclick = null;
                    blockElement.style.cursor = 'default';
                }
                
                blockElement.className = blockClass;
            });
            
            // Update holders list
            const holdersPanel = document.getElementById('holders-panel');
            if (stats.millionTokenHolders && stats.millionTokenHolders.length > 0) {
                holdersPanel.style.display = 'block';
                const holdersList = document.getElementById('holders-list');
                holdersList.innerHTML = stats.millionTokenHolders.map(holder => \`
                    <div class="panel-item \${holder.hasGuaranteedBlock ? 'holder-assigned' : ''} \${!holder.stillQualified ? 'holder-invalid' : ''}">
                        <div class="item-wallet">
                            <a href="https://solscan.io/account/\${holder.wallet}" target="_blank">
                                \${holder.wallet.substring(0, 8)}...\${holder.wallet.substring(-4)}
                                \${holder.hasGuaranteedBlock ? (holder.stillQualified ? ' ✅' : ' ❌') : ' ⏳'}
                            </a>
                        </div>
                        <div class="item-details">
                            \${holder.tokens.toLocaleString()} tokens (\${holder.percentage.toFixed(2)}%)
                            \${holder.assignedBlock ? \` • Block #\${holder.assignedBlock}\` : ' • Pending assignment'}
                        </div>
                    </div>
                \`).join('');
            } else {
                holdersPanel.style.display = 'none';
            }
            
            // Update winners list
            const winnersPanel = document.getElementById('winners-panel');
            if (gameData.winningWallets.length > 0) {
                winnersPanel.style.display = 'block';
                const winnerList = document.getElementById('winner-list');
                winnerList.innerHTML = gameData.winningWallets.map(winner => \`
                    <div class="panel-item \${winner.isFree ? 'winner-free' : ''} \${winner.isMillionTokenHolder ? 'winner-holder' : ''}">
                        <div class="item-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">
                                \${winner.wallet.substring(0, 8)}...\${winner.wallet.substring(-4)}
                            </a>
                        </div>
                        <div class="item-details">
                            Block #\${winner.blockNumber} • \${winner.isFree ? 'FREE BLOCK' : winner.solAmount.toFixed(4) + ' SOL'}
                            \${winner.isMillionTokenHolder ? ' • Holder' : ''}
                        </div>
                    </div>
                \`).join('');
            } else {
                winnersPanel.style.display = 'none';
            }
            
            // Update previous winners list
            const previousPanel = document.getElementById('previous-panel');
            if (gameData.previousWinners.length > 0) {
                previousPanel.style.display = 'block';
                const previousWinnerList = document.getElementById('previous-winner-list');
                previousWinnerList.innerHTML = gameData.previousWinners.map(winner => \`
                    <div class="panel-item">
                        <div class="item-wallet">
                            <a href="https://solscan.io/account/\${winner.wallet}" target="_blank">
                                \${winner.wallet.substring(0, 8)}...\${winner.wallet.substring(-4)}
                            </a>
                        </div>
                        <div class="item-details">
                            Block #\${winner.blockNumber} • \${winner.isFree ? 'FREE' : winner.solAmount.toFixed(4) + ' SOL'}
                            \${winner.isMillionTokenHolder ? ' • Holder' : ''}
                        </div>
                    </div>
                \`).join('');
            } else {
                previousPanel.style.display = 'none';
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
        
        createGameGrid();
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















