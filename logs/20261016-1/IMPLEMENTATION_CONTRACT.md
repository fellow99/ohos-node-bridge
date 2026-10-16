# 000-scaffold / Phase 1 —— 实现契约（冻结版）

> 本文件是 `ohos-node-bridge` Phase 1 实现的**接口冻结文档**。多个并行实现者以它为准，
> 不得单方面改动其中的签名、字符串字面量与文件路径。需要变更时先改本文件并通知全部实现者。
>
> 依据：`docs/000-工程规划.md` §5.3 / §5.4 / §5.5 / §5.6 / §5.7 / §5.10 ⑤⑰⑱ / §D.10 ⑰⑱ / §8 Phase 1。
> 宪法：`specs/constitution.md`（C1–C7、S1–S10；**C2 不隐藏平台真相** 是全篇红线）。

---

## 0. Phase 1 范围

| 模块 | Phase 1 是否在范围 | 本契约覆盖 |
|---|---|---|
| `001-runtime-core-lifecycle` | ✅ | §2 |
| `002-napi-bootstrap-native-loader` | ✅ | §1 |
| `003-host-bridge-json-transport` | 部分（ArkTS 侧 + Node 侧 API 面；**传输层属 Phase 2**） | §3 |
| `004-payload-bootstrap-entry-resolver` | ✅ | §4 |
| `005-provision-verify-elf-gates` | ✅（已实现，仅补 host 侧门禁脚本） | §5 |
| `006-observability-logring-crash` | ✅ | §1.3 / §1.4 / §2.3 |
| `007-distribution-har-package` | ✅（补许可清单 + 接入说明） | §5 |

**Phase 1 出口判据（规划 §8）**：① 自检载荷与消费方载荷都能起；② 状态机与日志环在 ArkTS 可见；
③ 崩溃记录可读；④ 载荷就绪幂等（二次启动跳过）；⑤ release 构建无 `--inspect`；⑥ 落实 §5.10 ⑰⑱。

---

## 1. 原生引导件 `libnode_bridge.so`（模块 002）

### 1.1 NAPI 面（`library/src/main/cpp/types/libnode_bridge/index.d.ts`）

```ts
/** 投递启动。返回 0 = 已投递；>0 = pthread_create 错误码；-1 = 已投递过；-2 = 入参校验失败。 */
export const start: (
  libDir: string,
  scriptPath: string,
  flags: string,
  home: string,
  logPath: string,
  envPairs: string,
) => number;

/** Node 主循环是否仍在跑（<0 未起、崩溃后归 0） */
export const isRunning: () => number;

/** 引导件版本串（构建期常量） */
export const version: () => string;

/** 最近一次原生层失败原因；无失败返回空串 ''（**新增**，ArkTS 侧必须可见） */
export const lastError: () => string;

/** 当前引导阶段：'init'|'dlopen'|'dlsym'|'stdio'|'start'|'running'|'exited'（**新增**） */
export const stage: () => string;
```

### 1.2 `envPairs` 编码

- 格式：`"K1=V1\nK2=V2\n…"`（**换行分隔**，值内不得含 `\n`）。
- 上限 **4096 字节**（`flags` 上限 256 字节）。超出 ⇒ 截断；**截断必须可见且不可被抹掉**（2026-10-17 修订）：
  - 原生层对每个被截断的参数写一条 `sys` 行，**指名参数**与「实际需要字节数 / 上限」；
  - **路径类参数**（`libDir`/`scriptPath`/`home`/`logPath`）被截断 ⇒ **致命**：`start()` 返回 `-2`，
    `lastError()` 说明原因（半截路径被当成正常参数继续用，比直接失败更难查）；
  - `flags`/`envPairs` 允许截断后继续，但证据留在日志里（成功路径会清空 `lastError()`，
    **不清空**已写出的 `sys` 行；契约要求「不静默」）。
- 语义：`setenv(K, V, 1)`，在 `node::Start` 之前生效；同一 key 后写覆盖前写。
- 原生层在 `envPairs` **之前**先设置自己的默认值（见 §1.5），故 `envPairs` 可覆盖它们。

