# 001-runtime-core-lifecycle —— 运行时核心 · 生命周期与状态机（spec.md）

> **模块**：`001-runtime-core-lifecycle`（规划 §7.3 编号 `001-runtime-core`「单例、状态机、启动参数、线程模型、生命周期」；目录名以本目录为准）
> **依据**：`specs/constitution.md`（原则 C1–C7 / 规约 S1–S10 / §三 证据纪律）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）
> **版本**：v1.0 · **状态**：Phase 1 规格，与**已落地代码逐条对齐**；未落地项一律标 `⬜ 规划未实现（Phase 1/2）`，不写成已实现。
> **标记**：✅实测（本仓库可复核，附 `path:line`）· 🔶沿用（外部一手真机记录，本工程未复现）· ⬜待验证/未实现 · ⚠️冲突或风险
> **边界**：本文件只写「做什么、验收判据是什么」（规划 §10 规则）；「怎么做」见同目录 `plan.md`。任何结论不改规划原文，只回引 § 号（constitution §六.3）。

---

## 1. 模块概述

### 1.1 目的

为宿主应用提供一个**进程内 Node 运行时的生命周期门面**：唯一实例、可查询的状态机、一次性启动的**投递**入口、失败可见的返回结果，以及一组稳定的公共类型契约。它**不启动 Node 本身**（`dlopen` / `node::Start` 属 `002-napi-bootstrap`），只负责「在正确的时机、用正确的参数、把启动请求交给原生层，并把结果如实汇报给宿主」。

✅实测（2026-10-17 校订）：本模块 = `library/src/main/ets/runtime/NodeRuntime.ets`（**798 行**，含 `logs`/`lastCrash`/`shutdown`/`waitUntilRunning`/`host`）+ `library/src/main/ets/runtime/Types.ets`（**159 行**），导出经 `library/Index.ets`。

### 1.2 解决的问题

| # | 问题 | 本模块的处置 | 依据 |
|---|---|---|---|
| 1 | 同进程内 `node::Start` **只能调用一次**，第二次命中 Node 内部断言 ⇒ 应用级崩溃 | 状态机 + 幂等保护：非 `idle` 再启动一律拒绝，不进原生层 | 硬约束 ⑥（规划 §2.3）· C5 |
| 2 | 启动必须在 **detached 线程**内完成，UI 线程做会 `APP_INPUT_BLOCK` | 启动入口设计成**投递**（立即返回），等待/就绪判定不在本模块 | 规划 §5.2 · §5.10 ① 🔶 |
| 3 | 进程内 Node 崩溃**无法自动重启**，假恢复会误导用户 | `failed` 是终态；只允许「读日志 / 提示重启应用」 | 硬约束 ⑥ · 规划 §0.3 · C5 |
| 4 | 启动参数（`execArgv`）**启动即固定**，事后追加会静默失效 | 参数只作一次性输入，不提供运行期修改入口 | C4 · 规划 §6.2 事实 5 |
| 5 | 「投递成功」极易被误读成「Node 已就绪」 | 返回值语义显式区分：`ok=true` 只表示已投递；就绪由消费方探活判定 | 规划 §6.1（生命周期行）· §D.8 ✅ |

### 1.3 范围

**包含**：单例获取入口 · 状态查询 · 一次性启动投递 + 幂等保护 · 启动参数装配与默认值 · 运行期目录准备调用时机 · 探活结果标记（running/failed）· 原生探针与引导件版本读取 · 启动参数与日志路径读回 · 公共类型契约（状态枚举 / 启动参数 / 启动结果）。

**不包含**（越界即一票否决，C1）：

| 不含 | 归属 | 依据 |
|---|---|---|
| C++ 侧加载与引导：`dlopen` / `dlsym` / `node::Start` / `argc` 构造 / SIGSYS shim / 崩溃处理器 / 线程栈尺寸 | `002-napi-bootstrap` | 规划 §7.3 |
| 载荷解包、入口解析、SHA-256 幂等、tar.gz 自解包 | `004-payload-bootstrap` | 规划 §5.5 · §7.3 |
| 宿主能力桥（Node → ArkTS 调用、注册表、线程安全通道、超时/上限） | `003-host-bridge` | 规划 §5.4 |
| 日志环、崩溃记录文件、`/facts` 自检端点 | `006-observability` | 规划 §5.7 |
| **应用语义**：窗口 / 页面 / ArkWeb / 加载页 / 鉴权 / Cookie / `PI_*` 变量的解释 / 失败态 UX / `onPrepareToTerminate` 接线 | 消费方 `pi-desktop-ark` | 规划 §0.3 · §6.1 · C1 |

