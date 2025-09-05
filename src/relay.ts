// relay.ts
// Relay class for maintaining a connection to a log collector with non-blocking queue and periodic flush.

import net from "net";
import http from "http";
import https from "https";

export interface RelayConfig {
  endpoint: string;              // tcp://host:port or http(s)://...
  batchMs?: number;              // flush interval (ms), default 100
  batchBytes?: number;           // max bytes per batch, default 262_144 (256KB)
  maxQueue?: number;             // max enqueued lines, default 10_000
  headers?: Record<string,string>; // extra headers for HTTP(S)
  keepAlive?: boolean;           // HTTP keep-alive agent, default true
}

const DEFAULTS = {
  batchMs: 100,
  batchBytes: 262_144,
  maxQueue: 10_000,
  keepAlive: true,
};

export class Relay {
  private config: Required<RelayConfig>;
  private socket?: net.Socket;
  private httpAgent?: http.Agent | https.Agent;
  private closed = false;
  private timer?: NodeJS.Timeout;
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

  /** Enqueue one envelope as NDJSON. Non-blocking; drops when full. */
  send(payload: object): void {
    if (this.closed) return;
    const line = JSON.stringify(payload) + "\n";
    // oversize single line? drop it early
    if (line.length > this.config.batchBytes) {
      this.dropped++;
      return;
    }
    this.q.push(line);
    this.queuedBytes += line.length;
    if (this.q.length > this.config.maxQueue) {
      const removed = this.q.shift();
      if (removed) this.queuedBytes -= removed.length;
      this.dropped++;
    }
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
    if (this.closed) return;
    const data = this.drainBatch();
    if (!data) return;
    const { endpoint } = this.config;

    if (endpoint.startsWith("tcp://") && this.socket) {
      // Single write; best-effort
      try { this.socket.write(data); } catch { /* ignore */ }
      return;
    }

    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      const isHttps = endpoint.startsWith("https://");
      const mod = isHttps ? https : http;
      const req = mod.request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Length": Buffer.byteLength(data),
          ...this.config.headers,
        },
        agent: this.httpAgent,
      });
      req.on("error", () => { /* ignore in emitter */ });
      req.write(data);
      req.end();
      return;
    }
  }

  /** Flush one batch immediately and resolve when send attempt completes. */
  async flushNow(): Promise<void> {
    if (this.closed) return;
    const data = this.drainBatch();
    if (!data) return;
    const { endpoint } = this.config;

    if (endpoint.startsWith("tcp://") && this.socket) {
      await new Promise<void>((resolve) => {
        try {
          this.socket!.write(data, () => resolve());
        } catch {
          resolve();
        }
      });
      return;
    }

    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      const isHttps = endpoint.startsWith("https://");
      const mod = isHttps ? https : http;
      await new Promise<void>((resolve) => {
        try {
          const req = mod.request(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-ndjson",
              "Content-Length": Buffer.byteLength(data),
              ...this.config.headers,
            },
            agent: this.httpAgent,
          }, () => resolve());
          req.on("error", () => resolve());
          req.write(data);
          req.end();
        } catch {
          resolve();
        }
      });
      return;
    }
  }

  close(): void {
    this.closed = true;
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
      lane: this.config.endpoint.startsWith("tcp://") ? "tcp" : (this.config.endpoint.startsWith("https://") ? "https" : "http"),
    } as const;
  }
}

export default Relay;
