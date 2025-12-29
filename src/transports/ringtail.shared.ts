// ringtail.shared.ts
// Shared helpers for shipping Ratatouille envelopes to Ringtail.
//
// IMPORTANT:
// - This file is runtime-neutral: no Node built-ins, no `process.env` access.
// - Node vs Workers wrappers should import the appropriate Relay implementation
//   and reuse these helpers.

export type SourceIdentity = {
  app: string;
  where: string;
  instance: string;
  // Allow small extra tags (region, dc, alloc, etc.)
  [k: string]: unknown;
};

export type RatatouilleEnvelope = {
  ts?: unknown;
  seq?: number;
  topic?: string;
  meta?: unknown;
  args?: unknown[];
  env?: unknown;
};

export type RingtailEnvelope = {
  ts: unknown;
  topic: string;
  src?: SourceIdentity;
  meta?: unknown;
  args?: unknown[];
  env?: unknown;
  seq?: number;
};

export type RingtailEnv = Record<string, string | undefined>;

export type RingtailTransportConfig = {
  /** Base URL or full sink endpoint.
   * Examples:
   *  - http://127.0.0.1:8080
   *  - 127.0.0.1:8080
   *  - http://127.0.0.1:8080/sink
   */
  url: string;

  /** Bearer token for Ringtail (optional). */
  token?: string;

  /** Extra headers (optional). */
  headers?: Record<string, string>;

  /** Source identity attached to each envelope (optional). */
  src?: SourceIdentity;

  /** Relay tuning (safe defaults are in Relay). */
  batchMs?: number;
  batchBytes?: number;
  maxQueueBytes?: number;
  maxQueue?: number;
  dropPolicy?: "drop_oldest" | "drop_newest";
  keepAlive?: boolean;
  sampleRate?: number;

  /** Default topic when the Ratatouille envelope has no topic (default: "raw"). */
  defaultTopic?: string;

  /** If true, include `env` from Ratatouille envelopes (default: true). */
  includeEnv?: boolean;
};

function toNumber(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a user-provided Ringtail URL into a POST-able `/sink` endpoint.
 * - If scheme is missing, defaults to `http://`.
 * - If path is empty or `/`, uses `/sink`.
 * - If path ends with `/`, appends `sink`.
 */
export function normalizeRingtailEndpoint(input: string): string {
  const s = (input || "").trim();
  if (!s) throw new Error("Ringtail URL is empty");

  // Allow host:port as shorthand.
  const withScheme = s.startsWith("http://") || s.startsWith("https://") ? s : `http://${s}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid Ringtail URL: ${input}`);
  }

  const p = url.pathname || "/";
  if (p === "/" || p === "") {
    url.pathname = "/sink";
  } else if (p.endsWith("/")) {
    url.pathname = `${p}sink`;
  }

  return url.toString();
}

/**
 * Build a minimal config from an env object.
 * This avoids touching `process.env` in runtime-neutral code.
 */
export function ringtailConfigFromEnv(env: RingtailEnv): Partial<RingtailTransportConfig> {
  const url = env.RINGTAIL_URL || env.RINGTAIL_ENDPOINT;
  const token = env.RINGTAIL_TOKEN;

  const sampleRate = toNumber(env.RINGTAIL_SAMPLE_RATE);
  const batchMs = toNumber(env.RINGTAIL_BATCH_MS);
  const batchBytes = toNumber(env.RINGTAIL_BATCH_BYTES);
  const maxQueueBytes = toNumber(env.RINGTAIL_MAX_QUEUE_BYTES);
  const maxQueue = toNumber(env.RINGTAIL_MAX_QUEUE);

  const dropPolicy = env.RINGTAIL_DROP_POLICY === "drop_newest" ? "drop_newest" : undefined;

  const defaultTopic = env.RATATOUILLE_DEFAULT_TOPIC || env.RINGTAIL_DEFAULT_TOPIC;

  return {
    url: url || "",
    token,
    sampleRate,
    batchMs,
    batchBytes,
    maxQueueBytes,
    maxQueue,
    dropPolicy,
    defaultTopic,
  };
}

/** Build request headers for Ringtail. */
export function ringtailHeaders(cfg: Pick<RingtailTransportConfig, "token" | "headers">): Record<string, string> {
  const h: Record<string, string> = { ...(cfg.headers || {}) };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

/** Wrap a Ratatouille envelope into a stable Ringtail-friendly envelope. */
export function toRingtailEnvelope(
  e: RatatouilleEnvelope,
  opts?: { src?: SourceIdentity; includeEnv?: boolean; defaultTopic?: string },
): RingtailEnvelope {
  const defaultTopic = opts?.defaultTopic || "raw";
  const topic = (e.topic && String(e.topic)) || defaultTopic;
  const ts = e.ts ?? Date.now();
  const includeEnv = opts?.includeEnv ?? true;

  const out: RingtailEnvelope = {
    ts,
    topic,
    src: opts?.src,
    meta: e.meta,
    args: e.args,
    seq: e.seq,
  };

  if (includeEnv) out.env = e.env;
  return out;
}