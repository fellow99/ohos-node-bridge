# 001-runtime-core-lifecycle —— 实现方案（plan.md）

> **配套**：同目录 `spec.md`（需求与验收）· `specs/constitution.md`（C1–C7 / S1–S10）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）
> **版本**：v1.0 · **状态**：Phase 1，spec 与 **as-built 代码**对齐；凡代码未落地项一律标 `⬜ 规划未实现（Phase x）` 并给规划 § 依据。
> **标记**：✅实测（本仓库可复核，附 `path:line`）· 🔶沿用 · ⬜待验证/未实现 · ⚠️冲突或风险
> **纪律**：本文只回引规划 § 号，不复制粘贴规划原文（constitution §六.3）。

---

## 1. 技术上下文

### 1.1 运行环境

| 项 | 值 | 依据 |
|---|---|---|
| 形态 | ArkTS **HAR**（`type: har`），非独立应用；无窗口、无页面、无 ArkWeb | `library/src/main/module.json5:4` ✅ · C1 |
| 模型 | Stage 模型（`apiType: stageMode`），Ability 生命周期由消费方驱动 | `library/build-profile.json5:2` ✅ |
| SDK | `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)`；目标是 **API 17+ / 24 / 26** 的兼容矩阵 | `build-profile.json5:23,26` ✅ · 规划 §7.5 |
| 真机基线 | HAD-W32 / HarmonyOS 6.1.0 / **API 26** / arm64-v8a | 规划 §D.8 ✅ |
| 设备类型 | `2in1` / `tablet`（不做 phone） | `module.json5:5-8` ✅ · 规划 §7.5 |
| 线程 | 本模块**不建线程**；启动发生在 002 的 detached pthread（32 MB 栈），UI 线程只做投递 | 规划 §5.2 · §5.10 ① 🔶 |
| 权限 | 本模块不需要任何权限；HAR 仅声明 `INTERNET` / `GET_NETWORK_INFO`（供 Node 侧 loopback 服务），受限 ACL 由消费方按自己包名申请 | `module.json5:12-22` ✅ · 规划 §7.5 / §9.4 |

### 1.2 依赖

| 依赖 | 接入方式 | 用途 | 备注 |
|---|---|---|---|
| `@kit.AbilityKit` → `common.Context` | `import { common } from '@kit.AbilityKit'`（`NodeRuntime.ets:1`） | 默认路径来源：`context.bundleCodeDir` / `context.filesDir` | 类型化接口，不做鸭子类型 ✅ · S1 |
| `libnode_bridge.so`（002 引导件） | **只经环境声明** `library/src/main/cpp/types/libnode_bridge/index.d.ts:20-43`（5 符号，`start` 6 参），`import nodeBridge from 'libnode_bridge.so'`（`NodeRuntime.ets:2`） | 本模块只消费 `start` / `isRunning` / `version` 三个符号 | MUST NOT 把 `.so` 当包内模块或 `dependencies` 引入（S1）✅；`.d.ts` 已与 C 侧同步（S8 ✅），`lastError` / `stage` 属**未接线**项（§9 第 6 条） |
| `../log/Logger`（006） | 直接 import（`NodeRuntime.ets:3`） | `info` / `error` 双通道日志入口（hilog） | `Logger.ets:14-24` ✅ |
| `../util/Env`（006） | 直接 import（`NodeRuntime.ets:4`） | `ensureRuntimeDirs` / `logPath`；目录与日志落点唯一来源 | `Env.ets:14-42` ✅ |
| `./Types`（本模块） | 直接 import（`NodeRuntime.ets:5`） | 公共类型契约（状态 / 参数 / 结果） | `Types.ets:8-46` ✅ |
| 反向依赖 | **禁止**：本模块 MUST NOT 被 002/006 引用；002/006 不得查本模块状态 | 保持单向依赖，避免循环 | 规划 §5.1 分层 ✅ |

**编译期风险**：ArkTS 严格模式（S1）下不得出现 `any` / `unknown`；`NodeRuntime.ets` 全文无 `any`/`unknown`/类型断言 ✅（可复核：`grep -n "any\|unknown" library/src/main/ets/runtime/*.ets` 0 命中）。

---

## 2. 宪法合规检查

### 2.1 七条原则

| 原则 | 判定 | 理由与证据 |
|---|---|---|
| **C1** 库/壳分离 | ✅ 符合 | `NodeRuntime.ets` / `Types.ets` 无窗口、ArkWeb、路由、鉴权、`pi`/`PI_*` 语义；失败态 UX 与 `onPrepareToTerminate` 明确留在消费方（spec §1.3、§8）。⚠️ 注意：`payload/bootstrap.js:43,49,52` 出现 `PI_WEB_ENTRY`，属 `004`/`payload` 面的既有偏差（`specs/STRUCTURE.md §8.1`），**不属本模块**，此处仅登记不处置 |
| **C2** 不隐藏平台真相 | ⚠️ 部分 | 本模块全部失败路径返回结构化结果 + 日志（`NodeRuntime.ets:63-68,83-92`）；⚠️ 002 侧的 stdio/dlopen/dlsym 失败发生在**后台线程**，`js_start` 当时早已返回 0 ⇒ 本模块拿到 `ok=true`、状态停在 `starting`。原生侧**已**提供 `set_error`/`set_stage` 与 `js_last_error`/`js_stage` 上报，`.d.ts` 也已声明，但**本模块尚未接线** ⇒ 目前只能靠探针 0 + `node.log`（§9 第 6 条） |
| **C3** 让最终使用者去读 | ✅ 符合 | 提供读回通道：`getLogPath()`（`NodeRuntime.ets:47-49`）+ `getOptions()`（`:51-53`）+ `Logger.tail()`（`Logger.ets:26-52`）；⬜ 日志环 `logs()` 未实现（属 006，规划 §5.7） |
| **C4** 启动参数不可事后修改 | ✅ 符合 | `flags` 只在投递时读取一次（`NodeRuntime.ets:76,82`）；无任何 push/追加 API；`Types.ets:17-24` 显式写清「JIT 需要 ACL」「`--jitless` 会关掉 WebAssembly」的一次性语义 |
| **C5** 单例与不可重启 | ✅ 符合 / ⚠️ 部分 | 幂等保护（`NodeRuntime.ets:62-69`）+ 无重启 API（spec FR-001-040/041）；⚠️ 规划 §5.2 要求「二次调用抛错并**保留首次失败原因**」——代码**不抛异常**（与 C5 的「返回失败」一致，优于抛错）但**未保留首次原因**（无 `lastError` 字段），仅回报当前状态（`NodeRuntime.ets:67`）⇒ Phase 1 补齐（§9 第 5 条） |
| **C6** 诊断优先于修码 | ✅ 符合 / ⚠️ 部分 | 每处状态迁移都有 hilog 留痕（`NodeRuntime.ets:85,94,112`）+ 原生 `crash_handler` 写结构化崩溃行 `sys <ms> CRASH sig=… si_addr=… pc=… lr=…` 与覆盖写的 `<home>/node-bridge/last-crash.json`（`node_bridge.c` `crash_handler`）；⚠️ 真机端到端证书 `/facts` 目前**不含 `state`**（`payload/selfcheck.js:63` 只回 `{at, checks[]}`），规划 §5.7 要求的 `{…, state}` 未落地（属 006） |
| **C7** 零上游补丁 / 二进制可替换 | ✅ 符合 | 本模块只依赖 002 暴露的 3 个符号，对 `libnode.so` 零假设、零补丁；运行时替换（`runtime.lock.json` 换一行）不影响本模块任何代码（规划 §5.8） |

