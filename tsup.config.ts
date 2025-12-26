import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index.node": "src/index.node.ts",
        "index.browser": "src/index.browser.ts",
        "relay": "src/relay.ts",
        "relay.worker": "src/relay.worker.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    target: "es2022",
    outDir: "dist",
});