# overall-data-model.md —— `@fellow99/node-bridge` 数据模型

> **性质**：项目级数据模型规格。覆盖 ① 运行时锁文件 ② ArkTS 公共类型 ③ 运行时状态机 ④ 宿主桥消息模型 ⑤ 文件系统实体 ⑥ 环境变量契约。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）· 源码 ✅实测（行号为本仓库当前行号）。
> **标记**：✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突或风险。凡「⬜ 规划未实现」= 代码里确实没有该字段/类型。
>
> ⚠️ **引用基准**：`runtime.lock.json` 与 `provision.mjs` 的名称/字段是**权威且稳定的**；ArkTS 侧行号取自 2026-10-16 成稿快照（该批文件随后有并行实现推进）⇒ **ArkTS 与 C 侧以类名 / 成员名 / 函数名为准**。
> **版本**：v1.0 · 2026-10-16。

---

## ① `runtime.lock.json` —— 运行时唯一事实源（✅ 全部已实现且已落值）

**顶层结构**：`{ schema, active, runtimes[], libcxx, localStore, openItems }`（严格 JSON，禁止注释；`provision.mjs:54-55` 解析失败即 `exit 2`）。

### 1.1 `schema`

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `schema` | `number` | 结构版本号 | 必须是整数；结构变更必须提号（当前 `1`），工具侧据此拒绝不认识的版本 | `1` |

### 1.2 `active`

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `active.node` | `string` | 当前选用的运行时版本串（含前缀 `v`） | 必须能在 `runtimes[].node` 中找到**完全一致**的项；换版本**只改这一行** | `"v24.2.0"` |
| `active.abi` | `string` | 当前选用的 ABI | 同上，必须能在 `runtimes[].abi` 中找到；工具参数 `--abi` 可覆盖 | `"arm64-v8a"` |

> 语义：`active` 是**选择器**，`runtimes[]` 是**候选集合**（规划 §附录 G.7）。`provision.mjs:57-63` 按 `(node, abi)` 定位唯一记录，找不到即列出可用组合并 `exit 2`。

