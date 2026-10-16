/**
 * 001-runtime-core / 003-host-bridge —— 对外类型（HAR 公共 API 的一部分）。
 *
 * 这些类型是**消费方契约**：改动即破坏性变更（见工程规划 §7.5 版本策略）。
 */

/** 运行时状态。`failed` 是**终态**：进程内 Node 崩溃后无法自动重启（硬约束 ⑥）。 */
export enum NodeState {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  FAILED = 'failed'
}

/** 启动参数（逐项对应原生层 bootstrap 的字段） */
export interface NodeRuntimeOptions {
  /**
   * Node 命令行参数（空格分隔）。
   *
   * - 默认 `--no-verify-heap`；
   * - **JIT 需要 ACL**（`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`）：无 ACL 时走 JIT 会 **SIGTRAP**；
   * - 无 ACL 的兜底是加 `--jitless`，代价是 **WebAssembly 全废**（Next 的 WASM SWC、undici 的 llhttp WASM 都依赖它）。
   *   真机实测：见工程规划 §D.8。
   */
  flags?: string;
  /** 入口脚本**绝对路径**（`resfile` 直读或沙箱内已物化的路径） */
  scriptPath: string;
  /** `libnode.so` 所在目录。默认 `context.bundleCodeDir`；注意真机上**只有裸名 `libnode.so` 的 `dlopen` 能成功**（§D.8 偏差表） */
  libDir?: string;
  /** HOME / TMPDIR 根（默认 `context.filesDir`） */
  homeDir?: string;
  /** Node 的 stdout/stderr 落盘路径（默认 `<homeDir>/payload/node.log`） */
  logPath?: string;
}

/** 启动结果（`start()` 是**投递**语义：返回时 Node 仍在后台线程启动中） */
export interface NodeStartResult {
  /** 是否成功投递启动 */
  ok: boolean;
  /** 0 = 已投递；其它值为原生层 `pthread_create` 的错误码 */
  code: number;
  /** 投递后的状态（成功即 `starting`） */
  state: NodeState;
  /** 人读说明（失败原因 / 下一步提示） */
  message: string;
}

/** 宿主能力桥的处理器（003）：入参与返回值都是 **JSON 字符串** */
export type HostBridgeHandler = (argsJson: string) => string;
