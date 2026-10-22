/**
 * `@fellow99/node-runtime` 对外入口。
 *
 * 本包**只承载运行时二进制**（`libs/arm64-v8a/libnode.so`），不提供 ArkTS API。
 * 这个入口文件存在的两个原因：
 *   ① 中心仓要求 `main`/`types` 指向**包内真实存在的文件**（缺文件直接 publication ERROR）；
 *   ② 让消费方能在**运行期自证**「装的是哪个 Node、哪一份二进制」——
 *      与 `libnode.so` 的运行期能力互补（库侧 `NodeRuntime.bridgeVersion()` 只能报引导件版本）。
 *
 * 值必须与仓库根 `runtime.lock.json` 的 active 项一致（发布脚本 `tools/release.mjs` 会断言，不要手改）。
 */
export const NODE_VERSION: string = '24.2.0';
export const NODE_MODULE_VERSION: number = 137;
export const ABI: string = 'arm64-v8a';
export const LIB_SHA256: string = '3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1';
export const LIB_SIZE: number = 126809264;
export const LIB_DEPLOY_NAME: string = 'libnode.so';

/** 一份便于日志打印/排障的摘要串 */
export const RUNTIME_ID: string = 'node-v24.2.0 / arm64-v8a / abi137';
