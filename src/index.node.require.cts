// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

const topicModule = require("./topic");
const relayModule = require("./relay");

const Topic = topicModule.default ?? topicModule;
const Relay = relayModule.default ?? relayModule;

const ratatouille = Object.assign(Topic, {
    default: Topic,
    Topic: topicModule.Topic,
    setDebug: topicModule.setDebug,
    configureRatatouille: topicModule.configureRatatouille,
    setPrint: topicModule.setPrint,
    Relay,
});

export = ratatouille;
