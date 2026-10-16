import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { resourceManager } from '@kit.LocalizationKit';

/**
 * 006-observability —— 路径与环境装配。
 *
 * 约定（依据工程规划 §5.6 环境契约 + §D.8 真机偏差）：
 * - `HOME` / `USERPROFILE` / `TMPDIR` / `TMP` / `TEMP` 全部由原生层指向**应用沙箱**；
 * - `process.cwd()` 在真机上是 `/` ⇒ **所有路径都必须是绝对路径**，不要依赖 cwd（S4）；
 * - Node 侧只写它自己的沙箱目录（「谁写谁读」，notes 硬约束 ④）。
 *
 * 路径取值冻结在契约 §2.8；新增字段必须同步 `Index.ets` / `Types.ets`（S2）。
 */
export class Env {
  /** payload（入口脚本 + 日志）目录 */
  static payloadDir(context: common.Context): string {
    return context.filesDir + '/payload';
  }

  /** Node 的 TMPDIR */
  static tmpDir(context: common.Context): string {
    return context.filesDir + '/tmp';
  }

  /** Node 的 stdout/stderr 落盘路径（崩溃取证的唯一通道） */
  static logPath(context: common.Context): string {
    return Env.payloadDir(context) + '/node.log';
  }

  /**
   * 库自己的沙箱目录：崩溃记录等**非载荷**文件放这里，与 Node 的可写运行目录（`payload/`）分开
   * —— 载荷目录可能被整份替换/清理，取证文件不该跟着消失（规划 §5.1 分层图）。
   */
  static bridgeDir(context: common.Context): string {
    return context.filesDir + '/node-bridge';
  }

  /** 崩溃记录：原生崩溃 handler 覆盖写、`NodeRuntime.lastCrash()` 读（契约 §1.4 / §5.7） */
  static crashPath(context: common.Context): string {
    return Env.bridgeDir(context) + '/last-crash.json';
  }

  /**
   * `resfile` **只读直读**根（零解压首选路线，规划 §5.5）。
   *
   * ⚠️ 平台真相（C2）：不是所有 `Context` 都带 `resourceDir`（例如某些窗口/应用级 Context 可能为空串）。
   * 空串时**原样返回 `''`**，绝不在这里编造一个路径 —— 消费方/Node 侧必须按「未提供只读根」处理，
   * 而不是去读一个不存在的目录后报 `ENOENT` 却不知道为什么。
   */
  static readonlyRoot(context: common.Context): string {
    return context.resourceDir;
  }

  /** 幂等建目录（已存在即忽略；不做递归创建，父目录是 filesDir） */
  static ensureDir(path: string): void {
    try {
      fs.mkdirSync(path);
    } catch (e) {
      // 已存在 / 权限不足：都留给后续 open 时报错，这里不吞掉诊断信息
    }
  }

  /** 建齐运行期目录（`payload/` + `tmp/` + `node-bridge/`）；调用时机：投递启动**之前**（FR-001-016） */
  static ensureRuntimeDirs(context: common.Context): void {
    Env.ensureDir(Env.payloadDir(context));
    Env.ensureDir(Env.tmpDir(context));
    Env.ensureDir(Env.bridgeDir(context));
  }

  /**
   * 把 `rawfile` 里的文件落到**应用沙箱**并返回落盘路径。
   *
   * 为什么必须落盘而不是直接用包内路径：Node 读得到 ArkTS 写的文件，读不到安装包内的只读条目
   * （notes 硬约束 ④；`libnode.so` 自身是 `dlopen` 由链接器处理，不受此限）。
   * 大载荷请改用 `resources/resfile/` 只读直读（工程规划 §5.5），不要走这里。
   */
  static materializeRawfile(
    mgr: resourceManager.ResourceManager,
    rawName: string,
    destPath: string
  ): string {
    const data: Uint8Array = mgr.getRawFileContentSync(rawName);
    // A5：`getRawFileContentSync` 的返回值是**视图**，可能带非零 `byteOffset` 或短于其 backing buffer。
    // 直接写 `data.buffer` 会把视图之外的字节一起落盘（载荷尾部多出垃圾 → 解包/执行结果不可信）。
    // 只写视图覆盖的字节：常见情形（offset=0 且长度相等）零拷贝，否则先 slice 出精确副本。
    const body: Uint8Array = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      ? data
      : data.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const file = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, body.buffer as ArrayBuffer);
    } finally {
      fs.closeSync(file);
    }
    return destPath;
  }
}
