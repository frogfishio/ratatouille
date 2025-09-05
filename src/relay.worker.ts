// relay.worker.ts
// Worker-friendly Relay that batches lines and POSTs via fetch. No Node built-ins.

export interface RelayConfig {
  endpoint: string;              // http(s)://...
  batchMs?: number;              // flush interval (ms), default 100
  batchBytes?: number;           // max bytes per batch, default 262_144 (256KB)
  maxQueue?: number;             // max enqueued lines, default 10_000
  headers?: Record<string,string>; // extra headers for HTTP(S)
  keepAlive?: boolean;           // ignored in Workers; kept for API parity
}

const DEFAULTS = {
  batchMs: 100,
  batchBytes: 262_144,
  maxQueue: 10_000,
  keepAlive: true,
};

export class Relay {
  private config: Required<RelayConfig>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private q: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;

  constructor(endpointOrConfig: string | RelayConfig) {
    const cfg = typeof endpointOrConfig === "string" ? { endpoint: endpointOrConfig } : endpointOrConfig;
    this.config = {
      endpoint: cfg.endpoint,
      batchMs: cfg.batchMs ?? DEFAULTS.batchMs,
      batchBytes: cfg.batchBytes ?? DEFAULTS.batchBytes,
      maxQueue: cfg.maxQueue ?? DEFAULTS.maxQueue,
      headers: cfg.headers ?? {},
      keepAlive: cfg.keepAlive ?? DEFAULTS.keepAlive,
    } as Required<RelayConfig>;
  }

  async connect(): Promise<void> {
    const { endpoint } = this.config;
    if (!(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) {
      throw new Error(`Unsupported endpoint for Workers: ${endpoint}`);
    }
    // start periodic flush loop
    this.timer = setInterval(() => {
      try { this.flush(); } catch { /* ignore */ }
    }, this.config.batchMs);
  }

  /** Enqueue one envelope as NDJSON. Non-blocking; drops when full. */
  send(payload: object): void {
    if (this.closed) return;
    const line = JSON.stringify(payload) + "\n";
    if (line.length > this.config.batchBytes) { this.dropped++; return; }
    this.q.push(line);
    this.queuedBytes += line.length;
    if (this.q.length > this.config.maxQueue) {
      const removed = this.q.shift();
      if (removed) this.queuedBytes -= removed.length;
      this.dropped++;
    }
  }

  /** Drain up to batchBytes and send once via fetch. */
  private flush(): void {
    void this.flushNow();
  }

  /** Flush one batch immediately and resolve when fetch completes. */
  async flushNow(): Promise<void> {
    if (this.closed || this.q.length === 0) return;
    let bytes = 0;
    const batch: string[] = [];
    while (this.q.length && bytes + this.q[0].length <= this.config.batchBytes) {
      const line = this.q.shift()!;
      batch.push(line);
      bytes += line.length;
    }
    this.queuedBytes -= bytes;
    if (batch.length === 0) return;

    const data = batch.join("");
    const { endpoint } = this.config;
    const doFetch = (globalThis as any).fetch as (input: string, init?: any) => Promise<Response>;
    if (typeof doFetch !== "function") return; // nowhere to send
    try {
      await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson", ...this.config.headers },
        body: data,
        // keepalive is a browser flag; Workers ignore it safely
        keepalive: this.config.keepAlive as any,
      }).catch(() => {});
    } catch {
      // swallow in dev logger
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    return {
      endpoint: this.config.endpoint,
      queued: this.q.length,
      queuedBytes: this.queuedBytes,
      dropped: this.dropped,
      lane: "http",
    } as const;
  }
}

export default Relay;
