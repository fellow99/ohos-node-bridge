import { buffer } from '@kit.ArkTS';
/** 文件信箱的目录/文件操作（`@kit.CoreFileKit`；与 Node 侧 `node:fs` 同一份文件系统视图） */
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import nodeBridge from 'libnode_bridge.so';
import { HostBridgeHandler } from '../runtime/Types';
import { Logger } from '../log/Logger';

/** 单次 JSON 载荷上限默认值：8 MiB（规划 §5.4 / 契约 §2.3 `capBytes`） */
const DEFAULT_CAP_BYTES: number = 8 * 1024 * 1024;

// ── 文件信箱传输的常量（与 Node 侧 `payload/host.js` 逐项同口径）───────────────
/** 请求文件后缀（Node 写、本类消费） */
const MAILBOX_REQ: string = '.req';
/** 临时后缀（先写它再 rename，保证读方只看到完整的 JSON） */
const MAILBOX_TMP: string = '.tmp';
/** 处理中后缀（`.req` rename 成它 = 「取走」；崩在这里能从文件名看出「谁在处理」） */
const MAILBOX_WIP: string = '.wip';
/** 成功结果后缀 */
const MAILBOX_DONE: string = '.done';
/** 失败结果后缀 */
const MAILBOX_FAIL: string = '.fail';
/** 心跳文件名（落在信箱目录内；列目录时靠后缀过滤，不会被当成请求） */
const MAILBOX_HEARTBEAT: string = 'heartbeat.log';
/** 心跳文件轮转阈值：超过就整体重写（长期运行不能无限增长） */
const MAILBOX_HEARTBEAT_MAX_BYTES: number = 65536;
/**
 * 陈旧文件回收阈值：10 分钟。
 *
 * **必须大于一次合法调用的最长耗时**，否则会误删正在处理的请求。选 10 分钟的理由：
 * 目前最长的是「用户手动选目录」（`fs.pickFolder`，可能几十秒到几分钟），10 分钟留足余量；
 * 同时保证真卡死（写入方崩溃）时能在可接受时间内自愈。在飞的那一个另有豁免（见 mailboxReap）。
 */
const MAILBOX_STALE_MS: number = 600000;

/**
 * `.req` 文件的内容结构（Node 侧 `invokeViaMailbox` 写入）。
 *
 * `args` 是**已序列化的 JSON 文本**而不是嵌套对象：与原生通道的 `args` 字段同形，
 * 两条传输交给 `dispatch()` 的都是同一种输入（否则 handler 要判两种形状）。
 */
class MailboxEnvelope {
  name: string = '';
  args: string = '{}';
  /** 写入方 pid（诊断用：能一眼看出请求来自哪一个进程实例） */
  pid: number = 0;
  ts: number = 0;
}

/**
 * `dispatch()` 的结构化失败形状（只取拆包需要的两个字段）。
 *
 * 与 `HostBridge.dispatch()` 的产出**同源**：`{"ok":false,"error":"<code>","detail":"…"}`。
 */
class DispatchFailure {
  error: string = '';
  detail: string = '';
}

/**
 * 原生层 `pollHostRequest()` 返回的请求结构（字段名与 `node_bridge.c` 的 snprintf 一致）。
 * 只做类型载体：`args` 是**已经转过义**的 JSON 文本，用前先 JSON.parse。
 */
class HostRequest {
  id: number = 0;
  name: string = '';
  args: string = '';
}

/**
 * 003-host-bridge —— Node ↔ ArkTS 双向调用。
 *
 * 传输层状态（2026-10-17，行动项 E18 —— 已换路并跑通）：
 *
 *   ① ✅ **Node → ArkTS：文件信箱（主路）**。`startMailbox(dir, 100)` 起一个 100 ms 轮询泵，
 *      扫 `<dir>/*.req` → rename 成 `.wip`（取走）→ `dispatch()` → 写 `.done`/`.fail`。
 *      换路的依据是**原生的两条路都实测不通**（不是没试）：
 *        · 主桥 `.so` 已被 ArkTS 侧 import 进 **libace_napi**，Node 再 `require` 得到
 *          `Module did not self-register`；导出 `napi_register_module_v1` 后 `napi_*`
 *          绑到 libace_napi 的实现、却收到 Node 的 env ⇒ **整个应用进程静默消失**；
 *        · 专用 addon 的 `DT_NEEDED` 缺 libnode ⇒ 6 个 `napi_*` 无人可解
 *          （`napi_create_function: symbol not found`）。
 *      文件信箱两侧同 UID、同文件系统视图，每个中间态都是可 `hdc shell cat` 的文件
 *      ⇒ 失败可诊断；代价是 ≤100 ms 延迟，而宿主能力全是用户显式动作。
 *   ② ⚠️ 原生槽位表（`startTransport` / `pollHostRequest` / `completeHostRequest`）**保留但不再是主路**：
 *      它给 ArkTS **内部**留一条同进程通路，且已有编译与自检覆盖；拆掉没有收益，只会多一次回归面。
 *      同理 `callHost`（Node→原生）保留给将来「专用 addon 补齐链接闭包」时用。
 *   ③ ✅ 上限与失败语义不变：name 128 B / args 8 KB / result 64 KB（原生）；
 *      信箱侧由 `dispatch()` 统一产出 `{"ok":false,"error":…}`，Node 侧 `invoke()` 原样上抛。
 *   ④ ✅ 超时：信箱默认 15 s（`host.js#MAILBOX_TIMEOUT_MS`），可**逐次**放宽
 *      （`fs.pickFolder` 这类由用户决定耗时的能力必须放宽，否则必然超时）。
 * **能力实现不在本库**（宪法 C1）：本类只做「寄存器 + 传输」；`CAPABILITIES` 仅用于诊断与自检。
 */
