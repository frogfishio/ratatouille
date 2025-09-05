# Ratatouille logger

A tiny, flexible debug logger for Node and SSR that’s easy to read in dev and easy to pipe in prod.

- **Callable topics**: `const log = Topic("api"); log("hello")`.
- **Inline colors**: `Topic("api#ff00aa")`, `Topic("db#red")`, or `Topic("auth#random")`.
- **Structured logs**: `RATATOUILLE=json` emits one JSON object per line.
- **Smart filtering**: `DEBUG`-style allow/deny with wildcards; support multiple envs.
- **Per-topic sequence**: Each topic counts calls (`#000001`, `#000002`, …) and includes it in output.
- **Zero-dep & SSR-safe**: Works in Node; falls back cleanly in browsers/workers.

---

## Install

```bash
# if published
npm i @frogfish/ratatouille
# or with pnpm
pnpm add @frogfish/ratatouille
```

> Working locally? Import from source: `import Topic, { setDebug } from "./src/topic"`.

---

## Quick start

```ts
// ESM default import
import Topic from "@frogfish/ratatouille"; // or "./src/topic"

// Or named import
// import { Topic } from "@frogfish/ratatouille";

// Plain topic
const log = Topic("debug", { svc: "api" });
log("hello world", { user: "alice" }, { requestId: 123 }, "extra arg");

// Colored topic (24‑bit)
const pink = Topic("debug#ff00aa", { svc: "api" });
pink("this prints the topic in #ff00aa");

// Named color
const red = Topic("auth#red");
red("login failed");

// Stable random color from a readable palette
const api = Topic("api#random");
api("picked a deterministic 256‑color for 'api'");
```

Output (text mode):

```
[2025-09-05T01:23:45.678Z #000001] debug — hello world { user: 'alice' } { requestId: 123 } extra arg
[2025-09-05T01:23:45.790Z #000002] debug — …
```

---

## Enabling topics with `DEBUG`

Ratatouille uses `DEBUG`-style matching (like the popular `debug` package).

- Patterns are separated by **commas or whitespace**.
- `*` is a wildcard; `-` negates a pattern.
- **Allow + deny** evaluation:
  - If both allow and deny lists are empty → logging is **disabled**.
  - If allow is empty **and** deny is non-empty → **allow everything** except deny matches.
  - Otherwise → enabled if topic matches **any allow** and **no deny**.

Examples:

```bash
# Enable everything
DEBUG=* node app.js

# Enable API only
DEBUG=api* node app.js

# Enable all except chat
DEBUG=-chat* node app.js

# Mix allow/deny
DEBUG="api*,auth*,-auth:noise" node app.js
```

> **Quote** values when using `*` to avoid shell globbing.

### Multiple env vars
You can merge more variables (e.g., `XYZ`) without changing your code by using `RATATOUILLE` config (see below):

```bash
# Use DEBUG and XYZ together
RATATOUILLE='{"debugVars":["DEBUG","XYZ"]}' \
  XYZ=auth* DEBUG=-db* node app.js
```

---

## Colors

Add a color by suffixing the topic with `#…`:

- **Hex**: `#ff00aa`, `#faf` (shorthand)
- **Named** (subset): `red`, `green`, `blue`, `cyan`, `magenta`, `yellow`, `orange`, `purple`, `pink`, `teal`, `gray/grey`, `black`, `white`
- **Random**: `#random` → assigns a deterministic, readable **256‑color** based on the topic name

Color only affects the **topic label**. Messages remain uncolored for readability.

Color output toggles:

- Auto‑enabled on TTY; disabled if `NO_COLOR` or `FORCE_COLOR=0`.
- Force on/off via `RATATOUILLE` (below).

---

## Output formats

### Text (default)
```
[ISO‑8601 #SEQ] <topic> <meta> — <args…>
```
- `#SEQ` is a zero‑padded per‑topic sequence (`#000001`).
- `meta` and each argument are pretty‑printed:
  - Uses a safe JSON replacer (handles circular refs, Error objects).
  - `Error` instances print `.stack` if present (else `name: message`).

### JSON lines
Enable with `RATATOUILLE=json` or a JSON config (`{"format":"json"}`). One JSON object per line:

```json
{"ts":"2025-09-05T01:23:45.678Z","seq":1,"topic":"debug","meta":{"svc":"api"},"args":["hello",{"user":"alice"}]}
```

- Handles circulars via a safe replacer (`"[Circular]"`).
- Serializes `Error` as `{name,message,stack}`.

---

## RATATOUILLE config

A single env var that’s either **quick flags** or a **full JSON**.

### Quick flags
```bash
RATATOUILLE=nocolor   # force disable colors
RATATOUILLE=json      # structured JSON output
```

### Full JSON config
```jsonc
{
  "color": "auto" | "on" | "off",  // default "auto"
  "format": "text" | "json",        // default "text"
  "debugVars": ["DEBUG", "XYZ"],    // env vars to merge for patterns
  "extra": { /* reserved for future */ }
}
```

Examples:

```bash
# Merge DEBUG + XYZ and disable colors
RATATOUILLE='{"debugVars":["DEBUG","XYZ"],"color":"off"}' \
  XYZ=auth* DEBUG=-db* node app.js

# Force JSON logs regardless of TTY
RATATOUILLE='{"format":"json"}' DEBUG=api* node app.js
```

---

## API reference

```ts
import Topic, { setDebug } from "@frogfish/ratatouille"; // or from "./src/topic"
```

### `Topic(name: string, meta?: Record<string, unknown>): TopicCallable`
Creates a **callable logger** bound to a topic.

- `name`: may include an inline color suffix: `"topic#ff00aa"`, `"topic#red"`, `"topic#random"`.
- `meta`: optional object printed once per line after the topic.

**Returns** a function `(...args: unknown[]) => void` with properties:

- `.topic: string` — the **base** topic name (color suffix stripped)
- `.meta: Record<string, unknown> | undefined` — the meta object
- `.enabled: boolean` — whether the topic is currently enabled by filters
- `.seq: number` — current per‑topic sequence (starts at 0; first call prints `#000001`)

Usage:

```ts
const debug = Topic("debug#random", { svc: "api" });
if (debug.enabled) {
  debug("starting", { port: 8080 });
}
```

### Alternative imports

```ts
// Named Topic
import { Topic } from "@frogfish/ratatouille";
const log = Topic("api");

// Access Relay and setDebug
import Topic, { setDebug, Relay } from "@frogfish/ratatouille";
```

### `setDebug(value?: string): void`
Recompile filter patterns at runtime.

- `setDebug("api*,auth*")` — override from a string.
- `setDebug()` — rebuild from env using configured `debugVars` (e.g., `DEBUG`, `XYZ`).

Useful in tests or REPLs that toggle logging on the fly.

---

## Relay (shipping logs)

Use `Relay` to batch and forward logs to a collector. It supports two runtimes:

- Node: TCP (`tcp://host:port`) and HTTP(S) with keep‑alive.
- Cloudflare Workers/Browser: HTTP(S) via `fetch` (no TCP; keep‑alive not user‑controlled).

### Install/import

- Node (first‑class):
  - `import { Relay } from "@frogfish/ratatouille"`  // root export includes Relay in Node
  - or `import Relay from "@frogfish/ratatouille/relay"`
- Cloudflare Worker / Browser:
  - `import Relay from "@frogfish/ratatouille/relay"`  // resolves to the Worker variant

### Config

```ts
type RelayConfig = {
  endpoint: string;               // "tcp://host:port" (Node) or "https://…"
  batchMs?: number;               // flush interval (default 100)
  batchBytes?: number;            // max bytes per batch (default 262_144)
  maxQueue?: number;              // max queued lines before dropping (default 10_000)
  headers?: Record<string,string>;// extra headers for HTTP(S)
  keepAlive?: boolean;            // Node HTTP(S) keep-alive agent (default true). Ignored in Workers.
}
```

### Node example (HTTP keep‑alive)

```ts
import { Relay } from "@frogfish/ratatouille";

const relay = new Relay({
  endpoint: "https://logs.example.com/ingest",
  keepAlive: true,               // enables Node http(s).Agent keep-alive
  batchMs: 100,                  // send every ~100ms
  headers: { Authorization: `Bearer ${process.env.LOG_TOKEN}` },
});

await relay.connect();

// emit logs
relay.send({ level: "info", msg: "service started" });

// flush at checkpoints
await relay.flushNow();

// on shutdown
process.on("SIGINT", async () => {
  await relay.flushNow();
  relay.close();
  process.exit(0);
});
```