### 2.2 代码规约

| 规约 | 判定 | 理由与证据 |
|---|---|---|
| **S1** ArkTS 严格模式 / 原生只经 `.d.ts` | ✅ 符合 | `NodeRuntime.ets:2` + `index.d.ts:5-15`；无 `any`/`unknown` |
| **S2** barrel 唯一出口 | ✅ 符合 | `Index.ets:16-18` 导出 `NodeRuntime` / `NodeState` / `NodeRuntimeOptions` / `NodeStartResult`；新增公共 API 必须同步 `Types.ets` + `Index.ets` |
| **S3** 类型改动即破坏性变更 | ✅ 符合 | `Types.ets:1-5` 文件头明文「消费方契约：改动即破坏性变更」，并回引规划 §7.5 |
| **S4** 路径一律绝对 | ✅ 符合 | 默认值取自 `Context`（绝对路径）；本模块无 `process.cwd()` / `execPath` 依赖；`scriptPath` 契约要求绝对路径（`Types.ets:26-27`） |
| **S5** 信号上下文禁用 stdio | ⚠️ 不适用（含 002 侧偏差） | 本模块无信号处理；002 的 `crash_handler` 仍调用 `snprintf`，与 S5 字面要求冲突 —— 属 002 面，本模块仅登记（`specs/STRUCTURE.md §4.1` 已记载） |
| **S6** native 产物落点固定 | ✅ 不适用 | 属 002（`CMakeLists.txt` 的 `CMAKE_LIBRARY_OUTPUT_DIRECTORY`） |
| **S7** 引导件不链接 libnode | ✅ 不适用 | 属 002（`dlopen` 在运行期） |
| **S8** C 侧接口只有 3 个 | ✅ 符合（002 侧已自洽） | C 侧现导出 5 个符号（`start` 6 参 / `isRunning` / `version` / `lastError` / `stage`），`index.d.ts:20-43` **已同步** ⇒ S8 成立；本模块仍只调用 `start`/`isRunning`/`version`（`NodeRuntime.ets:39,44,82`），阶段/错误读回属**未接线**项（§9 第 6 条） |
| **S9** 日志双通道 | ✅ 符合（本模块侧） | 本模块经 `Logger` 走 hilog；文件通道由 002 的 pipe + 独立 reader 线程逐行落盘（`node_bridge.c` `start_drain_threads`/`stdio_reader`/`write_line`，行格式 `<stream> <epochMs> <text>`）⇒ §5.10 ⑤ 已落实；⬜ 日志环 `logs()` 与 `/facts.state` 仍属 006 未完成项；`Logger.tail` 失败返回占位串不抛异常 ✅（`Logger.ets:49-51`） |
| **S10** 二进制不入库 | ✅ 符合 | 本模块无二进制；`libnode.so` 投放属 005/消费方（规划 §7.5、附录 G） |

---

## 3. 研究结论（设计取舍）

### 3.1 为什么状态机去掉 `stopping` / `stopped`

- 规划 §5.2/§5.3 草案列 6 态（含 `stopping`/`stopped`），但代码只实现 4 态（`Types.ets:8-13`）⚠️。**取代码口径（4 态）**，理由：
  1. 进程内 Node **没有优雅停止接口**：`node::Start` 直到进程结束才返回（规划 §5.2「线程与 ArkTS 线程的关系」）。任何 `stopping` 都必然是**无法完成的过渡态**；
  2. 硬约束 ⑥ / C5 已把「停止/重启」判为平台封死 ⇒ 暴露 `stopping` 只会诱导消费方写「先 shutdown 再 start」的假流程，属于 C2 禁止的假状态；
  3. 失败态 UX 契约（C5）只允许「读日志 / 读崩溃记录 / 提示重启应用」——不需要停止态支撑。
- **配套决定**：规划 §5.2 的 `shutdown()` + Node 侧 `onShutdown` 钩子保留为 Phase 2 的**可选**能力（对应 spec FR-001-042），落地时必须显式声明「不会让 Node 主循环返回」。
- 回写规划的建议动作登记在 §9 第 1 条（本任务不改规划原文）。

### 3.2 为什么「投递」而不是「等待就绪」

- 探活策略（端口 / 退避 / 超时 / 失败即刻回退）是**消费方契约**：规划 §6.1 把「生命周期」的责任切开——库提供 `start()`，消费方负责 `onPrepareToTerminate` 接线与失败态 UX；§5.10 ⑭ 🔶 更是要求「失败立刻回退而不是等满超时」。
- 库内轮询会引入三个坏后果：① 占用一条 ArkTS 定时器/线程；② 把「就绪判据」（HTTP 探活是否属库）硬编码进库，违反 C1；③ 与 §5.2「ArkTS 只做投递 + 查状态 + 读日志，绝不 join」相矛盾。
- 因此 `start()` 的返回是 `NodeStartResult`（`ok`/`code`/`state`/`message`），且 `ok=true` 的唯一含义是「已投递到后台线程」（`NodeRuntime.ets:55-60,95`）。⬜ 规划 §5.3 的 `waitUntilRunning(timeoutMs)` 属 Phase 1 候选，但**它的判据必须由消费方定义**（见 §9 第 3 条）。