export class HostBridge {
  /**
   * v1 能力名清单（**冻结命名**，契约 §2.7 / 规划 §5.4）。只用于日志与自检，
   * 库**不实现**其中任何一个 —— 每个能力都是宿主语义（选择器、通知、权限、外链），属消费方（C1）。
   */
  static readonly CAPABILITIES: string[] = [
    'runtime.facts',
    'perm.check',
    'perm.openAppInfo',
    'fs.pickFiles',
    'fs.pickFolder',
    'shell.openExternal',
    'notify.show',
    'log.hilog'
  ];

  private handlers: Map<string, HostBridgeHandler> = new Map<string, HostBridgeHandler>();
  private invocations: number = 0;
  private errors: number = 0;
  private capBytes: number = DEFAULT_CAP_BYTES;
  /** 传输泵定时器句柄（-1 = 未启动） */
  private pumpTimer: number = -1;
  private pumpRounds: number = 0;
  private pumpDispatched: number = 0;
  private pumpErrors: number = 0;
  // ── 文件信箱泵（E18 主路）的状态 ──────────────────────────────────────────
  /** 信箱定时器句柄（-1 = 未启动） */
  private mailboxTimer: number = -1;
  /** 信箱目录（空串 = 未接线；由消费方给出） */
  private mailboxDir: string = '';
  private mailboxRounds: number = 0;
  private mailboxDispatched: number = 0;
  private mailboxErrors: number = 0;
  private mailboxReaped: number = 0;
  /**
   * 正在处理的请求 id（空串 = 空闲）。
   *
   * 用途只有一个但很关键：陈旧回收**必须**放过在飞的那一个 —— 否则
   * 「用户选了 8 分钟文件夹」会被 10 分钟的阈值之外的误删规则牵连（更别说将来把阈值调小）。
   */
  private mailboxInflight: string = '';

  /** 注册一个能力（同名覆盖） */
  register(name: string, handler: HostBridgeHandler): void {
    this.handlers.set(name, handler);
  }

  /** 注销一个能力；返回**是否真的删掉了**（未注册时返回 false，便于调用方发现拼写错误） */
  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  /** 是否已注册（诊断用；也是「未注册必须报错」这一条的前置查询口，C2） */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** 已注册能力名列表（诊断用） */
  list(): string[] {
    const out: string[] = [];
    this.handlers.forEach((_v: HostBridgeHandler, k: string) => {
      out.push(k);
    });
    return out;
  }

  /**
   * 启动传输泵：**Node JS 线程 → ArkTS 主线程**的轮询端。
   *
   * 为什么是轮询而不是 `napi_threadsafe_function`：见 `node_bridge.c` 里「宿主桥传输」的长注释
   * —— tsfn 要在 ArkTS env 上创建，而 HarmonyOS ArkTS NAPI 对它的支持未经验证；一旦不支持就是
   * 启动期硬失败。轮询用最多 100 ms 的延迟换零平台风险，而宿主能力全是用户动作。
   *
   * 幂等：重复调用只返回当前状态，不重复起定时器。
   * @returns 人读状态串（同时进日志）
   */
  startTransport(intervalMs: number): string {
    if (this.pumpTimer >= 0) {
      return 'already-running:' + this.pumpDispatched + '/' + this.pumpRounds;
    }
    const iv: number = intervalMs > 0 ? intervalMs : 100;
    this.pumpTimer = setInterval(() => {
      this.pumpTick();
    }, iv);
    Logger.info('host-bridge: 传输泵已启动（轮询 ' + iv + ' ms，方向 Node→ArkTS；'
      + '原生侧上限 name=128B args=8KB result=64KB 超时=15s）');
    return 'started:' + iv + 'ms';
  }

  /** 停止传输泵（幂等） */
  stopTransport(): void {
    if (this.pumpTimer < 0) {
      return;
    }
    clearInterval(this.pumpTimer);
    this.pumpTimer = -1;
    Logger.info('host-bridge: 传输泵已停止（累计轮询 ' + this.pumpRounds
      + ' 次 / 分发 ' + this.pumpDispatched + ' 次 / 错误 ' + this.pumpErrors + ' 次）');
  }

  /** 诊断串（诊断面板与日志用；不含任何载荷内容） */
  transportStats(): string {
    return 'running=' + (this.pumpTimer >= 0)
      + ' rounds=' + this.pumpRounds
      + ' dispatched=' + this.pumpDispatched
      + ' errors=' + this.pumpErrors;
  }

