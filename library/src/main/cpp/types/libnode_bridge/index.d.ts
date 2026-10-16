/**
 * libnode_bridge.so 的 ArkTS 侧类型声明（只声明、不写函数体）。
 * 目录约定：`cpp/types/libnode_bridge/index.d.ts` ⇒ `import nodeBridge from 'libnode_bridge.so'`
 *
 * ⚠️ 这份声明与 `node_bridge.c` 的 `Init()` 必须同步；改一处必须改另一处。
 * 权威契约：`logs/20261016-1/IMPLEMENTATION_CONTRACT.md` §1.1。
 */

/**
 * 投递启动（**异步投递语义**：返回 0 只代表后台线程已创建）。
 *
 * @param libDir     `libnode.so` 所在目录（原生走候选链，最后回落到裸名 `libnode.so`）
 * @param scriptPath 入口脚本**绝对路径**（真机 `cwd=/`，不要用相对路径）
 * @param flags      空格分隔的 Node 参数
 * @param home       `HOME` / `USERPROFILE` 根（同时决定崩溃记录落点）
 * @param logPath    stdio 落盘路径（格式 `<stream> <epochMs> <text>`）
 * @param envPairs   `"K1=V1\nK2=V2"`（换行分隔，上限 4096 字节；超长按 §1.2 规则截断，
 *                   `flags`/`envPairs` 截断后继续但会写 `sys` 行，路径类参数截断直接失败）
 * @returns `0` = 已投递；`>0` = `pthread_create` 错误码；`-1` = 本进程已投递过；
 *          `-2` = 入参校验失败（路径类参数被截断 / 必填项为空 / 类型不对；细节见 `lastError()`）
 */
export const start: (
  libDir: string,
  scriptPath: string,
  flags: string,
  home: string,
  logPath: string,
  envPairs: string
) => number;

/** Node 主循环是否仍在跑（未起为 0；`node::Start` 返回后归 0） */
export const isRunning: () => number;

/** 引导件版本串（构建期常量，排障时先看它） */
export const version: () => string;

/**
 * 最近一次原生层失败原因；无失败返回空串 `''`。
 * 写入点：stdio 建立失败 / `dlopen` 全失败 / `dlsym` 失败 / `pthread_create` 失败 / 重复投递 / 参数校验失败。
 * 存在的意义：**失败必须对 ArkTS 可见**（宪法 C2「不隐藏平台真相」）。
 */
export const lastError: () => string;

/** 当前引导阶段：`init`|`stdio`|`dlopen`|`dlsym`|`start`|`running`|`exited`（`running` = 已见到第一行 Node 输出） */
export const stage: () => string;