### 1.3 `runtimes[]`（数组；每个可用产物一条）

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `node` | `string` | Node 版本串 | 与 `active.node` 对齐；供人读与版本矩阵 | `"v24.2.0"` |
| `nodeModuleVersion` | `number` | `NODE_MODULE_VERSION`（原生 addon ABI） | 必须等于 `SONAME` 尾号；决定 addon 兼容性 | `137` |
| `abi` | `string` | ABI 标识 | 与 `deployAs` 的落点目录名对应 | `"arm64-v8a"` |
| `file` | `string` | **上游资产原名** | 不得改名（改名后无法自证对应哪个 URL，附录 G.2） | `"libnode-arm64.so"` |
| `deployAs` | `string` | 投放进 HAP 时的**目标文件名** | 必须是 `libnode.so`：`dlopen` 只认裸名（§D.8） | `"libnode.so"` |
| `size` | `number` | 字节数 | 门禁⑦之一；与实测不一致即硬失败 | `126809264` |
| `sha256` | `string` | 小写十六进制摘要 | 门禁⑥；**唯一允许的版本指纹** | `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` |
| `soname` | `string` | ELF `DT_SONAME` | 与 HAP 内文件名**不一致**是已知事实（→ 全局符号表策略 R18） | `"libnode.so.137"` |
| `needsLibcxx` | `bool` | 是否依赖 `libc++_shared.so` | 为 `true` 时投放必须连带 `libcxx` 一起放（硬约束 ②） | `true` |
| `embeds.icu` | `bool` | ICU 数据是否内嵌 | 为 `false` 则 HAP 还需外置 `icudtl.dat`（本产物内嵌） | `true` |
| `embeds.v8Snapshot` | `bool` | V8 快照是否内嵌 | 同上（`snapshot_blob.bin` 零命中） | `true` |
| `flags.exposeInternals` | `bool` | 产物是否编译进 `--expose-internals` | 硬约束 ⑤ 的执行前提 | `true` |
| `flags.emitJitless` | `bool` | 产物是否支持 `--jitless` | 决定路线 I（无 ACL 兜底）是否可用 | `true` |
| `signed.codesign` | `bool` | 是否含 `.codesign` 段 | HAP 内**不需要**（G5 / §D.6/§D.9）；只影响独立分发 | `false` |
| `signed.note` | `string` | 签名判据说明 | 自由文本，必须写出「哪些场景需要签名」 | ✅（说明「仅有 `.note.ohos.ident`；独立分发请用 `ohos-selfsign.mjs`」） |
| `source.kind` | `string` | 来源类型 | 枚举化（当前 `github-release` / `null`） | `"github-release"` |
| `source.repo` | `string` | 来源仓库 | 与 `url` 一致；供应链审计锚点 | `"electerm/ohos-node-shared"` |
| `source.tag` | `string` | 来源 tag | 同上 | `"ohos-node-shared-v24.2.0"` |
| `source.asset` | `string` | 来源资产名 | 应与 `file` 一致 | `"libnode-arm64.so"` |
| `source.url` | `string` | 可复现的下载地址 | 必须可直接 `curl`；`--download` 的兜底来源 | ✅ GitHub Release URL |
| `source.license` | `string[]` | 许可清单 | **G4 的原始依据**（随包许可清单由此生成） | `["Node.js (MIT)", "build scripts (MIT, electerm/ohos-node-shared)"]` |
| `source.builtWith` | `string` | 构建线索 | 自建配方与产物可比对 | OHOS SDK + LLVM-19；`--shared --cross-compiling --openssl-no-asm --v8-disable-temporal-support` |
| `mirror.kind` | `string\|null` | 镜像类型 | `null` = 暂无镜像（第三方需按 `source.url` 自取） | `null` |
| `mirror.note` | `string` | 镜像说明 | 必须解释 `null` 的原因 | ✅ |
| `gates.typeDyn` | `bool` | 门禁① `ET_DYN` | 七项全 `true` 才允许投放 | `true` |
| `gates.ptInterp` | `number` | 门禁② `PT_INTERP` 计数 | **必须 `0`**（PIE 直接拒） | `0` |
| `gates.machineAArch64` | `bool` | 门禁③ `e_machine` | 必须 AArch64 | `true` |
| `gates.neededLibcxx` | `bool` | 门禁④ `DT_NEEDED` 含 libc++ | 必须为真 | `true` |
| `gates.exportsNodeStart` | `bool` | 门禁⑤ `node::Start` 已导出 | 必须为真 | `true` |
| `gates.sha256Match` | `bool` | 门禁⑥ 摘要一致 | 必须为真 | `true` |
| `gates.versionGeq2219` | `bool` | 门禁⑦ 大小一致 + 版本串存在（`>=22.19.0`） | 必须为真 | `true` |
| `verifiedOn` | `string` | 真机验证日期 | `YYYY-MM-DD`；改锁文件必须重跑并回写（宪法 §六-2） | `"2026-10-16"` |
| `verifiedDevice` | `string` | 验证设备标识 | 形如 `<机型> / <OS 版本> / API <n> / <abi>` | `"HAD-W32 / HarmonyOS 6.1.0 / API 26 / arm64-v8a"` |
| `verifiedNotes` | `string` | 验证结论备注 | 必须写出「验到了什么程度」与残留平台前提 | ✅（写明 `--jitless` 轮次跑通 + 无 ACL 即 SIGTRAP 属平台前置、与产物无关） |

### 1.4 `libcxx`

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `libcxx.file` | `string` | 部署文件名 | 必须与 `DT_NEEDED` 里的名字逐字一致（否则加载器找不到） | `"libc++_shared.so"` |
| `libcxx.from` | `string` | 来源 | 目前为 `ohos-sdk`（**刻意不固化哈希**：随 SDK 版本变化，附录 G.7） | `"ohos-sdk"` |
| `libcxx.sdkRelPath` | `string` | SDK 内相对路径 | `provision.mjs:198-212` 用它 + 5 个根路径候选定位 | `native/llvm/lib/aarch64-linux-ohos/libc++_shared.so` |
| `libcxx.abi` | `string` | ABI | 与 `runtimes[].abi` 对齐 | `"arm64-v8a"` |

