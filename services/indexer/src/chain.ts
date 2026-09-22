/**
 * Chain access: Anchor program handle, account snapshots, oracle price reads
 * (mock oracle or Pyth PriceUpdateV2), and the event listener/backfill.
 */
import { AnchorProvider, BorshCoder, EventParser, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import pino from "pino";
import { PYTH_RECEIVER_PROGRAM_ID, VAULT_IDL, VaultClient, MarketLike } from "@kydo/sdk";
import { env } from "./config";

const log = pino({ level: env.logLevel, name: "chain" });

/**
 * `connection.getTransactions()` sends ONE JSON-RPC batch (an array payload),
 * and some providers sell that as a paid feature. Helius's free plan answers
 * `-32403 Batch requests are only available for paid plans`. That never heals,
 * so once seen we latch it and fetch one signature at a time for the rest of
 * the process instead of burning the retry ladder (1.5 s -> 48 s, five times,
 * ~93 s) on every chunk forever. Slower, but ingestion actually progresses.
 */
let batchRpcUnsupported = false;
const isBatchUnsupported = (e: unknown) => /-32403|[Bb]atch requests are only available/.test(String(e));

export interface Price {
  price: number; // USD float
  conf: number;
  ts: number;
}

export function makeClient(): { connection: Connection; client: VaultClient } {
  const connection = new Connection(env.rpcUrl, { commitment: "confirmed", wsEndpoint: env.wsUrl });
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" });
  return { connection, client: new VaultClient(provider, env.programId) };
}

function normalize(price: bigint, conf: bigint, expo: number): { price: number; conf: number } {
  const f = Math.pow(10, expo);
  return { price: Number(price) * f, conf: Number(conf) * f };
}

/** Parse a Pyth `PriceUpdateV2` account (same layout the program reads). */
export function parsePriceUpdateV2(data: Buffer): { feedId: string; price: number; conf: number; publishTime: number; slot: number } | null {
  if (data.length < 8 + 32 + 1) return null;
  let o = 8 + 32;
  const level = data[o];
  o += 1;
  if (level === 0) o += 1;
  const feedId = data.subarray(o, o + 32).toString("hex");
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const expo = data.readInt32LE(o);
  o += 4;
  const publishTime = Number(data.readBigInt64LE(o));
  o += 8 + 8 + 8 + 8;
  const slot = Number(data.readBigUInt64LE(o));
  const n = normalize(price, conf, expo);
  return { feedId, price: n.price, conf: n.conf, publishTime, slot };
}

/** Read the current price for every market from its oracle account. */
export async function readOraclePrices(connection: Connection, client: VaultClient, markets: MarketLike[]): Promise<Map<number, Price>> {
  const out = new Map<number, Price>();
  if (!markets.length) return out;
  const infos = await connection.getMultipleAccountsInfo(markets.map((m) => m.oracle));
  infos.forEach((info, i) => {
    const m = markets[i];
    if (!info) return;
    try {
      if (info.owner.equals(client.programId)) {
        const mock = (client.program.coder.accounts as any).decode("mockOracle", info.data);
        const n = normalize(BigInt(mock.price.toString()), BigInt(mock.conf.toString()), mock.expo);
        // A mock oracle nobody feeds reads 0 at publishTime 0. Serving that put
        // a retired market into /prices at $0.0000 as though it were a real
        // quote. No price is the honest answer; the program rejects a
        // zero-priced oracle anyway.
        if (n.price > 0) out.set(m.marketId, { price: n.price, conf: n.conf, ts: Number(mock.publishTime) });
      } else if (info.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) {
        const p = parsePriceUpdateV2(info.data);
        if (p && p.price > 0) out.set(m.marketId, { price: p.price, conf: p.conf, ts: p.publishTime });
      }
    } catch (e) {
      log.warn({ market: m.symbol, err: String(e) }, "oracle decode failed");
    }
  });
  return out;
}

export interface DecodedEvent {
  name: string;
  data: any;
  sig: string;
  slot: number;
  idx: number;
}

export function eventParser(): EventParser {
  return new EventParser(env.programId, new BorshCoder({ ...(VAULT_IDL as any), address: env.programId.toBase58() }));
}

/** Decode all program events in a transaction's logs. */
export function decodeLogs(parser: EventParser, logs: string[], sig: string, slot: number): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  let idx = 0;
  for (const ev of parser.parseLogs(logs)) {
    out.push({ name: ev.name, data: ev.data, sig, slot, idx: idx++ });
  }
  return out;
}

