# 003-host-bridge-json-transport —— 宿主能力桥 · 传输与注册表（plan.md）

> 需求在 `spec.md`（验收判据以它为准）；**结论以 `docs/000-工程规划.md` 为准**，本文件只做设计、取舍与落地步骤，并回引 § 号。
> 治理约束：`specs/constitution.md`（C1–C7、S1–S10、§三 证据纪律、§四 红线 G11）。
> 现状标记：✅ 已落地（可复核源码）· 🔶 沿用外工程一手真机记录（**不得**作为对外承诺）· ⬜ 未实现 / 待验 · ⚠️ 缺陷或材料冲突。

---

## 1. 技术上下文

| 面 | 选型 | 依据 / 证据 |
|---|---|---|
| ArkTS 侧容器 | HAR 内纯 ArkTS：`Map<string, HostBridgeHandler>`；无第三方依赖（`library/oh-package.json5` 的 `dependencies` 为空） | ✅ `HostBridge.ets:15`；✅ `library/oh-package.json5:16` 行文件 |
| ArkTS 侧分发骨架 | 同步方法 `dispatch(name, argsJson): string` | ✅ `HostBridge.ets:35-45` |
| 载荷载体 | **一个 JSON 字符串**（入参、出参同形）；理由见 §3 R-003-01 | ✅ `Types.ets:49`；🔶 §5.3 对照段 |
| 线程安全传输层 | **`napi_threadsafe_function`**：在 ArkTS 侧创建，回调在 **ArkTS 线程**执行；Node 线程只入队 | ⬜ §5.4 线程安全行；现状 `dispatch` 是同线程直调 ⚠️ `HostBridge.ets:8` |
| Node 侧形态 | 由引导件暴露的**内置模块**：`require('@fellow99/node-bridge/host')`（`process.dlopen` 暴露的 builtin），无需 npm 安装 | ⬜ §5.3；`payload/` 现无该文件 ✅ |
| 原生面 | `libnode_bridge.so` 目前只导出 3 个接口（`start` / `isRunning` / `version`），**只经 `.d.ts` 环境声明接入** | ✅ `node_bridge.c:285-293`；✅ `cpp/types/libnode_bridge/index.d.ts`（15 行）；S1 / S8 |
| 日志 | `@kit.PerformanceAnalysisKit` 的 `hilog`，域 `0xD0033`、TAG `NODE_BRIDGE`；文件尾部读回走 `Logger.tail` | ✅ `Logger.ets:1,4,14-24,27-52`；S9 / C3 |
| 计时 | ArkTS `setTimeout`（超时兜底）+ Node 侧 `setTimeout`（对端失联兜底），**先到者胜** | ⬜ 本设计 |
| 平台事实 | 真机 HarmonyOS 6.1.0 / API 26 / arm64-v8a；Node 跑在 **detached pthread（32 MB 栈）**，与 ArkTS 线程**完全解耦**；进程内 `node::Start` 只能一次 | ✅ §D.8；✅ §5.2；✅ `NodeRuntime.ets:10-17` |
| 构建/工具链 | DevEco 6.1 + hvigor；工具链版本差异是致命风险，须锁定 | 🔶 R16 |
| 第三方依赖 | **零**（桥不得引入 npm 依赖；N-API 面由本工程自带） | ✅ `library/oh-package.json5` |

---

## 2. 宪法合规检查

### 2.1 原则 C1–C7

| # | 检查项 | 结论 | 证据 / 待办 |
|---|---|---|---|
| **C1** | 库只负责「在应用进程内跑 Node」，应用语义留消费方 | ✅ **边界正确**：`HostBridge.ets` 全文 46 行无窗口/路由/鉴权/包名等宿主语义；能力实现不在库内 | ⚠️ 落地时最大风险是「顺手把 `fs.pickFiles` 实现写进库里」——`fs.pick*` / `shell.openExternal` / `notify.show` / `perm.*` 的**实现**必须留在消费方（§6.1 第「宿主能力」行）；评审按「这是不是宿主语义」一票否决 |
| **C2** | 不隐藏平台真相：缺口⇒结构化错误，绝不静默降级 | ✅ **做到了（核心）**：未注册名返回 `{"ok":false,"error":"unregistered","name":…}`，不是空串、不是假成功（正面教材即宪法 C2 的引用依据） | ⚠️ 三处打折：① 名字未转义可致畸形载荷（§6.2 缺陷 A）；② `JSON.stringify(e)` 有两条逃逸路径（缺陷 B/C）；③ 分发不写日志 ⇒ 失败虽可见但无诊断记录（FR-003-025 ⬜） |
| **C3** | 写成功 ⇒ 最终使用者读回 | ✅ 不适用写文件；但「日志类能力必须双通道 + 有读回通道」（`Logger.tail` 已如此）与「大文件只回路径、由调用方自己读」都是同一条纪律 | ⬜ `log.hilog` 处理器 + `/log` 读回（`selfcheck.js:66-77` 已有读回端点） |
| **C4** | `execArgv` 启动后不可改 | ✅ 桥不提供改启动参数的路径；`runtime.facts` 只**上报** `process.execArgv`（§5.3 的 facts 字段），任何「运行期追加参数」的 API 都不允许出现 | ⬜ 实现 `runtime.facts` 时守住 |
| **C5** | 单例、不可重启 | ✅ 桥不提供重启/拉起 Node 的能力；`failed` 态下调用必须结构化报错而不是尝试恢复（FR-003-021 ⬜） | `NodeRuntime.ets:12-17,62-69` |
| **C6** | 诊断优先于修码 | ⚠️ **未达标**：桥目前无任何日志；`/facts` 也没有桥字段 | ⬜ FR-003-024/025；判据必须是应用域可观测量（`/facts` 的 `hostBridge` 字段、注册表枚举），**不得**用「hilog 里有没有那一行」当判据（§5.7 禁止的判据） |
| **C7** | 零上游补丁优先 / 二进制可替换 | ✅ 本模块只需 N-API 现成机制（线程安全函数、字符串、`napi_define_properties`）与 ArkTS `Map`，**不修改 `libnode.so`**，不依赖任何特定构建来源 | ⚠️ 唯一要注意的是 S7/R18：桥件不得 `DT_NEEDED` 指 libnode；符号在 `RTLD_GLOBAL` 下解析（O11 ⬜ 待验） |