### 1.5 `localStore`

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `localStore.path` | `string` | 本地运行时缓存目录（相对**库仓库根**） | 第一优先来源；不外发（父工程 `.gitignore`） | `"../ohos-node-runtime"` |
| `localStore.envOverride` | `string` | 覆盖该路径的环境变量名 | CI / 另一台机器用 | `"OHOS_NODE_RUNTIME_DIR"` |
| `localStore.layout` | `string` | 目录布局约定（人读） | 工具实际尝试 3 个布局候选（`node-<v>/<file>` → `<v>/<file>` → `<file>`） | ✅ |

### 1.6 `openItems`

| 字段 | 类型 | 含义 | 约束 | 现值 ✅ |
|---|---|---|---|---|
| `openItems[]` | `string[]` | **故意留在文件里的未闭环项** | 必须写清「缺什么 + 触发条件 + 处置方向」；不得为空数组（空 = 假装完成） | 3 条：镜像发布未建 / 自建配方延后 / x86_64 不做 |

---

## ② ArkTS 侧类型（✅ 已实现 vs ⬜ 规划）

### 2.1 已实现（`runtime/Types.ets`，✅ 全部可编译、已随 HAR 发布）

| 类型 | 定义 | 字段级说明 | 与规划的关系 |
|---|---|---|---|
| `NodeState`（enum） | `IDLE='idle'` / `STARTING='starting'` / `RUNNING='running'` / `FAILED='failed'` | **字符串值**而非数字：可安全落日志/JSON；`FAILED` 为**终态**（文档明文） | ⚠️ 规划 §5.3 写的是联合类型 `NodeRuntimeState` 且含 `stopping`/`stopped`；实现是 4 值 enum、名为 `NodeState` ⇒ **命名与取值都不一致**（见 §2.3） |
| `NodeRuntimeOptions`（interface） | `flags?: string` / `scriptPath: string` / `libDir?: string` / `homeDir?: string` / `logPath?: string` | `flags` 为**空格分隔字符串**（原生层 `strtok` 切词，`MAX_ARGS-1` 上限）；`scriptPath` 必填且为绝对路径；`libDir` 默认 `context.bundleCodeDir`；`homeDir` 默认 `context.filesDir`；`logPath` 默认 `<homeDir>/payload/node.log` | ⚠️ 规划字段集完全不同（`entry/payloadRoot/archive/archiveSha256/argv/execArgv/env/cwd/capBytes/logRingSize/jitless/onLog/onStateChange`）⇒ 见 §2.3 |
| `NodeStartResult`（interface） | `ok: boolean` / `code: number` / `state: NodeState` / `message: string` | `ok=true` **只代表已投递**；`code=0` 已投递，`code=-1` = 幂等拒绝（非 `IDLE` 再次启动），其它值为 `pthread_create` 的 `rc`；`message` 为人读原因/下一步提示 | ✅ 与「投递语义」一致（实现比规划更明确：规划 `start()` 返回 `Promise<void>` 无结果对象） |
| `HostBridgeHandler`（type alias） | `(argsJson: string) => string` | **入参与返回值都是 JSON 字符串**；返回值由处理器自己决定（库不归一化成功形态，见 §④） | ⚠️ 规划允许返回 `string \| Promise<string>`；实现是**同步签名**（异步 ⬜ Phase 2） |

### 2.2 ⬜ 规划有、当前**未实现**的类型

