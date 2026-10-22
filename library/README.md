# @fellow99/node-bridge —— 在应用进程内嵌入真正的 Node.js 运行时

把**真正的 Node.js 运行时**（不是 WebView、不是云函数、不是子进程）以
`NAPI 引导 + dlopen + node::Start` 的形态嵌进 **HarmonyOS 应用自己的进程**，
供 ArkTS 调用、由 ArkWeb 消费它起的本地服务。

- 目标设备：`2in1` / `tablet`（不做 phone）
- 形态：**ArkTS 组件库（HAR）+ NAPI 引导件（`.so`）**，发布到 [ohpm](https://ohpm.openharmony.cn/)
- 当前版本：`0.1.0`（**骨架**：编译链路通，运行时行为待 Phase 1/2 补齐）
- 配套运行时包：**`@fellow99/node-runtime@24.2.0`**（Node 版本号即包版本号）

## 安装

```bash
# ① 本包（ArkTS API + NAPI 引导件，约 0.5 MB）
ohpm install @fellow99/node-bridge

# ② 运行时包（Node v24.2.0 的 libnode.so，约 41 MB）
ohpm install @fellow99/node-runtime@24.2.0
```

装完 `assembleHap` 时，运行时包的 `libs/arm64-v8a/libnode.so` 会被合并进你的 HAP，
运行期由引导件加载，**不需要额外投放步骤**；SW/HW 目标设备：`2in1` / `tablet`，ABI 只有 `arm64-v8a`。

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

装好后还需要：② 在你的 `module.json5` 里声明本库需要的权限与**受限 ACL**（JIT 必需，见下）；
③ 把应用载荷放进你自己的模块（见「消费方必须做的三件事」第 3 条）。

## 消费方必须做的三件事

| # | 做什么 | 为什么 |
| --- | --- | --- |
| 1 | **装运行时包**：`ohpm install @fellow99/node-runtime@24.2.0`；离线/自建场景可改用 `tools/provision.mjs --out <你的模块>/libs/arm64-v8a` 手工投放（二者**择一**，别同时放） | 本 HAR **不带** `libnode.so`（约 121 MB）；版本与 SHA-256 固化在 `runtime.lock.json`，由运行时包承载 |
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
- **`dlopen` 命中的是 ABI 目录**：设备上引擎实际落在 `<bundleCodeDir>/libs/arm64/`（HAP 内是 `libs/arm64-v8a/`），
  引导件按候选链逐个尝试，实测 `libs/arm64/libnode.so` 命中（另外两个候选 `Operation not permitted`）。

## 包内容（发布物）

| 条目 | 说明 |
| --- | --- |
| `ets/modules.abc` + `Index.d.ets` + `src/main/ets/**/*.d.ets` | 编译后的 ArkTS 字节码与类型声明（byteCodeHar） |
| `libs/arm64-v8a/libnode_bridge.so` | NAPI 引导件（≈42 KB）：`dlopen` 引擎 + `dlsym(node::Start)` |
| `libs/arm64-v8a/libnode_host_client.so` | Node 侧宿主桥 addon（≈7.6 KB），`napi_*` 保持未定义、由引擎解析 |
| `libs/arm64-v8a/libc++_shared.so` | 来自 ohos-sdk（运行期依赖） |
| `README.md` / `CHANGELOG.md` / `LICENSE` | 中心仓四件套（`LICENSE` 为本库 MIT 原文） |
| ~~`libnode.so`~~ | **不随本包**（121 MB，由 `@fellow99/node-runtime` 提供） |

## 许可

本包自身 **MIT**（见包内 `LICENSE`）。它**不含** Node.js 二进制；随应用分发的 Node 运行时
（来自 `@fellow99/node-runtime`）适用其自身许可 —— 该包内附 Node.js 官方 `LICENSE` 原文。
