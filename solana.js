import { Connection, PublicKey } from "@solana/web3.js";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY";

export const connection = new Connection(RPC_ENDPOINT, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

export async function fetchAllTokenAccounts(mintAddress) {
  const mintPublicKey = new PublicKey(mintAddress);
  const filters = [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: mintPublicKey.toBase58() } },
  ];
  try {
    const accounts = await connection.getParsedProgramAccounts(
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      { filters }
    );
    return accounts
      .map(acc => {
        const parsed = acc.account.data.parsed;
        return {
          address: acc.pubkey.toBase58(),
          owner: parsed.info.owner,
          amount: Number(parsed.info.tokenAmount.amount) / Math.pow(10, parsed.info.tokenAmount.decimals),
        };
      })
      .filter(a => a.amount > 0);
  } catch (err) {
    console.error("Error fetching token accounts:", err);
    return [];
  }
}

export function analyze(fresh) {
  const totalHolders = fresh.length;
  let top50 = fresh.slice().sort((a, b) => b.amount - a.amount).slice(0, 50);
  return { totalHolders, top50 };
}