### 1.3 日志行格式（写入 `logPath` 的文件）

```
<stream> <epochMs> <text>\n
```

- `stream ∈ { out, err, sys }`：`out` = **进程** stdout、`err` = **进程** stderr、`sys` = 引导件自身（2026-10-17 修订，见下）。
- `epochMs` = 十进制毫秒时间戳（如 `1760659200123`）。
- `text` 为**单行**（内部换行已被 reader 切分掉）；不做转义。
- `sys` 行的 `text` 一律以 `[node_bridge] ` 开头（引导件自身）或 `CRASH ` 开头（崩溃）。SIGSYS shim 的
  非 `svc` 诊断同样遵守本格式：`sys <epochMs> [node_bridge] SIGSYS non-svc insn pc=0x… insn=0x… treated-as-ENOSYS pc-advanced`。
- **实现要点**：`fd1`/`fd2` 必须各自接一条 pipe，由**独立 reader 线程**持续排空并落盘
  —— 直接 `dup2` 到文件会让宿主管线的输出混入本文件、且不排空可能阻塞 ArkWeb IO 线程（§5.10 ⑤ / §D.10 ⑱ / R19）。
- **`out`/`err` 的口径（2026-10-17 修订，C1）**：`dup2` 之后 fd1/fd2 是**进程共享**的，因此 `out`/`err`
  收到的是**任何组件**写入进程 stdout/stderr 的内容（ArkWeb/Chromium 原生输出也包括在内），
  不是「只有 Node 的输出」。为不污染日志：含 `arkweb/chromium_ext` 或 `chromium` 的**行被 reader 过滤**，
  **不写入**日志文件；过滤**不静默** —— 首见此类行写一条 `sys` 行，每个 reader 退出时再写一条累计丢弃行数。
  载荷自己的日志通道是 `<HOME>/payload/app.log`（§3.4），不要把 `node.log` 当「载荷输出」的同义词。
  过滤是**行级**的，判据刻意收窄（只认这两种子串），避免误吞载荷输出。

### 1.4 崩溃记录 `<home>/node-bridge/last-crash.json`

原生层在崩溃信号 handler 内**覆盖写**该文件（只写 4 个字段；`logTail` 由 ArkTS 侧补）：

```json
{"at":1760659200123,"stage":"running","signal":"SIGSEGV","hint":"..."}
```

- `stage` = 崩溃时的 `g_stage`；`signal` = 信号名（`SIGSEGV`/`SIGILL`/`SIGBUS`/`SIGABRT`/`SIGFPE`/`SIGTRAP`）。
- handler 内**禁止** `printf`/`stdout`/`OH_LOG_Print`；也**不得用 `snprintf`**（它不是异步信号安全函数，
  S5）——只允许裸 `open`/`write`/`close` + 自实现的十进制/十六进制转换 + `strlen`。
- 覆盖 `logPath` 文件末尾的 `sys … CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…` 行保持不变（双通道）；
  该行与 JSON 均由 handler **拼成整块后单次 `write()`**（单次 write 才是原子的：逐段写会被别的线程插进中间）。
- 二次致命信号仍可能留下**截断/零字节**的 JSON ⇒ ArkTS `lastCrash()` 的口径（specs/006 FR-006-015）：
  **缺文件 ⇒ `null`**；文件存在但不可解析 ⇒ 从日志尾 `sys <ms> … CRASH ` 行重建 `at`/`signal` 的**降级记录**
  （`stage:''`），绝不把「崩过」退化成「没有崩溃」。

### 1.5 原生层固定环境与行为（不变项）

