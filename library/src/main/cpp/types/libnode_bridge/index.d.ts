/**
 * libnode_bridge.so 的 ArkTS 侧类型声明（只声明、不写函数体）。
 * 目录约定：`cpp/types/libnode_bridge/index.d.ts` ⇒ `import nodeBridge from 'libnode_bridge.so'`
 */
export const start: (
  libDir: string,
  scriptPath: string,
  flags: string,
  home: string,
  logPath: string
) => number;

export const isRunning: () => number;

export const version: () => string;
