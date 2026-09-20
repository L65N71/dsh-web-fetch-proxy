# dsh-web-fetch-proxy

> DSH 插件：让内置 `web_fetch` 经由本地代理出网，绕过 TUN 模式下 fake-ip 假地址被 SSRF 防护拦截的问题。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

---

## ⚠️ 本仓库是 Fork，行为与上游不同

基于 [1499501762/dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) v0.2.0（MIT，© Tong317）修改。

上游在**启动时决定一次**"是否走代理"，且判断依据是"本机有没有可达的代理端口"。
本 Fork 改了两件事，让开关切换**实时生效**、并且**尊重代理客户端自己的开关**：

| | 上游 v0.2.0 | 本 Fork v0.3.0 |
|---|---|---|
| 判定时机 | 启动时一次 | **每 `pollMs`（默认 5 秒）重新判定** |
| 判定依据 | 代理端口可达即启用 | **只在 Windows 系统代理或 Clash TUN 开着时才启用**（`trigger` 可切回上游行为） |
| Clash 关掉后 | 保留死路由 → `web_fetch` 全部失败 | **自动释放路由 → 回退直连** |
| 需要重启？ | 切换后需要手动「重新检测」 | **不需要** |

此外修复了一个上游未暴露的故障：上游从 `env.DSH_HOME` 构造宿主模块解析锚点，
而**宿主进程自己的 `process.env` 里没有 `DSH_HOME`**（它只注入给派生的 shell），
导致插件在部分安装布局下报 `cannot import @deepseek-ai/dsh-http-proxy`。
本 Fork 增加了 `~/.dsh` 与 `NODE_PATH` 两条回退锚点。

**完整改动说明、行为矩阵、实测记录见 [`PATCH.md`](./PATCH.md)。**
`trigger: "reachable"` + `pollMs: 0` 可退回上游语义。

安装（本 Fork）：

```sh
dsh plugin --profile web add github:L65N71/dsh-web-fetch-proxy
```

---

## 症状

在开着 TUN 模式代理（Clash Verge / Mihomo、sing-box、Surge 等）的 Windows 上，DSH 的 `web_fetch` 对所有域名都失败，
报错形如：

```
### https://raw.githubusercontent.com/... -> ERROR URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

关键点是：**DNS 解析成功了**。失败的原因不是解析不了，而是解析出来的地址被判定为**非公网地址**从而被主动拦截。

## 根因

### 1. TUN + fake-ip 会返回假地址

Clash Verge Rev 的运行时配置（`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml`）里：

```yaml
mixed-port: 7897
tun:
  enable: true
  dns-hijack: [any:53]
```

而它的 DNS 覆盖层设置了 fake-ip：

```yaml
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 28.0.0.1/8
  fake-ip-range6: fdfe:dcba:9876::1/64
```

于是系统 DNS 被 53 端口劫持后，任何域名都会得到伪造地址：

```
raw.githubusercontent.com  A     28.0.0.250
raw.githubusercontent.com  AAAA  fdfe:dcba:9876::ed
DNS 服务器地址:                  fdfe:dcba:9876::2
```

这是 fake-ip 模式的正常行为：故意返回假 IP，才能在 TLS 之前按域名分流。

### 2. web_fetch 的 SSRF 防护会拒绝这类地址

`@deepseek-ai/dsh-web-fetch-http` 在建立连接之前先自己解析域名，并逐条校验：

```js
// node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js
const resolved = await resolver(hostname, { all: true, order: "verbatim" });
for (const entry of resolved) {
  if (!isPublicIpAddress(entry.address))
    throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");
}
```

`isPublicIpAddress` 用 `ipaddr.js` 判定，实测结果：

```
28.0.0.250           ipv4  unicast      通过
fdfe:dcba:9876::ed   ipv6  uniqueLocal  拒绝   <- fc00::/7，不是公网单播
```

因为查询用的是 `all: true`（同时拿 A 和 AAAA），而循环是「只要有一条不合格就整体拒绝」（防 DNS rebinding），
所以只要有 AAAA 记录（现在几乎所有站点都有），请求就必然失败——连接从未发出。

### 3. 为什么普通代理插件救不了

`web_fetch` 是否走代理，取决于 `@deepseek-ai/dsh-http-proxy` 的进程级策略：

```js
// dsh-web-fetch-http/lib/index.js:501
const route = proxyRouteFor(url);
if (route.proxied && !isNonPublicIpLiteral(url.hostname))
  return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);
