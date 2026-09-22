# Onboarding flow: build spec

**Status:** steps 1–4 built: `apps/terminal/components/InstantOnboarding.tsx`,
rendered from `app/page.tsx`. The queue panel (section 7d) and the failure states (section 8)
remain blocked. Three further rows of the flow are labelled in Figma but never
drawn.

**Source:** the Figma design file, canvas *Dev Ready*, section *features and states*,
the row at y=3657. Frames `97:62013`, `97:17184`, `97:87605`, `97:113220`
(1440×900 each). Everything below was read from cached Figma metadata. No
further MCP calls were spent, and none are needed to build it.

Read alongside `tokens.md`, which defines every colour, size and component
class referenced here.

> **Governing rule (decided 18 Sep 2026).** Where the design and the code
> disagree on a *value*, the code is authoritative and the design is corrected.
> Not the other way round. Figures shown in the UI are rendered from config,
> never hardcoded from a mock. Every decision in section 7 follows from this.

---

## 1. What the design actually is

**One screen, four states of a four-step wizard.** The frames are named
"Terms & sign", which is misleading. There is no terms text and no signature
capture anywhere in them, and no terms step exists in the flow (section 7e).

| State | Frame | Card |
|---|---|---|
| deposit | `97:62013` | `97:62070` |
| queue | `97:17184` | `97:62012` |
| tier assignment | `97:87605` | `97:87662` |
| account creation done | `97:113220` | `97:113277` |

This is the **instant-funding** path. The trader pays to be funded
immediately, with no 30-day trial. It corresponds to
`requirements/instant-funding-workflow-v0.1.md`, not to the trial funnel.

## 2. Geometry

```
1440 × 900 frame
├── nav bar                Frame 633200   1247×56   ← already built (Header.tsx)
├── heading block          Frame 12        476×154
│     ├── title            Frame 11        476×96
│     └── body copy                        476×34
└── main card              Frame 1171280050 1245×480
      ├── left  "HOW IT WORKS"  Content     823×480
      └── right panel            Content     406×434
```

The left panel is identical in all four states except for each step's status
chip. The right panel is what changes.

## 3. Copy

Corrected per section 7. Figures in **bold** are rendered from config, not literals.
Two typos in the design as drawn ("acount" and "POSITON") are fixed here.

**Heading:** `Size your account Instantly`

**Body:** `Choose how much you want to trade with. Your deposit is 20% of the
account size, with the rest coming from the pool.`

**Left panel: "HOW IT WORKS"**, four steps:

1. **Deposit $1,000 USDC to get funded**. "One payment joining amount. Gives
   you access to a funded account for live markets, every order committed
   on-chain daily."
   *(amount = `max(1.5 × entryFee, 0.20 × tierCaps[0])`)*
2. **Queue for Instant funding pool**. "You get your own personal funding
   pool, funded from the global funding pool."
3. **Get Funding Tier 1: $5,000**. "Tier 1 → $5,000 | Tier 2 → $15,000 |
   Tier 3 → $30,000. You can upgrade tiers from your profits."
   *(all four figures from `cfg.tierCaps[]`)*
4. **Trade, win and keep 80% profit**. "80% of every winning close escrows to
   you, vests over **14 days** with clawback, and pays out above the high-water
   mark." *(vesting period from the assigned tier. 14 at Tier 1, 30 above)*

Each step carries a status chip. Only three labels exist in the design:
`Complete`, `Signing...`, `Waiting...` (frames `97:55611`, `97:55615`,
`97:55613`; 143×36).

**Chip state per screen:**

| Step | deposit | queue | tier assignment | done |
|---|---|---|---|---|
| 1 Deposit | Waiting… | Complete | Complete | Complete |
| 2 Queue |: | Signing… | Complete | Complete |
| 3 Tier |: | Waiting… | Signing… | Complete |
| 4 Trade | (| Waiting… | Waiting… |) |

**Right panel by state:**

*deposit*. `You Deposit` / **$1,000.00**, `Your Funding Amount` / **$5,000.00**,
then a `Connect Wallet` CTA.

*queue*. **shown only when the global funding pool is exhausted** (section 7d). When
capacity exists this state is a pass-through and step 2 goes straight to
`Complete`. When shown: `YOUR POSITION` / `Queue`, a table with columns
`Position`, `Wallet address`, `Waiting period`, and a `Continue` CTA. The
waiting estimate is derived from actual pool inflow. There is no fixed slot
cadence.

*tier assignment*. `ASSIGNING TIER` / `Tier Ladder`:
`Tier 1 · $5,000 (Current · unlocked`, `Tier 2 · $15,000) Upgrade from
profits`, `Tier 3 · $30,000`.

*done*. `You're funded and ready to trade` / `$5,000 tier active. Keep 80% of
every win.` / CTA `Open Terminal`.

## 4. Designer notes

Two `@devs` notes are pinned to this row:

- **"rotate the circle while in signing state"**. The `Signing...` chip's
  indicator spins while a wallet signature is pending.
- **"show skeleton ui while signing"**. The right panel renders a skeleton,
  not a spinner, during the signing step. `Skeleton` already exists in
  `@kydo/ui`.

## 5. Component mapping

Nothing new is needed below the page level. The design reuses the system
already built:

| Element | Use |
|---|---|
| Page gutter | `px-9` + `<main>`'s 8px, as the terminal does |
| Main card, right panel | `rounded-[24px]` + `bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-1` |
| Step status chip | 143×36, `rounded-full`, the inset surface (hairline `--fig-stroke`, `--fig-bg-additional`, inset shadow) |
| Step title | `text-h9` (16px) Geist Medium, `text-fg` |
| Step body | `text-h11` (12px) Geist Regular, `text-fig-text-600`, `leading-double` |
| Section label (`HOW IT WORKS`, `ASSIGNING TIER`) | `text-h11` uppercase, `text-fig-text-600` |
| `Connect Wallet` | the existing `ConnectButton size="lg"`: already the lime pill |
| `Continue`, `Open Terminal` | `.btn-cta` (Green/300, 48px pill) |
| Queue table | `.tbl` + `.tbl-book` for the 20px/10px row treatment |
| Tier ladder rows | `.kv` |
| Signing skeleton | `Skeleton` from `@kydo/ui` |

## 6. Reconciling with the code

`StatusCard.tsx` already models an instant journey. `instantJourney` is true
when `profile.instantCap > 0`, and it slices the eight-step `STEPS` array from
index 4, giving four steps. The same count as the design:

| Design step | `STEPS` key | Code label |
|---|---|---|
| 1 Deposit | `pool` | Get funded |
| 2 Queue | `fund` | Fund |
| 3 Tier | `live` | Live |
| 4 Trade | `promote` | Promote |

The semantics differ in one place: the design's step 1 is the *payment*, which
in code happens earlier, in `doApply(instantCapUsd)`. The design has no separate
"apply" concept. Paying is joining.

**Build this as the presentation layer for the existing instant journey, not a
new state machine.** The four design states map to `stage.current` after the
`slice(4)`; chip labels map to position relative to it. Before it `Complete`,
at it `Signing...` when a transaction is in flight and `Waiting...` otherwise,
after it blank. `app/page.tsx` is the natural home; it already branches on
`instant`.

## 7. Decisions

Resolved 18 Sep 2026. Each follows the governing rule at the top.

**a. Tier ladder: $5,000 / $15,000 / $30,000.** Matches step 3's body copy and
`mvp-requirements-v0.1.md` ("capped at $5,000 at first and scaling to
$30,000"). The design's right-hand panel drawing 5/10/15k is wrong and should
be corrected in Figma. The code hardcodes none of these. It reads
`cfg.tierCaps[]` from on-chain config, so this is a config value. **The UI must
render from `tierCaps`, never from a literal.**

**b. Deposit: $1,000 at Tier 1, derived.** The rule stays as the code has it:

```ts
const instantFee = Math.max(entryFee * 1.5, (instantCapUsd * 2000) / 10_000);
```

That is `max(1.5 × entry fee, 20% of cap)` → `max($750, $1,000)` → **$1,000**.
The design's `$800` is a stale mock and should be corrected in Figma. No code
change. The body copy's "20%" was right all along.

**c. Vesting: rendered from the assigned tier.** 14 days at Tier 1, 30 above,
per `mvp-requirements-v0.1.md`. On this screen that displays "14 days", which
matches the design, without hardcoding it or contradicting `app/page.tsx`
elsewhere.

**d. Queue: exception path only.** Funding is instant when the global pool has
capacity; the queue state appears only when it is exhausted. There is no fixed
"1 slot every ~8 hrs" cadence and no default "~4 days" wait. Both were mock
values and should come out of the design. When the queue does show, the
estimate derives from actual pool inflow.

*Implementation note:* this needs a "global pool has capacity" signal that does
not exist yet. Until the indexer exposes it, step 2 can pass through
unconditionally and the queue panel stays unbuilt.

**e. Terms: no terms step.** Nothing in the project defines one, so it does not
exist. The frame name is vestigial and the two undrawn `unsigned / signed`
states at y=5706 are not part of the flow. **Revisit before mainnet**. Pitfall
20 in `pitfalls-analysis.md` notes this structure resembles a structured
product and is devnet-only until counsel advises.

## 8. Still open: undesigned failure states

One row carries state labels but no frames, and it is the one that matters
most:

| Row | States | Status |
|---|---|---|
| y=5706 | unsigned, signed | dropped per section 7e |
| y=7675 | processing, **payment failure**, **paid, queue join failed**, success | **no design** |
| y=9644 | queued, waiting period | folded into section 7d |

"Paid, queue join failed" is the worst state the product can put someone in.
Their money is gone and they have no account, and there is no design for what
they see. Error states usually reshape the happy path, so this is worth
settling with the designer before step 3 of the build order.

## 9. Build order

1. ~~Page shell and heading block.~~ **Done.**
2. ~~Left panel: four steps plus the chip component.~~ **Done**. Derived from
   chain state (`instantCap` → pool exists → pool live), not a new state
   machine. All figures from `cfg.tierCaps[]`, `cfg.entryFee`, `cfg.vestDays[]`.
3. ~~Right panel: *done* → *deposit* → *tier assignment*.~~ **Done.**
4. ~~Signing states.~~ **Done**. Spinning chip indicator, `Skeleton` right
   panel while a chain read is outstanding.
5. Queue panel. Blocked on the capacity signal (section 7d). Step 2 currently shows a
   short "creating your funding pool" panel instead of the queue table.
6. Failure states. Blocked on design (section 8).

**Two notes on what was built.** The paying action itself stays in
`StatusCard`. This screen shows the journey and the two unambiguous CTAs
(connect, open terminal); it does not duplicate the transaction logic, and it
renders for a connected wallet that is either on the instant path already or
has no profile yet; a trial-path trader is on a different journey and does not
see it.

## 10. Figma corrections to push back

For whoever owns the file:

- Deposit `$800` → `$1,000` (four frames).
- Tier Ladder panel `$10,000` / `$15,000` → `$15,000` / `$30,000`.
- Typo "acount" → "account" (four frames); "YOUR POSITON" → "YOUR POSITION".
- Remove "1 pool slot opens every ~8 hrs" and the "~4 days" default wait.
- Rename the frames from "Terms & sign". They are the account-creation flow.
