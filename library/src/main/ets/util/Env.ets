import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { resourceManager } from '@kit.LocalizationKit';

/**
 * 006-observability —— 路径与环境装配。
 *
 * 约定（依据工程规划 §5.6 环境契约 + §D.8 真机偏差）：
 * - `HOME` / `USERPROFILE` / `TMPDIR` / `TMP` / `TEMP` 全部由原生层指向**应用沙箱**；
 * - `process.cwd()` 在真机上是 `/` ⇒ **所有路径都必须是绝对路径**，不要依赖 cwd；
 * - Node 侧只写它自己的沙箱目录（「谁写谁读」，notes 硬约束 ④）。
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

  /** 幂等建目录（已存在即忽略；不做递归创建，父目录是 filesDir） */
  static ensureDir(path: string): void {
    try {
      fs.mkdirSync(path);
    } catch (e) {
      // 已存在 / 权限不足：都留给后续 open 时报错，这里不吞掉诊断信息
    }
  }

  /** 建齐运行期目录（payload/ 与 tmp/） */
  static ensureRuntimeDirs(context: common.Context): void {
    Env.ensureDir(Env.payloadDir(context));
    Env.ensureDir(Env.tmpDir(context));
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
    const file = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, data.buffer as ArrayBuffer);
    } finally {
      fs.closeSync(file);
    }
    return destPath;
  }
}