| 类型 | 规划定义（§5.3） | 用途 | 缺失影响 |
|---|---|---|---|
| `NodeRuntimeState` 的扩展值 | `'stopping'` / `'stopped'` | 关停流程可见 | 状态机与生命周期 API 面不完整（Phase 1–2） |
| `NodeLogEntry` | `{ at: number; stream: 'stdout'\|'stderr'\|'system'; text: string }` | 日志环元素；界面渲染 | ArkTS 侧无结构化日志（只有 `Logger.tail` 读文件文本） |
| `CrashRecord` | `{ at: number; stage: string; signal?: string; hint?: string; logTail: string[] }` | 崩溃记录 | 崩溃只能读散落在 `node.log` 里的 `CRASH sig=…` 行 |
| `NodeRuntimeOptions` 扩展字段 | `entry` / `payloadRoot` / `archive` / `archiveSha256` / `argv` / `execArgv` / `env` / `cwd` / `capBytes` / `logRingSize` / `jitless` / `onLog` / `onStateChange` | 载荷/环境/观测/桥的全套入口 | 载荷分发、环境透传、上限、回调全部缺失 |
| `NodeHostBridge` | `register(name, handler)` / `unregister(name)` / `list(): string[]` | 桥的**公共**入口（挂在 `NodeRuntime.host`） | 桥只能通过 `HostBridge` 直接实例使用（`Index.ets:19` 已导出但未挂到 `NodeRuntime`） |
| `NodeRuntime` 成员 | `static readonly instance` / `readonly pid` / `waitUntilRunning(timeoutMs?)` / `logs()` / `lastCrash()` / `shutdown(reason)` / `readonly host` | 会话与观测面 | ⬜ Phase 1–2；实现目前是 `getInstance()`（方法）+ `getState()`（方法）而非 `readonly` 属性 |

### 2.3 ⚠️ 命名/形态对照表（规划 → 实现，评审必须按实现写代码）

| 规划（§5.3） | 实现（✅） | 处置 |
|---|---|---|
| `NodeRuntimeState`（联合类型，6 值） | `NodeState`（enum，**6 值**：`idle`/`starting`/`running`/`failed`/`stopping`/`stopped`） | ✅ 已对齐（B3/R2）：沿用实现名 `NodeState`，取值已补齐（`Types.ets:17-24`） |
| `NodeRuntime.instance`（静态只读） | `NodeRuntime.getInstance()` | 保留实现形态（ArkTS 静态 getter 限制）；`Index.ets` 已导出 |
| `runtime.state`（只读属性） | `getState(): NodeState` | 同上 |
| `runtime.pid` | `getPid(): number` | ✅ 已实现（`NodeRuntime.ets`；`process.pid` 不可用时返回 `-1` 并 `warn`，契约 §2.6） |
| `start(opts): Promise<void>` | `start(context, options): NodeStartResult` | 实现形态更符合「投递语义」；规划需同步 |
| `NodeRuntimeOptions.entry` | `scriptPath`（绝对路径） | 语义接近但缺「相对 `payloadRoot`」的解析能力 |
| `NodeRuntimeOptions.execArgv: string[]` | `flags: string`（空格分隔）**与** `execArgv: string[]` | ✅ 两者都支持：`execArgv` 给了就覆盖 `flags`（`flags = execArgv.join(' ')`）；契约 §2.3 |
| `NodeRuntimeOptions.payloadRoot` 默认 `<filesDir>/payload` | `Env.payloadDir` = `<filesDir>/payload` | ✅ 已对齐（B6/R2）：实现值 = `<filesDir>/payload`；日志 `<filesDir>/payload/node.log`、崩溃记录 `<filesDir>/node-bridge/last-crash.json`；规划草案的 `<filesDir>/node-bridge/payload` 被取代 |
| `runtime.host: HostBridge` | ✅ 已实现 `get host(): HostBridge`（`NodeRuntime.ets`） | ✅ B3/R2 复核 |
| Node 侧 `require('@fellow99/node-bridge/host')` | 无 | Phase 2（桥的 Node 半） |

---

## ③ 运行时状态机

### 3.1 状态定义（✅ 实现的 6 态）

| 状态 | 字符串值 | 含义 | 可终止？ |
|---|---|---|---|
| `IDLE` | `idle` | 尚未投递；唯一允许调用 `start()` 的状态 | 否 |
| `STARTING` | `starting` | 已投递到原生层，运行时装填中；**不代表已就绪** | 否 |
| `RUNNING` | `running` | 由**消费方**在探活成功后 `markRunning()` 认定 | 否 |
| `FAILED` | `failed` | **终态**：投递失败 / 探活失败 / 崩溃 | 是（终态） |
| `STOPPING` | `stopping` | `shutdown()` 标记：已记录关停请求（**进程内 Node 无法优雅停止**，不做实际关停） | 否（仅标记） |
| `STOPPED` | `stopped` | 终态枚举值（Node 结束后的停止标记） | 是（终态） |

