## 0.1.3

- Node-first root export: `import { Topic, Relay } from '@frogfish/ratatouille'` in Node; Workers/Browsers get a Relay-free root via `browser` export condition.
- Dual relay implementations:
  - Node relay (`@frogfish/ratatouille/relay` → Node): TCP + HTTP(S) with keep-alive agents.
  - Worker relay (`@frogfish/ratatouille/relay` → Workers/Browser): fetch-based HTTP(S), batching.
- New `flushNow(): Promise<void>` on both relays to push one batch immediately (use `ctx.waitUntil(relay.flushNow())` in Workers; `await relay.flushNow()` in Node before shutdown).
- Topic portability: removed `node:util` dependency; safe JSON replacer is used for pretty output in all runtimes.
- README: added Node and Cloudflare Worker guides, examples, and behavior notes.

## 0.1.4

- Relay sampling: new `sampleRate` option (0..1) in both Node and Worker relays to probabilistically drop lines and control volume.
- README: added Durable Object aggregator example and Cloudflare Queues producer/consumer pipeline with batching.
- README: Worker example now shows lazy init with env-bound headers and `ctx.waitUntil(relay.flushNow())`.
