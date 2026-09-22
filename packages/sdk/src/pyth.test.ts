import { strict as assert } from "assert";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PRICE_UPDATE_V2_DISCRIMINATOR, feedIdHex, parsePriceUpdateV2, pythPriceUpdateAddress, pythPriceUpdateKeypair } from "./pyth";

const SOL = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

test("feedIdHex accepts hex with/without 0x and byte arrays", () => {
  assert.equal(feedIdHex("0x" + SOL.toUpperCase()), SOL);
  assert.equal(feedIdHex([...Buffer.from(SOL, "hex")]), SOL);
  assert.throws(() => feedIdHex("abcd"));
});

test("price update keypair is deterministic per (write authority, feed) and distinct across both", () => {
  const a = Keypair.generate();
  const b = Keypair.generate();
  assert.ok(pythPriceUpdateAddress(a, SOL).equals(pythPriceUpdateKeypair(a, "0x" + SOL).publicKey));
  assert.ok(!pythPriceUpdateAddress(a, SOL).equals(pythPriceUpdateAddress(a, BTC)));
  assert.ok(!pythPriceUpdateAddress(a, SOL).equals(pythPriceUpdateAddress(b, SOL)));
  // the derived keypair must actually be able to sign (valid ed25519 seed → pubkey)
  const kp = pythPriceUpdateKeypair(a, SOL);
  assert.ok(new PublicKey(kp.publicKey.toBytes()).equals(kp.publicKey));
});

function encode(level: "full" | "partial", numSigs = 5): Buffer {
  const parts: Buffer[] = [PRICE_UPDATE_V2_DISCRIMINATOR, Buffer.alloc(32, 7)];
  parts.push(level === "full" ? Buffer.from([1]) : Buffer.from([0, numSigs]));
  const msg = Buffer.alloc(32 + 8 + 8 + 4 + 8 + 8 + 8 + 8);
  Buffer.from(SOL, "hex").copy(msg, 0);
  let o = 32;
  msg.writeBigInt64LE(15_012_345_678n, o); o += 8; // $150.12345678 at expo -8
  msg.writeBigUInt64LE(5_000_000n, o); o += 8;
  msg.writeInt32LE(-8, o); o += 4;
  msg.writeBigInt64LE(1_700_000_000n, o); o += 8;
  msg.writeBigInt64LE(1_699_999_999n, o); o += 8;
  msg.writeBigInt64LE(15_000_000_000n, o); o += 8;
  msg.writeBigUInt64LE(4_000_000n, o);
  parts.push(msg);
  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(123_456n);
  parts.push(slot);
  return Buffer.concat(parts);
}

test("parsePriceUpdateV2 handles Full and Partial verification levels", () => {
  const full = parsePriceUpdateV2(encode("full"))!;
  assert.equal(full.verificationLevel, "full");
  assert.equal(full.feedId, SOL);
  assert.equal(full.price, 15_012_345_678n);
  assert.equal(full.conf, 5_000_000n);
  assert.equal(full.expo, -8);
  assert.equal(full.publishTime, 1_700_000_000);
  assert.equal(full.postedSlot, 123_456);
  assert.ok(full.writeAuthority.equals(new PublicKey(Buffer.alloc(32, 7))));

  const partial = parsePriceUpdateV2(encode("partial", 5))!;
  assert.equal(partial.verificationLevel, "partial");
  assert.equal(partial.numSignatures, 5);
  assert.equal(partial.feedId, SOL);
  assert.equal(partial.postedSlot, 123_456);

  assert.equal(parsePriceUpdateV2(Buffer.alloc(10)), null);
  assert.equal(parsePriceUpdateV2(Buffer.concat([Buffer.alloc(8, 1), encode("full").subarray(8)])), null);
});
