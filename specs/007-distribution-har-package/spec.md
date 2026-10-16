# spec.md —— `007-distribution-har-package`（分发 · HAR 包与接入契约）

> 上游规划：[`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) §7.5 发布物与版本策略 / §7.2 目录结构 / §7.3 模块编号 / §7.4 构建流水线 / §6.1 承诺与责任 / §8 Phase 2·Phase 3 / §9.3 待人工确认 / §9.4 权限 / §9.5 上架合规 / §4.8 上架合规可行性 / 附录 C 体积预算 / 附录 G.1·G.8。
> 宪法：[`../constitution.md`](../constitution.md) C1 / S2 / S3 / S10、合规红线 G3 / G4 / G5 / G11。
> 编号与内容：`007-distribution`（规划 §7.3：「ohpm 包形态、版本策略、许可清单、接入文档」）。
> 本文**技术无关**：只写「要什么、怎么算通过」，不写实现细节（实现见 `plan.md`）。
> 证据标记：✅ 实测 · 🔶 沿用外部/同型工程 · ⬜ 待验证/未落地 · ⚠️ 冲突或风险。

---

## 1. 模块概述

### 1.1 目的

把「进程内 Node.js 运行时」交付给**第三方**——他们不读本仓库源码、不进内部群、不重编 C++，也能
**自己拿到产物、自己校验、自己接入**。本模块定义发布物的**形状**（HAR 里有什么、没有什么）、
**边界**（哪些内容随包、哪些由消费方自备）、**声音**（版本、许可、权限声明面）与**接入步骤**。

### 1.2 它解决什么问题

| # | 问题 | 本模块的回答 |
|---|---|---|
| 1 | 第三方拿不到 121 MB 的 `libnode.so`（GitHub 单文件 100 MiB 硬限、无制品库） | 二进制**不入库、也不入 HAR**；给「锁文件（版本 + SHA-256 + 门禁）+ 投放工具 + 三条获取出路」（附录 G.1 / §7.5） |
| 2 | 第三方不知道该配什么版本 | 版本**固化在文件里**：`runtime.lock.json` 是唯一事实源，`diff` 即审计；库版本 ↔ 运行时版本矩阵可查（§7.5） |
| 3 | 第三方不知道要申请哪些权限（JIT 无 ACL 即 SIGTRAP） | 库只声明**自己需要的**开放权限；受限 ACL 由消费方**按自己的包名**申报，README 写清（§9.4 / §7.5） |
| 4 | 第三方不知道「怎么接」 | **三步**：加依赖 → 投放运行时 → 按自己包名声明 ACL；一步一判据（§6.1） |
| 5 | 合规审查要问「包里到底有什么」 | 包内容清单化 + 第三方许可清单 + 明确「不得含绕行实现」（G3 / G4 / G11） |

### 1.3 范围

**在范围内**：ohpm 包形态（HAR 内容边界）、barrel 导出面与类型契约的**登记与稳定性**、
`libnode.so` 的「不随包 + 怎么拿」边界、`runtime.lock.json` 作为版本/供应链事实源的随包或随仓库可达性、
`module.json5` 权限声明面、`.ohpmignore` 排除规则、语义化版本策略与版本矩阵、兼容矩阵、
第三方许可清单、三步接入契约与两种接入形态（`file:` 源目录 / 构建出的 `.har`）、样例工程计划、Phase 2/3 交付物与验收判据。

**不在范围内**（明确排除，避免越界改别人的东西）：

- 具体应用（`pi-desktop-ark`）的接入**实现**：Ability、ArkWeb、加载页、鉴权、载荷裁剪（§0.3 / §6.1 / §6.4）；
- 运行时的**获取实现**（`tools/provision.mjs` 本体属 `005-provision-verify`）与编译实现（`002-napi-bootstrap`）；
- 库的运行期 API 语义（属 `001`/`003`/`006`），本模块只**登记**导出面与契约稳定性口径；
- 自建 `libnode.so` 的配方（§G.6 路线 C，Phase 3 可选项）。

---

## 2. 用户故事

| 角色 | 故事 | 出口判据 |
|---|---|---|
| **第三方 ohpm 使用者**（不认识本仓库的人） | 我想在 ohpm 上装 `@fellow99/node-bridge`，跑通「起 Node → 起本地 HTTP 服务」，而不用读 C++、不用理解 ELF | 照 README 三步做完，`assembleHap` 成功，HAP 内 `libs/arm64-v8a/` 有 `libnode.so`（SHA = 锁值）与 `libnode_bridge.so`（来自 HAR），真机 `/facts` 返回正确 JSON |
| **第三方 ohpm 使用者**（合规敏感团队） | 我要在采购/上架材料里写清「这个包带了什么第三方代码、什么许可、从哪来」 | 拿到许可清单与来源 + SHA-256；能自己复核（`provision --check` 全过） |
| **库维护者** | 我要在**不改库代码**的前提下换 Node 版本 / 换签名策略 / 换消费方 | 换版本只改 `runtime.lock.json` 一行 + 重跑门禁；换消费方不动发布物；新公共 API 必须同时改 barrel 与类型文件并提版本 |
| **合规审计者** | 我要证明发布物里**没有**浏览器内核、没有绕过平台代码签名/可执行内存控制的组件 | HAR/HAP 内容清单可复核（含/不含逐项列举）；G11 有可执行的审计判据（检索关键词 + 物理隔离要求） |

---

## 3. 功能需求

> 编号连续，`FR-007-001` 起。**现状**列区分「已实现 ✅」「未落地 ⬜」「有风险 ⚠️」。

| 编号 | 需求 | 现状与判据 |
|---|---|---|
| **FR-007-001** | **单一入口导出面**：HAR 对外只经 `library/Index.ets`（S2），`oh-package.json5` 的 `main` 指向它；对外可见符号必须**逐项登记**（名称 / 种类 / 来源文件），未登记即不得新增 | ✅ `main: Index.ets`（`library/oh-package.json5:5`）；导出面 = **8 个符号、6 条 `export` 语句**（`library/Index.ets:16-21`），清单见 `plan.md` §4.3 |
| **FR-007-002** | **类型即契约**：`runtime/Types.ets` 的每个声明都是对外契约，改动即破坏性变更（S3）；文件头必须写明该口径 | ✅ `Types.ets:1-5` 已写明；4 个声明：`NodeState` / `NodeRuntimeOptions` / `NodeStartResult` / `HostBridgeHandler` |
| **FR-007-003** | **HAR 不得含大二进制**：包内不含 `libnode.so`（121 MB）及任何运行时二进制（S10 / §7.5） | ✅ 实测：HAR 内 27 个条目里**无** `libnode.so`（`library/.ohpmignore:11` + 产物核对，见 `plan.md` §6.2） |
| **FR-007-004** | **HAR 必须含引导件**：`libnode_bridge.so` 与其类型声明入口（`Index.d.ets`）随包；引导件不链接 `libnode.so`（S7），因此换运行时版本不需要重编库 | ✅ 实测：`package/libs/arm64-v8a/libnode_bridge.so` 14,208 B + `package/Index.d.ets` 1,104 B；`CMakeLists.txt:16` 只链接 `libace_napi.z.so` / `libhilog_ndk.z.so` |
| **FR-007-005** | **HAR 必须给出「怎么拿到运行时」的可闭合线索**：至少含锁定版本 + SHA-256 + 门禁结论（锁文件）与投放方式（工具入口 + 用法）；可执行载荷（`payload/`）要么随包、要么给出等效的、网络可达的获取路径 | ⬜ **未落地**：HAR 内**没有** `runtime.lock.json`，也**没有** `payload/`（`payload/` 在**仓库根**，不在 `library/` 内，hvigor 只收 `library/`）；当前这些线索只存在于 GitHub 仓库文本里。修法与判据见 `plan.md` §9 第 2/3 项 |
| **FR-007-006** | **权限声明最小化**：HAR 的 `module.json5` 只声明库**自身确实需要**的开放权限 | ✅ 仅 2 项：`ohos.permission.INTERNET`、`ohos.permission.GET_NETWORK_INFO`（`library/src/main/module.json5:12-22`）；不照抄旧壳的 21 条（§9.4） |
| **FR-007-007** | **受限权限归消费方**：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（JIT 刚性前置）由消费方按**自己的包名**申报并在自己的 `module.json5` 里与 `definePermissions` **成对**声明；库不得替消费方声明、也不得暗示「装了库就有 JIT」 | ⚠️ 库侧 ✅（不声明，且注释写明归属，`module.json5:13-15`）；README ✅ 写明第 2 步；**成对声明**的判据在消费方 ✅ 已实测（`../pi-desktop-ark/entry/src/main/module.json5:65` + `:162`） |
| **FR-007-008** | **语义化版本 + 版本矩阵**：库版本遵守 semver；「`node-bridge` 版本 ↔ `libnode` 版本」矩阵必须固化在**文件**里（含 SHA-256、SONAME、门禁结果、真机验证记录），README 呈现摘要 | ⚠️ **部分**：`runtime.lock.json` 已含 libnode 侧全字段（版本 24.2.0 / SHA-256 / SONAME `libnode.so.137` / 7 项门禁 / `verifiedOn`+`verifiedDevice`）；**缺 `node-bridge` 版本侧的映射字段**（锁文件里没有任何 bridge 版本），且 HAR 未导出 `HAR_VERSION`，第三方无法在运行期/包内自证版本 |
| **FR-007-009** | **兼容矩阵可查**：`node-bridge vX.Y` × `libnode 22.19+/24.x` × `API 17+/24/26` × `deviceTypes 2in1/tablet` 必须以**可机读或可断言**的形式发布（不能只活在规划文档的表格里） | ⬜ **未落地**：口径在规划 §7.5；包内 `module.json` 只体现 `deviceTypes`（`2in1`/`tablet`）与 `compatibleSdkVersion: 17`（实测），**没有**独立矩阵文件 |
| **FR-007-010** | **许可齐备**：库自身 MIT 明确；随包分发 Node 运行时（若消费方一同分发）必须给出第三方许可清单（Node.js MIT + V8/OpenSSL 等），并用**来源 + SHA-256** 把清单锚到具体产物（G4 / §4.8 / §9.5） | ⚠️ **缺口**：仓库只有根 `LICENSE`（MIT）+ `runtime.lock.json` 的 `source.license` 字段；**没有独立的第三方许可清单文件**，也没有进 HAR。必须补齐（`plan.md` §9 第 1 项） |
| **FR-007-011** | **接入步骤可复现（三步）**：① 加依赖 ② 投放运行时 ③ 按自己包名声明 ACL；每步有**可复制命令**与**成功判据**；且**构建前必须校验运行时**（`provision --check` 可进 CI） | ✅ 三步已文档化（`library/README.md:27-33`、根 `README.md:52-57`）；`node tools/provision.mjs --check` 本机实测**七项门禁全过**（退出码 0）；⬜ CI 脚本未落地 |
| **FR-007-012** | **发布物不得含绕行实现**：路线 J′（绕平台代码签名 / 可执行内存控制）的任何实现、代码、注释、构建脚本**不得**进入 HAR / HAP / 发布分支（G11 / R23） | ✅ 现无此类实现（`tools/ohos-selfsign.mjs` 只服务「独立分发补 `.codesign`」，不参与 App 内加载路径，`provision --sign` 亦仅此用途）；需保留**可执行审计判据**（关键词检索 + 目录物理隔离），见 `plan.md` §2 G11 |
| **FR-007-013** | **样例只用于验证库**：`samples/` 不得被 `library/` 依赖；样例不得引入应用语义（C1）；样例的失败不得作为库不可用的判据 | ⬜ **未落地**：`samples/` 只有 `README.md`（`samples/minimal-app`、`samples/arkweb-http` 仅规划，§7.2）；✅ 「不被依赖」现状成立（库只依赖平台 Kit） |
| **FR-007-014** | **包内不得含第三方浏览器内核**（G3）：HAR/HAP 的库侧内容只有引导件 + 运行时 + JS 载荷 | ✅ 实测：HAR 内无任何内核类文件；库侧 HAP 增量仅 3 枚 `.so`（`plan.md` §4.1） |
| **FR-007-015** | **包元数据自证**：`oh-package.json5` 的 `name`/`version`/`description`/`author`/`license`/`keywords` 齐备；`module.json5` 的 `type: "har"` 与 `deviceTypes` 明确；**刻意不写** `module.json5` 的 `description`（避免 HAR 与消费方资源合并时的**资源名重名告警**），HAR 用途说明只放 `oh-package.json5` 与 README | ✅ 全部落地（`library/oh-package.json5`；`module.json5:3-11` 含「刻意不写」的原因注释）；实测发布版 `module.json` 确无 `description` |
| **FR-007-016** | **接入形态二选一且失败可判**：① `file:` **构建出的 `.har`**（跨工程首选）；② 源目录 `file:../ohos-node-bridge/library`（同工程/未开 `useNormalizedOHMUrl` 时可用）。`useNormalizedOHMUrl: true` 的工程**必须**用 `.har`，否则 hvigor 报 `00309001` | ✅ 消费方实测：`useNormalizedOHMUrl: true` 下相对路径导入外部模块源码被拒 ⇒ 改为 `.har`（`../pi-desktop-ark/oh-package.json5:9-12`、`scripts/build-bridge-har.sh:4-11`、其 `docs/000-工程规划.md:516`） |
| **FR-007-017** | **消费方打包口径必须文件化并可核对**：HAP 内原生库压缩与符号保留口径（module 级 `compressNativeLibs` + `extractNativeLibs`；release 保留 native 符号）写进接入文档，并给出**查 HAP 而不查磁盘**的核对命令与期望值 | ⚠️ **缺口**：口径只在规划 §5.9 / §5.10 ⑬；实测消费方已签名 HAP 中 3 枚 `.so` 的 `compress_type = 0`（**未压缩**，HAP ≈129 MB），与附录 C 的「库侧压后 ≈44 MB」预算不一致。库侧必须把「怎么写、怎么核」写成契约（`plan.md` §5.2 / §9 第 8 项） |

---

## 4. 关键实体

| 实体 | 定义 | 载体（真实路径） | 现状 |
|---|---|---|---|
| **HAR 包** | 发布到 ohpm 的单元：已编译 ArkTS（`modules.abc`）+ 类型声明（`.d.ets`）+ 引导件 `.so` + README | `library/build/default/outputs/default/library.har`（实测 441,353 B） | ✅ 可构建 |
| **barrel 导出项** | 对外唯一出口上的符号；未登记即非公共 API | `library/Index.ets`（8 个符号） | ✅ 已登记 |
| **锁文件** | 运行时唯一事实源：版本 / SHA-256 / SONAME / 门禁 / 来源 / 许可 / 真机验证 / openItems | `runtime.lock.json`（64 行） | ✅ 入库；⬜ 未随 HAR |
| **版本矩阵** | `node-bridge` 版本 ↔ `libnode` 版本 ↔ SONAME 的映射 | 应在锁文件内（§7.5） | ⚠️ 只有 libnode 侧，无 bridge 侧字段 |
| **兼容矩阵** | bridge × libnode × API × deviceTypes 的可断言组合 | 规划 §7.5（表格）；包内仅 `module.json` 的 `deviceTypes`/`compatibleSdkVersion` | ⬜ 无独立文件 |
| **许可清单** | 库 MIT + 第三方（Node.js MIT、V8/OpenSSL 等）+ 来源与 SHA-256 | 应随包（G4） | ⬜ 缺文件 |
| **消费方接入记录** | 「谁用什么形态接进来、投了什么版本、验过什么」的可复核证据 | 消费方仓库：`../pi-desktop-ark/oh-package.json5`、`scripts/provision-runtime.sh`、`scripts/build-bridge-har.sh`；本仓库 `tests/README.md` 判据 | ✅ 已有一手记录（含 HAP 内 SHA 核对） |

---

## 5. 验收场景

> 全部可证伪。`现状` 标明该场景**今天是否已满足**（未满足者进 `plan.md` §9 交付物清单）。

### AC-007-01 第三方按三步接入成功
**Given** 一台干净机器（只有 CLT + Node ≥18）、一个开了 `useNormalizedOHMUrl` 的应用工程；
**When** ① 加依赖 `"@fellow99/node-bridge": "file:./libs/@fellow99/node-bridge.har"` → ② `node ohos-node-bridge/tools/provision.mjs --out entry/libs/arm64-v8a` → ③ 在自己的 `module.json5` 按自己包名声明 ACL，然后 `hvigorw assembleHap`；
**Then** 构建成功，且 HAP 内 `libs/arm64-v8a/` 同时存在 `libnode.so`（SHA-256 = 锁值 `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1`）与 `libnode_bridge.so`。**现状** ✅（消费方已实测通过）。

### AC-007-02 HAR 里没有 `libnode.so`
**Given** `assembleHar` 产物；
**When** 枚举包内条目并检索体积 > 1 MB 的文件；
**Then** 无 `libnode.so`，最大条目是 `libc++_shared.so`（1,262,504 B，来自 ohos-sdk）。**现状** ✅（实测 27 条目全清单，见 `plan.md` §4.1）。

### AC-007-03 HAR 里有引导件 `.so`
**Given** 同一产物；
**When** 查 `libs/arm64-v8a/`；
**Then** 有 `libnode_bridge.so`（≈14 KB 量级）与 `libc++_shared.so`，且 `Index.d.ets` 作为类型入口存在。**现状** ✅（14,208 B / 1,104 B）。

### AC-007-04 权限不足时消费方 `module.json5` 的 ACL 成对声明
**Given** 消费方应用（包名 `org.fellow99.pi.PiDesktopArk`，与库不同）；
**When** 只在库侧声明需求、未在自己的 `module.json5` 里 `requestPermissions` + `definePermissions` 成对出现该 ACL；
**Then** ① 装机即被拒（`code:9568289`，§9.4 已踩过的坑）；② 成对声明且 Profile 含 ACL 后装机成功、JIT 生效（`wasm.validate === true`）。**现状** ✅（消费方实测；库侧只留 2 项开放权限）。

### AC-007-05 版本不满足 `>= 22.19.0` 时可见告警
**Given** 本地运行时目录放着一个版本过低的 `libnode`；
**When** 跑 `node tools/provision.mjs --check`（或投放）；
**Then** 门禁第 ⑦ 项（版本 ≥ 22.19）**硬失败**并 `exit 2`，输出明确原因，**不静默继续**（C2）。**现状** ✅（门禁已实现且本机实测全过；`runtime.lock.json:41` 记录 `versionGeq2219`）。

### AC-007-06 包内无 Chromium（G3）
**Given** HAR 与库侧 HAP 增量；
**When** 按内容清单逐项核对；
**Then** 只有引导件 + 运行时 + ArkTS 字节码 + README，无任何浏览器内核文件。**现状** ✅。

### AC-007-07 G11 绕行实现不在发布物里
**Given** 发布分支与发布产物；
**When** 对 HAR/HAP 与 `library/` 全树检索关键词（`wxjit`、`LD_PRELOAD`、`mremap`、`preadv`、`fake_codesign`、`selfsign` 相关符号）并核对目录隔离；
**Then** 0 命中；`tools/ohos-selfsign.mjs` 仅出现在仓库工具目录（不随包）、且其用途仅「独立分发补 `.codesign`」。**现状** ✅（需固化为可执行审计，见 `plan.md` §2 G11 行）。

### AC-007-08 `file:` 源目录在同一 `useNormalizedOHMUrl` 工程下被拒而 `.har` 可用
**Given** 消费方工程 `useNormalizedOHMUrl: true`；
**When** 依赖写 `file:../ohos-node-bridge/library`（源目录）并构建；
**Then** hvigor 报 `00309001 Cannot import files from an external module using relative paths`；改为 `.har` 后构建通过。**现状** ✅（消费方实测；`../pi-desktop-ark/scripts/build-bridge-har.sh:4-11`）。

### AC-007-09 包内「怎么拿运行时」可闭合
**Given** 只有 ohpm（或只有 `.har` 文件）的第三方；
**When** 按包内线索执行获取 + 校验；
**Then** 能读到锁定版本 + SHA-256 + 门禁结论 + 投放用法（含获取出路），并能在**不读本仓库源码**的前提下完成投放与校验。**现状** ⬜（当前线索只在 GitHub 仓库文本；包内既无锁文件也无 `payload/`）。

### AC-007-10 许可清单随包
**Given** HAR/HAP 发布物；
**When** 检查第三方许可清单；
**Then** 清单存在、覆盖 Node.js（MIT）与 V8/OpenSSL 等运行时内嵌组件、并用来源 + SHA-256 锚到 `runtime.lock.json` 的锁定项。**现状** ⬜（G4 缺口）。

### AC-007-11 运行时版本可替换而不改库代码
**Given** 需要从 `v24.2.0` 换到另一满足 `>=22.19` 的产物；
**When** 只改 `runtime.lock.json` 的 `active` + `runtimes[]`，重跑 `provision --check` + 真机回归；
**Then** 库的 ArkTS/C++ 代码 **0 行改动**，HAR 重新 `assembleHar` 后仍可用（引导件不链接 `libnode.so`，S7）。**现状** ✅（结构上成立：`CMakeLists.txt:13-16`；`runtime.lock.json:59-63` 记录 openItems）。

### AC-007-12 打包口径可核对（压缩与符号）
**Given** 消费方构建的 HAP；
**When** 用「查 HAP 不查磁盘」的命令枚举 `.so` 的 `compress_type`（以及 release 构建的 native 符号保留）；
**Then** 期望 `compress_type = 8`（DEFLATE）且 release 保留 native 符号以支持崩溃取证。**现状** ⚠️ 实测为 `compress_type = 0`（未压缩，HAP ≈129 MB）——口径未落地，必须回填到接入文档 + 加断言。

### AC-007-13 样例可作为库的独立验证入口
**Given** 第三方只想自证「库能跑」；
**When** 构建 `samples/minimal-app`（一个 Ability + 按钮 + 日志面板）；
**Then** 出 HAP、装机、点按钮起 Node、日志面板可见；样例不依赖任何应用语义。**现状** ⬜（`samples/` 只有 README）。

---

## 6. 非功能需求

| # | 需求 | 判据 / 现状 |
|---|---|---|
| NFR-1 | **包体积**：HAR 保持在 **≈441 KB 量级**（不含 `libnode.so`） | ✅ 实测 441,353 B（≈431 KiB）；预算见附录 C |
| NFR-2 | **HAP 内库侧增量**：`libnode.so` 压缩后 ≈43 MB，库侧合计 ≈44 MB | ⚠️ 当前消费方 HAP 未压缩 ⇒ 实际 ≈121 MB；压缩口径未落地（AC-007-12） |
| NFR-3 | **可 diff**：版本、哈希、门禁、验证记录都是文本，换版本产生的差异一眼可见 | ✅ `runtime.lock.json`（64 行，入库）；HAR 为二进制产物，不作为审计载体 |
| NFR-4 | **可审计**：任何随包二进制能说出「来源 + SHA-256 + 许可 + 验过没有（时间/设备）」 | ✅ 锁文件含 `source`/`sha256`/`gates`/`verifiedOn`/`verifiedDevice`/`verifiedNotes`；⬜ 许可清单文件缺失 |
| NFR-5 | **向后兼容策略**：类型或导出面改动必须提版本（semver）；`0.x` 阶段允许 minor 破坏但**必须**在 README 与 `plan.md` 里写明迁移 | ✅ 宪法 §六 1 规定；`Types.ets:1-5` 已声明契约地位 |
| NFR-6 | **离线可构建**：库自身构建不依赖远端包（无 `dependencies`） | ✅ 根 `oh-package.json5:4-7`（刻意留空）+ `library/oh-package.json5:15`（空 `dependencies`） |
| NFR-7 | **工具链固定**：DevEco/CLT、hvigor、ArkTS、SDK 版本写进文档，避免「他机编译不崩、本机崩」（R16） | ✅ 实测并登记：ohpm `6.1.2.285`、hvigor `6.24.4`、`modelVersion 6.1.1`、`compileSdkVersion 6.1.1.125`、SDK 根 `D:\oh-workspace\command-line-tools\sdk`（详见 `plan.md` §1.1） |
| NFR-8 | **失败可见**：发布物不得让「拿不到运行时」变成静默降级（C2）；获取工具必须给出三条明确出路 | ✅ `provision.mjs` 硬失败 `exit 2` + `--from`/`--download`/本地目录；`--check` 可进 CI |

---

## 7. 假设与约束

| # | 假设 / 约束 | 依据 |
|---|---|---|
| A1 | 二进制**不入 git**：`libnode.so` 120.9 MiB > GitHub 单文件 **100 MiB 硬限**；用 LFS 会把 clone 变成联网重操作 | 附录 G.1 |
| A2 | **没有可用制品库**（本工程与消费方都没有）；运行时可放父工程本地目录 `<父工程>/ohos-node-runtime/` | 附录 G（决策 2026-10-16） |
| A3 | 消费方**可能用不同 `libnode` 版本 / 不同签名策略**（自建、镜像、自签），因此 HAR 不能绑死某个二进制 | 附录 G.8 ②、§G.6 三条演进路线 |
| A4 | **HAP 内原生库不需要 `.codesign`**（已实测），`provision --sign` 只服务「脱离 HAP 的独立分发」 | §D.6 / §D.9 / G5 |
| A5 | **不做 phone、不做 x86_64**（只用真机调试）：`deviceTypes` 只 `2in1`/`tablet` | §G 决策 + `module.json5:5-8` |
| A6 | **JIT 依赖受限 ACL**，无 ACL 时不带 `--jitless` 即 SIGTRAP；`--jitless` 会关掉 WebAssembly | §D.8 / §9.4 / C2 |
| A7 | 库**不参与渲染**、不含应用语义；`samples/` 不被库依赖；库不认识 `pi`/`pi-web`/Next | §0.3 / §7.2 / C1 |
| A8 | ohpm 组织/scope（`@fellow99`）归属**待人工确认**，故「ohpm 首发」属 Phase 3，期间以 `.har` + `file:` 依赖交付 | §9.3 第 1 项 / §8 Phase 3 |
| A9 | 第三方拿运行时的公开镜像 Release **尚未建立**（无制品库） ⇒ 现阶段第三方按 `source.url` 自取 + SHA-256 校验 | `runtime.lock.json:59-63` openItems / §G.6 路线 B |
| A10 | 库侧不给「重启 Node」「绕行」这类看似省事的承诺：进程内 `node::Start` 每进程一次，崩溃是终态 | C5 / §0.3 / 风险 R9 |

---

## 8. 依赖

| 方向 | 依赖对象 | 说明 |
|---|---|---|
| **上游（必须已实现）** | `001-runtime-core`、`002-napi-bootstrap`、`003-host-bridge`、`004-payload-bootstrap`、`005-provision-verify`、`006-observability` 的实现 | 发布物是它们的**封装面**：导出面来自 `001`/`003`/`006`，引导件来自 `002`，载荷来自 `004`，锁文件与投放工具来自 `005`。任何其一未落地，本模块的验收场景只能部分闭合（如 AC-007-13 样例） |
| **上游（事实源）** | `runtime.lock.json` | 版本 / SHA-256 / 门禁 / 许可 / 真机验证的唯一事实源；本模块只**引用**，不复制（宪法 §六 3） |
| **上游（治理）** | `specs/constitution.md`、`docs/000-工程规划.md` | 原则与结论的权威；冲突以规划为准，本规格只引用 § 号 |
| **下游（消费方）** | `pi-desktop-ark`（在册消费方）：`oh-package.json5`、`scripts/build-bridge-har.sh`、`scripts/provision-runtime.sh` | 本模块的**真实接入形态**由它定义：`.har` 依赖 + 运行时投放脚本 + 按自己包名申报 ACL |
| **下游（第三方）** | 任何 ohpm 使用者 | 本模块的验收判据必须能在「只有 ohpm + 公开网络 + 自己的工程」的条件下闭合（AC-007-09 是当前最大缺口） |
| **构建期外部依赖** | ohos-sdk（`libc++_shared.so`、llvm-19 工具链）、CLT hvigor/ohpm、host Node ≥ 18 | `runtime.lock.json:48-53`（libcxx 来源规则：从 SDK 取，**不固化哈希**，随 SDK 版本变化）；`provision.mjs` 需要 host Node |