---

## 2. 用户故事

| # | 故事 | 依据 |
|---|---|---|
| US-001-01 | 作为**宿主应用开发者**，我希望通过一个稳定的单例入口拿到运行时门面，以便在 Ability 生命周期里随处查询状态而不必自己维护静态变量。 | `NodeRuntime.ets:20,26-31` ✅ |
| US-001-02 | 作为**宿主应用开发者**，我希望启动调用**立刻返回**一个结构化结果，以便它可以在 UI 线程安全地调用而不会阻塞输入。 | 规划 §5.2 · §5.10 ① 🔶 |
| US-001-03 | 作为**宿主应用开发者**，我希望重复启动会被**明确拒绝**并告知当前状态，以便我的代码错误不会把整个应用进程打崩。 | 硬约束 ⑥ · C5 |
| US-001-04 | 作为**宿主应用开发者**，我希望探活成功后能把运行时标记为运行中，且这个标记不会把我从错误状态「救回」正确状态。 | `NodeRuntime.ets:98-106` ✅ · 规划 §5.10 ⑭ 🔶 |
| US-001-05 | 作为**宿主应用开发者**，当启动失败或探活超时时，我希望拿到错误码 + 人读原因 + 日志路径，以便用户界面能**截出一张图**说明哪里坏了。 | C2 · C6 · 规划 §3.1 目标 7 |
| US-001-06 | 作为**排障者**，我希望在不重启应用的前提下读回「本次实际生效的启动参数」与日志路径，以及确认 Node 主循环是否还在跑。 | C3 · 规划 §5.7 · `NodeRuntime.ets:38-53` ✅ |
| US-001-07 | 作为**库维护者**，我希望状态取值与公共类型是显式冻结的契约，以便消费方升级时不出现静默不兼容。 | S2 · S3 · 规划 §7.5 |

---

## 3. 功能需求

RFC 2119 关键词：MUST / MUST NOT / SHOULD / MAY。状态列：`✅实测实现` / `⬜ 规划未实现`（括注 Phase 与 § 号）。

### 3.1 单例性

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-001 | 运行时门面 MUST 在**进程内唯一**：多次获取 MUST 返回同一对象引用。 | ✅ `NodeRuntime.ets:20,26-31`（`private static instance` + 懒建） |
| FR-001-002 | 唯一实例 MUST 只能经静态获取入口创建；实现 MUST NOT 依赖外部 `new`。 | ✅ `NodeRuntime.ets:26-31`（构造函数未导出） |
| FR-001-003 | 库 MUST NOT 提供「销毁 / 重建 / 重置实例」的公共 API。 | ✅ `NodeRuntime.ets` 无此类方法 |

