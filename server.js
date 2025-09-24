import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import express from "express";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { WebSocketServer } from 'ws';
import http from 'http';

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const TOKEN_MINT = "AG6PqNvjrPEA46URPPvxrCZwuZv7zVuLbvbwVBGsyoRh";
const POLL_INTERVAL_MS = 1349;
const MIN_SOL_FOR_BLOCK = 0.1;
const TOTAL_BLOCKS = 100;
const MIN_TOKENS_FOR_GUARANTEED_GREEN = 10000000;
const MAX_TOKENS_FOR_GUARANTEED_GREEN = 31000000;
const GREEN_CHANCE = 0.091;
const BALLOON_INFLATE_AMOUNT = 0.1;

const creatorConnection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sdk = new OnlinePumpSdk(creatorConnection);

// Get wallet from environment variable
const walletSecretKey = JSON.parse(process.env.WALLET_SECRET_KEY);
const SECRET_KEY = new Uint8Array(walletSecretKey);
const wallet = Keypair.fromSecretKey(SECRET_KEY);

const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });

// Game state variables
let allTimeHighPrice = 0;
let currentPrice = 0;
let priceChange24h = 0;
let consoleMessages = [];
let totalVolume = 0;
let creatorFees = 0;
let balloonProgress = 0;
let lastTriggerWallet = null;

// Fee tracking variables
let lastFeesCollected = 0; // Track how much was collected at last distribution
let totalFeesCollected = 0; // Total fees collected since start
let volumeSinceLastCheckpoint = 0;
let lastVolumeCheckpoint = 0;

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

// Enhanced fee distribution logic
async function checkAndDistributeFees() {
    try {
        const currentFees = await fetchCreatorFees();
        
        // Check 1 SOL threshold distribution
        if (currentFees >= 1.0 && creatorFees < 1.0) {
            if (lastTriggerWallet) {
                await collectAndDistributeFees(lastTriggerWallet, 1.0, '1 SOL threshold');
            }
        }
        
        // Check volume-based distribution (every 10 SOL volume)
        if (volumeSinceLastCheckpoint >= 10) {
            if (lastTriggerWallet) {
                await collectAndDistributeFees(lastTriggerWallet, volumeSinceLastCheckpoint, 'volume trigger');
            }
            volumeSinceLastCheckpoint = 0;
            lastVolumeCheckpoint = totalVolume;
        }
        
        creatorFees = currentFees;
    } catch (error) {
        logToConsole(`❌ Fee check failed: ${error.message}`, 'error');
    }
}

async function collectAndDistributeFees(walletAddress, triggerAmount, triggerType) {
    try {
        // First, collect the current fees
        const feesBeforeCollection = await fetchCreatorFees();
        
        const transaction = new Transaction();
        
        // Add fee collection instructions
        const collectInstructions = await sdk.collectCoinCreatorFeeInstructions(wallet.publicKey);
        transaction.add(...collectInstructions);
        
        // Calculate half of the collected amount
        const halfFees = feesBeforeCollection / 2;
        const halfFeesLamports = Math.floor(halfFees * LAMPORTS_PER_SOL);
        
        if (halfFeesLamports > 0) {
            // Add transfer instruction for half the fees
            const transferInstruction = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: new PublicKey(walletAddress),
                lamports: halfFeesLamports
            });
            
            transaction.add(transferInstruction);
            
            const signature = await sendAndConfirmTransaction(
                connection, 
                transaction, 
                [wallet],
                { commitment: "confirmed" }
            );
            
            // Update tracking variables
            lastFeesCollected = feesBeforeCollection;
            totalFeesCollected += feesBeforeCollection;
            
            logToConsole(`💰 ${triggerType.toUpperCase()}! Collected ${feesBeforeCollection.toFixed(4)} SOL fees`, 'success');
            logToConsole(`🎁 Sent ${halfFees.toFixed(4)} SOL (50%) to ${walletAddress.substring(0, 8)}...`, 'success');
            logToConsole(`📊 Total fees collected: ${totalFeesCollected.toFixed(4)} SOL`, 'info');
            logToConsole(`✅ TX: https://solscan.io/tx/${signature}`, 'info');
            
        } else {
            logToConsole(`❌ No fees to collect for ${triggerType}`, 'warning');
        }
        
    } catch (error) {
        logToConsole(`❌ Fee collection/distribution failed: ${error.message}`, 'error');
    }
}

