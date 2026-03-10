import { defineConfig } from "tsup";

export default defineConfig([
    {
        entry: {
            "index.node": "src/index.node.ts",
            "index.browser": "src/index.browser.ts",

            "relay": "src/relay.ts",
            "relay.worker": "src/relay.worker.ts",

            "transports/ringtail": "src/transports/ringtail.ts",
            "transports/ringtail.worker": "src/transports/ringtail.worker.ts",

            "presets/nomad": "src/presets/nomad.ts",
            "presets/lambda": "src/presets/lambda.ts",
            "presets/workers": "src/presets/workers.ts",
        },
        format: ["esm"],
        dts: true,
        sourcemap: true,
        splitting: false,
        treeshake: true,
        target: "es2022",
        outDir: "dist",
    },
    {
        entry: {
            "index.node.require": "src/index.node.require.cts",
            "relay.require": "src/relay.require.cts",
            "transports/ringtail.require": "src/transports/ringtail.require.cts",
            "presets/nomad.require": "src/presets/nomad.require.cts",
            "presets/lambda.require": "src/presets/lambda.require.cts",
        },
        format: ["cjs"],
        dts: false,
        sourcemap: true,
        splitting: false,
        treeshake: true,
        target: "es2022",
        outDir: "dist",
    },
]);