### 3.2 状态机与合法迁移

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-004 | 状态 MUST 可查询，取值集合 MUST 恰为 `idle` / `starting` / `running` / `failed` / `stopping` / `stopped` 六者。 | ✅ 六态（`Types.ets:17-24`）；`getState()` 只读 |
| FR-001-005 | 初始状态 MUST 为 `idle`。 | ✅ `NodeRuntime.ets:22` |
| FR-001-006 | 合法迁移 MUST 仅为：`idle → starting`（投递）、`starting → running`（探活成功）、`starting/running → failed`（失败）、`starting/running → stopping`（`shutdown()` 标记）；`failed`/`stopped` 为终态。 | ✅ `NodeRuntime.ets`（`setState` 私有入口 + `shutdown()`；`Types.ets:17-24` 六态枚举） |
| FR-001-007 | 状态 MUST NOT 由外部直接赋值；变更 MUST 仅发生于投递/探活/失败/关停入口。 | ✅ 字段 `private`；唯一变更入口 `setState()`（`NodeRuntime.ets`），无公开赋值面 |
| FR-001-008 | `failed` MUST 是终态：MUST NOT 存在 `failed → running/starting/idle` 的迁移路径。 | ✅ `markRunning` 仅 `starting → running`；`markFailed` 只进 `failed` |
| FR-001-009 | 状态集合 = `idle` / `starting` / `running` / `failed` / `stopping` / `stopped`；`stopping` 由 `shutdown()` 标记（**不假装能停**：进程内 Node 无优雅停止接口，见 §4.1 与 plan §3.1）。 | ✅ 已实现 6 态（`Types.ets:17-24`）；`shutdown()` 置 `stopping` 并记录 reason（`NodeRuntime.ets`） |
| FR-001-010 | 每次状态变更 SHOULD 留下可读回的证据（hilog / 日志）。 | ✅ `NodeRuntime.ets:85,94,112`（Logger.error / info） |
| FR-001-011 | `running` MUST NOT 由状态机自行推定：只有消费方显式标记才会进入 `running`。 | ✅ 无自动轮询（`NodeRuntime.ets:98-106` 注释明文） |

### 3.3 投递语义与幂等保护

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-012 | 启动入口 MUST 是**投递**语义：成功返回 MUST NOT 表示 Node 已就绪，实现 MUST NOT 等待就绪。 | ✅ `NodeRuntime.ets:55-60,95`；就绪判定归消费方（规划 §6.1） |
| FR-001-013 | 首次投递成功后状态 MUST 变为 `starting`，且返回结果中的状态字段 MUST 为 `starting`。 | ✅ `NodeRuntime.ets:78,95` |
| FR-001-014 | **幂等保护**：当状态 ≠ `idle` 时再次调用启动入口 MUST 被拒绝，且 MUST NOT 触达原生层。 | ✅ `NodeRuntime.ets:62-69`（守卫在原生调用之前）；原生侧另有第二道守卫 `g_dispatched`，命中即返回 `-1`（`node_bridge.c` `js_start`） |
| FR-001-015 | 被拒绝时 MUST 返回 `ok=false`、`code=-1`、当前状态、以及说明「每进程只能启动一次」的人读消息。 | ✅ `NodeRuntime.ets:63-68`（⚠️ `-1` 现为**双来源**：本模块守卫与原生第二道守卫 `node_bridge.c` `js_start` ⇒ 消费方 MUST 结合 `state`+`message` 判断来源） |
| FR-001-016 | 投递 MUST 前先完成运行期目录准备（幂等建目录，失败不抛）。 | ✅ `NodeRuntime.ets:71`；`Env.ets:29-42` |
| FR-001-017 | 参数装配 MUST 在调用原生层之前完成：`flags` / `libDir` / `homeDir` / `logPath` 缺省时 MUST 使用各自默认值（见 3.5）。 | ✅ `NodeRuntime.ets:73-76` |
| FR-001-018 | 启动入口 MUST NOT 抛异常；一切失败 MUST 以结构化结果返回。 | ✅ 全路径 `return NodeStartResult`（`NodeRuntime.ets:61-96`） |
| FR-001-019 | 库 MUST NOT 提供运行期追加 / 修改启动参数（`execArgv`）的任何 API。 | ✅ 无此类方法；C4 · 规划 §6.2 事实 5 |
| FR-001-020 | 投递 MUST 保存「实际生效参数」快照，供事后读回（本地读回通道）。 | ✅ `NodeRuntime.ets:79-80` + `getOptions()`（`:51-53`） |