// Balloon inflation with 9.1% chance trigger
function inflateBalloon(purchaseAmount, walletAddress) {
    const inflateAmount = (purchaseAmount / BALLOON_INFLATE_AMOUNT) * 2;
    balloonProgress = Math.min(100, balloonProgress + inflateAmount);
    
    logToConsole(`🎈 Balloon inflated to ${balloonProgress.toFixed(1)}% (+${inflateAmount.toFixed(1)}%) by ${walletAddress.substring(0, 8)}...`, 'info');
    
    // Check for 9.1% chance trigger
    if (Math.random() < 0.091) {
        triggerBalloonPop(walletAddress);
    }
    
    // Update volume tracking
    volumeSinceLastCheckpoint += purchaseAmount;
    totalVolume += purchaseAmount;
    lastTriggerWallet = walletAddress;
}

async function triggerBalloonPop(walletAddress) {
    logToConsole(`🎉 BALLOON POP! 9.1% chance triggered for ${walletAddress.substring(0, 8)}...`, 'success');
    
    const currentFees = await fetchCreatorFees();
    if (currentFees > 0) {
        await collectAndDistributeFees(walletAddress, currentFees, 'balloon pop');
    } else {
        logToConsole(`💔 Balloon popped but no fees to distribute`, 'warning');
    }
    
    balloonProgress = 0; // Reset balloon after pop
}

let cachedFees = 0;
let lastFeesFetchTime = 0;
const CACHE_DURATION = 30000;

async function fetchCreatorFees() {
    const now = Date.now();
    
    if (now - lastFeesFetchTime < CACHE_DURATION) {
        return cachedFees;
    }
    
    try {
        const balanceLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
        const balanceSol = Number(balanceLamports) / LAMPORTS_PER_SOL;
        
        cachedFees = balanceSol;
        lastFeesFetchTime = now;
        
        return balanceSol;
    } catch (err) {
        console.error("Error fetching creator fees:", err);
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
            totalOccupiedBlocks: totalOccupiedBlocks,
            balloonProgress: balloonProgress,
            volumeSinceLastCheckpoint: volumeSinceLastCheckpoint
        },
        stats: {
            uniqueBuyers: new Set(winningWallets.map(p => p.wallet)).size,
            totalBlocksOpened: currentBlockIndex,
            currentPrice: currentPrice,
            priceChange24h: priceChange24h,
            creatorFees: creatorFees,
            totalVolume: totalVolume,
            millionTokenHolders,
            tokenSupply,
            greenChance: GREEN_CHANCE * 100,
            blocksRemaining: TOTAL_BLOCKS - currentBlockIndex,
            assignedGuaranteedBlocks: assignedHoldersThisGame.size,
            revealedGreenBlocks: revealedGreenBlocks,
            totalGreenBlocks: totalGreenBlocks,
            totalOccupiedBlocks: totalOccupiedBlocks,
            balloonProgress: balloonProgress,
            volumeSinceLastCheckpoint: volumeSinceLastCheckpoint,
            lastFeesCollected: lastFeesCollected,
            totalFeesCollected: totalFeesCollected,
            lastTriggerWallet: lastTriggerWallet
        }
    };
}

// ... (rest of the helper functions remain the same: isHolderStillQualified, getAssignedBlockForHolder, logToConsole, fetchTokenSupply, fetchMajorHolders, fetchTokenPrice, assignFreeGreenBlocks, validateGuaranteedBlocks, getTransactionDetails, calculateSolSpent, monitorNewTokenTransactions, analyzeTokenPurchase)

function processGameBlock(purchase) {
    if (gameCompleted) return;
    
    // Inflate balloon with each purchase
    inflateBalloon(purchase.solAmount, purchase.wallet);
    
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
        }
        
        currentBlockIndex = gameBlocks.filter(block => block.status === 'revealed').length;
        if (currentBlockIndex >= TOTAL_BLOCKS) {
            completeGame();
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
    logToConsole(`💰 Starting fee distribution...`, 'info');
    
    distributeFeesToWinners().then(() => {
        logToConsole(`🔄 Starting new game in 3 seconds...`, 'info');
        setTimeout(() => {
            startNewGame();
        }, 3000);
    });
}

