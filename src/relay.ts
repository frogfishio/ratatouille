// relay.ts
// Relay class for maintaining a connection to a log collector with non-blocking queue and periodic flush.

import net from "net";
import http from "http";
import https from "https";

export interface RelayConfig {
  endpoint: string;                // tcp://host:port or http(s)://...
  batchMs?: number;                // flush interval (ms), default 100
  batchBytes?: number;             // max bytes per batch, default 262_144 (256KB)

  // Hard bounds (best-effort telemetry): keep RAM bounded; drop when full.
  // `maxQueueBytes` is the primary guard; `maxQueue` remains as a secondary cap.
  maxQueueBytes?: number;          // max buffered bytes, default 5_242_880 (5MB)
  maxQueue?: number;               // max enqueued lines, default 10_000
  dropPolicy?: "drop_oldest" | "drop_newest"; // default "drop_oldest"

  headers?: Record<string,string>; // extra headers for HTTP(S)
  keepAlive?: boolean;             // HTTP keep-alive agent, default true
  sampleRate?: number;             // 0..1 probability to keep a line (default 1)

  // Optional encoder override. If provided, `send()` will pass the payload through this encoder
  // and enqueue the returned string as a single NDJSON line (a trailing `\n` is added if missing).
  encode?: (payload: unknown) => string;

  // Optional static source identity injected into every envelope.
  // Example: { app: "payments", where: "node", instance: "prod-eu1" }
  // If omitted, defaults can be sourced from env:
  //   RATATOUILLE_APP, RATATOUILLE_WHERE, RATATOUILLE_INSTANCE
  source?: Record<string, unknown>;

  // Default topic used when payload is not already an envelope with a `topic`.
  // Can be overridden via env RATATOUILLE_DEFAULT_TOPIC.
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
  private config: {
    endpoint: string;
    batchMs: number;
    batchBytes: number;
    maxQueueBytes: number;
    maxQueue: number;
    dropPolicy: "drop_oldest" | "drop_newest";
    headers: Record<string, string>;
    keepAlive: boolean;
    sampleRate: number;
    encode?: (payload: unknown) => string;
    source: Record<string, unknown>;
    defaultTopic: string;
  };
  private socket?: net.Socket;
  private httpAgent?: http.Agent | https.Agent;
  private closed = false;
  private timer?: NodeJS.Timeout;
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

  private normalizeEndpoint(endpoint: string): string {
    if (!(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) return endpoint;
    try {
      const u = new URL(endpoint);
      if (!u.pathname || u.pathname === "/") u.pathname = "/sink";
      return u.toString();
    } catch {
      return endpoint;
    }
  }

  private envSource(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const app = process.env.RATATOUILLE_APP;
    const where = process.env.RATATOUILLE_WHERE;
    const instance = process.env.RATATOUILLE_INSTANCE;
    if (app) out.app = app;
    if (where) out.where = where;
    if (instance) out.instance = instance;
    return out;
  }

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

  // prevent overlapping flushes (timer + explicit flushNow)
  private flushing = false;

  constructor(endpointOrConfig: string | RelayConfig) {
    const cfg = typeof endpointOrConfig === "string" ? { endpoint: endpointOrConfig } : endpointOrConfig;

    const envSource = this.envSource();
    const envDefaultTopic = process.env.RATATOUILLE_DEFAULT_TOPIC;

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

      // env provides defaults; explicit config wins
      source: { ...envSource, ...(cfg.source ?? {}) },
      defaultTopic: cfg.defaultTopic ?? envDefaultTopic ?? DEFAULTS.defaultTopic,
    };
  }

