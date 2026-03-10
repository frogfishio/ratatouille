const relayModule = require("./relay");

const Relay = relayModule.default ?? relayModule;
const relayFacade = Object.assign(Relay, {
    default: Relay,
    Relay: relayModule.Relay,
});

export = relayFacade;
