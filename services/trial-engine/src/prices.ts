/** Price feed for the simulator: indexer (default), Hermes, or a random walk. */
import pino from "pino";
import { env } from "./config";

const log = pino({ level: env.logLevel, name: "trial-prices" });

export class Prices {
  latest: Record<number, number> = {};
  private timer?: NodeJS.Timeout;
  constructor(private feedIdByMarket: Map<number, string>) {}

  start() {
    const poll = async () => {
      try {
        if (env.priceSource === "random-walk") return this.walk();
        if (env.priceSource === "hermes") return await this.hermes();
        await this.indexer();
      } catch (e) {
        log.warn({ err: String(e) }, "price poll failed");
      }
    };
    poll();
    this.timer = setInterval(poll, env.pricePollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async indexer() {
    const res = await fetch(`${env.indexerUrl}/prices`);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as Record<string, { price: number }>;
    for (const [k, v] of Object.entries(body)) this.latest[Number(k)] = v.price;
  }

  private async hermes() {
    const ids = [...this.feedIdByMarket.values()].map((f) => `ids[]=0x${f}`).join("&");
    const res = await fetch(`${env.hermesUrl}/v2/updates/price/latest?${ids}&parsed=true`);
    if (!res.ok) throw new Error(`hermes ${res.status}`);
    const body = (await res.json()) as any;
    for (const p of body.parsed ?? []) {
      for (const [m, f] of this.feedIdByMarket) {
        if (f === p.id) this.latest[m] = Number(p.price.price) * Math.pow(10, p.price.expo);
      }
    }
  }

  private walk() {
    const base = [150, 60_000, 3_000, 30, 550, 0.15];
    let i = 0;
    for (const m of this.feedIdByMarket.keys()) {
      const cur = this.latest[m] ?? base[i % base.length];
      this.latest[m] = cur * (1 + (Math.random() - 0.5) * 0.002);
      i++;
    }
  }
}