### 3.4 失败可见

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-021 | 原生层返回非 0 值（投递失败）时：状态 MUST 置 `failed`，结果 MUST 返回 `ok=false`、`code=该返回码`、`message` 含原因与日志路径。 | ✅ `NodeRuntime.ets:83-92` |
| FR-001-022 | 失败 MUST 同时进入错误日志通道（可读回，不是只返回给调用方）。 | ✅ `NodeRuntime.ets:85`（含 `node.log` 路径） |
| FR-001-023 | 运行期失败标记接口 MUST 在**非 `idle`** 状态生效：置 `failed` 并写错误日志。 | ✅ `markFailed`（`NodeRuntime.ets:109-114`） |
| FR-001-024 | 运行期失败标记接口在 `idle` 状态 MUST NOT 改变状态（避免「未启动即失败」的伪状态）。 | ✅ `NodeRuntime.ets:110` |
| FR-001-025 | 强制成功/失败 MUST NOT 静默：任何失败都 MUST 在返回值与日志两侧之一可见，MUST NOT 返回假成功。 | ✅ `NodeRuntime.ets:83-92`；C2 |
| FR-001-026 | SHOULD 保留**首次**失败原因，使后续被拒的调用能回报首次原因而非仅当前状态。 | ⬜ 规划未实现（Phase 1）：C5 / 规划 §5.2 明文要求「保留首次原因」；代码仅回当前状态（`NodeRuntime.ets:67`）⚠️ |
| FR-001-027 | SHOULD 提供结构化「最近一次失败记录」（阶段 + 信号 + 日志尾）以便失败态界面取证。 | ⬜ 规划未实现（Phase 2）：规划 §5.3 `CrashRecord` / §5.7 `last-crash.json`（属 `006`） |

### 3.5 默认值与参数装配

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-028 | 启动参数 MUST 至少含 `scriptPath`（入口脚本**绝对路径**，必填）。 | ✅ `Types.ets:27`；S4 |
| FR-001-029 | 缺省 `flags` MUST 为 `--no-verify-heap`。 | ✅ ArkTS 侧 `NodeRuntime.ets:76`；原生侧二次兜底在 `node_bridge.c` `js_start`（双层兜底，互为防御） |
| FR-001-030 | 缺省运行时库目录 MUST 为 `context.bundleCodeDir`。 | ✅ `NodeRuntime.ets:73`（⚠️ 真机上只有裸名 `libnode.so` 的 `dlopen` 成功，§D.8 ⇒ 该默认值**不保证**加载成功，见 plan §3.3） |
| FR-001-031 | 缺省 HOME 根 MUST 为 `context.filesDir`。 | ✅ `NodeRuntime.ets:74`；规划 §5.6 |
| FR-001-032 | 缺省日志路径 MUST 为 `<homeDir>/payload/node.log`。 | ✅ `NodeRuntime.ets:75` → `Env.ets:25-27` |
| FR-001-033 | 启动参数 MAY 接受 `--jitless`，但它 MUST 只被当作**诊断开关**（其代价必须显式告知使用方）。 | ⬜ 规划未实现（Phase 1：结构化的 `jitless` 布尔选项与代价提示）；当前仅能经 `flags` 字符串手写，`Types.ets:20-24` 有代价注释 ✅；C4 · 规划 §4.7 |

### 3.6 原生探针与读回

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-034 | 运行状态探针 MUST 走原生层计数值（引导线程是否仍在 `node::Start` 内），崩溃后 MUST 归 0。 | ✅ `NodeRuntime.ets:38-40` → `node_bridge.c` `js_is_running` 读 `g_node_running`（置位/清零均在 `bootstrap`） |
| FR-001-035 | 探针 MUST NOT 以「进程存在 / 端口可连 / 文件存在」替代原生信号。 | ✅ `NodeRuntime.ets:37-40` 注释明文；规划 §5.7「禁止的判据」 |
| FR-001-036 | 探针 MUST 无副作用：查询 MUST NOT 改变状态、MUST NOT 触发启动、MUST NOT 阻塞。 | ✅ 纯读分支（`NodeRuntime.ets:38-40`） |
| FR-001-037 | 引导件版本读取 MUST 可用，且 MUST 是构建期字符串常量（排障第一判据）。 | ✅ `NodeRuntime.ets:43-45` → `node_bridge.c` `js_version`（当前值 `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`） |
| FR-001-038 | 实现 MUST 提供本地读回通道：日志路径 + 生效参数，供诊断面板直接使用。 | ✅ `getLogPath()` / `getOptions()`（`NodeRuntime.ets:47-53`） |
| FR-001-039 | 状态与探针 MUST 可组合判定失败：`状态=failed` ∨ 探针归 0 ⇒ 调用方可判定「本次运行已结束」。 | ⚠️ 部分：探针归 0 与 `failed` 之间**没有自动联动**（无自治线程），需消费方观察后再标记（`NodeRuntime.ets:108-114`） |

