# 本地补丁说明

**上游**：[1499501762/dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) v0.2.0（MIT）
**本副本**：本地补丁版，供"关闭 Clash 直连 / 开系统代理或 TUN 走代理 / 全程实时"这一具体需求使用。

上游插件本身设计良好（宿主模块锚定解析、安装后自检回滚、候选端口先 TCP 探测），
但它的**决策时机**和**判断依据**与上述需求冲突，因此打了这个补丁。

---

## 为什么要改

上游有两个硬伤：

1. **没有轮询** —— 路由在启动时决定一次。Clash 关掉后，已安装的路由仍指向死掉的端口，
   `web_fetch` 全部失败也不会自动回退直连，必须手动点"重新检测"或重启 DSH。
2. **判断不看开关** —— 上游的发现顺序里，第 3 步读取 Clash `config.yaml` 的 `mixed-port`
   并只做 TCP 可达性探测。只要 Clash **内核**在跑（端口在监听），即使系统代理和 TUN
   **都关着**，它也会认定"需要走代理"。

---

## 改了什么

| 文件 | 改动 |
|---|---|
| `lib/detect.js` | 新增 `parseTopLevelFlag` / `parseNestedFlag` / `readClashTunEnabled` / `readProxyGate` / `clashConfigFiles`；`discoverProxy` 增加 `trigger` 闸门与 `readSystemProxy` 测试缝 |
| `lib/manager.js` | `DEFAULT_CONFIG` 增加 `trigger` / `pollMs`；`reconcile` 处理闸门结果（`phase: "idle"`）并释放上一条路由；轮询开启时禁用 burst 重试 |
| `lib/index.js` | `apply()` 启动/停止轮询定时器；settings schema 增加 `trigger` 及校验 |
| `lib/harness.js` | 宿主模块加载失败时**记录每个候选的真实错误**；`import()` 失败后回退到 `require()` |
| `cordis.patch.yml` | 显式写出全部默认值，便于查阅与覆盖 |
| `test/*.test.mjs` | 新增 13 个测试：开关解析、陈旧配置优先级、闸门开关、轮询语义、加载诊断与重试 |
| `scripts/gate-check.mjs` | 只读诊断脚本：打印当前判定，不安装任何路由 |

**未改动**：`lib/client.js`（设置页 UI）以及 `discoverProxy` 的候选发现顺序本身。

---

## 行为矩阵

`trigger: toggles`（默认）下：

| Clash 状态 | 判定依据 | 结果 | 生效延迟 |
|---|---|---|---|
| 完全退出 | 端口探测失败 | 直连 | ≤ 一个 `pollMs` |
| 系统代理 开 | WinINET `ProxyEnable=1` | 走代理 | ≤ 一个 `pollMs` |
| TUN 开 | `verge.yaml` → `enable_tun_mode: true` | 走代理 | ≤ 一个 `pollMs` |
| 两个都关（内核仍在跑） | 闸门关闭 | **直连** | ≤ 一个 `pollMs` |
| 显式配置了代理地址 | 用户明确意图 | 走代理（绕过闸门） | 立即 |
| 设置了 `HTTPS_PROXY` 等环境变量 | 用户明确意图 | 走代理（绕过闸门） | 立即 |

无论哪种状态，**都不需要重启 DSH**。

---

## 新增配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `trigger` | `toggles` | `toggles` = 只有系统代理或 TUN 开着才走代理；`reachable` = 上游原行为（代理可达即启用） |
| `pollMs` | `5000` | 轮询间隔（毫秒）。`0` = 关闭轮询，退回上游的一次性决策 |

设置页（**设置 → 常规 → Web Fetch 代理**）只能改 `proxy` / `noProxy`；
`trigger` 与 `pollMs` 属于部署级配置，写在 `cordis.patch.yml` 的 `config` 里。
需要临时强制走代理时，可在设置页切到「手动代理」并填写地址——显式地址会绕过闸门。

---

## 四个关键设计决定

