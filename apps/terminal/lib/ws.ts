"use client";
/** Reconnecting WebSocket to the indexer broadcast (`ws://…/ws`). */
import { useEffect, useSyncExternalStore } from "react";
import type { WsMessage } from "./api";
import { wsUrl } from "./config";
import { priceStore } from "./prices";

export type FeedStatus = "connecting" | "open" | "closed";
type Handler<T extends WsMessage["type"]> = (msg: Extract<WsMessage, { type: T }>) => void;

class LiveFeed {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(m: any) => void>>();
  private statusListeners = new Set<() => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  status: FeedStatus = "closed";
  lastMessageAt = 0;

  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.connect();
  }

  private setStatus(s: FeedStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l();
  }

  private connect() {
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: WsMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (msg.type === "price") {
        priceStore.update(msg.marketId, { price: msg.price, conf: msg.conf, ts: msg.ts }, "ws");
      }
      const hs = this.handlers.get(msg.type);
      if (hs) for (const h of hs) h(msg);
      const all = this.handlers.get("*");
      if (all) for (const h of all) h(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect() {
    if (this.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  on<T extends WsMessage["type"] | "*">(type: T, handler: T extends WsMessage["type"] ? Handler<T> : (m: WsMessage) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as (m: any) => void);
    return () => {
      set!.delete(handler as (m: any) => void);
    };
  }

  subscribeStatus = (cb: () => void) => {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  };
  getStatus = () => this.status;
}

export const liveFeed = new LiveFeed();

/** Starts the feed (idempotent) and returns its connection status. */
export function useLiveFeed(): { status: FeedStatus; on: LiveFeed["on"] } {
  useEffect(() => {
    liveFeed.start();
  }, []);
  const status = useSyncExternalStore(liveFeed.subscribeStatus, liveFeed.getStatus, () => "closed" as FeedStatus);
  return { status, on: liveFeed.on.bind(liveFeed) };
}

/** Subscribe to one message type for the lifetime of the component. */
export function useFeedMessage<T extends WsMessage["type"]>(type: T, handler: Handler<T>, deps: unknown[] = []) {
  useEffect(() => {
    liveFeed.start();
    return liveFeed.on(type, handler as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