| 项 | 值 |
|---|---|
| `HOME` / `USERPROFILE` | `home` 参数 |
| `TMPDIR` / `TMP` / `TEMP` | `<home>/tmp`（并 `mkdir`） |
| `NODE_ENV` | `production` |
| `NODE_OPTIONS` | `unsetenv`（清空） |
| `UV_USE_IO_URING` | `0` |
| 线程 | `std::` 等价的 `pthread` detached，栈 **32 MB** |
| `dlopen` 标志 | `RTLD_NOW \| RTLD_GLOBAL` |
| `dlopen` 候选链（顺序） | `<libDir>/libs/arm64-v8a/libnode.so` → `<libDir>/libnode.so` → `<libDir>/libs/arm64/libnode.so` → `libnode.so`（**裸名兜底**） |
| `dlsym` 符号 | `_ZN4node5StartEiPPc` |
| argv | `argv[0]="node"` + `flags` 按空格切分（最多 `MAX_ARGS-1-1` 个）+ `scriptPath`；**`argc` 不含尾部 `NULL` 哨兵**；`argv[argc]=NULL` |
| SIGSYS shim | 读指令编码 `0xd4000001`；命中则 `x0 = (uint64_t)-1` 且 `pc += 4` |
| 崩溃信号集 | `SIGSEGV` `SIGILL` `SIGBUS` `SIGABRT` `SIGFPE` `SIGTRAP` |
| `lastError()` 写入点 | `dlopen` 全失败、`dlsym` 失败、`pthread_create` 失败、stdio 建立失败（日志 fd / pipe / reader 线程）、参数校验失败（类型不对 / 必填为空 / 路径类参数被截断） |
| `lastError()` 清理时机 | **`pthread_create` 之前**清空，创建成功后**不再清**（bootstrap 线程可能已抢先写入 `无法打开日志文件 …`，清掉等于把主因抹掉） |
| `stage()` 取值 | `init` → `stdio` → `dlopen` → `dlsym` → `start` → `running` → `exited`；`running` 在 **reader 见到第一行未被过滤的 Node 输出**时提升（`node::Start` 返回前进程内无其它信号的代理判据），每一步早退失败都置 `exited` |
| SIGSYS 非 `svc` 诊断行 | `sys <epochMs> [node_bridge] SIGSYS non-svc insn pc=0x… insn=0x… treated-as-ENOSYS pc-advanced`（单次 `write`，必须可被 §1.3 解析器解析） |

---

## 2. ArkTS 公共 API（模块 001 / 003 / 006）

### 2.1 `library/Index.ets` 导出面（冻结）

```ts
export { NodeRuntime } from './src/main/ets/runtime/NodeRuntime';
export { NodeState } from './src/main/ets/runtime/Types';
export { NodeRuntimeOptions, NodeStartResult, NodeLogEntry, CrashRecord, HostBridgeHandler }
  from './src/main/ets/runtime/Types';
export { HostBridge } from './src/main/ets/bridge/HostBridge';
export { Logger } from './src/main/ets/log/Logger';
export { Env } from './src/main/ets/util/Env';
```

### 2.2 `NodeState`（冻结）

```ts
export enum NodeState {
  IDLE = 'idle', STARTING = 'starting', RUNNING = 'running',
  FAILED = 'failed', STOPPING = 'stopping', STOPPED = 'stopped',
}
```

### 2.3 `NodeRuntimeOptions`（冻结字段）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scriptPath` | `string`（可选*） | — | 入口脚本绝对路径（**兼容既有消费方，保留**） |
| `entry` | `string`（可选*） | — | 入口（相对 `payloadRoot` 或绝对）；给了就覆盖 `scriptPath` |
| `payloadRoot` | `string` | `<filesDir>/payload` | Node 可写根 |
| `archive` | `string` | — | 载荷 `tar.gz` 绝对路径；给出即自解包 |
| `archiveSha256` | `string` | — | 幂等判据；缺省由 bootstrap 计算一次并落盘记下 |
| `readonlyRoot` | `string` | `context.resourceDir` | `resfile` 只读直读根（零解压首选路线） |
| `argv` | `string[]` | — | 追加到 `flags` 之后的 argv（顺序：flags → argv → scriptPath） |
| `execArgv` | `string[]` | — | 与 `flags` 二选一；给了就覆盖 `flags`（`flags = execArgv.join(' ')`） |
| `flags` | `string` | `'--no-verify-heap'` | 空格分隔的 Node 参数（**兼容既有消费方**） |
| `env` | `Record<string,string>` | `{}` | 合并进环境（在原生默认值之后，故可覆盖） |
| `cwd` | `string` | 载荷根 | bootstrap 的 `process.chdir` 目标 |
| `capBytes` | `number` | `8388608` | 宿主桥单次载荷上限（8 MiB） |
| `logRingSize` | `number` | `500` | `logs()` 默认返回条数 |
| `jitless` | `boolean` | `false` | 诊断专用；`true` 时自动补 `--jitless` |
| `libDir` | `string` | `context.bundleCodeDir` | `libnode.so` 所在目录（原生走候选链 + 裸名兜底） |
| `homeDir` | `string` | `context.filesDir` | `HOME` / `TMPDIR` 根 |
| `logPath` | `string` | `<filesDir>/payload/node.log` | stdio 落盘路径 |
| `onLog` | `(e: NodeLogEntry) => void` | — | **⚠️ 不实现**（无反向通道）；给了要 `warn` 明确说明，不静默忽略 |
| `onStateChange` | `(s: NodeState, detail?: string) => void` | — | 同上；每次状态迁移**同步**回调（不跨线程，由 ArkTS 自己触发） |

