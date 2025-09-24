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
    <title>BWANANA.FUN</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');
* { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box; 
}
body {
    background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
    color: #00ff41;
    font-family: 'JetBrains Mono', monospace;
    min-height: 100vh;
    overflow-x: hidden;
    font-size: 13px;
    line-height: 1.3;
    background-attachment: fixed;
}
.terminal-container {
    padding: 15px;
    max-width: 1400px;
    margin: 0 auto;
    background: rgba(0, 0, 0, 0.85);
    border: 1px solid #00ff41;
    box-shadow: 
        0 0 30px #00ff4120,
        inset 0 0 20px #00ff4108;
    backdrop-filter: blur(10px);
}
.game-header {
    text-align: center;
    margin-bottom: 20px;
    color: #ffff00;
    font-size: 28px;
    font-weight: 800;
    text-shadow: 
        0 0 15px #ffff00,
        0 0 30px #ffff0040;
    letter-spacing: 2px;
    text-transform: uppercase;
}
.progress-section {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid #00ffff;
    background: rgba(0, 255, 255, 0.03);
    border-radius: 8px;
    position: relative;
    overflow: hidden;
}
.progress-section::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #00ffff10, transparent);
    animation: scan 3s linear infinite;
}
@keyframes scan {
    0% { left: -100%; }
    100% { left: 100%; }
}
.progress-title {
    color: #00ffff;
    font-weight: 700;
    margin-bottom: 12px;
    text-align: center;
    font-size: 18px;
    text-shadow: 0 0 10px #00ffff80;
}
.progress-bar {
    width: 100%;
    height: 25px;
    background: #000;
    border: 1px solid #00ff41;
    position: relative;
    margin-bottom: 8px;
    border-radius: 4px;
    overflow: hidden;
}
.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ff41, #00ffff, #00ff41);
    background-size: 200% 100%;
    width: 0%;
    transition: width 0.5s ease;
    position: relative;
    animation: gradientShift 2s ease infinite;
}
@keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
}
.progress-text {
    text-align: center;
    font-weight: 700;
    color: #00ffff;
    font-size: 14px;
    margin-bottom: 5px;
}
.progress-details {
    text-align: center;
    font-size: 11px;
    color: #00ff41;
    opacity: 0.9;
}

/* 128x128px Blocks Grid */
.minesweeper-grid {
    display: grid;
    grid-template-columns: repeat(5, 128px); /* 5 columns of 128px */
    grid-auto-rows: 128px; /* Each row 128px */
    gap: 8px;
    margin: 20px 0;
    padding: 20px;
    border: 1px solid #ff00ff;
    background: rgba(255, 0, 255, 0.02);
    border-radius: 8px;
    justify-content: center;
    max-width: fit-content;
    margin-left: auto;
    margin-right: auto;
}