1. **`verge.yaml` 优先于 `config.yaml`**。实测发现 Clash Verge 切换 TUN 时，
   `verge.yaml` 的 `enable_tun_mode` 立即更新，而生成的 `config.yaml` 可能仍写着
   `tun: enable: false`。所以先在所有文件里找 UI 开关，找不到才回退到运行时段。
   测试 `the UI switch beats a stale generated runtime block` 固定了这个行为。

2. **显式意图绕过闸门**。明确写了代理地址、或导出了 `HTTPS_PROXY`，说明用户就是要走代理，
   此时不该被开关判断拦住。闸门只作用于"自动发现"路径。

3. **轮询开启时禁用 burst 重试**。上游的 `retryMs × maxRetries` 循环最长可占用 5 分钟，
   会让后面的轮询全部堆积。现在 `pollMs > 0` 时单次 reconcile 只探测一次，
   **轮询本身就是重试机制**。

4. **闸门关闭是决定，不是故障**。状态记为 `idle`（而非 `error`），
   设置页状态行显示"开关未开启，保持直连"，下一个轮询周期自然重开。

---

## 宿主模块加载：根因与修复（实装实测后补的）

### 症状

首次实装后状态接口报：

```json
{"phase":"unavailable","message":"cannot import @deepseek-ai/dsh-http-proxy [resolve ... ]"}
```

### 根因

诊断信息显示失败的锚点是 `dsh-desktop`、`C:\Program Files\nodejs\resources\app`、
`DSH Desktop` 这三个，而最该成功的 `.dsh\profiles\...` **根本没出现在尝试列表里**。

原因是 `resolutionAnchors()` 从 `env.DSH_HOME` 构造头两个锚点，而
**宿主进程自己的 `process.env` 里没有 `DSH_HOME`** —— 它只被 `dsh-shell-env` 注入到派生的
shell 里（所以在 pwsh 里能读到它，容易误以为宿主也有）。缺了那两个锚点，剩下能试的路径
都到不了 harness 内部包，于是全部 `MODULE_NOT_FOUND`。

第二个隐患：全局 / npx 安装把所有 harness 包嵌在
`<global>/node_modules/@deepseek-ai/dsh/node_modules/` 下，**`NODE_PATH` 指向上一级，
任何锚点都够不到那个嵌套目录**。

### 修复

`resolutionAnchors()` 现在有三个来源：

1. `DSH_HOME` —— 精确，但宿主通常没有，保留兼容；
2. **`~/.dsh`**（`os.homedir()` + `.dsh`）—— 默认 harness home，**实际生效的就是它**；
3. **`NODE_PATH` 的每个条目 + `@deepseek-ai/dsh/node_modules`** —— 直接命中全局安装的嵌套目录。

三者解析到同一个 realpath，所以顺序不影响模块身份。
模拟宿主环境（删掉 `DSH_HOME`）实测：

```
0: %USERPROFILE%\.dsh\profiles\resolve-anchor.js                              <- 生效
1: %USERPROFILE%\.dsh\profiles\web\resolve-anchor.js
2: <NODE_PATH 条目>\@deepseek-ai\dsh\node_modules\...                          <- 也生效
...
loadHarness -> ok = true
```

### 另外两处加固

- **诊断**：`importHarnessModule` 接受 `diagnostics` 数组，逐候选记录
  `resolve <spec> from <anchor> -> <code: message>` / `import <href> -> …` /
  `bare import <spec> -> …`，前三条拼进 `reason`。上游把错误整个吞掉，
  一个裸的 `cannot import` 从设置页根本无法定位。
- **`require()` 回退**：`import()` 失败后改用 `createRequire()`。Node ≥ 22.12 的
  `require()` 也能加载 ESM，走不同加载路径，可绕过宿主安装的、拒绝裸 file URL 的 loader hook。
  身份安全性已实测：`require()` 与 `import()` 对同一文件返回**同一个命名空间对象**、
  同一函数引用，且**通过 require 安装的策略 import 侧能看见**。
- **失败不缓存**：`manager.harnessRef()` 只记住成功的加载。上游一旦失败就永久缓存，
  而轮询本身就是免费的天然重试——每次 `pollMs` 重新尝试导入。

### 完整生产路径预演

