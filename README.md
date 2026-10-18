# ohos-node-bridge（`@fellow99/node-bridge`）

> **一句话**：把**真正的 Node.js 运行时**（不是 WebView、不是云函数、不是子进程）以
> `NAPI 引导 + dlopen + node::Start` 的形态嵌进 **HarmonyOS 应用自己的进程**，
> 封装成可发布到 [ohpm](https://ohpm.openharmony.cn/) 的 **ArkTS 组件库**。

它不是应用，而是**应用里的 Node.js 脚本环境**，面向多个 HarmonyOS 工程复用，
并计划发布到 [OpenHarmony 三方库中心仓（ohpm）](https://ohpm.openharmony.cn/)。
库的设计与对接契约见 [`docs/000-工程规划.md`](docs/000-工程规划.md)（只讲库本身，
不绑定任何具体应用的业务语义）。

> **在 OC Desktop 中的角色**：本库是 [`oc-desktop-ark`](../oc-desktop-ark)（**HarmonyOS Edition**）的运行时底座；
> `runtime/` 目录存放锁定版本的 `libnode-arm64.so`（v24.2.0 / ABI 137）与投放/校验工具，
> 由 `tools/provision.mjs` 投放进消费方模块。Electron on HarmonyOS Edition（[`oc-desktop-hos`](../oc-desktop-hos)）**不使用**本库。

| 项 | 值 |
| --- | --- |
| 包名 / 版本 | `@fellow99/node-bridge` / `0.1.0`（**骨架**） |
| 形态 | ArkTS 组件库（HAR）+ NAPI 引导件（`.so`）+ 运行时获取/校验工具链 |
| 目标设备 | `2in1` / `tablet`（不做 phone） |
| 运行时 | Node **v24.2.0**（`electerm/ohos-node-shared` 产物，SHA-256 锁定在 `runtime.lock.json`） |
| 规划文档 | [`docs/000-工程规划.md`](docs/000-工程规划.md)（**v0.11**：只讲**库本身**，**结论以它为准**）；规格见 [`specs/`](specs/) |

## 目录

```
ohos-node-bridge/
├── runtime.lock.json     # ★ 运行时唯一事实源：版本 + SHA-256 + 门禁结果 + 真机验证记录（二进制不入库）
├── runtime/              # 运行时产物本地缓存（node-v*/libnode-arm64.so；仅 *.so 不入库，README/校验/溯源入库）
├── library/              # ★ 发布到 ohpm 的 HAR（ArkTS + NAPI 引导件）
├── payload/              # Node 侧 JS：bootstrap 参考实现 + selfcheck 自检
├── tools/                # provision.mjs（投放/校验）· elf-inspect.py · ohos-selfsign.mjs
├── specs/                # 规格（NNN-<name>，对应规划文档 §7.3 编号）
├── tests/                # 测试说明与自检入口（host 侧 + 真机）
├── samples/              # 样例工程（Phase 1；当前仅占位，见其 README）
├── docs/                 # 工程规划
└── AppScope/ hvigorfile.ts build-profile.json5 oh-package.json5   # 本仓库 = 可编译的 DevEco 工程
```

## 快速开始

```bash
# ① 构建 HAR（本仓库根就是工程根；CLT 的 hvigorw 即可，无需 DevEco GUI）
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default assembleHar --no-daemon"
# 产物：library/build/default/outputs/default/library.har

# ② 校验运行时产物（不进构建，但消费方构建前必做）
node tools/provision.mjs --check      # 七项 ELF 门禁 + SHA-256
node tools/provision.mjs --list       # 打印锁定项
```

**签名**：仓库内**不含任何密钥**。构建默认产出未签名包；要签名就在 DevEco 里为
`org.fellow99.nodebridge.sample` 生成调试签名，然后把值填进 `signing.debug.local.json`
（照抄 `signing.debug.local.json.sample`，该文件已 gitignore）。

## 消费方接入（三步）

1. `oh-package.json5` 加依赖：`"@fellow99/node-bridge": "file:../ohos-node-bridge/library"`（或发布后的版本号）；
2. 投放运行时到自己的模块：`node ohos-node-bridge/tools/provision.mjs --out entry/libs/arm64-v8a`；
3. 在自己的 `module.json5` 按**自己的包名**申请并声明 ACL：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`
   （JIT 必需；没有它 V8 走 JIT 会 SIGTRAP，`--jitless` 可兜底但 WebAssembly 全废）。

```ts
import { NodeRuntime } from '@fellow99/node-bridge';
NodeRuntime.getInstance().start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<沙箱绝对路径>/payload/bootstrap.js'
});
```

## 已知限制（实测结论，非推断）

| 限制 | 影响 |
| --- | --- |
| `node::Start` **每进程只能一次** | 崩溃即终态，应用内无法重启 Node（只能重启应用） |
| **JIT 需要 ACL**；`--jitless` 会关掉 WebAssembly | 无 ACL 时 Next 的 WASM SWC、undici 的 llhttp WASM 必须改造 |
| `process.cwd()` = `/`、`execPath` = `/system/bin/appspawn`、`os.cpus()` 长度 0 | 路径一律用绝对路径；不要靠这三者做版本/并发探测 |
| `dlopen` 只认**裸名** `libnode.so` | 引导件因此先试绝对路径再落到裸名（见 `library/src/main/cpp/node_bridge.c`） |

## 许可

MIT（见 `LICENSE`）。随应用一起分发的 Node.js 运行时适用其上游许可。
