// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

const nomadModule = require("./nomad");

const createNomadFactory = nomadModule.default ?? nomadModule;
const nomadFacade = Object.assign(createNomadFactory, {
    default: createNomadFactory,
    createNomadFactory: nomadModule.createNomadFactory,
    computeNomadSourceIdentity: nomadModule.computeNomadSourceIdentity,
});

export = nomadFacade;
