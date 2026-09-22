/**
 * Pyth pull-oracle pusher (`PYTH_MODE=pull`, section 3.4 "the same feeds the program reads").
 *
 * Every `PRICE_PUSH_MS` the keeper fetches the latest Hermes accumulator update
 * for all registry feeds and posts it on-chain with the Pyth Solana receiver so
 * the program can read real `PriceUpdateV2` accounts instead of mock oracles.
 *
 * Why this shape:
 *  * **Full verification.** The program only accepts `VerificationLevel::Full`.
 *    `post_update_atomic` can't deliver that within one transaction (a 13-of-19
 *    guardian VAA does not fit), so we use the encoded-VAA path: write the VAA
 *    into a Wormhole `EncodedVaa` account, `verify_encoded_vaa_v1`, then
 *    `post_update` per feed, then close the encoded VAA to recover its rent.
 *  * **Stable accounts.** `post_update` is `init_if_needed` on a signer-addressed
 *    account and only checks `write_authority`, so we sign with a keypair
 *    derived from the keeper key + feed id (`pythPriceUpdateKeypair` in
 *    `@kydo/sdk`) and rewrite the same account forever. The bootstrap script
 *    registers exactly that address as the market's `oracle`.
 *  * **Batching.** Instructions are packed with the SDK's size-aware
 *    `TransactionBuilder` and each batch is sent through `sendWithPriority`.
 *    Each `post_update` carries a ~250-byte merkle proof, so only one fits per
 *    legacy transaction; an address lookup table would pack several (follow-up).
 *  * **One confirmation per round, not per feed.** The VAA batches go in
 *    sequence, then every `post_update` is sent at once. They only read the
 *    verified VAA and each writes its own price-update account and its own
 *    treasury PDA. Sending them in sequence took 7.4 s per round on devnet,
 *    which does not fit inside a 10 s `oracle_max_age_slots` window: feeds were
 *    already stale when the next one landed and `evaluate_risk` reverted on
 *    OracleStale every tick.
 *
 * Cost note: every round pays base fees (2 signatures per tx) + the priority
 * fee on tight compute budgets + 1 lamport per update to the Pyth treasury;
 * the encoded-VAA rent (≈0.008 SOL) is recovered by the close. Price-update
 * accounts (≈0.0016 SOL each) are paid once and persist. At the default
 * PRICE_PUSH_MS=3000 that is roughly 0.00012 SOL/round ≈ 3–4 SOL/day. Raise
 * the cadence (within `oracle_max_age_slots`) on a faucet-funded key.
 */
import { Wallet } from "@coral-xyz/anchor";
import { PythSolanaReceiver, TransactionBuilder } from "@pythnetwork/pyth-solana-receiver";
import type { InstructionWithEphemeralSigners } from "@pythnetwork/pyth-solana-receiver";
import { parseAccumulatorUpdateData, parsePriceFeedMessage } from "@pythnetwork/price-service-sdk";
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
import pino from "pino";
import {
  FeedId,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_WORMHOLE_PROGRAM_ID,
  feedIdHex,
  parsePriceUpdateV2,
  pythPriceUpdateKeypair,
} from "@kydo/sdk";
import { env } from "./config";
import { sendWithPriority } from "./tx";

const log = pino({ level: env.logLevel, name: "pyth" });

/** Every outbound HTTP call gets this deadline; Node's fetch has none. */
const HTTP_TIMEOUT_MS = 8_000;

/** Mirrors the SDK's `compute_budget.ts` (not re-exported from its index). */
const POST_UPDATE_CU = 35_000;
const CU_MARGIN = 1.3;
const MIN_CU = 20_000;

export interface PushBatch {
  instructions: TransactionInstruction[];
  signers: Signer[];
  computeUnits: number;
  /** Serialized size of the legacy transaction `sendWithPriority` will build (incl. compute-budget ixs). */
  bytes: number;
}

export class PythPusher {
  readonly receiver: PythSolanaReceiver;
  /** feed id (hex) → stable, keeper-owned `PriceUpdateV2` account keypair */
  readonly accounts = new Map<string, Keypair>();
  private pushing = false;
  /** When the in-flight round took the lock, and which round holds it. A round
   *  that overruns is abandoned rather than allowed to block every later one,
   *  and the generation stops its late `finally` from clearing a newer lock. */
  private pushingSince = 0;
  private generation = 0;
  private lastSuccessAt = 0;
  private intervalMs = 0;
  private timer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private readonly configPda: PublicKey;