async function distributeFeesToWinners() {
    try {
        const currentFees = await fetchCreatorFees();
        
        if (currentFees > 0) {
            const transaction = new Transaction();
            
            // Collect fees first
            const collectInstructions = await sdk.collectCoinCreatorFeeInstructions(wallet.publicKey);
            transaction.add(...collectInstructions);
            
            // Calculate distribution amounts
            const onePercentSOL = currentFees * 0.01;
            const onePercentLamports = Math.floor(onePercentSOL * LAMPORTS_PER_SOL);

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
                walletData.totalPercentage = walletData.greenBlocks;
            });

            const uniqueWinners = Array.from(winnerMap.values());
            
            logToConsole(`🎯 Distributing ${currentFees.toFixed(4)} SOL to ${uniqueWinners.length} winners with ${winningWallets.length} green blocks`, 'info');

            let totalDistributed = 0;

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

            if (transaction.instructions.length > 1) {
                const signature = await sendAndConfirmTransaction(
                    connection, 
                    transaction, 
                    [wallet],
                    { commitment: "confirmed" }
                );
                
                // Update fee tracking
                lastFeesCollected = currentFees;
                totalFeesCollected += currentFees;
                
                logToConsole(`✅ Distribution completed! TX: https://solscan.io/tx/${signature}`, 'success');
                logToConsole(`💰 Total distributed: ${totalDistributed.toFixed(4)} SOL from ${currentFees.toFixed(4)} SOL collected`, 'success');
                logToConsole(`📊 Total lifetime fees collected: ${totalFeesCollected.toFixed(4)} SOL`, 'info');
                
            } else {
                logToConsole(`❌ No fees to distribute`, 'warning');
            }
        } else {
            logToConsole(`❌ No fees available for distribution`, 'warning');
        }

    } catch (error) {
        logToConsole(`❌ Distribution failed: ${error.message}`, 'error');
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
    balloonProgress = 0;
    assignedHoldersThisGame.clear();
    consoleMessages = consoleMessages.slice(-20);
    processedTransactions.clear();
    recentHolders.clear();
    
    logToConsole(`🔄 NEW GAME STARTED! 100 blocks ready`, 'success');
    logToConsole(`🎈 Balloon reset to 0%`, 'info');
    logToConsole(`💰 Fee tracking: ${totalFeesCollected.toFixed(4)} SOL collected lifetime`, 'info');
    logToConsole(`🎯 1M-3M holders get FREE GREEN blocks automatically`, 'info');
    logToConsole(`📊 Volume until next reward: ${volumeSinceLastCheckpoint.toFixed(2)}/10 SOL`, 'info');
    
    assignFreeGreenBlocks();
    broadcastUpdate();
}

