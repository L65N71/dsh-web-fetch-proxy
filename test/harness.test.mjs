import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { fallbackEnvironment, importHarnessModule, loadHarness, resolutionAnchors } from "../lib/harness.js";

test("resolutionAnchors starts inside the harness tree", () => {
  const anchors = resolutionAnchors({ DSH_HOME: path.join("C:", "h"), APPDATA: path.join("C:", "a"), LOCALAPPDATA: path.join("C:", "l") });
  assert.equal(anchors[0], path.join("C:", "h", "profiles", "resolve-anchor.js"));
  assert.ok(anchors.includes(path.join("C:", "h", "profiles", "web", "resolve-anchor.js")));
  assert.ok(anchors.some((anchor) => anchor.includes("resources")));
});

test("resolutionAnchors survives a missing DSH_HOME", () => {
  const anchors = resolutionAnchors({});
  assert.ok(Array.isArray(anchors));
  assert.ok(anchors.length > 0);
});

test("resolutionAnchors falls back to the default harness home without DSH_HOME", () => {
  // The host does not export DSH_HOME to its own process, so this fallback is the
  // one that actually resolves in practice.
  const anchors = resolutionAnchors({});
  const expected = path.join(os.homedir(), ".dsh", "profiles", "resolve-anchor.js");
  assert.ok(anchors.includes(expected), "expected " + expected + " among: " + anchors.join(", "));
  assert.ok(anchors.includes(path.join(os.homedir(), ".dsh", "profiles", "web", "resolve-anchor.js")));
});

test("resolutionAnchors reaches a global install's nested node_modules", () => {
  const dirs = [path.join("C:", "g", "node_modules"), path.join("C:", "h", "node_modules")];
  const anchors = resolutionAnchors({ NODE_PATH: dirs.join(path.delimiter) });
  for (const dir of dirs) {
    assert.ok(
      anchors.includes(path.join(dir, "@deepseek-ai", "dsh", "node_modules", "resolve-anchor.js")),
      "expected a nested anchor under " + dir,
    );
  }
});

test("fallbackEnvironment answers the shape dsh-http-proxy reads", () => {
  const env = fallbackEnvironment([{ source: "process", values: { http_proxy: "http://127.0.0.1:7897" } }]);
  assert.equal(env.get("http_proxy").value, "http://127.0.0.1:7897");
  assert.equal(env.get("no_proxy"), undefined);
  if (process.platform === "win32") {
    assert.equal(env.get("HTTP_PROXY").value, "http://127.0.0.1:7897");
  }
});

test("importHarnessModule reports an unresolvable package instead of throwing", async () => {
  assert.equal(await importHarnessModule("@deepseek-ai/dsh-definitely-not-installed", []), undefined);
});

test("importHarnessModule records why every candidate failed", async () => {
  const diagnostics = [];
  const result = await importHarnessModule(
    "@deepseek-ai/dsh-definitely-not-installed",
    [path.join(os.tmpdir(), "dsh-wfp-anchor.js")],
    diagnostics,
  );
  assert.equal(result, undefined);
  assert.equal(diagnostics.length, 2, "one resolve failure plus the bare-import failure");
  assert.match(diagnostics[0], /^resolve /);
  assert.match(diagnostics[1], /^bare import /);
});

test("loadHarness explains an unresolvable host package", async () => {
  const diagnostics = [];
  await importHarnessModule("@deepseek-ai/dsh-definitely-not-installed", [], diagnostics);
  assert.match(diagnostics.join("\n"), /ERR_MODULE_NOT_FOUND|Cannot find/);
});

test("loadHarness either returns the proxy module or a reason, never throws", async () => {
  const result = await loadHarness(process.env);
  assert.equal(typeof result.ok, "boolean");
  if (result.ok === true) {
    assert.equal(typeof result.proxy.installProxyFromEnvironment, "function");
    assert.equal(typeof result.proxy.proxyRouteFor, "function");
    assert.equal(typeof result.createSnapshot, "function");
  } else {
    assert.equal(typeof result.reason, "string");
  }
});