### 3.2 迁移表（✅ 逐条对应代码）

| # | 起始 | 事件 | 触发者 | 目标 | 副作用 | 代码 |
|---|---|---|---|---|---|---|
| T1 | `IDLE` | `start(ctx, opts)` 首次调用 | 消费方 | `STARTING` | 建目录、记 `options`/`logPath`、调原生 `start()` | `NodeRuntime.ets:71-78` |
| T2 | `STARTING` | 原生 `start()` 返回非 0 | 引擎 | `FAILED` | `Logger.error('… rc=…')` + 返回 `{ok:false,code:rc,state:FAILED,message}` | `NodeRuntime.ets:83-92` |
| T3 | `STARTING` | 原生 `start()` 返回 0 | 引擎 | `STARTING`（不变） | 返回 `{ok:true,code:0,message:'已投递启动'}` + `Logger.info` | `NodeRuntime.ets:94-95` |
| T4 | `STARTING` | `markRunning()` | **消费方**（探活成功） | `RUNNING` | 无日志（静默成功） | `NodeRuntime.ets:102-106` |
| T5 | `STARTING` | `markFailed(reason)` | 消费方（探活超时） | `FAILED` | `Logger.error('Node 运行失败：'+reason)` | `NodeRuntime.ets:109-113` |
| T6 | `RUNNING` | `markFailed(reason)` | 消费方 / 故障检测 | `FAILED` | 同上 | `NodeRuntime.ets:109-113` |

### 3.3 **不可迁移**说明（必须显式存在，否则会被误实现）

| 不可发生 | 原因 | 依据 |
|---|---|---|
| `FAILED → *`（任何状态） | 进程内 `node::Start` **只能调用一次**；崩溃是终态 | 硬约束 ⑥ / C5 / `NodeRuntime.ets:12-17` 注释 |
| `RUNNING → IDLE` / `STARTING → IDLE` | 无「停止」语义：真正的停止只能是进程退出 | 规划 §5.2 |
| `IDLE → *`（任意非 `start` 的迁移） | `markFailed` 在 `IDLE` 下**静默返回**（守卫 `state !== IDLE`）⇒ 未启动就报失败不会改状态、也不写日志 | ⚠️ `NodeRuntime.ets:110`（**静默 no-op**，与 C2 有张力：行为不可见） |
| 二次 `start()` 改变状态 | 守卫：非 `IDLE` 直接返回 `{ok:false,code:-1,state:<当前>,message}`，**不保留**首次失败原因字段 | ⚠️ `NodeRuntime.ets:62-69`（C5 缺口：原因只在首次调用的返回值与日志里） |
| `stopping` / `stopped` 迁移 | 六态枚举已实现：`shutdown()` 标记 `stopping`（**不假装能停**）；`stopped` 为终态值 | 规划 §5.2/§5.3 · `Types.ets:17-24` | ✅ 2026-10-17 |
| 运行期改变启动参数后重启到新参数 | `execArgv` 启动即固定，库不提供 push | C4 / 硬约束 ⑤ |

### 3.4 与原生层的状态对应（⚠️ 两套状态不同步）

| ArkTS 状态 | 原生层可观测项 | 一致性 |
|---|---|---|
| （无对应） | `g_log_path` / `g_ctx` 已填 | 投递前 |
| `STARTING` | `stage()` ∈ `init\|stdio\|dlopen\|dlsym\|start`，`lastError()` 非空表示该阶段失败，`g_node_running == 0`，`g_dispatched == 1` | ✅ 现在**可以区分**「线程刚起 / stdio 失败 / dlopen 失败 / dlsym 失败」——靠 `stage()` + `lastError()`；⚠️ 但 **ArkTS 侧尚未调用这两个探针** |
| `RUNNING`（消费方认定） | `g_node_running == 1`，`isRunning()` 返回 1，`stage()` = `start` | ✅ 可交叉验证 |
| `FAILED`（崩溃） | `g_node_running` 归 0（仅当 `node::Start` 返回过）＋ 日志内 `CRASH sig=…` ＋ `last-crash.json` | ⚠️ 原生崩溃后 ArkTS 不会自动变 `FAILED`（需消费方调用 `markFailed`）；`lastCrash()` 读取接口 ⬜ |