### 3.7 关闭与不可重启语义

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-040 | 库 MUST NOT 实现「崩溃自动重启 / 自动拉起 Node」。 | ✅ `NodeRuntime.ets:16-17`；C5 · 规划 §0.3 |
| FR-001-041 | 库 MUST NOT 提供进程内重启 API；唯一「重启」手段是重启整个应用（失败态 UX 只允许：读日志 / 读崩溃记录 / 提示重启）。 | ✅ 无重启 API；C5 |
| FR-001-042 | 若未来提供关闭入口，它 MUST 明确声明「不会让 Node 主循环返回」，且 MUST NOT 状态回退到可再次启动。 | ⬜ 规划未实现（Phase 2）：规划 §5.2 `shutdown()` + Node 侧 `onShutdown` 钩子 / §5.3 |
| FR-001-043 | 「Node 已结束」 MUST NOT 使状态查询或日志读取失效（状态机 MUST NOT 依赖 Node 存活）。 | ✅ 状态为本对象字段；日志读取走独立通道（`Logger.ets:26-52`） |

### 3.8 类型契约稳定性

| # | 需求 | 状态与证据 |
|---|---|---|
| FR-001-044 | 公共类型 MUST 只经唯一对外出口暴露（barrel）。 | ✅ `Index.ets:16-18`；S2 |
| FR-001-045 | 公共类型的任何改动 MUST 视为**破坏性变更**（文件头必须写明，并同步提升语义化版本）。 | ✅ `Types.ets:1-5`；S3 · 规划 §7.5 |
| FR-001-046 | 状态枚举取值 MUST 为稳定字符串标识，与状态机**六态**一一对应。 | ✅ `Types.ets:17-24`（`idle`/`starting`/`running`/`failed`/`stopping`/`stopped`） |
| FR-001-047 | 启动结果 MUST 含四字段：成功标志、返回码（0 = 已投递；其它 = 原生线程创建错误码）、状态、人读消息。 | ✅ `Types.ets:37-46` |
| FR-001-048 | 启动参数的**新增**字段 MUST 保持可选，以保证向后兼容（不得把可选字段改为必填）。 | 🔶 沿用既有形态：`Types.ets:16-34` 仅 `scriptPath` 必填；C4 要求参数一次性 ⇒ 新增字段只增不改语义 |

---

## 4. 关键实体

> 下表是本模块的**可观测契约**（此处允许出现 ArkTS 类型名，其余章节用行为化措辞）。

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `NodeRuntime` | 进程内唯一运行时门面：状态查询 + 一次性投递 + 探活标记 + 读回 | `getInstance()` · `getState()` · `isRunning()` · `bridgeVersion()` · `getLogPath()` · `getOptions()` · `start()` · `markRunning()` · `markFailed()`（`NodeRuntime.ets:19-115`） |
| `NodeState` | 状态机取值（`failed` 为终态） | `IDLE='idle'` · `STARTING='starting'` · `RUNNING='running'` · `FAILED='failed'`（`Types.ets:8-13`） |
| `NodeRuntimeOptions` | 一次性启动参数（启动后不可增改） | `scriptPath`（必填，绝对路径）· `flags?`（默认 `--no-verify-heap`）· `libDir?`（默认 `bundleCodeDir`）· `homeDir?`（默认 `filesDir`）· `logPath?`（默认 `<home>/payload/node.log`）（`Types.ets:16-34`） |
| `NodeStartResult` | 投递结果（**不等于**就绪） | `ok` · `code` · `state` · `message`（`Types.ets:37-46`） |
| 原生运行探针 | 引导线程是否仍在 Node 主循环内（崩溃后归 0） | 原生计数 `g_node_running`（`node_bridge.c`）↔ `isRunning()` |
| 运行期目录与日志路径 | 投递前准备的沙箱目录与日志落点（读回通道） | `payload/`、`tmp/`、`node.log`（`Env.ets:14-42`；`Logger.ets:26-52` `tail()`） |
| 引导件版本串 | 构建期常量，排障第一判据 | `node_bridge/<ver> (ohos-node-bridge)`（`node_bridge.c` `js_version`） |

