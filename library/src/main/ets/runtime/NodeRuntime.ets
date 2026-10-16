import { common } from '@kit.AbilityKit';
import nodeBridge from 'libnode_bridge.so';
import { Logger } from '../log/Logger';
import { Env } from '../util/Env';
import { NodeRuntimeOptions, NodeStartResult, NodeState } from './Types';

/**
 * 001-runtime-core —— 进程内 Node 运行时单例。
 *
 * 三条不可违背的约束（都是真机实测结论，见工程规划 §5.10 / §D.8）：
 *
 * 1. **`node::Start` 每进程只能调用一次**（Node 内部 `limit_checker` 断言）⇒ 状态机
 *    `idle → starting → running|failed` **不可重启**；要"重启"只能重启整个应用。
 * 2. **启动必须在 detached pthread（32 MB 栈）内**完成，绝不能在 UI 线程调用
 *    （否则 `APP_INPUT_BLOCK`，先例的旧版本就这么被系统杀掉）。
 * 3. **崩溃是终态**：进程内 Node 崩溃无法自动拉起（硬约束 ⑥），
 *    消费方只能靠 `node.log` + 原生层 `CRASH sig=…` 取证，并提示用户重启应用。
 */
export class NodeRuntime {
  private static instance: NodeRuntime | undefined = undefined;

  private state: NodeState = NodeState.IDLE;
  private options: NodeRuntimeOptions | undefined = undefined;
  private logPath: string = '';

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

  getLogPath(): string {
    return this.logPath;
  }

  getOptions(): NodeRuntimeOptions | undefined {
    return this.options;
  }

  /**
   * 投递启动（**幂等保护**：只有 `idle` 允许调用）。
   *
   * 返回 `ok=true` 只代表**已成功投递到后台线程**，不代表 Node 已经起来 ——
   * 判断"起来了"的正确方式是轮询宿主服务端口（消费方约定，见工程规划 §6.1 状态机）。
   */
  start(context: common.Context, options: NodeRuntimeOptions): NodeStartResult {
    if (this.state !== NodeState.IDLE) {
      return {
        ok: false,
        code: -1,
        state: this.state,
        message: 'Node 只能启动一次（node::Start 每进程一次）；当前状态=' + this.state
      };
    }

    Env.ensureRuntimeDirs(context);

    const libDir: string = options.libDir !== undefined ? options.libDir : context.bundleCodeDir;
    const home: string = options.homeDir !== undefined ? options.homeDir : context.filesDir;
    const logPath: string = options.logPath !== undefined ? options.logPath : Env.logPath(context);
    const flags: string = options.flags !== undefined ? options.flags : '--no-verify-heap';

    this.state = NodeState.STARTING;
    this.options = options;
    this.logPath = logPath;

    const rc: number = nodeBridge.start(libDir, options.scriptPath, flags, home, logPath);
    if (rc !== 0) {
      this.state = NodeState.FAILED;
      Logger.error('nodeBridge.start 投递失败 rc=' + rc + '（见 node.log：' + logPath + '）');
      return {
        ok: false,
        code: rc,
        state: this.state,
        message: '原生层 pthread_create 失败 rc=' + rc
      };
    }

    Logger.info('Node 已投递启动：flags=' + flags + ' script=' + options.scriptPath + ' log=' + logPath);
    return { ok: true, code: 0, state: NodeState.STARTING, message: '已投递启动' };
  }

  /**
   * 标记为运行中 —— 由消费方在**探活成功**后调用（库不替消费方猜）。
   * 库不做自动轮询：探活策略（端口/退避/超时）属于消费方契约。
   */
  markRunning(): void {
    if (this.state === NodeState.STARTING) {
      this.state = NodeState.RUNNING;
    }
  }

  /** 标记为失败（探活超时 / 读到崩溃记录时由消费方调用） */
  markFailed(reason: string): void {
    if (this.state !== NodeState.IDLE) {
      this.state = NodeState.FAILED;
      Logger.error('Node 运行失败：' + reason);
    }
  }
}
