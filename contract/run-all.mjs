import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const commands = [
  ["npm", ["run", "build"]],
  ["make", ["-C", "c", "example"]],
  ["node", [path.join("contract", "run-node.mjs"), path.join("contract", "cases.tsv")]],
  [path.join("c", "build", "contract_runner"), [path.join("contract", "cases.tsv")]],
  ["cargo", ["run", "--manifest-path", path.join("rust", "Cargo.toml"), "--example", "contract_runner", "--", path.join("contract", "cases.tsv")]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DEBUG: "" },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("contract test suite ok");