### 3.3 为什么 `isRunning()` 走原生 `g_node_running` 而不是进程探测

- 本形态下「进程」就是**宿主应用进程**：进程活着 ≠ Node 活着；`appspawn` 不是 Node（`process.execPath = /system/bin/appspawn`，规划 §D.8 ✅），端口连通也可能是别的应用占着（§D.10 ⑰ ✅ 实测端口冲突→载荷异常→整个 App abort）。
- 原生计数 `g_node_running` 的语义精确：**引导线程已进入 `node::Start`**——置位在 stdio 重建 + env 装配 + dlopen + dlsym + argv 之后、调用之前（`node_bridge.c` `bootstrap`），清零在 `node::Start` 返回/崩溃后（同一函数）。所以它回答的是「Node 主循环是否在跑」这个唯一有信息量的问题。
- 副作用：`isRunning()=1` **不等于 Node 已就绪**（未运行到用户脚本/未监听端口）⇒ 它就绪判据仍归消费方探活（spec FR-001-036）。这条疆界必须写死在文档里，否则会被误用为「启动完成」信号。
- 另一处实测约束：`libDir` 默认 `context.bundleCodeDir`（`NodeRuntime.ets:73`），但真机上**只有裸名 `libnode.so` 的 `dlopen` 能成功**（规划 §D.8 偏差表 ✅）⇒ 该参数的默认值**不保证**加载成功；原生层用 4 个候选兜底（`node_bridge.c` `bootstrap` 的候选链：`<libDir>/libs/arm64-v8a/` → `<libDir>/` → `<libDir>/libs/arm64/` → 裸名），因此消费方通常**不必**设置 `libDir`，但排障时应先看 `node.log` 里的 `dlopen(...) -> OK/失败原因`。

### 3.4 为什么类型放 `Types.ets` 且注释声明「改动即破坏性变更」

- 类型是跨进程/跨模块契约：消费方（ArkTS）与 Node 侧载荷都按「状态字符串」推理行为；状态取值或字段语义漂移不会产生编译错误，只会产生**线上假阳性**（最坏情况：消费方把 `failed` 当 `starting` 继续等）。
- 与 S2/S3 的一致做法：公共类型集中在 `Types.ets`，由 `Index.ets` 单一出口暴露，文件头写明「改动即破坏性变更」（`Types.ets:1-5`），并登记在规划 §7.5 的语义化版本策略下。
- 具体纪律：① 新增字段一律可选；② 枚举**只增不改**已有取值的语义；③ 改类型必须同步 `Index.ets`、`specs/README.md` 编号表与受影响模块 `plan.md`（constitution §六.1）。

### 3.5 为什么默认 `flags` 是 `--no-verify-heap`（而非含 `--expose-internals`）

- 代码默认值：`--no-verify-heap`（`NodeRuntime.ets:76`；原生二次兜底在 `node_bridge.c` `js_start`）✅；规划 §5.3 草案默认 `execArgv = ['--expose-internals','--no-verify-heap']` ⇒ ⚠️ **不一致**。
- 硬约束 ⑤（规划 §2.3）明确要求 `--expose-internals` 出现在**启动参数**里，否则 `internal/modules/*` 全 `MODULE_NOT_FOUND`；§D.8 ③ ✅ 实测该路线在真机成立。
- 结论：这是**已知悬空项**（不是本模块可以自行决定的取舍）——需要 Phase 1 决策「库默认带上」还是「消费方必须显式带」；在此之前消费方必须自查 `flags`（§9 第 8 条）。本模块不做静默追加（那会违反 C4 的「参数显式化」精神）。

---

## 4. 数据模型

### 4.1 `NodeState` 与迁移表

```ts
export enum NodeState { IDLE = 'idle', STARTING = 'starting', RUNNING = 'running', FAILED = 'failed' }  // Types.ets:8-13
```

| 当前状态 | 事件 | 下一状态 | 合法? | 实现位置 |
|---|---|---|---|---|
| `idle` | `start()` 且原生返回 0 | `starting` | ✅ | `NodeRuntime.ets:78` |
| `idle` | `start()` 且原生返回非 0 | `failed` | ✅ | `NodeRuntime.ets:84` |
| `idle` | `markRunning()` | `idle`（不变） | ✅ 忽略 | `NodeRuntime.ets:103` |
| `idle` | `markFailed(reason)` | `idle`（不变，无日志） | ✅ 忽略 | `NodeRuntime.ets:110` |
| `starting` | `markRunning()` | `running` | ✅ | `NodeRuntime.ets:104` |
| `starting` | `markFailed(reason)` | `failed`（+ error 日志） | ✅ | `NodeRuntime.ets:111-112` |
| `starting` | `start()` | `starting`（拒绝，返回 `ok=false`/`code=-1`） | ✅ 幂等保护 | `NodeRuntime.ets:62-69` |
| `running` | `markFailed(reason)` | `failed`（+ error 日志） | ✅ | `NodeRuntime.ets:111-112` |
| `running` | `markRunning()` | `running`（不变） | ✅ 幂等 | `NodeRuntime.ets:103` |
| `running` | `start()` | `running`（拒绝） | ✅ 幂等保护 | `NodeRuntime.ets:62-69` |
| `failed` | `start()` | `failed`（拒绝） | ✅ 终态 | `NodeRuntime.ets:62-69` |
| `failed` | `markRunning()` | `failed`（不变） | ✅ 终态 | `NodeRuntime.ets:103` |
| `failed` | `markFailed(reason)` | `failed`（+ error 日志） | ✅ 允许重复取证 | `NodeRuntime.ets:110-112` |
| 任意 | 崩溃（探针归 0） | **状态不变**（需消费方 `markFailed`）；原生 `crash_handler` 同时写 `CRASH` 日志行与 `last-crash.json` | ⚠️ 见 §9 第 7 条 | `node_bridge.c` `crash_handler` / `bootstrap` |

**不存在的状态**：`stopping` / `stopped`（§3.1）——任何 UI 文案 MUST NOT 出现「正在停止」。

### 4.2 `NodeRuntimeOptions` 字段表

