import type { WebSocket } from "ws";

/** Broadcast hub. Every connected client gets every message (MVP). */
export class Hub {
  private clients = new Set<WebSocket>();
  add(ws: WebSocket) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }
  broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(s);
    }
  }
  get size() {
    return this.clients.size;
  }
}
