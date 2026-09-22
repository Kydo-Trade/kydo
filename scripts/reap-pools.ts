/**
 * Devnet janitor: reap every reapable dead pool (section 4.10). Whatever is left in
 * the vault (the unspent part of the trader's first-loss seed, plus dust) is
 * split REAP_PLATFORM_BPS to the treasury and the rest to the CommonPool, where
 * it raises NAV/share; rent returns to the treasury. Skips pools that still owe
 * someone something and says why.
 * Usage: SOLANA_RPC_URL=<rpc> ts-node --transpile-only scripts/reap-pools.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { DEAD_SHARES, VaultClient, VAULT_PROGRAM_ID } from "../packages/sdk/src";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// From the SDK, not a local copy: this was hand-written as 1_000_000 against the
// program's 1_000_000_000 and silently skipped every reapable create_pool pool.
const DEAD = BigInt(DEAD_SHARES.toString());

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(homedir(), ".config/solana/id.json"), "utf8"))));
  const provider = new anchor.AnchorProvider(new Connection(RPC, "confirmed"), new anchor.Wallet(admin), { commitment: "confirmed" });
  const client = new VaultClient(provider, new PublicKey(VAULT_PROGRAM_ID));
  const pools = await (client.program.account as any).pool.all();
  let reaped = 0;
  for (const { publicKey, account: p } of pools) {
    const addr = publicKey.toBase58();
    const status = Object.keys(p.status)[0];
    const skip =
      status !== "locked" ? `status ${status}` :
      p.openPositions > 0 ? `${p.openPositions} open positions` :
      BigInt(p.totalShares.toString()) > DEAD ? "investors still hold shares" :
      p.pendingRedemptionShares.toString() !== "0" ? "pending redemptions" :
      p.escrowTotal.toString() !== "0" || p.vestedClaimable.toString() !== "0" ? "trader escrow unclaimed" : null;
    if (skip) { console.log(`skip  ${addr}  (${skip})`); continue; }
    try {
      const sig = await (client as any).reapPool(admin.publicKey, publicKey).rpc();
      console.log(`REAPED ${addr}  ${sig}`);
      reaped++;
    } catch (e: any) {
      console.log(`fail  ${addr}  ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  console.log(`done: ${reaped} reaped of ${pools.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