### 2.2 代码规约 S1–S10

| # | 规约 | 结论 | 证据 / 待办 |
|---|---|---|---|
| S1 | ArkTS 严格模式；原生模块只经 `.d.ts` 接入 | ✅ 现状 `HostBridge.ets` 无 `any` / `unknown`；⬜ Phase 2 扩展 NAPI 面时必须同时改 `cpp/types/libnode_bridge/index.d.ts` 与 `oh-package.json5` 声明 | `HostBridge.ets`；`cpp/types/libnode_bridge/index.d.ts` |
| S2 | barrel 唯一出口 | ✅ `HostBridge` 已在 `Index.ets:19` 导出；⬜ 新增公共符号（`unregister` 属方法、选项类型属新符号）必须同步 `Index.ets` + `Types.ets` | `Index.ets:16-21` |
| S3 | 类型改动即破坏性变更 | ⚠️ Phase 2 有**两处**破坏性改动候选：① `HostBridgeHandler` 允许 `Promise<string>`（规划 §5.3）与现状 `Types.ets:49` 只声明同步冲突；② 成功路径是否统一包裹（§4.3）。两处都必须按 §7.5 版本策略提版本，并在 `Types.ets` 文件头写明 | `Types.ets:1-5,49` |
| S4 | 路径一律绝对 | ✅ 设计上遵守：文件类能力**只回沙箱内绝对路径**（FR-003-021），不依赖 `process.cwd()`（真机 = `/`） | ⬜ 能力实现落地时校验 |
| S5 | 信号上下文禁用 stdio | ✅ 不涉及（桥不写信号 handler）；⬜ 提醒：桥的日志**禁止**出现在崩溃 handler 里，崩溃取证属 002 | §5.10 第 2 条 |
| S6 | native 产物落点固定 | ✅ 本模块不改 CMake；⬜ 若新增桥件 C 文件，仍须落在 `library/src/main/cpp` 并受 `CMakeLists.txt:11-12` 约束 | `library/src/main/cpp/CMakeLists.txt`（16 行） |
| S7 | 引导件不链接 libnode | ⚠️ Phase 2 新增桥件时必须守住（`dlopen` 期由 Node 提供 `napi_*`） | R18；P0-11 ⬜ |
| S8 | C 侧接口**现为 5 个**（2026-10-17 扩充）；扩展 NAPI 面必须同步 `.d.ts` | ⚠️ 线程安全传输层**必须**继续扩展 NAPI 面（如 `hostCreate` / `hostDispatch` / `hostSetResult`）：`.d.ts` 必须同步（S8 硬要求），并需按宪法变更流程 §六 登记 S8 口径的更新（**不是**偷偷加接口） | `node_bridge.c` `Init()` |
| S9 | 日志双通道；读日志失败返回占位串而不抛异常 | ⚠️ 桥未接 `Logger`（缺陷 F）；`Logger.tail` 已符合「失败返回占位串」 | `Logger.ets:27-52` |
| S10 | 二进制不入库 | ✅ 不涉及（桥不引入二进制） | `.ohpmignore`；`runtime.lock.json` |

---

## 3. 研究结论

**R-003-01 · 为什么用可序列化载体而不是多参原始类型**
旧壳唯一的可用通道是运行时 `systemPreferences.callArkTSFunction`：**≤3 参、仅原始类型**（🔶 §5.3 对照段；`pi-desktop-hos/src-main/main.js:370` 明确列为「不采用」）。这直接决定了能力形态无法表达：对象/数组、可变字段集、UTF-8 长文本、嵌套结构。而 v1 能力清单里 `perm.check` 要 `string[]`、`fs.pickFiles` 要 `{mimeTypes, maxCount}`（§5.4 能力清单行）——多参原始类型根本装不下。**结论**：一个 JSON 载荷 + 能力名，是「参数个数与类型不受限」与「跨语言边界成本最低」的交点；代价是必须在 plan 里把 schema 冻结（§4.4），否则消费方实现会各自漂移。

**R-003-02 · 为什么 `dispatch` 永不抛异常**
🔶 **R15 是反面教材**：壳侧无条件调 `ExternalWeb.Open`，ArkTS 侧从未注册 ⇒ 适配器 `GetJSFunction … failed` 后**解引用空指针** ⇒ 整个应用进程 `SIGSEGV`（`pi-desktop-hos/docs/工程规划.md:869`；现场注释 `pi-desktop-hos/src-main/main.js:1085-1087`）。本形态下的等价风险是：一个能力缺失就被放大成「进程消失」或「Node 侧 `unhandledRejection` 满天飞」（`HostBridge.ets:32-33` 的注释就是这个意图）。**结论**：注册表校验 + 结构化返回 + 错误类别枚举，把「缺失」降级为一次可判定的失败；这也正是宪法 C2 说「未注册的宿主能力必须明确报错」的原因（§5.4 失败语义）。

