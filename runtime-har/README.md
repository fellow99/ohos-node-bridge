# @fellow99/node-runtime —— Node.js 运行时（HarmonyOS / arm64-v8a）

在 HarmonyOS 应用进程内被 [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge)
`dlopen` 加载的 **Node.js 运行时二进制**（`libs/arm64-v8a/libnode.so`）。本包**不含** ArkTS API，
只承载运行时本体 + 版本常量。

```bash
ohpm install @fellow99/node-runtime@24.2.0
```

> **状态（2026-10-22）**：`24.2.0` 已提交中心仓审核。审核通过前公共搜索不可见，
> 本地接入请用 `"@fellow99/node-runtime": "file:<路径>/runtime-har"`，或直接 `ohpm publish` 产出的 `.har`。

## 这个包是什么

| 项 | 值 |
| --- | --- |
| Node 版本 | **v24.2.0**（`process.versions.node`） |
| `process.versions.modules` | **137**（SONAME `libnode.so.137`） |
| ABI / 架构 | **arm64-v8a**（AArch64）；**不做** x86_64 |
| 设备类型 | `2in1` / `tablet`（**不做 phone**） |
| 包内 `.so` | `libs/arm64-v8a/libnode.so`（126,809,264 B）+ `libc++_shared.so` |
| SHA-256（libnode.so） | `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` |

> **版本号 = Node 版本**（严格一一对应）：`24.2.0` 就是 Node v24.2.0。本包**不跟随** `@fellow99/node-bridge` 的版本号。

## 怎么用（两步）

```bash
# ① 装上两个包（主包提供 ArkTS API，本包提供运行时）
ohpm install @fellow99/node-bridge
ohpm install @fellow99/node-runtime@24.2.0
```

② 在自己的 `module.json5` 里按**自己的包名**声明 ACL（JIT 必需）：
`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` —— 详见主包 README。

装好之后：`assembleHap` 会把本包的 `libs/arm64-v8a/libnode.so` 合并进你的 HAP
（HAP 内路径 `libs/arm64-v8a/libnode.so`），运行期由主包的引导件 `dlopen` 加载。**不需要**再手工投放
（若你之前用 `tools/provision.mjs` 手工投放过，请删掉模块里的那份，避免同名双份）。

> 主包会按候选链逐个 `dlopen`；真机实测命中的是**安装后的 ABI 目录** `<bundleCodeDir>/libs/arm64/libnode.so`
> （HAP 内写 `arm64-v8a/`，安装时由系统映射）。因此本包的 `.so` **必须**留在 `libs/arm64-v8a/`，不要改名、不要挪目录。

## 校验（可选，建议进 CI）

```bash
# 装完后在 oh_modules 里核对 SHA-256 是否与上表一致（Linux/macOS）
shasum -a 256 oh_modules/@fellow99/node-runtime/libs/arm64-v8a/libnode.so
```

也可以在运行期自证版本（ArkTS）：

```ts
import { NODE_VERSION, NODE_MODULE_VERSION, LIB_SHA256 } from '@fellow99/node-runtime';
```

## 运行期限制（都是实测结论）

- **`dlopen` 加载的是 HAP 内那一份**：设备上的实际路径是 `<bundleCodeDir>/libs/arm64/libnode.so`；
  本包在 HAP 里是 `libs/arm64-v8a/`，安装时由系统映射到 ABI 目录。
- **`node::Start` 每进程只能一次**：崩溃即终态，只能重启应用。
- **JIT 需要受限 ACL**：没有它就必须 `--jitless`（代价：WebAssembly 全废）。
- `process.cwd()` = `/`、`execPath` = `/system/bin/appspawn`、`os.cpus()` 长度 0。

## 许可

- 本包封装的是 [Node.js](https://nodejs.org/) v24.2.0 的共享库构建，采用 **MIT**（Node.js 本体）。
- 包内 `LICENSE` = **Node.js 官方 `LICENSE` 原文**（取自 `nodejs/node` 的 tag `v24.2.0`，**逐字未改**）：
  142,089 B / 2,641 行 / **SHA-256 `b58bb782ec115892f61475a6199db165545926d93624ae172f25b7a6e1dafffe`**。
  该文件**汇总了全部内嵌第三方许可全文**（V8 / OpenSSL / ICU / llhttp / zlib / libuv / nghttp2 / c-ares / brotli / undici …）。
  自行复核：`shasum -a 256 oh_modules/@fellow99/node-runtime/LICENSE`。
- 构建来源：`electerm/ohos-node-shared` @ `ohos-node-shared-v24.2.0`（构建脚本 MIT）。
