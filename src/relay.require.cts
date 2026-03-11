// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

const relayModule = require("./relay");

const Relay = relayModule.default ?? relayModule;
const relayFacade = Object.assign(Relay, {
    default: Relay,
    Relay: relayModule.Relay,
});

export = relayFacade;