\* `scriptPath` 与 `entry` **至少给一个**；都不给 ⇒ `start()` 返回
`{ ok:false, code:-2, state:IDLE, message:'…' }`（**结构化失败，不抛异常**）。

**`scriptPath` / `entry` 分工（2026-10-17 修订，与实现对齐）**

- `scriptPath` = 交给 `node::Start` 的 argv 脚本，**实际被执行的脚本**（通常指向库自带的 `payload/bootstrap.js`）；
  `entry` 给它时只作为「应用入口」经 `NODE_BRIDGE_ENTRY` 交给 bootstrap，**按运行根**解析 ——
  归档解包 / 未捕获异常兜底 / 独立日志通道只有在 bootstrap 被执行时才会生效。
- 只给 `entry`（不给 `scriptPath`）⇒ `entry` 自身就是被执行脚本：库把它解析成**绝对路径**
  （`readonlyRoot` → `payloadRoot`，S4：真机 `cwd=/`），且**不注入** `NODE_BRIDGE_CWD`。
- 给了 `archive` 却**没有** `scriptPath` ⇒ 库的 bootstrap 不会被执行，解包逻辑无人消费 ⇒
  `start()` 必须 `warn` 指名这件事（不静默，C2）。

### 2.4 `NodeStartResult`（冻结）

```ts
export interface NodeStartResult {
  ok: boolean;
  code: number;      // 0 = 已投递；>0 = pthread_create 错误码；<0 = ArkTS 侧参数/状态校验失败
  state: NodeState;
  message: string;
}
```

### 2.5 `NodeLogEntry` / `CrashRecord`（冻结）

```ts
export interface NodeLogEntry { at: number; stream: 'stdout'|'stderr'|'system'; text: string; }
export interface CrashRecord { at: number; stage: string; signal?: string; hint?: string; logTail: string[]; }
```

`logs()` 的解析规则：按 §1.3 的 `out|err|sys` 前缀映射为 `stdout|stderr|system`；
无法解析的行 ⇒ `{ at: 0, stream: 'system', text: <原行> }`（**保留原文，不丢信息**）。

### 2.6 `NodeRuntime` 方法面（冻结）

