"use client";
/**
 * What a funded trader's account *is*, in four figures, at the top of the page.
 *
 * The hero used to be chrome only: a grey label, a title repeating the pool
 * name already in the pills beside it, one sentence, a disclosure, four
 * stair-stepped buttons and a 1,400 px stepper. The most valuable strip on the
 * page carried no data at all, while the numbers were scattered down the page
 * as bordered tiles, and the single most important one was not on the page.
 *
 * The four, in the order the questions get asked:
 *
 *  1. **How much am I trading**. Capital against the tier cap, with the bar.
 *  2. **How am I doing**. NAV/share against where this tier began.
 *  3. **How close am I to losing it**. Room to the binding lock floor. This is
 *     the premise of the entire product: a breach locks the account, for good.
 *     It lived only in the terminal's risk HUD, so the account page could show
 *     an account four hundred dollars from permanent lock and say nothing.
 *  4. **What have I earned**. Escrow, and how much of it is claimable now.
 *
 * Built on the Rulebook's `Figure` and its gradient card rather than on
 * `.panel`: value first at 28 px, label under it at 12 px, a lit surface with
 * 24 px of padding instead of a flat fill with a hairline. That page reads
 * better than the rest of the app, and this is the material it is made of.
 */
import { Card, Figure } from "./Surface";
import { pct, usd } from "@/lib/format";

/** A thin share-of-total bar. `tone` carries the meaning, never the width. */
function Bar({ ratio, tone = "bg-up" }: { ratio: number; tone?: string }) {
  return (
    <span className="mt-2 block h-1 overflow-hidden rounded-full bg-fig-bg-750" aria-hidden>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
    </span>
  );
}

export interface AccountSummaryProps {
  /** Pool NAV. The capital actually being traded. */
  capital: number;
  /** Tier capital ceiling. */
  cap: number;
  /** NAV/share now and when this tier began. */
  nps: number;
  npsStart: number;
  /** Distance in dollars to the binding lock floor, and which one binds. */
  room: { usd: number; which: string; ofBudget: number } | null;
  escrowTotal: number;
  escrowClaimable: number;
}

export function AccountSummary({ capital, cap, nps, npsStart, room, escrowTotal, escrowClaimable }: AccountSummaryProps) {
  const perf = npsStart > 0 ? nps / npsStart - 1 : 0;
  // Amber under a quarter of the budget left, red under a tenth. The account
  // does not get a second chance, so the warning arrives early.
  const roomTone = !room ? "fg" : room.ofBudget < 0.1 ? "down" : room.ofBudget < 0.25 ? "amber" : "fg";

  return (
    <Card className="gap-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={usd(capital)} label="Investor capital" sub={`of the ${usd(cap)} cap`}>
          <Bar ratio={cap ? capital / cap : 0} />
        </Figure>

        <Figure value={pct(perf, 2, true)} label="Since this tier began" tone={perf > 0 ? "up" : perf < 0 ? "down" : "fg"} sub={`NAV/share ${nps.toFixed(4)} vs ${npsStart.toFixed(4)}`} />

        <Figure
          value={room ? usd(room.usd) : "—"}
          label="Room before the account locks"
          tone={roomTone}
          sub={room ? `${room.which} binds · a breach is permanent` : "waiting for the first keeper mark"}
        >
          {room && <Bar ratio={1 - room.ofBudget} tone={roomTone === "down" ? "bg-down" : roomTone === "amber" ? "bg-amber" : "bg-up"} />}
        </Figure>

        <Figure
          value={usd(escrowTotal)}
          label="Escrow"
          tone={escrowTotal > 0 ? "fg" : "fg"}
          sub={escrowClaimable > 0 ? `${usd(escrowClaimable)} claimable now` : "80% of net new profit"}
        />
      </div>
    </Card>
  );
}
