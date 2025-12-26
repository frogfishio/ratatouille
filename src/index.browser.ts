export { default } from "./topic";
export { Topic } from "./topic";

export { setDebug, configureRatatouille, setPrint } from "./topic";

export type {
    TopicCallable,
    TopicConstructor,
    TopicMeta,
    TopicOptions,
    LogEnvelope,
} from "./topic";

// Relay is intentionally subpath-only:
//   import Relay from "@frogfish/ratatouille/relay"