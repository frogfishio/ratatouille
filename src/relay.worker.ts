// relay.worker.ts
// Worker-friendly Relay that batches lines and POSTs via fetch. No Node built-ins.

export interface RelayConfig {
  endpoint: string;                // http(s)://...
  batchMs?: number;                // flush interval (ms), default 100
  batchBytes?: number;             // max bytes per batch, default 262_144 (256KB)

  // Hard bounds (best-effort telemetry): keep RAM bounded; drop when full.
  // `maxQueueBytes` is the primary guard; `maxQueue` remains as a secondary cap.
  maxQueueBytes?: number;          // max buffered bytes, default 5_242_880 (5MB)
  maxQueue?: number;               // max enqueued lines, default 10_000
  dropPolicy?: "drop_oldest" | "drop_newest"; // default "drop_oldest"

  headers?: Record<string,string>; // extra headers for HTTP(S)
  keepAlive?: boolean;             // ignored in Workers; kept for API parity
  sampleRate?: number;             // 0..1 probability to keep a line (default 1)

  // Optional encoder override. If provided, `send()` will pass the payload through this encoder
  // and enqueue the returned string as a single NDJSON line (a trailing `\n` is added if missing).
  encode?: (payload: unknown) => string;

  // Optional static source identity injected into every envelope.
  // Example: { app: "payments", where: "cf-worker", instance: "prod-eu1" }
  source?: Record<string, unknown>;

  // Default topic used when payload is not already an envelope with a `topic`.
  defaultTopic?: string;          // default "raw"
}

const DEFAULTS = {
  batchMs: 100,
  batchBytes: 262_144,
  maxQueueBytes: 5_242_880, // 5MB
  maxQueue: 10_000,
  dropPolicy: "drop_oldest" as const,
  keepAlive: true,
  sampleRate: 1,
  defaultTopic: "raw",
};

export class Relay {
  private config: Required<RelayConfig>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private q: string[] = [];
  private queuedBytes = 0;

  // counters (telemetry; no correctness promises)
  private dropped = 0;
  private droppedBytes = 0;
  private sentBatches = 0;
  private sentBytes = 0;
  private failedFlushes = 0;
  private lastError?: string;
  private lastFlushMs?: number;

  /** Default encoder: wrap payload into an envelope and inject `source`. */
  private encodeDefault(payload: unknown): string {
    const src = this.config.source && Object.keys(this.config.source).length ? this.config.source : undefined;

    const isPlainObject = (x: any) =>
      x && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

    // If caller already sent an envelope with `topic`, keep it, but ensure ts/src exist.
    if (isPlainObject(payload) && typeof (payload as any).topic === "string") {
      const p = payload as any;
      const out: any = { ...p };
      if (out.ts == null) out.ts = Date.now();
      if (src) out.src = out.src && isPlainObject(out.src) ? { ...src, ...out.src } : src;
      return JSON.stringify(out);
    }

    // Otherwise wrap into a minimal envelope.
    const env: any = {
      ts: Date.now(),
      topic: this.config.defaultTopic || "raw",
      args: [payload],
    };
    if (src) env.src = src;
    return JSON.stringify(env);
  }

  private normalizeEndpoint(endpoint: string): string {
    const s = (endpoint || "").trim();
    if (!s) return endpoint;

    // Allow host:port as shorthand; Workers only support http(s).
    const withScheme = s.startsWith("http://") || s.startsWith("https://") ? s : `http://${s}`;

    try {
      const u = new URL(withScheme);
      if (!u.pathname || u.pathname === "/") u.pathname = "/sink";
      return u.toString();
    } catch {
      return endpoint;
    }
  }

  // prevent overlapping flushes (timer + explicit flushNow)
  private flushing = false;

