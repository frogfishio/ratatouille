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
  - Printing goes to stderr with a small, predictable format. Objects are JSON-stringified; Errors are summarized.
*/

// Environment/IO guards
const isNode = typeof process !== "undefined" && !!(process as any)?.stderr;

// RATATOUILLE quick flags / JSON config
interface K2LogConfig {
  color?: "auto" | "on" | "off";   // default "auto"
  format?: "text" | "json";         // default "text"
  debugVars?: string[];               // default ["DEBUG"]
  extra?: Record<string, unknown>;    // reserved for future knobs
}

function readRatatouilleEnv(): K2LogConfig {
  // In non-Node runtimes (browsers/workers), there is no process.env
  const ratatouille = (typeof process !== "undefined" && (process as any)?.env?.RATATOUILLE) || "";
  const raw = String(ratatouille).trim();
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
      if (Array.isArray(cfg?.debugVars)) out.debugVars = cfg.debugVars.filter(Boolean);
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
  (isNode && !!(process.stderr as any)?.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0");

function readDebugStrings(): string {
  const vars = RT_CFG.debugVars ?? ["DEBUG"]; // allow multiples via RATATOUILLE JSON
  return vars.map((k) => process.env[k as keyof typeof process.env] as string | undefined).filter(Boolean).join(",");
}

let DEBUG_CFG = parseDebugEnv(isNode ? readDebugStrings() : undefined);

/** Recompile DEBUG patterns at runtime (e.g., tests or dynamic flags) */
export function setDebug(value: string | undefined) {
  DEBUG_CFG = parseDebugEnv(value ?? (isNode ? readDebugStrings() : undefined));
  enabledCache.clear();
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

  const { allow, deny } = DEBUG_CFG;
  if (allow.length === 0 && deny.length === 0) {
    enabledCache.set(topic, false);
    return false; // DEBUG unset => disabled
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

function writeLine(s: string) {
  if (isNode) {
    try {
      process.stderr.write(s + "\n");
    } catch {
      // ignore write errors in dev logging
    }
  } else {
    // eslint-disable-next-line no-console
    console.error(s);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function padSeq(n: number, width = 6): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

function writeJsonLine(seq: number, topic: string, meta: unknown, args: unknown[]) {
  const payload: Record<string, unknown> = { ts: nowIso(), seq, topic, meta: meta ?? null, args };
  try {
    writeLine(JSON.stringify(payload));
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
    writeLine(safe);
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

export interface TopicCallable {
  (...args: unknown[]): void;
  topic: string;
  meta?: TopicMeta;
  /** Whether local DEBUG printing is enabled for this topic */
  readonly enabled: boolean;
}

export interface TopicConstructor {
  new (name: string, meta?: TopicMeta): TopicCallable;
  (name: string, meta?: TopicMeta): TopicCallable;
}

function createCallableTopic(name: string, meta?: TopicMeta): TopicCallable {
  const parsed = parseTopicSpec(name);
  const baseName = parsed.name;
  const explicitColor = parsed.color;

  let seq = 0;

  const fn = ((...args: unknown[]) => {
    if (!isEnabledFor(baseName)) return; // no-op when DEBUG doesn’t match
    const n = ++seq;
    if ((RT_CFG.format ?? "text") === "json") {
      writeJsonLine(n, baseName, meta, args);
      return;
    }
    const ts = nowIso();
    const head = `[${ts} #${padSeq(n)}] ${colorizeTopic(baseName, explicitColor)}`;
    const pieces = args.map((a) => fmtPart(a));
    const metaStr = meta ? ` ${fmtPart(meta)}` : "";
    const line = `${head}${metaStr} — ${pieces.join(" ")}`;
    writeLine(line);
  }) as TopicCallable;

  return new Proxy(fn, {
    get: (t, prop) => {
      if (prop === "topic") return baseName;
      if (prop === "meta") return meta;
      if (prop === "enabled") return isEnabledFor(baseName);
      if (prop === "seq") return seq;
      // fall back to function props (e.g., length, name)
      // @ts-ignore - allow passthrough to function properties
      return (t as any)[prop];
    },
  });
}

export const Topic: TopicConstructor = function (this: unknown, name: string, meta?: TopicMeta): TopicCallable {
  return createCallableTopic(name, meta);
} as unknown as TopicConstructor;

export default Topic;
