/**
 * Transaction sending: priority fees on every tx; Jito bundles for the
 * latency-critical lock / unwind path when a block engine is configured (section 3.4).
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import pino from "pino";
import { env } from "./config";

const log = pino({ level: env.logLevel, name: "tx" });

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export async function sendWithPriority(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  opts: {
    cuLimit?: number;
    label?: string;
    /** extra (ephemeral) signers, e.g. Pyth price-update / encoded-VAA accounts */
    signers?: Signer[];
    /** Reuse a blockhash already fetched for this round. One getLatestBlockhash
     *  per transaction is a third of the Pyth pusher's RPC calls, and on a
     *  throttled endpoint every avoided call is one less chance of a 429. */
    blockhash?: { blockhash: string; lastValidBlockHeight: number };
  } = {},
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit ?? 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: env.priorityFee }),
    ...ixs,
  );
  const { blockhash, lastValidBlockHeight } = opts.blockhash ?? (await connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...(opts.signers ?? []));
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log.debug({ sig, label: opts.label }, "confirmed");
  return sig;
}

/**
 * Send as a Jito bundle (one tx + tip) via the block engine JSON-RPC.
 * Falls back to a priority-fee send when no block engine is configured
 * or the bundle submission fails. A lock must never be dropped.
 */
export async function sendCritical(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  label: string,
): Promise<string> {
  if (!env.jitoUrl) return sendWithPriority(connection, payer, ixs, { label });
  try {
    const tip = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: env.priorityFee }),
      ...ixs,
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tip, lamports: env.jitoTipLamports }),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const raw = tx.serialize();
    const res = await fetch(`${env.jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[bs58.encode(raw)]] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as any;
    if (body.error) throw new Error(JSON.stringify(body.error));
    const sig = bs58.encode(tx.signature!);
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    log.info({ sig, bundle: body.result, label }, "jito bundle landed");
    return sig;
  } catch (e) {
    log.warn({ err: String(e), label }, "jito bundle failed; falling back to priority send");
    return sendWithPriority(connection, payer, ixs, { label });
  }
}
