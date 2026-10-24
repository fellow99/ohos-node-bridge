# ohos-node-bridge

> 把**真正的 Node.js 运行时**嵌入 **HarmonyOS 应用自己的进程**——不是 WebView、不是云函数、不是子进程。
> 本仓库只包含 **bridge 包**（ArkTS API + NAPI 引导件）；**引擎本体**（`libnode.so`）在独立仓库
> [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime)。

## 安装

```bash
# 两个包都要装（缺一不可）
ohpm install @fellow99/node-bridge
ohpm install @fellow99/node-runtime@24.2.0
```

bridge 与 runtime 靠**运行期符号契约**咬合（`dlopen` + `dlsym(node::Start)` + `napi_*`），
**不是编译期链接**——换 Node 版本不需要重编 bridge。

## 30 秒用法

```ts
import { NodeRuntime } from '@fellow99/node-bridge';
import { common } from '@kit.AbilityKit';

const runtime = NodeRuntime.getInstance();
const result = runtime.start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<沙箱绝对路径>/payload/bootstrap.js',
  // flags: '--jitless'  // 无 ACL 时改用（WebAssembly 会失效）
});
```

## 消费方必须做的三件事

| # | 做什么 | 为什么 |
|---|--------|--------|
| 1 | `ohpm install @fellow99/node-runtime@24.2.0` | bridge **不声明**对 runtime 的依赖；`libnode.so`（~121 MB）由 runtime 包承载 |
| 2 | 按**自己的包名**申请 ACL `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | JIT 必需；没有它 V8 走 JIT 即 SIGTRAP（`--jitless` 可兜底但 WASM 全废） |
| 3 | 自备载荷到 `resources/resfile/<app>/`（只读直读） | Node 读不到包内只读条目，必须用应用沙箱路径 |

## 两个仓库

| | [ohos-node-bridge](https://github.com/fellow99/ohos-node-bridge)（本仓库） | [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) |
|---|---|---|
| **ohpm 包** | `@fellow99/node-bridge` | `@fellow99/node-runtime` |
| **版本策略** | 自身 semver（当前 `0.2.0`） | **= Node 版本**（当前 `24.2.0`） |
| **装什么** | ArkTS 字节码 + `libnode_bridge.so`（引导件）+ `libnode_host_client.so`（NAPI addon） | `libnode.so`（~121 MB）+ `libc++_shared.so` + 版本常量 |
| **干什么** | `NodeRuntime` 状态机、`HostBridge`（Node→ArkTS）、`dlopen` 引擎并调 `node::Start` | 引擎本体：V8/JIT、`node:http` 等全部内置模块；**不提供 ArkTS API** |
| **发布节奏** | 跟功能迭代走 | 跟 Node 大版本走 |

## 仓库结构

```
ohos-node-bridge/
├── library/              # @fellow99/node-bridge 源码（ArkTS + NAPI 引导件 C）
├── payload/              # Node 侧 JS：bootstrap 参考实现 + selfcheck 自检
├── samples/              # 样例工程（minimal-app = 参考实现 + 真机探针）
├── tools/                # build-bridge · elf-inspect · probe（真机取证）
├── specs/                # 规格文档（NNN-<name>）
├── docs/                 # 工程规划 + 发布分析
└── AppScope/ hvigorfile.ts build-profile.json5 oh-package.json5
```

## 构建

```bash
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"

# 出 release HAR
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default -p buildMode=release assembleHar --no-daemon"
```

签名：仓库内**不含密钥**。默认产出未签名包；需要签名时按 DevEco 指引生成后填入
`signing.debug.local.json`（已 gitignore）。

## 发布到 ohpm

```bash
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
ohpm config set publish_id <发布码>
ohpm config set key_path <私钥>
ohpm publish library/build/default/outputs/default/library.har
```

> 必须**交互式终端**（ohpm 提示输入私钥口令）；无 TTY 环境会死循环 OOM。

## 已知限制（实测结论）

| 限制 | 影响 |
|------|------|
| `node::Start` **每进程只能一次** | 崩溃即终态，只能重启应用 |
| JIT 需 ACL；`--jitless` 关掉 WASM | 无 ACL 时 Next SWC / undici llhttp 必须改造 |
| `process.cwd()=/`、`execPath=/system/bin/appspawn`、`os.cpus()` 长度 0 | 路径一律绝对路径 |
| `dlopen` 有效路径是 `libs/arm64/`（非 `libs/arm64-v8a/`） | 引导件内部已处理，消费方无感 |

## 许可

本仓库 **MIT**（见 [`LICENSE`](LICENSE)）。
Node.js 运行时适用其上游许可，由 [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) 包内 `LICENSE` 原文承载。