**R-003-03 · 为什么不做「ArkTS 调 Node 的通用入口」**
规划只留两条：`start()` 的启动参数、`shutdown()` 的关停钩子（§5.4 方向 2）。理由有三：① **API 面越小越不会被应用语义污染**（R15 库 API 面膨胀，§9.1）；② 反向通用入口需要 Node 侧常驻监听 + ArkTS 侧发起 + 结果回投，等于再造一套双向 RPC，而应用语义已经有同进程 HTTP 服务可用（同进程 `127.0.0.1`，天然同源，§5.10 第 6 条）；③ 反向通道的失败面（Node 已崩、载荷未起）与 `failed` 是终态这条硬约束（§5.2）叠在一起，会让「调用 Node 函数」变成不可靠 API。**结论**：保持两条，反向需求走文件/HTTP。

**R-003-04 · 为什么必须有超时**
🔶 旧壳实测：`requestDirectoryPermission` 在**主进程调用不 settle**（`pi-desktop-hos/src-main/main.js:371-372`）。凡是把用户交互（选择器、权限弹窗、通知）当能力的形态，「调用方永远等不到结果」是**常态**而非异常。没有超时，Node 侧的 Promise 永不结算 ⇒ 上层（HTTP 请求、agent 工具调用）永久挂住，且无法区分「慢」与「死了」。**结论**：默认 10 s（规划 §5.3 明确；⚠️ 代码注释 `HostBridge.ets:10` 写 30 s，**以规划 10 s 为准**，注释在 Phase 2 一并改正），超时后返回结构化 `timeout`；对需要人工操作的能力，默认值可由调用方按能力放宽（能力 schema 里带 `timeoutMs?`）。

**R-003-05 · 为什么 Node 线程不能直接调 ArkTS 对象**
ArkTS/JS 对象与 `napi_value` 都绑定在**创建它的 JS 线程**上；Node 在本形态里跑在**自己的 detached pthread**（§5.2；§5.10 第 1 条），从该线程触碰 ArkTS 对象属于跨线程访问，N-API 的既定做法是把回调**投递回创建线程**执行（`napi_threadsafe_function`）。**结论**：桥的入队-执行必须分离；⬜ 这是结构性结论，真机验证列为 Phase 2 出口判据（A-003-06：🔶 沿用不得当承诺）。现状 `dispatch` 的同线程直调只在「调用方本来就在 ArkTS 主线程」时成立（A-003-02）。

**R-003-06 · 为什么「永不抛」还不够，`detail` 必须是字符串**
桥的输出要越过两个边界（ArkTS → native → Node）。任何**非确定的令牌**（`undefined`、循环引用、超长栈）在边界上都会变成「非法载荷」或「二次异常」。**结论**：失败体只装**已规约的字符串**（§6.2），并且构造函数本身有最后防线（构造失败也返回一个合法载体），把「永不抛」从意图变成**结构上不可能抛**。

---

## 4. 数据模型

### 4.1 处理器类型

```ts
// library/src/main/ets/runtime/Types.ets:49（现状，✅）
export type HostBridgeHandler = (argsJson: string) => string;

// 规划 §5.3 的目标形态（⬜，破坏性变更候选 —— S3 要求提版本）
export type HostBridgeHandler = (argsJson: string) => string | Promise<string>;
```

**差异（必须登记）**：规划允许 `Promise<string>`，代码只声明同步。现状 `dispatch` 是同步签名 ⇒ 返回 Promise 的处理器会被当成普通对象返回（**类型上是缺陷**，运行时表现为 Node 侧拿到 `"[object Promise]"` 之类）。Phase 2 必须二选一：① 保持同步 `dispatch` + 另开 `dispatchAsync(name, argsJson): Promise<string>`（推荐：不给既有同步语义加负担）；② 改 `dispatch` 为 `Promise<string>`（破坏性更大，牵动 002 的原生回投）。

### 4.2 注册表

| 项 | 设计 | 现状 |
|---|---|---|
| 键空间 | 能力名（`namespace.action` 形式，v1 见 §4.4）；**同名覆盖**，`Map.set` 语义 | ✅ `HostBridge.ets:15,18-20` |
| 值 | `HostBridgeHandler` | ✅ |
| 查询 | `Map.get` 平均 O(1) | ✅ |
| 枚举 | 插入顺序遍历；不排序（诊断可读性靠日志） | ✅ `HostBridge.ets:23-29` |
| 无名/超长名 | 注册与调用都校验非空；建议 `maxNameLength = 256`（⬜ 本工程建议，规划未给）：名字会进日志与失败体，超长名字会把两者一起撑爆 | ⬜ |

### 4.3 请求 / 响应 schema

**请求（ArkTS 侧收到的形态）**

| 形态 | 字段 | 类型 | 必填 | 说明 | 现状 |
|---|---|---|---|---|---|
| v1 现状 | `name` | string | ✅ | 能力名 | ✅ `dispatch` 的形参 |
| v1 现状 | `argsJson` | string | ✅ | 能力入参载荷（能力自己定义的 JSON） | ✅ |
| Phase 2 | `id` | string | ⬜ | 调用关联 id（日志与超时对账用） | ⬜ |
| Phase 2 | `timeoutMs` | number | ⬜ | 覆盖默认超时（10 s） | ⬜ |

**响应：失败形态（`{"ok":false,…}`，桥**唯一**注入的形态）**

