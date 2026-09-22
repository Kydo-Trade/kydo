# Kydo: on-chain funded trading platform (MVP, devnet)

A prop-trading platform on Solana. Traders prove themselves on a 30-day
simulated account, then get funded by investors through a program-owned vault.
Profits split 80/15/5 between trader, investors and platform, with vesting and
clawback. An on-chain risk guard and an off-chain keeper lock the pool when a
loss limit is breached.

The product specification, the REST and WS interface contract and the
deployment runbook are kept with the team and shared on request.

## What we claim, precisely

Three words get used loosely about platforms like this one. What they mean here:

* **Permissionless** applies to the risk instructions. `evaluate_risk`,
  `lock_pool`, `unwind_all` and `unwind_for_redemption` are callable by anyone
  and pay a bounty, so no privileged party can sit on a breach. It does not
  apply to admission: a trader is admitted by a trial that the `trial_attestor`
  key attests, and funding comes off a queue.
* **Non-custodial** applies to key custody. Nobody holds your keys, and investor
  funds sit in a program-owned PDA that only the program can move, but `admin`
  is a single `Pubkey` with no rotation instruction, and `set_paused` blocks
  every exit path while it is set. The accurate claim is that no one takes
  custody, not that no one can trap your money.
* **"The moment" a limit is breached** overstates the trigger. There is no
  instantaneous on-chain mechanism. The keeper marks every live pool on a 3 s
  cadence and then lands a `lock_pool` transaction. Under a stale feed the
  strict read reverts with `OracleStale` and the lock waits.

## Components

| # | Component | Where | Status |
|---|---|---|---|
| C1 | Vault program (Anchor/Rust) | `programs/vault` | 46 instructions, 11 accounts, 33 events, with a localnet suite in `tests/`. Includes the CommonPool funding layer: one shared investor pool priced mark-to-market, a strict FIFO funding queue, the redemption cascade (idle balance first, then permissionless proportional pulls from trader pools), and the 80/15/5 profit split, whose 5% funds the keeper bounty reserve and treasury revenue. The entry fee is injected as no-shares first-loss seed excluded from investor NAV, so funding a trader starts the pool at NAV per share of 1.0 instead of printing phantom profit. `sweep_forfeited_fee` hands a failed trader's fee to the CommonPool as investor value rather than stranding it in treasury custody. |
| C2 | Venue adapter | `programs/vault/src/venue` | `VenueAdapter` trait. `MockPerps` runs today (dev and tests). `DriftAdapter` is written and byte-verified against protocol-v2 v2.162.0 but has never executed. Phoenix is the production target. |
| C3 | Trial engine | `services/trial-engine` | Node/TS; simulated $50k account, live prices, live risk limits, signed hash-chained log, daily merkle roots, section 5.4 metrics, attested `finalize_trial` |
| C4 | Keeper + price gateway | `services/keeper` | Pyth Hermes stream into mock oracles (`PYTH_MODE=mock`) or posts real Pyth `PriceUpdateV2` accounts via the Pyth receiver (`PYTH_MODE=pull`); marks every live pool every 3 s; `lock_pool` / `unwind_all` / redemption unwinds / vesting; priority fees + optional Jito bundles |
| C5 | Indexer + API | `services/indexer` | Events into Postgres (or in-memory), served as REST and WS; cross-pool hedge alerts |
| C6 | Trader terminal | `apps/terminal` | Next.js; same UI for trial and live |
| C7 | Investor surface | `apps/terminal` (`/invest`) | Merged into the terminal app: discovery, pool detail, deposit/redeem, portfolio (the standalone `apps/investor` was retired) |
|    | SDK | `packages/sdk` | PDAs, `VaultClient`, NAV/guard maths, merkle utilities |

## Toolchain

* Rust (stable), **Solana CLI 2.1.x**, **Anchor 0.31.1**. The `scripts` assume
  the standard install paths (`~/.cargo/bin`,
  `~/.local/share/solana/install/active_release/bin`).
* The SBF build uses **platform-tools v1.51** (`anchor build -- --tools-version
  v1.51`). `Cargo.lock` pins a few transitive crates to edition-2021 releases so
  the bundled Cargo can parse them, so keep the lockfile.
