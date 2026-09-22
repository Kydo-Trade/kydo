/**
 * Post-upgrade layout migration: grows every pre-upgrade Pool / TraderProfile
 * account by its appended bytes (ends_at / instant_cap / stops /
 * venue_accounted_quote / first_loss_seed / investor_principal) via the
 * admin-only `migrate_account` instruction. Idempotent. Accounts already at
 * the current size are skipped.
 *
 * Zero is NOT "feature off" for the last three of those. Read the warnings
 * below before running this against anything that holds money.
 *
 * WARNING. The zero-fill BREAKS first-loss ordering, in both directions, and
 * the direction depends on when the pool was created. `realloc(zero_init)`
 * clears every byte past the old length, so a pool predating `e28fa1b` gets
 * `first_loss_seed = 0` as well as `investor_principal = 0`: `min(equity - 0, 0)`
 * is 0, investor NAV reads as the whole equity with no cushion in front of it,
 * and exits are OVER-paid. A pool created between `e28fa1b` and `5226575`
 * already has a seed and gets only `investor_principal` zero-filled, so
 * `remaining_first_loss` becomes a constant reserve that is never spent and
 * exits are UNDER-paid by the seed pro-rata. The first case becomes the second
 * as soon as anyone calls `promote_tier`. It is permissionless and raises
 * `first_loss_seed` without touching `investor_principal`. There is no
 * instruction to backfill it: reap such a pool and re-fund it instead, and do
 * not migrate a pool with shares outstanding.
 *
 * WARNING. Drift pools holding venue collateral must not be migrated by this
 * script. `venue_accounted_quote` zero-fills, and a zero baseline against a
 * non-zero Drift balance makes the next `sync_venue` read the whole deposit as
 * profit and accrue 80% of it to the trader's escrow. Such a pool needs the
 * baseline seeded with its current `usdc_balance + Σ quote over flat slots`
 * first. Safe today: no Drift pool has ever been funded.
 *
 * Migrated pools also come back with no stops, so their open positions block
 * new trades (`StopMissing`) until they are closed. That is deliberate.
 *
 * Usage: SOLANA_RPC_URL=<rpc> ts-node --transpile-only scripts/migrate-accounts.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { VaultClient, VAULT_PROGRAM_ID } from "../packages/sdk/src";
import idl from "../packages/sdk/src/idl/vault.json";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

function loadKeypair(p = process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json") {
  const path = p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const admin = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID);
  const client = new VaultClient(provider, programId);

  for (const name of ["Pool", "TraderProfile"]) {
    const acc = (idl as any).accounts.find((a: any) => a.name === name);
    if (!acc) throw new Error(`${name} missing from IDL`);
    const disc = Buffer.from(acc.discriminator);
    // Anchor size = 8 + INIT_SPACE; measure from a current-layout account if one
    // exists, else compute nothing. The program itself rejects already-current
    // accounts with InvalidArgument, so we just try every one and classify.
    const raw = await connection.getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
    });
    console.log(`${name}: ${raw.length} accounts, sizes ${[...new Set(raw.map((r) => r.account.data.length))].join("/")}`);
    for (const r of raw) {
      try {
        const sig = await (client.program.methods as any)
          .migrateAccount()
          .accounts({ admin: admin.publicKey, config: client.pda.platform(), target: r.pubkey, systemProgram: SystemProgram.programId })
          .rpc();
        console.log(`  migrated ${r.pubkey.toBase58()} (${r.account.data.length}B) ${sig}`);
      } catch (e: any) {
        const msg = String(e.message ?? e);
        if (msg.includes("InvalidArgument")) console.log(`  current  ${r.pubkey.toBase58()} (${r.account.data.length}B)`);
        else throw e;
      }
    }
  }
  console.log("migration done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
