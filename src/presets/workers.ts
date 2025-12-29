// workers.ts
// Workers (Cloudflare/Service Worker / browser) preset for Ratatouille.
//
// Goal: one install, minimal wiring.
// - Computes a stable-ish source identity from provided `env`.
// - Optionally ships envelopes to Ringtail (if RINGTAIL_URL is set).
// - Exposes a global topic factory usable from any module.

import Topic from "../topic";
import {
  createRingtailTransport,
  ringtailConfigFromEnv,
  type RingtailTransport,
  type RingtailTransportConfig,
  type SourceIdentity,
} from "../transports/ringtail.worker";

type Json = Record<string, unknown>;

export type WorkersFactoryOptions = {
  /** Worker env bindings / vars (strings preferred). */
  env: Record<string, unknown>;

  /** Force enable/disable Ringtail transport. Default: enabled iff url is present. */
  enabled?: boolean;

  /** Override Ringtail base URL (or full /sink URL). Default: env RINGTAIL_URL. */
  ringtailUrl?: string;

  /** Override token. Default: env RINGTAIL_TOKEN. */
  ringtailToken?: string;

  /** Override computed app/where/instance. */
  src?: SourceIdentity;

  /** Convenience overrides (used only if `src` is not provided). */
  app?: string;
  where?: string;
  instance?: string;

  /** If true, include `env` from Ratatouille envelopes (default: true). */
  includeEnv?: boolean;

  /** If true, also print locally while forwarding (default: false). */
  alsoPrint?: boolean;

  /** Optional: pass through Relay tuning. */
  transport?: Omit<RingtailTransportConfig, "url" | "token" | "src" | "includeEnv">;
};

export type WorkersFactory = {
  topic: (name: string, meta?: Json) => ReturnType<typeof Topic>;
  initLogging: () => Promise<void>;
  sourceIdentity: () => SourceIdentity;
  transportStatus: () => ReturnType<RingtailTransport["status"]> | undefined;
};

function pick(...xs: Array<unknown>): string | undefined {
  for (const x of xs) {
    if (typeof x === "string" && x.trim() !== "") return x;
  }
  return undefined;
}

function envToStringRecord(env: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

const ISOLATE_ID: string = (() => {
  try {
    const c: any = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {}
  return Math.random().toString(16).slice(2, 10);
})();

export function computeWorkersSourceIdentity(
  env: Record<string, unknown>,
  overrides?: { app?: string; where?: string; instance?: string },
): SourceIdentity {
  const e = envToStringRecord(env);

  const app =
    pick(overrides?.app, e.RATATOUILLE_APP, e.APP, e.SERVICE, e.WORKER_NAME, e.CF_WORKER_NAME) || "worker";

  const where = pick(overrides?.where, e.RATATOUILLE_WHERE, e.RINGTAIL_WHERE, e.WHERE) || "cf-worker";

  const envName = pick(e.ENVIRONMENT, e.ENV, e.STAGE);
  const region = pick(e.CF_REGION, e.REGION);

  const instance =
    pick(overrides?.instance, e.RATATOUILLE_INSTANCE, e.INSTANCE) ||
    [envName, region, ISOLATE_ID].filter(Boolean).join(":") ||
    ISOLATE_ID;

  const src: SourceIdentity = { app, where, instance };
  if (envName) src.environment = envName;
  if (region) src.region = region;

  return src;
}

export function createWorkersFactory(opts: WorkersFactoryOptions): WorkersFactory {
  if (!opts || !opts.env) throw new Error("createWorkersFactory requires { env }");

  const envStrings = envToStringRecord(opts.env);
  const envCfg = ringtailConfigFromEnv(envStrings);

  const url = pick(opts.ringtailUrl, envCfg.url);
  const token = pick(opts.ringtailToken, envCfg.token);

  const enabled = opts.enabled ?? Boolean(url);

  const src =
    opts.src ||
    computeWorkersSourceIdentity(opts.env, {
      app: opts.app,
      where: opts.where,
      instance: opts.instance,
    });

  const includeEnv = opts.includeEnv ?? true;
  const alsoPrint = opts.alsoPrint ?? false;

  let transport: RingtailTransport | undefined;
  let connectPromise: Promise<void> | undefined;

  const ensureTransport = (): RingtailTransport | undefined => {
    if (!enabled) return undefined;
    if (!url) return undefined;
    if (transport) return transport;

    transport = createRingtailTransport({
      url,
      token,
      src,
      includeEnv,

      batchMs: opts.transport?.batchMs ?? envCfg.batchMs,
      batchBytes: opts.transport?.batchBytes ?? envCfg.batchBytes,
      maxQueueBytes: opts.transport?.maxQueueBytes ?? envCfg.maxQueueBytes,
      maxQueue: opts.transport?.maxQueue ?? envCfg.maxQueue,
      dropPolicy: opts.transport?.dropPolicy ?? envCfg.dropPolicy,
      sampleRate: opts.transport?.sampleRate ?? envCfg.sampleRate,
      keepAlive: opts.transport?.keepAlive,
      headers: opts.transport?.headers,
      defaultTopic: opts.transport?.defaultTopic ?? envCfg.defaultTopic,
    } as any);

    connectPromise = transport
      .connect()
      .catch(() => {
        // swallow; telemetry is best-effort
      });

    return transport;
  };

  const initLogging = async () => {
    const t = ensureTransport();
    if (!t) return;
    if (connectPromise) await connectPromise;
  };

  const topic = (name: string, meta?: Json) => {
    const t = Topic(name, meta ? { meta } : undefined);
    const tr = ensureTransport();
    if (!tr) return t;

    return t.extend(
      (e: any) => {
        try {
          const live = ensureTransport();
          if (!live) return;
          live.send(e);
        } catch {
          // swallow
        }
      },
      alsoPrint,
    );
  };

  return {
    topic,
    initLogging,
    sourceIdentity: () => src,
    transportStatus: () => transport?.status(),
  };
}

export default createWorkersFactory;