| 字段 | 类型 | 必填 | 语义 | 现状 |
|---|---|---|---|---|
| `ok` | boolean | ✅ | 恒 `false` | ✅ `HostBridge.ets:38,43` |
| `error` | string | ✅ | 类别枚举：`unregistered` / `handler-threw` / `handler-invalid-return` / `bad-name` / `too-large` / `timeout` / `queue-full` / `serialize-failed` | ✅ 仅前两类 |
| `name` | string | ✅ | 出错的能力名（原样回传） | ✅（**未转义** ⚠️ 缺陷 A） |
| `detail` | string | ⬜ | 已规约为字符串的可诊断细节 | ⚠️ 现为裸 JSON 值 |
| `id` | string | ⬜ | 调用关联 id | ⬜ |

**响应：成功形态**

| 形态 | 结构 | 判定方式 | 现状 |
|---|---|---|---|
| **现状（✅）** | 处理器返回的载荷字符串**原样**返回（不做包裹、不改字段） | 调用方靠「不是失败体」判定成功；能力 schema 里禁止使用 `ok` 字段以免歧义 | ✅ `HostBridge.ets:41` |
| **Phase 2 目标（⬜ 建议）** | `{"ok":true,"result":"<处理器返回的载荷字符串>"}` | `ok === true` 显式判定；桥仍**不解析** `result`（零解析成本），解析交给 Node 侧 shim | ⬜ |

> **取舍（为什么建议加 `ok:true` 包裹）**：现状的成功/失败判定是「约定」而非「结构」（FR-003-007 要求无歧义判定）。加包裹**不增加解析成本**（`result` 仍是原字符串），Node 侧 shim 反正要 `JSON.parse` 一次；代价是 `dispatch` 的返回形态变化 ⇒ **破坏性变更候选**，但 Node 侧 shim（FR-003-022 ⬜）是本模块一起交付的，不存在既有消费者的兼容负担。若消费方选择维持现状，则必须在能力 schema 里**显式禁止** `ok` 字段，并把该约定写进 §4.4 的签收表。

### 4.4 能力清单 v1 的入参/出参 schema **草案（规划；实现属消费方，§6.1）**

| 能力名 | 入参 | 出参 | 关键约束 | 证据 |
|---|---|---|---|---|
| `runtime.facts` | `{}` | `{node, platform, arch, execArgv, state, hostBridge}` | 只**上报**，不可改（C4）；`hostBridge` 供 FR-003-024 | 🔶 §5.3 facts 示例；§5.7 `/facts` |
| `perm.check` | `{permissions?: string[], permType?: 'directory_desktop'\|'directory_document'\|'directory_download'}` | `{available: boolean, results: boolean[]}` | 对齐旧壳 `checkPermission`：真机**同步**返回 `[false,false,false]`；`available=false` 时必须如实上报（不可用 ≠ false 权限） | 🔶 `pi-desktop-hos/src-main/main.js:368,375-390` |
| `perm.openAppInfo` | `{}` | `{opened: boolean}` | 旧壳 `openApplicationInfoEntry()` 同步返回 `undefined`（无异常） ⇒ 只能以「无异常」为成功判据 | 🔶 `pi-desktop-hos/src-main/main.js:369,396-400` |
| `fs.pickFiles` | `{mimeTypes?: string[], maxCount?: number}` | `{paths: string[]}`（**仅绝对路径**） | 内容绝不回传（§5.4 参数上限）；可能长时间不返回 ⇒ 需放宽容忍超时 | ⬜ §5.4 |
| `fs.pickFolder` | `{}` | `{path: string}`（绝对路径） | 同上 | ⬜ §5.4 |
| `shell.openExternal` | `{url: string}`（仅 http/https） | `{opened: boolean}` | 非 http(s) 必须结构化拒绝；旧壳 `shell.openExternal` 实测安全（R15 处置 ① 选它） | 🔶 `pi-desktop-hos/docs/工程规划.md:869` |
| `notify.show` | `{title: string, text: string, id?: string}` | `{shown: boolean}` | 通知权限由消费方申请 | ⬜ §5.4 |
| `log.hilog` | `{level: 'info'\|'warn'\|'error', tag?: string, msg: string}` | `{logged: boolean, hilog: boolean}` | **必须**同时进 hilog 与日志文件（S9） | ⬜ §5.4；`Logger.ets:14-24` |

> 本节所有 schema 均为**规划草案 ⬜**，冻结判据 = 消费方与库双方签收（§6.2 共享事实：任一方改动都要同步）。

### 4.5 常量（默认值表）

| 常量 | 默认 | 来源 | 状态 |
|---|---|---|---|
| `timeoutMs` | **10000** | 🔶 §5.3（「明确超时（默认 10 s）」） | ⚠️ 代码注释写 30 s，以规划为准 |
| `capBytes` | **8 MiB** | 🔶 §5.3 `NodeRuntimeOptions.capBytes`；§5.4 参数上限 | ⬜ |
| `maxNameLength` | 256 | 本工程建议 | ⬜ 待签收 |
| `maxQueue` | 64 | 本工程建议（规划只说「有界」） | ⬜ 待签收 |
| `maxInFlight` | 8 | 本工程建议：长期调用（选择器/权限弹窗）会占额度，太小会饿死日志类短调用 | ⬜ 待签收 |

