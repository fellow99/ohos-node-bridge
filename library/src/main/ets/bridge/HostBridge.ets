import { buffer } from '@kit.ArkTS';
import { HostBridgeHandler } from '../runtime/Types';
import { Logger } from '../log/Logger';

/** 单次 JSON 载荷上限默认值：8 MiB（规划 §5.4 / 契约 §2.3 `capBytes`） */
const DEFAULT_CAP_BYTES: number = 8 * 1024 * 1024;

/**
 * 003-host-bridge —— Node ↔ ArkTS 双向调用（骨架）。
 *
 * ⚠️ 本文件的 `dispatch` 目前是**纯 JS 骨架**：注册表 + 分发 + JSON 编解码。
 * Phase 2 必须补上的部分（工程规划 §5.4）：
 *   ① Node 侧调用必须经 **`napi_threadsafe_function`** 回到 ArkTS 主线程（当前 `dispatch` 只是同线程直调）；
 *   ② ArkTS 侧调用 Node 需要一条**反向通道**（原生层 → Node 的 C++ addon / `require('internal/...')` 桩）；
 *   ③ 每条调用要有**超时与上限**（默认 30s、并发上限可配），失败必须返回结构化错误而不是抛异常穿透。
 *
 * 为什么不用旧壳的 `systemPreferences.callArkTSFunction`：那只支持「取一个偏好值」，不是能力调用（§2.2）。
 *
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
    if (safeName.length === 0) {
      this.errors = this.errors + 1;
      return '{"ok":false,"error":"bad-args","name":"' + HostBridge.jsonEsc(safeName) + '"}';
    }
    if (typeof argsJson !== 'string') {
      this.errors = this.errors + 1;
      return '{"ok":false,"error":"bad-args","name":"' + HostBridge.jsonEsc(safeName) + '"}';
    }

    const h: HostBridgeHandler | undefined = this.handlers.get(safeName);
    if (h === undefined) {
      this.errors = this.errors + 1;
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
      this.errors = this.errors + 1;
      return '{"ok":false,"error":"bad-args","name":"' + HostBridge.jsonEsc(safeName) +
        '","detail":"payload byte length unavailable (utf8 encode failed)"}';
    }
    if (actualBytes > this.capBytes) {
      this.errors = this.errors + 1;
      return '{"ok":false,"error":"payload-too-large","name":"' + HostBridge.jsonEsc(safeName) +
        '","capBytes":' + this.capBytes + ',"actual":' + actualBytes + '}';
    }

    try {
      return h(argsJson);
    } catch (e) {
      this.errors = this.errors + 1;
      // B3：`describeThrown` 自身已保证不抛；这里再包一层，让 dispatch 的「永不抛」不依赖它
      // （契约 §2.7 明文要求 dispatch 永不抛异常）。
      let detail: string = '(unserializable thrown value)';
      try {
        detail = Logger.describeThrown(e);
      } catch (describeFailed) {
        detail = '(describeThrown failed)';
      }
      return '{"ok":false,"error":"handler-threw","name":"' + HostBridge.jsonEsc(safeName) +
        '","detail":"' + HostBridge.jsonEsc(detail) + '"}';
    }
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