| 方法 | 返回 | 语义 |
|---|---|---|
| `static getInstance()` | `NodeRuntime` | 进程内唯一 |
| `getState()` | `NodeState` | 当前状态 |
| `isRunning()` | `boolean` | 原生 `isRunning() === 1` |
| `bridgeVersion()` | `string` | 原生 `version()` |
| `getStage()` | `string` | 原生 `stage()` |
| `getLastError()` | `string` | 原生 `lastError()` |
| `getLogPath()` | `string` | 落盘日志路径 |
| `getOptions()` | `NodeRuntimeOptions \| undefined` | 投递时快照 |
| `getPid()` | `number` | 宿主进程 pid（`@kit.ArkTS` 的 `process.pid`；**不是子进程**） |
| `get host()` | `HostBridge` | 宿主能力桥（惰性创建的单例） |
| `start(context, options)` | `NodeStartResult` | **投递**语义 + 幂等保护（非 IDLE ⇒ 拒绝，`code=-1`） |
| `waitUntilRunning(timeoutMs?)` | `Promise<void>` | 轮询 `isRunning()`；默认 15000 ms；超时 ⇒ `markFailed` 并 **reject** 一个 `Error`（`message` 含 `stage`/`lastError`/`logPath`） |
| `markRunning()` | `void` | 仅 `STARTING → RUNNING` |
| `markFailed(reason)` | `void` | 非 `IDLE` ⇒ `FAILED` + `error` 日志 |
| `logs(count?)` | `NodeLogEntry[]` | 读日志尾（默认 `logRingSize` 行）；**永不抛**（读失败返回单条 `system` 提示） |
| `lastCrash()` | `CrashRecord \| null` | 读 `<filesDir>/node-bridge/last-crash.json`；缺文件 ⇒ `null`；`logTail` 由 ArkTS 从日志尾补 20 行；**永不抛** |
| `shutdown(reason)` | `Promise<void>` | `RUNNING/STARTING → STOPPING`；写 `warn` 日志；resolve 前把原因记进 `getLastError()`。**⚠️ 不假装能停 Node**（`node::Start` 不返回）：Phase 2 才经宿主桥触发 Node 侧 `onShutdown` 钩子 |

**状态迁移合法表**

| 当前 | 事件 | 下一状态 | 合法 |
|---|---|---|---|
| IDLE | `start()` 参数校验通过且原生投递成功 | STARTING | ✅ |
| IDLE | `start()` 参数校验失败 / 原生投递失败 | IDLE / FAILED | ✅ |
| STARTING | `markRunning()` | RUNNING | ✅ |
| STARTING | `markFailed()` / `waitUntilRunning` 超时 | FAILED | ✅ |
| RUNNING | `markFailed()` | FAILED | ✅ |
| RUNNING/STARTING | `shutdown()` | STOPPING | ✅ |
| STOPPING | （进程退出） | STOPPED | ✅（仅标记） |
| STARTING/RUNNING/FAILED/STOPPING/STOPPED | `start()` | **拒绝**，`code=-1` | ⛔ |
| FAILED | 任何「自动恢复」 | — | ⛔（**禁止实现**，C5） |

### 2.7 `HostBridge`（冻结）

```ts
export class HostBridge {
  register(name: string, handler: HostBridgeHandler): void;   // 同名覆盖
  unregister(name: string): boolean;                          // 返回是否真的删掉了（**新增**）
  has(name: string): boolean;                                 // **新增**
  list(): string[];                                           // 已注册名（用于日志/自检）
  dispatch(name: string, argsJson: string): string;           // **永不抛异常**
  stats(): string;                                            // JSON：{count,names,invocations,errors,capBytes}
  setCapBytes(n: number): void;                               // 载荷上限（默认 8 MiB）
}
```

`dispatch` 返回的 JSON **必须用转义函数**构造（不得字符串拼 `name` / `detail`）：

| 场景 | 返回 |
|---|---|
| 成功 | 处理器返回的原始字符串（原样透传，**不包装**） |
| 未注册 | `{"ok":false,"error":"unregistered","name":"<esc>"}` |
| 处理器抛错 | `{"ok":false,"error":"handler-threw","name":"<esc>","detail":"<esc>"}` |
| 入参超上限 | `{"ok":false,"error":"payload-too-large","name":"<esc>","capBytes":<n>,"actual":<n>}` |
| 入参非法（非法 UTF-16 长度/未定义） | `{"ok":false,"error":"bad-args","name":"<esc>"}` |
| 载荷字节数**无法测量**（UTF-8 编码失败；两侧同口径） | `{"ok":false,"error":"bad-args","name":"<esc>","detail":"payload byte length unavailable…"}` |

**能力名常量（v1 清单，冻结命名）**：`runtime.facts` · `perm.check` · `perm.openAppInfo` ·
`fs.pickFiles` · `fs.pickFolder` · `shell.openExternal` · `notify.show` · `log.hilog`。
库**只做寄存器与传输**；**每个能力的实现属消费方**（C1）。

### 2.8 `Env`（冻结）

