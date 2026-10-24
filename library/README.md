# @fellow99/node-bridge —— 在应用进程内嵌入真正的 Node.js 运行时

把**真正的 Node.js 运行时**（不是 WebView、不是云函数、不是子进程）以
`NAPI 引导 + dlopen + node::Start` 的形态嵌进 **HarmonyOS 应用自己的进程**，
供 ArkTS 调用、由 ArkWeb 消费它起的本地服务。

- 配套运行时包：**`@fellow99/node-runtime@24.2.0`**（Node 版本号即包版本号，独立仓库 [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime)）
- **状态**：`0.1.0` 已上架（2026-10-22，[详情页](https://ohpm.openharmony.cn/#/cn/detail/@fellow99/node-bridge)）；`0.2.0` 拆仓

## 安装（两个包，缺一不可）

```bash
# ① 本包（ArkTS API + NAPI 引导件，约 0.5 MB）
ohpm install @fellow99/node-bridge

# ② 运行时包（Node v24.2.0 的 libnode.so，约 41 MB）
ohpm install @fellow99/node-runtime@24.2.0
```

> 主包**刻意不声明**对运行时包的依赖 ⇒ 两个包都要显式安装。

装完 `assembleHap` 时，运行时包的 `libs/arm64-v8a/libnode.so` 会被合并进你的 HAP，
运行期由引导件加载，**不需要额外投放步骤**；目标设备：`2in1` / `tablet`，ABI 只有 `arm64-v8a`。

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

## 消费方必须做的三件事

| # | 做什么 | 为什么 |
| --- | --- | --- |
| 1 | **装运行时包**：`ohpm install @fellow99/node-runtime@24.2.0`（独立仓库 [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) 发布） | 本 HAR **不带** `libnode.so`（约 121 MB），由运行时包承载 |
| 2 | **声明权限与 ACL**：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（JIT 必需）按**你自己的包名**申请并声明 | 没有它，V8 走 JIT 即 SIGTRAP；`--jitless` 可兜底但 WebAssembly 全废 |
| 3 | **自备载荷**：把应用代码放到 `resources/resfile/<app>/`（只读直读，零解压） | Node 读得到 ArkTS 写的文件，读不到包内只读条目 |

## 包内容（发布物）

| 条目 | 说明 |
| --- | --- |
| `ets/modules.abc` + `Index.d.ets` + `src/main/ets/**/*.d.ets` | 编译后的 ArkTS 字节码与类型声明（byteCodeHar） |
| `libs/arm64-v8a/libnode_bridge.so` | NAPI 引导件（≈42 KB）：`dlopen` 引擎 + `dlsym(node::Start)` |
| `libs/arm64-v8a/libnode_host_client.so` | Node 侧宿主桥 addon（≈7.6 KB），`napi_*` 保持未定义、由引擎解析 |
| `src/main/resources/rawfile/node_bridge/*` | 随包事实源：`runtime.lock.json`、`THIRD-PARTY-NOTICES.md`、`compatibility.json`（可运行期读取） |
| `README.md` / `CHANGELOG.md` / `LICENSE` | 中心仓必要文件（`LICENSE` 为本库 MIT 原文） |
| `libc++_shared.so` | hvigor 对 native 模块自动补入（HAR 层无法排除）；运行时包也自带一份，最终 HAP 按路径去重只保留一份（✅ 实测） |
| ~~`libnode.so`~~ | **不随本包**（121 MB，由 `@fellow99/node-runtime` 提供） |

## 已知限制（都是实测结论，不是猜测）

- **`--jitless` 会关掉 WebAssembly**：Next 的 WASM SWC、undici 的 llhttp WASM 都依赖它 ⇒ 无 ACL 时这些载荷必须改造；
- **`node::Start` 每进程只能一次**：崩溃即终态，无法在应用内重启（只能重启应用）；
- **`process.cwd()` = `/`**、**`process.execPath` = `/system/bin/appspawn`**、**`os.cpus()` 长度 0**：不要依赖这三者；
- **`dlopen` 命中的是 ABI 目录**：设备上引擎实际落在 `<bundleCodeDir>/libs/arm64/`（HAP 内是 `libs/arm64-v8a/`），
  引导件按候选链逐个尝试，实测 `libs/arm64/libnode.so` 命中（另外两个候选 `Operation not permitted`）。

## 许可

本包自身 **MIT**（见包内 `LICENSE`）。它**不含** Node.js 二进制；随应用分发的 Node 运行时
（来自 `@fellow99/node-runtime`）适用其自身许可 —— 该包内附 Node.js 官方 `LICENSE` 原文。
