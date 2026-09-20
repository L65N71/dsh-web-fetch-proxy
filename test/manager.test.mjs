import test from "node:test";
import assert from "node:assert/strict";

import { createManager, isProxyDisabled, normalizeConfig } from "../lib/manager.js";

/** A harness stand-in that records install / release calls. */
function fakeHarness(reachable) {
  const state = { installed: 0, released: 0, environments: [] };
  return {
    state,
    ok: true,
    createSnapshot: (layers) => ({ layers }),
    proxy: {
      async installProxyFromEnvironment(environment) {
        if (reachable === false) throw new Error("install refused");
        state.installed += 1;
        state.environments.push(environment);
        return async () => { state.released += 1; };
      },
      proxyRouteFor() {
        return state.installed > state.released ? { proxied: true, proxy: "http://fake:1" } : { proxied: false };
      },
    },
  };
}

const silent = () => {};

test("normalizeConfig clamps and defaults every field", () => {
  assert.deepEqual(normalizeConfig(undefined), {
    enabled: true, proxy: "auto", noProxy: "", trigger: "toggles", pollMs: 5000,
    retryMs: 15000, maxRetries: 20, probeTimeoutMs: 400,
  });
  assert.deepEqual(normalizeConfig({ enabled: false, proxy: " off ", noProxy: " .a ", retryMs: -5, maxRetries: 2.9, probeTimeoutMs: 1 }), {
    enabled: false, proxy: "off", noProxy: ".a", trigger: "toggles", pollMs: 5000,
    retryMs: 0, maxRetries: 2, probeTimeoutMs: 50,
  });
  assert.equal(normalizeConfig({ trigger: " REACHABLE " }).trigger, "reachable");
  assert.equal(normalizeConfig({ pollMs: -3 }).pollMs, 0);
});

test("a closed trigger gate settles as idle and installs nothing", async () => {
  const harness = fakeHarness(true);
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => ({ gated: true, reason: "开关都没开" }),
  });

  await manager.configure({ proxy: "auto" });
  const status = manager.snapshot();
  assert.equal(status.phase, "idle");
  assert.equal(status.url, undefined);
  assert.equal(status.message, "开关都没开");
  assert.equal(harness.state.installed, 0, "a gated reconcile must not install a route");
});

test("a gated reconcile drops a route that a previous poll installed", async () => {
  const harness = fakeHarness(true);
  let gated = false;
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => (gated ? { gated: true, reason: "开关关了" } : { url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  assert.equal(manager.snapshot().phase, "ready");
  assert.equal(harness.state.installed, 1);

  gated = true;
  await manager.redetect();
  assert.equal(manager.snapshot().phase, "idle");
  assert.equal(harness.state.released, 1, "the stale route must be released");
  assert.equal(harness.proxy.proxyRouteFor().proxied, false);
});

test("polling replaces the burst retry loop", async () => {
  let calls = 0;
  const harness = fakeHarness(true);
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => { calls += 1; return undefined; },
  });

  await manager.configure({ proxy: "auto", retryMs: 1, maxRetries: 5, pollMs: 5000 });
  assert.equal(calls, 1, "one attempt per reconcile while polling is on");
  assert.equal(manager.snapshot().phase, "error");
});

test("isProxyDisabled matches every spelling of off", () => {
  for (const value of ["off", "OFF", " none ", "direct", "false", "disabled"]) {
    assert.equal(isProxyDisabled(value), true, value);
  }
  for (const value of ["auto", "http://127.0.0.1:7897", ""]) {
    assert.equal(isProxyDisabled(value), false, value);
  }
});

test("configure installs a discovered proxy and dispose releases it", async () => {
  const harness = fakeHarness(true);
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => ({ url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  let status = manager.snapshot();
  assert.equal(status.phase, "ready");
  assert.equal(status.url, "http://127.0.0.1:7897");
  assert.equal(status.source, "test");
  assert.equal(harness.state.installed, 1);

  await manager.dispose();
  assert.equal(harness.state.released, 1);
  assert.equal(harness.proxy.proxyRouteFor().proxied, false);
});

test("proxy off releases the route and reports disabled", async () => {
  const harness = fakeHarness(true);
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => ({ url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  await manager.configure({ proxy: "off" });
  const status = manager.snapshot();
  assert.equal(status.phase, "disabled");
  assert.equal(status.url, undefined);
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.installed, 1);
});

test("a newer configuration wins over an in-flight discovery", async () => {
  const harness = fakeHarness(true);
  let entered;
  const discoveryStarted = new Promise((resolve) => { entered = resolve; });
  let release;
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const slow = manager.configure({ proxy: "auto", retryMs: 0 });
  await discoveryStarted;
  const late = manager.configure({ proxy: "off" });
  release({ url: "http://127.0.0.1:7897", source: "stale" });
  await slow;
  await late;

  assert.equal(manager.snapshot().phase, "disabled");
  assert.equal(harness.state.installed, 0, "a stale discovery must not install anything");
});

test("an unreachable proxy retries then reports error", async () => {
  const harness = fakeHarness(true);
  let calls = 0;
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => { calls += 1; return undefined; },
  });

  await manager.configure({ proxy: "auto", retryMs: 1, maxRetries: 2, pollMs: 0 });
  const status = manager.snapshot();
  assert.equal(status.phase, "error");
  assert.equal(calls, 3, "one attempt plus maxRetries retries");
  assert.equal(status.message, "未找到可用的本地代理");
});

test("an unavailable harness is reported, never thrown", async () => {
  const manager = createManager({
    log: silent,
    loadHarness: async () => ({ ok: false, reason: "no modules" }),
    discover: async () => ({ url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  const status = manager.snapshot();
  assert.equal(status.phase, "unavailable");
  assert.equal(status.message, "no modules");
});

test("an existing host route is adopted instead of replaced", async () => {
  const harness = fakeHarness(true);
  harness.state.installed = 1;
  const manager = createManager({
    log: silent,
    loadHarness: async () => harness,
    discover: async () => ({ url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  const status = manager.snapshot();
  assert.equal(status.phase, "ready");
  assert.equal(status.source, "host");
  assert.equal(harness.state.installed, 1);
});

test("a failed harness load is retried instead of cached forever", async () => {
  const harness = fakeHarness(true);
  let loads = 0;
  const manager = createManager({
    log: silent,
    loadHarness: async () => {
      loads += 1;
      return loads >= 2 ? harness : { ok: false, reason: "transient" };
    },
    discover: async () => ({ url: "http://127.0.0.1:7897", source: "test" }),
  });

  await manager.configure({ proxy: "auto" });
  assert.equal(manager.snapshot().phase, "unavailable");
  assert.equal(loads, 1);

  // The next poll must try the import again rather than replaying the cached failure.
  await manager.redetect();
  assert.equal(loads, 2);
  assert.equal(manager.snapshot().phase, "ready");
  assert.equal(harness.state.installed, 1);
});