| 方法 | 返回 | 值 |
|---|---|---|
| `payloadDir(context)` | `string` | `<filesDir>/payload` |
| `tmpDir(context)` | `string` | `<filesDir>/tmp` |
| `logPath(context)` | `string` | `<filesDir>/payload/node.log` |
| `bridgeDir(context)` | `string` | `<filesDir>/node-bridge`（**新增**） |
| `crashPath(context)` | `string` | `<filesDir>/node-bridge/last-crash.json`（**新增**） |
| `readonlyRoot(context)` | `string` | `context.resourceDir`（`resfile` 直读根；**新增**） |
| `ensureDir(path)` | `void` | 幂等 |
| `ensureRuntimeDirs(context)` | `void` | 建 `payloadDir` + `tmpDir` + `bridgeDir`（**新增 bridgeDir**） |
| `materializeRawfile(mgr, rawName, destPath)` | `string` | 原样保留 |

### 2.9 `Logger`（冻结）

`info/warn/error(msg)`、`tail(path, maxBytes): string`、`tailLines(path, maxBytes, wantLines): string[]`、`describeThrown(e): string`。
**`tail` 必须按 UTF-8 正确解码**（当前逐字节 `String.fromCharCode` 对中文会乱码 —— 必须修）。
实现建议：`buffer.from(arrayBuffer).toString('utf-8')`（`@kit.ArkTS` 的 `buffer`）。
占位串必须可区分（2026-10-17 修订）：缺文件 ⇒ `(log missing)`；**空文件**（`stat.size === 0`）⇒ `(log empty)`；
`maxBytes <= 0` ⇒ `(maxBytes <= 0)`；**读失败 / stat>0 却读到 0 字节** ⇒ `(read log failed: …)`。
**永不抛**：`catch` 里的错误序列化本身也必须包 try（循环引用的抛出物会让 `JSON.stringify` 抛错）。

### 2.10 原生崩溃记录的读回口径（2026-10-17 修订，specs/006 FR-006-015）

`lastCrash()` 读 `<home>/node-bridge/last-crash.json`（`home` = 投递时**实际生效**的 `options.homeDir | context.filesDir`，
与原生 handler 同源）：缺文件 ⇒ `null`；文件存在但 JSON 不可解析（二次致命信号截断 / 零字节）⇒ **降级记录**
（`at`/`signal` 从日志尾 `sys … CRASH ` 行重建，`stage:''`，`logTail` 照常补 20 行）——不得把「崩过」退化成「没崩过」。

---

## 3. Node 侧载荷 API（模块 003 / 004）

### 3.1 `payload/bootstrap.js` 输入契约（环境变量，冻结）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NODE_BRIDGE_PAYLOAD_ROOT` | `<HOME>/payload` | Node 可写根 |
| `NODE_BRIDGE_ENTRY` | — | 入口；绝对路径直接用，否则相对**运行根**解析 |
| `NODE_BRIDGE_ARCHIVE` | — | 载荷 `tar.gz` 绝对路径（给了就走解包路线） |
| `NODE_BRIDGE_ARCHIVE_SHA256` | — | 幂等判据（缺省由 bootstrap 计算并落盘记下） |
| `NODE_BRIDGE_READONLY_ROOT` | — | `resfile` 只读直读根（优先级低于解包根、高于 `payloadRoot`） |
| `NODE_BRIDGE_CWD` | 运行根 | `process.chdir` 目标（真机 `cwd=/`，必须显式设） |
<!-- 2026-10-17：`PI_WEB_ENTRY` 兼容别名**已删除**。库侧不得解释 `PI_*`（宪法 C1 一票否决）且与
     specs/004 FR-004-020 直接冲突；消费方这类值走 `options.env`（envPairs 在 NODE_BRIDGE_* 之后应用 ⇒ 仍然有效）。 -->

**运行根决策（冻结顺序）**：`archive` 解出的目录 → `NODE_BRIDGE_READONLY_ROOT` → `NODE_BRIDGE_PAYLOAD_ROOT`。

### 3.2 幂等判据（冻结）