  // ── 文件信箱传输（E18 主路）：Node → ArkTS ──────────────────────────────────
  //
  // 协议与 Node 侧 `payload/host.js#invokeViaMailbox` 逐字对应：
  //   Node 写 `<dir>/<id>.tmp` → rename → `<id>.req`
  //   本类每 100 ms 扫一遍：`.req` → rename 成 `.wip`（取走即改名）→ dispatch()
  //                        → 写 `<id>.tmp` → rename → `<id>.done` | `<id>.fail`
  //   Node 读到结果后清掉五件套；本类只负责**回收无人认领的陈旧文件**（崩溃/断电残留）。
  //
  // 为什么这条是主路：原生传输的两条路都实测不通（见 `node_bridge.c` 长注释与
  // `payload/host.js` 文件头）。文件信箱两侧同 UID、同文件系统视图，每个中间态都是
  // 一个可 `hdc shell cat` 的文件 ⇒ 失败可诊断，而代价只是最多 100 ms 延迟
  // （宿主能力全是用户显式动作，延迟不可感知）。
  //
  // 保留原生槽位表（`startTransport`）不动：它给 ArkTS **内部**留一条同进程通路，
  // 且已通过编译与自检；拆掉它没有收益，只会多一次回归面。

  /**
   * 启动文件信箱泵（幂等：重复调用只返回当前状态）。
   *
   * 之所以**必须常驻**而不是用时才起：Node 侧写 `.req` 是**随时**可能发生的
   * （扩展、钩子、启动期自检），桥没起来 ⇒ `.req` 堆在目录里没人处理 ⇒ Node 侧只能超时。
   * 这与宿主侧「原生层只暴露三个函数、没有消息通道」是同一个约束的两种表达。
   *
   * @param dir 信箱目录（由**消费方**给出：库不解释沙箱路径，C1）
   * @param intervalMs 轮询间隔（默认/下限都用 100 ms：10 Hz 对主机 CPU 可忽略）
   * @returns 人读状态串（同时进日志）
   */
  startMailbox(dir: string, intervalMs: number): string {
    if (this.mailboxTimer >= 0) {
      return 'already-running:' + this.mailboxDir + ':' + this.mailboxDispatched + '/' + this.mailboxRounds;
    }
    if (typeof dir !== 'string' || dir.length === 0) {
      Logger.warn('host-bridge: startMailbox 收到空目录 ⇒ 不启动（Node 侧会如实报 transport-unavailable）');
      return 'refused:empty-dir';
    }
    let mkdirError: string = '';
    try {
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir);
      }
    } catch (e) {
      const err = e as BusinessError;
      mkdirError = err.message;
    }
    if (mkdirError.length > 0) {
      // 建不出来就**不要**假装在跑：Node 侧写 .req 会失败并如实报 mailbox-write-failed
      Logger.warn('host-bridge: 信箱目录不可用（' + dir + '）：' + mkdirError);
      return 'refused:mkdir-failed:' + mkdirError;
    }
    this.mailboxDir = dir;
    const iv: number = intervalMs > 0 ? intervalMs : 100;
    this.mailboxTimer = setInterval(() => {
      this.mailboxTick();
    }, iv);
    this.mailboxHeartbeat('started dir=' + dir + ' pollMs=' + iv);
    Logger.info('host-bridge: 文件信箱泵已启动（' + dir + '，轮询 ' + iv
      + ' ms；协议 .req → .wip → .done/.fail；陈旧回收 ' + (MAILBOX_STALE_MS / 1000) + ' s）');
    return 'started:' + dir + ':' + iv + 'ms';
  }

  /** 停止文件信箱泵（幂等） */
  stopMailbox(): void {
    if (this.mailboxTimer < 0) {
      return;
    }
    clearInterval(this.mailboxTimer);
    this.mailboxTimer = -1;
    this.mailboxHeartbeat('stopped rounds=' + this.mailboxRounds
      + ' dispatched=' + this.mailboxDispatched + ' errors=' + this.mailboxErrors);
    Logger.info('host-bridge: 文件信箱泵已停止（累计 ' + this.mailboxRounds
      + ' 轮 / 分发 ' + this.mailboxDispatched + ' 次 / 错误 ' + this.mailboxErrors
      + ' 次 / 回收 ' + this.mailboxReaped + ' 个陈旧文件）');
  }

  /** 信箱诊断串（诊断面板与 `/diag` 用；不含任何载荷内容） */
  mailboxStats(): string {
    return 'running=' + (this.mailboxTimer >= 0)
      + ' dir=' + (this.mailboxDir.length > 0 ? this.mailboxDir : '(none)')
      + ' rounds=' + this.mailboxRounds
      + ' dispatched=' + this.mailboxDispatched
      + ' errors=' + this.mailboxErrors
      + ' reaped=' + this.mailboxReaped;
  }

  /**
   * 一轮信箱轮询：回收陈旧 → 取一个 `.req` → dispatch → 写回结果。
   *
   * **绝不抛**：任何异常都写进 `.fail`（否则 Node 侧只能等到自己超时，
   * 而"超时"与"处理器报错"是两件完全不同的事，混在一起就没法定位）。
   *
   * 一次只处理一个（串行）：宿主能力全是用户动作，串行让"上一单没清干净"不会互相干扰；
   * 而 10 Hz 的轮询频率远高于人点按钮的频率。
   */
  private mailboxTick(): void {
    this.mailboxRounds = this.mailboxRounds + 1;
    /*
     * 串行保证（E17/E20/E21 起必需）：异步能力的处理会横跨多个 tick，
     * 期间 `mailboxInflight` 非空 —— 必须早退，否则下一轮会**再取一个**请求，
     * 两个 `.wip` 同时在飞，串行语义（以及"在飞豁免回收"的判据）全部失效。
     */
    if (this.mailboxInflight.length > 0) {
      return;
    }
    const dir: string = this.mailboxDir;
    if (dir.length === 0) {
      return;
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (e) {
      this.mailboxErrors = this.mailboxErrors + 1;
      // 目录被删/不可读：只记一次，不要每 100 ms 刷屏
      if (this.mailboxRounds % 100 === 1) {
        Logger.warn('host-bridge: 列出信箱目录失败：' + Logger.describeThrown(e));
      }
      return;
    }
    this.mailboxReap(dir, names);
    const reqs: string[] = names.filter((n: string): boolean => n.endsWith(MAILBOX_REQ)).sort();
    if (reqs.length === 0) {
      // 每 50 轮（≈5 s）刷一次存活心跳：回答"泵是否真在跑"，与"有没有请求"是两件事
      if (this.mailboxRounds % 50 === 0) {
        this.mailboxHeartbeat('alive rounds=' + this.mailboxRounds
          + ' dispatched=' + this.mailboxDispatched + ' errors=' + this.mailboxErrors
          + ' reaped=' + this.mailboxReaped + ' pending=' + names.filter((n: string): boolean => n.endsWith(MAILBOX_REQ)).length);
      }
      return;
    }
    const name: string = reqs[0];
    const id: string = name.substring(0, name.length - MAILBOX_REQ.length);
    const reqPath: string = dir + '/' + name;
    let payload: string = '';
    try {
      payload = fs.readTextSync(reqPath);
    } catch (e) {
      return; // 下轮再试（可能正被 Node 侧写入，但那边是 .tmp+rename，理论不该发生）
    }
    /*
     * 完整性判据：空串、或不以 `}` 结尾 ⇒ 内容还没写完，等下一轮。
     *
     * 这条**不能省**：`.req` 由 Node 侧 `rename` 发布（原子），但断电/磁盘满仍可能留下
     * 半截文件；而一旦这种文件排到队首，本函数会每轮都返回、每轮都不处理它
     * ⇒ 队首被永久占住（宿主侧的语音桥就踩过这个坑）。配套的两道保险是
     * ① 陈旧回收覆盖 `.req`（见 mailboxReap）；② 这里只跳过、不消耗。
     */
    if (payload.length === 0 || !payload.endsWith('}')) {
      return;
    }
    const wipPath: string = dir + '/' + id + MAILBOX_WIP;
    try {
      fs.renameSync(reqPath, wipPath);
    } catch (e) {
      return; // 被别的轮次抢走了（不该发生：单定时器），或目录刚被换掉
    }
    this.mailboxInflight = id;
    this.mailboxDispatched = this.mailboxDispatched + 1;
    let reqName: string = '';
    let reqArgs: string = '{}';
    try {
      const parsed = JSON.parse(payload) as MailboxEnvelope;
      reqName = typeof parsed.name === 'string' ? parsed.name : '';
      reqArgs = typeof parsed.args === 'string' ? parsed.args : '{}';
    } catch (e) {
      this.mailboxErrors = this.mailboxErrors + 1;
      this.mailboxWrite(dir, id, MAILBOX_FAIL, '{"ok":false,"error":"bad-request",'
        + '"detail":"请求 JSON 无法解析"}');
      this.mailboxFinish(dir, id);
      this.mailboxHeartbeat('bad-request id=' + id);
      return;
    }
    this.mailboxHeartbeat('got id=' + id + ' name=' + reqName + ' bytes=' + payload.length);
    /*
     * 走**异步分发**（E17/E20/E21）：弹授权窗、选目录、发通知都是 Promise，
     * 而 `mailboxTick` 每 100 ms 被调一次 —— 不能在定时器回调里 await。
     * 做法：把「写结果 + 收尾」抽成 `mailboxSettle`，由 Promise 的 then 调它；
     * 在这期间 `mailboxInflight` 非空，下一轮 tick 直接早退（串行保证）。
     */
    this.dispatchAsync(reqName, reqArgs).then((result: string): void => {
      this.mailboxSettle(dir, id, result);
    }, (e: Object): void => {
      // dispatchAsync 契约上永不 reject；真 reject 了也必须回填，否则 Node 只能等超时
      this.mailboxErrors = this.mailboxErrors + 1;
      const body: string = '{"ok":false,"error":"host-dispatch-rejected","name":"'
        + HostBridge.jsonEsc(reqName) + '","detail":"' + HostBridge.jsonEsc(Logger.describeThrown(e)) + '"}';
      this.mailboxSettle(dir, id, body);
    });
  }

  /**
   * 把一次分发的结果写回信箱并收尾（同步/异步两条路共用）。
   *
   * 成功/失败都由结果的 JSON 决定（`ok === false` 即失败）：宿主侧只做字节搬运，
   * 不重复解释 —— 一处口径，两侧不会漂。
   */
  private mailboxSettle(dir: string, id: string, result: string): void {
    const ok: boolean = !HostBridge.isFailureJson(result);
    const writeOk: boolean = ok
      ? this.mailboxWrite(dir, id, MAILBOX_DONE, '{"ok":true,"result":"' + HostBridge.jsonEsc(result) + '"}')
      : this.mailboxWrite(dir, id, MAILBOX_FAIL, HostBridge.mailboxFailBody(result));
    if (!writeOk) {
      this.mailboxErrors = this.mailboxErrors + 1;
    }
    this.mailboxFinish(dir, id);
    this.mailboxHeartbeat('done id=' + id + ' ok=' + ok + ' writeOk=' + writeOk
      + ' resultBytes=' + result.length);
  }

  /** 收尾：清掉 `.wip`（成功/失败都要清，否则它会一直占着"处理中"的语义） */
  private mailboxFinish(dir: string, id: string): void {
    try {
      fs.unlinkSync(dir + '/' + id + MAILBOX_WIP);
    } catch (e) {
      // 忽略：陈旧回收兜底
    }
    this.mailboxInflight = '';
  }

  /**
   * 原子写一个结果文件（`.tmp` → rename）。
   *
   * 直接写目标名会让 Node 侧读到"写了一半的 JSON" —— 它那侧对半截文件的处理是
   * "下一轮再读"，看起来安全，但那会把一次成功退化成一次额外的 100 ms 延迟；
   * 更重要的是**失败无法区分**（读到半截 vs 结果本就是空的）。
   */
  private mailboxWrite(dir: string, id: string, suffix: string, body: string): boolean {
    const tmp: string = dir + '/' + id + MAILBOX_TMP;
    const dest: string = dir + '/' + id + suffix;
    try {
      const f: fs.File = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(f.fd, body);
      } finally {
        fs.closeSync(f);
      }
      fs.renameSync(tmp, dest);
      return true;
    } catch (e) {
      Logger.warn('host-bridge: 写结果失败（' + dest + '）：' + Logger.describeThrown(e));
      try {
        fs.unlinkSync(tmp);
      } catch (ignore) {
        // 忽略
      }
      return false;
    }
  }

  /**
   * 回收陈旧文件（写入方或处理方已经死掉的残留）。
   *
   * **必须覆盖 `.req`**：只清 `.wip/.done/.fail` 的版本会让一个半截 `.req` 永久堵死队首
   * （它既不满足完整性判据、又没人删它）—— 宿主侧的语音桥就是审核时发现这个真缺陷才补的。
   *
   * **跳过在处理的 `.wip`**：`fs.pickFolder` 这类能力的耗时由用户决定（可能几分钟），
   * 而 mtime 阈值是按"最短合法耗时"定的；把在飞的那一个排除掉，就不必为了不误删而把
   * 阈值调得很大（阈值越大，真卡死时的自愈越慢）。
   */
  private mailboxReap(dir: string, names: string[]): void {
    const now: number = Date.now();
    for (const n of names) {
      if (!HostBridge.isMailboxFile(n)) {
        continue;
      }
      const isWip: boolean = n.endsWith(MAILBOX_WIP);
      if (isWip && this.mailboxInflight.length > 0
        && n === this.mailboxInflight + MAILBOX_WIP) {
        continue; // 正在处理，绝不回收
      }
      const p: string = dir + '/' + n;
      try {
        const st: fs.Stat = fs.statSync(p);
        if (now - st.mtime * 1000 > MAILBOX_STALE_MS) {
          fs.unlinkSync(p);
          this.mailboxReaped = this.mailboxReaped + 1;
          Logger.warn('host-bridge: 回收陈旧信箱文件（' + n + '，mtime ' + st.mtime + '）');
          this.mailboxHeartbeat('reap ' + n);
        }
      } catch (e) {
        // 忽略：下轮再试
      }
    }
  }

  /**
   * 追加一行心跳。
   *
   * 为什么**每次结果都写**（而不只写"收到请求"）：只写请求时，事后无法区分
   * 「处理成功」与「请求根本没被处理」—— 两者都停在最后一条 `got`/`alive` 上，
   * 而这正是排查时最需要区分的一件事。
   *
   * 超过 64 KB 就整体重写：长期运行每 5 s 一行 ≈ 每天 1.7 万行，不能无限增长。
   */
  private mailboxHeartbeat(detail: string): void {
    const dir: string = this.mailboxDir;
    if (dir.length === 0) {
      return;
    }
    const path: string = dir + '/' + MAILBOX_HEARTBEAT;
    const line: string = new Date().toISOString() + ' ' + detail + '\n';
    try {
      let size: number = 0;
      try {
        size = fs.statSync(path).size;
      } catch (e) {
        size = 0;
      }
      const rotate: boolean = size > MAILBOX_HEARTBEAT_MAX_BYTES;
      const f: fs.File = fs.openSync(path, rotate
        ? (fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC)
        : (fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.APPEND));
      try {
        fs.writeSync(f.fd, rotate ? ('--- 超过 ' + MAILBOX_HEARTBEAT_MAX_BYTES + 'B，已轮转 ---\n' + line) : line);
      } finally {
        fs.closeSync(f);
      }
    } catch (e) {
      // 心跳失败不影响主流程
    }
  }

  /** 是否是信箱中间文件（心跳等其它文件不参与回收） */
  private static isMailboxFile(name: string): boolean {
    return name.endsWith(MAILBOX_REQ) || name.endsWith(MAILBOX_TMP)
      || name.endsWith(MAILBOX_WIP) || name.endsWith(MAILBOX_DONE) || name.endsWith(MAILBOX_FAIL);
  }

  /** `dispatch()` 的返回串是否表示失败（只认顶层的 `"ok":false`，不解析嵌套） */
  private static isFailureJson(result: string): boolean {
    const trimmed: string = result.trim();
    return trimmed.startsWith('{"ok":false') || trimmed.startsWith('{"ok": false');
  }

  /**
   * 把 `dispatch()` 的结构化失败**拆包**成 `.fail` 的顶层字段。
   *
   * 为什么要拆：Node 侧把 `.fail` 的 `error` **原样**当成 `invoke()` 的 `err.error`。
   * 若统一写成 `host-dispatch-failed`，调用方拿到的永远是这一句，真正的
   * `unregistered` / `payload-too-large` / `handler-threw` 只能从 `detail` 里正则抠 ——
   * 那是反模式（错误码本来就是为了让人按码分派）。
   *
   * 拆包失败（处理器返回了非 JSON）时才兜底成 `host-dispatch-failed`；
   * 无论哪种情况，原始返回串都留在 `dispatch` 字段里，保证信息不丢。
   */
  private static mailboxFailBody(result: string): string {
    let code: string = 'host-dispatch-failed';
    let detail: string = result;
    try {
      const parsed = JSON.parse(result) as DispatchFailure;
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        code = parsed.error;
      }
      if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
        detail = parsed.detail;
      }
    } catch (e) {
      // 非 JSON：整串进 detail（code 保持兜底值）
    }
    return '{"ok":false,"error":"' + HostBridge.jsonEsc(code) + '","detail":"'
      + HostBridge.jsonEsc(detail) + '","dispatch":"' + HostBridge.jsonEsc(result) + '"}';
  }

  /**
   * 一轮轮询：取一个请求 → 分发 → 回填。
   * **绝不抛**：任何异常都转成结构化结果回填（否则 Node 侧只能等到 15 s 超时）。
   */
  private pumpTick(): void {
    this.pumpRounds = this.pumpRounds + 1;
    let raw: string = '';
    try {
      raw = nodeBridge.pollHostRequest();
    } catch (e) {
      this.pumpErrors = this.pumpErrors + 1;
      Logger.warn('host-bridge: pollHostRequest 抛异常：' + JSON.stringify(e));
      return;
    }
    if (raw.length === 0) {
      return;
    }
    let req: HostRequest;
    try {
      req = JSON.parse(raw) as HostRequest;
    } catch (e) {
      this.pumpErrors = this.pumpErrors + 1;
      Logger.warn('host-bridge: 请求不是合法 JSON（丢弃本轮）：' + raw);
      return;
    }
    this.pumpDispatched = this.pumpDispatched + 1;
    let result: string;
    try {
      result = this.dispatch(req.name, req.args);
    } catch (e) {
      // dispatch 契约上永不抛；真抛了也必须回填，否则 Node 侧只能等超时
      this.pumpErrors = this.pumpErrors + 1;
      result = '{"ok":false,"error":"host-dispatch-failed","name":"'
        + HostBridge.jsonEsc(req.name) + '"}';
      Logger.error('host-bridge: dispatch 抛出（已转为结构化错误回填）：' + JSON.stringify(e));
    }
    try {
      const rc: number = nodeBridge.completeHostRequest(req.id, result);
      if (rc !== 0) {
        this.pumpErrors = this.pumpErrors + 1;
        Logger.warn('host-bridge: completeHostRequest 返回 ' + rc
          + '（id=' + req.id + ' 可能已超时被 Node 侧放弃）');
      }
    } catch (e) {
      this.pumpErrors = this.pumpErrors + 1;
      Logger.warn('host-bridge: completeHostRequest 抛异常：' + JSON.stringify(e));
    }
  }

  /**
   * 分发一次调用。**永不抛异常**：未注册 / 处理器抛错 / 载荷超限 / 入参非法
   * 都返回结构化 JSON，这样 Node 侧拿到的一定是可解析的字符串
   * （否则会变成难以定位的 `unhandledRejection`；宪法 C2 禁止静默失败）。
   *
   * 判定顺序（先便宜后昂贵，且**未注册优先于超限**：名字都不认识时不必先算长度）：
   * `bad-args` → `unregistered` → `payload-too-large` → `handler-threw`。
   *
   * 成功时**原样透传**处理器的返回串，不包装 —— 包装会逼迫消费方为每个能力写两套解析。
   */
  dispatch(name: string, argsJson: string): string {
    this.invocations = this.invocations + 1;
    const safeName: string = typeof name === 'string' ? name : '';
    const rejection: string = this.precheck(safeName, argsJson);
    if (rejection.length > 0) {
      this.errors = this.errors + 1;
      return rejection;
    }
    const h: HostBridgeHandler = this.handlers.get(safeName) as HostBridgeHandler;
    try {
      const out: string | Promise<string> = h(argsJson);
      /*
       * 异步处理器**不能**走同步路径：原生槽位表（`pumpTick`）在拿回填值时必须立刻返回，
       * 而 Promise 此刻还没有结果。如实报错好过返回未决值 —— 后者会让 Node 侧拿到
       * 一个空串/半截 JSON，看起来像"宿主返回了空"（正是 C2 禁止的那类静默失败）。
       * 需要异步能力的调用方走文件信箱（`dispatchAsync`）。
       */
      if (out instanceof Promise) {
        this.errors = this.errors + 1;
        return '{"ok":false,"error":"async-handler-on-sync-path","name":"'
          + HostBridge.jsonEsc(safeName)
          + '","hint":"该能力是异步的（弹窗/选择器/通知），请经文件信箱调用"}';
      }
      return out;
    } catch (e) {
      return this.threwBody(safeName, e);
    }
  }

  /**
   * 异步分发（2026-10-17，E17/E20/E21）：与 `dispatch` **同一套校验口径**，只把
   * "调用处理器"这一步换成 await。
   *
   * 为什么必须共用 `precheck`：校验顺序与错误码是**跨传输的契约**
   * （`bad-args` → `unregistered` → `payload-too-large`）；两条路径各写一份，
   * 迟早出现"同一个调用在信箱上成功、在原生上被拒"。
   *
   * **永不抛**：任何异常都转成结构化 JSON（否则 `mailboxTick` 只能等超时）。
   */
  async dispatchAsync(name: string, argsJson: string): Promise<string> {
    this.invocations = this.invocations + 1;
    const safeName: string = typeof name === 'string' ? name : '';
    const rejection: string = this.precheck(safeName, argsJson);
    if (rejection.length > 0) {
      this.errors = this.errors + 1;
      return rejection;
    }
    const h: HostBridgeHandler = this.handlers.get(safeName) as HostBridgeHandler;
    try {
      const out: string | Promise<string> = h(argsJson);
      if (out instanceof Promise) {
        return await out as string;
      }
      return out;
    } catch (e) {
      return this.threwBody(safeName, e);
    }
  }

  /**
   * 前置校验（**两条传输共用**）。返回空串 = 通过；否则是可直接回给调用方的结构化错误。
   *
   * 判定顺序（先便宜后昂贵，且**未注册优先于超限**：名字都不认识时不必先算长度）：
   * `bad-args` → `unregistered` → `payload-too-large`。计数由调用方做（两处各加一次，
   * 不能在 helper 里加 —— 否则 `dispatch` 会把错误计两遍）。
   */
  private precheck(safeName: string, argsJson: string): string {
    if (safeName.length === 0 || typeof argsJson !== 'string') {
      return '{"ok":false,"error":"bad-args","name":"' + HostBridge.jsonEsc(safeName) + '"}';
    }
    if (!this.handlers.has(safeName)) {
      return '{"ok":false,"error":"unregistered","name":"' + HostBridge.jsonEsc(safeName) + '"}';
    }
    /*
     * 载荷上限按 **UTF-8 字节** 计（不是 `string.length` 的 UTF-16 码元数）：
     * Node 侧 `payload/host.js` 用 `Buffer.byteLength()` 判断同一件事，两侧必须同口径 ——
     * 否则含中文/emoji 的临界载荷会出现「一侧放行、一侧拒绝」，而这类不一致极难定位。
     * B4：测不出长度（`utf8Len` 返回 -1）时**必须拒绝**：任何退化估算要么偏小（放行超限载荷）、
     * 要么与 Node 侧口径不一致，二者都违背「同口径」。
     */
    const actualBytes: number = HostBridge.utf8Len(argsJson);
    if (actualBytes < 0) {
      return '{"ok":false,"error":"bad-args","name":"' + HostBridge.jsonEsc(safeName) +
        '","detail":"payload byte length unavailable (utf8 encode failed)"}';
    }
    if (actualBytes > this.capBytes) {
      return '{"ok":false,"error":"payload-too-large","name":"' + HostBridge.jsonEsc(safeName) +
        '","capBytes":' + this.capBytes + ',"actual":' + actualBytes + '}';
    }
    return '';
  }

  /** 处理器抛错时的结构化返回（`describeThrown` 自身已保证不抛，这里再包一层兜底） */
  private threwBody(safeName: string, e: Object): string {
    this.errors = this.errors + 1;
    let detail: string = '(unserializable thrown value)';
    try {
      detail = Logger.describeThrown(e);
    } catch (describeFailed) {
      detail = '(describeThrown failed)';
    }
    return '{"ok":false,"error":"handler-threw","name":"' + HostBridge.jsonEsc(safeName) +
      '","detail":"' + HostBridge.jsonEsc(detail) + '"}';
  }

  /**
   * 诊断快照（JSON）：`{count, names, invocations, errors, capBytes}`（契约 §2.7）。
   *
   * 全部由 `jsonEsc` 构造，**不做字符串拼 `name`** —— 能力名是消费方给的外部输入，
   * 直接拼进 JSON 会让一个带引号的名字把整包 JSON 弄坏（旧实现的缺陷）。
   */
  stats(): string {
    const names: string = HostBridge.namesJson(this.list());
    return '{"count":' + this.handlers.size +
      ',"names":' + names +
      ',"invocations":' + this.invocations +
      ',"errors":' + this.errors +
      ',"capBytes":' + this.capBytes + '}';
  }

  /** 单次载荷上限（默认 8 MiB）。非法值（<=0）会被拒绝并 `warn`，不会静默让所有调用都超限 */
  setCapBytes(n: number): void {
    if (n <= 0) {
      Logger.warn('HostBridge.setCapBytes 忽略非法值 ' + n + '（必须 > 0；保持原值 ' + this.capBytes + '）');
      return;
    }
    this.capBytes = n;
  }

  /** 当前载荷上限（诊断用；`stats()` 里也有） */
  getCapBytes(): number {
    return this.capBytes;
  }

  /** 名字数组 → JSON 数组（逐项转义） */
  private static namesJson(names: string[]): string {
    let out: string = '[';
    for (let i = 0; i < names.length; i++) {
      if (i > 0) {
        out += ',';
      }
      out += '"' + HostBridge.jsonEsc(names[i]) + '"';
    }
    return out + ']';
  }

  /**
   * 字符串的 **UTF-8 字节长度**；**测量失败返回 -1**（调用方按 `bad-args` 拒绝分发，不得猜值）。
   *
   * 为什么不能直接用 `s.length`：`string.length` 数的是 UTF-16 码元，中文一个字算 1、emoji 算 2，
   * 而 Node 侧 `payload/host.js` 用 `Buffer.byteLength(s,'utf8')` 判断同一个上限。
   * 两侧口径不一致 ⇒ 含非 ASCII 的临界载荷会出现「一侧放行、一侧拒绝」，这类不一致极难定位。
   *
   * B4：旧实现在编码失败时退化成 `s.length`，注释还写成「保守偏大」——方向恰好相反：
   * 对任何非 ASCII 文本 `s.length` 都**小于** UTF-8 字节数（一个中文字 = 3 字节），
   * 该退化会**放行**超上限载荷，且与 Node 侧口径不同。选择「拒绝」而不是乘系数估算：
   * 契约 §2.7 要求两侧同口径，任何估算都会给出与 `Buffer.byteLength()` 不同的数；
   * 而「`bad-args`」已在冻结的返回表里（入参非法），不需要新语义。
   */
  static utf8Len(s: string): number {
    try {
      return buffer.from(s, 'utf-8').length;
    } catch (e) {
      Logger.warn('HostBridge.utf8Len 编码失败 ⇒ 无法测量载荷字节数（按 bad-args 拒绝分发）：'
        + Logger.describeThrown(e));
      return -1;
    }
  }

  /**
   * 最小 JSON 字符串转义：`"`、`\` 与所有 < 0x20 的控制字符。
   *
   * 只做到「输出合法 JSON」这一条底线（含 `\u00XX` 兜底），不试图做完整 ECMA-404 转义：
   * 本函数只用于**我们自己拼的** JSON 骨架里的字符串值。
   */
  private static jsonEsc(s: string): string {
    let out: string = '';
    for (let i = 0; i < s.length; i++) {
      const c: number = s.charCodeAt(i);
      if (c === 0x22) {
        out += '\\"';
      } else if (c === 0x5C) {
        out += '\\\\';
      } else if (c === 0x08) {
        out += '\\b';
      } else if (c === 0x09) {
        out += '\\t';
      } else if (c === 0x0A) {
        out += '\\n';
      } else if (c === 0x0C) {
        out += '\\f';
      } else if (c === 0x0D) {
        out += '\\r';
      } else if (c < 0x20) {
        out += '\\u' + HostBridge.hex4(c);
      } else {
        out += s.charAt(i);
      }
    }
    return out;
  }

  private static hex4(c: number): string {
    const D: string = '0123456789abcdef';
    return D.charAt((c >> 12) & 0xF) + D.charAt((c >> 8) & 0xF) + D.charAt((c >> 4) & 0xF) + D.charAt(c & 0xF);
  }
}