删掉 `DSH_HOME` 模拟宿主，跑真实的 `createManager().configure()`（真实闸门 + 真实发现 + 真实安装）：

```
phase     = "ready"
url       = "http://127.0.0.1:7897"
source    = "clash-config:...\config.yaml"
trigger   = "toggles"
pollMs    = 5000
attempts  = 1
```

---

## 实测验证记录（真实环境，Windows + Clash Verge Rev）

**方法**：每次只改一个开关，等一个轮询周期（6 秒），然后同时取三项证据 ——
状态接口、系统 DNS、以及两个**判别性 URL**：

- `https://example.com` —— 国内可直连，任何状态下都应成功（用来证明"没断网"）；
- `https://www.google.com.hk` —— 国内直连不可达，**只有流量真的经代理出去才会成功**
  （用来证明"确实走了代理"，而不是"看起来走了"）。

全程**同一个 dsh 进程，一次都没有重启**。

### 四态对照

| 场景 | 状态接口 `phase` | DNS `example.com` | `example.com` | `google.com.hk` | 结论 |
|---|---|---|---|---|---|
| **A** TUN 开 | `ready` | `28.0.0.103`（fake-ip） | ✅ 200 | ✅ 200 | 走代理 |
| **B** TUN 关（内核仍在跑） | **`idle`** | `172.66.147.243` | ✅ 200 | ❌ `fetch failed` | 直连 |
| **C** TUN 再开 | `ready` | `28.0.0.103` | ✅ 200 | ✅ **200** | 走代理 |
| **E** TUN 关 + 系统代理开 | `ready` | `172.66.147.243` | ✅ 200 | ✅ **200** | 走代理 |

### 状态接口原文（关键字段）

A / C：

```json
{"phase":"ready","url":"http://127.0.0.1:7897",
 "source":"clash-config:%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\config.yaml",
 "attempts":1,"trigger":"toggles","pollMs":5000}
```

B：

```json
{"phase":"idle","attempts":1,
 "message":"Windows 系统代理与 Clash TUN 均为关闭状态，web_fetch 保持直连。",
 "trigger":"toggles","pollMs":5000}
```

### 三条关键结论

1. **B 是补丁的核心证据**。该状态下 Clash **内核仍在运行、`127.0.0.1:7897` TCP 可连接**
   （实测 `可连接 = True`），插件却正确地判定为直连、不装路由。
   上游在这个状态下会照样装路由 —— 那正是它违背需求的地方。

2. **`google.com.hk` 在 B 失败，恰恰证明代理路由真的被卸掉了**，而不是"看起来卸了其实还在"。
   同一个进程、同一个 URL，只关了一个开关就从 200 变成连不上，C 又变回 200。

3. **系统代理检测路径也是通的，只是被更靠前的候选抢先命中**。
   E 组里 `enable_tun_mode: false` 而状态是 `ready` 而非 `idle`，
   说明闸门判定时 `readWindowsSystemProxy()` **成功读到了注册表**——
   即宿主进程里 `reg.exe` 可用。（`source` 显示 `clash-config` 而非 `windows-registry`，
   只是因为发现顺序把 Clash `config.yaml` 的 `mixed-port` 排在 WinINET 之前，
   而两者指向同一地址 `127.0.0.1:7897`。）

### 未实测的边界

**完全退出 Clash（内核也退出）** 未做端到端实测，但逻辑上是安全的：
端口不可达 → 发现失败 → 不装路由 → 直连。即使 Clash 退出时没有清掉系统代理开关
（`ProxyEnable` 仍为 1），闸门虽会打开，发现阶段也会因端口不可达而失败，
结果是 `phase: "error"` + **无路由 + 直连**，而**不会**留下一条指向死端口的代理路由
让 `web_fetch` 全部超时。这正是"每个候选必须先过 TCP 探测"的价值。

---

## 安装

```powershell
dsh plugin --profile web add link:<本目录的绝对路径>
```

然后**重启一次** `dsh web`（插件首次装载必须重启；之后所有切换都不需要）。

首次启动日志里出现类似这行即为生效：

```
[web-fetch-proxy] web_fetch 现在经由 http://127.0.0.1:7897 出网（来源：clash-config:...）
```

