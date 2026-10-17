/**
 * 001-runtime-core / 003-host-bridge / 006-observability —— 对外类型（HAR 公共 API 的一部分）。
 *
 * 这些类型是**消费方契约**：改动即破坏性变更（见工程规划 §7.5 版本策略；宪法 S3）。
 * 字段与取值冻结在 `logs/20261016-1/IMPLEMENTATION_CONTRACT.md` §2.2–§2.5。
 */

/**
 * 运行时状态机取值。合法迁移表见契约 §2.6。
 *
 * - `failed` 是**终态**：进程内 Node 崩溃后无法自动重启（硬约束 ⑥ / 宪法 C5）；
 * - `stopping` / `stopped` 是**标记位**而不是「Node 正在收尾」的事实：
 *   进程内 `node::Start` 直到进程结束才返回，没有优雅停止接口（契约 §2.6 `shutdown`）。
 *   之所以仍然暴露它们：消费方在 `onPrepareToTerminate` 里需要如实告诉用户
 *   「已通知、正在退出」，而不是假装还能停下来（C2 不隐藏平台真相）。
 */
export enum NodeState {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  FAILED = 'failed',
  STOPPING = 'stopping',
  STOPPED = 'stopped'
}

/**
 * 启动参数（逐项对应原生层 bootstrap 与 Node 侧 `payload/bootstrap.js` 的输入契约）。
 *
 * `scriptPath` 与 `entry` **至少给一个**；都不给 ⇒ `start()` 返回
 * `{ ok:false, code:-2, state:idle }`（结构化失败，不抛异常）。
 */
export interface NodeRuntimeOptions {
  /**
   * Node 命令行参数（空格分隔）。与 `execArgv` 二选一，`execArgv` 优先。
   *
   * - 默认 `--no-verify-heap`；
   * - **JIT 需要 ACL**（`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`）：无 ACL 时走 JIT 会 **SIGTRAP**；
   * - 无 ACL 的兜底是加 `--jitless`，代价是 **WebAssembly 全废**（Next 的 WASM SWC、undici 的 llhttp WASM 都依赖它）。
   *   真机实测：见工程规划 §D.8（`--jitless` 热循环 ≈ 慢 7–10×，§D.10）。
   *
   * `execArgv` 一旦投递即固定，库**不提供**运行期修改入口（宪法 C4）。
   */
  flags?: string;
  /**
   * 入口脚本**绝对路径**（`resfile` 只读直读或沙箱内已物化的路径）。
   *
   * **兼容既有消费方保留**（`pi-desktop-ark` 传的是物化后的 `selfcheck.js` 绝对路径）。
   * 与 `entry` 二选一：`entry` 给了就以 `entry` 为准（契约 §2.3）。
   */
  scriptPath?: string;
  /**
   * 入口（相对 `payloadRoot`/运行根，或绝对路径）。给了就覆盖 `scriptPath`。
   *
   * 与 `scriptPath` 的分工：`scriptPath` 是交给 `node::Start` 的 argv 脚本；
   * `entry` 是「要跑哪一个应用入口」，同时经 `NODE_BRIDGE_ENTRY` 交给 Node 侧 bootstrap 解析（契约 §3.1/§3.3）。
   */
  entry?: string;
  /** Node 可写根（默认 `<filesDir>/payload`） */
  payloadRoot?: string;
  /**
   * 载荷 `tar.gz` 的绝对路径；给出即由 **Node 自己**解包（宪法 C3：谁写谁读 ——
   * ArkTS 侧解压器写出的文件 Node 读不到）。
   */
  archive?: string;
  /** 载荷 sha256（幂等判据）。缺省由 Node 侧 bootstrap 计算一次并落盘记下（契约 §3.2） */
  archiveSha256?: string;
  /**
   * `resfile` 只读直读根（默认 `context.resourceDir`；零解压首选路线，规划 §5.5）。
   * `context.resourceDir` 为空时 `Env.readonlyRoot()` 返回 `''`（**不编造路径**，C2）。
   */
  readonlyRoot?: string;
  /**
   * 追加到 `flags` **之后**的 Node argv（顺序：`execArgv`/`flags` → `argv` → `scriptPath`）。
   *
   * ⚠️ 原生层按**空格**切分 `flags`（契约 §1.5），因此单个 argv 项**不得含空格**，
   * 否则会被切成两项；库会对含空格的项发 `warn`（不静默）。
   */
  argv?: string[];
  /** 与 `flags` 二选一；给了就覆盖 `flags`（`flags = execArgv.join(' ')`） */
  execArgv?: string[];
  /**
   * 合并进进程环境（在原生默认值**之后**，故可覆盖 `HOME`/`TMPDIR`/`NODE_ENV` 等）。
   * 库只做透明传递：不认识也不解释任何业务变量（宪法 C1）。
   * 值**不得含 `\n`**（契约 §1.2：`envPairs` 以换行分隔）——含换行的项被丢弃并发 `warn`。
   */
  env?: Record<string, string>;
  /** Node 侧 `process.chdir` 目标（默认**运行根**：解包目录 → `readonlyRoot` → `payloadRoot`，契约 §3.1） */
  cwd?: string;
  /** 宿主桥单次载荷上限（默认 8 MiB，契约 §5.4） */
  capBytes?: number;
  /** `logs()` 默认返回条数（默认 500） */
  logRingSize?: number;
  /** 诊断专用；`true` 时自动补 `--jitless`（关闭 WASM，见 §4.7 —— 不是性能选项） */
  jitless?: boolean;
  /** `libnode.so` 所在目录。默认 `context.bundleCodeDir`；真机上**只有裸名 `libnode.so` 的 `dlopen` 能成功**（§D.8 偏差表） */
  libDir?: string;
  /** HOME / TMPDIR 根（默认 `context.filesDir`） */
  homeDir?: string;
  /** Node 的 stdout/stderr 落盘路径（默认 `<filesDir>/payload/node.log`） */
  logPath?: string;
  /**
   * ⚠️ **不实现**：Node → ArkTS 没有反向推送通道（Phase 2 才有宿主桥的
   * `napi_threadsafe_function` 队列，规划 §5.4）。给了只会被 `warn` 明确告知，
   * **绝不静默忽略**（C2）。要读日志请用 `logs()` 主动拉取。
   */
  onLog?: (e: NodeLogEntry) => void;
  /**
   * 状态迁移回调。**每次状态迁移同步回调**（在同一 ArkTS 线程内，不跨线程）。
   * 回调抛错不会破坏状态机，但会进 `error` 日志（不静默）。
   */
  onStateChange?: (s: NodeState, detail?: string) => void;
}