---

## ④ 宿主桥消息模型（`003-host-bridge`）

### 4.1 载体与形态

| 项 | 设计 | 现状 |
|---|---|---|
| 载体 | **JSON 字符串**（入参 `argsJson`、返回值均为 `string`），不受参数个数/类型限制 | ✅ `Types.ets:48-49` / `HostBridge.ets:35` |
| 方向 1（Node → ArkTS） | 脚本侧调用 → 入队 → ArkTS 主线程执行处理器 → 结果回投 → Node 侧 Promise resolve | ⚠️ 当前 `dispatch` 是**同线程直调**（无队列、无线程安全） |
| 方向 2（ArkTS → Node） | 只有两条：`start()` 的启动参数、`shutdown()`；**不提供**通用「调 Node 函数」入口 | ✅ 只有前者存在 |
| 线程安全 | `napi_threadsafe_function`（在 ArkTS 侧创建，回调在 ArkTS 线程执行）；队列**有界**，溢出即报错 | ⬜ 规划未实现（Phase 2） |
| 超时 | 默认 **10 s** | ⬜ 规划未实现 |
| 载荷上限 `capBytes` | 默认 **8 MiB**；超限必须是结构化错误 | ⬜ 规划未实现 |
| 能力清单（v1） | `runtime.facts` · `perm.check` · `perm.openAppInfo` · `fs.pickFiles` · `fs.pickFolder` · `shell.openExternal` · `notify.show` · `log.hilog` | ⬜ 规划未实现（库只提供传输层，具体能力由消费方注册） |
| Node 侧入口 | `require('@fellow99/node-bridge/host')` → `host.invoke(name, json)` / `host.handle(name, fn)` | ⬜ 规划未实现 |

### 4.2 消息形态（**失败路径由库归一化，成功路径不归一化**）

| 场景 | 返回字符串 | 是否由库生成 | 代码 |
|---|---|---|---|
| 能力**未注册** | `{"ok":false,"error":"unregistered","name":"<name>"}` | ✅ 库生成 | `HostBridge.ets:37-39` |
| 处理器**抛错** | `{"ok":false,"error":"handler-threw","name":"<name>","detail":<JSON 化的异常>}` | ✅ 库生成 | `HostBridge.ets:42-44` |
| 调用成功 | **处理器返回什么就是什么**（库不做包装） | ❌ 处理器自己决定 | `HostBridge.ets:41` |

⚠️ **数据模型缺口**：成功形态**没有约定** `ok:true`。`{"ok":…}` 只是失败路径的**约定字段**，库不校验、不补全 ⇒ 脚本侧无法用统一判据区分「成功」与「处理器返回了一个奇怪的字符串」。**建议 Phase 2 定为**：成功一律 `{"ok":true,"value":<任意>}`，失败一律 `{"ok":false,"error":"<枚举>",...}`，并由库在返回值未含 `ok` 字段时**包一层**（`{"ok":true,"value":<原值>}`）。

### 4.3 错误码枚举（`error` 字段取值）

| 值 | 触发条件 | 现状 |
|---|---|---|
| `unregistered` | 能力名未注册 | ✅ 已实现 |
| `handler-threw` | 处理器同步抛错 | ✅ 已实现 |
| `handler-rejected` | 处理器返回的 Promise reject（异步） | ⬜ Phase 2（当前无异步支持） |
| `timeout` | 超过 10 s | ⬜ Phase 2 |
| `too-large` | 载荷超过 `capBytes` | ⬜ Phase 2 |
| `queue-full` | 桥队列溢出 | ⬜ Phase 2 |
| `shutting-down` | 关停窗口期内拒绝新调用 | ⬜ Phase 2 |

**纪律（C2）**：任何新错误路径必须用**枚举值**表达（不得自由文本），且**不得**以空字符串/空数组/假成功代替错误。反面教材：旧壳 `ExternalWeb.Open` 未注册却直接解引用，把整个应用打崩（规划 §5.4 / R15）。

---

## ⑤ 文件系统实体

