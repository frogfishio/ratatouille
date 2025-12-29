import { defineConfig } from "tsup";

export default defineConfig({
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
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    target: "es2022",
    outDir: "dist",
});