| 字段 | 类型 | 必填 | 默认值 | 现状 |
|---|---|---|---|---|
| `scriptPath` | `string` | ✅ | — | ✅已实现（`Types.ets:27`；绝对路径，真机 `cwd='/'` ⇒ 禁相对路径） |
| `flags` | `string?` | — | `'--no-verify-heap'` | ✅已实现（`Types.ets:25`；`NodeRuntime.ets:76`；`node_bridge.c` `js_start` 二次兜底） |
| `libDir` | `string?` | — | `context.bundleCodeDir` | ✅已实现（`Types.ets:29`；⚠️ 真机 dlopen 只认裸名，§3.3） |
| `homeDir` | `string?` | — | `context.filesDir` | ✅已实现（`Types.ets:31`；规划 §5.6） |
| `logPath` | `string?` | — | `<homeDir>/payload/node.log` | ✅已实现（`Types.ets:33`；`Env.ets:25-27`） |
| `entry` | `string` | ✅ | — | ⬜ 规划未实现（Phase 1）：规划 §5.3 用 `entry`（相对 `payloadRoot` 或绝对）；当前代码用 `scriptPath` ⇒ **重命名/兼容层需显式决策**（属破坏性变更，S3） |
| `payloadRoot` | `string?` | — | `<filesDir>/node-bridge/payload`（规划 §5.5） | ⬜ 规划未实现（Phase 1/2）；代码实际沙箱布局是 `<filesDir>/payload`（`Env.ets:16`），而崩溃记录已落 `<filesDir>/node-bridge/last-crash.json`（`node_bridge.c` `js_start` 的 `g_crash_path`）⇒ 三处口径未对齐 ⚠️ 见 §9 第 2 条 |
| `archive` / `archiveSha256` | `string?` | — | — | ⬜ 规划未实现（Phase 1，规划 §5.5 路线 ②；首选路线已改为零解压） |
| `argv` | `string[]?` | — | `['node', <entry abs>]` | ⬜ 规划未实现（Phase 2；规划 §5.3） |
| `execArgv` | `string[]?` | — | `['--expose-internals','--no-verify-heap']`（规划 §5.3） | ⬜ 规划未实现（Phase 1）；当前用空格分隔的 `flags` 字符串（`node_bridge.c` `bootstrap` 切分，上限 `MAX_ARGS=12`，超限显式 WARN） |
| `env` | `Record<string,string>?` | — | — | ⚠️ **部分实现（仅原生侧）**：`start` 第 6 参 `envPairs` 已支持（`node_bridge.c` `js_start` + `apply_env_pairs`，`index.d.ts:26` 已声明），但 ArkTS 侧 `start()` 只传 5 参（`NodeRuntime.ets:82`）⇒ **实际不可用**；接线属 Phase 1/2（§9 第 6 条） |
| `cwd` | `string?` | — | `payloadRoot` | ⬜ 规划未实现（Phase 2；真机 `cwd='/'`，需显式 `chdir`，规划 §D.8） |
| `capBytes` | `number?` | — | `8 MiB` | ⬜ 规划未实现（Phase 2，`003-host-bridge`；规划 §5.4） |
| `logRingSize` | `number?` | — | `500` | ⬜ 规划未实现（Phase 1，`006`；规划 §5.7） |
| `jitless` | `boolean?` | — | `false` | ⬜ 规划未实现（Phase 1，规划 §5.3 / §4.7）：**诊断开关**，用了即关 WebAssembly |
| `onLog` / `onStateChange` | 函数 | — | — | ⬜ 规划未实现（Phase 2，规划 §5.3）；当前状态变更只进日志，无回调 |

### 4.3 `NodeStartResult` 字段表

| 字段 | 类型 | 语义 | 现状 |
|---|---|---|---|
| `ok` | `boolean` | 是否**成功投递**（≠ 就绪） | ✅ `Types.ets:39` |
| `code` | `number` | `0` = 已投递；`-1` = 状态守卫拒绝；其它 = 原生 `pthread_create` 错误码 | ✅ `Types.ets:41`；`NodeRuntime.ets:65,88` |
| `state` | `NodeState` | **变更后**的状态（成功 = `starting`，失败 = `failed` / 当前态） | ✅ `Types.ets:43` |
| `message` | `string` | 人读说明（原因 + 下一步，通常含日志路径） | ✅ `Types.ets:45` |

### 4.4 内部字段

| 字段 | 类型 | 初值 | 说明 |
|---|---|---|---|
| `instance`（静态） | `NodeRuntime \| undefined` | `undefined` | 进程内唯一实例；懒建（`NodeRuntime.ets:20,26-31`） |
| `state` | `NodeState` | `NodeState.IDLE` | 唯一状态源；`private`，外部只读（`:22,33-35`） |
| `options` | `NodeRuntimeOptions \| undefined` | `undefined` | 生效参数**快照**（原对象引用，不做深拷贝）✅ 读回用（`:23,79`） |
| `logPath` | `string` | `''` | 生效日志路径（未启动时为空串；`:24,80`） |
| ⬜ `lastError` / `crash` | — | — | 规划未实现（Phase 1/2）：首次失败原因与最近崩溃记录（C5 / 规划 §5.7） |
| ⬜ `pid` | `number` | — | 规划未实现（Phase 2）：进程内 Node ⇒ 等于宿主进程 pid（规划 §5.3） |
| ⬜ 持久化 | `AppStorage` / 文件 | — | 规划未实现（Phase 2）：跨冷启动保留失败态，避免「重启后误以为没发生过」（当前不持久化） |

---

## 5. 接口契约

### 5.1 对外提供

