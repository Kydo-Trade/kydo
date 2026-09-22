/**
 * Pyth pull-oracle helpers shared by the keeper (posts price updates) and the
 * bootstrap script (registers the accounts the keeper posts to).
 *
 * Stable price-update accounts
 * ----------------------------
 * The Pyth receiver's `post_update` is `init_if_needed` on a *signer*-addressed
 * `PriceUpdateV2` account and only requires that the stored `write_authority`
 * equals the signing write authority, so the same account can be re-posted
 * forever by the same key (the SDK's own builders just happen to use a fresh
 * keypair every time). We derive one keypair per (write authority, feed id)
 * from the write authority's ed25519 seed:
 *
 *   seed = sha256("mt5/pyth-price-update/v1" || keeperSeed32 || feedId32)
 *
 * The address is therefore deterministic for whoever holds the keeper key.
 * The only party the receiver lets write to it anyway, and unguessable for
 * everyone else, so nobody can front-run creation with a foreign write
 * authority. Rotating the keeper key changes the addresses (re-run bootstrap).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

/** Wormhole core bridge. Same address on devnet and mainnet. */
export const PYTH_WORMHOLE_PROGRAM_ID = new PublicKey("HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ");

// DO NOT RENAME. This string is hashed into the price-update keypair
// derivation, so changing it changes the address of every derived account.
// The markets in the on-chain registry point at addresses derived from this
// exact prefix: change it and the keeper posts to accounts the registry does
// not know, and every strict oracle read fails with OracleMissing until
// `devnet:bootstrap --pyth` re-registers every market. The "mt5" here is a
// historical project name, deliberately preserved.
const PRICE_UPDATE_SEED_PREFIX = "mt5/pyth-price-update/v1";

export type FeedId = string | number[] | Uint8Array;

/** Normalize a feed id (hex with/without `0x`, or 32 bytes) to lowercase hex without prefix. */
export function feedIdHex(feedId: FeedId): string {
  const hex = typeof feedId === "string" ? feedId.replace(/^0x/i, "").toLowerCase() : Buffer.from(feedId).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid Pyth feed id: ${String(feedId)}`);
  return hex;
}

/** The keeper-owned `PriceUpdateV2` account (as a signing keypair) for `feedId`. */
export function pythPriceUpdateKeypair(writeAuthority: Keypair, feedId: FeedId): Keypair {
  const seed = createHash("sha256")
    .update(PRICE_UPDATE_SEED_PREFIX)
    .update(Buffer.from(writeAuthority.secretKey.subarray(0, 32)))
    .update(Buffer.from(feedIdHex(feedId), "hex"))
    .digest();
  return Keypair.fromSeed(seed);
}

/** Address of the keeper-owned `PriceUpdateV2` account for `feedId` (what the registry should point at). */
export function pythPriceUpdateAddress(writeAuthority: Keypair, feedId: FeedId): PublicKey {
  return pythPriceUpdateKeypair(writeAuthority, feedId).publicKey;
}

/** Anchor discriminator of `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`. */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);

export interface PriceUpdateV2 {
  writeAuthority: PublicKey;
  verificationLevel: "full" | "partial";
  /** Only for `partial`. */
  numSignatures?: number;
  feedId: string; // hex, no prefix
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
  prevPublishTime: number;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: number;
}

/**
 * Parse a `PriceUpdateV2` account (same Borsh layout the program reads in `oracle.rs`):
 *   [8] discriminator · [32] write_authority ·
 *   verification_level: enum { Partial { num_signatures: u8 } = 0, Full = 1 } ·
 *   price_message { feed_id [32], price i64, conf u64, exponent i32, publish_time i64,
 *                   prev_publish_time i64, ema_price i64, ema_conf u64 } · posted_slot u64
 * Returns null for anything that is not a `PriceUpdateV2`.
 */
export function parsePriceUpdateV2(raw: Buffer | Uint8Array): PriceUpdateV2 | null {
  const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (data.length < 8 + 32 + 1 || !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const writeAuthority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const tag = data[o++];
  let verificationLevel: PriceUpdateV2["verificationLevel"];
  let numSignatures: number | undefined;
  if (tag === 0) {
    verificationLevel = "partial";
    numSignatures = data[o++];
  } else if (tag === 1) {
    verificationLevel = "full";
  } else {
    return null;
  }
  if (data.length < o + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8) return null;
  const feedId = data.subarray(o, o + 32).toString("hex");
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const expo = data.readInt32LE(o);
  o += 4;
  const publishTime = Number(data.readBigInt64LE(o));
  o += 8;
  const prevPublishTime = Number(data.readBigInt64LE(o));
  o += 8;
  const emaPrice = data.readBigInt64LE(o);
  o += 8;
  const emaConf = data.readBigUInt64LE(o);
  o += 8;
  const postedSlot = Number(data.readBigUInt64LE(o));
  return { writeAuthority, verificationLevel, numSignatures, feedId, price, conf, expo, publishTime, prevPublishTime, emaPrice, emaConf, postedSlot };
}
