import { hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';

const DOMAIN = 0xD0033;

/** 默认读尾字节数（规划 §5.7：`/log` 返回日志尾 8192 字节） */
const DEFAULT_TAIL_BYTES: number = 8192;
/** 单次读尾上界：防止「一次读 1 GB 把宿主 OOM」（FR-006-006；读尾成本必须可预测，NFR-006-008） */
const MAX_TAIL_BYTES: number = 4 * 1024 * 1024;
/** `logs()` 未指定条数时的缺省（与 `NodeRuntimeOptions.logRingSize` 默认值一致，契约 §2.3） */
const DEFAULT_TAIL_LINES: number = 500;

const PLACEHOLDER_EMPTY: string = '(log empty)';
const PLACEHOLDER_MISSING: string = '(log missing)';
const PLACEHOLDER_BAD_ARGS: string = '(maxBytes <= 0)';

/**
 * 006-observability —— 日志与崩溃取证。
 *
 * 为什么日志要同时落盘：进程内 Node 崩溃后进程还可能活着（detached 线程），
 * 系统 CppCrash 日志不保证包含 Node 自身的输出；原生层崩溃 handler 会把
 * `CRASH sig=… si_addr=… pc=… lr=…` 追加到同一份日志里（见 `library/src/main/cpp/node_bridge.c`）。
 *
 * 读回契约（宪法 C3「谁写谁读」+ S9 + FR-006-004/005/006）：**永不抛异常**，
 * 任何异常路径都返回占位串；空文件 / 缺文件 / 参数非法各有**可区分**的占位串。
 */
export class Logger {
  static info(msg: string): void {
    hilog.info(DOMAIN, 'NODE_BRIDGE', '%{public}s', msg);
  }

  static warn(msg: string): void {
    hilog.warn(DOMAIN, 'NODE_BRIDGE', '%{public}s', msg);
  }

  static error(msg: string): void {
    hilog.error(DOMAIN, 'NODE_BRIDGE', '%{public}s', msg);
  }

  /**
   * 读取日志尾部（调试面板 / 诊断接口用）。
   *
   * - `maxBytes` 缺省 8192，硬上界 4 MiB，`<= 0` 返回 `'(maxBytes <= 0)'`（与「空文件」可区分）；
   * - **按 UTF-8 解码**：先用 `buffer.from(arrayBuffer).toString('utf-8')`，绝不再逐字节
   *   `String.fromCharCode` —— 那会把任何非 ASCII 字节（中文日志、沙箱路径、载荷输出）
   *   解码成乱码（FR-006-005 的既有缺陷）；
   * - 截断点落在**行中间**时，丢掉被截断的首行（若整个窗口是一行，则丢掉首个被截断的多字节
   *   字符替换符 `\uFFFD`），绝不输出半个字符（FR-006-005）；
   * - 文件不存在 ⇒ `'(log missing)'`；读失败 ⇒ `'(read log failed: …)'`；空文件 ⇒ `'(log empty)'`。
   */
  static tail(path: string, maxBytes: number = DEFAULT_TAIL_BYTES): string {
    if (maxBytes <= 0) {
      // 参数非法必须与「空文件」可区分（FR-006-006）；返回空串会让调用方误判为「读成功但没内容」
      return PLACEHOLDER_BAD_ARGS;
    }
    const cap: number = maxBytes > MAX_TAIL_BYTES ? MAX_TAIL_BYTES : maxBytes;

    let size: number = 0;
    try {
      const st = fs.statSync(path);
      size = st.size;
    } catch (e) {
      // stat 都失败（不存在 / 不可读 / 路径为空）：按契约返回固定占位串，不抛
      return PLACEHOLDER_MISSING;
    }
    if (size === 0) {
      return PLACEHOLDER_EMPTY;
    }

    const start: number = size > cap ? size - cap : 0;
    const want: number = size - start;
    try {
      const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const ab: ArrayBuffer = new ArrayBuffer(want);
      let read: number = 0;
      try {
        read = fs.readSync(file.fd, ab, { offset: start, length: want });
      } finally {
        fs.closeSync(file);
      }
      if (read <= 0) {
        /*
         * B5：stat 已经证明 `size > 0`，所以「读到 0 字节」**不是空文件**，
         * 而是文件在 stat 与 read 之间被截断 / I-O 异常。必须用可区分的读失败占位串 ——
         * 旧代码返回 `(log empty)`，与真正的 0 字节文件混为一谈（与本文档口径不符，C2）。
         */
        return '(read log failed: read returned ' + read + '; stat size was ' + size + ')';
      }
      // 只把真正读到的字节交给解码器（read 可能小于 want）
      const buf: buffer.Buffer = buffer.from(ab, 0, read);
      const text: string = buf.toString('utf-8');
      return Logger.dropTruncatedHead(text, start > 0);
    } catch (e) {
      // B3：catch 里**任何东西都可能被抛出**（包括循环引用对象）⇒ 序列化必须再包一层 try，
      //     否则 `tail()` 会从「永不抛」的路径上抛出去，把 logs() 一起带崩。
      return '(read log failed: ' + Logger.safeStringify(e) + ')';
    }
  }

  /** `tail` 的同义入口：强调「按字节读尾」（消费方与自检代码可任选其一） */
  static tailBytes(path: string, maxBytes: number = DEFAULT_TAIL_BYTES): string {
    return Logger.tail(path, maxBytes);
  }

  /**
   * 读日志尾并切成**最多** `wantLines` 行（`NodeRuntime.logs()` 用）。
   *
   * 读失败/空文件时返回**单元素数组**（就是 `tail` 的占位串），由上层按「无法解析的行」
   * 处理 —— 这样 `logs()` 的失败提示走的是同一条格式化路径，不会出现两套错误文案。
   * （空行不占名额也不出现在结果里：`node.log` 每行都带 stream 前缀，空行只可能是切分残留。）
   */
  static tailLines(path: string, maxBytes: number = DEFAULT_TAIL_BYTES,
    wantLines: number = DEFAULT_TAIL_LINES): string[] {
    const out: string[] = [];
    const want: number = wantLines > 0 ? wantLines : 1;
    const text: string = Logger.tail(path, maxBytes);
    if (text.length === 0) {
      return out;
    }
    const parts: string[] = text.split('\n');
    // 末尾的空段（日志通常以 \n 结尾）不占「最后 N 行」的名额
    let end: number = parts.length;
    while (end > 0 && parts[end - 1].length === 0) {
      end = end - 1;
    }
    const begin: number = end > want ? end - want : 0;
    for (let i = begin; i < end; i++) {
      const line: string = parts[i];
      if (line.length > 0) {
        out.push(line);
      }
    }
    return out;
  }

  /**
   * 丢掉被截断的首行（`start > 0` 说明读取窗口不是从文件头开始的）。
   *
   * 有换行 ⇒ 换行之前那段必然是半行，丢掉；无换行 ⇒ 整个窗口是同一行的尾巴，
   * 只丢掉首个 `\uFFFD`（被切断的多字节字符的解码结果）。
   */
  private static dropTruncatedHead(text: string, truncatedHead: boolean): string {
    if (!truncatedHead || text.length === 0) {
      return text;
    }
    const nl: number = text.indexOf('\n');
    if (nl >= 0) {
      return text.substring(nl + 1);
    }
    if (text.charCodeAt(0) === 0xFFFD) {
      return text.substring(1);
    }
    return text;
  }

  /**
   * 把 `catch` 到的任何东西变成一句人读文本（**自身不抛**）。
   *
   * 为什么不能只是 `JSON.stringify(e)`：`Error` 实例的可枚举属性为空 ⇒ 只会得到 `'{}'`，
   * 把最关键的 message 丢干净。所以先按 `Error` 读 `name`/`message`，失败再退化为序列化。
   */
  static describeThrown(e: Object): string {
    try {
      const err: Error = e as Error;
      const msg: string | undefined = err.message;
      if (msg !== undefined && msg.length > 0) {
        const nm: string | undefined = err.name;
        if (nm !== undefined && nm.length > 0) {
          return nm + ': ' + msg;
        }
        return msg;
      }
    } catch (castFailed) {
      // 抛出物既不是 Error 也不可当 Error 读：落到下面的序列化分支，不在这里抛
    }
    // B3：`JSON.stringify` 对循环引用**会抛**（`const a={}; a.self=a; throw a;`），
    // 这条路径的契约是「永不抛」⇒ 序列化必须再包一层，失败退化为固定串。
    return Logger.safeStringify(e);
  }

  /**
   * 永不抛的 `JSON.stringify`（B3 的公共实现）。
   *
   * 为什么需要它：`String()`/模板串拼接本身也可能触发 `toString` 抛错，而 `JSON.stringify`
   * 对循环结构、BigInt 等输入一律抛 `TypeError`。这些值都能作为 `throw` 的操作数出现在
   * `catch` 里，若在「永不抛」的路径上把它序列化，异常会穿透 `Logger.tail`/`tailLines`
   * 一路打崩 `NodeRuntime.logs()` 与 `HostBridge.dispatch`（两者契约都写明永不抛）。
   */
  static safeStringify(v: Object): string {
    try {
      const s: string = JSON.stringify(v);
      return s !== undefined ? s : '(unserializable: ' + typeof v + ')';
    } catch (stringifyFailed) {
      return '(unserializable thrown value: circular or non-JSON)';
    }
  }
}