- 目标目录 = `<payloadRoot>/<sha256 前 12 位>`。
- 就绪 marker = `<payloadRoot>/.ready-<sha256 前 12 位>`，内含完整 sha256 + 文件数 + 字节数 + **跳过条目数（`skipped`）** + epochMs
  （`skipped` 是 2026-10-17 追加：解包树可能因跳过的链接/设备条目而不完整，必须可审计）。
- **命中 marker **且** 目标目录存在 ⇒ 跳过解包**，打印 `[bootstrap] payload ready (skip)` 并附目录与 marker 内容。
- 缺 marker 但目录存在 ⇒ **重新解包**（宁可重做也不留半成品）。
- `NODE_BRIDGE_ARCHIVE_SHA256` 给了就与实算值比对，不一致 ⇒ **硬失败**（不静默继续）。

### 3.3 入口解析（冻结）

1. 绝对路径 ⇒ 直接用。
2. 相对路径 ⇒ `path.resolve(runRoot, entry)`。
3. 缺席 ⇒ `path.join(runRoot, 'index.js')`（并检查 `package.json` 的 `main`，存在则用它）。
4. 加载：`require(entry)`；失败（`ERR_REQUIRE_ESM` 或 `ERR_REQUIRE_ASYNC_MODULE`）⇒
   `import(pathToFileURL(entry).href)`。
5. 打印 `[bootstrap] entry=<abs> mode=<cjs|esm> root=<runRoot> cwd=<cwd>`。

### 3.4 异常兜底（冻结，⑱）

- 顶部**必须**注册 `process.on('uncaughtException')` 与 `process.on('unhandledRejection')`。
- 兜底处理：把 `时间戳 + 类型 + message + stack` 追加写 **`<HOME>/payload/app.log`**（**独立日志通道**，
  不与 stdio 混流）+ 同样写 `stderr`；**不调用 `process.exit`**（保留现场让原生层记录 `node::Start` 返回值）。
- 再导出 `globalThis.__nodeBridgeLastError` 供自检读取。

### 3.5 `payload/host.js`（Node 侧宿主桥客户端）

```js
const host = require('<payload 绝对目录>/host.js');
await host.invoke('perm.check', { name: 'ohos.permission.X' });  // → 已解析的对象
host.handle('shutdown', async (payload) => { ... });             // 注册 Node 侧钩子
host.list();                                                     // → string[]
host.setTransport(fn);                                           // Phase 2 接线点
```

- **默认传输不可用**：`invoke()` 必须 `reject` 一个 **结构化错误**
  （`{ ok:false, error:'transport-unavailable', name, hint }`），**不得静默返回空值**（C2）。
- `handle`/`list` 是本地注册表，可用。
- `facts()` 返回本进程事实（`node/platform/arch/execArgv/pid/versions/HOME/TMPDIR/cwd`）。

### 3.6 `payload/selfcheck.js` 端点（冻结）

| 端点 | 响应 |
|---|---|
| `GET /facts` | `200 application/json`；`{at, checks:{…}}`；`checks` 键名冻结：`node` `platform` `arch` `execArgv` `versions` `homedir` `tmpdir` `homedir_redirected` `tmpdir_redirected` `netifaces` `cpus` `spawn` `wasm.validate` `wasm.error` `fs_write_readback` `hotloop_ms_5rounds` |
| `GET /log` | `200 text/plain`；`<HOME>/payload/node.log` **尾部**（注意 §1.3 的组件输出过滤）。当前实现按 **UTF-16 码元切 8192** —— 与本契约早期的「8192 字节」措辞不一致，已登记为 `specs/006-observability-logring-crash/plan.md` 缺陷 #11（目标：按 offset 有界读 + 按字节切并丢弃被截断的首字符）；`NodeRuntime.logs()` / `Logger.tail(path, maxBytes)` 走的是**字节精确**路径，两条读回路径切法不同是已知事实 |
| `POST /rport` | `200 text/plain`；把请求体原文转发到 `127.0.0.1:${RPORT_PORT}`（缺省 19999），用于第三条取证通道 |
| `GET /diag` | `200 application/json`；`{at, lastError, appLogTail, hostBridge:{transport, handles}}`（`appLogTail` 读 `<HOME>/payload/app.log` 末 4096 字节） |
| 其它 | `404` |