* Node 18+ and **pnpm 8**, pinned by `packageManager` in `package.json` so
  corepack picks it up. pnpm 9+ rewrites `pnpm-lock.yaml` (lockfileVersion 6.0)
  and CI's `--frozen-lockfile` then fails.
* Docker is optional, for Postgres. Both services fall back to an in-memory
  store when `DATABASE_URL` is unset.

## Build & test

```bash
pnpm install
pnpm build:program        # anchor build + IDL → packages/sdk/src/idl
pnpm --filter @kydo/sdk build    # REQUIRED before anything below typechecks
pnpm test:program         # spins a local validator and runs tests/vault.ts (~5 min)
pnpm test:services        # unit tests: merkle, keeper risk maths, hedge detector, trial engine
pnpm typecheck
```

**The SDK build is not optional and not reorderable.** `services/trial-engine`
and `apps/terminal` typecheck against `@kydo/sdk`'s declared types. Until the SDK
has emitted its `.d.ts` files, both fail with `Cannot find module '@kydo/sdk'`,
and that cascades into roughly 25 further `implicitly has an 'any' type` and `is
of type 'unknown'` errors in files that are fine. If a typecheck error mentions
`@kydo/sdk`, build the SDK and re-run before investigating anything else.

## Platform parameters (config files)

Every tunable from sections 4 and 5 lives in one JSON file, applied by the admin key:

| File | Purpose |
|---|---|
| `config/platform.jsonc` | spec values: 24 h days, 30-day trial, 30 live days per tier, 14/30/30-day vesting |
| `config/platform.demo.jsonc` | spec day counts on a **real 24 h `daySecs`**, so promotion is still 30 days and vesting 14/30 days. What it relaxes is the trial (`commitGraceDays: 1000` ≥ `RELAXED_GRACE_DAYS`, so the "Pass trial (dev)" button finalizes without the 30 day roots), plus a 60 s redemption lockup, 10 s min hold and a 30 s re-apply cooldown. Set `daySecs: 20` for the accelerated clock. Every line is commented. |

```bash
pnpm params:apply config/platform.demo.jsonc     # update a running platform (localnet or devnet, per SOLANA_RPC_URL)
PLATFORM_CONFIG=config/platform.jsonc pnpm devnet:bootstrap   # or choose the file at init time
PLATFORM_CONFIG=config/platform.jsonc scripts/dev-stack.sh up # dev stack with spec timings
```

`daySecs` is the single clock for trial days, live-trading days (tier promotion)
and escrow vesting. The program's `epoch_day` divides unix time by it. Tier caps,
vesting days and `promotionDays` sit under `tiers`. The loader enforces the
section 5.2 invariant `entryFee ≥ 80% × maxDrawdown × Tier-1 cap`.

## Run on devnet

```bash
solana config set --url devnet && solana airdrop 2
anchor deploy --provider.cluster devnet
pnpm devnet:bootstrap                          # test USDC mint, init_platform, markets → prints .env values
cp .env.example .env                            # paste USDC_MINT etc.
pnpm devnet:bootstrap faucet <wallet> 5000      # test USDC for a trader / investor

pnpm db:up                                      # optional Postgres
pnpm dev:keeper                                 # prices + marks + locks
pnpm dev:indexer                                # :4000  REST + WS
pnpm dev:trial                                  # :4100  trial engine
pnpm dev:terminal                               # :3000  trader terminal + investor surface (/invest)
```

The keeper is permissionless: anyone can run it against the same program and
collect the bounty for locks and unwinds (section 3.2).

**RPC rate limits.** `api.devnet.solana.com` throttles per IP (`429 Connection rate limits
exceeded`) and the keeper, indexer and both browser apps share that IP. `dev-stack.sh` therefore
runs the services slowly on devnet (prices and marks every 20 s, snapshot every 30 s, against an
oracle staleness window of about 60 s) and the apps poll the chain every 12 s. For a faster demo,
point `SOLANA_RPC_URL` (services) and `APP_RPC_URL` (browsers) at a dedicated RPC and lower
`KEEPER_MS`, `PUSH_MS` and `SNAP_MS`. A free Helius or QuickNode devnet key is enough.