  constructor(endpointOrConfig: string | RelayConfig) {
    const cfg = typeof endpointOrConfig === "string" ? { endpoint: endpointOrConfig } : endpointOrConfig;
    this.config = {
      endpoint: this.normalizeEndpoint(cfg.endpoint),
      batchMs: cfg.batchMs ?? DEFAULTS.batchMs,
      batchBytes: cfg.batchBytes ?? DEFAULTS.batchBytes,
      maxQueueBytes: cfg.maxQueueBytes ?? DEFAULTS.maxQueueBytes,
      maxQueue: cfg.maxQueue ?? DEFAULTS.maxQueue,
      dropPolicy: cfg.dropPolicy ?? DEFAULTS.dropPolicy,
      headers: cfg.headers ?? {},
      keepAlive: cfg.keepAlive ?? DEFAULTS.keepAlive,
      sampleRate: cfg.sampleRate ?? DEFAULTS.sampleRate,
      encode: cfg.encode,
      source: cfg.source ?? {},
      defaultTopic: cfg.defaultTopic ?? DEFAULTS.defaultTopic,
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

  /** Ensure the queue has room for `bytes` according to configured bounds. Returns true if it fits. */
  private ensureCapacity(bytes: number): boolean {
    // Primary guard: bytes
    if (this.queuedBytes + bytes > this.config.maxQueueBytes) {
      if (this.config.dropPolicy === "drop_newest") return false;
      // drop oldest until it fits
      while (this.q.length && this.queuedBytes + bytes > this.config.maxQueueBytes) {
        const old = this.q.shift();
        if (!old) break;
        this.queuedBytes -= old.length;
        this.dropped++;
        this.droppedBytes += old.length;
      }
      if (this.queuedBytes + bytes > this.config.maxQueueBytes) return false;
    }

    // Secondary guard: line count
    if (this.q.length + 1 > this.config.maxQueue) {
      if (this.config.dropPolicy === "drop_newest") return false;
      const removed = this.q.shift();
      if (removed) {
        this.queuedBytes -= removed.length;
        this.dropped++;
        this.droppedBytes += removed.length;
      }
      if (this.q.length + 1 > this.config.maxQueue) return false;
    }

    return true;
  }

  /**
   * Enqueue one item as NDJSON.
   * - If you pass an object, it will be JSON-stringified (or encoded via `config.encode`).
   * - If you already have a line/chunk, prefer `sendLine()` / `sendChunk()` for "send bullshit" mode.
   *
   * Non-blocking; drops when full.
   */
  send(payload: unknown): void {
    if (this.closed) return;

    // probabilistic sampling
    if (this.config.sampleRate < 1 && Math.random() >= this.config.sampleRate) {
      this.dropped++;
      return;
    }

    let line: string;
    try {
      if (this.config.encode) {
        line = this.config.encode(payload);
      } else {
        line = this.encodeDefault(payload);
      }
    } catch {
      this.dropped++;
      return;
    }

    // Ensure NDJSON framing
    if (!line.endsWith("\n")) line += "\n";

    // oversize single line? drop it early
    if (line.length > this.config.batchBytes) {
      this.dropped++;
      this.droppedBytes += line.length;
      return;
    }

    if (!this.ensureCapacity(line.length)) {
      this.dropped++;
      this.droppedBytes += line.length;
      return;
    }

    this.q.push(line);
    this.queuedBytes += line.length;
  }

  /** Enqueue a pre-formatted NDJSON line (adds trailing \n if missing). */
  sendLine(line: string): void {
    this.send(line);
  }

  /**
   * Enqueue a pre-formatted NDJSON chunk (may contain multiple lines).
   * This does not attempt to parse or validate. It only enforces bounds.
   */
  sendChunk(chunk: string): void {
    if (this.closed) return;

    let data = chunk;
    if (!data.endsWith("\n")) data += "\n";

    if (data.length > this.config.batchBytes) {
      this.dropped++;
      this.droppedBytes += data.length;
      return;
    }

    if (!this.ensureCapacity(data.length)) {
      this.dropped++;
      this.droppedBytes += data.length;
      return;
    }

    this.q.push(data);
    this.queuedBytes += data.length;
  }

  /** Drain up to batchBytes and send once via fetch. */
  private flush(): void {
    void this.flushNow();
  }

  /** Flush one batch immediately and resolve when fetch completes. */
  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.flushing) return;
    if (this.q.length === 0) return;

    // Drain one batch
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
    const started = Date.now();

    this.flushing = true;
    try {
      const { endpoint } = this.config;
      const doFetch = (globalThis as any).fetch as (input: string, init?: any) => Promise<Response>;
      if (typeof doFetch !== "function") {
        this.failedFlushes++;
        this.lastError = "fetch unavailable";
        return;
      }

      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson", ...this.config.headers },
        body: data,
        // keepalive is a browser flag; Workers ignore it safely
        keepalive: this.config.keepAlive as any,
      }).catch(() => undefined as any);

      if (!res || !res.ok) {
        this.failedFlushes++;
        this.lastError = !res ? "fetch failed" : `triager ${res.status}`;
        return;
      }

      this.sentBatches++;
      this.sentBytes += data.length;
      this.lastError = undefined;
      this.lastFlushMs = Date.now() - started;
    } catch (err: any) {
      this.failedFlushes++;
      this.lastError = err?.message ? String(err.message) : "flush error";
    } finally {
      if (this.lastFlushMs === undefined) this.lastFlushMs = Date.now() - started;
      this.flushing = false;
    }
  }

  close(): void {
    this.closed = true;
    this.flushing = false;
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    return {
      endpoint: this.config.endpoint,
      queued: this.q.length,
      queuedBytes: this.queuedBytes,
      dropped: this.dropped,
      droppedBytes: this.droppedBytes,
      sentBatches: this.sentBatches,
      sentBytes: this.sentBytes,
      failedFlushes: this.failedFlushes,
      lastError: this.lastError,
      lastFlushMs: this.lastFlushMs,
      lane: "http",
    } as const;
  }
}

export default Relay;