  async connect(): Promise<void> {
    const { endpoint } = this.config;
    if (endpoint.startsWith("tcp://")) {
      const [, , hostPort] = endpoint.split("/");
      const [host, portStr] = hostPort.split(":");
      const port = parseInt(portStr, 10);
      this.socket = net.createConnection({ host, port });
      this.socket.on("error", () => {/* swallow in emitter */});
    } else if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      if (this.config.keepAlive) {
        this.httpAgent = endpoint.startsWith("https://")
          ? new https.Agent({ keepAlive: true })
          : new http.Agent({ keepAlive: true });
      }
    } else {
      throw new Error(`Unsupported endpoint protocol: ${endpoint}`);
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
      // If still over the cap, refuse.
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
    if (this.closed) return;

    let data = line;
    if (!data.endsWith("\n")) data += "\n";

    // oversize single line? drop it early
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

  /**
   * Enqueue a pre-formatted NDJSON chunk (may contain multiple lines).
   * This does not attempt to parse or validate. It only enforces bounds.
   */
  sendChunk(chunk: string): void {
    if (this.closed) return;
    // Treat chunk as already-framed bytes. Add a trailing newline for friendliness.
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

  /** Drain a batch from the queue up to batchBytes. Returns NDJSON payload or undefined if empty. */
  private drainBatch(): string | undefined {
    if (this.q.length === 0) return undefined;
    let bytes = 0;
    const batch: string[] = [];
    while (this.q.length && bytes + this.q[0].length <= this.config.batchBytes) {
      const line = this.q.shift()!;
      batch.push(line);
      bytes += line.length;
    }
    this.queuedBytes -= bytes;
    if (batch.length === 0) return undefined;
    return batch.join("");
  }

  /** Drain up to batchBytes and send once. */
  private flush(): void {
    void this.flushNow();
  }

  /** Flush one batch immediately and resolve when send attempt completes. */
  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.flushing) return;

    const data = this.drainBatch();
    if (!data) return;

    this.flushing = true;
    const started = Date.now();

    try {
      const { endpoint } = this.config;

      if (endpoint.startsWith("tcp://") && this.socket) {
        await new Promise<void>((resolve) => {
          try {
            // best-effort single write
            this.socket!.write(data, () => resolve());
          } catch {
            resolve();
          }
        });
        this.sentBatches++;
        this.sentBytes += data.length;
        this.lastError = undefined;
        this.lastFlushMs = Date.now() - started;
        return;
      }

      if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
        const isHttps = endpoint.startsWith("https://");
        const mod = isHttps ? https : http;
        await new Promise<void>((resolve) => {
          try {
            const req = mod.request(
              endpoint,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-ndjson",
                  "Content-Length": Buffer.byteLength(data),
                  ...this.config.headers,
                },
                agent: this.httpAgent,
              },
              (res) => {
                // Drain response to avoid socket leaks; we don't parse.
                res.on("data", () => {});
                res.on("end", () => resolve());
              },
            );
            req.on("error", () => resolve());
            req.write(data);
            req.end();
          } catch {
            resolve();
          }
        });
        this.sentBatches++;
        this.sentBytes += data.length;
        this.lastError = undefined;
        this.lastFlushMs = Date.now() - started;
        return;
      }

      // Unsupported protocol (should have been caught in connect)
      this.failedFlushes++;
      this.lastError = `unsupported endpoint: ${endpoint}`;
    } catch (err: any) {
      this.failedFlushes++;
      this.lastError = err?.message ? String(err.message) : "flush error";
    } finally {
      // If we got here due to an exception, we've already drained the batch.
      // This is intentional: logs are best-effort telemetry.
      if (this.lastFlushMs === undefined) this.lastFlushMs = Date.now() - started;
      this.flushing = false;
    }
  }

  close(): void {
    this.closed = true;
    this.flushing = false;
    if (this.timer) clearInterval(this.timer);
    if (this.socket) {
      try { this.socket.end(); } catch {}
      try { this.socket.destroy(); } catch {}
      this.socket = undefined;
    }
  }

  /** lightweight status for introspection */
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
      lane: this.config.endpoint.startsWith("tcp://")
        ? "tcp"
        : (this.config.endpoint.startsWith("https://") ? "https" : "http"),
    } as const;
  }
}

export default Relay;