---

## 5. 验收场景

> 全部场景的观测点 MUST 落在**应用域**（沙箱日志 / hilog / 返回值 / 界面文字），不得依赖 `hdc` 读沙箱文件（constitution §三.2）。本规格的 `AC-001-xx` 与 `specs/overall-test-cases.md` 的 `TC-001-*` **双向映射**见 plan §7.2（该索引另登记 TC-001-006～010 为本模块 Phase 1 缺口）。

| # | Given | When | Then（可证伪判据） |
|---|---|---|---|
| AC-001-01 | 应用刚启动，状态为 `idle`；宿主服务端口未监听 | 调用启动投递（入口脚本存在、参数使用默认值） | 立即返回 `ok=true`、`code=0`、`state='starting'`；随后 `node.log` 出现引导线程与 argv 记录，探针最终为 1 ✅（`NodeRuntime.ets:78,82,95`；`node_bridge.c` `bootstrap` 的 argv 日志与 `g_node_running` 置位） |
| AC-001-02 | 已完成一次启动投递（状态 `starting`） | 再次调用启动投递 | 返回 `ok=false`、`code=-1`、`state='starting'`、消息含「只能启动一次」；`node.log` 中**不新增**引导线程记录（原生层未被触达）✅（`NodeRuntime.ets:62-69`） |
| AC-001-03 | 状态为 `failed`（先前已失败） | 再次调用启动投递 | 返回 `ok=false`、`code=-1`、`state='failed'`；状态 MUST NOT 被重置 ✅（`NodeRuntime.ets:62-69`；FR-001-008） |
| AC-001-04 | 状态为 `idle` | 让原生层线程创建失败（返回非 0） | 返回 `ok=false`、`code=该错误码`、`state='failed'`、消息含「pthread_create 失败」，且错误日志含日志路径 ✅（`NodeRuntime.ets:83-92`） |
| AC-001-05 | 已投递且探针首次为 1，消费方探活成功 | 调用探活成功标记 | 状态变为 `running`；重复调用 MUST 幂等（不改变状态）✅（`NodeRuntime.ets:102-106`） |
| AC-001-06 | 已投递（状态 `starting` 或 `running`），探活超时 | 调用失败标记并传入原因 | 状态变为 `failed`；错误日志出现该原因；再次调用标记 MUST NOT 改变状态 ✅（`NodeRuntime.ets:109-114`） |
| AC-001-07 | 状态为 `idle` | 调用失败标记 | 状态**保持** `idle`，且不产生错误日志 ✅（`NodeRuntime.ets:110`） |
| AC-001-08 | Node 曾在运行（探针为 1） | 触发原生崩溃（如 `--jitless` 与 ACL 缺失组合，或载荷未捕获异常） | 探针读回 0；状态查询仍可用、日志可读回；`state` **不会自动**变为 `failed`（需消费方标记）；日志出现 `sys … CRASH sig=… si_addr=… pc=… lr=…` 行，且原生侧覆盖写 `<home>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`）✅（`node_bridge.c` `crash_handler` / `bootstrap`；`NodeRuntime.ets:38-40`） |
| AC-001-09 | 未启动过 | 依次读回日志路径与生效参数 | 日志路径返回空串、生效参数返回未定义，MUST NOT 抛异常 ✅（`NodeRuntime.ets:24,47-53`） |
| AC-001-10 | 任意状态 | 冷启动路径上观察 UI 线程 | 启动调用返回耗时与线程创建无关（不等待 Node）；真机 `APP_INPUT_BLOCK` 命中数 0 ⬜ 待验证（Phase 1 真机实测项；🔶 规划 §5.10 ① 的判据） |
| AC-001-11 | 已完成一次启动（参数 A） | 读回生效参数 | 返回与传入一致的对象；再次尝试修改参数**无入口**（不存在 API）✅（`NodeRuntime.ets:79,51-53`；FR-001-019） |
| AC-001-12 | 已投递但原生层 `dlopen` 失败（运行时未投放 / 缺 `libc++_shared.so`） | 观察返回值、探针、原生阶段与日志 | 返回值仍为 `ok=true` / `code=0`（投递是异步的，加载失败发生在后台线程），探针保持 0，`node.log` 出现 `FATAL: libnode.so 加载失败（已试：…）`；⚠️ 原生侧已提供 `stage()` / `lastError()` 上报（`node_bridge.c` `js_stage` / `js_last_error`，`index.d.ts:35-43` 已声明），但本模块未接线 ⇒ 消费方当前只能靠探针 + 日志（plan §9 第 6 条；`overall-test-cases.md` 的 **TC-002-008**） |