若当时开关都关着，则会看到：

```
[web-fetch-proxy] Windows 系统代理与 Clash TUN 均为关闭状态，web_fetch 保持直连。
```

---

## 验证

### 1. 查实时状态（最常用，不影响运行中的 DSH）

插件注册了一个只读状态接口，只接受环回 + 同源请求，**不需要 GUI 的 token**：

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3080/web-fetch-proxy/api' -Method POST `
  -Body '{"action":"status"}' -ContentType 'application/json' `
  -Headers @{Origin='http://127.0.0.1:3080'} -UseBasicParsing).Content
```

关键字段：

| 字段 | 含义 |
|---|---|
| `phase` | `ready`（路由已装）/ `idle`（开关未开，直连）/ `error`（开关开了但找不到代理）/ `unavailable`（宿主模块加载失败）/ `disabled`（配置关闭） |
| `url` / `source` | 当前生效的代理地址与来源 |
| `message` | 失败或判定原因；`unavailable` 时会带出真实的 import 错误 |

同一端点接受 `{"action":"redetect"}` 强制重新探测一次。

### 2. 只读诊断

```powershell
# 不安装任何路由，只打印当前判定
node scripts/gate-check.mjs
```

### 3. 单元测试

```powershell
# 注意：node --test 在受限沙箱下会因 spawn 受限失败，直接跑文件即可
node test/detect.test.mjs
node test/manager.test.mjs
node test/surfaces.test.mjs
node test/harness.test.mjs
node test/integration.test.mjs
```

当前共 47 个测试全通过。`test/harness.test.mjs` 里那条
`resolutionAnchors falls back to the default harness home without DSH_HOME`
是防止锚点回归的关键用例——它锁定了本补丁修掉的那个真实故障。

---

## 回滚

把它从 profile 里移除即可，回到上游行为：

```powershell
dsh plugin --profile web remove dsh-web-fetch-proxy
```

或者只把 `trigger` 改成 `reachable`、`pollMs` 改成 `0`，
就在保留本副本的同时退回上游语义。

---

## 已知限制

- **只影响 `web_fetch`**。模型请求、`web_search`、以及 `pwsh` 子进程的代理不受本插件管辖；
  需要那部分实时开关请另外使用 `dsh-plugin-proxy` 之类的全局插件。
- **轮询间隔决定了灵敏度**，不是瞬时。调小 `pollMs` 会更灵敏，代价是更频繁的
  TCP 探测与策略重装。
- **依赖宿主内部包**（`@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment` /
  `proxyRouteFor`）。DSH 大版本改变内部结构后可能失效；插件对此 fail-open，
  不会阻止 DSH 启动，但功能会静默消失。
- **不支持 SOCKS 代理**，与上游及 `dsh-http-proxy` 保持一致，必须是 `http(s)://`。
- 如果宿主已经有一条代理路由（例如启动时带了 `HTTP_PROXY`），插件**不会覆盖**它，
  只报告 `source: "host"`。这也是它不能"关掉"启动时环境变量带来的代理的原因。
- **候选优先级：Clash 配置端口先于系统代理地址**。发现顺序是
  `显式配置 → 环境变量 → Clash config.yaml 的 mixed-port → WinINET 系统代理 → 常见端口探测`，
  这是上游的顺序，本补丁未改。所以当 **Clash 内核在跑** 且 **系统代理也开着** 时，
  `source` 会显示 `clash-config:...` 而不是 `windows-registry`。
  两者通常指向同一地址（Clash Verge 的系统代理就是它自己的 mixed-port），因此无实际差异。

  仅当你把**系统代理指向另一个端口**（例如别的工具占用 `127.0.0.1:1080`），
  而 Clash 内核同时还在运行时，插件会优先使用 Clash 的 mixed-port 而非你配置的地址。
  若需要"开了系统代理就用我配的那个地址"的语义，把 `discoverProxy()` 里
  `system` 那段 `reachable` 检查移到 `readClashMixedPort()` 之前即可；
  该改动是安全的——系统代理不可达时会自动落到下一个候选。
