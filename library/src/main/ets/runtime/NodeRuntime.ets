import { common } from '@kit.AbilityKit';
import { buffer, process, JSON } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import nodeBridge from 'libnode_bridge.so';
import { Logger } from '../log/Logger';
import { Env } from '../util/Env';
import { HostBridge } from '../bridge/HostBridge';
import { CrashRecord, NodeLogEntry, NodeRuntimeOptions, NodeStartResult, NodeState } from './Types';

/** 缺省 `flags`（契约 §2.3；原生层还会做一次兜底，两层互为防御） */
const DEFAULT_FLAGS: string = '--no-verify-heap';
/** `jitless: true` 时自动补的参数（诊断开关，不是性能选项 —— 用了等于关闭 WASM，规划 §4.7） */
const JITLESS_FLAG: string = '--jitless';
const DEFAULT_LOG_RING_SIZE: number = 500;
const DEFAULT_WAIT_TIMEOUT_MS: number = 15000;
const WAIT_POLL_INTERVAL_MS: number = 100;
/** `logs(count)` 至少读这么多字节，保证 count 行即使在 UTF-8 中文下也读得全 */
const LOG_TAIL_MIN_BYTES: number = 64 * 1024;
/** 每行日志的估算字节数（`out <13 位 epochMs> <text>` ≈ 20 + text） */
const LOG_TAIL_BYTES_PER_LINE: number = 160;
/** `lastCrash()` 补的日志尾行数（契约 §2.6） */
const CRASH_LOG_TAIL_LINES: number = 20;
/** 崩溃记录文件上界（原生 handler 单次 write、只写 4 个字段 ⇒ 实际只有几百字节） */
const CRASH_FILE_MAX_BYTES: number = 64 * 1024;

/**
 * `last-crash.json` 的字段形状（契约 §1.4：原生 handler 只写 `at`/`stage`/`signal`/`hint`）。
 * 内部键（`si_addr`/`pc`/`lr`/`sp`/`r0`/`pid`）不在这里声明 —— 它们不属公共契约。
 */
interface CrashJson {
  at?: number;
  stage?: string;
  signal?: string;
  hint?: string;
}

/**
 * 001-runtime-core —— 进程内 Node 运行时单例。
 *
 * 三条不可违背的约束（都是真机实测结论，见工程规划 §5.10 / §D.8）：
 *
 * 1. **`node::Start` 每进程只能调用一次**（Node 内部 `limit_checker` 断言）⇒ 状态机
 *    `idle → starting → running|failed` **不可重启**；要「重启」只能重启整个应用。
 * 2. **启动必须在 detached pthread（32 MB 栈）内**完成，绝不能在 UI 线程调用
 *    （否则 `APP_INPUT_BLOCK`，先例的旧版本就这么被系统杀掉）。
 * 3. **崩溃是终态**：进程内 Node 崩溃无法自动拉起（硬约束 ⑥），
 *    消费方只能靠 `node.log` + 原生层 `CRASH sig=…` 取证，并提示用户重启应用。
 *
 * 本类只做「投递 / 查询 / 读回」三件事：**不做探活轮询**（那是消费方契约，规划 §6.1）。
 */
export class NodeRuntime {
  private static instance: NodeRuntime | undefined = undefined;

  private state: NodeState = NodeState.IDLE;
  private options: NodeRuntimeOptions | undefined = undefined;
  private logPath: string = '';
  /** `start()` 时实际生效的 `home`（`options.homeDir` 或 `context.filesDir`）—— B1：
   * 原生崩溃 handler 写的是 **<home>/node-bridge/last-crash.json**，`lastCrash()` 必须读同一个 home，
   * 否则自定义 `homeDir` 时记录被写到没人读的地方 ⇒ 崩了却报「没有崩溃」。 */
  private home: string = '';
  /** `start()` 时记住的 Context（`home` 未知时用它算 `<filesDir>/node-bridge/last-crash.json` 默认值） */
  private context: common.Context | undefined = undefined;
  /** ArkTS 侧记录的「最近一次失败/关停原因」——原生 `lastError()` 为空时的兜底读回 */
  private lastError: string = '';
  private hostBridge: HostBridge | undefined = undefined;
  /** 一次性提示标记：避免诊断面板高频调用时刷屏 */
  private onLogWarned: boolean = false;
  private crashContextWarned: boolean = false;
  private pidFallbackWarned: boolean = false;

  static getInstance(): NodeRuntime {
    if (NodeRuntime.instance === undefined) {
      NodeRuntime.instance = new NodeRuntime();
    }
    return NodeRuntime.instance;
  }

  getState(): NodeState {
    return this.state;
  }