| 成员 | 签名 | 语义 | 证据 |
|---|---|---|---|
| 获取单例 | `static getInstance(): NodeRuntime` | 懒建并返回同一实例 | `NodeRuntime.ets:26-31` ✅ |
| 查状态 | `getState(): NodeState` | 纯读，无副作用 | `:33-35` ✅ |
| 原生探针 | `isRunning(): boolean` | `原生计数 === 1`；崩溃后 false | `:38-40` ✅ |
| 引导件版本 | `bridgeVersion(): string` | 构建期常量串 | `:43-45` ✅ |
| 日志路径 | `getLogPath(): string` | 未启动 = `''` | `:47-49` ✅ |
| 生效参数 | `getOptions(): NodeRuntimeOptions \| undefined` | 未启动 = `undefined` | `:51-53` ✅ |
| 投递启动 | `start(context: common.Context, options: NodeRuntimeOptions): NodeStartResult` | 幂等；非 `idle` 拒绝；不抛异常 | `:61-96` ✅ |
| 探活成功标记 | `markRunning(): void` | 仅 `starting → running` | `:102-106` ✅ |
| 运行期失败标记 | `markFailed(reason: string): void` | 非 `idle → failed` + error 日志 | `:109-114` ✅ |
| 类型导出 | `NodeState` / `NodeRuntimeOptions` / `NodeStartResult` | 公共契约（含 `HostBridgeHandler`，属 003） | `Index.ets:17-18` ✅ |
| ⬜ `waitUntilRunning(timeoutMs?)` | — | 规划未实现（Phase 1）；判据需消费方定义 | 规划 §5.3 |
| ⬜ `logs()` / `lastCrash()` | — | 规划未实现（Phase 1/2，属 006） | 规划 §5.3 / §5.7 |
| ⬜ `shutdown(reason)` / `readonly host` | — | 规划未实现（Phase 2，`003`） | 规划 §5.2 / §5.4 |

**`Index.ets` 导出清单（改公共 API 必须同步，S2/constitution §六.1）**：`NodeRuntime`（`:16`）· `NodeState`（`:17`）· `NodeRuntimeOptions` / `NodeStartResult` / `HostBridgeHandler`（`:18`）· `HostBridge` / `Logger` / `Env`（`:19-21`，非本模块）。

### 5.2 消费（依赖方向）

| 消费对象 | 签名 / 语义 | 证据 |
|---|---|---|
| `context.bundleCodeDir` | 安装目录（HAP 内 `libs/` 的宿主）——默认 `libDir` | `NodeRuntime.ets:73` ✅ |
| `context.filesDir` | 应用可写沙箱根——默认 `homeDir`（`HOME`/`TMPDIR` 由原生层指向它） | `NodeRuntime.ets:74`；`node_bridge.c` `bootstrap` 的 `setenv` ✅ |
| `Env.ensureRuntimeDirs(context)` | 幂等创建 `<filesDir>/payload` 与 `<filesDir>/tmp`；失败不抛（留给后续 open 报错） | `Env.ets:29-42` ✅ |
| `Env.logPath(context)` | `<filesDir>/payload/node.log` | `Env.ets:25-27` ✅ |
| NAPI `start(libDir, scriptPath, flags, home, logPath, envPairs): number` | 原生版：`0` = 已投递；`>0` = `pthread_create` 错误码；`-1` = 已投递过（第二道守卫） | `index.d.ts:20-27`；`node_bridge.c` `js_start` ✅ |
| NAPI `isRunning(): number` | 引导线程是否在 `node::Start` 内（`0/1`） | `index.d.ts:29-30`；`node_bridge.c` `js_is_running` ✅ |
| NAPI `version(): string` | 引导件版本串（当前 `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`） | `index.d.ts:32-33`；`node_bridge.c` `js_version` ✅ |

### 5.3 回调 / 事件协议（探活标记的调用约定）

| 调用方 | 入口 | 前置状态 | 副作用 | 幂等性 |
|---|---|---|---|---|
| 消费方（探活成功） | `markRunning()` | `starting` | `state = running`（**无日志**） | ✅ 重复调用无效果 |
| 消费方（探活超时 / 读到崩溃记录） | `markFailed(reason)` | `starting` 或 `running` | `state = failed` + `Logger.error('Node 运行失败：' + reason)` | ⚠️ 重复调用会**重复写日志**（状态不变）；调用方 SHOULD 自行去重 |
| 消费方（错误调用） | 两者在 `idle` 调用 | `idle` | 无（静默忽略，不写日志） | ✅ |
| 库内部（不再自动触发） | 无自治线程 | — | 库**不做**自动轮询/自动降级（`NodeRuntime.ets:98-106` 注释明文） | — |

**契约要点**：① 标记只在消费方**确认事实**之后调用，库不替消费方猜（规划 §5.10 ⑭ 🔶）；② 标记 MUST NOT 用于「让状态好看」——`failed → running` 不存在；③ 崩溃后探针归 0 但状态仍可能是 `running` ⇒ 消费方 MUST 以探针为准并调用 `markFailed`（§9 第 7 条）。

---

## 6. 实现策略

### 6.1 架构模式

**进程内单例 + 显式状态机 + 投递委托**：

```
消费方 ArkTS ──start(ctx, opts)──▶ NodeRuntime（状态守卫 + 参数装配 + 状态置位）
                                        │ 一次同步 NAPI 调用（O(1)，不等待）
                                        ▼
                                  002 引导件：fill g_ctx → install_crash_handlers
                                        → pthread_create(32MB) → pthread_detach → return 0
                                        ▼（后台线程，与 ArkTS 完全解耦）
                                  设置 stdio（pipe+reader）/env → dlopen → dlsym → argv → node::Start（不返回）
```

- **不使用** 事件总线 / Promise 链 / 中间层：状态机只有 4 态、变更点只有 4 处（`NodeRuntime.ets:78,84,104,111`），任何抽象都会增加审计成本。
- 分层纪律：本模块**永不**读 Node 的 stdout、**永不** join 后台线程、**永不**自己做探活（规划 §5.2）。

### 6.2 `start()` 的 10 步流程

