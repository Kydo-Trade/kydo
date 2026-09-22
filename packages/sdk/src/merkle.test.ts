import assert from "node:assert/strict";
import { test } from "node:test";
import { hashEntry, merkleProof, merkleRoot, TrialOrderEntry, verifyChain, verifyProof } from "./merkle";

function mk(n: number): TrialOrderEntry[] {
  const out: TrialOrderEntry[] = [];
  let prev = "0".repeat(64);
  for (let i = 0; i < n; i++) {
    const e: TrialOrderEntry = {
      seq: i, day: 0, ts: 1_700_000_000 + i, trader: "T", marketId: 1,
      side: i % 2 ? "short" : "long", action: "open", baseQty: "1000000000",
      oraclePrice: "150000000", fillPrice: "150075000", fee: "75000", realizedPnl: "0",
      equityAfter: "50000000000", prevHash: prev,
    };
    prev = hashEntry(e).toString("hex");
    out.push(e);
  }
  return out;
}

test("proofs verify for every leaf, including odd-sized trees", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const entries = mk(n);
    const root = merkleRoot(entries).toString("hex");
    for (let i = 0; i < n; i++) {
      const p = merkleProof(entries, i);
      assert.equal(p.root, root);
      assert.ok(verifyProof(p, entries[i]), `leaf ${i} of ${n}`);
    }
  }
});

test("tampered entry fails verification", () => {
  const entries = mk(4);
  const p = merkleProof(entries, 2);
  const bad = { ...entries[2], fillPrice: "1" };
  assert.equal(verifyProof(p, bad), false);
});

test("hash chain detects reordering", () => {
  const entries = mk(5);
  assert.ok(verifyChain(entries));
  const swapped = [entries[0], entries[2], entries[1], entries[3], entries[4]];
  assert.equal(verifyChain(swapped), false);
});