| 实体 | 路径（相对应用沙箱） | 谁创建 | 谁读 | 现状 |
|---|---|---|---|---|
| 载荷目录（实现口径） | `<filesDir>/payload/` | `Env.ensureDir`（ArkTS，`Env.ets:39-42`）；原生层另建 `<home>/tmp` 与 `<home>/node-bridge/` | Node / ArkTS | ✅ 已实现 |
| 载荷根（规划**草案**口径） | `<filesDir>/node-bridge/payload` | 规划 | — | ❌ **已被实现取代**（B6/R2）：实现值 = `<filesDir>/payload`；`docs/000-工程规划.md` 保留历史措辞 |
| 临时目录 | `<filesDir>/tmp/` | `Env.ensureRuntimeDirs` ✅ + 原生 `mkdir(tmp, 0755)` ✅ | Node（`TMPDIR`/`TMP`/`TEMP`） | ✅ |
| 日志文件 | `<filesDir>/payload/node.log`（常开 fd，单次 `write()` 整行追加，`0644`） | 原生 `open_log_fd()` + 独立 reader 线程（stdio pipe 排空） | ArkTS `Logger.tail`、自检 `/log`（读尾 8192 字符） | ✅ 已实现；**行格式 `<stream> <epochMs> <text>`**（`stream ∈ out\|err\|sys`）—— 改格式必须同时改 ArkTS 解析 |
| 崩溃记录 | `<HOME>/node-bridge/last-crash.json`（`HOME` 默认 = `context.filesDir`） | ✅ **原生 `crash_handler()` 已写**（`O_TRUNC` 覆盖，内容 `{at,stage,signal,hint}`） | ✅ ArkTS `lastCrash()` 已实现（含 JSON 损坏时从日志尾降级重建） | ✅ **两侧齐备**（2026-10-17） |
| 幂等 marker | `<payloadRoot>/.ready-<sha256 前 12 位>`（JSON：完整 `sha256` + `files` + `bytes` + `skipped` + `at`） | `payload/bootstrap.js`（已实现） | 同上（命中即跳过解包） | ✅ 已实现（B7/R2：**不是** `<archive 基名>.sha256`） |
| 宿主载荷（只读） | `resources/resfile/<app>/`（安装目录，只读直读） | 消费方构建期 | Node | ⬜ 库侧引导逻辑未实现 |
| 运行时与引导件 | HAP `libs/arm64-v8a/`（真机实际落 `/data/storage/el1/bundle/libs/arm64/`） | 构建 + 投放 | 动态链接器（`dlopen` 裸名） | ✅ |
| 归档中转（可选） | 归档由 `rawfile`/`resfile` 提供（只读）⇒ 解包目标必须落**可写沙箱** | — | — | ⬜ |

**写权限与命名纪律**

| 规矩 | 原因 |
|---|---|
| 日志/临时/载荷目录**只能在 `<filesDir>` 之下** | `HOME` 重定向的落点；沙箱外（如 `/storage/Users/currentUser`）会 `EPERM` |
| 文件写入后必须能被 **Node 读回** | 「谁写谁读」（C3 / 硬约束 ④） |
| 需要独占创建时用 `open(dst,'wx')`（保住 `EEXIST`）；已确认不存在才 `rename` | 平台无硬链接（`link` EACCES） |
| 一律 copy 物化，不用 `symlink` | 应用域与 shell 域均拒（EACCES） |
| 日志追加写、不轮转（库侧） | 崩溃证据不能因为轮转被截掉；轮转/裁剪由消费方决定 |

---

## ⑥ 环境变量契约