| 步 | 动作 | 证据 / 说明 |
|---|---|---|
| 1 | **幂等守卫**：`state !== IDLE` ⇒ 立刻返回 `{ok:false, code:-1, state, message:'Node 只能启动一次…'}`，**不触达原生层** | `NodeRuntime.ets:62-69`；AC-001-02 |
| 2 | **运行期目录准备**：`Env.ensureRuntimeDirs(context)`（`payload/` + `tmp/`，幂等、异常吞掉只留后续报错） | `NodeRuntime.ets:71`；`Env.ets:29-42` |
| 3 | **参数装配**：`libDir ← options.libDir ?? context.bundleCodeDir`；`home ← options.homeDir ?? context.filesDir`；`logPath ← options.logPath ?? Env.logPath(context)`；`flags ← options.flags ?? '--no-verify-heap'` | `NodeRuntime.ets:73-76`；原生兜底 `node_bridge.c` `js_start` |
| 4 | **状态置位**：`state = STARTING`（**先于**原生调用：即使原生调用失败也绝不回退 `idle`，从而幂等保护不可被绕过） | `NodeRuntime.ets:78` |
| 5 | **保存快照**：`this.options = options`；`this.logPath = logPath`（供 `getOptions()` / `getLogPath()` 读回，C3） | `NodeRuntime.ets:79-80` |
| 6 | **同步投递**：`nodeBridge.start(libDir, options.scriptPath, flags, home, logPath)`（第 6 参 `envPairs` 当前未传，见 §4.2 `env`）；原生 `js_start`：第二道守卫 `g_dispatched` → 落 `g_ctx` → 空 flags 兜底 → 派生 `tmp`/`g_log_path`/`g_crash_path` → `mkdir(<home>/node-bridge)` + `mkdir(<home>/tmp)` → 装崩溃处理器 → `pthread_create`（32 MB 栈）→ `pthread_detach` → `g_dispatched = 1`；后台线程 `bootstrap` 再做 stdio 通道、env、dlopen、dlsym、argv、`node::Start` | `NodeRuntime.ets:82`；`node_bridge.c` `js_start` / `bootstrap` |
| 7 | **失败分支**：`rc !== 0` ⇒ `state = FAILED` + `Logger.error(…rc…node.log 路径…)` ⇒ 返回 `{ok:false, code:rc, state:FAILED, message:'原生层 pthread_create 失败 rc=…'}` | `NodeRuntime.ets:83-92`；AC-001-04 |
| 8 | **成功分支**：`Logger.info('Node 已投递启动：flags=… script=… log=…')` ⇒ 返回 `{ok:true, code:0, state:STARTING, message:'已投递启动'}`。**此处结束库的责任**，就绪判定交给消费方 | `NodeRuntime.ets:94-95`；spec §3.3 |
| 9 | （**库外**）消费方探活：轮询 `127.0.0.1:<port>`（退避 + 超时，失败即刻回退）⇒ 成功调 `markRunning()` | 规划 §6.1 · §5.10 ⑭ 🔶 |
| 10 | （**库外**）消费方失败路径：超时 / 读到 `CRASH sig=…` / 探针归 0 ⇒ 调 `markFailed(reason)` 并展示日志路径 | 规划 §5.7 · C5 |

### 6.3 错误处理

| 规则 | 内容 | 证据 |
|---|---|---|
| 不抛异常 | 全部路径 `return NodeStartResult`；标记类接口返回 `void` 且不抛 | `NodeRuntime.ets:61-114`；与 C5「返回失败」一致（优于规划 §5.2 的「抛错」措辞） |
| `code` 语义固定 | 本模块：`0` = 已投递；`-1` = 状态守卫拒绝；其它 = 原生 `pthread_create` 错误码（正数）。⚠️ `-1` 与原生第二道守卫的 `-1` 同值（`node_bridge.c` `js_start`）⇒ 消费方 MUST 结合 `state` + `message` 判断来源 | `NodeRuntime.ets:65,88`；`node_bridge.c` `js_start` 的 `rc != 0` 分支 |
| `state` 必须是**变更后**状态 | 失败分支取 `this.state`（已是 `FAILED`），保证返回对象与内部状态一致 | `NodeRuntime.ets:66,89` |
| `message` 必须可行动 | 至少含「为什么」+「去哪看」（日志路径 / 下一步提示），禁止空串或只有错误码 | `NodeRuntime.ets:67,85,90`；C2 |
| 不吞错 | 目录创建失败不在此处吞：`Env.ensureDir` 只忽略异常，真正失败会在后续 open/原生层暴露成日志 | `Env.ets:29-36` |
| 已知「异步沉默路径」 | 002 的 stdio/dlopen/dlsym 失败发生在后台线程 ⇒ `js_start` 已返回 0，本模块表现为 `ok=true` + `starting`；原生 `set_error`/`set_stage` 与 `js_last_error`/`js_stage` **已能上报**，缺的是本模块接线 ⇒ 当前靠探针 + 日志发现 | `node_bridge.c` `bootstrap` / `js_last_error` / `js_stage`；§9 第 6 条 |

### 6.4 性能

| 项 | 结论 | 依据 |
|---|---|---|
| `start()` 复杂度 | **O(1)**：2 次幂等 `mkdir` + 4 次字符串装配 + **1 次同步 NAPI 调用**（原生侧只做 `pthread_create` + `detach`，不等待 Node） | `NodeRuntime.ets:71-95` ✅ |
| UI 线程 | 返回时间与 Node 启动耗时**无关**；`APP_INPUT_BLOCK` 的结构性风险被投递语义消除（真机量化见 spec AC-001-10 ⬜） | 规划 §5.2 · §5.10 ① 🔶 |
| 内存 | 本模块不持有大对象（仅参数引用 + 字符串）；线程栈 `pthread_attr_setstacksize(32 MB)` 由 002 负责 | `node_bridge.c` `js_start` ✅ |
| 探针开销 | `isRunning()` 是常量读（`napi_create_int32` of `volatile int`），可在 UI 帧内调用 | `node_bridge.c` `js_is_running` ✅ |
| 日志开销 | 状态迁移日志最多 2 行/次（投递 + 失败或成功）；运行期标记由消费方控制频次（重复 `markFailed` 会重复写，见 §5.3） | `NodeRuntime.ets:85,94,112` ✅ |

---

## 7. 测试考虑

### 7.1 可测点与手段（三层，与 `tests/README.md` 分层一致）

| 层 | 可测点 | 手段 | 现状 |
|---|---|---|---|
| 编译期 / 静态 | 单例唯一、类型契约、无 `any`、`Index.ets` 导出完整 | hvigor 构建 HAR（0 error）+ 派生的 `.d.ets` 声明核对 | ✅ 可跑（`hvigorw assembleHar`） |
| host 侧 | 状态机迁移表逻辑、错误对象构造规则 | `tools/smoke-host.mjs`（Phase 1 ⬜）：以「状态迁移表 + 错误构造表」为断言清单，可对纯逻辑做等价模型测试（NAPI 无法 mock） | ⬜ |
| 真机 | 全部 AC-001-xx（投递 / 拒绝 / 探针 / 崩溃 / 不阻塞） | 样例应用按钮 + `/facts` + `/log` + `hilog`；探针与状态由 UI 文本显示（**可截图**，C6） | ⬜ Phase 1（`samples/minimal-app` 尚未存在） |

### 7.2 与 `specs/overall-test-cases.md` 的编号对齐