// 否则：本地解析 + 公网校验
```

这条 `route` 只由 `installProxyFromEnvironment()` 在**启动时从环境变量**解析并安装。
插件（例如 `dsh-network-proxy`）即使用 `undici.setGlobalDispatcher()` 接管了全局 Dispatcher，
`dsh-http-proxy` 内部的 `active` 策略仍然是空的，`proxyRouteFor()` 依旧返回 `{ proxied: false }`，
`web_fetch` 还是走本地 DNS 校验。

实测（本仓库 `npm run verify` 的对照输出）：

```
route before  : direct (local DNS check applies)
fetch before  : WEB_BLOCKED_URL URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

## 这个插件做什么

启动时在宿主进程内：

1. 找到当前可用的本地 HTTP 代理（见下方发现顺序）；
2. 用一份合成的 launch environment 调用 `@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment()`，
   为整个进程安装一条 proxied 策略；
3. 校验 `proxyRouteFor()` 确实变为 `proxied: true`，否则立刻回滚。

于是 `web_fetch` 走代理隧道，由代理侧解析域名，**跳过本地 DNS 校验**：

```
route after   : proxied via http://127.0.0.1:7897
fetch after   : ok, 200, 1046 chars
```

全程不需要重启时环境变量，也不需要改动代理客户端。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:L65N71/dsh-web-fetch-proxy
```

本仓库已提交**预构建的 `lib/`**，且 `package.json` 里没有 `prepare` 脚本，
因此 pnpm 不会触发构建，**不需要** `allowBuilds` 授权。

### 本地目录（开发 / 私有插件）

```bash
git clone https://github.com/L65N71/dsh-web-fetch-proxy.git
dsh plugin --profile web add link:<仓库绝对路径>
```

> ⚠️ `link:` 装法只在 profile 的 `node_modules` 里建一个 **Junction 指向源目录，不复制文件**。
> 源目录一旦被删或移动，链接就悬空，插件下次启动加载不到。想删源目录请改用下面的 tarball 方式。

### 本地 tarball（离线 / 内部分发）

```bash
cd <仓库目录>
pnpm pack                                          # 产出 dsh-web-fetch-proxy-0.3.0.tgz
dsh plugin --profile web add <tgz 绝对路径>
```

tarball 会被**解包进 profile 自己的 `node_modules\.pnpm\`**，源目录随后可以删。
删之前请确认它真的自包含了：

```powershell
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-web-fetch-proxy" | Select-Object LinkType,Target
# 期望 Target 指向 ...\node_modules\.pnpm\...，而不是你的源目录
```

### 安装后

**重启 `dsh web`**（首次装载必须重启；之后所有开关切换都不需要）。
启动日志里出现下面这行就说明生效了：

```
[web-fetch-proxy] web_fetch 现在经由 http://127.0.0.1:7897 出网（来源：clash-config:...）；本地 DNS 校验已被代理路由跳过。
```

若当时两个开关都关着，则会是：

```
[web-fetch-proxy] Windows 系统代理与 Clash TUN 均为关闭状态，web_fetch 保持直连。
```

> 注意：本插件的 `cordis.patch.yml` 已经声明了插入行，`dsh plugin add` 会把它写进 profile 的 bundles。
> 如果你的 profile 是手动维护的，也可以自己在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里加：
>
> ```yaml
> - insert:
>     - id: web-fetch-proxy
>       name: dsh-web-fetch-proxy
> ```

## 快速开始（默认配置即可用）

装完重启就完事了，**不需要任何配置**。默认行为是：

| 你的操作 | 插件行为 | 生效延迟 |
|---|---|---|
| 开着系统代理或 TUN | `web_fetch` 走代理（`phase: ready`） | ≤ 5 秒 |
| 关掉两个开关（Clash 内核还在跑） | `web_fetch` 直连（`phase: idle`） | ≤ 5 秒 |
| 完全退出 Clash | `web_fetch` 直连（无路由） | ≤ 5 秒 |

切换开关**不需要重启 DSH**，也不需要点「重新检测」——插件每 5 秒自己重新判定一次。

## 配置页面

重启 DSH 后，**设置 → 常规** 里会出现「Web Fetch 代理」一栏：

| 控件 | 作用 |
| --- | --- |
| 自动检测 / 手动代理 / 关闭 | 写 `web-fetch-proxy` settings 命名空间的 `proxy` 字段，**立即生效**，无需重启 |
| 代理地址输入框 | 手动模式下填 `http://127.0.0.1:7897` 或 `127.0.0.1:7897`；主机端会校验，非法地址在保存前就被拒绝 |
| 绕过列表 | 追加 `noProxy` 条目；`localhost`、`127.0.0.1`、`::1` 由 dsh-http-proxy 强制绕过 |
| 状态行 / 重新检测 | 读宿主实时状态（当前路由、来源、失败原因），并可按需重新探测一次 |