| 变量 | 值 | 谁设 | 何时 | 理由 | 现状 |
|---|---|---|---|---|---|
| `HOME` | `options.homeDir ?? context.filesDir` | **库**（原生层 `setenv`，覆盖式 `1`） | `node::Start` 之前 | `os.homedir()` 默认指向沙箱外 ⇒ 文件选择器 `EPERM`（症状 #10）；同时决定崩溃记录落点 | ✅ `bootstrap()` |
| `USERPROFILE` | 同 `HOME` | **库** | 同上 | Windows 风格 API 兼容（Node 在多平台探测用户目录） | ✅ `bootstrap()` |
| `TMPDIR` | `<HOME>/tmp` | **库** | 同上 | `/tmp` 与默认 `os.tmpdir()` 不可写 | ✅ `bootstrap()` |
| `TMP` | 同上 | **库** | 同上 | 同上（多键冗余，跨库兼容） | ✅ `bootstrap()` |
| `TEMP` | 同上 | **库** | 同上 | 同上 | ✅ `bootstrap()` |
| `UV_USE_IO_URING` | `0` | **库**（强制） | 同上 | libuv 初始化会无条件探测被 trap 的 syscall（⚠️ 该变量在部分 libuv build 里**不生效** ⇒ 不能当唯一手段，SIGSYS shim 是主手段） | ✅ `bootstrap()` |
| `envPairs`（`K=V` 逐行，上限 4096 B） | 由消费方定义 | **消费方**（经 `start()` 第 6 参） | 同上 | 应用语义变量由调用方显式传入（C1）；原生 `apply_env_pairs()` 覆盖式 `setenv` | ⚠️ C 侧 ✅ / **ArkTS 侧 `start()` 尚未传该参数**（`NodeRuntimeOptions` 无 `env` 字段） |
| `NODE_ENV` | `production` | **库**（默认） | 同上 | 与生产语义一致；消费方可经 `envPairs` 覆盖 | ✅ `bootstrap()` |
| `NODE_OPTIONS` | **清空**（`unsetenv`） | **库** | 同上 | 避免宿主环境污染运行时行为（旧壳构建期同做法） | ✅ `bootstrap()` |
| `LD_LIBRARY_PATH` 等链接搜索路径 | **不改** | — | — | 依赖 `DT_RUNPATH`/同目录加载；改动会连带影响宿主（规划 §5.6 明文） | ✅ 未触碰 |
| 应用语义变量（如 `PI_*`、密码、根目录白名单） | 由消费方定义 | **消费方**（经 `start()` 第 6 参 `envPairs`） | 启动前 | 库不认识应用语义（C1）；原生 `apply_env_pairs()` 覆盖式 `setenv` | ⚠️ C 侧 ✅ / **ArkTS 侧 `start()` 尚未传该参数**；且 `payload/bootstrap.js:49` 仍读应用特有变量（C1 越界） |
| `NO_PROXY` / `no_proxy` | 追加 loopback 与局域网地址 | **消费方** | 启动前 | 避免代理拦截本机请求 | ⬜ 消费方 |
| `SELFCHECK_PORT` | `15577`（默认） | 自检脚本 | 运行期 | 自检端口可覆盖；**产品路径应由载荷随机/先探测空闲**（硬约束 ⑰） | ✅ `payload/selfcheck.js:19` ⚠️ 默认固定 |
| `OHOS_NODE_RUNTIME_DIR` | 本地运行时缓存目录 | host 工具用户 | 投放时 | 覆盖 `localStore.path`（CI / 另一台机器） | ✅ `provision.mjs:74-77` |
| `NODE_USE_ENV_PROXY` | `1` | host 工具用户 | 联网投放时 | Node 内置 `fetch` 默认**不读**代理变量（Node ≥ 24） | ✅ `provision.mjs:250-254` |
| `DEVECO_SDK_HOME` / `OHOS_SDK_NATIVE` | SDK 根 | 构建者 | 构建 / 投放时 | 定位 `libc++_shared.so` 与工具链 | ✅ `provision.mjs:200-206` |
| `SIGN_MODE` / `CERTPATH` / `STORE_FILE` / `PROFILE` / `KEY_ALIAS` / `KEY_PASSWORD` / `STORE_PASSWORD` / `SIGN_ALG` | 签名材料 | 构建者（CI） | 构建时 | 签名材料不落仓库（`hvigorfile.ts:78-96`） | ✅ |

**纪律**：库只设「自己必须负责的默认值」（沙箱重定向、平台探测开关、宿主污染清除）；**应用语义变量一律由消费方经 `env` 传入**；`env` 的合并顺序必须明确（规划：库默认值 → 消费方 `env` 覆盖）⬜ 待 Phase 1 定义并写入类型契约。
