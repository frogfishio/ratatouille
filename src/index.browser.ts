// Browser/Workers public entrypoint (no Node-only exports)
export { default as default } from "./topic";
export { Topic } from "./topic";
export { setDebug, configureRatatouille, setPrint, TopicCallable, TopicConstructor, TopicMeta, TopicOptions, LogEnvelope } from "./topic";
// Note: Relay is available via subpath import which resolves to worker variant:
//   import Relay from '@frogfish/ratatouille/relay'