> `capBytes` 的归属需澄清：§5.3 把它写在 `NodeRuntimeOptions`（启动选项）里，但桥是**运行期**对象、上限按调用计 ⇒ 本设计建议作为桥的选项（字段名保持 `capBytes`），由消费方在建桥时给出；若坚持从 `NodeRuntimeOptions` 透传，则改 `Types.ets`（破坏性变更，S3）。

---

## 5. 接口契约

### 5.1 提供（ArkTS 侧，`library/Index.ets` 导出 `HostBridge`）

| 成员 | 签名 | 语义 | 失败形态 | 现状 |
|---|---|---|---|---|
| `register` | `(name: string, handler: HostBridgeHandler): void` | 注册能力；**同名覆盖** | 名字非法 ⇒ 抛 `TypeError`（**注册是主机侧 API，允许立刻失败**，与分发相反） | ✅ |
| `unregister` | `(name: string): boolean` | 注销；未注册返回 `false`（不抛） | 无 | ⬜ 规划 §5.3 有 |
| `list` | `(): string[]` | 已注册名字（诊断/自检） | 无（空表 ⇒ 空数组） | ✅ |
| `dispatch` | `(name: string, argsJson: string): string` | 分发一次调用；**永不抛** | 结构化失败体（§4.3） | ✅ |
| `dispatchAsync`（建议） | `(name: string, argsJson: string, timeoutMs?: number): Promise<string>` | 承载异步处理器与超时 | 以结构化失败体 **resolve**（不 reject，保持「错误也是数据」） | ⬜ Phase 2 |

### 5.2 消费（Node 侧）

```js
const host = require('@fellow99/node-bridge/host');   // ⬜ 内置模块（§5.3）
const facts = await host.invoke('runtime.facts');      // → 已解析的对象
try {
  const { paths } = await host.invoke('fs.pickFiles', { mimeTypes: ['*/*'], maxCount: 1 });
} catch (err) {
  // err.code === 'unregistered' | 'timeout' | 'too-large' | 'queue-full' | 'handler-threw' …
  // err.name（能力名）· err.detail（字符串）
}
host.handle('shutdown', () => new Promise((r) => server.close(r)));   // Node 侧钩子
host.list();                                          // 与 ArkTS 侧 list() 同源
```

| 面 | 契约 | 现状 |
|---|---|---|
| 模块名 | `@fellow99/node-bridge/host`，经引导件注册为 builtin（`process.dlopen` 路线），**无需 npm 安装** | ⬜ §5.3；`payload/` 无该文件 |
| `invoke(name, args?, opts?)` | 返回 Promise；入参对象由 shim 序列化；失败 ⇒ **reject 一个带 `code` / `name` / `detail` 的 Error**（Node 侧惯用失败面），而 ArkTS 侧仍是 resolve 失败体 | ⬜ |
| `handle(name, fn)` | 注册 Node 侧钩子（当前只有 `shutdown` 语义，§5.4 方向 2） | ⬜ |
| `list()` | 名字数组（诊断用） | ⬜ |

### 5.3 事件协议（Node → ArkTS，规划）

```
Node 线程                        引导件 / ArkTS 主线程
  invoke(name, args)
    ├─ 序列化请求（名字 + 载荷 + deadline + id）
    ├─ 入队（有界；满 ⇒ 立即 reject queue-full）
    └─ 投递 threadsafe function ─────► 主线程 pump（一次一个/并发上限内）
                                          ├─ 查注册表 ⇒ 未注册 ⇒ 失败体 unregistered
                                          ├─ 载荷上限校验 ⇒ 超限 ⇒ 失败体 too-large（不执行）
                                          ├─ 执行 handler（try/catch）
                                          ├─ 异步 ⇒ 挂起等待，超时 ⇒ 失败体 timeout
                                          └─ 结果序列化（字符串载体）
    ◄──── 回投结果 ─────────────────────┘
    ├─ 解析 envelope ⇒ ok:true ⇒ resolve(result)
    └─                 ok:false ⇒ reject(Error{code,name,detail})
```

**主线程执行约定（必须写进接入文档）**
1. 处理器**只在 ArkTS 主线程**执行 ⇒ 不得在其中做同步阻塞 IO / 忙等 / 等待用户操作（长交互必须由处理器内部异步化，并按能力放宽超时）。
2. **重入允许**：处理器内再次 `dispatch` 时，调用方已在主线程 ⇒ 必须走**同步快路径**直接执行，禁止入队（否则 Phase 2 队列化后会自死锁）。这条是队列设计的硬要求。
3. 处理器抛错 ⇒ 失败体；处理器返回非字符串 ⇒ `handler-invalid-return`（桥不解析能力载荷，只做类型判定）。
4. 每个请求**只结算一次**（先到者胜：结果 / 超时 / 队列拒绝），重复结算必须被丢弃并记日志。

---

## 6. 实现策略

### 6.1 架构模式

```
[Node 线程]  host.invoke ──shim──► threadsafe queue（有界）
                                        │  投递（napi_threadsafe_function）
                                        ▼
[ArkTS 主线程] HostBridge.dispatch ──► Map 注册表 ──► handler（消费方实现）
                                        │
                                        └─► 失败体/成功载荷 ──回投──► Node 侧 Promise
```

- **现状（✅）**：注册表 + 同步分发骨架（46 行），等价于上图中「ArkTS 主线程」这一列，队列与投递缺失 ⚠️。
- **Phase 2（⬜）**：在保留 `register` / `list` / `dispatch` 语义不变的前提下，把「跨线程投递」与「超时/上限」加在同一对象上；`dispatch` 的同步语义保留给「已在主线程」的调用方。
- **分层纪律**：桥不认识任何能力语义（C1）；能力实现由消费方 `register` 注入；桥只保证传输与失败语义。