> `specs/overall-test-cases.md` **已落盘**（206 行，同批项目级规格）⇒ 本模块**沿用其 `TC-001-*` 编号，不另起编号**；下表必须双向维护（改本规格验收场景 ⇒ 同步该文件）。

| 本规格验收场景 | 对应 TC | 差异 / 待办 |
|---|---|---|
| AC-001-01 首次投递成功 | TC-001-001（✅） | 判据一致（`ok=true` / `code=0` / `state=starting` / `message='已投递启动'`） |
| AC-001-02 二次 `start()` 被拒 | TC-001-002（✅）+ TC-OVR-011（✅） | 一致 |
| AC-001-03 `failed` 后再启动仍被拒 | TC-001-005（✅） | 一致 |
| AC-001-04 原生线程创建失败 | **无专项 TC** | 需登记（建议 TC-001-011：注入 `pthread_create` 失败 ⇒ `failed` + `code=rc` + 日志含路径） |
| AC-001-05 / AC-001-06 探活标记 | TC-001-004（✅） | 该 TC 把「成功→`running` / 失败→`failed` 且终态」合成一族；建议拆出「探活超时」专项 |
| AC-001-07 `idle` 下 `markFailed` 无变化 | 无 | host 侧模型测试即可覆盖 |
| AC-001-08 崩溃后探针归 0 | TC-002-006（✅ 崩溃证据六项齐全） | 本模块侧的「探针 0 + 状态不变」断言需登记（§9 第 7 条） |
| AC-001-09 未启动读回 | 无 | host 侧模型测试即可覆盖 |
| AC-001-10 UI 线程不阻塞 | TC-001-003（L4） | 该 TC 标注「库侧待复跑」⇒ 真机复跑后转 ✅ |
| AC-001-11 参数快照 / 无修改入口 | TC-OVR-010（✅ 静态审导出面） | 运行期读回建议并入 TC-001-004 |
| AC-001-12 `dlopen` 失败可见性 | **TC-002-008**（⚠️「当前静止在 `starting`」） | 本模块接线 `stage()` / `lastError()`（§9 第 6 条）后转 ✅ |
| 失败原因结构化（本规格 §9 第 6 条） | TC-001-006（⬜） | 原生已写 `stage` + `last-crash.json`；缺 ArkTS 读回 |
| 就绪等待接口（本规格 §9 第 3 条） | TC-001-007（⬜） | 判据须先由消费方签署 |
| 版本下限可见告警 | TC-001-008（⬜，归属 001） | ⚠️ **本规格缺该 FR** ⇒ 见 §9 第 14 条 |
| 关停态 `stopping` / `stopped` | TC-001-009（⬜，期待停止态） | ⚠️ **口径冲突**：本规格 §3.1 / FR-001-009 明确拒绝 ⇒ 见 §9 第 15 条 |
| 默认 `flags` 载体 | TC-001-010（⚠️ 不含 `--expose-internals`） | 与硬约束 ⑤ 冲突，Phase 1 决策（§9 第 8 条） |

### 7.3 边界用例（必须覆盖）

1. 连续快速两次 `start()`（同一事件循环 tick 内）⇒ 第二次必拒，且**不得**出现两次线程创建日志。
2. `state=starting` 时调 `markFailed` 再 `markRunning` ⇒ 状态必须停在 `failed`（终态不可回退）。
3. `logPath` 显式传空串 / 相对路径 ⇒ 记录实际行为（空串会让原生 `write_line` / `open_log_fd` 直接返回，不落盘）⚠️，并考虑在 ArkTS 侧加校验（§9 第 9 条）。
4. `flags` 传空串 ⇒ 原生 `js_start` 兜底为 `--no-verify-heap`，断言最终 argv 内容。
5. `flags` 超过 11 个 token ⇒ 原生层截断（`MAX_ARGS=12` 且 `argc < MAX_ARGS-1`），断言不会拿到 NULL 哨兵（硬约束 ③）。
6. 探针为 0 且状态 `starting`（dlopen 失败场景）⇒ 消费方当前只能靠日志判定；原生 `stage()`/`lastError()` 已可读、`.d.ts` 已声明，缺的是本模块接线（§9 第 6 条），对应 `overall-test-cases.md` **TC-002-008**。

---

## 8. 文件清单

| 文件 | 作用 | 行数（✅ `wc -l`） |
|---|---|---|
| `library/src/main/ets/runtime/NodeRuntime.ets` | 本模块主体：单例 + 状态机 + 投递 + 探活标记 + 读回 | 115 |
| `library/src/main/ets/runtime/Types.ets` | 公共类型契约（`NodeState` / `NodeRuntimeOptions` / `NodeStartResult`，+ 003 的 `HostBridgeHandler`） | 49 |
| `library/Index.ets` | barrel：`NodeRuntime` / `NodeState` / `NodeRuntimeOptions` / `NodeStartResult` 唯一出口 | 21 |
| `library/src/main/ets/util/Env.ets` | 沙箱目录与日志路径（本模块的默认值来源 + 目录准备） | 65 |
| `library/src/main/ets/log/Logger.ets` | hilog 入口 + `tail()` 读回（失败返回占位串） | 53 |
| `library/src/main/cpp/node_bridge.c` | 002 引导件（工作区 Phase 1 过渡版；本模块只消费其中 3 个符号） | 640（HEAD 骨架版 295） |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | 环境声明（S1/S8 的接入面）✅ 已同步 C 侧 5 符号 / 6 参 | 43 |
| `library/src/main/module.json5` | HAR 模块声明（权限面；注意缺 `compressNativeLibs`，见 §9 第 10 条） | 24 |
| `library/build-profile.json5` | stageMode + `abiFilters[arm64-v8a]` | 18 |
| `library/oh-package.json5` | HAR 元数据（name/version 0.1.0/main=Index.ets/MIT） | 16 |
| `payload/bootstrap.js` | 消费方入口参考实现（投递之后发生的事） | 64 |
| `specs/001-runtime-core-lifecycle/spec.md` | 本模块需求与验收（配套） | 242 |
| `specs/001-runtime-core-lifecycle/plan.md` | 本文件 | 365 |

---

## 9. Phase 1 未完成项清单