状态行显示的是宿主真正生效的结果，例如：

```
已生效  http://127.0.0.1:7897  (via: clash-config:%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml)
```

页面读的是一个带围栏的只读接口 `POST /web-fetch-proxy/api`（仅接受 loopback / 受信 Host、同源请求）：
请求体 `{"action":"status"}` 取状态，`{"action":"redetect"}` 触发一次重新探测。

**不需要开 GUI 也能查同一个接口**（不需要 GUI token）：

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3080/web-fetch-proxy/api' -Method POST `
  -Body '{"action":"status"}' -ContentType 'application/json' `
  -Headers @{Origin='http://127.0.0.1:3080'} -UseBasicParsing).Content
```

> ⚠️ **设置页只能改 `proxy` / `noProxy`。** 本 Fork 新增的 `trigger` 与 `pollMs`
> 属于部署级配置，页面没有暴露，只能写在 `cordis.patch.yml` 的 `config` 里（见下一节）。
> 需要临时强制走代理时，可以在页面上切到「手动代理」并填地址——显式地址会**绕过闸门**。

> 页面不需要「重启后生效」：设置走的是 `applies: live` 的 settings 命名空间，改动通过
> `scope.watch()` 直接驱动路由重建（旧的策略先释放，再按新配置重新探测安装）。

## 配置（cordis 层）

页面写的是同一份配置；`cordis.patch.yml` 的 `config` 提供**部署级基线与默认值**（settings 的 base 层），
页面上没有暴露的字段只能在这里改：