### 6.2 关键算法：`dispatch` 的错误包装（现状实现有**真实缺陷**）

现状（逐字）：

```ts
dispatch(name: string, argsJson: string): string {
  const h: HostBridgeHandler | undefined = this.handlers.get(name);
  if (h === undefined) {
    return '{"ok":false,"error":"unregistered","name":"' + name + '"}';          // L38
  }
  try {
    return h(argsJson);                                                          // L41
  } catch (e) {
    return '{"ok":false,"error":"handler-threw","name":"' + name + '","detail":' + JSON.stringify(e) + '}';  // L43
  }
}
```

| 缺陷 | 严重度 | 触发条件 | 后果 |
|---|---|---|---|
| **A · 字符串拼接 JSON（`name` 未转义）** | **中** | 能力名含 `"` / `\` / 换行 / 控制字符（名字由调用方给出） | 返回**畸形 JSON** ⇒ Node 侧 `JSON.parse` 抛错，或解析出攻击者可控的额外字段（注入）。L38 与 L43 两处都在 |
| **B · `JSON.stringify(e)` 可返回 `undefined`** | **高** | `throw undefined` / `throw function(){}` / 抛 Symbol | 产出 `"detail":undefined` —— **非法 JSON**，破坏 FR-003-011 |
| **C · `JSON.stringify(e)` 可抛 `TypeError`** | **高** | 抛出循环引用对象（`e.self = e`）或含 `BigInt` 的对象 | 异常从 `catch` 块中**逃出 `dispatch`** ⇒ 直接违反「**永不抛异常**」契约（FR-003-010），把「一次失败调用」升级成平台边界异常 |
| **D · 成功返回值不校验** | **中** | 处理器返回非字符串（JS 互操作、异步处理器被同步调用、返回 `undefined`） | 非字符串被透出 ⇒ 声明为 `string` 的 API 实际返回 `undefined`，Node 侧解析失败且**错误类别无处可查**（FR-003-012） |
| **E · 无载荷上限** | **中** | 入参或出参超 `capBytes` | 越过 N-API 边界的大字符串拷贝会显著占用主线程时间（NFR-003-01），且无任何拒绝（FR-003-018） |
| **F · 分发不写日志** | **中** | 任何失败路径 | 失败可判定但**不可追溯**（C6/FR-003-025） |

**修法（Phase 2 目标实现；ArkTS 严格模式可用）**

```ts
/** 失败体：桥唯一注入的响应形态（字段见 §4.3）。 */
interface HostBridgeFailure {
  ok: boolean;       // 恒 false
  error: string;     // 类别枚举（§6.3）
  name: string;      // 出错的能力名（原样）
  detail?: string;   // 已规约为「确定的字符串」
}

/** 把任意抛出值规约成字符串 —— 规避缺陷 B/C：不再让 JSON.stringify 直接吃未知值。 */
function describeThrow(e: Object | undefined): string {
  if (e === undefined) { return '<undefined thrown>'; }
  try {
    if (e instanceof Error) { return e.name + ': ' + e.message; }
    return String(e);                    // 循环引用对象的 String() 也包在 try 里
  } catch (err) {
    return '<unprintable thrown value>';
  }
}

private fail(error: string, name: string, detail?: string): string {
  const f: HostBridgeFailure = { ok: false, error: error, name: name, detail: detail };
  try {
    return JSON.stringify(f);            // 名字与 detail 都由序列化器转义 ⇒ 缺陷 A 消失
  } catch (err) {
    return '{"ok":false,"error":"serialize-failed","name":""}';   // 最后防线：仍是合法载体
  }
}

