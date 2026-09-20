/**
 * Live diagnostic for the trigger gate.
 *
 * Prints which Clash config files were found, which switch reports what, and what
 * discoverProxy() would decide right now. Run it from the package root:
 *
 *     node scripts/gate-check.mjs
 *
 * Read-only: it touches no route and never installs a proxy policy, so it is safe
 * to run while DSH is serving.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clashConfigFiles,
  discoverProxy,
  readClashTunEnabled,
  readWindowsSystemProxy,
} from "../lib/detect.js";

/** A path that never exists, so the gate can be shown closed without touching Clash. */
const NO_CLASH_FILES = { files: [path.join(os.tmpdir(), "dsh-wfp-absent-config.yaml")] };

console.log("=== Clash 配置文件探测 ===");
for (const file of clashConfigFiles()) {
  console.log((fs.existsSync(file) ? "  FOUND  " : "   -     ") + file);
}

console.log("\n=== 开关读取 ===");
console.log("readClashTunEnabled()    =", readClashTunEnabled());
console.log("readWindowsSystemProxy() =", JSON.stringify(readWindowsSystemProxy()));

console.log("\n=== discoverProxy（env 已隔离，排除从 DSH 继承的代理变量）===");
for (const trigger of ["toggles", "reachable"]) {
  const hit = await discoverProxy({ explicit: "auto", env: {}, trigger });
  console.log(`  trigger=${trigger.padEnd(9)} -> ${JSON.stringify(hit)}`);
}

console.log("\n=== 模拟两者都关（忽略真实 Clash 配置）===");
const gated = await discoverProxy({
  explicit: "auto",
  env: {},
  trigger: "toggles",
  readSystemProxy: () => undefined,
  clashOptions: NO_CLASH_FILES,
  ports: [7897],
  reachable: async () => true,
});
console.log("  ->", JSON.stringify(gated));
