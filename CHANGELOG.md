# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式。

## [0.3.0] - 2026-09-20

基于上游 v0.2.0 的 Fork（MIT，© Tong317）。完整说明见 [PATCH.md](./PATCH.md)。

### 新增

- **代理闸门 `trigger`**（默认 `toggles`）：隐式发现只在 Windows 系统代理或 Clash TUN
  开启时才运行。上游只要探测到可达的本地代理端口就启用，导致 Clash 内核在跑、
  但两个开关都关着时依然会走代理。`trigger: "reachable"` 保留上游行为。
- **轮询 `pollMs`**（默认 5000）：每 N 毫秒重新评估整条决策（先释放旧路由、再重新发现），
  开关切换无需重启。`0` 关闭轮询，退回上游的一次性决策。
- **`verge.yaml` 优先的 TUN 探测**：Clash Verge 切换 TUN 时 UI 开关立即更新，
  而生成的 `config.yaml` 可能仍是陈旧的 `tun.enable: false`。两遍扫描让 UI 开关优先。
- **加载失败诊断**：`importHarnessModule` 接受 `diagnostics` 数组，逐候选记录真实的
  resolve / import 错误并拼进 `reason`；上游把错误整个吞掉，只报一个裸的 `cannot import`。
- **`scripts/gate-check.mjs`**：只读诊断脚本，打印当前判定，不安装任何路由。

### 修复

- **缺少 `DSH_HOME` 时所有解析锚点失效**。宿主进程不把自己的 `DSH_HOME` 导出到
  `process.env`（只注入给派生的 shell），因此上游那两个最强锚点从未被构造出来，
  在部分安装布局下报 `cannot import @deepseek-ai/dsh-http-proxy`。
  现增加 `~/.dsh`（`os.homedir()`）与 `NODE_PATH + @deepseek-ai/dsh/node_modules` 两条回退。
- **`import()` 失败后回退 `require()`**：Node ≥ 22.12 的 `require()` 同样能加载 ESM，
  且走不同的加载路径。已实测 `require()` 与 `import()` 返回**同一命名空间对象**与同一函数引用，
  通过 `require()` 安装的策略在 `import` 侧可见，因此不会造成"策略装在副本上"的静默失效。
- **加载失败不再永久缓存**：上游一旦失败就缓存到底，导致整个进程生命周期内不再重试。
  现只缓存成功结果，轮询每次都会重试，启动期的瞬时失败可在 5 秒内自愈。

### 变更

- 轮询开启（`pollMs > 0`）时禁用上游的 `retryMs × maxRetries` burst 重试循环：
  单次 reconcile 只探测一次，**轮询本身就是重试**，
  避免一次慢探测占满队列、饿死后续轮询。
- 闸门关闭记为 `phase: "idle"`（而非 `error`），并带出明确原因。
- 测试从 33 个增加到 47 个：开关解析、陈旧配置优先级、闸门开关、轮询语义、
  加载诊断与失败重试、锚点回退。

## [0.2.0] - 2026-09-17

### 新增

- **配置页面**：注册 `web-fetch-proxy` settings 命名空间（`applies: live`），在
  **设置 → 常规** 里提供「自动检测 / 手动代理 / 关闭」、代理地址、绕过列表与实时状态行，
  改动立即生效，无需重启。
- **状态接口**：`POST /web-fetch-proxy/api`，带同源围栏（仅接受 loopback / 受信 Host），
  返回当前路由、来源与失败原因，并支持 `redetect` 重新探测。
- **路由生命周期管理器**（`lib/manager.js`）：代际保护（慢探测不会覆盖更新的配置）、
  可唤醒的重试等待、路由释放与状态快照。

### 变更

- 插件现在声明 `dsh.client`，宿主据此加载设置页（`exports["./client"]`）。
- 宿主包解析新增同步入口 `requireHarnessModule`，用于在 cordis inject 回调内加载 settings schema。

## [0.1.0] - 2026-09-17

### 新增

- 自动发现本地 HTTP 代理：显式配置 → 环境变量 → Clash/Mihomo 配置的
  mixed-port → Windows WinINET 系统代理 → 常见端口 TCP 探测。
- 通过 @deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment() 安装宿主
  级代理策略，使 @deepseek-ai/dsh-web-fetch-http 走 proxied 路由，跳过本地
  DNS 校验。
- 宿主模块解析锚定在 harness 目录树内，支持从 harness 树外以 link: 方式安装。
- 探测失败时按 retryMs / maxRetries 重试，代理客户端晚启动也能自愈。
- 全部失败路径 fail-open：不抛错、不覆盖已有路由、代理不可达则不安装。