---

## 6. 非功能需求

| # | 需求 | 判据 | 状态与证据 |
|---|---|---|---|
| NFR-001-001 | **可观测性**：状态与失败 MUST 在应用域留下可截图/可读回的证据（hilog + 沙箱日志） | 每条状态迁移至少 1 行日志；`node.log` 可在应用内经 `tail()` 读回 | ✅ `NodeRuntime.ets:85,94,112`；`Logger.ets:14-52`（C6） |
| NFR-001-002 | **UI 线程不阻塞**：启动入口 MUST 为 O(1) 投递，MUST NOT 等待原生线程或轮询 | 启动调用 MUST NOT 触发 `APP_INPUT_BLOCK` | ✅ 结构上满足（`NodeRuntime.ets:61-96` 仅做装配 + 一次原生调用）；⬜ 真机量化见 AC-001-10 |
| NFR-001-003 | **状态查询无副作用且轻量**：任意线程、任意频次查询 MUST NOT 改变状态或产生日志 | 连续查询不改变 `getState()` 结果与日志行数 | ✅ `NodeRuntime.ets:33-53`（纯读） |
| NFR-001-004 | **类型兼容**：公共类型的增量演进 MUST 不破坏既有调用方（新增字段可选；枚举取值只增不改语义） | 旧调用代码零改动可编译 | 🔶 沿用：`Types.ets:16-34`；S3 · 规划 §7.5 |
| NFR-001-005 | **资源边界由原生层负责**：本模块 MUST NOT 复制线程栈 / 线程管理逻辑（32 MB 栈、detached 线程属 002） | 本模块无 `pthread` / 线程尺寸代码 | ✅ `NodeRuntime.ets` 无线程代码；线程创建与 32 MB 栈由 `node_bridge.c` `js_start` 负责 |
| NFR-001-006 | **不静默降级**：任何「够不着」的能力（如缺 ACL 时的 JIT）MUST 以调用方可见的方式呈现，MUST NOT 假装可用 | 失败/降级要么是结构化错误，要么是日志 + 探针不一致 | ⚠️ 部分：JIT/ACL 前置不在本模块，但代码注释已写明代价（`Types.ets:20-24`）；库侧**无能力标志**（规划 §3.2 目标项 ⬜） |

---

## 7. 假设与约束