**Prices.** The keeper streams Pyth Hermes by default (`PRICE_SOURCE=hermes`). The public
`hermes.pyth.network` endpoint started answering `401 unauthorized` without an API key, so the
gateway falls back to exchange spot prices when Hermes rejects it (Binance ticker, Coinbase
per-symbol fallback, 2 s poll). The mock oracles keep being fed and nothing else changes. Set
`PYTH_HERMES_URL` to a keyed Hermes for real Pyth prices, or `PRICE_SOURCE=exchange` to skip
Hermes outright.

### Real Pyth oracles on devnet (`PYTH_MODE=pull`)

By default the registry points at program-owned mock oracles that the keeper
feeds from Hermes. To have the program read real Pyth `PriceUpdateV2` accounts,
which are the same feeds posted through the Pyth Solana receiver, switch the
registry and the keeper to pull mode:

```bash
pnpm devnet:bootstrap --pyth                    # re-registers every market's oracle → the keeper's stable Pyth account
PYTH_MODE=pull PYTH_DRY_RUN=true pnpm dev:keeper  # builds one round of post txs, logs sizes/accounts, sends nothing
PYTH_MODE=pull pnpm dev:keeper                  # posts every PRICE_PUSH_MS (one round per registered Pyth feed; `DEFAULT_MARKETS` ships 5); mock markets keep working
pnpm devnet:bootstrap --mock                    # back to mock oracles
```

The Pyth receiver's `post_update` is `init_if_needed` on a signer-addressed
account and only checks `write_authority`, so the keeper derives one keypair
per feed from its own key (`pythPriceUpdateKeypair` in `packages/sdk/src/pyth.ts`)
and rewrites the same account every round; the bootstrap registers exactly that
address. Both scripts must therefore use the same key (`KEEPER_KEYPAIR`,
default `~/.config/solana/id.json`). Updates are fully verified (encoded-VAA
path, `VerificationLevel::Full`), and the encoded VAA is closed after each
round so only fees are spent (≈0.00012 SOL per round; at the default
`PRICE_PUSH_MS=3000` that is 3 to 4 SOL/day, so raise the cadence on a
faucet-funded key). Keep `PRICE_PUSH_MS` well under `oracleMaxAgeSlots × 0.4 s`.
Staleness is measured from `posted_slot`, and a round takes about 8 sequential
confirmations.

## Program overview

* **State**: `PlatformConfig`, `MarketRegistry`, `TraderProfile`, `Pool`
  (positions, 30-slot escrow ring buffer, NAV references), `InvestorPosition`,
  `Treasury` (revenue + ring-fenced bounty reserve), `MockOracle` (devnet).
* **NAV** is accounted USDC plus venue equity, less trader escrow and vested
  claimable. Shares are scaled 1e12, with 1e9 dead shares against a 1 USDC seed
  at creation.
* **Pre-trade guard** (steps 1 to 14 of section 5.3) runs inside `place_trade` before the
  venue call. Oracles are passed as remaining accounts and validated against the
  registry (Pyth `PriceUpdateV2` or `MockOracle`).
* **Profit split**: 80% of net new realized profit accrues to today's escrow
  bucket, stamped with the current tier's vesting period. Net new means
  `max(0, cum_after) - max(0, cum_before)` on cumulative realized PnL, so a
  trader who makes 1000 and loses 1000 has earned nothing, and one who is 5000
  down earns nothing on the way back up until they clear it. Losses claw back
  the nearest-to-unlock buckets first. Claims require investor NAV per share to
  be at its high-water mark.
* **Risk**: `evaluate_risk` / `lock_pool` / `unwind_all` / `unwind_for_redemption`
  are permissionless and bountied. A breach lock returns unvested escrow to the
  pool, freezes the trader and resets their tier.
* **Redemption**: immediate from free collateral, otherwise a pro-rata unwind of
  every position with the exiting investor bearing the slippage; shares burn at
  settlement. A request is refused outright by the global pause, by a Settled
  pool, by a redemption already pending for that investor, and on a Live pool by
  the 24 h post-deposit lockup. It is deferred to the unwind path whenever free
  collateral or the venue's settled balance will not cover the slice, which is
  the common case.
