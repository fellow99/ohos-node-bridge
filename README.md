# ohos-node-bridge（`@fellow99/node-bridge` + `@fellow99/node-runtime`）

> **一句话**：把**真正的 Node.js 运行时**（不是 WebView、不是云函数、不是子进程）以
> `NAPI 引导 + dlopen + node::Start` 的形态嵌进 **HarmonyOS 应用自己的进程**，拆成
> **两个可发布到 [ohpm](https://ohpm.openharmony.cn/) 的包**：一个装代码，一个装引擎。

它不是应用，而是**应用里的 Node.js 脚本环境**，面向多个 HarmonyOS 工程复用。
库的设计与对接契约见 [`docs/000-工程规划.md`](docs/000-工程规划.md)（只讲库本身，不绑定任何应用的业务语义）；
**发布面**（双包形态、中心仓规则、发布流水线）见
[`docs/提交到OpenHarmony三方库中心仓.md`](docs/提交到OpenHarmony三方库中心仓.md)。

> **在 OC Desktop 中的角色**：本库是 [`pi-desktop-ark`](../pi-desktop-ark)（**HarmonyOS Edition**）的运行时底座。
> Electron on HarmonyOS Edition（[`pi-desktop-hos`](../pi-desktop-hos)）**不使用**本库。

## 两个包（缺一不可）

| 包 | 版本策略 | 首发 | 体积（压缩） | 装什么 | 干什么 |
| --- | --- | --- | --- | --- | --- |
| **`@fellow99/node-bridge`** | 自身 semver | `0.1.0` | **488 KB** | ArkTS 字节码 + 类型 `.d.ets` + 引导件 `libnode_bridge.so` + `libnode_host_client.so` | **接口与加载器**：`NodeRuntime` 状态机、`HostBridge`（Node→ArkTS）、日志/崩溃取证；`dlopen` 引擎并调 `node::Start` |
| **`@fellow99/node-runtime`** | **= Node 版本** | `24.2.0` | **41 MB** | `libs/arm64-v8a/libnode.so`（121 MB）+ `libc++_shared.so` + 版本常量 + Node 官方 LICENSE | **引擎本体**：V8/JIT、`node:http` 等全部内置模块；不提供任何 ArkTS API |

> **发布状态**：✅ **两包均已上架**（2026-10-22）：[`@fellow99/node-bridge@0.1.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99/node-bridge) · [`@fellow99/node-runtime@24.2.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99/node-runtime)。
> 已用干净目录 `ohpm install` 实测：两包可拉取，`libnode.so` SHA-256 与锁值逐字一致。

两者靠**运行期符号契约**咬合（不是编译期链接）：引导件只认 `_ZN4node5StartEiPPc`（`node::Start(int,char**)`）
与 `napi_*`，因此**换 Node 版本不需要重编主包**（`specs/007` 的 `AC-007-11`，✅ 真机验证过）。

| 项 | 值 |
| --- | --- |
| 目标设备 | `2in1` / `tablet`（不做 phone）；ABI 只有 `arm64-v8a` |
| 运行时 | Node **v24.2.0**（`electerm/ohos-node-shared` 产物，SHA-256 锁定在 `runtime.lock.json`）；`process.versions.modules = 137` |
| 规划文档 | [`docs/000-工程规划.md`](docs/000-工程规划.md)（**v0.11**，结论以它为准）；规格见 [`specs/`](specs/) |

## 目录

```
ohos-node-bridge/
├── runtime.lock.json     # ★ 运行时唯一事实源：版本 + SHA-256 + 门禁结果 + 真机验证记录（二进制不入库）
├── runtime/              # 运行时产物本地缓存（node-v*/libnode-arm64.so；仅 *.so 不入库）
├── library/              # ★ 包 1：@fellow99/node-bridge（ArkTS + NAPI 引导件）
├── runtime-har/          # ★ 包 2：@fellow99/node-runtime（只承载 libnode.so；模块标识符 runtimehar）
├── payload/              # Node 侧 JS：bootstrap 参考实现 + selfcheck 自检（随仓库分发，不随 HAR）
├── tools/                # provision（投放/校验）· elf-inspect · verify-har（发布门禁）· release（双包流水线）
│                         # · probe（真机取证）· smoke-host（host 侧门禁）· ohos-selfsign · build-bridge
├── specs/                # 规格（NNN-<name>，对应规划文档 §7.3 编号）
├── tests/                # 测试说明与自检入口（host 侧 + 真机）
├── samples/              # 样例工程（minimal-app = 参考实现 + 真机探针）
├── docs/                 # 工程规划 + 发布分析
└── AppScope/ hvigorfile.ts build-profile.json5 oh-package.json5   # 本仓库 = 可编译的 DevEco 工程
```

## 快速开始（本仓库内构建）

```bash
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"

# ① 校验运行时产物（七项 ELF 门禁 + SHA-256，退出码 2 = 不合格）
node tools/provision.mjs --check

# ② 投放进「运行时包」模块（幂等；不入库）
node tools/provision.mjs --out runtime-har/libs/arm64-v8a

# ③ 出两个 release HAR（主包 ≈488 KB / 运行时包 ≈41 MB）
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default     -p buildMode=release assembleHar --no-daemon"
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=runtimehar@default -p buildMode=release assembleHar --no-daemon"

# ④ 本地发布门禁（复刻中心仓服务端规则；两包都要过）
node tools/verify-har.mjs library/build/default/outputs/default/library.har
node tools/verify-har.mjs runtime-har/build/default/outputs/default/runtimehar.har

# ⑤ 一条命令跑完「版本一致性 → 投放 → 两个 HAR → 双门禁 → 双 prepublish」
node tools/release.mjs --all
```

**签名**：仓库内**不含任何密钥**。构建默认产出未签名包；要签名就在 DevEco 里为
`org.fellow99.nodebridge.sample` 生成调试签名，然后把值填进 `signing.debug.local.json`
（照抄 `signing.debug.local.json.sample`，该文件已 gitignore）。

## 消费方接入（三步）

```bash
# ① 装两个包：主包给 API，运行时包给引擎
ohpm install @fellow99/node-bridge
ohpm install @fellow99/node-runtime@24.2.0
```

② 在自己的 `module.json5` 按**自己的包名**申请并声明 ACL：
`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`
（JIT 必需；没有它 V8 走 JIT 会 SIGTRAP，`--jitless` 可兜底但 WebAssembly 全废）。

③ 自备载荷：把应用代码放进自己的模块（`resources/resfile/<app>/` 只读直读为首选，见 [`payload/README.md`](payload/README.md)）。

```ts
import { NodeRuntime } from '@fellow99/node-bridge';
NodeRuntime.getInstance().start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<沙箱绝对路径>/payload/bootstrap.js'
});
```

> **离线 / 自建产物怎么办**：不用运行时包，改用手工投放
> `node ohos-node-bridge/tools/provision.mjs --out entry/libs/arm64-v8a`
> （版本与 SHA-256 由 `runtime.lock.json` 锁定）。**两种方式择一，不要同时放**同名 `.so`。
> 注意：主包**不声明**对运行时包的依赖，两个包必须分别安装。

## 发布到 ohpm

> **状态**：✅ 已上架（2026-10-22）。干净目录 `ohpm install` 实测可拉取两包并构建。

**一条命令自检**（版本一致性 → 投放运行时 → 两个 release HAR → 双门禁 → 双 `prepublish`）：

```bash
node tools/release.mjs --all
```

**发布两条命令**（必须**交互式终端**：ohpm 会提示输入私钥口令）：

```bash
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
ohpm config set publish_id <中心仓个人中心的发布码>
ohpm config set key_path <私钥>

# ★ 顺序不能反：先运行时包，后主包；也**不要**加 -t latest（服务端拒绝该 tag）
# ⚠️ 无 TTY 环境（CI/重定向）会因口令提示死循环而 OOM —— 与包体积无关
ohpm publish runtime-har/build/default/outputs/default/runtimehar.har
ohpm publish library/build/default/outputs/default/library.har
```

完整流程、两道坑的根因、失败重试策略与未决事项：[`docs/提交到OpenHarmony三方库中心仓.md`](docs/提交到OpenHarmony三方库中心仓.md)。

## 已知限制（实测结论，非推断）

| 限制 | 影响 |
| --- | --- |
| `node::Start` **每进程只能一次** | 崩溃即终态，应用内无法重启 Node（只能重启应用） |
| **JIT 需要 ACL**；`--jitless` 会关掉 WebAssembly | 无 ACL 时 Next 的 WASM SWC、undici 的 llhttp WASM 必须改造 |
| `process.cwd()` = `/`、`execPath` = `/system/bin/appspawn`、`os.cpus()` 长度 0 | 路径一律用绝对路径；不要靠这三者做版本/并发探测 |
| **`dlopen` 的有效路径是 ABI 目录**：设备上实际落在 `<bundleCodeDir>/libs/arm64/`（HAP 内是 `libs/arm64-v8a/`） | ✅ 真机实测：`libs/arm64-v8a/…` 与 `<bundleCodeDir>/libnode.so` 两个候选 `Operation not permitted`，`libs/arm64/libnode.so` 命中；早期「只认裸名」的说法已作废 |

## 许可

本仓库自身 **MIT**（见 `LICENSE`）。
随包分发的 Node.js 运行时适用**其上游许可**：`runtime-har/LICENSE` 是 Node.js 官方 `LICENSE` **原文**
（142,089 B，含 V8/OpenSSL/ICU 等全部第三方许可全文），来源与 SHA-256 见 `runtime.lock.json` 与
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
