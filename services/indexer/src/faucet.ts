/**
 * Dev-only faucet: creates the wallet's test-USDC ATA, mints test USDC and
 * airdrops SOL. The indexer holds the mint authority only on localnet/devnet
 * (`FAUCET_ENABLED=true`); the route is absent otherwise.
 */
import { createAssociatedTokenAccountIdempotent, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { env } from "./config";

/** File path (`~` = $HOME) or the inline JSON secret-key array; errors name the path (see keeper/config.ts). */
function loadKeypair(pathOrJson: string, label = "FAUCET_KEYPAIR"): Keypair {
  const v = pathOrJson.trim();
  if (v.startsWith("[")) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(v)));
    } catch (e) {
      throw new Error(`${label}: inline JSON secret key is invalid (${(e as Error).message})`);
    }
  }
  const p = v.startsWith("~") ? resolve(homedir(), v.slice(2)) : resolve(v);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`${label}: no file at ${p}. Set the env var to a keypair file (solana-keygen new -o <file>) or to the JSON secret-key array`);
  }
  if (st.isDirectory()) throw new Error(`${label}: ${p} is a directory, not a keypair file (a Docker bind mount of a missing file creates an empty directory. Check the host path)`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
  } catch (e) {
    throw new Error(`${label}: ${p} is not a valid Solana keypair JSON file (${(e as Error).message})`);
  }
}

export function clusterName(rpc: string): "localnet" | "devnet" | "testnet" | "mainnet" | "custom" {
  if (/127\.0\.0\.1|localhost/.test(rpc)) return "localnet";
  if (/devnet/.test(rpc)) return "devnet";
  if (/testnet/.test(rpc)) return "testnet";
  if (/mainnet/.test(rpc)) return "mainnet";
  return "custom";
}

/** Retry an RPC-backed step through public-devnet throttling (429 / rate limit) with back-off. */
async function throttled<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= attempts - 1 || !/429|rate limit|Too Many Requests/i.test(msg)) throw new Error(`${label}: ${msg}`);
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i)); // 1.5 s → 12 s
    }
  }
}

export class Faucet {
  readonly authority: Keypair;
  readonly mint: PublicKey;
  private payerFloor = 0;
  constructor(private connection: Connection, mint: PublicKey) {
    this.authority = loadKeypair(env.faucetKeypair);
    this.mint = mint;
  }

  /**
   * USDC first (the thing the platform actually needs), then SOL as best effort: the devnet
   * airdrop is rate-limited and the faucet key's own SOL is finite, so a SOL shortfall is
   * reported in `note` instead of failing the whole drip.
   */
  async drip(wallet: PublicKey, usd: number, sol: number): Promise<{ ata: string; usd: number; sol: number; sigs: string[]; note?: string }> {
    const sigs: string[] = [];
    const amount = Math.min(Math.max(0, usd), env.faucetMaxUsd);
    const ata = getAssociatedTokenAddressSync(this.mint, wallet, true);
    // Pre-flight: the faucet key pays fees and (for new wallets) ~0.002 SOL ATA rent, and, since
    // rent-fee enforcement, a transaction may not leave the FEE PAYER below its own rent-exempt
    // floor (~0.00089 SOL). A key sitting exactly at the floor can't sign anything at all, and the
    // RPC only says "account (0) with insufficient funds for rent". Check all of it up front.
    if (!this.payerFloor) this.payerFloor = await throttled("read rent floor", () => this.connection.getMinimumBalanceForRentExemption(0));
    const [payerLamports, ataInfo] = await throttled("check faucet balance", () =>
      Promise.all([this.connection.getBalance(this.authority.publicKey), this.connection.getAccountInfo(ata)]),
    );
    const neededLamports = this.payerFloor + (ataInfo ? 0 : 2_100_000) + 50_000; // stay rent-exempt + ATA rent (if missing) + fee headroom
    if (payerLamports < neededLamports) {
      const key = this.authority.publicKey.toBase58();
      throw new Error(
        `the faucet wallet ${key} has only ${(payerLamports / LAMPORTS_PER_SOL).toFixed(5)} SOL. Below the ${(neededLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL it needs to pay fees and stay rent-exempt, so it cannot sign any transaction. Send it devnet SOL from https://faucet.solana.com and try again`,
      );
    }
    if (!ataInfo) await throttled("create token account", () => createAssociatedTokenAccountIdempotent(this.connection, this.authority, this.mint, wallet));
    if (amount > 0) {
      sigs.push(await throttled("mint test USDC", () => mintTo(this.connection, this.authority, this.mint, ata, this.authority, BigInt(Math.round(amount * 1e6)))));
    }

    let solGiven = 0;
    let note: string | undefined;
    if (sol > 0) {
      try {
        const sig = await this.connection.requestAirdrop(wallet, Math.min(sol, 5) * LAMPORTS_PER_SOL);
        await this.connection.confirmTransaction(sig, "confirmed");
        sigs.push(sig);
        solGiven = Math.min(sol, 5);
      } catch {
        // devnet airdrop rate-limited → transfer from the faucet key, keeping a fee reserve
        const RESERVE = 0.05 * LAMPORTS_PER_SOL;
        const balance = await throttled("read faucet balance", () => this.connection.getBalance(this.authority.publicKey));
        const lamports = Math.min(Math.min(sol, 0.5) * LAMPORTS_PER_SOL, balance - RESERVE);
        if (lamports >= 0.01 * LAMPORTS_PER_SOL) {
          const sig = await throttled("send SOL", () =>
            sendAndConfirmTransaction(
              this.connection,
              new Transaction().add(SystemProgram.transfer({ fromPubkey: this.authority.publicKey, toPubkey: wallet, lamports: Math.floor(lamports) })),
              [this.authority],
            ),
          );
          sigs.push(sig);
          solGiven = lamports / LAMPORTS_PER_SOL;
          if (solGiven < Math.min(sol, 0.5)) note = `The faucet wallet is low on SOL (${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL), so only ${solGiven.toFixed(3)} SOL was sent. Get more at https://faucet.solana.com if you need it.`;
        } else {
          note = `Devnet airdrop is rate-limited and the faucet wallet (${this.authority.publicKey.toBase58().slice(0, 6)}…) has only ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL, so no SOL was sent. Get devnet SOL at https://faucet.solana.com. Your test USDC was minted.`;
        }
      }
    }
    return { ata: ata.toBase58(), usd: amount, sol: Number(solGiven.toFixed(3)), sigs, note };
  }
}