### Node example (TCP)

```ts
import { Relay } from "@frogfish/ratatouille";

const relay = new Relay("tcp://collector.internal:5001");
await relay.connect();
relay.send({ level: "warn", msg: "hot path" });
```

### Cloudflare Worker example (HTTP, batched)

```ts
// worker.ts
import Relay from "@frogfish/ratatouille/relay"; // Worker variant (fetch-based)

let relay: Relay | undefined; // lazily initialize with env-bound headers

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext) {
    if (!relay) {
      relay = new Relay({
        endpoint: "https://logs.example.com/ingest",
        batchMs: 100,
        headers: env.LOG_TOKEN ? { Authorization: `Bearer ${env.LOG_TOKEN}` } : undefined,
      });
      await relay.connect();
    }

    // enqueue structured log lines (non-blocking)
    relay.send({ ts: Date.now(), url: req.url, method: req.method });

    // ensure at least one batch is pushed even if the isolate goes idle soon
    ctx.waitUntil(relay.flushNow());
    return new Response("ok");
  }
};
```

Notes for Workers:

- Only `http(s)://` endpoints are supported (no raw TCP sockets).
- The platform may reuse connections under the hood (HTTP/1.1 persistent or HTTP/2), but keep‑alive is not configurable.
- Create a singleton Relay at module scope; avoid per‑request construction.
- Tune `batchMs` / `batchBytes` for your delivery/overhead trade‑off.

### Behavior

- `send(payload)` enqueues a single NDJSON line (object → JSON + `\n`).
- Batches are limited by `batchBytes`; oversized single lines are dropped early.
- When the queue exceeds `maxQueue`, oldest lines are dropped (counter exposed via `status()`).
- Periodic flush runs every `batchMs`. Call `flushNow()` to push one batch immediately.
- `close()` stops timers and tears down Node sockets/agents. In Workers, it clears the timer.

## Pattern syntax (recap)

- Tokens split by commas **or** whitespace: `"api*,-db*"`, `"api* -db*"`.
- `*` matches any substring.
- A leading `-` negates a token.
- **Semantics**: enabled iff (allowed or implied‑allow‑all) **and not** denied.

Edge cases:

- `DEBUG=""` → disabled.
- `DEBUG="*"` → all topics.
- `DEBUG="-chat*"` → all except `chat…` (deny‑only ⇒ allow everything else).

---

## Cross‑platform notes

### Unix shells
Quote values containing `*`:

```bash
DEBUG='api*,auth*,-auth:noise' node app.js
```

### PowerShell
```powershell
$env:DEBUG = 'api*,auth*,-auth:noise'
node app.js
```

### Windows CMD
```cmd
set DEBUG=api*,auth*,-auth:noise
node app.js
```

---

## Behavior & internals

- **No background timers** — logs are written synchronously to `stderr` (Node) or `console.error` (browsers/workers).
- **Error printing** — prints `err.stack` when available; otherwise `name: message`.
- **Portability** — guards `process` and `stderr`. If not present, falls back to `console.error`.
- **Performance** — precompiles allow/deny regexes; caches `enabled` decisions per topic; minimal stringification.

---

## FAQ

**Q: What gets colored?**  
Only the **topic label** (e.g., `debug`). Arguments remain uncolored for readability.

**Q: How do I ensure colors never print?**  
Set `RATATOUILLE=nocolor` **or** `RATATOUILLE='{"color":"off"}'`.

**Q: Can I force colors even in non‑TTY environments?**  
Yes: `RATATOUILLE='{"color":"on"}'`.

**Q: What’s `#random` vs no suffix?**  
No suffix → uncolored topic. `#random` → assign a stable 256‑color from a curated palette.

**Q: How do I combine multiple env vars for patterns?**  
`RATATOUILLE='{"debugVars":["DEBUG","XYZ"]}'` then set `DEBUG` and `XYZ` as usual.

---

## License
GPL-3.0-only
