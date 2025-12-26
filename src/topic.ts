// topic.ts
// Minimal, dev-focused Topic with DEBUG-style filtering and callable instances.
// Usage:
//   import { Topic } from "./topic";
//   const debug = new Topic("debug", { svc: "api" });
//   debug("hello world");
// If DEBUG=debug -> prints. If DEBUG=sev* -> topics starting with "sev" print.

/*
  Design notes
  - Instances are callable via a Proxy that forwards to an internal log() function.
  - DEBUG env supports comma/space-separated patterns, wildcards '*', and optional negation with leading '-'.
  - Printing goes to stdout in Node (fast stream write) and console.log elsewhere. Objects are JSON-stringified; Errors are summarized.
*/

// Environment/IO guards
// We treat "Node" as: a runtime with `process` and writable `process.stdout`.
// Ratatouille does *not* model an "error stream"—topics can be named "error" but
// output is just a single fire-hose stream.
const isNode =
  typeof process !== "undefined" &&
  !!(process as any)?.stdout &&
  typeof (process as any).stdout.write === "function";

// RATATOUILLE quick flags / JSON config
interface K2LogConfig {
  color?: "auto" | "on" | "off";   // default "auto"
  format?: "text" | "json";         // default "text"
  filter?: string;                    // primary filter (DEBUG-style patterns)
  debugVars?: string[];               // default ["DEBUG"]
  print?: boolean;                    // gate console/stderr printing; defaults vary (see below)
  extra?: Record<string, unknown>;    // reserved for future knobs
}

function readRatatouilleEnv(): K2LogConfig {
  // Sources (in order): process.env.RATATOUILLE, globalThis.RATATOUILLE
  let src: unknown = "";
  if (typeof process !== "undefined" && (process as any)?.env?.RATATOUILLE) {
    src = (process as any).env.RATATOUILLE;
  } else if (typeof globalThis !== "undefined" && (globalThis as any)?.RATATOUILLE) {
    src = (globalThis as any).RATATOUILLE;
  }
  const raw = String(src || "").trim();
  if (!raw) return {};
  if (raw === "nocolor") return { color: "off" };
  if (raw === "json") return { format: "json" };
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      const obj = JSON.parse(raw);
      const cfg = Array.isArray(obj) ? obj[0] : obj;
      const out: K2LogConfig = {};
      if (typeof cfg?.color === "string") out.color = cfg.color;
      if (typeof cfg?.format === "string") out.format = cfg.format;
      if (typeof cfg?.filter === "string") out.filter = cfg.filter;
      if (Array.isArray(cfg?.debugVars)) out.debugVars = cfg.debugVars.filter(Boolean);
      if (typeof cfg?.print === "boolean") out.print = cfg.print;
      if (cfg?.extra && typeof cfg.extra === "object") out.extra = cfg.extra;
      return out;
    } catch {
      return {};
    }
  }
  return {};
}

const DEFAULT_CFG: K2LogConfig = { color: "auto", format: "text", debugVars: ["DEBUG"] };
const RT_CFG: K2LogConfig = { ...DEFAULT_CFG, ...readRatatouilleEnv() };

