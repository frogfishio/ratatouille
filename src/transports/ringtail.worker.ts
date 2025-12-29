// ringtail.worker.ts (Workers/browser)
// Workers/browser wrapper for the Ringtail transport.
//
// IMPORTANT: This file imports the Workers Relay implementation (../relay.worker).
// The Node wrapper lives in `ringtail.ts` and imports `../relay`.

import Relay from "../relay.worker";

export {
  normalizeRingtailEndpoint,
  ringtailConfigFromEnv,
  ringtailHeaders,
  toRingtailEnvelope,
} from "./ringtail.shared";

export type {
  SourceIdentity,
  RatatouilleEnvelope,
  RingtailEnvelope,
  RingtailEnv,
  RingtailTransportConfig,
} from "./ringtail.shared";

import {
  normalizeRingtailEndpoint,
  ringtailHeaders,
  toRingtailEnvelope,
  type RatatouilleEnvelope,
  type RingtailTransportConfig,
} from "./ringtail.shared";

export type RingtailTransport = {
  relay: Relay;
  endpoint: string;
  connect: () => Promise<void>;
  send: (e: RatatouilleEnvelope) => void;
  close: () => void;
  status: () => ReturnType<Relay["status"]>;
};

/**
 * Create a Ringtail transport (Workers/browser).
 */
export function createRingtailTransport(cfg: RingtailTransportConfig): RingtailTransport {
  if (!cfg || !cfg.url) throw new Error("Ringtail transport requires `url`");

  const endpoint = normalizeRingtailEndpoint(cfg.url);
  const headers = ringtailHeaders({ token: cfg.token, headers: cfg.headers });

  const relay = new Relay({
    endpoint,
    headers,
    batchMs: cfg.batchMs,
    batchBytes: cfg.batchBytes,
    maxQueueBytes: cfg.maxQueueBytes,
    maxQueue: cfg.maxQueue,
    dropPolicy: cfg.dropPolicy,
    keepAlive: cfg.keepAlive,
    sampleRate: cfg.sampleRate,
  } as any);

  return {
    relay,
    endpoint,
    connect: () => relay.connect(),
    send: (e: RatatouilleEnvelope) => {
      try {
        relay.send(
          toRingtailEnvelope(e, {
            src: cfg.src,
            includeEnv: cfg.includeEnv,
            defaultTopic: cfg.defaultTopic,
          }),
        );
      } catch {
        // best-effort telemetry
      }
    },
    close: () => relay.close(),
    status: () => relay.status(),
  };
}

export default createRingtailTransport;