// Enhanced HTML with fee tracking display
app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <title>BWANANA.FUN - Enhanced Fee Tracking</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
        /* ... existing styles ... */
        
        .fee-tracking {
            background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8));
            border: 1px solid rgba(64, 224, 208, 0.3);
            border-radius: 12px;
            padding: 15px;
            margin: 15px 0;
        }
        
        .fee-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            margin-bottom: 10px;
        }
        
        .fee-stat {
            text-align: center;
            padding: 10px;
            background: rgba(64, 224, 208, 0.1);
            border-radius: 8px;
        }
        
        .fee-value {
            font-size: 1.2rem;
            font-weight: bold;
            color: #40e0d0;
        }
        
        .fee-label {
            font-size: 0.8rem;
            color: #9ca3af;
        }
        
        .trigger-info {
            background: rgba(255, 105, 180, 0.1);
            padding: 10px;
            border-radius: 8px;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="app-container">
        <div class="header">
            <div class="title">BWANANA.FUN 💰</div>
            <div class="subtitle">Enhanced Fee Tracking - Collect & Distribute Half</div>
        </div>

        <!-- Fee Tracking Section -->
        <div class="fee-tracking">
            <div class="fee-stats">
                <div class="fee-stat">
                    <div class="fee-value" id="current-fees">0.0000</div>
                    <div class="fee-label">Current Creator Fees</div>
                </div>
                <div class="fee-stat">
                    <div class="fee-value" id="last-collected">0.0000</div>
                    <div class="fee-label">Last Collected</div>
                </div>
                <div class="fee-stat">
                    <div class="fee-value" id="total-collected">0.0000</div>
                    <div class="fee-label">Total Collected</div>
                </div>
                <div class="fee-stat">
                    <div class="fee-value" id="volume-progress">0.00/10</div>
                    <div class="fee-label">Volume Progress</div>
                </div>
            </div>
            <div class="trigger-info">
                <div>🎯 Next Trigger: <span id="next-trigger">1 SOL fees or 10 SOL volume</span></div>
                <div>👤 Last Buyer: <span id="last-buyer">None yet</span></div>
                <div>💰 Reward: Collect ALL fees → Send 50% to last buyer</div>
            </div>
        </div>

        <!-- Balloon Section -->
        <div class="balloon-section">
            <div class="balloon-container">
                <div class="balloon" id="balloon"></div>
                <div class="balloon-string"></div>
                <div class="balloon-loading">
                    <div class="balloon-fill" id="balloon-fill"></div>
                </div>
            </div>
            <div class="balloon-info">
                <div>Balloon Progress: <span id="balloon-percent">0%</span> (9.1% pop chance)</div>
                <div>Each 0.1 SOL = +2% inflation</div>
            </div>
        </div>

        <!-- Rest of the HTML remains similar but with updated rules -->
        <div class="progress-section">
            <div class="progress-title">Enhanced Fee Distribution Rules</div>
            <div class="game-rules">
                • <strong>1 SOL Threshold</strong>: When fees reach 1 SOL → Collect ALL → Send 50% to last buyer<br>
                • <strong>Volume Rewards</strong>: Every 10 SOL volume → Collect ALL → Send 50% to last buyer<br>
                • <strong>Balloon Pop</strong>: 9.1% chance on purchase → Collect ALL → Send 50% to buyer<br>
                • <strong>Game Completion</strong>: Distribute 1% per green block to winners<br>
                • <strong>1% Token Holders</strong>: FREE GREEN blocks each round
            </div>
        </div>

        <!-- ... rest of the HTML ... -->
    </div>

    <script>
        function updateGame(data) {
            // Update fee tracking
            document.getElementById('current-fees').textContent = data.stats.creatorFees.toFixed(4);
            document.getElementById('last-collected').textContent = data.stats.lastFeesCollected.toFixed(4);
            document.getElementById('total-collected').textContent = data.stats.totalFeesCollected.toFixed(4);
            document.getElementById('volume-progress').textContent = data.stats.volumeSinceLastCheckpoint.toFixed(2) + '/10';
            
            // Update next trigger info
            const nextTrigger = data.stats.creatorFees >= 1.0 ? 
                'READY (1 SOL reached)' : 
                `1 SOL fees (${(1.0 - data.stats.creatorFees).toFixed(4)} SOL needed)`;
            document.getElementById('next-trigger').textContent = nextTrigger;
            
            document.getElementById('last-buyer').textContent = data.stats.lastTriggerWallet ? 
                data.stats.lastTriggerWallet.substring(0, 8) + '...' : 'None yet';
            
            // Update balloon
            const balloonProgress = data.gameData.balloonProgress || 0;
            const balloonFill = document.getElementById('balloon-fill');
            const balloonPercent = document.getElementById('balloon-percent');
            const balloonElement = document.getElementById('balloon');
            
            balloonFill.style.width = balloonProgress + '%';
            balloonPercent.textContent = balloonProgress.toFixed(1) + '%';
            
            const scale = 1 + (balloonProgress / 100) * 0.5;
            balloonElement.style.transform = `scale(${scale})`;
            
            if (balloonProgress > 80) {
                balloonElement.style.background = 'radial-gradient(circle at 30% 30%, #ff4444, #cc0000)';
            } else if (balloonProgress > 50) {
                balloonElement.style.background = 'radial-gradient(circle at 30% 30%, #ff9966, #ff6600)';
            } else {
                balloonElement.style.background = 'radial-gradient(circle at 30% 30%, #ff69b4, #ff1493)';
            }
            
            // ... rest of the updateGame function ...
        }
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
    logToConsole(`💰 Enhanced Fee Tracking System Started`, 'info');
    logToConsole(`🎯 1 SOL threshold: Collect ALL → Send 50% to last buyer`, 'info');
    logToConsole(`📊 Volume rewards: Every 10 SOL → Collect ALL → Send 50%`, 'info');
    logToConsole(`🎈 Balloon: 9.1% chance to pop and win 50% fees`, 'info');
});

// ... (initialize and mainLoop functions remain the same)

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

            // Check fees with enhanced logic every 1349ms
            if (now - lastFetchCreatorFees >= 1349) {
                await checkAndDistributeFees();
                lastFetchCreatorFees = Date.now();
            }

            // Check major holders every 5 iterations
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

            if (holderCheckCounter % 2 === 0) {
                await fetchTokenPrice();
            }

            if (now - lastMonitorTransactions >= 1349) {
                const newPurchase = await monitorNewTokenTransactions();
                lastMonitorTransactions = now;
                
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

mainLoop().catch(e => {
    logToConsole(`Fatal error: ${e.message}`, 'error');
    process.exit(1);
});
