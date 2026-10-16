import { hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';

const DOMAIN = 0xD0033;

/**
 * 006-observability —— 日志与崩溃取证。
 *
 * 为什么日志要同时落盘：进程内 Node 崩溃后进程还可能活着（detached 线程），
 * 系统 CppCrash 日志不保证包含 Node 自身的输出；原生层崩溃 handler 会把
 * `CRASH sig=… si_addr=… pc=… lr=…` 追加到同一份日志里（见 `library/src/main/cpp/node_bridge.c`）。
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

  /** 读取日志尾部（调试面板 / 诊断接口用；文件不存在时返回占位串而不是抛异常） */
  static tail(path: string, maxBytes: number): string {
    try {
      const st = fs.statSync(path);
      const size: number = st.size;
      if (size === 0) {
        return '(log empty)';
      }
      const start: number = size > maxBytes ? size - maxBytes : 0;
      const len: number = size - start;
      const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const buf = new ArrayBuffer(len);
      try {
        fs.readSync(file.fd, buf, { offset: start, length: len });
      } finally {
        fs.closeSync(file);
      }
      const bytes = new Uint8Array(buf);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
      }
      return out;
    } catch (e) {
      return '(read log failed: ' + JSON.stringify(e) + ')';
    }
  }
}