监听：`127.0.0.1:${SELFCHECK_PORT:-15577}`（**不得** `0.0.0.0`）。默认 15577 是**文档化取证契约**
（真机命令 `hdc fport tcp:15577`）；若被占用 ⇒ 回退到内核临时端口并打印
`[selfcheck] WARN 15577 被占用 → 改用 <port>`（不静默换端口，见 2026-10-17 修订）。

### 3.7 `payload/lib/tar-extract.js`（ustar 解包器）

- 纯 Node 内置模块（`zlib` + `fs` + `path`），**无第三方依赖**。
- 支持 `typeflag`：`0`/`\0`（普通文件）、`5`（目录）、`L`（GNU 长名）、`x`（pax 扩展头，**跳过其数据**）、`g`（跳过）。
- 支持 `prefix[155]` + `name[100]` 拼接、`size` 八进制（含 `base-256` 高位形式）。
- **必须**做路径安全校验：解析后的绝对路径必须落在目标目录内，否则**抛错**（拒绝 `../` 穿越与绝对路径条目）。
- 必须支持**流式**解压（`createGunzip`），不得把整个 tar 读进内存。
- 返回 `{ files, bytes, dirs }` 统计。
- 归档结束块必须是**整块 512 B 全 0**；「首字节 0、其余非 0」是畸形/截断头 ⇒ **抛错**
  （只看首字节会把后续条目静默丢弃、`finish()` 却通过 ⇒ 就绪 marker 指向一棵不完整的树，C4）。
- 返回 `{ files, bytes, dirs, skipped }` 统计；`skipped` = 跳过的条目数（链接/设备/FIFO/未知 typeflag + pax 头），
  必须随结果回传并进就绪 marker（不完整的树要可审计）。
---

## 4. host 侧工具（模块 005 / 007）

| 文件 | 契约 |
|---|---|
| `tools/build-bridge.mjs` | 包装 `hvigorw assembleHar`（`--abi arm64-v8a` 只用于打印提示）。幂等；失败 `exit 2`；打印产物路径与大小 |
| `tools/smoke-host.mjs` | **不需要真机**的门禁：① `provision.mjs --check`；② 若存在 `libs/arm64-v8a/libnode.so` ⇒ 跑 `elf-inspect.py`；③ payload 单测（`tests/payload/*.mjs`）；④ 汇总 PASS/FAIL 并 `exit 0/2` |
| `tests/payload/*.mjs` | 纯 Node 单测：tar 解包（普通/长名/目录/路径穿越拒绝/截断）、幂等 marker、入口解析（CJS/ESM/package.json main）、`host.js` 结构化错误、日志行解析与 §1.3 格式一致 |
| `THIRD-PARTY-NOTICES.md` | G4：Node.js（MIT）+ V8/OpenSSL 等 + 上游构建脚本许可 + `libnode.so` 来源与 SHA-256 |
| `docs/能力矩阵.md` | 规划 §10 的 Phase 0 产物：能力 × 状态 × 根因层（L1–L4）× 证据 |

---

## 5. 禁止事项（评审会逐条查）

1. **禁止**实现「崩了自动重启 Node」（C5）。
2. **禁止**在信号 handler 内调 `printf`/`stdout`/`OH_LOG_Print`（S5）。
3. **禁止**用 OHOS/ArkTS 侧解压器写 Node 要读的业务文件（C3）。
4. **禁止**运行期修改 `execArgv`（C4）。
5. **禁止**任何形式的静默降级：失败必须有结构化返回或日志（C2）。
6. **禁止**在 `library/` 内引入 `pi` / `pi-web` / Next.js / 应用语义（C1）。
7. **禁止**把 `libnode.so` 或任何大二进制入库（S10）。
8. **禁止** `ohos.permission` 之外的 ACL 由库申请（受限权限归消费方）。
9. **禁止** `process.exit()` 出现在 `bootstrap.js` 的兜底路径里。
10. **禁止**在 ArkTS 里使用 `any`/`unknown` 或把 `.so` 当包内模块 import（S1）。