  /** 原生层探针：Node 主循环是否仍在跑（崩溃后归 0） */
  isRunning(): boolean {
    return nodeBridge.isRunning() === 1;
  }

  /** 原生引导件版本（构建期字符串，排障时先看它） */
  bridgeVersion(): string {
    return nodeBridge.version();
  }

  /**
   * 原生引导件的当前阶段（`init`/`dlopen`/`dlsym`/`stdio`/`start`/`running`/`exited`，契约 §1.1）。
   *
   * 为什么要单独暴露：`ok=true` 只代表「已投递」，失败时**卡在哪一步**才是排障的第一信息。
   * 老 `.so`（不含 `stage()` 符号）会被防御性捕获并返回明确文案，不抛异常（C2）。
   */
  getStage(): string {
    try {
      const stage: string = nodeBridge.stage();
      return stage !== undefined ? stage : '';
    } catch (e) {
      return '(native stage() 不可用：引导件版本过旧？)';
    }
  }

  /**
   * 最近一次失败原因：优先原生 `lastError()`（`dlopen`/`dlsym`/`pthread_create`/stdio 失败点写入），
   * 原生为空时回落到 ArkTS 侧记录的原因（探活超时、`shutdown()` 的 reason 等）。
   */
  getLastError(): string {
    let native: string = '';
    try {
      native = nodeBridge.lastError();
    } catch (e) {
      native = '';
    }
    if (native !== undefined && native.length > 0) {
      return native;
    }
    return this.lastError;
  }

  getLogPath(): string {
    return this.logPath;
  }

  /** 投递时快照（实际生效参数，含已解析的默认值）——诊断面板直接可读 */
  getOptions(): NodeRuntimeOptions | undefined {
    return this.options;
  }

  /**
   * **宿主进程** pid（不是子进程）。
   *
   * 为什么不是「Node 的 pid」：Node 跑在本进程的线程里，没有独立 pid（规划 §5.3）。
   * `@kit.ArkTS` 的 `process.pid` 在 API 7+ 可用；取不到（异常/非数字）时返回 `-1`
   * 并**发一次 warn**，绝不返回一个看起来像真实 pid 的假值（C2）。
   */
  getPid(): number {
    try {
      const pid: number = process.pid;
      if (typeof pid === 'number' && pid > 0) {
        return pid;
      }
    } catch (e) {
      // 落到下面的兜底
    }
    if (!this.pidFallbackWarned) {
      this.pidFallbackWarned = true;
      Logger.warn('process.pid 不可用 ⇒ getPid() 返回 -1（不是真实 pid；契约 §2.6 的降级口径）');
    }
    return -1;
  }

  /** 宿主能力桥（惰性创建的单例；能力实现属消费方，库只提供寄存器与传输，C1） */
  get host(): HostBridge {
    if (this.hostBridge === undefined) {
      this.hostBridge = new HostBridge();
    }
    return this.hostBridge;
  }