/**
 * Backfill: walk signatures for the program newest → oldest until `untilSig`.
 * `maxSigs` caps a cold start (no cursor) to the newest N signatures; `onProgress`
 * is called every 25 transactions so a slow replay stays visible in the logs.
 */
export async function backfill(
  connection: Connection,
  parser: EventParser,
  untilSig: string | null,
  onTx: (events: DecodedEvent[], blockTime: number | null) => Promise<void>,
  opts: { maxSigs?: number; onProgress?: (done: number, total: number) => void; onSkip?: (sigs: string[], err: string) => void; address?: PublicKey } = {},
): Promise<string | null> {
  let before: string | undefined;
  let newest: string | null = null;
  const cap = untilSig ? Infinity : (opts.maxSigs ?? Infinity);
  const address = opts.address ?? env.programId;
  const batches: { signature: string; slot: number; blockTime: number | null }[] = [];
  for (;;) {
    const limit = Math.min(1000, Math.max(1, cap - batches.length));
    const sigs = await connection.getSignaturesForAddress(address, { before, until: untilSig ?? undefined, limit }, "confirmed");
    if (!sigs.length) break;
    for (const s of sigs) if (!s.err) batches.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null });
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < limit || batches.length >= cap) break;
  }
  batches.reverse(); // oldest first
  let done = 0;
  // Small batched JSON-RPC calls with back-off: public devnet caps both requests per IP and calls
  // per method ("Too many requests for a specific RPC call"), so fetch 5 at a time, pause between
  // batches and retry a throttled batch instead of aborting the whole replay.
  const BATCH = 5;
  const PAUSE_MS = 400;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A batch that still fails after the back-off is skipped (reported via onSkip) so one bad
  // network moment cannot abort the whole replay; the caller may run a second pass.
  /** One request per signature, for providers that refuse JSON-RPC batches. */
  const fetchSequential = async (sigs: string[]) => {
    const out: Awaited<ReturnType<typeof connection.getTransaction>>[] = [];
    for (const sig of sigs) {
      let got: Awaited<ReturnType<typeof connection.getTransaction>> = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          got = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          break;
        } catch (e) {
          if (attempt === 3) opts.onSkip?.([sig], String(e));
          else await sleep(800 * 2 ** attempt);
        }
      }
      out.push(got);
      await sleep(60); // stay under per-method rate limits
    }
    return out;
  };
  const fetchBatch = async (sigs: string[]) => {
    if (batchRpcUnsupported) return fetchSequential(sigs);
    for (let attempt = 0; ; attempt++) {
      try {
        return await connection.getTransactions(sigs, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      } catch (e) {
        // Latch on the first refusal: retrying a plan limit never succeeds.
        if (isBatchUnsupported(e)) {
          if (!batchRpcUnsupported) log.warn({ err: String(e).slice(0, 160) }, "this RPC refuses JSON-RPC batches (paid-plan feature). Falling back to one getTransaction per signature for the rest of this process");
          batchRpcUnsupported = true;
          return fetchSequential(sigs);
        }
        if (attempt >= 5) {
          opts.onSkip?.(sigs, String(e));
          return null;
        }
        await sleep(1500 * 2 ** attempt); // 1.5 s → 48 s
      }
    }
  };
  for (let i = 0; i < batches.length; i += BATCH) {
    const chunk = batches.slice(i, i + BATCH);
    if (i > 0) await sleep(PAUSE_MS);
    const txs = await fetchBatch(chunk.map((s) => s.signature));
    if (!txs) {
      done += chunk.length;
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const s = chunk[j];
      const tx = txs[j];
      done++;
      if (!tx?.meta?.logMessages) continue;
      await onTx(decodeLogs(parser, tx.meta.logMessages, s.signature, s.slot), tx.blockTime ?? s.blockTime);
      newest = s.signature;
    }
    opts.onProgress?.(done, batches.length);
  }
  return newest;
}
