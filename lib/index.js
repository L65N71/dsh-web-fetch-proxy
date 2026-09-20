/**
 * dsh-web-fetch-proxy - host half.
 *
 * WHY THIS EXISTS
 * ---------------
 * The harness's built-in web_fetch provider (@deepseek-ai/dsh-web-fetch-http)
 * has an SSRF guard: it resolves the target hostname itself and refuses the whole
 * answer set when any address is not globally routable unicast. A TUN-mode proxy
 * client (Clash Verge / Mihomo, sing-box, Surge) with DNS "fake-ip" answers every
 * name with a synthetic address, e.g.
 *
 *     raw.githubusercontent.com -> 28.0.0.250, fdfe:dcba:9876::ed
 *
 * The IPv6 answer lives in fc00::/7 (unique local), so ipaddr.js classifies it as
 * "uniqueLocal" instead of "unicast" and the fetch dies with
 *
 *     WEB_BLOCKED_URL URL hostname "..." resolves to a non-public IP address
 *
 * The provider already knows the way out: when @deepseek-ai/dsh-http-proxy reports
 * a proxied route for the URL, the provider tunnels through that route and lets the
 * proxy resolve the hostname, skipping the local DNS check entirely. That route only
 * exists when the harness was launched with HTTP(S)_PROXY set.
 *
 * This plugin closes that gap. It installs that route itself, and exposes the
 * choice on a settings page (设置 -> 常规 -> Web Fetch 代理):
 *
 *   - a "web-fetch-proxy" settings namespace, applied live, so mode / URL /
 *     bypass-list changes take effect without a restart;
 *   - POST /web-fetch-proxy/api, which reports the live route status and can
 *     re-run discovery on demand.
 *
 * LOCAL PATCH (see PATCH.md)
 * -------------------------
 * Two changes over the upstream release, both about *when* the route should exist:
 *
 *   1. GATE — implicit discovery only runs while the Windows system proxy or Clash
 *      TUN mode is switched on (`trigger: "toggles"`, the new default). Upstream
 *      discovered any reachable local proxy, so a running Clash core with both
 *      switches off was still treated as "proxy wanted".
 *   2. POLL — the whole decision is re-run every `pollMs` (default 5s), so toggling
 *      Clash on or off takes effect within one interval instead of requiring a
 *      restart or a manual "重新检测". Upstream decided once, at boot.
 *
 * SAFETY
 * ------
 * The plugin is deliberately fail-open. It never throws during module evaluation,
 * never throws from apply(), never overrides an existing route, and only installs a
 * policy for a proxy that currently accepts a TCP connection. Every harness package
 * it needs is loaded through a guarded resolver instead of a static import, so a
 * harness layout change degrades the settings page rather than the boot.
 *
 * @module dsh-web-fetch-proxy
 */
import { normalizeProxyUrl } from "./detect.js";
import { requireHarnessModule, resolutionAnchors } from "./harness.js";
import { createManager, isProxyDisabled, normalizeConfig } from "./manager.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-fetch-proxy";

/** Settings namespace backing the configuration page. */
export const SETTINGS_NAMESPACE = "web-fetch-proxy";

/** Host route the configuration page reads the live status from. */
export const STATUS_PATH = "/web-fetch-proxy/api";

/** Package that supplies the settings schema builder. */
const SCHEMA_PACKAGE = "@deepseek-ai/schemastery";

/** Largest status request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Normalize the cordis config object; every field is optional. */
export function resolveConfig(raw) {
  return normalizeConfig(raw);
}

