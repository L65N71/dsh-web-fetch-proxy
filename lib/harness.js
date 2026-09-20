/**
 * Host-side access to the harness's own network modules.
 *
 * dsh-web-fetch-http decides between "tunnel through the proxy" and "resolve the
 * hostname locally and check it is public" by asking
 * @deepseek-ai/dsh-http-proxy for its process-wide policy. Installing a policy
 * therefore only works when this plugin reaches the *same module instance* the
 * running web-fetch provider uses.
 *
 * A plugin installed with "link:" from outside the harness tree cannot resolve
 * the harness's private packages by bare specifier, so every candidate anchor
 * inside the harness tree is tried first. Node de-duplicates ES modules by real
 * path, so any anchor that resolves through the harness's own node_modules
 * yields the identical instance (see the identity check in the README).
 *
 * @module dsh-web-fetch-proxy/harness
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The package that owns the process-wide outbound proxy policy. */
export const PROXY_PACKAGE = "@deepseek-ai/dsh-http-proxy";

/** The package that models the launch environment the policy is resolved from. */
export const LAUNCH_PACKAGE = "@deepseek-ai/dsh-launch-environment";

/** The two anchor positions a harness home contributes. */
function pushHomeAnchors(anchors, home) {
  anchors.push(path.join(home, "profiles", "resolve-anchor.js"));
  anchors.push(path.join(home, "profiles", "web", "resolve-anchor.js"));
}

/**
 * Anchor files whose node_modules ancestry reaches the harness's own packages.
 * The files never have to exist; only their directory is used for resolution.
 *
 * Three sources, because no single one covers every install:
 *
 *   1. `DSH_HOME` — exact, but the host does NOT export it to its own process; it is
 *      only injected into the shells it spawns. Reading it here therefore usually
 *      fails and the fallbacks below are what actually resolve.
 *   2. `~/.dsh` — the default harness home, used when (1) is absent.
 *   3. `NODE_PATH` — a global or npx install keeps every harness package nested
 *      inside `@deepseek-ai/dsh/node_modules`, which no NODE_PATH entry reaches
 *      directly; this points at that nested directory explicitly.
 */
export function resolutionAnchors(env) {
  const source = env === null || typeof env !== "object" ? process.env : env;
  const anchors = [];
  const home = source.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") {
    pushHomeAnchors(anchors, home);
  }
  try {
    pushHomeAnchors(anchors, path.join(os.homedir(), ".dsh"));
  } catch {
    /* an unresolvable home directory is not fatal */
  }
  const nodePath = typeof source.NODE_PATH === "string" && source.NODE_PATH !== "" ? source.NODE_PATH : process.env.NODE_PATH;
  if (typeof nodePath === "string" && nodePath !== "") {
    for (const dir of nodePath.split(path.delimiter)) {
      if (dir.trim() === "") continue;
      anchors.push(path.join(dir, "@deepseek-ai", "dsh", "node_modules", "resolve-anchor.js"));
    }
  }
  const appData = source.APPDATA;
  if (typeof appData === "string" && appData.trim() !== "") {
    anchors.push(path.join(appData, "dsh-desktop", "harness", "profiles", "web", "resolve-anchor.js"));
  }
  if (typeof process.execPath === "string" && process.execPath !== "") {
    anchors.push(path.join(path.dirname(process.execPath), "resources", "app", "resolve-anchor.js"));
  }
  const localAppData = source.LOCALAPPDATA;
  if (typeof localAppData === "string" && localAppData.trim() !== "") {
    anchors.push(path.join(localAppData, "Programs", "DSH Desktop", "resources", "app", "resolve-anchor.js"));
  }
  try {
    anchors.push(path.join(process.cwd(), "resolve-anchor.js"));
  } catch {
    /* an unavailable cwd is not fatal: the anchored attempts above still run */
  }
  return anchors;
}

/** Describe a thrown value without leaking a stack into a status line. */
function describeError(error) {
  if (error === null || error === undefined) return String(error);
  const code = typeof error.code === "string" ? error.code + ": " : "";
  return code + (error instanceof Error ? error.message : String(error));
}

/**
 * Load one already-resolved path.
 *
 * `import()` runs first so the module-identity guarantee holds — the host reached
 * this package through the same real path, and Node de-duplicates by real path.
 * `require()` is the fallback: on Node >= 22.12 it loads ESM too, and it takes a
 * different route through the loader, which recovers when a host has installed an
 * ESM loader hook that rejects a bare file URL.
 *
 * @param resolved - absolute path to the module entry.
 * @param diagnostics - collects one line per failed strategy.
 * @returns the module namespace, or undefined when both strategies failed.
 */
