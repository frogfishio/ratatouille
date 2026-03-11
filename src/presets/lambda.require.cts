// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

const lambdaModule = require("./lambda");

const createLambdaFactory = lambdaModule.default ?? lambdaModule;
const lambdaFacade = Object.assign(createLambdaFactory, {
    default: createLambdaFactory,
    createLambdaFactory: lambdaModule.createLambdaFactory,
    computeLambdaSourceIdentity: lambdaModule.computeLambdaSourceIdentity,
});

export = lambdaFacade;