/** A logger that never throws and works with or without a cordis context. */
export function makeLogger(ctx) {
  const logger = ctx !== null && typeof ctx === "object" ? ctx.logger : undefined;
  return function log(level, message) {
    const line = "[" + name + "] " + message;
    try {
      if (logger !== undefined && logger !== null && typeof logger[level] === "function") {
        logger[level](line);
        return;
      }
      if (level === "warn" || level === "error") console.warn(line);
      else console.log(line);
    } catch {
      /* logging must never break the boot */
    }
  };
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Trigger values the host understands. */
export const TRIGGER_VALUES = ["toggles", "reachable"];

/**
 * Reject a stored value the host cannot act on. Runs on every settings write,
 * before anything is persisted.
 */
export function validateSettings(value) {
  const source = value !== null && typeof value === "object" ? value : {};
  const proxy = typeof source.proxy === "string" ? source.proxy.trim() : "auto";
  if (proxy !== "" && proxy.toLowerCase() !== "auto" && !isProxyDisabled(proxy) && normalizeProxyUrl(proxy) === undefined) {
    throw new Error("代理地址必须是 http:// 或 https:// URL（或 host:port 简写）");
  }
  const trigger = typeof source.trigger === "string" ? source.trigger.trim().toLowerCase() : "";
  if (trigger !== "" && TRIGGER_VALUES.indexOf(trigger) < 0) {
    throw new Error("trigger 只能是 toggles（跟随系统代理 / TUN 开关）或 reachable（代理可达即启用）");
  }
}

/** Build the settings schema, or undefined when schemastery is unavailable. */
function buildSettingsSchema(z, log) {
  try {
    return z.object({
      proxy: z.string().default("auto").description("auto | off | http(s)://host:port"),
      noProxy: z.string().default("").description("comma separated bypass list"),
      trigger: z.string().default("toggles").description("toggles | reachable"),
    });
  } catch (error) {
    log("warn", "构造 settings schema 失败：" + describe(error));
    return undefined;
  }
}

/** Whether one request may reach the plugin's own host route. */
function isTrustedRequest(req, ctx) {
  const headers = req !== null && typeof req === "object" && req.headers !== null && typeof req.headers === "object" ? req.headers : {};
  const host = typeof headers.host === "string" ? headers.host : "";
  if (host === "") return false;

  let hostname;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch (error) {
    return false;
  }

  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!loopback) {
    const runtime = ctx !== null && typeof ctx === "object" ? ctx.webRuntime : undefined;
    const trusted = runtime !== null && runtime !== undefined && Array.isArray(runtime.trustedHosts) ? runtime.trustedHosts : [];
    const accepted = trusted.some(function (entry) {
      const text = String(entry);
      try {
        return new URL(text.indexOf("//") >= 0 ? text : "http://" + text).hostname === hostname;
      } catch (error) {
        return false;
      }
    });
    if (!accepted) return false;
  }

  if (headers["sec-fetch-site"] === "cross-site") return false;
  const origin = headers.origin;
  if (typeof origin !== "string") return true;
  try {
    return new URL(origin).hostname === hostname;
  } catch (error) {
    return false;
  }
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let total = 0;
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", function () {
      resolve(undefined);
    });
  });
}

function sendJson(res, statusCode, payload) {
  try {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    try {
      res.end();
    } catch (inner) {
      /* the caller is already gone */
    }
  }
}

/** The status / redetect endpoint the configuration page talks to. */
function createStatusHandler(ctx, manager, log) {
  return async function handler(req, res) {
    if (!isTrustedRequest(req, ctx)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed" } });
      return;
    }

    const raw = await readBody(req);
    let action = "status";
    if (typeof raw === "string" && raw !== "") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && typeof parsed.action === "string") action = parsed.action;
      } catch (error) {
        /* an unparseable body means "status" */
      }
    }

    if (action === "redetect") {
      try {
        await manager.redetect();
      } catch (error) {
        log("warn", "重新检测失败：" + describe(error));
      }
    }
    sendJson(res, 200, { ok: true, value: manager.snapshot() });
  };
}