  /**
   * 投递启动（**幂等保护**：只有 `idle` 允许调用）。
   *
   * 返回 `ok=true` 只代表**已成功投递到后台线程**，不代表 Node 已经起来 ——
   * 判断「起来了」的正确方式是轮询宿主服务端口（消费方约定，见工程规划 §6.1 状态机），
   * 或用 `waitUntilRunning()`（本库提供的通用轮询，不解释任何应用语义）。
   *
   * 本方法**不抛异常**（FR-001-018）：所有失败都是结构化 `NodeStartResult`。
   */
  start(context: common.Context, options: NodeRuntimeOptions): NodeStartResult {
    if (this.state !== NodeState.IDLE) {
      const first: string = this.lastError.length > 0 ? '；首次失败原因=' + this.lastError : '';
      return {
        ok: false,
        code: -1,
        state: this.state,
        message: 'Node 每进程只能启动一次（node::Start 不返回）；当前状态=' + this.state + first
      };
    }

    const entryOpt: string | undefined = options.entry;
    const scriptOpt: string | undefined = options.scriptPath;
    const hasEntry: boolean = entryOpt !== undefined && entryOpt.length > 0;
    const hasScript: boolean = scriptOpt !== undefined && scriptOpt.length > 0;
    if (!hasEntry && !hasScript) {
      // 结构化失败（不抛异常）：契约 §2.3 脚注 / FR-001-018
      const msg: string = '启动参数非法：至少给 scriptPath 或 entry（入口脚本绝对路径 / 相对 payloadRoot 的入口）';
      Logger.error(msg);
      return { ok: false, code: -2, state: NodeState.IDLE, message: msg };
    }

    // 投递前先建齐运行期目录（FR-001-016；失败不抛，留给后续 open 报错）
    Env.ensureRuntimeDirs(context);

    const libDir: string = options.libDir !== undefined ? options.libDir : context.bundleCodeDir;
    const home: string = options.homeDir !== undefined ? options.homeDir : context.filesDir;
    const logPath: string = options.logPath !== undefined ? options.logPath : Env.logPath(context);
    const payloadRoot: string = options.payloadRoot !== undefined ? options.payloadRoot : Env.payloadDir(context);
    const readonlyRoot: string = options.readonlyRoot !== undefined ? options.readonlyRoot : Env.readonlyRoot(context);

    // 入口/脚本（契约 §2.3，2026-10-16 修订澄清）：
    //   · 给了 `scriptPath` ⇒ **它才是 `node::Start` 实际执行的脚本**（通常指向库自带的
    //     `payload/bootstrap.js`）；`entry` 只作为「应用入口」经 `NODE_BRIDGE_ENTRY` 交给 bootstrap
    //     按运行根解析（这样 archive 解包 / 未捕获异常兜底 / 独立日志通道才会生效）。
    //   · 只给 `entry` ⇒ 退回「entry 就是被执行脚本」，转成**绝对路径**（S4：真机 `cwd=/`）。
    //   · 给了 `archive` 却没有 `scriptPath` ⇒ **没有任何东西会消费它**（解包逻辑在 bootstrap 里）
    //     ⇒ 必须明确报警，不能静默什么都不做（C2 不隐藏平台真相）。
    let entry: string = '';
    let script: string = '';
    if (hasEntry && entryOpt !== undefined) {
      entry = entryOpt;
      if (hasScript) {
        script = scriptOpt !== undefined ? scriptOpt : '';
      } else {
        script = NodeRuntime.resolveEntry(entryOpt, readonlyRoot, payloadRoot);
        if (options.archive !== undefined && options.archive.length > 0) {
          Logger.warn('已给出 archive 但没有 scriptPath：库的 bootstrap 不会被执行 ⇒ 归档不会被解包、'
            + '未捕获异常兜底与独立日志通道也不会生效。要使用 tar.gz 路线，请把 scriptPath 指向 '
            + 'payload/bootstrap.js，并把应用入口放在 entry。entry=' + entry);
        }
      }
    } else {
      script = scriptOpt !== undefined ? scriptOpt : '';
    }

    // 参数装配（顺序冻结：execArgv/flags → jitless → argv → scriptPath，契约 §2.3/§2.6）
    let flags: string = options.execArgv !== undefined
      ? options.execArgv.join(' ')
      : (options.flags !== undefined ? options.flags : DEFAULT_FLAGS);
    if (options.jitless === true && flags.indexOf(JITLESS_FLAG) < 0) {
      flags = flags.length > 0 ? flags + ' ' + JITLESS_FLAG : JITLESS_FLAG;
    }
    let flagsForNative: string = flags;
    const argv: string[] | undefined = options.argv;
    if (argv !== undefined && argv.length > 0) {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i].indexOf(' ') >= 0) {
          // 原生层按空格切分 flags（契约 §1.5）⇒ 含空格的项会被切成两项：必须让调用方看得见
          Logger.warn('argv[' + i + '] 含空格，会被原生层切成两项（契约 §1.5）：' + argv[i]);
        }
      }
      const joined: string = argv.join(' ');
      flagsForNative = flagsForNative.length > 0 ? flagsForNative + ' ' + joined : joined;
    }

    // 运行根决策（契约 §3.1 冻结顺序）：archive 解出的目录 → readonlyRoot → payloadRoot。
    // ArkTS 侧只在**能确定**时下发 cwd：archive 路线的解包目录是
    // `<payloadRoot>/<sha256 前 12 位>`，由 Node 侧 bootstrap 决定 ⇒ 此时**不注入**
    // NODE_BRIDGE_CWD，让 Node 侧默认值（= 运行根）生效，而不是在这里猜一个错的。
    const runRoot: string = options.archive !== undefined
      ? ''
      : (readonlyRoot.length > 0 ? readonlyRoot : payloadRoot);
    const cwd: string = options.cwd !== undefined ? options.cwd : runRoot;

    const basePairs: string = NodeRuntime.buildEnvPairs(payloadRoot, entry, options.archive,
      options.archiveSha256, readonlyRoot, cwd, options.env);
    /*
     * `NODE_BRIDGE_LIBDIR` 是**库自己的**键：Node 侧要 `process.dlopen` 加载同一个
     * `libnode_bridge.so`（宿主桥的 Node→原生入口），而 Node 无法从进程环境推出 HAP 的 libs 目录。
     * 放在用户 env 之后 ⇒ 库拥有该键，应用不能覆盖（与其它 NODE_BRIDGE_* 同口径）。
     */
    const envPairs: string = (basePairs.length === 0 ? '' : basePairs + '\n')
      + 'NODE_BRIDGE_LIBDIR=' + libDir;

    // 快照「实际生效参数」供事后读回（FR-001-020）
    this.options = NodeRuntime.snapshot(options, script, entry, payloadRoot, readonlyRoot, flags,
      libDir, home, logPath, cwd);
    this.logPath = logPath;
    this.home = home;  // B1：记住实际生效的 home（可能是 options.homeDir）
    this.context = context;

    if (options.onLog !== undefined && !this.onLogWarned) {
      this.onLogWarned = true;
      Logger.warn('NodeRuntimeOptions.onLog 未实现：**推送**通道仍未提供（传输层已可用，但方向是'
        + 'Node 调 ArkTS 的请求/响应，不是日志流；要做日志推送得再加一条订阅式通道）。'
        + '日志不会丢，请用 logs() 主动读 ' + logPath + ' 的尾部；本次忽略该回调（不静默）。');
    }

    this.setState(NodeState.STARTING, '已投递启动参数');

    /*
     * 传输泵必须在 `nodeBridge.start` **之前**起来：载荷在启动早期就会 `host.invoke()`
     * （物化 agent 资源后的自检、`runtime.facts` 探针）。泵晚起 ⇒ 那些早期调用只能等 15 s 超时。
     */
    try {
      const pumpState: string = this.host.startTransport(100);
      Logger.info('host-bridge 传输泵：' + pumpState);
    } catch (e) {
      Logger.warn('host-bridge 传输泵启动失败（宿主能力将不可达，但不阻断 Node 启动）：'
        + Logger.describeThrown(e));
    }

    let rc: number = 0;
    try {
      rc = nodeBridge.start(libDir, script, flagsForNative, home, logPath, envPairs);
    } catch (e) {
      // 引导件缺符号 / 版本不匹配：仍然按结构化失败返回，不把异常抛给 UI 线程
      const detail: string = Logger.describeThrown(e);
      this.lastError = '原生调用抛错：' + detail;
      Logger.error('nodeBridge.start 调用抛错（引导件版本不匹配？）：' + detail);
      this.setState(NodeState.FAILED, this.lastError);
      return {
        ok: false,
        code: -3,
        state: this.state,
        message: '原生引导件调用失败（libnode_bridge.so 版本不匹配？）：' + detail
      };
    }

    if (rc !== 0) {
      const native: string = this.getLastError();
      /*
       * A8：按返回码的**符号**分流。旧文案把所有非 0 都写成「pthread_create 失败」，
       * 而 -1（第二道单例守卫拒绝）与 -2（原生参数校验失败）都不是线程创建问题 ——
       * 拿错原因的排障成本远大于多写三行（契约 §2.4 的取值域 / C2 不隐藏真相）。
       */
      let why: string;
      if (rc === -1) {
        why = '原生层拒绝了重复投递（本进程已投递过，node::Start 每进程一次）';
      } else if (rc === -2) {
        why = '原生层参数校验失败（路径类参数被截断 / 必填项为空；详见 lastError）';
      } else {
        why = '原生层 pthread_create 失败 rc=' + rc + '（Node 日志：' + logPath + '）';
      }
      this.lastError = '投递失败 rc=' + rc + (native.length > 0 ? '；native=' + native : '');
      Logger.error('nodeBridge.start 投递失败 rc=' + rc + ' native=' + native + '（见 node.log：' + logPath + '）');
      this.setState(NodeState.FAILED, this.lastError);
      return {
        ok: false,
        code: rc,
        state: this.state,
        message: why
      };
    }

    Logger.info('Node 已投递启动：flags=' + flagsForNative + ' script=' + script + ' libDir=' + libDir
      + ' home=' + home + ' log=' + logPath
      + ' envPairs=' + NodeRuntime.countPairs(envPairs) + ' 对（键值不落日志：env 可能含凭据）');
    return { ok: true, code: 0, state: NodeState.STARTING, message: '已投递启动' };
  }

  /**
   * 轮询原生探针直到 Node 主循环起来（默认 15 s，每 100 ms 一次）。
   *
   * 成功 ⇒ `markRunning()` 并 resolve；超时/已失败/引导线程已退出 ⇒ `markFailed()` 后
   * **reject** 一个 `Error`，`message` 里一定带 `stage` / `lastError` / `logPath`
   * ——失败态 UI 需要的就是这三样（契约 §2.6 / §5.10 ⑭「失败立刻回退，不要等满超时」）。
   */
  async waitUntilRunning(timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
    const timeout: number = timeoutMs > 0 ? timeoutMs : 0;
    const deadline: number = Date.now() + timeout;
    while (!this.isRunning()) {
      if (this.state === NodeState.FAILED) {
        throw new Error(this.waitFailMessage('状态已为 failed'));
      }
      if (this.getStage() === 'exited') {
        const msg: string = this.waitFailMessage('引导阶段 exited（Node 主循环已返回）');
        this.markFailed(msg);
        throw new Error(msg);
      }
      if (Date.now() >= deadline) {
        const msg: string = this.waitFailMessage('超时 ' + timeout + ' ms');
        this.markFailed(msg);
        throw new Error(msg);
      }
      await NodeRuntime.sleep(WAIT_POLL_INTERVAL_MS);
    }
    this.markRunning();
  }

  /**
   * 标记为运行中 —— 由消费方在**探活成功**后调用，或由 `waitUntilRunning()` 在探针命中后调用。
   * 库不做「自动推定就绪」：探活策略（端口/退避/超时）属于消费方契约。
   */
  markRunning(): void {
    if (this.state === NodeState.STARTING) {
      this.setState(NodeState.RUNNING, '探针命中');
    }
  }

  /** 标记为失败（探活超时 / 读到崩溃记录时调用）。`idle` 状态不改变状态（FR-001-024） */
  markFailed(reason: string): void {
    if (this.state === NodeState.IDLE) {
      return;
    }
    this.lastError = reason;
    this.setState(NodeState.FAILED, reason);
    Logger.error('Node 运行失败：' + reason);
  }

  /**
   * 读日志尾（默认 `logRingSize` 行，缺省 500）。
   *
   * **永不抛**：路径未知/读失败都返回**单条 `system` 提示**（契约 §2.6）。
   * 解析规则见契约 §2.5：`out|err|sys` → `stdout|stderr|system`；无法解析的行
   * **保留原文**（`at: 0`），绝不丢信息。
   */
  logs(count?: number): NodeLogEntry[] {
    const entries: NodeLogEntry[] = [];
    const path: string = this.logPath;
    if (path.length === 0) {
      entries.push({ at: 0, stream: 'system', text: '(log path unknown: start() 尚未调用，无日志可读)' });
      return entries;
    }
    const ring: number = this.ringSize();
    const want: number = count !== undefined && count > 0 ? count : ring;
    const maxBytes: number = Math.max(LOG_TAIL_MIN_BYTES, want * LOG_TAIL_BYTES_PER_LINE);
    const lines: string[] = Logger.tailLines(path, maxBytes, want);
    for (let i = 0; i < lines.length; i++) {
      entries.push(NodeRuntime.parseLogLine(lines[i]));
    }
    return entries;
  }

  /**
   * 最近一次崩溃记录（`<home>/node-bridge/last-crash.json`，契约 §1.4 / §2.6）。
   *
   * **缺文件 ⇒ `null`**（契约明文：还没崩过）；**文件存在但不可解析 ⇒ 降级记录**（B2）：
   * 原生 handler 用 `O_TRUNC` 覆盖写，二次致命信号会留下截断/零字节文件 ——
   * `specs/006 FR-006-015` 要求此时从日志尾的 `sys <ms> … CRASH ` 行重建 `at`/`signal`
   * （`stage: ''`，因为 stage 只在 JSON 里），否则「崩过」会退化成「没有崩溃」。
   * `logTail` 由 ArkTS 侧补日志尾 20 行 —— 崩溃 handler 内禁止 stdio（宪法 S5）。**永不抛**。
   */
  lastCrash(): CrashRecord | null {
    const ctx: common.Context | undefined = this.context;
    if (ctx === undefined) {
      if (!this.crashContextWarned) {
        this.crashContextWarned = true;
        Logger.warn('lastCrash() 在 start() 之前调用：不知道 filesDir，返回 null（不猜路径）');
      }
      return null;
    }
    // B1：优先用 start() 时**实际生效**的 home（options.homeDir 可能不是 filesDir）；
    //     `Env.crashPath(context)` 仍是未指定 homeDir 时的文档化默认值。
    const path: string = this.home.length > 0
      ? this.home + '/node-bridge/last-crash.json'
      : Env.crashPath(ctx);

    let text: string = '';
    try {
      const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const ab: ArrayBuffer = new ArrayBuffer(CRASH_FILE_MAX_BYTES);
      let read: number = 0;
      try {
        read = fs.readSync(file.fd, ab, { offset: 0, length: CRASH_FILE_MAX_BYTES });
      } finally {
        fs.closeSync(file);
      }
      // read <= 0 视为「存在但不可用」（零字节 = 二次信号打断 O_TRUNC 后的写）⇒ 走降级路径
      text = read > 0 ? buffer.from(ab, 0, read).toString('utf-8') : '';
    } catch (e) {
      // 缺文件是最常见的情况（还没崩过）⇒ 契约明确要求返回 null，不抛
      return null;
    }

    let parsed: Object | null = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return this.degradedCrashFromLog(path, 'JSON 不可解析（被截断 / 零字节）');
    }
    if (parsed === null) {
      return this.degradedCrashFromLog(path, 'JSON 解析结果为空');
    }
    const rec: CrashJson = parsed as CrashJson;

    const tailEntries: NodeLogEntry[] = this.logs(CRASH_LOG_TAIL_LINES);
    const logTail: string[] = [];
    for (let i = 0; i < tailEntries.length; i++) {
      logTail.push(tailEntries[i].text);
    }

    const out: CrashRecord = {
      at: rec.at !== undefined ? rec.at : 0,
      stage: rec.stage !== undefined ? rec.stage : '',
      logTail: logTail
    };
    if (rec.signal !== undefined) {
      out.signal = rec.signal;
    }
    if (rec.hint !== undefined) {
      out.hint = rec.hint;
    }
    return out;
  }

  /**
   * B2：JSON 不可用时的降级记录（`specs/006 FR-006-015`）。
   *
   * 从日志尾找最后一条 `sys <ms> … CRASH …` 行，抽出 `at`（行自带 epochMs）与 `signal`（`sig=<n>`）。
   * 找不到 CRASH 行也**必须返回记录**（at=0、无 signal）—— 「文件在但读不出」不等于「没崩过」。
   * `stage: ''`：stage 只写在 JSON 里，原生 CRASH 行不含该字段，这里不猜。
   */
  private degradedCrashFromLog(jsonPath: string, because: string): CrashRecord {
    const tailEntries: NodeLogEntry[] = this.logs(CRASH_LOG_TAIL_LINES);
    const logTail: string[] = [];
    for (let i = 0; i < tailEntries.length; i++) {
      logTail.push(tailEntries[i].text);
    }
    let at: number = 0;
    let signal: string | undefined = undefined;
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      const e: NodeLogEntry = tailEntries[i];
      if (e.stream !== 'system' || e.text.indexOf('CRASH ') < 0) {
        continue;
      }
      if (e.at > 0) {
        at = e.at;
      }
      signal = NodeRuntime.signalFromCrashText(e.text);
      break;
    }
    Logger.warn('lastCrash() 走降级路径（' + because + '）：json=' + jsonPath
      + ' ⇒ 从日志尾 CRASH 行重建 at=' + at
      + ' signal=' + (signal !== undefined ? signal : '(未找到 CRASH 行)'));
    const out: CrashRecord = { at: at, stage: '', logTail: logTail };
    if (signal !== undefined) {
      out.signal = signal;
    }
    return out;
  }

  /** 从 `CRASH sig=<n> …` 文本映射回信号名（与原生 `sig_name()` 同一张表；未知则 `SIG<n>`） */
  private static signalFromCrashText(text: string): string | undefined {
    const idx: number = text.indexOf('sig=');
    if (idx < 0) {
      return undefined;
    }
    let end: number = idx + 4;
    while (end < text.length) {
      const c: number = text.charCodeAt(end);
      if (c < 0x30 || c > 0x39) {
        break;
      }
      end++;
    }
    const num: number = NodeRuntime.decMs(text.substring(idx + 4, end));
    if (num < 0) {
      return undefined;
    }
    if (num === 11) {
      return 'SIGSEGV';
    }
    if (num === 4) {
      return 'SIGILL';
    }
    if (num === 7) {
      return 'SIGBUS';
    }
    if (num === 6) {
      return 'SIGABRT';
    }
    if (num === 8) {
      return 'SIGFPE';
    }
    if (num === 5) {
      return 'SIGTRAP';
    }
    return 'SIG' + num;
  }

  /**
   * 关停请求（**不假装能停**）。
   *
   * 进程内 `node::Start` 直到进程结束才返回，没有优雅停止接口 ⇒ 本方法只做两件事：
   * 标记 `stopping` + 把 `reason` 记进 `getLastError()`，并 `warn` 说明真相。
   * 真正的关停钩子（Node 侧 `onShutdown`，如 `server.close()`）Phase 2 才经宿主桥接线
   * （契约 §2.6 / 规划 §5.2；宪法 C2 禁止假装恢复）。
   */
  shutdown(reason: string): Promise<void> {
    if (this.state === NodeState.STARTING || this.state === NodeState.RUNNING) {
      this.lastError = reason;
      this.setState(NodeState.STOPPING, 'shutdown: ' + reason);
      Logger.warn('shutdown 已记录（reason=' + reason + '）：进程内 Node **无法优雅停止** ——'
        + 'node::Start 不返回，只有整个进程退出才算停；Node 侧 onShutdown 钩子 Phase 2 经宿主桥提供。'
        + '本次不做任何实际关停。');
      // 传输泵随状态一起停：Node 已经不在了，继续轮询只会空转
      try {
        this.host.stopTransport();
      } catch (e) {
        Logger.warn('shutdown 停传输泵失败（忽略）：' + Logger.describeThrown(e));
      }
      return Promise.resolve();
    }
    if (this.state === NodeState.FAILED || this.state === NodeState.STOPPED) {
      Logger.warn('shutdown 忽略：Node 已结束（state=' + this.state + '），无需关停');
      return Promise.resolve();
    }
    Logger.warn('shutdown 忽略：尚未启动（state=' + this.state + '）');
    return Promise.resolve();
  }

  /** 运行时默认读尾条数（`logRingSize`，缺省 500） */
  private ringSize(): number {
    const opts: NodeRuntimeOptions | undefined = this.options;
    if (opts !== undefined && opts.logRingSize !== undefined && opts.logRingSize > 0) {
      return opts.logRingSize;
    }
    return DEFAULT_LOG_RING_SIZE;
  }

  /**
   * 状态迁移的唯一入口：写状态 + 留日志 + **同步**回调 `onStateChange`。
   *
   * 回调抛错不能让状态机停摆，也不能被吞掉（C2）⇒ 捕获后进 `error` 日志。
   */
  private setState(next: NodeState, detail?: string): void {
    if (this.state === next) {
      return;
    }
    const prev: NodeState = this.state;
    this.state = next;
    Logger.info('Node 状态迁移：' + prev + ' → ' + next + (detail !== undefined ? '（' + detail + '）' : ''));
    const opts: NodeRuntimeOptions | undefined = this.options;
    if (opts === undefined || opts.onStateChange === undefined) {
      return;
    }
    try {
      if (detail === undefined) {
        opts.onStateChange(next);
      } else {
        opts.onStateChange(next, detail);
      }
    } catch (e) {
      Logger.error('onStateChange 回调抛错（状态机不受影响）：' + Logger.describeThrown(e));
    }
  }

  private waitFailMessage(detail: string): string {
    return 'Node 未进入运行态（' + detail + '）：stage=' + this.getStage()
      + '，lastError=' + this.getLastError() + '，log=' + this.logPath;
  }

  /** 相对入口按 **payloadRoot** 变绝对（S4：绝不把相对路径交给 `node::Start`） */
  private static absoluteUnder(p: string, root: string): string {
    if (p.length === 0) {
      return '';
    }
    if (p.startsWith('/')) {
      return p;
    }
    let rel: string = p;
    while (rel.startsWith('./')) {
      rel = rel.substring(2);
    }
    return root + '/' + rel;
  }

  /**
   * 把（可能是相对路径的）应用入口解析成**绝对路径**。
   *
   * 解析基顺序：`readonlyRoot` → `payloadRoot`（契约 §3.3 运行根顺序 `archive → readonlyRoot → payloadRoot`
   * 在 ArkTS 侧的对应；`archive` 路线的真实运行根只有 Node 侧知道，故那种情况应同时给 `scriptPath`，
   * 由库的 bootstrap 再解析一次）。
   */
  private static resolveEntry(p: string, readonlyRoot: string, payloadRoot: string): string {
    if (p.length === 0) {
      return '';
    }
    if (p.startsWith('/')) {
      return p;
    }
    const base: string = readonlyRoot.length > 0 ? readonlyRoot : payloadRoot;
    return NodeRuntime.absoluteUnder(p, base);
  }

  /**
   * 装配 `envPairs`（契约 §1.2：`K=V` 以 `\n` 连接，值内不得含 `\n`）。
   *
   * 顺序即优先级（原生层同一 key 后者覆盖前者，且原生默认值在 envPairs **之前**设置）：
   * ① `NODE_BRIDGE_*`（由 options 推导，契约 §3.1）→ ② `options.env`（用户值最终胜出）。
   *
   * **不注入**任何应用语义变量（`PI_*` 一类名字的解释权在消费方，宪法 C1）：要传就走
   * `options.env` 自己传 —— 它在 `NODE_BRIDGE_*` 之后应用，覆盖顺序仍然正确。
   */
  private static buildEnvPairs(payloadRoot: string, entry: string, archive: string | undefined,
    archiveSha256: string | undefined, readonlyRoot: string, cwd: string,
    userEnv: Record<string, string> | undefined): string {
    const pairs: string[] = [];
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_PAYLOAD_ROOT', payloadRoot);
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_ENTRY', entry);
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_ARCHIVE', archive);
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_ARCHIVE_SHA256', archiveSha256);
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_READONLY_ROOT', readonlyRoot);
    NodeRuntime.pushPair(pairs, 'NODE_BRIDGE_CWD', cwd);
    if (userEnv !== undefined) {
      const keys: string[] = Object.keys(userEnv);
      for (let i = 0; i < keys.length; i++) {
        const k: string = keys[i];
        NodeRuntime.pushPair(pairs, k, userEnv[k]);
      }
    }
    return pairs.join('\n');
  }

  /** 单对 K=V 入列；空值不注入（保留原生/Node 侧默认值），含换行的值丢弃并 `warn` */
  private static pushPair(pairs: string[], key: string, value: string | undefined): void {
    if (value === undefined || value.length === 0) {
      return;
    }
    if (value.indexOf('\n') >= 0) {
      // 契约 §1.2：值内换行会破坏「一值一行」编码 ⇒ 丢弃该对，且必须让人看得见
      Logger.warn('envPairs 丢弃 ' + key + '：值含换行（契约 §1.2 规定 K=V 以 \\n 分隔）');
      return;
    }
    pairs.push(key + '=' + value);
  }

  private static countPairs(envPairs: string): number {
    return envPairs.length === 0 ? 0 : envPairs.split('\n').length;
  }

  /**
   * 解析一行日志（契约 §1.3：`<stream> <epochMs> <text>`）。
   * 无法解析 ⇒ `{ at: 0, stream: 'system', text: <原行> }`（保留原文，不丢信息）。
   */
  private static parseLogLine(line: string): NodeLogEntry {
    const entry: NodeLogEntry = { at: 0, stream: 'system', text: line };
    const sp1: number = line.indexOf(' ');
    if (sp1 > 0) {
      const tag: string = line.substring(0, sp1);
      const rest: string = line.substring(sp1 + 1);
      const sp2: number = rest.indexOf(' ');
      if (sp2 > 0) {
        const ms: number = NodeRuntime.decMs(rest.substring(0, sp2));
        if (ms >= 0) {
          const body: string = rest.substring(sp2 + 1);
          if (tag === 'out') {
            entry.at = ms;
            entry.stream = 'stdout';
            entry.text = body;
          } else if (tag === 'err') {
            entry.at = ms;
            entry.stream = 'stderr';
            entry.text = body;
          } else if (tag === 'sys') {
            entry.at = ms;
            entry.stream = 'system';
            entry.text = body;
          }
        }
      }
    }
    return entry;
  }

  /** 十进制时间戳解析（不依赖 `parseInt`：逐位累加，非数字即 -1 = 无法解析） */
  private static decMs(s: string): number {
    if (s.length === 0) {
      return -1;
    }
    let v: number = 0;
    for (let i = 0; i < s.length; i++) {
      const c: number = s.charCodeAt(i);
      if (c < 0x30 || c > 0x39) {
        return -1;
      }
      v = v * 10 + (c - 0x30);
    }
    return v;
  }

  /** 「实际生效参数」快照：缺省值已解析、`flags` 已含 jitless 补丁（FR-001-020） */
  private static snapshot(options: NodeRuntimeOptions, script: string, entry: string,
    payloadRoot: string, readonlyRoot: string, flags: string, libDir: string, home: string,
    logPath: string, cwd: string): NodeRuntimeOptions {
    const snap: NodeRuntimeOptions = {
      scriptPath: script,
      payloadRoot: payloadRoot,
      readonlyRoot: readonlyRoot,
      flags: flags,
      libDir: libDir,
      homeDir: home,
      logPath: logPath
    };
    if (entry.length > 0) {
      snap.entry = entry;
    }
    if (options.archive !== undefined) {
      snap.archive = options.archive;
    }
    if (options.archiveSha256 !== undefined) {
      snap.archiveSha256 = options.archiveSha256;
    }
    if (options.argv !== undefined) {
      snap.argv = options.argv;
    }
    if (options.execArgv !== undefined) {
      snap.execArgv = options.execArgv;
    }
    if (options.env !== undefined) {
      snap.env = options.env;
    }
    if (cwd.length > 0) {
      snap.cwd = cwd;
    }
    if (options.capBytes !== undefined) {
      snap.capBytes = options.capBytes;
    }
    if (options.logRingSize !== undefined) {
      snap.logRingSize = options.logRingSize;
    }
    if (options.jitless !== undefined) {
      snap.jitless = options.jitless;
    }
    if (options.onStateChange !== undefined) {
      snap.onStateChange = options.onStateChange;
    }
    // 刻意**不**把 onLog 带进快照：它未被实现，带进去会让人误以为接了线
    return snap;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}
