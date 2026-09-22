/**
 * Drop a market from the on-chain registry.
 *
 *   pnpm exec ts-node --transpile-only scripts/remove-market.ts <marketId> [--yes]
 *
 * The program enforces what it can see: the market must exist and must already
 * be disabled. It cannot enforce the dangerous half, because it cannot
 * enumerate pools inside one instruction, so that check lives here.
 *
 * Why it matters: every pool holding a position resolves its market through
 * `registry.find(market_id)`. A miss is not a soft failure. `mark_positions`
 * returns MarketNotFound, and from that point the pool cannot be marked,
 * traded, unwound OR redeemed from until the market is registered again. This
 * script refuses to send unless every pool is clear.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { VaultClient, VAULT_PROGRAM_ID } from "../packages/sdk/src";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const symbolOf = (b: number[] | Uint8Array) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");

function loadKeypair(p = process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json") {
  const path = p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const marketId = Number(process.argv[2]);
  const yes = process.argv.includes("--yes");
  if (!Number.isInteger(marketId)) {
    console.error("usage: remove-market.ts <marketId> [--yes]");
    process.exit(1);
  }

  const admin = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const client = new VaultClient(provider, new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID));

  const reg = await client.registry();
  const market = (reg.markets as any[]).slice(0, reg.count).find((m) => m.marketId === marketId);
  if (!market) {
    console.error(`market ${marketId} is not in the registry (${reg.count} markets: ${(reg.markets as any[]).slice(0, reg.count).map((m) => m.marketId).join(", ")})`);
    process.exit(1);
  }
  const sym = symbolOf(market.symbol);
  console.log(`market ${marketId} (${sym}) · enabled=${market.enabled} · oracle ${market.oracle.toBase58()}`);

  if (market.enabled) {
    console.error(`\nREFUSING: ${sym} is still enabled. Disable it first so no new position can open:`);
    console.error(`  client.setMarketEnabled(admin, ${marketId}, false)`);
    process.exit(2);
  }

  // The check the program cannot do for itself.
  const pools = await client.allPools();
  const holders: string[] = [];
  for (const { publicKey, account } of pools as any[])
    for (const p of account.positions)
      if (p.side !== 0 && p.marketId === marketId) holders.push(`${publicKey.toBase58()} (qty ${p.baseQty.toString()})`);

  console.log(`checked ${pools.length} pools for open positions in market ${marketId}: ${holders.length} found`);
  if (holders.length) {
    console.error(`\nREFUSING: removing a market out from under an open position makes that pool`);
    console.error(`unmarkable, untradeable, unwindable and unredeemable. Close these first:`);
    for (const h of holders) console.error(`  ${h}`);
    process.exit(3);
  }

  if (!yes) {
    console.log(`\nDry run. ${sym} is disabled and held by no pool. Safe to remove.`);
    console.log(`Re-run with --yes to send.`);
    return;
  }

  const sig = await client.removeMarket(admin.publicKey, marketId).rpc();
  const after = await client.registry();
  console.log(`removed ${sym}: ${sig}`);
  console.log(`registry ${reg.count} -> ${after.count} markets: ${(after.markets as any[]).slice(0, after.count).map((m) => `${m.marketId}:${symbolOf(m.symbol)}`).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
