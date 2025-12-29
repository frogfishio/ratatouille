
// nomad.ts
// Nomad (Node) preset for Ratatouille.
//
// Goal: one install, minimal wiring.
// - Computes a stable-ish source identity from Nomad env vars.
// - Optionally ships envelopes to Ringtail (if RINGTAIL_URL is set).
// - Exposes a global topic factory usable from any file.

import Topic from "../topic";
import {
  createRingtailTransport,
  ringtailConfigFromEnv,
  type RingtailTransport,
  type RingtailTransportConfig,
  type SourceIdentity,
} from "../transports/ringtail";

type Json = Record<string, unknown>;

type NomadFactory = {
  /** Create a topic (same as Topic(name), but wired to Ringtail if enabled). */
  topic: (name: string, meta?: Json) => ReturnType<typeof Topic>;
  /** Optional eager connect (useful at process startup). */
  initLogging: () => Promise<void>;
  /** The computed source identity attached to envelopes. */
  sourceIdentity: () => SourceIdentity;
  /** Transport status if enabled (Relay counters). */
  transportStatus: () => ReturnType<RingtailTransport["status"]> | undefined;
};

export type NomadFactoryOptions = {
  /** Override env; defaults to process.env. */
  env?: Record<string, string | undefined>;

  /** Force enable/disable Ringtail transport. Default: enabled iff url is present. */
  enabled?: boolean;

  /** Override Ringtail base URL (or full /sink URL). Default: env RINGTAIL_URL. */
  ringtailUrl?: string;

  /** Override token. Default: env RINGTAIL_TOKEN. */
  ringtailToken?: string;

  /** Override computed app/where/instance (rare; mostly tests). */
  src?: SourceIdentity;

  /** If true, include `env` from Ratatouille envelopes (default: true). */
  includeEnv?: boolean;

  /** If true, also print locally while forwarding (default: false). */
  alsoPrint?: boolean;

  /** Optional: pass through Relay tuning. */
  transport?: Omit<RingtailTransportConfig, "url" | "token" | "src" | "includeEnv">;
};

function pick(...xs: Array<string | undefined>): string | undefined {
  for (const x of xs) {
    if (x != null && String(x).trim() !== "") return String(x);
  }
  return undefined;
}

function randomSuffix(): string {
  // Avoid Node-only imports; this is best-effort identity only.
  return Math.random().toString(16).slice(2, 10);
}

export function computeNomadSourceIdentity(env: Record<string, string | undefined> = process.env): SourceIdentity {
  // Explicit overrides (portable across platforms)
  const explicitApp = pick(env.RATATOUILLE_APP, env.APP, env.SERVICE);
  const explicitWhere = pick(env.RATATOUILLE_WHERE);
  const explicitInstance = pick(env.RATATOUILLE_INSTANCE);

  // Nomad context (best-effort)
  const nomadJob = pick(env.NOMAD_JOB_NAME);
  const nomadGroup = pick(env.NOMAD_GROUP_NAME);
  const nomadTask = pick(env.NOMAD_TASK_NAME);
  const nomadAlloc = pick(env.NOMAD_ALLOC_ID);
  const nomadRegion = pick(env.NOMAD_REGION);
  const nomadDc = pick(env.NOMAD_DC);

  const app = explicitApp || nomadJob || nomadTask || "app";
  const where = explicitWhere || (nomadJob ? "nomad" : "node");

  let instance = explicitInstance;
  if (!instance) {
    const parts: string[] = [];
    if (nomadRegion) parts.push(nomadRegion);
    if (nomadDc) parts.push(nomadDc);
    if (nomadAlloc) parts.push(nomadAlloc.slice(0, 8));
    if (nomadGroup) parts.push(nomadGroup);
    if (nomadTask) parts.push(nomadTask);
    if (parts.length === 0) parts.push(`pid${process.pid}`, randomSuffix());
    instance = parts.join(":");
  }

  const src: SourceIdentity = { app, where, instance };

  // Keep a little extra provenance (handy for filtering).
  if (nomadJob) src.nomad_job = nomadJob;
  if (nomadGroup) src.nomad_group = nomadGroup;
  if (nomadTask) src.nomad_task = nomadTask;
  if (nomadAlloc) src.nomad_alloc = nomadAlloc;
  if (nomadRegion) src.nomad_region = nomadRegion;
  if (nomadDc) src.nomad_dc = nomadDc;

  return src;
}

export function createNomadFactory(opts: NomadFactoryOptions = {}): NomadFactory {
  const env = opts.env || process.env;

  const envCfg = ringtailConfigFromEnv(env);
  const url = pick(opts.ringtailUrl, envCfg.url);
  const token = pick(opts.ringtailToken, envCfg.token);

  const enabled = opts.enabled ?? Boolean(url);

  const src = opts.src || computeNomadSourceIdentity(env);

  const includeEnv = opts.includeEnv ?? true;
  const alsoPrint = opts.alsoPrint ?? false;

  // Singleton transport + connect gate.
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

      // Merge env-derived tuning with explicit opts, then with transport overrides.
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

    // Best-effort connect once; never await on hot paths.
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
          // Lazily ensure transport (in case it was GC'd or never created).
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

export default createNomadFactory;