/**
 * 启动结果（`start()` 是**投递**语义：返回时 Node 仍在后台线程启动中）。
 *
 * `code` 的取值域（契约 §2.4）：`0` = 已投递；`>0` = 原生层 `pthread_create` 错误码；
 * `<0` = ArkTS 侧参数/状态校验失败（`-1` 状态非 idle、`-2` 缺入口）。
 */
export interface NodeStartResult {
  /** 是否成功投递启动 */
  ok: boolean;
  /** 0 = 已投递；>0 = 原生层 `pthread_create` 错误码；<0 = ArkTS 侧校验失败 */
  code: number;
  /** 投递后的状态（成功即 `starting`） */
  state: NodeState;
  /** 人读说明（失败原因 / 下一步提示） */
  message: string;
}

/**
 * 一条日志（`logs()` 的返回元素，契约 §2.5）。
 *
 * `stream` 由 Node 侧 `out`/`err`/`sys` 前缀映射而来（§1.3）；`at` 是**日志行自带**的
 * epochMs（不是读日志的时刻）—— 它与 `stdout` 的实际产生时刻一致，可直接当时间轴用。
 */
export interface NodeLogEntry {
  at: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

/**
 * 崩溃记录（`lastCrash()`，契约 §1.4 / §2.5）。
 *
 * 前 4 个字段来自原生崩溃 handler 覆盖写的 `<filesDir>/node-bridge/last-crash.json`；
 * `logTail` 由 ArkTS 侧从日志尾补 20 行 —— 崩溃时 handler 内**禁止** stdio
 * （宪法 S5、规划 §5.10 ②），所以「崩溃现场周围的日志」只能事后拼。
 */
export interface CrashRecord {
  at: number;
  stage: string;
  signal?: string;
  hint?: string;
  logTail: string[];
}

/** 宿主能力桥的处理器（003）：入参与返回值都是 **JSON 字符串**（不受参数个数与类型限制，规划 §5.3） */
/**
 * 宿主能力桥的处理器（003）：入参与返回值都是 **JSON 字符串**（不受参数个数与类型限制，规划 §5.3）。
 *
 * **允许返回 Promise**（2026-10-17，E17/E20/E21）：这类能力天然异步 ——
 * `requestPermissionsFromUser`（弹授权窗）、`picker.select`（等用户选目录）、
 * `notificationManager.publish` 都是 Promise。两条传输的处置不同：
 *   · **文件信箱**（`mailboxTick`）走 `dispatchAsync`，会 await 它；
 *   · **原生槽位表**（`pumpTick`）是同步的，拿到 Promise 只能如实报错
 *     （`async-handler-on-sync-path`），绝不返回未决结果。
 */
export type HostBridgeHandler = (argsJson: string) => string | Promise<string>;