  constructor(
    private readonly connection: Connection,
    private readonly keeper: Keypair,
    feeds: FeedId[],
  ) {
    this.receiver = new PythSolanaReceiver({
      connection,
      // The SDK is typed against its own (older) anchor's `Wallet` interface; NodeWallet is structurally compatible.
      wallet: new Wallet(keeper) as any,
      receiverProgramId: PYTH_RECEIVER_PROGRAM_ID,
      wormholeProgramId: PYTH_WORMHOLE_PROGRAM_ID,
    });
    this.configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PYTH_RECEIVER_PROGRAM_ID)[0];
    for (const f of feeds) {
      const hex = feedIdHex(f);
      this.accounts.set(hex, pythPriceUpdateKeypair(keeper, hex));
    }
  }

  get feeds(): string[] {
    return [...this.accounts.keys()];
  }

  address(feedId: FeedId): PublicKey | undefined {
    return this.accounts.get(feedIdHex(feedId))?.publicKey;
  }

  /** Existing accounts must be ours (same write authority). Otherwise every post fails with WrongWriteAuthority. */
  async verifyAccounts(): Promise<void> {
    const entries = [...this.accounts.entries()];
    const infos = await this.connection.getMultipleAccountsInfo(entries.map(([, kp]) => kp.publicKey));
    infos.forEach((info, i) => {
      const [feed, kp] = entries[i];
      const account = kp.publicKey.toBase58();
      if (!info) {
        log.info({ feed, account }, "price update account not created yet; the first push creates it");
        return;
      }
      if (!info.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) {
        log.warn({ feed, account, owner: info.owner.toBase58() }, "price update account exists but is not owned by the Pyth receiver");
        return;
      }
      const p = parsePriceUpdateV2(info.data);
      if (p && !p.writeAuthority.equals(this.keeper.publicKey)) {
        throw new Error(
          `Pyth price update account ${account} (feed ${feed}) has write authority ${p.writeAuthority.toBase58()} ≠ keeper ${this.keeper.publicKey.toBase58()}`,
        );
      }
      log.info({ feed, account, level: p?.verificationLevel, postedSlot: p?.postedSlot }, "price update account ok");
    });
  }

  /** Latest Hermes accumulator update(s) covering all feeds, base64 (usually a single VAA). */
  async fetchUpdates(): Promise<string[]> {
    const ids = this.feeds.map((f) => `ids[]=0x${f}`).join("&");
    // Same bearer token as the price gateway. Without it Hermes 401s and the
    // pusher has no accumulator update to post. Pull mode simply never works.
    const res = await fetch(`${env.hermesUrl}/v2/updates/price/latest?${ids}&encoding=base64&parsed=false`, {
      headers: env.hermesAuth ? { Authorization: `Bearer ${env.hermesAuth}` } : {},
      // A deadline, not politeness. Node's fetch has none, and a socket whose
      // network disappears under it (laptop sleep, VPN drop) hangs forever
      // rather than erroring, which wedged this pusher for 12.7 h.
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`hermes ${res.status} ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { binary?: { encoding: string; data: string[] } };
    if (!body.binary?.data?.length) throw new Error("hermes returned no binary update data");
    if (body.binary.encoding !== "base64") throw new Error(`unexpected hermes encoding ${body.binary.encoding}`);
    return body.binary.data;
  }

  /** Build one round: post batches (VAA + per-feed post_update) and close batches (encoded VAA rent recovery). */
  /**
   * Split deliberately: `vaa` writes and verifies the guardian VAA and must land
   * before anything else, but the per-feed `updates` only read it and each
   * writes its own price-update account, so they are independent of one
   * another and `push` sends them all at once. Sending them in sequence made a
   * round take 7.4 s against devnet, longer than the 10 s `oracle_max_age_slots`
   * window it has to fit inside, so every feed was stale by the time the next
   * one was posted and `evaluate_risk` reverted on OracleStale every tick.
   */
  async buildRound(): Promise<{ vaa: PushBatch[]; updates: PushBatch[]; close: PushBatch[]; feeds: string[] }> {
    const datas = await this.fetchUpdates();
    const vaaIxs: InstructionWithEphemeralSigners[] = [];
    const updateIxs: InstructionWithEphemeralSigners[] = [];
    const close: InstructionWithEphemeralSigners[] = [];
    const posted: string[] = [];

    for (const data of datas) {
      const acc = parseAccumulatorUpdateData(Buffer.from(data, "base64"));
      const vaa = await this.receiver.buildPostEncodedVaaInstructions(acc.vaa);
      vaaIxs.push(...vaa.postInstructions);
      close.push(...vaa.closeInstructions);
      for (const update of acc.updates) {
        const feed = parsePriceFeedMessage(update.message).feedId.toString("hex");
        const kp = this.accounts.get(feed);
        if (!kp) {
          log.warn({ feed }, "hermes returned an update for a feed we did not ask for; skipping");
          continue;
        }
        // A treasury PDA per feed, not per round: `post_update` pays 1 lamport
        // into it, so a shared one would put a write lock on every post in the
        // round and the scheduler would serialise the very sends we just
        // parallelised. The receiver has 256 of them.
        const treasuryId = Math.floor(Math.random() * 256);
        const treasury = PublicKey.findProgramAddressSync([Buffer.from("treasury"), Buffer.from([treasuryId])], PYTH_RECEIVER_PROGRAM_ID)[0];
        // Same instruction the SDK's `buildPostPriceUpdateInstructions` builds, but with our stable
        // account as the (init_if_needed) signer instead of a throwaway keypair.
        const ix = await this.receiver.receiver.methods
          .postUpdate({ merklePriceUpdate: update, treasuryId })
          .accounts({
            payer: this.keeper.publicKey,
            encodedVaa: vaa.encodedVaaAddress,
            config: this.configPda,
            treasury,
            priceUpdateAccount: kp.publicKey,
            systemProgram: SystemProgram.programId,
            writeAuthority: this.keeper.publicKey,
          })
          .instruction();
        updateIxs.push({ instruction: ix, signers: [kp], computeUnits: POST_UPDATE_CU });
        posted.push(feed);
      }
    }
    return { vaa: this.batch(vaaIxs), updates: this.batch(updateIxs), close: this.batch(close), feeds: posted };
  }

  /** Pack instructions into as few transactions as fit (order preserved. Later batches depend on earlier ones). */
  private batch(ixs: InstructionWithEphemeralSigners[]): PushBatch[] {
    const b = new TransactionBuilder(this.keeper.publicKey, this.connection);
    b.addInstructions(ixs);
    return b.transactionInstructions.map(({ instructions, signers, computeUnits }) => ({
      instructions,
      signers,
      computeUnits,
      bytes: this.legacySize(instructions),
    }));
  }

  private legacySize(ixs: TransactionInstruction[]): number {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ...ixs,
    );
    tx.recentBlockhash = PublicKey.default.toBase58();
    tx.feePayer = this.keeper.publicKey;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  }

  private cuLimit(b: PushBatch): number {
    return Math.max(MIN_CU, Math.ceil(b.computeUnits * CU_MARGIN));
  }

  private describe(batches: PushBatch[]) {
    return batches.map((b, i) => ({ tx: i + 1, ixs: b.instructions.length, bytes: b.bytes, cu: this.cuLimit(b), signers: b.signers.length }));
  }

  /** Build the round and log what would be sent. Never sends. */
  async dryRun(): Promise<void> {
    const { vaa, updates, close, feeds } = await this.buildRound();
    log.info(
      {
        feeds: feeds.length,
        accounts: Object.fromEntries(feeds.map((f) => [f, this.accounts.get(f)!.publicKey.toBase58()])),
        vaa: this.describe(vaa),
        updates: this.describe(updates),
        close: this.describe(close),
        // vaa runs in sequence, updates all at once, then close: the round costs
        // vaa.length + 2 confirmations, not one per transaction.
        confirmations: vaa.length + (updates.length ? 1 : 0) + (close.length ? 1 : 0),
        totalTxs: vaa.length + updates.length + close.length,
        totalBytes: [...vaa, ...updates, ...close].reduce((s, b) => s + b.bytes, 0),
      },
      "PYTH_DRY_RUN: built one round of Pyth post transactions (not sent)",
    );
  }

  /** One push round; concurrent calls are coalesced. */
  async push(): Promise<void> {
    const now = Date.now();
    if (this.pushing) {
      // Not just a busy round: a hung one. Node's fetch and the RPC client can
      // both wait forever on a socket whose network went away, and the lock
      // below is what every later tick tests, so without this the pusher stops
      // dead and says nothing while marks go stale and evaluate_risk reverts on
      // OracleStale. Seen for 12.7 h after a laptop sleep.
      const held = now - this.pushingSince;
      if (held < this.stuckAfterMs()) return;
      log.error(
        { heldMs: held, lastSuccessAgoMs: this.lastSuccessAt ? now - this.lastSuccessAt : null },
        "a Pyth push has been in flight far longer than a round takes. Abandoning it and starting fresh. Feeds have been stale for that long",
      );
    }
    this.pushing = true;
    this.pushingSince = now;
    const generation = ++this.generation;
    const t0 = now;
    try {
      const { vaa, updates, close, feeds } = await this.buildRound();
      if (!feeds.length) {
        log.warn("no Pyth updates to post");
        return;
      }
      let vaaCreated = false;
      // One blockhash for the whole round instead of one per transaction: that
      // alone is a third of the round's RPC calls, and every avoided call is one
      // less chance of a 429 on a throttled endpoint. A round is seconds long,
      // well inside a blockhash's ~60s validity.
      const bh = await this.connection.getLatestBlockhash("confirmed");
      try {
        // 1. The VAA, in order: write the guardian signatures, then verify them.
        for (const [i, b] of vaa.entries()) {
          await sendWithPriority(this.connection, this.keeper, b.instructions, {
            signers: b.signers,
            cuLimit: this.cuLimit(b),
            label: `pyth vaa ${i + 1}/${vaa.length}`,
            blockhash: bh,
          });
          vaaCreated = true; // the first batch creates the encoded VAA account
        }
        // 2. Every feed at once. They only read the VAA and each writes its own
        //    price-update account and treasury, so the round costs one
        //    confirmation instead of one per feed.
        const sent = await Promise.allSettled(
          updates.map((b, i) =>
            sendWithPriority(this.connection, this.keeper, b.instructions, {
              signers: b.signers,
              cuLimit: this.cuLimit(b),
              label: `pyth post ${i + 1}/${updates.length}`,
              blockhash: bh,
            }),
          ),
        );
        const failed = sent.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        for (const f of failed) log.warn({ err: String(f.reason) }, "a feed's price update failed to post; it stays stale until the next round");
        if (failed.length === updates.length && updates.length > 0) throw new Error(`every price update failed: ${failed[0]?.reason}`);
        this.lastSuccessAt = Date.now();
        log.info(
          { feeds: feeds.length, txs: vaa.length + updates.length, failed: failed.length, ms: this.lastSuccessAt - t0 },
          "posted Pyth price updates",
        );
      } finally {
        // 3. Recover the encoded-VAA rent. Always, even if a post failed, but
        //    NOT while holding `pushing`. This is book-keeping, not price data:
        //    awaiting it inside the round added its confirmation (~3 s) to every
        //    cycle, so a 4 s timer actually delivered prices every 7 s and feeds
        //    aged past `oracle_max_age_slots` before the next round landed.
        //    Anything missed here is swept by `reclaimOrphanedVaas` at startup.
        if (this.generation === generation) this.pushing = false;
        if (vaaCreated) {
          void (async () => {
            for (const b of close) {
              try {
                await sendWithPriority(this.connection, this.keeper, b.instructions, { signers: b.signers, cuLimit: this.cuLimit(b), label: "pyth close vaa" });
              } catch (e) {
                log.warn({ err: String(e) }, "failed to close encoded VAA (≈0.008 SOL rent stays locked; reclaimed at next keeper start)");
              }
            }
          })();
        }
      }
    } catch (e) {
      log.error({ err: String(e) }, "pyth push failed");
    } finally {
      // Only if we still own it: an abandoned round must not unlock the one
      // that replaced it.
      if (this.generation === generation) this.pushing = false;
    }
  }

  /** How long a round may hold the lock before it is treated as hung. */
  private stuckAfterMs(): number {
    return Math.max(45_000, this.intervalMs * 10);
  }

  /** Close encoded-VAA accounts left behind by earlier crashed rounds (uses getProgramAccounts; best effort). */
  async reclaimOrphanedVaas(max = 20): Promise<void> {
    try {
      const ixs = await this.receiver.buildClosePreviousEncodedVaasInstructions(max);
      if (!ixs.length) return;
      for (const b of this.batch(ixs)) {
        await sendWithPriority(this.connection, this.keeper, b.instructions, { signers: b.signers, cuLimit: this.cuLimit(b), label: "pyth reclaim vaa" });
      }
      log.info({ closed: ixs.length }, "reclaimed orphaned encoded VAA accounts");
    } catch (e) {
      log.warn({ err: String(e) }, "could not reclaim orphaned encoded VAAs (rpc may not allow getProgramAccounts)");
    }
  }

  async start(intervalMs: number): Promise<void> {
    this.intervalMs = intervalMs;
    await this.push();
    this.timer = setInterval(() => void this.push(), intervalMs);
    // Independent of the push path, so it still fires when that path is the
    // thing that is broken. Silence here is what a stale oracle looks like
    // before anyone notices the pools stopped being evaluated.
    this.watchdog = setInterval(() => {
      const since = this.lastSuccessAt ? Date.now() - this.lastSuccessAt : Infinity;
      if (since > this.stuckAfterMs()) {
        log.error({ lastSuccessAgoMs: Number.isFinite(since) ? since : null, intervalMs }, "no Pyth price update has posted in far longer than the push interval. Pools are marking against stale oracles");
      }
    }, Math.max(30_000, intervalMs * 5));
  }

  stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.timer) clearInterval(this.timer);
  }
}