/**
 * Cordis entry point.
 *
 * Wires three things, each guarded so a missing service only degrades the
 * settings page: the route manager, the live settings namespace, and the status
 * route. Returns synchronously and never throws.
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const base = normalizeConfig(config);
  const manager = createManager({ log });

  let pollTimer;
  let polling = false;

  /**
   * Re-evaluate the route on a timer. This is what makes flipping the Clash system
   * proxy or TUN switch take effect without restarting DSH: every tick releases the
   * installed route and re-runs discovery, so losing the proxy falls back to a direct
   * web_fetch (local DNS check, real addresses) and regaining it re-installs the tunnel.
   */
  function startPolling() {
    if (!(base.pollMs > 0)) return;
    try {
      pollTimer = setInterval(function () {
        if (polling) return;
        polling = true;
        Promise.resolve(manager.redetect()).then(
          function () { polling = false; },
          function () { polling = false; },
        );
      }, base.pollMs);
      // Never hold the event loop open on the plugin's account.
      if (pollTimer !== null && typeof pollTimer.unref === "function") pollTimer.unref();
    } catch (error) {
      log("warn", "启动轮询失败：" + describe(error));
    }
  }

  function stopPolling() {
    if (pollTimer === undefined) return;
    try {
      clearInterval(pollTimer);
    } catch (error) {
      /* clearing a timer has no failure worth reporting */
    }
    pollTimer = undefined;
  }

  if (ctx !== null && typeof ctx === "object" && typeof ctx.effect === "function") {
    try {
      ctx.effect(function () {
        return function () {
          stopPolling();
          void manager.dispose();
        };
      }, name + ": proxy route");
    } catch (error) {
      log("warn", "注册生命周期清理失败：" + describe(error));
    }
  }

  const anchors = resolutionAnchors(process.env);
  let settingsApplied = false;

  /** Apply a settings value on top of the deployment config. */
  function applySettings(value) {
    settingsApplied = true;
    const fromSettings = value !== null && typeof value === "object" ? value : {};
    return manager.configure({
      enabled: base.enabled,
      proxy: typeof fromSettings.proxy === "string" ? fromSettings.proxy : base.proxy,
      noProxy: typeof fromSettings.noProxy === "string" ? fromSettings.noProxy : base.noProxy,
      trigger: typeof fromSettings.trigger === "string" ? fromSettings.trigger : base.trigger,
      pollMs: base.pollMs,
      retryMs: base.retryMs,
      maxRetries: base.maxRetries,
      probeTimeoutMs: base.probeTimeoutMs,
    });
  }

  if (ctx !== null && typeof ctx === "object" && typeof ctx.inject === "function") {
    try {
      ctx.inject(["settings"], function (settingsCtx) {
        try {
          const z = requireHarnessModule(SCHEMA_PACKAGE, anchors);
          if (z === undefined || typeof z.object !== "function") {
            log("warn", "无法加载 " + SCHEMA_PACKAGE + "，配置页面不可用（插件仍按 cordis config 运行）。");
            return;
          }
          const schema = buildSettingsSchema(z, log);
          if (schema === undefined) return;
          const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, schema, {
            applies: "live",
            base: { proxy: base.proxy, noProxy: base.noProxy },
            validate: validateSettings,
          });
          void applySettings(scope.get());
          settingsCtx.effect(function () {
            return scope.watch(function (next) {
              void applySettings(next);
            });
          }, name + ": live settings");
        } catch (error) {
          log("warn", "配置页面初始化失败：" + describe(error));
        }
      });
    } catch (error) {
      log("warn", "注入 settings 服务失败：" + describe(error));
    }

    try {
      ctx.inject(["webServer"], function (serverCtx) {
        try {
          const handler = createStatusHandler(serverCtx, manager, log);
          serverCtx.effect(function () {
            return serverCtx.webServer.register({ kind: "exact", path: STATUS_PATH, handler });
          }, name + ": status route");
        } catch (error) {
          log("warn", "状态接口注册失败：" + describe(error));
        }
      });
    } catch (error) {
      log("warn", "注入 webServer 服务失败：" + describe(error));
    }
  }

  if (settingsApplied !== true) void manager.configure(base);
  startPolling();
  return undefined;
}

/**
 * Awaited variant used by the tests and by tooling that wants the outcome.
 * @returns the settled status plus the disposer that drops the route.
 */
export async function start(ctx, config) {
  const log = makeLogger(ctx);
  const manager = createManager({ log });
  await manager.configure(normalizeConfig(config));
  const snapshot = manager.snapshot();
  return {
    installed: snapshot.phase === "ready",
    url: snapshot.url,
    source: snapshot.source,
    phase: snapshot.phase,
    manager,
    dispose: function () {
      return manager.dispose();
    },
  };
}
