/**
 * Trial log attestation (section 4.2). Every simulated order is a signed, hash-chained
 * entry; each day's entries roll up into a merkle root committed on-chain.
 * Investors verify exported proofs client-side with `verifyProof`.
 *
 * Leaf  = sha256(0x00 || canonical JSON of the entry)
 * Node  = sha256(0x01 || left || right)   (odd levels duplicate the last node)
 */
import { createHash } from "crypto";

export interface TrialOrderEntry {
  seq: number;
  day: number;
  ts: number;
  trader: string;
  marketId: number;
  side: "long" | "short";
  action: "open" | "close";
  baseQty: string;
  oraclePrice: string;
  fillPrice: string;
  fee: string;
  realizedPnl: string;
  equityAfter: string;
  /** sha256 hex of the previous entry (hash chain); "0"×64 for the first. */
  prevHash: string;
  /** ed25519 signature (hex) by the trial engine over `hashEntry` */
  signature?: string;
}

const sha256 = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Canonical serialization: sorted keys, signature excluded. */
export function canonical(entry: TrialOrderEntry): Buffer {
  const { signature: _sig, ...rest } = entry;
  const keys = Object.keys(rest).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = (rest as Record<string, unknown>)[k];
  return Buffer.from(JSON.stringify(obj));
}

export function hashEntry(entry: TrialOrderEntry): Buffer {
  return sha256(Buffer.from([0x00]), canonical(entry));
}

export function hashPair(a: Buffer, b: Buffer): Buffer {
  return sha256(Buffer.from([0x01]), a, b);
}

export interface MerkleProof {
  leaf: string;
  index: number;
  siblings: string[]; // hex, bottom → top
  root: string;
}

export function buildTree(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) return [[Buffer.alloc(32)]];
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const l = prev[i];
      const r = i + 1 < prev.length ? prev[i + 1] : prev[i];
      next.push(hashPair(l, r));
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(entries: TrialOrderEntry[]): Buffer {
  const levels = buildTree(entries.map(hashEntry));
  return levels[levels.length - 1][0];
}

export function merkleProof(entries: TrialOrderEntry[], index: number): MerkleProof {
  const leaves = entries.map(hashEntry);
  const levels = buildTree(leaves);
  const siblings: string[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sib = i % 2 === 0 ? (i + 1 < level.length ? level[i + 1] : level[i]) : level[i - 1];
    siblings.push(sib.toString("hex"));
    i = Math.floor(i / 2);
  }
  return {
    leaf: leaves[index].toString("hex"),
    index,
    siblings,
    root: levels[levels.length - 1][0].toString("hex"),
  };
}

export function verifyProof(proof: MerkleProof, entry?: TrialOrderEntry): boolean {
  let node: Buffer = Buffer.from(proof.leaf, "hex");
  if (entry && !hashEntry(entry).equals(node)) return false;
  let i = proof.index;
  for (const s of proof.siblings) {
    const sib = Buffer.from(s, "hex");
    node = i % 2 === 0 ? hashPair(node, sib) : hashPair(sib, node);
    i = Math.floor(i / 2);
  }
  return node.toString("hex") === proof.root;
}

/** Validate the hash chain: each entry's prevHash equals the previous entry's hash. */
export function verifyChain(entries: TrialOrderEntry[]): boolean {
  let prev = "0".repeat(64);
  for (const e of entries) {
    if (e.prevHash !== prev) return false;
    prev = hashEntry(e).toString("hex");
  }
  return true;
}
