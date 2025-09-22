import React, { useState, useEffect, useRef } from 'react';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";

const CREATOR_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
const SCANNER_RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a";
const PUMP_TOKEN_MINT = "Gupf4N7c9WWr87naP2pC2m5JCwrs8QFBRB6yC1Xomxr7";
const SECRET_KEY = new Uint8Array([

]);
const MIN_FEES_TO_COLLECT_SOL = 0.05;
const ATH_BUY_MIN_SOL = 0.1;
const POLL_INTERVAL_MS = 2000;

const creatorConnection = new Connection(CREATOR_RPC_ENDPOINT, "confirmed");
const scannerConnection = new Connection(SCANNER_RPC_ENDPOINT, { commitment: "confirmed" });
const wallet = Keypair.fromSecretKey(SECRET_KEY);
const sdk = new OnlinePumpSdk(creatorConnection);

const MMORPGDashboard = () => {
  const [gameState, setGameState] = useState({
    boss: {
      name: "BEAR MARKET BOSS",
      hp: 100,
      maxHp: 100,
      attack: 10,
      level: 1,
      isAttacking: false
    },
    players: [],
    athBuyers: [],
    tokenPrice: 0,
    volume24h: 0,
    totalHolders: 0,
    collectedFees: 0,
    lastAth: null,
    transactions: [],
    consoleMessages: []
  });

  const [dashboardData, setDashboardData] = useState({
    priceHistory: [],
    allTimeHighPrice: 0,
    athPurchases: [],
    fullTransactions: [],
    stats: {
      totalATHPurchases: 0,
      uniqueBuyers: 0,
      trackedTransactions: 0,
      lastPrice: 0,
      priceChange24h: 0
    },
    athChad: null,
    recentAthPurchases: []
  });

  const processedTransactions = useRef(new Set());
  const recentHolders = useRef(new Set());
  const allTimeHighPrice = useRef(0);
  const athPurchases = useRef([]);
  const fullTransactions = useRef([]);
  const priceHistory = useRef([]);
  const consoleMessages = useRef([]);

  const logToConsole = (message, type = 'info') => {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type, id: Date.now() + Math.random() };
    consoleMessages.current.push(logEntry);
    if (consoleMessages.current.length > 500) consoleMessages.current.shift();
    
    setGameState(prev => ({
      ...prev,
      consoleMessages: [...consoleMessages.current].slice(-50)
    }));
  };

  const fetchTokenPrice = async (mintAddress) => {
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintAddress}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data[mintAddress]) {
        const tokenData = data[mintAddress];
        const price = tokenData.usdPrice || 0;
        const isNewATH = price > allTimeHighPrice.current;
        
        if (isNewATH) {
          allTimeHighPrice.current = price;
          logToConsole(`🚀 NEW ALL-TIME HIGH: $${price.toFixed(8)}`, 'success');
        }

        const priceEntry = {
          price,
          timestamp: Date.now(),
          isNewATH,
          priceChange24h: tokenData.priceChange24h || 0
        };

        priceHistory.current.push(priceEntry);
        if (priceHistory.current.length > 1000) priceHistory.current.shift();

        setGameState(prev => ({
          ...prev,
          tokenPrice: price
        }));

        setDashboardData(prev => ({
          ...prev,
          priceHistory: [...priceHistory.current],
          allTimeHighPrice: allTimeHighPrice.current
        }));

        return priceEntry;
      }
      return null;
    } catch (e) {
      logToConsole(`Error fetching price: ${e.message}`, 'error');
      return null;
    }
  };

  const calculateSolSpent = (tx) => {
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
      return { solSpent: 0, buyer: null };
    }
  };

  const analyzeTokenPurchase = async (tx, signature, currentPrice) => {
    try {
      if (!tx?.meta || !tx?.transaction) return null;
      const postTokenBalances = tx.meta?.postTokenBalances || [];
      const tokenTransfers = postTokenBalances.filter(balance =>
        balance?.mint === PUMP_TOKEN_MINT && balance?.uiTokenAmount?.uiAmount > 0
      );
      if (tokenTransfers.length === 0) return null;

      const { solSpent, buyer } = calculateSolSpent(tx);
      const purchases = [];

      for (const transfer of tokenTransfers) {
        const wallet = transfer.owner || 'unknown';
        const tokenAmount = transfer.uiTokenAmount?.uiAmount || 0;
        if (recentHolders.current.has(wallet)) continue;

        const pricePerToken = solSpent > 0 && tokenAmount > 0 ? solSpent / tokenAmount : 0;
        const marketPrice = currentPrice || 0;
        const isATHPurchase = marketPrice >= allTimeHighPrice.current;

        const purchaseDetails = {
          wallet,
          buyerAddress: buyer,
          signature,
          timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown",
          txTime: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
          solAmount: solSpent,
          tokenAmount,
          pricePerToken,
          marketPrice,
          isATHPurchase,
          slot: tx.slot || 0,
          fee: tx.meta.fee ? tx.meta.fee / LAMPORTS_PER_SOL : 0
        };

        purchases.push(purchaseDetails);
        recentHolders.current.add(wallet);

        if (isATHPurchase) {
          athPurchases.current.push(purchaseDetails);
          logToConsole(`🎯 ATH PURCHASE! ${wallet} bought at $${marketPrice.toFixed(8)}`, 'success');
          
          setGameState(prev => ({
            ...prev,
            boss: {
              ...prev.boss,
              hp: Math.max(0, prev.boss.hp - solSpent * 10),
              isAttacking: false
            },
            players: [...prev.players.filter(p => p.wallet !== wallet), {
              wallet,
              damage: solSpent * 10,
              level: Math.floor(solSpent * 100),
              lastAction: Date.now()
            }]
          }));
        }
      }

      return purchases.length > 0 ? purchases : null;
    } catch (e) {
      return null;
    }
  };

  const monitorNewTokenTransactions = async (currentPrice) => {
    try {
      const mintPublicKey = new PublicKey(PUMP_TOKEN_MINT);
      const signatures = await scannerConnection.getSignaturesForAddress(mintPublicKey, { limit: 10 });
      const newPurchases = [];

      for (const sig of signatures) {
        if (processedTransactions.current.has(sig.signature)) continue;
        
        try {
          const tx = await scannerConnection.getTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          });

          if (!tx || !tx.meta || tx.meta.err) {
            processedTransactions.current.add(sig.signature);
            continue;
          }

          const txTime = tx.blockTime ? tx.blockTime * 1000 : 0;
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          if (txTime < fiveMinutesAgo) {
            processedTransactions.current.add(sig.signature);
            continue;
          }

          const purchase = await analyzeTokenPurchase(tx, sig.signature, currentPrice);
          if (purchase) {
            processedTransactions.current.add(sig.signature);
            newPurchases.push(purchase);
          } else {
            processedTransactions.current.add(sig.signature);
          }
        } catch (e) {
          processedTransactions.current.add(sig.signature);
        }
      }

      return newPurchases;
    } catch (e) {
      return [];
    }
  };

  const collectCreatorFeesIfNeeded = async () => {
    try {
      const balanceLamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
      const balanceSol = Number(balanceLamports) / LAMPORTS_PER_SOL;
      
      if (balanceSol > MIN_FEES_TO_COLLECT_SOL) {
        try {
          const sig = await sdk.collectCreatorFees(wallet);
          logToConsole(`✅ Collected ${balanceSol} SOL fees! TX: ${sig}`, 'success');
          
          setGameState(prev => ({
            ...prev,
            collectedFees: prev.collectedFees + balanceSol
          }));

          const athChad = athPurchases.current
            .filter(p => p.isATHPurchase && p.solAmount >= ATH_BUY_MIN_SOL)
            .sort((a, b) => b.marketPrice - a.marketPrice)[0];

          if (athChad) {
            const rewardSol = balanceSol * 0.4;
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: new PublicKey(athChad.wallet),
                lamports: Math.floor(rewardSol * LAMPORTS_PER_SOL)
              })
            );
            await creatorConnection.sendTransaction(tx, [wallet]);
            logToConsole(`🎁 Sent ${rewardSol} SOL to ATH Chad: ${athChad.wallet}`, 'success');
          }

          return balanceSol;
        } catch (err) {
          logToConsole(`Failed to collect fees: ${err.message}`, 'error');
          return 0;
        }
      }
      return 0;
    } catch (err) {
      return 0;
    }
  };

  useEffect(() => {
    const gameLoop = setInterval(async () => {
      try {
        const priceData = await fetchTokenPrice(PUMP_TOKEN_MINT);
        await monitorNewTokenTransactions(priceData?.price);
        
        const recentAth = athPurchases.current
          .filter(p => p.isATHPurchase)
          .sort((a, b) => b.txTime - a.txTime)
          .slice(0, 10);

        const athChad = athPurchases.current
          .filter(p => p.isATHPurchase && p.solAmount >= ATH_BUY_MIN_SOL)
          .sort((a, b) => b.marketPrice - a.marketPrice)[0] || null;

        setDashboardData(prev => ({
          ...prev,
          athPurchases: [...athPurchases.current],
          recentAthPurchases: recentAth,
          athChad,
          stats: {
            totalATHPurchases: athPurchases.current.filter(p => p.isATHPurchase).length,
            uniqueBuyers: new Set(athPurchases.current.filter(p => p.isATHPurchase).map(p => p.wallet)).size,
            trackedTransactions: fullTransactions.current.length,
            lastPrice: priceData?.price || 0,
            priceChange24h: priceData?.priceChange24h || 0
          }
        }));

        if (Math.random() > 0.7) {
          setGameState(prev => ({
            ...prev,
            boss: {
              ...prev.boss,
              isAttacking: true
            }
          }));
          
          setTimeout(() => {
            setGameState(prev => ({
              ...prev,
              boss: {
                ...prev.boss,
                isAttacking: false
              }
            }));
          }, 1000);
        }

        if (Date.now() % 30000 === 0) {
          await collectCreatorFeesIfNeeded();
        }
      } catch (error) {
        logToConsole(`Game loop error: ${error.message}`, 'error');
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(gameLoop);
  }, []);

  const BossHealthBar = ({ hp, maxHp }) => (
    <div style={{ 
      width: '100%', 
      background: '#333', 
      borderRadius: '10px', 
      overflow: 'hidden',
      margin: '10px 0',
      border: '2px solid #ff4444'
    }}>
      <div style={{
        width: `${(hp / maxHp) * 100}%`,
        height: '30px',
        background: hp > 50 ? '#ff4444' : hp > 20 ? '#ffaa00' : '#ff0000',
        transition: 'all 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontWeight: 'bold',
        textShadow: '2px 2px 4px rgba(0,0,0,0.5)'
      }}>
        {hp.toFixed(0)}/{maxHp}
      </div>
    </div>
  );

  const PlayerCard = ({ player }) => (
    <div style={{
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '10px',
      margin: '5px',
      borderRadius: '8px',
      color: 'white',
      minWidth: '200px'
    }}>
      <div style={{ fontWeight: 'bold' }}>👤 {player.wallet.slice(0, 8)}...</div>
      <div>⚔️ Damage: {player.damage}</div>
      <div>⭐ Level: {player.level}</div>
    </div>
  );

  return (
    <div style={{
      background: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)',
      minHeight: '100vh',
      color: 'white',
      fontFamily: 'Arial, sans-serif'
    }}>
      {/* Header */}
      <div style={{
        background: 'rgba(0,0,0,0.8)',
        padding: '20px',
        textAlign: 'center',
        borderBottom: '3px solid #ffd700'
      }}>
        <h1 style={{ 
          color: '#ffd700', 
          fontSize: '3em',
          textShadow: '0 0 20px #ffd700',
          margin: 0 
        }}>
          🏰 PUMP MMORPG BATTLE
        </h1>
        <div style={{ fontSize: '1.2em', opacity: 0.8 }}>
          Every holder is a hero fighting the Bear Market Boss!
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', padding: '20px', gap: '20px' }}>
        
        {/* Left Column - Game View */}
        <div style={{ flex: '2', minWidth: '300px' }}>
          
          {/* Boss Section */}
          <div style={{
            background: 'rgba(0,0,0,0.6)',
            padding: '20px',
            borderRadius: '15px',
            border: '2px solid #ff4444',
            marginBottom: '20px'
          }}>
            <h2 style={{ 
              color: '#ff4444', 
              textAlign: 'center',
              animation: gameState.boss.isAttacking ? 'shake 0.5s infinite' : 'none'
            }}>
              💀 {gameState.boss.name} 💀
            </h2>
            <BossHealthBar hp={gameState.boss.hp} maxHp={gameState.boss.maxHp} />
            <div style={{ textAlign: 'center', fontSize: '1.2em' }}>
              Level {gameState.boss.level} | Attack: {gameState.boss.attack}
            </div>
          </div>

          {/* Players Grid */}
          <div style={{
            background: 'rgba(0,0,0,0.6)',
            padding: '20px',
            borderRadius: '15px',
            border: '2px solid #667eea'
          }}>
            <h3 style={{ color: '#667eea', marginBottom: '15px' }}>👥 HEROES IN BATTLE</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {gameState.players.slice(0, 12).map((player, index) => (
                <PlayerCard key={index} player={player} />
              ))}
            </div>
          </div>
        </div>

        {/* Right Column - Stats & ATH */}
        <div style={{ flex: '1', minWidth: '300px' }}>
          
          {/* Token Stats */}
          <div style={{
            background: 'rgba(0,0,0,0.6)',
            padding: '20px',
            borderRadius: '15px',
            border: '2px solid #00ff88',
            marginBottom: '20px'
          }}>
            <h3 style={{ color: '#00ff88' }}>📊 TOKEN STATS</h3>
            <div style={{ fontSize: '1.1em' }}>
              <div>💰 Price: ${gameState.tokenPrice.toFixed(8)}</div>
              <div>📈 24h Change: {(dashboardData.stats.priceChange24h * 100).toFixed(2)}%</div>
              <div>🏆 ATH: ${allTimeHighPrice.current.toFixed(8)}</div>
              <div>💸 Collected Fees: {gameState.collectedFees.toFixed(4)} SOL</div>
            </div>
          </div>

          {/* ATH Chad */}
          {dashboardData.athChad && (
            <div style={{
              background: 'linear-gradient(135deg, #ffd700 0%, #ff6b00 100%)',
              padding: '20px',
              borderRadius: '15px',
              marginBottom: '20px',
              color: 'black',
              fontWeight: 'bold'
            }}>
              <h3 style={{ textAlign: 'center', marginBottom: '15px' }}>👑 ATH CHAD</h3>
              <div>Wallet: {dashboardData.athChad.wallet}</div>
              <div>Paid: ${dashboardData.athChad.marketPrice.toFixed(8)}</div>
              <div>Amount: {dashboardData.athChad.solAmount} SOL</div>
            </div>
          )}

          {/* Console */}
          <div style={{
            background: 'rgba(0,0,0,0.8)',
            padding: '15px',
            borderRadius: '10px',
            border: '1px solid #666',
            height: '300px',
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: '12px'
          }}>
            <div style={{ color: '#00ff88', marginBottom: '10px' }}>💻 LIVE CONSOLE</div>
            {gameState.consoleMessages.map((msg, index) => (
              <div key={index} style={{ 
                color: msg.type === 'error' ? '#ff4444' : msg.type === 'success' ? '#00ff88' : '#888',
                marginBottom: '2px'
              }}>
                [{new Date(msg.timestamp).toLocaleTimeString()}] {msg.message}
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes shake {
          0% { transform: translateX(0); }
          25% { transform: translateX(-5px); }
          50% { transform: translateX(5px); }
          75% { transform: translateX(-5px); }
          100% { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
};

export default MMORPGDashboard;