* **Trial**: `apply_as_trader` (entry fee to treasury, part ring-fenced for bounties),
  `commit_trial_root` daily (missed day invalidates), `finalize_trial` evaluates
  section 5.4 against metrics attested by the trial engine key.

## Session keys (1-click trading)

`set_session_key(key, ttl ≤ 24 h)` lets the trader wallet authorise a browser-held
keypair (PDA `["session", trader]`) that may sign `place_trade`, `close_trade`
and `set_stop` and nothing else. Those are the three call sites of
`check_trade_signer`. The key is rejected everywhere funds move: deposits,
redemptions, claims and pool closing. The terminal's **Enable 1-click trading**
button generates the key, funds it with 0.02 SOL for fees and authorises it with
one wallet signature. Trades are then signed locally. `revoke_session_key` closes the PDA
immediately. Covered by `tests/vault.ts` ("session keys") and the property tests
in `programs/vault/src/tests.rs` (`cargo test -p vault`).

## Known gaps / next steps

* **The first-loss cushion is a heuristic, not a bound.** `minFirstLossBps =
  1571` is derived in `config/platform.jsonc` from a square-root-of-time
  diffusion model with no jump term, over a 68 s mark window at 5x leverage, and
  it assumes a live keeper. It absorbs the ordinary case ahead of investor
  capital. It does not bound investor loss. A price gap does not follow that
  model, a keeper that is down widens the window without limit, and the buffer is
  sized per pool while every funded pool may hold the same cluster at once. No
  confidence level has been published for it, and anything said to investors
  about the cushion needs to say so.

* **The oracle confidence ceiling is not enforced.** `oracle_max_conf_bps`
  (config: 50) is read by nothing. The `require!` was removed on 2026-09-22 and
  the reasoning is recorded in `programs/vault/src/oracle.rs` at the removal
  site. In short: a spot ticker carries no confidence interval, so the keeper's
  exchange fallback published a hard-coded `price / 2000`, or 5 bps, on every
  such price. 5 never exceeds 50, so the ceiling passed by construction on the
  degraded path it existed for, while still being able to block the honest Pyth
  path. Restoring it requires the keeper to publish a real confidence first.
  Binance `/ticker/bookTicker` carries a bid and ask; a source without one should
  report a wide value rather than invent a narrow one. Until then nothing rejects
  an untrustworthy price, and because MockPerps fills at the oracle mark, one bad
  number sets the fill, the mark, the NAV and the breach decision together.

* **No venue adapter has executed against a live venue.** Trading runs on
  `MockPerps`, which fills at the oracle mark plus a fixed half-spread: real
  prices, synthetic counterparty. A Drift adapter exists, with hand-written
  bodies for `initialize_user`, `deposit`, `withdraw`,
  `place_and_take_perp_order`, `place_perp_order` and `cancel_orders` against
  protocol-v2 v2.162.0. Its discriminators are computed and verifiable
  (`sha256("global:<name>")[..8]`), but it has never run, and it is no longer the
  production target. Phoenix is. Nothing gates `Venue::Drift` either:
  `adapter_for` returns `DriftAdapter` unconditionally, so such a pool attempts
  real CPIs today. Create `Venue::MockPerps` pools until a venue adapter has a
  verified round trip.

* **Pyth pull oracles.** The keeper can post real `PriceUpdateV2` accounts
  (`PYTH_MODE=pull`, see "Real Pyth oracles on devnet"), so devnet no longer
  depends on mock oracles. Remaining gaps: `allow_mock_oracle` is an
  init-time flag and stays on for devnet (turn it off at `init_platform` for a
  real deployment); the pusher is a single keeper (a second keeper cannot write
  to the same accounts, as it would need its own registry entries); and pull mode
  costs 8 transactions per `PRICE_PUSH_MS` round, which an address lookup table
  would bring to about 5, so use a dedicated RPC and a funded keeper key.
* Mainnet with third-party funds is gated on an external audit (section 7).