// Enable colors only when interactive and not explicitly disabled
const colorsEnabled =
  RT_CFG.color === "off" ? false :
  RT_CFG.color === "on" ? true :
  // Use TTY detection on stdout (our single output stream). If the output is not a TTY
  // (e.g., redirected to a file/pipe), avoid emitting ANSI color codes.
  (isNode && !!(process.stdout as any)?.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0");

function readEnvFilters(): string {
  const vars = RT_CFG.debugVars ?? ["DEBUG"]; // allow multiples via RATATOUILLE JSON
  return vars.map((k) => process.env[k as keyof typeof process.env] as string | undefined).filter(Boolean).join(",");
}

function currentFilterString(): string | undefined {
  // Primary: explicit RATATOUILLE.filter; fallback: env vars (DEBUG, etc.) in Node
  if (typeof RT_CFG.filter === "string" && RT_CFG.filter.trim().length > 0) return RT_CFG.filter;
  return isNode ? readEnvFilters() : undefined;
}

// Compiled allow/deny patterns for the *emission* filter (topics that exist).
// Note: DEBUG is treated as a compatibility input for local dev printing; the core filter is RATATOUILLE.filter.
let FILTER_CFG = parseDebugEnv(currentFilterString());

function computePrintEnabled(): boolean {
  // Explicit override wins
  if (typeof RT_CFG.print === "boolean") return !!RT_CFG.print;
  // If RATATOUILLE.filter is set explicitly, default to NOT printing to console
  const hasFilter = typeof RT_CFG.filter === "string" && RT_CFG.filter.trim().length > 0;
  if (hasFilter) return false;
  // Otherwise, if using env-derived filters (e.g., DEBUG), default to printing
  const envStr = isNode ? readEnvFilters() : undefined;
  if (envStr && envStr.trim().length > 0) return true;
  return false;
}

let PRINT_ENABLED = computePrintEnabled();

/** Recompile DEBUG patterns at runtime (e.g., tests or dynamic flags) */
export function setDebug(value: string | undefined) {
  // Treat setDebug as the programmatic way to set the primary filter.
  RT_CFG.filter = value;
  FILTER_CFG = parseDebugEnv(currentFilterString());
  enabledCache.clear();
  PRINT_ENABLED = computePrintEnabled();
}

/** Programmatically configure RATATOUILLE at runtime. Accepts JSON string or partial object. */
export function configureRatatouille(value: string | Partial<K2LogConfig> | undefined): void {
  if (value == null) return;
  let next: Partial<K2LogConfig> | undefined;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return;
    if (s === "nocolor") next = { color: "off" };
    else if (s === "json") next = { format: "json" };
    else if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        const parsed = JSON.parse(s);
        next = (Array.isArray(parsed) ? parsed[0] : parsed) as Partial<K2LogConfig>;
      } catch {
        /* ignore */
      }
    }
  } else if (typeof value === "object") {
    next = value;
  }
  if (!next) return;
  if (typeof next.color === "string") (RT_CFG as any).color = next.color;
  if (typeof next.format === "string") (RT_CFG as any).format = next.format;
  if (typeof next.filter === "string") (RT_CFG as any).filter = next.filter;
  if (Array.isArray(next.debugVars)) (RT_CFG as any).debugVars = next.debugVars.filter(Boolean);
  if (typeof next.print === "boolean") (RT_CFG as any).print = next.print;
  if (next.extra && typeof next.extra === "object") (RT_CFG as any).extra = next.extra;
  // recompute
  FILTER_CFG = parseDebugEnv(currentFilterString());
  enabledCache.clear();
  PRINT_ENABLED = computePrintEnabled();
}

/** Explicitly control printing at runtime (e.g., Workers). */
export function setPrint(enabled: boolean): void {
  (RT_CFG as any).print = !!enabled;
  PRINT_ENABLED = computePrintEnabled();
}

/* Utility: parse and match DEBUG patterns */
function parseDebugEnv(envValue: string | undefined) {
  if (!envValue) return { allow: [] as RegExp[], deny: [] as RegExp[] };
  const tokens = envValue
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const allow: RegExp[] = [];
  const deny: RegExp[] = [];
  for (const t of tokens) {
    const neg = t.startsWith("-");
    const body = neg ? t.slice(1) : t;
    const rx = wildcardToRegExp(body);
    (neg ? deny : allow).push(rx);
  }
  return { allow, deny };
}

function wildcardToRegExp(pattern: string): RegExp {
  // Escape regex special chars except '*', then replace '*' with '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const enabledCache = new Map<string, boolean>();

function isEnabledFor(topic: string): boolean {
  const cached = enabledCache.get(topic);
  if (cached !== undefined) return cached;

  const { allow, deny } = FILTER_CFG;
  if (allow.length === 0 && deny.length === 0) {
    enabledCache.set(topic, false);
    return false; // filter unset => disabled
  }
  const impliedAllowAll = allow.length === 0 && deny.length > 0; // pure deny list means allow everything except…
  const allowed = impliedAllowAll || allow.some((rx) => rx.test(topic));
  const denied = deny.some((rx) => rx.test(topic));
  const result = allowed && !denied;
  enabledCache.set(topic, result);
  return result;
}

/* Pretty printer */
function fmtPart(arg: unknown): string {
  if (arg == null) return String(arg);
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  if (arg instanceof Error) return (arg as Error).stack ? (arg as Error).stack as string : `${(arg as Error).name}: ${(arg as Error).message}`;
  // Lightweight safe stringify without Node's util.inspect to stay platform-neutral
  const seen = new WeakSet();
  const replacer = (_k: string, v: unknown) => {
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (typeof v === "object" && v !== null) {
      if (seen.has(v as object)) return "[Circular]";
      seen.add(v as object);
    }
    if (typeof v === "function") return `[Function ${(v as Function).name || "anonymous"}]`;
    if (typeof v === "symbol") return v.toString();
    return v as any;
  };
  try {
    return JSON.stringify(arg, replacer);
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unserializable]";
    }
  }
}