dispatch(name: string, argsJson: string): string {
  if (typeof name !== 'string' || name.length === 0) { return this.fail('bad-name', ''); }
  if (name.length > MAX_NAME_LENGTH) { return this.fail('bad-name', ''); }
  const h = this.handlers.get(name);
  if (h === undefined) {
    Logger.warn('hostBridge 未注册调用：' + name);                    // 修 F（C6）
    return this.fail('unregistered', name);                          // C2 的正面形态
  }
  try {
    const out: string = h(argsJson);
    if (typeof out !== 'string') {                                   // 修 D
      return this.fail('handler-invalid-return', name, typeof out);
    }
    return out;                                                      // 保持「桥不重写能力载荷」
  } catch (e) {
    Logger.error('hostBridge 处理器抛错：' + name + ' · ' + describeThrow(e));
    return this.fail('handler-threw', name, describeThrow(e));        // 修 B/C
  }
}
```

**载荷上限的判定顺序（修 E）**：`if (argsJson.length > capBytes) return this.fail('too-large', name)` —— **快速路径**（UTF-16 长度 ≥ 任何字符的 UTF-8 字节数 ⇒ 长度已超限时字节数必然超限，**不会误杀**）；否则再用 `@kit.ArkTS` 的 `util.TextEncoder` 取**精确 UTF-8 字节数**做判定（§5.4 的上限是「JSON 载荷单次 ≤ capBytes」，按字节计；用 `String.length` 会让中文载荷按 1/3 放行）。出参同样在回投**之前**校验（超限 ⇒ 失败体，且**不**回投半截数据）。

### 6.3 错误处理：三类错误的构造规则

| 类别 | 触发 | 谁构造 | 字段 | Node 侧处置建议 | 现状 |
|---|---|---|---|---|---|
| `unregistered` | 注册表查不到该名字 | 桥（分发入口） | `ok:false, error, name` | **不要重试**（能力缺失是配置问题）；提示「该能力未就绪」 | ✅ |
| `handler-threw` | 处理器抛错（任意值） | 桥（catch） | `+ detail`（字符串化后的错误） | 可重试一次；`detail` 直接给人看（进诊断面板） | ✅（detail 构造有缺陷 B/C） |
| `bad-args` / `too-large` | 入参非字符串 / 超上限 | 桥（入口校验） | `+ detail`（实际长度、上限） | **不重试**；调用方修载荷 | ⬜ |
| `timeout` | 超过 `timeoutMs`（默认 10 s） | 桥（定时器） | `+ id` | 视能力语义决定是否重试；必须让用户看到「还在等」而不是死机 | ⬜ |
| `queue-full` | 队列满 / 在途达上限 | 桥（入队处） | `+ detail`（当前队列深度） | 退避重试；**不得**改为无限等待 | ⬜ |
| `handler-invalid-return` | 处理器返回非字符串 | 桥 | `+ detail`（实际类型） | 报缺陷给能力实现方 | ⬜ |
| `serialize-failed` | 连失败体都构造不出来（最后防线） | 桥 | 固定最小体 | 视为内部缺陷，上报日志 | ⬜ |

**总规则**：桥**只**在「入队/分发/回投」三处产生失败体；能力实现自己的业务失败必须由能力 schema 表达（`permission not granted` 之类**不是**桥的 `error` 类别，否则桥就开始承载应用语义，违反 C1）。

### 6.4 性能

| 项 | 结论 |
|---|---|
| 注册表查找 | `Map.get` 平均 O(1)；`list()` O(n)，n = 已注册能力数（个位数）✅ |
| 载荷成本 | N-API 字符串跨边界是 **UTF-8 编解码拷贝**，不是零拷贝；8 MiB 载荷 ⇒ 至少 1 次编码 + 1 次解码，且发生在**主线程** ⇒ 这是 `capBytes` 取值的主要依据 ⬜（真机测一次再定；大文件选择器只回路径正是为了避开这笔开销） |
| 无拷贝假设 | 只能避免**额外**拷贝（不二次序列化、不解析能力载荷）；边界拷贝无法避免 ⇒ 设计上不要「顺手 `JSON.parse` 一下再 `stringify`」 |
| 并发 | 主线程**串行**执行处理器（单线程语义，无需锁）⇒ 吞吐由处理器耗时决定；并发上限 `maxInFlight` 只影响「拒绝 vs 排队」的取舍 ⬜ |
| 队列 | 有界，溢出即 `queue-full`（§5.4：不许静默丢弃）⬜ |
| 内存 | 单个在途调用持有 1 份载荷字符串；`maxInFlight × capBytes` 是**最坏驻留上界**（8 × 8 MiB = 64 MiB），必须写进接入文档 ⬜ |

---

## 7. 测试考虑

| # | 层 | 内容 | 现状 |
|---|---|---|---|
| T-003-01 | **host 侧（纯 JS，可测）** | 用**等价实现**（同样的拼接/包裹逻辑）在 Node 里验证 JSON 契约：未注册 / 抛错 / 覆盖 / 空表 / 特殊字符名 / 抛 `undefined` / 抛循环引用 / 返回非字符串 / 重入 —— 断言「输出**永远**可 `JSON.parse`」「失败体字段齐全」「`ok` 语义无歧义」。落在 `tests/host-bridge-protocol.test.mjs`（⬜ 待建，属本模块交付） | ⬜（`tests/` 现只有 `README.md`，28 行） |
| T-003-02 | 边界 | 超长 name（> 256 与 1 MiB 两级）、空 name、非 JSON 入参（`'{'` 截断）、处理器返回非 JSON（**这是允许的**——桥不解析能力载荷，测试要断言「透传而不是报错」，避免把测试写成规格的敌人）、重入调用（handler 内再 `dispatch`，Phase 2 必须走快路径不自死锁） | ⬜ |
| T-003-03 | 真机 | `/facts` 的 `hostBridge` 字段（名字数组 + 上限/超时值）+ 一次真实往返（`host.invoke('log.hilog')`）：`hdc fport` + `curl` 取证 | ⬜ §5.7 通道 ④ |
| T-003-04 | **判据纪律** | **不得**用「hilog 里有没有那一行」判执行（§5.7 禁止的判据）；桥的可用性判据 = 注册表枚举 + `/facts` 字段 + 往返结果 | 宪法 C6 |
| T-003-05 | 负向回归 | 未注册调用**不得**崩溃（对照 🔶 R15：旧壳在此 `SIGSEGV`）；`Faultlogger` 无新增 fault log | ⬜ |

---

## 8. 文件清单（真实 `wc -l`，2026-10-16 本机）

| 文件 | 行数 | 角色 |
|---|---|---|
| `library/src/main/ets/bridge/HostBridge.ets` | **46** | 本模块主体（注册表 + 分发）✅ |
| `library/src/main/ets/runtime/Types.ets` | **49** | `HostBridgeHandler` 类型（S3 契约）✅ |
| `library/Index.ets` | **21** | barrel：导出 `HostBridge` ✅ |
| `library/src/main/ets/runtime/NodeRuntime.ets` | **115** | 上游 001：生命周期/状态机（`host` 访问器 ⬜） |
| `library/src/main/ets/log/Logger.ets` | **53** | 上游 006：hilog + 读回 ✅ |
| `library/src/main/ets/util/Env.ets` | **65** | 上游 006：路径/环境 |
| `library/src/main/cpp/node_bridge.c` | **295** | 上游 002：只导出 3 接口（S8）——线程安全传输层要扩展它 ⬜ |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | **15** | 原生模块类型声明（扩展 NAPI 面必须同步，S1/S8）⬜ |
| `library/src/main/cpp/CMakeLists.txt` | **16** | S6 落点约束 |
| `payload/selfcheck.js` | **84** | 自检载荷：`/facts`（现无桥字段 ⬜ FR-003-024）、`/log` 读回 ✅ |
| `payload/bootstrap.js` | **64** | 载荷引导（Node 自解包路线） |
| `payload/README.md` | **21** | 载荷说明（`host` 内置模块在此无踪迹 ⬜） |
| `library/oh-package.json5` | **16** | HAR 元数据（零依赖 ✅） |
| `docs/000-工程规划.md` | **1298** | 唯一权威（§2.3 / §5.3 / §5.4 / §5.7 / §5.10 / §6.1 / §8） |
| `specs/constitution.md` | **163** | 治理原则（C1–C7 / S1–S10） |
| `specs/README.md` | **25** | 编号表 —— ⚠️ 现记作 `003-host-bridge`，与本规格目录名不同，按宪法 §六.1 需同步 ⬜ |
| `tests/README.md` | **28** | host 侧测试说明（测试文件待建 ⬜ T-003-01） |
| `specs/003-host-bridge-json-transport/spec.md` · `plan.md` | 本文件对 | 本模块规格 |

**Phase 2 新增（⬜，暂无行数）**：桥件 C 侧代码（线程安全函数 + 入队/回投，建议并入 `library/src/main/cpp/` 并受 S6/S7/S8 约束）· Node 侧内置模块（如 `payload/lib/host.cjs` 或由桥件直接注册的 builtin）· `tests/host-bridge-protocol.test.mjs`。

---

## 9. Phase 2 待实现清单（逐条 + 验收判据）

| # | 事项 | 验收判据 | 依赖 |
|---|---|---|---|
| P2-003-01 | **`napi_threadsafe_function` 传输层**：Node 线程入队 → ArkTS 主线程执行 → 回投结算 | AS-003-04 通过；真机无跨线程崩溃；主线程在等待期间仍处理其它事件；每次调用只结算一次 | P2-003-08（002 的 NAPI 面扩展，S8） |
| P2-003-02 | **`unregister`** + 名字校验（非空、`maxNameLength`） | AS-003-14 通过；未注册注销返回 `false` 不抛 | 无 |
| P2-003-03 | **超时**：默认 **10 s**（规划），可被能力/调用方覆盖；改正 `HostBridge.ets:10` 的 30 s 注释 | AS-003-05 通过；「永不 settle 的处理器」在超时后结算一次 | P2-003-01 |
| P2-003-04 | **`capBytes`（默认 8 MiB）**：入参与出参都校验，按 UTF-8 字节计 | AS-003-06 通过；中文载荷不被低估放行；超限**不执行**处理器 | 无 |
| P2-003-05 | **有界队列 + 并发上限 + `queue-full`** | AS-003-11 通过；没有请求被静默丢弃；队列深度可诊断 | P2-003-01 |
| P2-003-06 | **错误构造修复**（缺陷 A/B/C/D）：统一 `serialize`、`describeThrow`、返回值类型校验、最后防线 | AS-003-09 / AS-003-10 通过；T-003-01 全绿 | 无 |
| P2-003-07 | **桥的日志接线**（缺陷 F）：未注册/抛错/超时/溢出/超限进 hilog + 日志文件 | AS-003-12 通过；`/log` 读回可见 | `Logger.ets` ✅ |
| P2-003-08 | **Node 侧内置模块** `@fellow99/node-bridge/host`（`invoke` / `handle` / `list`），经 builtin 暴露，无需 npm | 真机 `require(...)` 成功 + 一次往返 + 一次失败（`unregistered`）可被 catch 到 `code` | P0-11（Addon 符号可见性 ⬜）；002 |
| P2-003-09 | **反向通道两条**：启动参数（已有，属 001）+ `shutdown` 钩子；**不**做通用入口 | AS-003-13 通过（API 面上不可达） | 001 |
| P2-003-10 | **`runtime.facts` 桥字段 + `/facts` 的 `hostBridge` 字段** | FR-003-024 + T-003-03：`hdc fport` + `curl` 一条命令可见能力清单与上限/超时值 | `selfcheck.js` ⬜；001 |
| P2-003-11 | **`NodeRuntime.host` 暴露** + `Index.ets` / `Types.ets` 同步（S2/S3），版本号按 §7.5 提 | 消费方能 `runtime.host.register(...)`；HAR 公共 API 面与 README 一致 | 001 |
| P2-003-12 | **能力 schema 与消费方共同签收**（§4.4 草案转正），并写进接入文档（含 `maxInFlight × capBytes` 的驻留上界） | 双方文档同版本号签收；消费方实现 `perm.*` / `fs.pick*` / `shell.*` / `notify.*` 时不再回头改名字 | 消费方 |
| P2-003-13 | **host 侧契约测试** `tests/host-bridge-protocol.test.mjs`（T-003-01 / T-003-02） | 断言「输出永远可解析」「失败体字段齐全」；覆盖边界与重入 | 无 |
| P2-003-14 | **规格编号表同步**：`specs/README.md` 的 `003-host-bridge` 与本规格目录名对齐（宪法 §六.1） | 编号表与目录名一致 | 流程项 |
