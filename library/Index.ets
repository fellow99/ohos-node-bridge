/**
 * `@fellow99/node-bridge` 对外入口（HAR barrel）。
 *
 * 用法（消费方）：
 * ```ts
 * import { NodeRuntime, NodeRuntimeOptions } from '@fellow99/node-bridge';
 * ```
 *
 * 目录 ↔ 模块编号（工程规划 §7.3）：
 *   src/main/ets/runtime  → 001-runtime-core（状态机 / 线程模型 / 启动参数）
 *   src/main/cpp          → 002-napi-bootstrap（dlopen + node::Start + SIGSYS shim + 崩溃取证）
 *   src/main/ets/bridge   → 003-host-bridge（Node ↔ ArkTS 双向调用）
 *   src/main/ets/log      → 006-observability（日志环 + hilog + 崩溃记录）
 *   src/main/ets/util     → 006-observability（路径 / 环境变量装配）
 */
export { NodeRuntime } from './src/main/ets/runtime/NodeRuntime';
export { NodeState } from './src/main/ets/runtime/Types';
export { NodeRuntimeOptions, NodeStartResult, HostBridgeHandler } from './src/main/ets/runtime/Types';
export { HostBridge } from './src/main/ets/bridge/HostBridge';
export { Logger } from './src/main/ets/log/Logger';
export { Env } from './src/main/ets/util/Env';