```yaml
- insert:
    - id: web-fetch-proxy
      name: dsh-web-fetch-proxy
      config:
        enabled: true        # false 则完全不介入
        proxy: auto          # auto | off | http://host:port | host:port
        noProxy: ''          # 额外的不走代理的域名，逗号分隔
        trigger: toggles     # toggles = 跟系统代理/TUN 开关 | reachable = 代理可达即启用（上游行为）
        pollMs: 5000         # 重新判定间隔（毫秒），0 = 关闭轮询
        retryMs: 15000       # 仅 pollMs: 0 时有意义
        maxRetries: 20       # 仅 pollMs: 0 时有意义
        probeTimeoutMs: 400  # 单个候选代理的 TCP 探测超时
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 部署级总开关；`false` 时插件不安装任何路由（页面无法覆盖） |
| `proxy` | string | `auto` | `auto` 自动发现；`off`/`none`/`direct` 不安装；也可以写死代理地址。**页面可改** |
| `noProxy` | string | `""` | 追加到绕过列表（`localhost`、`127.0.0.1`、`::1` 由 dsh-http-proxy 强制绕过）。**页面可改** |
| `trigger` | string | `toggles` | **本 Fork 新增。** `toggles` = 只有 Windows 系统代理或 Clash TUN 开着才走代理；`reachable` = 上游行为（本机有可达的代理端口就启用） |
| `pollMs` | number | `5000` | **本 Fork 新增。** 重新评估整条决策的间隔（毫秒）。`0` = 关闭轮询，退回上游的"启动时决定一次" |
| `retryMs` | number | `15000` | 自动发现失败后的重试间隔。**仅在 `pollMs: 0` 时生效**——轮询开启时由轮询承担重试 |
| `maxRetries` | number | `20` | 重试上限（约 5 分钟）。同样**仅在 `pollMs: 0` 时生效** |
| `probeTimeoutMs` | number | `400` | 候选代理的 TCP 连接超时 |

也可以直接用**环境变量**指定代理地址（优先级高于自动发现，且**绕过闸门**）：

```bash
set DSH_WEB_FETCH_PROXY=http://127.0.0.1:7897
```

### 三种典型配置

```yaml
# ① 默认（推荐）：实时跟随开关，关掉 Clash 自动直连
trigger: toggles
pollMs: 5000

# ② 退回上游行为：只要有代理端口就启用，启动时决定一次
trigger: reachable
pollMs: 0
retryMs: 15000
maxRetries: 20

