import { HostBridgeHandler } from '../runtime/Types';

/**
 * 003-host-bridge —— Node ↔ ArkTS 双向调用（骨架）。
 *
 * ⚠️ 本文件目前是**纯 JS 骨架**：注册表 + 分发 + JSON 编解码。
 * Phase 2 必须补上的部分（工程规划 §5.4）：
 *   ① Node 侧调用必须经 **`napi_threadsafe_function`** 回到 ArkTS 主线程（当前 `dispatch` 只是同线程直调）；
 *   ② ArkTS 侧调用 Node 需要一条**反向通道**（原生层 → Node 的 C++ addon / `require('internal/...')` 桩）；
 *   ③ 每条调用要有**超时与上限**（默认 30s、并发上限可配），失败必须返回结构化错误而不是抛异常穿透。
 *
 * 为什么不用旧壳的 `systemPreferences.callArkTSFunction`：那只支持"取一个偏好值"，不是能力调用（§2.2）。
 */
export class HostBridge {
  private handlers: Map<string, HostBridgeHandler> = new Map<string, HostBridgeHandler>();

  /** 注册一个能力（同名覆盖） */
  register(name: string, handler: HostBridgeHandler): void {
    this.handlers.set(name, handler);
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
   * 分发一次调用。**永不抛异常**：未注册 / 处理器抛错都返回结构化 JSON，
   * 这样 Node 侧拿到的一定是可解析的字符串（否则会变成难以定位的 `unhandledRejection`）。
   */
  dispatch(name: string, argsJson: string): string {
    const h: HostBridgeHandler | undefined = this.handlers.get(name);
    if (h === undefined) {
      return '{"ok":false,"error":"unregistered","name":"' + name + '"}';
    }
    try {
      return h(argsJson);
    } catch (e) {
      return '{"ok":false,"error":"handler-threw","name":"' + name + '","detail":' + JSON.stringify(e) + '}';
    }
  }
}