| # | 约束 | 与本模块的关系 | 依据 |
|---|---|---|---|
| A1 | **硬约束 ⑥**：同进程内 `node::Start` 只能调用一次，第二次命中 Node 内部断言 ⇒ 应用崩溃 | 直接决定 FR-001-014 幂等保护、FR-001-040 不可重启、`failed` 终态 | 规划 §2.3 ⑥ · C5 |
| A2 | 硬约束 ①②③④⑤（真共享库 / `libc++_shared.so` 随包 / `argc` 不含 NULL 哨兵 / 谁写谁读 / `--expose-internals` 属启动参数） | 均为上游（002/004）实现约束，但**启动参数一次性**（⑤）由本模块承担（FR-001-019） | 规划 §2.3 · §D.8 ✅ |
| A3 | **UI 线程不做启动**：`dlopen`/`node::Start` 必须在 detached 线程（32 MB 栈）内 | 本模块只投递，不等待（FR-001-012、NFR-001-002） | 规划 §5.2 · §5.10 ① 🔶 |
| A4 | **`--jitless` 只作诊断**：无 ACL 时它是兜底，代价是 WebAssembly 全废（`fetch` / WASM SWC 失效） | 只影响 `flags` 默认值与提示文案，MUST NOT 作为产品默认值 | C4 · 规划 §4.7 · §D.8 ✅ |
| A5 | **单实例 + 随机端口**（消费方契约）：端口冲突会让载荷未捕获异常把整个应用进程 abort | 本模块不需要端口，但「崩溃即终态」的判定依赖该事实不被违反 | 规划 §6.2 事实 1 · §D.10 ⑰ ✅ |
| A6 | 载荷 MUST 自装未捕获异常/未处理拒绝兜底并写独立日志 | 兜底缺失时崩因会被 `node.log` 的宿主输出淹没，`isRunning()` 归 0 成为唯一信号 | 规划 §D.10 ⑱ ✅ |
| A7 | 真机路径偏差：`process.cwd()='/'`、`execPath=/system/bin/appspawn`、`os.cpus()` 长度 0、`dlopen` 只认裸名 | `scriptPath` / `libDir` MUST 用绝对路径；`scriptPath` 缺省猜测 MUST NOT 依赖 cwd | 规划 §D.8 ✅ · S4 |
| A8 | 崩溃是终态，恢复手段只有「重启应用」 | 失败态 UX 契约：只允许读日志 / 读崩溃记录 / 提示重启 | C5 · 规划 §5.2 |

---

## 8. 依赖

**上游（本模块依赖，不得反向依赖本模块）**

| 提供方 | 提供物 | 用途 |
|---|---|---|
| `002-napi-bootstrap` | **5 个** NAPI 符号（经 `.d.ts` 环境声明，S1/S8）：`start(libDir, scriptPath, flags, home, logPath, envPairs): number`（0 = 已投递；>0 = 线程创建错误码；-1 = 原生第二道守卫拒绝；-2 = 原生入参校验失败）、`isRunning(): number`、`version(): string`、`lastError(): string`、`stage(): string` | 投递、探针、版本读回（`index.d.ts`；`node_bridge.c` `js_start` / `js_is_running` / `js_version` / `js_last_error` / `js_stage`）。`lastError()` 与 `stage()` **已被本模块消费**：`getLastError()` / `getStage()` 公开读回，`waitUntilRunning()` 用 `stage==='exited'` 做失败快路径，`start()` 用符号分流 `-1`/`-2`（见 `NodeRuntime.ets`） |
| `006-observability` | `Env`：`payloadDir` / `tmpDir` / `logPath` / `ensureDir` / `ensureRuntimeDirs`；`Logger`：`info` / `warn` / `error` / `tail` | 目录准备时机、日志路径默认值、失败可见（`Env.ets:14-42`；`Logger.ets:13-52`） |
| 平台 | `@kit.AbilityKit` 的 `common.Context`（`bundleCodeDir` / `filesDir`） | 默认路径来源（`NodeRuntime.ets:1,73-75`） |

**下游（消费方，本模块不实现其语义）**

| 消费方 | 期望用法 |
|---|---|
| `pi-desktop-ark`（宿主应用） | 取单例 → 投递启动 → **轮询宿主服务探活（退避 + 超时）** → 成功调 `markRunning()` / 超时或读到崩溃记录调 `markFailed(reason)` → 失败态读日志并提示重启应用；`onPrepareToTerminate` 接线与失败态 UX 归消费方 |

---

## 9. 非目标（本规格明确不承诺，防止越界）

1. **不承诺「投递成功 = Node 可用」** —— 就绪判定属消费方契约（规划 §6.1）。
2. **不承诺优雅停止 / 重启** —— 平台语义封死（硬约束 ⑥、C5）。
3. **不承诺在 `failed` 后自愈** —— 只提供取证通道（日志 / 探针 / 版本）。
4. **不承诺库侧决定服务端口、鉴权、载荷形态** —— 属消费方（规划 §5.5 / §6.2 / §6.3）。
5. **不承诺本模块内做崩溃记录解析** —— 属 `006`（`last-crash.json` / `lastCrash()` ⬜ Phase 1/2）。