| # | 未完成项 | 规划 § 依据 | 验收判据（可证伪） |
|---|---|---|---|
| 1 | **口径回写**：规划 §5.2/§5.3 的 6 态（含 `stopping`/`stopped`）与 4 态实现不一致 ⚠️ | §5.2 状态机行 · §5.3 `NodeRuntimeState` | 规划 §5.2/§5.3 改为 4 态（或明确标注 `stopping/stopped` 为 Phase 2 可选态），且 spec FR-001-009 与代码一致 |
| 2 | **沙箱路径口径**：代码 `<filesDir>/payload`（`Env.ets:16`）vs 规划 §5.5/§5.7 的 `<filesDir>/node-bridge/payload`、§D.8 的 `<filesDir>/payload/` ⚠️ | §5.5 · §5.7 · §D.8 | 三处对齐为同一布局；`payloadRoot` 选项落地后 `Env` 与原生 `tmp` 派生一致 |
| 3 | `waitUntilRunning(timeoutMs?)`：库侧形态已定（不阻塞 UI），**就绪判据未定** | §5.3 · §6.1 | 实现前必须有消费方签署的判据（端口 / HTTP / 日志标记 之一）；落地后 `overall-test-cases.md` 的 **TC-001-007** 由 ⬜ 转 ✅ |
| 4 | `logs(): NodeLogEntry[]` 日志环 + `lastCrash(): CrashRecord`（006 面，本模块接口预留）；⚠️ 原生侧**已**写 `<home>/node-bridge/last-crash.json`（`node_bridge.c` `crash_handler`），缺的是 ArkTS 读回接口 | §5.3 · §5.7 | 崩溃后能在 ArkTS 侧读到结构化记录（阶段 / 信号 / 提示 / 日志尾）；使 `overall-test-cases.md` 的 **TC-001-006** / TC-002-006 的判据从「日志文本」升级为「结构化字段」 |
| 5 | **保留首次失败原因**（C5 明文要求；当前只回当前状态）⚠️ | C5 · §5.2 单例行 | 二次 `start()` 的 `message`/新字段能回报**首次**失败原因与时间；`overall-test-cases.md` 的 TC-001-002 / TC-001-006 断言该字段非空 |
| 6 | **异步失败与阶段读回接线**：原生已提供 `stage()` / `lastError()`（`.d.ts:35-43` 已声明），但本模块未提供读取入口 ⇒ 消费方只能看探针 + 日志 ⚠️ | §5.2 失败可见 · §5.7 · C2 | ① 本模块暴露阶段 / 最近错误读回（或让 `start()` 的异步结果可查）；② 使 `overall-test-cases.md` 的 **TC-002-008** 从「靠日志」升级为「看阶段/错误」 |
| 7 | **探针与状态的一致性**：崩溃后状态可能停留在 `running`（无自治线程） | §5.2 失败后的恢复 · §5.10 ⑭ | 二选一：① 提供显式 `refresh()` / 由消费方强制 `markFailed` 的契约写入文档；② `isRunning()` 读回 0 时提供可查询的「疑似已结束」标志；需在 `overall-test-cases.md` 登记「探针归 0 但状态未变」的用例 |
| 8 | `--expose-internals` 默认值决策（默认 `flags` 不含它，而硬约束 ⑤ 要求它出现）⚠️ | §2.3 ⑤ · §5.3 `execArgv` · §D.8 ③ | 决策记录（库默认带上 / 消费方必须显式带）+ `flags` 默认值或文档同步更新；`overall-test-cases.md` 的 **TC-001-010** 由 ⚠️ 转 ✅ |
| 9 | 参数校验（`scriptPath` 非绝对、`logPath` 空串、`flags` token 超限） | §D.8 偏差（`cwd='/'`）· 硬约束 ③ · S4 | 非法输入返回结构化失败或明确告警日志（MUST NOT 静默接受）；边界用例 3/5 有确定结果 |
| 10 | `compressNativeLibs` / `extractNativeLibs` 未在 `module.json5` 声明（`grep` 0 命中）⚠️ | §5.9 原生库压缩 · §1.2 关键结论 | 模块级声明存在（HAP 内 `.so` `compress_type=8`）；否则 HAP 体积门禁无依据（属 002/007 面，本清单仅登记） |
| 11 | `failed` 状态的跨冷启动可见性（本模块无持久化；原生 `last-crash.json` 是唯一跨启动证据） | §5.2 失败后的恢复 · C5 · §5.7 | 冷启动后仍能回答「上次失败没有」：读 `<home>/node-bridge/last-crash.json` 或 AppStorage 标志，避免误判为首次启动 |
| 12 | **`-1` 返回码双来源**：本模块状态守卫（`NodeRuntime.ets:65`）与原生第二道守卫（`node_bridge.c` `js_start`）同值 ⇒ 消费方可能误判来源 | §5.3 错误语义 · C2 | 二选一：① 本模块改用别的负值；② 在 `NodeStartResult` 增加来源字段并在契约中写明 |
| 13 | **目录创建职责重叠**：`Env.ensureRuntimeDirs` 建 `<filesDir>/payload` + `<filesDir>/tmp`（`Env.ets:29-42`），原生 `js_start` 又建 `<home>/tmp` 与 `<home>/node-bridge` | §5.5 · §5.6 | 目录清单在文档与代码中唯一化（谁建什么写清）；`payloadRoot` 落地后不出现第三种布局 |
| 14 | **版本下限可见告警**（`overall-test-cases.md` 的 TC-001-008 归属 001）：当前 `bridgeVersion()` 只回引导件版本，Node 版本只有载荷侧 `/facts` 可见 ⇒ 「`process.version < 22.19.0` 时可见 warn」无实现 | §5.8 版本要求（≥22.19.0 否则启动即 warn，**不静默**）· C2 | 低于下限的运行时启动后，调用方能在应用域看到明确告警（返回值或日志），TC-001-008 由 ⬜ 转 ✅；需新增 FR + 落地 |
| 15 | **与 TC-001-009 的口径冲突** ⚠️：`overall-test-cases.md` 期待 `shutdown()` 期间出现 `stopping → stopped`，而本规格（§3.1 / FR-001-009）**明确拒绝**这两个状态 | §5.2 关停行 · §5.3 `NodeRuntimeState` | 二选一并回写：① 维持 4 态 ⇒ 修订 TC-001-009 的判据为「不出现 `stopping/stopped`」；② Phase 2 引入停止态 ⇒ 修订 FR-001-009 与 §4.1 迁移表 |
