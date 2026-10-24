# ohos-node-bridge

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 把**真正的 Node.js 运行时**嵌入 **HarmonyOS 应用自己的进程**——
> 不是 WebView、不是云函数、不是子进程。

本仓库只包含 **bridge 包**（ArkTS API + NAPI 引导件原生库）；**引擎本体**
（`libnode.so`）在独立仓库 [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime)，
发布为 `@fellow99/node-runtime`。

[English](README.md) · **语言：简体中文**

---

## 工作原理

```
┌──────────────────────────── HarmonyOS 应用进程 ────────────────────────────┐
│                                                                            │
│  ArkTS 页面 ──► NodeRuntime.start()                                       │
│                     │                                                      │
│                     ▼                                                      │
│   libnode_bridge.so  ── dlopen("libnode.so") ──►  libnode.so（V8 + Node） │
│   （本包）              dlsym(node::Start)              （runtime 包）     │
│                                                                            │
│        Node JS  ◄──── NAPI 宿主桥 ────►  ArkTS 处理器（HostBridge）       │
└────────────────────────────────────────────────────────────────────────────┘
```

两个包靠**运行期符号契约**咬合（`dlopen` + `dlsym(node::Start)` + `napi_*`），
**不是编译期链接**。换 Node 版本（如 24.2.0 → 24.x）**不需要重编 bridge**。

## 安装

两个包**缺一不可**：

```bash
# Bridge —— ArkTS API + 原生引导件（约 0.5 MB）
ohpm install @fellow99/node-bridge

# Runtime —— Node.js 引擎二进制（压缩后约 41 MB）
ohpm install @fellow99/node-runtime@24.2.0
```

bridge **刻意不声明**对 runtime 的依赖，所以两个包都要显式安装，Node 版本由你自己选择。

## 30 秒用法

```ts
import { NodeRuntime } from '@fellow99/node-bridge';
import { common } from '@kit.AbilityKit';

const runtime = NodeRuntime.getInstance();
const result = runtime.start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<沙箱绝对路径>/payload/bootstrap.js',
  // flags: '--jitless',  // 无 JIT ACL 时的兜底（会关闭 WebAssembly）
});
```

## 消费方必须做的三件事

| # | 做什么 | 为什么 |
|---|--------|--------|
| 1 | 安装 `@fellow99/node-runtime@24.2.0` | bridge **不带** `libnode.so`（约 121 MB），由 runtime 包提供 |
| 2 | 按**自己的包名**申请 ACL `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | JIT 必需；没有它 V8 走 JIT 会 SIGTRAP，`--jitless` 可兜底但 WebAssembly 全废 |
| 3 | 把载荷放到 `resources/resfile/<app>/`（只读直读） | Node 读不到包内只读条目，必须用应用沙箱绝对路径 |

## API 面

| 导出 | 用途 |
|------|------|
| `NodeRuntime` | 单例生命周期管理：`start()`、状态机、崩溃取证 |
| `NodeState` | 运行时状态枚举 |
| `HostBridge` | 注册可被 Node JS 调用的 ArkTS 处理器 |
| `HostBridgeHandler` | Node → ArkTS 调用的处理器签名 |
| `Logger` | 进程内日志环 + hilog 桥接 |
| `Env` | 路径 / 环境变量装配 |
| 类型 | `NodeRuntimeOptions`、`NodeStartResult`、`NodeLogEntry`、`CrashRecord` |

## 两个仓库

| | **ohos-node-bridge**（本仓库） | [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) |
|---|---|---|
| **ohpm 包** | `@fellow99/node-bridge` | `@fellow99/node-runtime` |
| **版本** | 自身 semver（当前 `0.2.0`） | **= Node 版本**（当前 `24.2.0`） |
| **装什么** | ArkTS 字节码 + `libnode_bridge.so` 引导件 + `libnode_host_client.so` NAPI addon | `libnode.so`（约 121 MB）+ `libc++_shared.so` + 版本常量 |
| **干什么** | `NodeRuntime` 状态机、`HostBridge`（Node ↔ ArkTS）、`dlopen` 引擎并调 `node::Start` | 引擎本体：V8/JIT 与全部内置模块；**不提供 ArkTS API** |
| **发布节奏** | 跟功能迭代走 | 跟 Node 大版本走 |

| 项 | 值 |
|----|----|
| 目标设备 | `2in1` / `tablet`（不做 phone）；ABI 仅 `arm64-v8a` |
| 运行时 | Node.js **v24.2.0**；`process.versions.modules = 137` |
| 设计文档 | [`docs/`](docs/)（工程规划、规格、发布分析） |

## 仓库结构

```
ohos-node-bridge/
├── library/        # @fellow99/node-bridge 源码（ArkTS + NAPI 引导件 C）
├── payload/        # Node 侧 JS：参考 bootstrap + selfcheck
├── samples/        # 样例工程（minimal-app = 参考实现 + 真机探针）
├── tools/          # build-bridge · elf-inspect · probe（真机取证）
├── specs/          # 规格（NNN-<name>）
├── docs/           # 工程规划 + 发布分析
└── AppScope/ hvigorfile.ts build-profile.json5 oh-package.json5
```

## 构建

```bash
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"

# 出 release HAR
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default -p buildMode=release assembleHar --no-daemon"
```

仓库内**不提交任何签名材料**，默认产出未签名包；需要签名时在 DevEco 里配置，
并填入 `signing.debug.local.json`（已 gitignore）。

## 发布到 ohpm

```bash
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
ohpm config set publish_id <发布码>
ohpm config set key_path <私钥>
ohpm publish library/build/default/outputs/default/library.har
```

> 必须在**交互式终端**运行（ohpm 会提示输入私钥口令）；无 TTY 环境会挂起并 OOM。

## 已知限制（真机实测结论，非推断）

| 限制 | 影响 |
|------|------|
| `node::Start` **每进程只能调一次** | 崩溃即终态，应用内无法重启 Node（只能重启应用） |
| JIT 需要 ACL；`--jitless` 会关闭 WASM | 无 ACL 时 Next 的 SWC / undici 的 llhttp WASM 必须改造 |
| `process.cwd()=/`、`execPath=/system/bin/appspawn`、`os.cpus()` 长度 0 | 路径一律用绝对路径；不要靠这三者做版本/并发探测 |
| `dlopen` 的有效路径是 `libs/arm64/`（不是 `libs/arm64-v8a/`） | 引导件内部已处理，消费方无感 |

## 许可

本仓库 **MIT** 许可（见 [`LICENSE`](LICENSE)），不含 Node.js 二进制。
随应用分发的 Node.js 运行时由 [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime)
提供，适用其上游许可（该包内含 Node.js 官方 `LICENSE` 原文）。
