## 0.1.3

- Node-first root export: `import { Topic, Relay } from '@frogfish/ratatouille'` in Node; Workers/Browsers get a Relay-free root via `browser` export condition.
- Dual relay implementations:
  - Node relay (`@frogfish/ratatouille/relay` → Node): TCP + HTTP(S) with keep-alive agents.
  - Worker relay (`@frogfish/ratatouille/relay` → Workers/Browser): fetch-based HTTP(S), batching.
- New `flushNow(): Promise<void>` on both relays to push one batch immediately (use `ctx.waitUntil(relay.flushNow())` in Workers; `await relay.flushNow()` in Node before shutdown).
- Topic portability: removed `node:util` dependency; safe JSON replacer is used for pretty output in all runtimes.
- README: added Node and Cloudflare Worker guides, examples, and behavior notes.

## 0.1.4

## 0.1.5

## 0.1.6

- Workers config: added `configureRatatouille(value)` to apply config at runtime (accepts JSON string or partial object). Useful to pass `env.RATATOUILLE` from `wrangler.toml`.
- Printing control API: added `setPrint(boolean)` to explicitly enable/disable console/stderr output at runtime.
- Config detection: `RATATOUILLE` can also be read from `globalThis.RATATOUILLE` when present.
- README: added Cloudflare Worker configuration example using `configureRatatouille(env.RATATOUILLE)`.

- Config precedence: added `RATATOUILLE.filter` as the primary filter string; falls back to env vars (e.g., `DEBUG`) only when `filter` is not set.
- Printing control: new `RATATOUILLE.print` option. Defaults: if `filter` is set and `print` unspecified → do not print; if using env-derived filters (e.g., `DEBUG`) → print by default for debug-compat.
- API: `setDebug(value)` now sets the primary filter (equivalent to `RATATOUILLE.filter`) and recomputes print behavior.
- README: documented `filter` and `print` options and updated examples; dev script uses RATATOUILLE only.

- Relay sampling: new `sampleRate` option (0..1) in both Node and Worker relays to probabilistically drop lines and control volume.
- README: added Durable Object aggregator example and Cloudflare Queues producer/consumer pipeline with batching.
- README: Worker example now shows lazy init with env-bound headers and `ctx.waitUntil(relay.flushNow())`.