function writeLine(s: string, force = false) {
  if (!PRINT_ENABLED && !force) return;

  if (isNode) {
    // Node hot-path: write the already-formatted line directly to stdout.
    // This is typically lower overhead than `console.log` because it avoids additional
    // formatting/inspection work and gives us predictable newline behavior.
    // We intentionally do *not* write to stderr: Ratatouille is a single-stream fire hose,
    // and stderr vs stdout is not used to encode "error" semantics.
    try {
      process.stdout.write(s + "\n");
    } catch {
      // ignore write errors in dev logging
    }
  } else {
    // Workers/Browser: there is no Node stream API, so use console.
    // IMPORTANT: use `console.log` (not `console.error`) so Wrangler/devtools don't
    // classify every log line as an ERROR.
    // eslint-disable-next-line no-console
    console.log(s);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function padSeq(n: number, width = 6): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

function writeJsonLine(seq: number, topic: string, meta: unknown, args: unknown[], env?: unknown, force = false) {
  const payload: Record<string, unknown> = { ts: nowIso(), seq, topic, meta: meta ?? null, args };
  if (typeof env !== "undefined") payload.env = env;
  try {
    writeLine(JSON.stringify(payload), force);
  } catch {
    const seen = new WeakSet();
    const safe = JSON.stringify(payload, (_k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    writeLine(safe, force);
  }
}

// Stable palette (readable 256-color indexes) for #random
const PALETTE_256 = [
  33, 39, 45, 51, 69, 75, 81,
  111, 117, 123, 129, 135, 141,
  147, 159, 165, 171, 177, 183,
  189, 195, 201, 207, 213, 219,
];

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return h >>> 0;
}

/**
 * Parse a raw topic like "debug#ff00aa", "debug#faf", or "debug#red" into { name, color }.
 */
function parseTopicSpec(raw: string): { name: string; color?: { r: number; g: number; b: number } | { ansiIndex: number } } {
  const i = raw.indexOf("#");
  if (i === -1) return { name: raw };
  const base = raw.slice(0, i) || raw;
  const spec = raw.slice(i + 1).trim();
  if (spec.toLowerCase() === "random") {
    const idx = djb2(base) % PALETTE_256.length;
    const ansiIndex = PALETTE_256[idx];
    return { name: base, color: { ansiIndex } };
  }
  const rgb = parseColor(spec);
  return rgb ? { name: base, color: rgb } : { name: base };
}

/** Accepts hex (3/6) or a small set of CSS named colors. */
function parseColor(spec: string): { r: number; g: number; b: number } | undefined {
  const hex3 = /^([0-9a-fA-F]{3})$/;
  const hex6 = /^([0-9a-fA-F]{6})$/;
  if (hex3.test(spec)) {
    const h = RegExp.$1;
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  }
  if (hex6.test(spec)) {
    const h = RegExp.$1;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const named: Record<string, [number, number, number]> = {
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    yellow: [255, 255, 0],
    orange: [255, 165, 0],
    purple: [128, 0, 128],
    pink: [255, 192, 203],
    teal: [0, 128, 128],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    black: [0, 0, 0],
    white: [255, 255, 255],
  };
  const trip = named[spec.toLowerCase()];
  return trip ? { r: trip[0], g: trip[1], b: trip[2] } : undefined;
}

function colorizeTopic(name: string, color?: { r: number; g: number; b: number } | { ansiIndex: number }): string {
  if (!color || !colorsEnabled) return name;
  if ("ansiIndex" in color) {
    return `\x1b[38;5;${color.ansiIndex}m${name}\x1b[0m`;
  }
  const { r, g, b } = color;
  return `\x1b[38;2;${r};${g};${b}m${name}\x1b[0m`;
}

export type TopicMeta = Record<string, unknown> | undefined;
export interface LogEnvelope {
  ts: string;
  seq: number;
  topic: string;
  meta: unknown;
  args: unknown[];
  env?: unknown;
}
export interface TopicOptions {
  meta?: TopicMeta;           // user-supplied metadata to print with each line
  env?: unknown;              // environment snapshot to include (e.g., Worker env)
  print?: boolean;            // per-topic print override (forces or suppresses)
}

export interface TopicCallable {
  (...args: unknown[]): void;
  topic: string;
  meta?: TopicMeta;
  /** Whether local DEBUG printing is enabled for this topic */
  readonly enabled: boolean;
  /** Attach a non-blocking handler for JSON envelopes; returns the same callable for chaining.
   * Handlers represent the "sink" side of Ratatouille (the core fire-hose). They run whenever the topic
   * is enabled by filters, regardless of whether local console printing is enabled.
   *
   * Printing is a convenience "PrintSink" for developers. If any handler is attached with alsoPrint=false
   * (default), printing is suppressed and only handlers run. If at least one handler is attached with
   * alsoPrint=true, printing happens as well as handlers (subject to the print gate).
   */
  extend(handler: (envelope: LogEnvelope) => void, alsoPrint?: boolean): TopicCallable;
}

export interface TopicConstructor {
  new (name: string, config?: TopicOptions | TopicMeta): TopicCallable;
  (name: string, config?: TopicOptions | TopicMeta): TopicCallable;
}

function normalizeOptions(config?: TopicOptions | TopicMeta): TopicOptions | undefined {
  if (config == null) return undefined;
  if (typeof config === "object" && ("meta" in (config as any) || "env" in (config as any) || "print" in (config as any))) {
    return config as TopicOptions;
  }
  // Back-compat: bare meta becomes { meta }
  return { meta: config as TopicMeta } as TopicOptions;
}

function createCallableTopic(name: string, config?: TopicOptions | TopicMeta): TopicCallable {
  const parsed = parseTopicSpec(name);
  const baseName = parsed.name;
  const explicitColor = parsed.color;
  const opts = normalizeOptions(config) || {};
  const perTopicPrint = typeof opts.print === "boolean" ? opts.print : undefined;

  let seq = 0;
  const extensions: Array<{ fn: (e: LogEnvelope) => void; alsoPrint: boolean } > = [];

  let self: TopicCallable; // will assign after proxy creation

  const fn = ((...args: unknown[]) => {
    // Emission gate: topic enabled by filters. This governs the "fire-hose" (handlers/sinks).
    if (!isEnabledFor(baseName)) return;

    const n = ++seq;
    const ts = nowIso();
    const envelope: LogEnvelope = { ts, seq: n, topic: baseName, meta: opts.meta ?? null, args, env: opts.env };

    // Fire-and-forget extension handlers (the core sink path). These run whenever enabled,
    // independent of local printing.
    if (extensions.length) {
      const call = () => {
        for (const h of extensions) {
          try {
            h.fn(envelope);
          } catch {
            /* ignore */
          }
        }
      };
      try {
        setTimeout(call, 0);
      } catch {
        try {
          queueMicrotask(call);
        } catch {
          /* ignore */
        }
      }
    }

    // Print is a convenience for developers. It is controlled by a global gate and an optional
    // per-topic override, and can be suppressed when handlers are attached (unless any handler opts
    // in to alsoPrint).
    const forcePrint = perTopicPrint === true;
    const suppressPrint = perTopicPrint === false;
    const printGate = suppressPrint ? false : (forcePrint ? true : PRINT_ENABLED);

    const shouldAlsoPrint = extensions.length === 0 || extensions.some((h) => h.alsoPrint);
    const shouldPrint = printGate && shouldAlsoPrint;

    if (!shouldPrint) return;

    if ((RT_CFG.format ?? "text") === "json") {
      writeJsonLine(n, baseName, opts.meta, args, opts.env, forcePrint);
      return;
    }

    const head = `[${ts} #${padSeq(n)}] ${colorizeTopic(baseName, explicitColor)}`;
    const pieces = args.map((a) => fmtPart(a));
    const metaStr = opts.meta ? ` ${fmtPart(opts.meta)}` : "";
    const envStr = typeof opts.env !== "undefined" ? ` ${fmtPart(opts.env)}` : "";
    const line = `${head}${metaStr}${envStr} — ${pieces.join(" ")}`;
    writeLine(line, forcePrint);
  }) as TopicCallable;

  self = new Proxy(fn, {
    get: (t, prop) => {
      if (prop === "topic") return baseName;
      if (prop === "meta") return opts.meta;
      if (prop === "enabled") return isEnabledFor(baseName);
      if (prop === "seq") return seq;
      if (prop === "extend") return (handler: (e: LogEnvelope) => void, alsoPrint: boolean = false) => {
        if (typeof handler === "function") extensions.push({ fn: handler, alsoPrint: !!alsoPrint });
        return self;
      };
      // fall back to function props (e.g., length, name)
      // @ts-ignore - allow passthrough to function properties
      return (t as any)[prop];
    },
  });

  return self;
}

export const Topic: TopicConstructor = function (
  this: unknown,
  name: string,
  config?: TopicOptions | TopicMeta,
): TopicCallable {
  // Note: second arg may be legacy meta or a config object
  return createCallableTopic(name, config);
} as unknown as TopicConstructor;

export default Topic;