async function loadResolved(resolved, diagnostics) {
  const href = pathToFileURL(resolved).href;
  try {
    return await import(href);
  } catch (error) {
    diagnostics.push("import " + href + " -> " + describeError(error));
  }
  try {
    return createRequire(import.meta.url)(resolved);
  } catch (error) {
    diagnostics.push("require " + href + " -> " + describeError(error));
  }
  return undefined;
}

/**
 * Import a harness package, preferring resolution anchored inside the harness tree.
 * @param diagnostics - optional array collecting why each candidate failed, so a
 *   caller can surface a real reason instead of a bare "cannot import".
 * @returns the module namespace, or undefined when nothing resolved or evaluated.
 */
export async function importHarnessModule(specifier, anchors, diagnostics) {
  const notes = Array.isArray(diagnostics) ? diagnostics : [];
  for (const anchor of anchors) {
    let resolved;
    try {
      resolved = createRequire(anchor).resolve(specifier);
    } catch (error) {
      notes.push("resolve " + specifier + " from " + anchor + " -> " + describeError(error));
      continue;
    }
    const loaded = await loadResolved(resolved, notes);
    if (loaded !== undefined) return loaded;
  }
  try {
    return await import(specifier);
  } catch (error) {
    notes.push("bare import " + specifier + " -> " + describeError(error));
    return undefined;
  }
}

/**
 * Require a harness package synchronously through the same anchors.
 *
 * Only for packages that publish a CommonJS build through their exports map
 * (@deepseek-ai/schemastery does: `require` -> lib/index.cjs). Settings
 * registration happens inside a synchronous cordis inject callback, so the
 * schema module has to resolve without awaiting.
 *
 * @param specifier - the package name to require.
 * @param anchors - resolution anchors, as built by {@link resolutionAnchors}.
 * @returns the required exports, or undefined when no anchor resolved it.
 */
export function requireHarnessModule(specifier, anchors) {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier);
    } catch {
      /* try the next anchor */
    }
  }
  try {
    return createRequire(import.meta.url)(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Minimal launch-environment stand-in, used only when the real helper is absent.
 * It implements the single method dsh-http-proxy reads: get(name) -> { value }.
 */
export function fallbackEnvironment(layers) {
  const values = new Map();
  const list = Array.isArray(layers) ? layers : [];
  for (const layer of list) {
    const entries = layer !== null && typeof layer === "object" && layer.values !== null && typeof layer.values === "object"
      ? Object.entries(layer.values)
      : [];
    for (const [key, value] of entries) {
      const envName = process.platform === "win32" ? key.toUpperCase() : key;
      if (!values.has(envName)) values.set(envName, value);
    }
  }
  return {
    get(name) {
      const envName = process.platform === "win32" ? String(name).toUpperCase() : String(name);
      return values.has(envName) ? { value: String(values.get(envName)), source: "process" } : undefined;
    },
  };
}

/**
 * Load everything the plugin needs from the host.
 * @returns { ok: true, proxy, createSnapshot } or { ok: false, reason }.
 */
export async function loadHarness(env) {
  const anchors = resolutionAnchors(env);
  const diagnostics = [];
  const proxy = await importHarnessModule(PROXY_PACKAGE, anchors, diagnostics);
  if (proxy === undefined) {
    // Surface the first few real failures: a bare "cannot import" is undebuggable
    // from the settings page, and this is the one failure that disables the plugin.
    const detail = diagnostics.slice(0, 3).join(" | ");
    return { ok: false, reason: "cannot import " + PROXY_PACKAGE + (detail === "" ? "" : " [" + detail + "]") };
  }
  if (typeof proxy.installProxyFromEnvironment !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export installProxyFromEnvironment" };
  }
  if (typeof proxy.proxyRouteFor !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export proxyRouteFor" };
  }
  const launch = await importHarnessModule(LAUNCH_PACKAGE, anchors);
  const createSnapshot = launch !== undefined && typeof launch.createLaunchEnvironmentSnapshot === "function"
    ? launch.createLaunchEnvironmentSnapshot
    : fallbackEnvironment;
  return { ok: true, proxy, createSnapshot };
}
