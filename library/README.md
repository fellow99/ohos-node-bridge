# @fellow99/node-bridge —— 在应用进程内嵌入真正的 Node.js 运行时

把**真正的 Node.js 运行时**（不是 WebView、不是云函数、不是子进程）以
`NAPI 引导 + dlopen + node::Start` 的形态嵌进 **HarmonyOS 应用自己的进程**，
供 ArkTS 调用、由 ArkWeb 消费它起的本地服务。

- 目标设备：`2in1` / `tablet`（不做 phone）
- 形态：**ArkTS 组件库（HAR）+ NAPI 引导件（`.so`）**，发布到 [ohpm](https://ohpm.openharmony.cn/)
- 当前版本：`0.1.0`（**骨架**：编译链路通，运行时行为待 Phase 1/2 补齐）

## 30 秒用法

```ts
import { NodeRuntime, NodeRuntimeOptions } from '@fellow99/node-bridge';
import { common } from '@kit.AbilityKit';

const runtime = NodeRuntime.getInstance();
const result = runtime.start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<绝对路径>/payload/bootstrap.js',
  flags: '--no-verify-heap'   // 无 ACL 时改用 '--jitless'（会失去 WebAssembly）
});
```

调用前请确认：① 已把 `libnode.so` 投放进你的 `entry/libs/arm64-v8a/`（见下）；
② 你的 `module.json5` 已声明本库需要的权限与 ACL（JIT 必需）。

## 消费方必须做的三件事

| # | 做什么 | 为什么 |
| --- | --- | --- |
| 1 | **投放运行时**：用本仓库的 `tools/provision.mjs --out <你的模块>/libs/arm64-v8a` | HAR **不带** `libnode.so`（约 121 MB）；版本与 SHA-256 固化在 `runtime.lock.json` |
| 2 | **声明权限与 ACL**：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（JIT 必需）按**你自己的包名**申请并声明 | 没有它，V8 走 JIT 即 SIGTRAP；`--jitless` 可兜底但 WebAssembly 全废 |
| 3 | **自备载荷**：把应用代码放到 `resources/resfile/<app>/`（只读直读，零解压） | Node 读得到 ArkTS 写的文件，读不到包内只读条目 |

## 目录结构

```
library/                 ← 发布到 ohpm 的 HAR（ArkTS + cpp 引导件）
├── Index.ets            # barrel（对外只暴露 NodeRuntime / HostBridge / Logger / Env / 类型）
├── src/main/ets/        # runtime(001) / bridge(003) / log(006) / util(006)
├── src/main/cpp/        # 002：node_bridge.c + CMakeLists.txt + types/
├── src/main/module.json5# HAR 只需声明的系统权限（INTERNET 等）
└── .ohpmignore          # 发布时排除 libs/ 与构建产物
payload/                 # Node 侧 JS（bootstrap 参考实现 + 自检脚本）
```

## 已知限制（都是实测结论，不是猜测）

- **`--jitless` 会关掉 WebAssembly**：Next 的 WASM SWC、undici 的 llhttp WASM 都依赖它 ⇒ 无 ACL 时这些载荷必须改造；
- **`node::Start` 每进程只能一次**：崩溃即终态，无法在应用内重启（只能重启应用）；
- **`process.cwd()` = `/`**、**`process.execPath` = `/system/bin/appspawn`**、**`os.cpus()` 长度 0**：不要依赖这三者；
- **`dlopen` 只认裸名 `libnode.so`**（绝对路径全部失败）。

## 许可

MIT。随包分发的 Node.js 运行时（如你在应用中一同分发）适用其自身许可（MIT 及其依赖各自许可）。
