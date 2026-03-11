// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

const ringtailModule = require("./ringtail");

const createRingtailTransport = ringtailModule.default ?? ringtailModule;
const ringtailFacade = Object.assign(createRingtailTransport, {
    default: createRingtailTransport,
    createRingtailTransport: ringtailModule.createRingtailTransport,
    normalizeRingtailEndpoint: ringtailModule.normalizeRingtailEndpoint,
    ringtailConfigFromEnv: ringtailModule.ringtailConfigFromEnv,
    ringtailHeaders: ringtailModule.ringtailHeaders,
    toRingtailEnvelope: ringtailModule.toRingtailEnvelope,
});

export = ringtailFacade;