.block {
    width: 128px;
    height: 128px;
    border: 2px solid #333;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.3s ease;
    background: linear-gradient(145deg, #1a1a1a, #2a2a2a);
    position: relative;
    overflow: hidden;
    font-size: 12px;
    border-radius: 6px;
    box-shadow: 
        inset 0 0 20px #00000080,
        0 4px 8px #00000040;
}

.block.hidden {
    background: linear-gradient(145deg, #2a2a2a, #3a3a3a);
    border-color: #555;
    animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
}

.block.revealed.green {
    background: linear-gradient(145deg, #00ff41, #00cc33);
    color: #000;
    border-color: #00ff41;
    box-shadow: 
        0 0 30px #00ff41,
        inset 0 0 20px #00ff4180;
    font-size: 14px;
    font-weight: 800;
    transform: scale(1.05);
}

.block.revealed.red {
    background: linear-gradient(145deg, #ff4444, #cc3333);
    color: #000;
    border-color: #ff4444;
    box-shadow: 
        0 0 30px #ff4444,
        inset 0 0 20px #ff444480;
    font-size: 14px;
    font-weight: 800;
}

.block.revealed.green.guaranteed {
    background: linear-gradient(145deg, #00ff41, #ffff00, #00ff41);
    box-shadow: 
        0 0 40px #ffff00,
        inset 0 0 30px #ffff0080;
    border-color: #ffff00;
    font-size: 14px;
    font-weight: 800;
    animation: glow 1.5s ease-in-out infinite alternate;
}

@keyframes glow {
    from { box-shadow: 0 0 30px #ffff00; }
    to { box-shadow: 0 0 50px #ffff00, 0 0 70px #ffff0040; }
}

.block-number {
    font-size: 32px;
    opacity: 0.9;
    font-weight: 800;
    text-shadow: 0 2px 4px #00000080;
}

.block-wallet {
    font-size: 9px;
    position: absolute;
    bottom: 4px;
    left: 4px;
    right: 4px;
    text-align: center;
    background: rgba(0, 0, 0, 0.85);
    padding: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
    border-radius: 3px;
}

.block-sol {
    font-size: 10px;
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.85);
    padding: 3px 6px;
    border-radius: 4px;
    font-weight: 700;
}

.block-free {
    font-size: 10px;
    position: absolute;
    top: 4px;
    left: 4px;
    background: rgba(0, 0, 0, 0.85);
    padding: 3px 6px;
    border-radius: 4px;
    font-weight: 700;
    color: #00ff41;
}

.winners-section,
.previous-winners-section,
.holders-section {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid;
    background: rgba(255, 255, 0, 0.03);
    border-radius: 8px;
    position: relative;
    overflow: hidden;
}

.winners-section {
    border-color: #ffff00;
    background: rgba(255, 255, 0, 0.03);
}
.previous-winners-section {
    border-color: #00ffff;
    background: rgba(0, 255, 255, 0.03);
}
.holders-section {
    border-color: #ff00ff;
    background: rgba(255, 0, 255, 0.03);
}

.winners-title,
.previous-winners-title,
.holders-title {
    font-weight: 700;
    margin-bottom: 12px;
    text-align: center;
    font-size: 16px;
    text-shadow: 0 0 10px currentColor;
}

.winners-title { color: #ffff00; }
.previous-winners-title { color: #00ffff; }
.holders-title { color: #ff00ff; }

.winner-list, 
.holders-list {
    max-height: 200px;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 8px;
}

.winner-item {
    padding: 8px;
    background: rgba(255, 255, 0, 0.08);
    border-left: 3px solid #ffff00;
    border-radius: 4px;
    font-size: 10px;
    transition: all 0.3s ease;
}

.winner-item:hover {
    transform: translateX(4px);
    background: rgba(255, 255, 0, 0.15);
}

.winner-item.million-holder {
    background: rgba(255, 255, 0, 0.2);
    border-left: 3px solid #ff00ff;
}

.winner-item.free {
    background: rgba(0, 255, 0, 0.15);
    border-left: 3px solid #00ff00;
}

.previous-winner-item {
    padding: 6px;
    background: rgba(0, 255, 255, 0.08);
    border-left: 3px solid #00ffff;
    border-radius: 4px;
    font-size: 9px;
    opacity: 0.9;
}

.holder-item {
    padding: 8px;
    background: rgba(255, 0, 255, 0.08);
    border-left: 3px solid #ff00ff;
    border-radius: 4px;
    font-size: 10px;
    transition: all 0.3s ease;
}

.holder-item.assigned {
    background: rgba(0, 255, 0, 0.15);
    border-left: 3px solid #00ff00;
}

.holder-item.invalid {
    background: rgba(255, 0, 0, 0.1);
    border-left: 3px solid #ff0000;
    opacity: 0.7;
}

.winner-wallet, 
.holder-wallet {
    font-weight: 700;
    margin-bottom: 3px;
    word-break: break-all;
    font-size: 11px;
}

.winner-wallet a, 
.holder-wallet a {
    color: inherit;
    text-decoration: none;
    transition: all 0.3s ease;
}

.winner-wallet a:hover, 
.holder-wallet a:hover {
    text-shadow: 0 0 8px currentColor;
    text-decoration: none;
}

.winner-details, 
.holder-details {
    font-size: 9px;
    color: #ccc;
}

.winner-details a, 
.holder-details a {
    color: #00ff41;
    text-decoration: none;
    margin-right: 8px;
    transition: all 0.3s ease;
}

.winner-details a:hover, 
.holder-details a:hover {
    text-shadow: 0 0 8px #00ff41;
}

.stats-section {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin: 15px 0;
}

.stat-card {
    padding: 12px;
    border: 1px solid #00ff41;
    background: rgba(0, 255, 65, 0.03);
    text-align: center;
    border-radius: 6px;
    transition: all 0.3s ease;
    position: relative;
    overflow: hidden;
}

.stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 5px 15px #00ff4120;
}

.stat-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #00ff4110, transparent);
    transition: left 0.5s ease;
}

.stat-card:hover::before {
    left: 100%;
}

.stat-value {
    font-size: 16px;
    font-weight: 800;
    color: #ffff00;
    margin: 3px 0;
    text-shadow: 0 0 10px #ffff0080;
}

.stat-label {
    font-size: 10px;
    color: #00ff41;
    opacity: 0.9;
    font-weight: 500;
}

.console-section {
    background: #000;
    border: 1px solid #00ff41;
    height: 180px;
    overflow-y: auto;
    margin: 15px 0;
    padding: 8px;
    font-size: 9px;
    border-radius: 6px;
    box-shadow: inset 0 0 20px #00000080;
}

.console-line {
    margin: 1px 0;
    word-break: break-all;
    padding: 2px 4px;
    border-radius: 2px;
    transition: all 0.3s ease;
}

.console-line:hover {
    background: rgba(0, 255, 65, 0.05);
}

.console-info { color: #00ff41; }
.console-success { color: #ffff00; }
.console-error { color: #ff4444; }
.console-warning { color: #ffaa00; }

.connection-status {
    position: fixed;
    top: 10px;
    right: 10px;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.9);
    border: 1px solid #00ff41;
    font-size: 9px;
    border-radius: 4px;
    z-index: 1000;
    backdrop-filter: blur(5px);
}

.status-connected { color: #00ff41; text-shadow: 0 0 8px #00ff41; }
.status-disconnected { color: #ff4444; text-shadow: 0 0 8px #ff4444; }

.game-rules {
    margin: 15px 0;
    padding: 12px;
    border: 1px solid #00ff41;
    background: rgba(0, 255, 65, 0.03);
    border-radius: 6px;
}

.rules-title {
    color: #00ff41;
    font-weight: 700;
    margin-bottom: 8px;
    text-align: center;
    font-size: 14px;
}

.rules-list {
    font-size: 10px;
    line-height: 1.5;
    text-align: center;
}

/* Scrollbar Styling */
::-webkit-scrollbar {
    width: 6px;
}
::-webkit-scrollbar-track {
    background: #1a1a1a;
    border-radius: 3px;
}
::-webkit-scrollbar-thumb {
    background: #00ff41;
    border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
    background: #00cc33;
}

@media (max-width: 768px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 128px);
        gap: 6px;
        padding: 10px;
    }
    
    .terminal-container {
        padding: 8px;
        margin: 5px;
    }
    
    .winner-list, 
    .holders-list {
        grid-template-columns: 1fr;
    }
    
    .stats-section {
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
    }
    
    .game-header {
        font-size: 20px;
    }
}

@media (max-width: 480px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 110px);
        grid-auto-rows: 110px;
    }
    
    .block {
        width: 110px;
        height: 110px;
    }
    
    .block-number {
        font-size: 24px;
    }
}.main-content {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin: 20px 0;
}

.panels-container {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
    gap: 15px;
    margin: 0 auto;
    width: 100%;
    max-width: 1200px;
}

.holders-section,
.winners-section,
.previous-winners-section {
    display: block !important; /* Override inline display:none */
    margin: 0;
    padding: 15px;
    border: 1px solid;
    background: rgba(255, 255, 0, 0.03);
    border-radius: 8px;
    min-height: 200px;
    max-height: 300px;
    overflow: hidden;
}

.holders-section {
    border-color: #ff00ff;
    background: rgba(255, 0, 255, 0.03);
}

.winners-section {
    border-color: #ffff00;
    background: rgba(255, 255, 0, 0.03);
}

.previous-winners-section {
    border-color: #00ffff;
    background: rgba(0, 255, 255, 0.03);
}

.holders-title,
.winners-title,
.previous-winners-title {
    color: inherit;
    font-weight: 700;
    margin-bottom: 12px;
    text-align: center;
    font-size: 14px;
    text-shadow: 0 0 8px currentColor;
}

.holders-list,
.winner-list {
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.minesweeper-grid {
    display: grid;
    grid-template-columns: repeat(5, 128px);
    grid-auto-rows: 128px;
    gap: 8px;
    margin: 0 auto;
    padding: 20px;
    border: 1px solid #ff00ff;
    background: rgba(255, 0, 255, 0.02);
    border-radius: 8px;
    justify-content: center;
    max-width: fit-content;
}

.console-section {
    background: #000;
    border: 1px solid #00ff41;
    height: 180px;
    overflow-y: auto;
    margin: 0;
    padding: 8px;
    font-size: 9px;
    border-radius: 6px;
    box-shadow: inset 0 0 20px #00000080;
}

/* Responsive Design */
@media (max-width: 1200px) {
    .panels-container {
        grid-template-columns: 1fr;
        max-width: 800px;
    }
}

@media (max-width: 768px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 128px);
        gap: 6px;
        padding: 10px;
    }
    
    .panels-container {
        gap: 10px;
    }
    
    .holders-section,
    .winners-section,
    .previous-winners-section {
        min-height: 180px;
        max-height: 250px;
        padding: 10px;
    }
}

@media (max-width: 480px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 110px);
        grid-auto-rows: 110px;
    }
    
    .panels-container {
        grid-template-columns: 1fr;
    }
}.main-content {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 20px;
    margin: 20px 0;
    align-items: start;
}

.minesweeper-grid {
    display: grid;
    grid-template-columns: repeat(5, 128px);
    grid-auto-rows: 128px;
    gap: 8px;
    padding: 20px;
    border: 1px solid #ff00ff;
    background: rgba(255, 0, 255, 0.02);
    border-radius: 8px;
    justify-content: center;
}

.right-panel {
    display: flex;
    flex-direction: column;
    gap: 15px;
    height: 100%;
}

.panels-container {
    display: grid;
    grid-template-columns: 1fr;
    gap: 15px;
    flex: 1;
}

.holders-section,
.winners-section,
.previous-winners-section {
    display: block !important;
    margin: 0;
    padding: 15px;
    border: 1px solid;
    background: rgba(255, 255, 0, 0.03);
    border-radius: 8px;
    min-height: 150px;
    max-height: 200px;
    overflow: hidden;
}

.holders-section {
    border-color: #ff00ff;
    background: rgba(255, 0, 255, 0.03);
}

.winners-section {
    border-color: #ffff00;
    background: rgba(255, 255, 0, 0.03);
}

.previous-winners-section {
    border-color: #00ffff;
    background: rgba(0, 255, 255, 0.03);
}

.holders-title,
.winners-title,
.previous-winners-title {
    color: inherit;
    font-weight: 700;
    margin-bottom: 10px;
    text-align: center;
    font-size: 14px;
    text-shadow: 0 0 8px currentColor;
}

.holders-list,
.winner-list {
    max-height: 140px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.console-section {
    background: #000;
    border: 1px solid #00ff41;
    height: 200px;
    overflow-y: auto;
    margin: 0;
    padding: 10px;
    font-size: 10px;
    border-radius: 6px;
    box-shadow: inset 0 0 20px #00000080;
    flex-shrink: 0;
}

/* Responsive Design */
@media (max-width: 1024px) {
    .main-content {
        grid-template-columns: 1fr;
        gap: 15px;
    }
    
    .minesweeper-grid {
        justify-self: center;
    }
    
    .right-panel {
        order: -1;
    }
}

@media (max-width: 768px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 128px);
        gap: 6px;
        padding: 15px;
    }
    
    .holders-section,
    .winners-section,
    .previous-winners-section {
        min-height: 120px;
        max-height: 180px;
        padding: 10px;
    }
    
    .holders-list,
    .winner-list {
        max-height: 110px;
    }
}

@media (max-width: 480px) {
    .minesweeper-grid {
        grid-template-columns: repeat(2, 110px);
        grid-auto-rows: 110px;
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
    <div class="progress-title">CURRENT ROUND BLOCKS PROGRESS</div>
    <div style="text-align: center; color: #ffff00; margin-bottom: 10px; font-size: 14px;">
        TOKEN: ${TOKEN_MINT}
    </div>
    <div class="progress-text" id="progress-text">0/100 Blocks (0%)</div>
    <div class="progress-bar">
        <div class="progress-fill" id="progress-fill"></div>
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
                <div class="stat-label">TOTAL REVEALED BLOCKS</div>
                <div class="stat-value" id="total-occupied">0</div>
            </div>
        </div>
<div class="main-content">
    <div class="minesweeper-grid" id="minesweeper-grid"></div>
    
    <div class="right-panel">
        <div class="panels-container">
            <div class="holders-section" id="holders-section">
                <div class="holders-title">🏦 1% HOLDERS BLOCKS 🏦</div>
                <div class="holders-list" id="holders-list"></div>
            </div>
            
            <div class="winners-section" id="winners-section">
                <div class="winners-title">🏆 CURRENT ROUND BUYERS 🏆</div>
                <div class="winner-list" id="winner-list"></div>
            </div>
            
            <div class="previous-winners-section" id="previous-winners-section">
                <div class="previous-winners-title">📋 PREVIOUS ROUND WINNERS 📋</div>
                <div class="winner-list" id="previous-winner-list"></div>
            </div>
        </div>
        
        <div class="console-section" id="console-output">
            <div class="console-line console-info">Initializing Game System...</div>
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
            document.getElementById('progress-details').textContent = 
                \`\${gameData.revealedGreenBlocks} Green Blocks + \${stats.totalOccupiedBlocks - gameData.revealedGreenBlocks} Red Blocks = \${stats.totalOccupiedBlocks} Total Revealed Blocks\`;
            
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
                        <span class="block-number">\${index + 1}</span><BR><BR>
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

