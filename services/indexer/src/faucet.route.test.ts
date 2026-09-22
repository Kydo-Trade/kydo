/**
 * Faucet abuse-resistance regression tests.
 *
 * The cooldown used to be derived from a 20-row history that was trimmed from
 * the front, while every rejected attempt. Including the cooldown's own 429.
 * Appended a row. ~21 requests pushed the successful drip out of the window and
 * the cooldown lifted, so the limiter defeated itself under exactly the load it
 * existed to stop. These tests pin that shut, along with the claim-size clamp
 * and the two rate limits.
 */
process.env.FAUCET_COOLDOWN_HOURS ??= "24";
process.env.FAUCET_MAX_USD ??= "10000";
process.env.FAUCET_GLOBAL_PER_HOUR ??= "20";
process.env.TRUST_PROXY_HOPS ??= "1";
process.env.PROGRAM_ID ??= "G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1";

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { buildApi } from "./api";

const WALLET = Keypair.generate().publicKey.toBase58();
const fresh = () => Keypair.generate().publicKey.toBase58();

function harness() {
  const cursors = new Map<string, string>();
  let drips = 0;
  const store: any = {
    getCursor: async (k: string) => cursors.get(k) ?? null,
    setCursor: async (k: string, v: string) => void cursors.set(k, v),
    pools: async () => [], trader: async () => null, strategy: async () => null,
    navMarks: async () => [], investorCounts: async () => new Map(),
    investorPositions: async () => [], trades: async () => [],
  };
  const snap: any = { markets: [], prices: new Map(), config: null, lastSlot: 0, lastRunMs: 0, priceSource: "test" };
  const faucet: any = {
    mint: { toBase58: () => "MINT" },
    authority: { publicKey: { toBase58: () => "AUTH" } },
    drip: async (_w: unknown, usd: number, sol: number) => { drips++; return { ata: "ATA", usd, sol, sigs: ["SIG"] }; },
  };
  const build = () => buildApi(store, snap, { size: 0 } as any, { lastEventTs: 0, alertSinks: [] } as any, faucet);
  const app = build();
  const post = (body: unknown, ip = "1.2.3.4") =>
    app.inject({ method: "POST", url: "/faucet", payload: body as any, headers: { "x-forwarded-for": ip } });
  return { post, build, drips: () => drips, cursors };
}

test("a rejected attempt cannot evict the cooldown (the old bypass)", async () => {
  const h = harness();
  assert.equal((await h.post({ wallet: WALLET })).statusCode, 200);
  assert.equal(h.drips(), 1);
  for (let i = 0; i < 25; i++) await h.post({ wallet: WALLET });
  const after = await h.post({ wallet: WALLET });
  assert.equal(after.statusCode, 429, "cooldown must still hold after 25 rejected attempts");
  assert.equal(h.drips(), 1, "no extra drip may be granted");
});

test("the cooldown survives a restart", async () => {
  const h = harness();
  assert.equal((await h.post({ wallet: WALLET })).statusCode, 200);
  const restarted = h.build();
  const r = await restarted.inject({ method: "POST", url: "/faucet", payload: { wallet: WALLET }, headers: { "x-forwarded-for": "5.5.5.5" } });
  assert.equal(r.statusCode, 429, "a new process must read the persisted cooldown");
});

test("the caller cannot choose the claim size", async () => {
  const h = harness();
  const r = await h.post({ wallet: fresh(), usd: 10_000 });
  assert.equal(JSON.parse(r.body).usd, 1_200, "must clamp to the advertised claim, not FAUCET_MAX_USD");
});

test("non-numeric usd does not reach BigInt(NaN)", async () => {
  const h = harness();
  const r = await h.post({ wallet: fresh(), usd: "abc" });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).usd, 1_200);
});

test("per-IP limit caps fresh wallets without hitting other clients", async () => {
  const h = harness();
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await h.post({ wallet: fresh() }, "9.9.9.9")).statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 5, "exactly FAUCET_IP_MAX granted");
  const other = await h.post({ wallet: fresh() }, "7.7.7.7");
  assert.equal(other.statusCode, 200, "a different client must not be collateral damage");
});

test("the global cap bounds an attack spread across many IPs", async () => {
  const h = harness();
  const codes: number[] = [];
  for (let i = 0; i < 30; i++) codes.push((await h.post({ wallet: fresh() }, `10.0.${i}.${i}`)).statusCode);
  const granted = codes.filter((c) => c === 200).length;
  assert.equal(granted, 20, "no more than FAUCET_GLOBAL_PER_HOUR regardless of IP spread");
});