# ③ 写死代理、永不自动切换（配合页面上选「手动代理」使用）
proxy: 'http://127.0.0.1:7897'
trigger: reachable
pollMs: 0
```

## 代理发现顺序

`proxy: auto` 时按以下顺序找第一个**当前能建立 TCP 连接**的候选：

1. `DSH_WEB_FETCH_PROXY` 环境变量；
2. `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy`；

   > **↑ 1–2 视为用户明确意图，绕过闸门。以下 3–5 属于"隐式发现"，只有闸门打开时才执行。**

3. 本地 Clash / Mihomo / Clash Verge 配置里的 `mixed-port`
   （`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml` 等 8 个已知路径）；
4. Windows WinINET 系统代理（`HKCU\...\Internet Settings`，即系统代理开关打开时的设置）；
5. 常见端口 TCP 探测：7897、7890、7891、7899、10809、10808、1080、2080、20171、8889。

任何候选都必须先通过 TCP 探测，避免把路由指向一个没在运行的代理。

### 闸门（`trigger: toggles`）

执行 3–5 之前先判断：**Windows 系统代理已开启，或 Clash TUN 已开启**？

- 是 → 继续发现并安装路由；
- 否 → 直接返回"保持直连"，**不安装任何路由**（`phase: idle`）。

TUN 状态的读法有两遍：先在所有已知配置文件里找 Clash Verge 的 UI 开关
（`verge.yaml` → `enable_tun_mode`），找不到才回退到生成的运行时段
（`config.yaml` → `tun.enable`）。**UI 开关优先**，因为它立即更新，
而 `config.yaml` 在切换 TUN 后可能仍是陈旧的 `tun.enable: false`。

### 行为矩阵

| Clash 状态 | 判定依据 | `phase` | `web_fetch` |
|---|---|---|---|
| 完全退出 | 端口探测失败 | `error` | 直连 |
| 系统代理 开 | WinINET `ProxyEnable=1` | `ready` | 走代理 |
| TUN 开 | `verge.yaml` 的 `enable_tun_mode` | `ready` | 走代理 |
| 两个都关（内核仍在跑） | 闸门关闭 | `idle` | **直连** |
| 页面上填了「手动代理」地址 | 显式意图，绕过闸门 | `ready` | 走代理 |
| 设置了 `HTTPS_PROXY` 等环境变量 | 显式意图，绕过闸门 | `ready` | 走代理 |

## 排查

**第一步永远是看状态接口**（命令见「配置页面」一节）。`phase` 的含义：

| `phase` | 含义 | 怎么办 |
|---|---|---|
| `ready` | 路由已装好 | 正常。看 `url` / `source` 确认地址 |
| `idle` | 系统代理与 TUN 都没开，按设计保持直连 | 正常。要用代理就开其中一个开关 |
| `error` | 开关开了，但找不到可达的本地代理 | 确认代理客户端在跑、端口对得上；或在页面上切「手动代理」填地址 |
| `unavailable` | **加载宿主模块失败**，插件完全没生效 | `message` 里现在带真实错误。常见是 DSH 安装布局变化，见下 |
| `disabled` | 配置为关闭（`enabled: false` 或 `proxy: off`） | 正常 |

**`unavailable` 的典型原因**：宿主进程的 `process.env` 里**没有 `DSH_HOME`**
（它只被注入给派生的 shell），而上游只从 `DSH_HOME` 构造解析锚点。
本 Fork 已增加 `~/.dsh` 与 `NODE_PATH` 两条回退，正常安装布局下不会再出现。
若仍出现，把 `message` 里的完整错误贴出来——它会指明是哪个锚点、什么错误码。

**只读诊断**（不安装任何路由，可随时运行）：

```powershell
cd <仓库目录>
node scripts/gate-check.mjs
```

它会打印找到哪些 Clash 配置文件、两个开关各是什么、以及当前判定。

## 与 dsh-network-proxy 的关系

`dsh-network-proxy` 管的是**全局 undici Dispatcher**（跟随系统 / 手动 / 直连），它能让普通 `fetch` 走代理，
但它没有触及 `@deepseek-ai/dsh-http-proxy` 的策略，所以 `web_fetch` 不受其影响。

**两者不冲突。** 把两个插件装进同一个进程实测的结果：

| 场景 | `proxyRouteFor()` | `web_fetch` |
| --- | --- | --- |
| 只装 `dsh-network-proxy`（直连模式） | DIRECT | 失败 `WEB_BLOCKED_URL` |
| 再挂上本插件 | PROXIED `127.0.0.1:7897` | 200 |
| `dsh-network-proxy` 经 settings 切到「手动」 | PROXIED | 200 |
| `dsh-network-proxy` 切到「直连」（清空 `HTTP(S)_PROXY`） | PROXIED | 200 |
| 连续来回切换三次 | PROXIED | 每次都是 200 |

要点：

- `web_fetch` 只认 `dsh-http-proxy` 自己持有的策略与 dispatcher，别的插件 `setGlobalDispatcher()` 改不动它
  ——实测 `dsh-network-proxy` 把 `HTTPS_PROXY` 清空后，`web_fetch` 照样走隧道；
- 两者确实共用 **undici 全局 Dispatcher**（后写者赢），但这只影响普通 `fetch()`（模型 API、其它插件），不影响 `web_fetch`；
- 两者都只关闭自己创建的 dispatcher，所以反复切换模式不会把对方弄坏；
- 唯一会让人困惑的是：`dsh-network-proxy` 的「直连 / 手动 / 跟随系统」**不管辖 `web_fetch`**。
  若把它设为「直连」，普通请求直连而 `web_fetch` 仍走代理，界面上会显得不一致。要让两条路径一致，
  就把它们指向同一个代理，或在本插件的 `config.proxy` 里写死同一个地址。

## 安全性

- **fail-open**：模块求值期不抛错，`apply()` 不抛错，异步流程只在 logger 里报告失败；
- 不覆盖宿主已有的代理路由（启动时若 `proxyRouteFor()` 已经是 proxied，直接退出）；
- 只使用 `node:` 内置模块做静态导入，宿主包全部用动态 `import()` 包在 try/catch 里，
  即使某个 DSH 版本改了内部结构，也不会阻止宿主启动；
- 安装后会用 `proxyRouteFor()` 自检，不生效就回滚。

### 为什么需要「锚定解析」

插件通常以 `link:` 方式从 harness 目录树之外安装，此时它的真实路径在 `profiles/` 之外，
裸 `import("@deepseek-ai/dsh-http-proxy")` 会 `ERR_MODULE_NOT_FOUND`。
本插件会按 `DSH_HOME`、app 安装目录、`cwd` 依次构造解析锚点，用 `createRequire(anchor).resolve()` 定位宿主包。
Node 的 ES 模块按 realpath 去重，因此通过锚点拿到的实例与 `dsh-web-fetch-http` 内部用的是**同一个模块实例**
（`bare === anchored === junction === appCopy` 的恒等性已验证）。

## 验证

```bash
npm test            # 30 个单元 / 集成测试
npm run verify      # 对真实网址做前后对照，打印 route 与 HTTP 状态码
npm run verify -- https://example.com/
```

测试覆盖：代理发现、宿主模块锚定解析、路由生命周期（含「慢探测不覆盖新配置」的代际保护）、
surfaces（settings 命名空间注册、状态接口围栏与方法校验、设置改动实时重建路由）、
以及真实 `HttpFetchProvider` 的前后对照集成测试。

`npm run verify` 会在独立进程里跑真实的 `HttpFetchProvider`，安装前后各取一次，
不改动正在运行的 DSH。

## 目录结构

```
dsh-web-fetch-proxy/
├── lib/index.js          # cordis 宿主插件：apply / settings 命名空间 / 状态接口
├── lib/manager.js        # 路由生命周期：安装、释放、代际保护、重试、状态
├── lib/client.js         # 设置页（设置 → 常规 的「Web Fetch 代理」一栏）
├── lib/detect.js         # 代理发现（环境变量 / Clash 配置 / 系统代理 / 端口探测）
├── lib/harness.js        # 宿主模块的锚定解析与 launch environment 构造
├── scripts/verify.mjs    # 真实网络的前后对照验证脚本
├── test/                 # node:test 测试（detect / harness / manager / surfaces / integration）
├── cordis.patch.yml      # 插件注入声明
└── package.json          # 含 dsh.client 声明，宿主据此加载设置页
```

## 常见问题

**Q: 装完之后 `web_fetch` 还是失败？**

A: 看启动日志。如果是 `no reachable local proxy found`，说明插件没找到代理：确认代理客户端已启动并监听
（Clash Verge 默认 `mixed-port: 7897`），或者用 `DSH_WEB_FETCH_PROXY` 显式指定。
如果是 `cannot reach the harness network modules`，说明 DSH 版本差异导致内部包路径变了，欢迎提 issue。

**Q: 会不会影响模型 API 的请求？**

A: 进程级策略会对所有出站 HTTP 生效，模型 API 的流量也会经过本地代理，由代理客户端按自己的规则分流。
如果你希望某些域名直连，用 `noProxy` 或代理客户端的规则处理。

**Q: 关掉代理客户端后 DSH 会断网吗？**

A: 不会。插件只在探测到代理可连接时才安装路由；代理中途退出属于运行期变化，
此时出站请求会失败，重启 DSH 或重新触发（插件会重试）即可恢复直连。

**Q: 设置页里改了模式，需要重启吗？**

A: 不需要。设置写的是 `applies: live` 的 settings 命名空间，宿主端 `scope.watch()` 收到后立即重建路由；
状态行会在一两秒内刷新出新结果。重启只影响**插件本身更新**（例如升级版本后加载新的客户端代码）。

**Q: 状态行一直显示「未找到可用的本地代理」？**

A: 说明候选都没通过 TCP 探测。确认代理客户端在跑（Clash Verge 默认 mixed-port 7897），
或在页面上切到「手动代理」直接填地址；也可以点「重新检测」强制重探一次。

**Q: 设置页没有出现？**

A: 页面要求宿主端注册了 `web-fetch-proxy` 这个 settings 命名空间，否则整行会隐藏。
可能是 `@deepseek-ai/schemastery` 锚定解析失败（日志里会有提示），或插件没被加载。

**Q: 支持 SOCKS 代理吗？**

A: 不支持。`dsh-http-proxy` 只接受 `http(s)://`，本插件与之保持一致；Clash 的 `mixed-port` 本身就是 HTTP 混合端口。

## License

[MIT](./LICENSE) © 2026 Tong317
