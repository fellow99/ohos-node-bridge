# TECH.md —— `ohos-node-bridge` 技术选型（as-built + 决策）

> **性质**：项目级技术选型规格。回答「用了什么、什么版本、为什么、**否掉了什么**」。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10 / G3/G4/G5/G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）· 本仓库文件 ✅实测。
> **标记**：✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突或风险。**「选定」一律给理由，「否掉」一律给替代方案**。
>
> ⚠️ **引用基准**：源文件行号取自 **2026-10-16 成稿快照**（`node_bridge.c` 295 行 / ArkTS 侧 5 个文件共 328 行）；此后 `cpp/` 与 `ets/` 均有**并行实现**推进（当前 `node_bridge.c` 已 >760 行）⇒ **以函数名 / 类名为准**。
> **版本**：v1.0 · 2026-10-16。

---

## 1. 选型总表

| 类别 | 技术/版本 | 用途 | 选型理由 |
|---|---|---|---|
| **宿主语言（库）** | ArkTS / ArkUI（stage 模型，HAR 组件库） | 对外 API、状态机、路径装配、日志、桥的 ArkTS 半 | 库的消费者就是 ArkTS 应用，非 ArkTS 无法「零 C++ 接入」；HAR 是 ohpm 的组件库形态（规划 §7.5）；严格模式禁 `any/unknown`（S1，`arkts-no-any-unknown` 症状见表 #13） |
| **类型契约** | `.ets` 声明 + `cpp/types/*/index.d.ts` 环境声明 | 原生模块只经 `.d.ts` 接入；`Types.ets` 即对外契约 | S1/S3；`.so` 由 hvigor 的 CMake+ProcessLibs 流程产出，用「裸名 import + .d.ts」是唯一不触发 `arkts-no-any-unknown` 的接法（规划 §7.2 / 症状 #13） |
| **IDE / 构建** | DevEco Studio 6.1 + hvigor（CLT 的 `hvigorw.bat`）+ `@ohos/hvigor-ohos-plugin` | 构建 HAR / HAP；native 交叉编译；签名注入 | 官方唯一支持的构建链（无 hvigor 无法产出合法 HAR/HAP）；本仓库实测可用命令行构建，无需 GUI ✅；`hvigorfile.ts` 把签名材料抽成 env → 本地文件 → 未签名包三级（仓库不落密钥） |
| **SDK** | `ohos-sdk`（CLT SDK；工程内声明 `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)`）⚠️ | 提供 `libace_napi.z.so`、`libhilog_ndk.z.so`、LLVM 交叉工具链、`libc++_shared.so` | 与真机基线 HAD-W24 / 7.0.0.107(SP7C00E100R13P5) / OpenHarmony-7.0.0.105 / **API 26** 同代（规划 §D.8）；⚠️ **工程 targetSdkVersion 是 6.1.1(24)**，比基线设备 API 26 低一档 ⇒ 见 §5 风险 |
| **原生接口层** | NAPI（`libace_napi.z.so`，`napi_module_register` / `napi_property_descriptor` 直用 C API） | ArkTS ↔ C 的唯一通道（初版 `start`/`isRunning`/`version`；Phase 1 扩为 **5 个**，增加 `lastError`/`stage`，`start()` 增加第 6 参 `envPairs`） | 引导件**只**依赖 NAPI 与 hilog；NAPI 是 ArkTS NativeModule 的官方 ABI；S8 的口径是「C 侧接口保持极窄，扩展必须**同时**改 `.d.ts`」（扩展后 `index.d.ts` 已同步更新） |
| **原生语言/构建** | C11 + CMake **3.5.0**（`cmake_minimum_required(VERSION 3.5.0)`，实测工具链 CMake 3.28.2 ✅） | 引导件 `libnode_bridge.so`（SHARED） | C11 而非 C++：引导件不需要 C++ 运行时，避免与 `libc++_shared.so` 版本纠缠；`3.5.0` 是 hvigor 模板下最保守的下限（写高版本会被旧工具链拒）；S6 要求显式设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` → `<module>/libs/${OHOS_ARCH}` |
| **运行时** | Node.js **v24.2.0**（`libnode.so`，`electerm/ohos-node-shared` 产物） | 应用进程内的 Node 运行时 | ① 真共享库（`ET_DYN`、**`PT_INTERP=0`**）⇒ 唯一能 `dlopen` 进 App 进程的形态（硬约束 ①）；② 内嵌 ICU 与 V8 快照（`icudtl.dat`/`snapshot_blob.bin` 零命中）⇒ HAP 只需 2 个 `.so`；③ 满足消费方 `engines >= 22.19.0`；④ `--expose-internals` flag 已编译进产物（字符串命中 9 处）⇒ 「零原生模块移植」路线可用；⑤ 与 🔶 notes 真机验证过的版本同为 24.2.0（规划 §D.4 候选表 / §5.8） |
| **运行时锁定值** | 大小 `126,809,264 B` / SHA-256 `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` / SONAME `libnode.so.137` / `modules=137` | 供应链可自证 | `runtime.lock.json` 是**唯一事实源**（S10：二进制不入库）；`137` = `NODE_MODULE_VERSION`，决定原生 addon ABI（规划 §D.4） |
| **C++ 运行时** | `libc++_shared.so`（**从 ohos-sdk 取**，`native/llvm/lib/aarch64-linux-ohos/libc++_shared.so`，1,262,504 B） | 满足 `libnode.so` 的 `DT_NEEDED` | 硬约束 ②：缺它 `dlopen` **静默失败**，ArkTS 侧只拿到 `undefined`；**不固化哈希**（随 SDK 版本变化）⇒ `runtime.lock.json` 只记来源规则（`libcxx.sdkRelPath`） |
| **ELF 校验（host）** | 纯 JS 自解析（`provision.mjs`）+ 纯 Python 自解析（`elf-inspect.py`），**不依赖 llvm/python 包** | 七项门禁 / 六项排障 / CI | 门禁要在任何机器上跑得动（CI 未必有 `llvm-readelf`）；两套实现同口径互为交叉验证（规划 §5.8 / §7.4） |
| **自签（host）** | 纯 SHA-256 Merkle（4K 页）+ fs-verity descriptor，`ElfSignInfo(8)+descriptor(256)+SHA256(32)=296 B` 填 4096 B 段，**无私钥无证书** | `--sign`（只服务**脱离 HAP 独立分发**） | 算法逆向自 `binary-sign-tool -selfSign 1` 且与真实已签产物逐字节互验（`verify` 十项 PASS / `selftest` IDENTICAL）；不需要 Java 与 SDK 二进制（规划 §D.4/§D.5）；G5：HAP 内原生库**不需要** `.codesign`（§D.6/§D.9 实测） |
| **日志** | hilog（`libhilog_ndk.z.so` + ArkTS `@kit.PerformanceAnalysisKit`，DOMAIN `0xD0033` / TAG `NODE_BRIDGE`）+ **文件日志**（`<filesDir>/payload/node.log`） | 诊断与崩溃取证 | 单一通道不够：沙箱日志 `hdc` 读不到（§三纪律 2），hilog 又「应用侧 INFO 常不入 dump 缓冲」（症状 #17）⇒ **双通道**（S9）；C 侧信号上下文只允许裸 `open/write/close`；ArkTS 侧 `Logger.tail()` 提供读回（C3） |
| **真机自检协议** | `node:http` + `/facts`（JSON）+ `/log`（文本尾 8 KB），`hdc fport` + `curl` | 端到端证书 | 「这条 JSON 就是一次真机成功运行的证书」；比 hilog grep 与 `VmSize` 强得多（§5.7 禁止的判据） |
| **目标设备** | `deviceTypes: ["2in1","tablet"]`，**只做 arm64-v8a** | 目标平台 | 与平台约束一致：`ALLOW_WRITABLE_CODE_MEMORY` 仅**平板 + 2in1**，`system_basic` / API 14+（规划 §9.4）；`abiFilters: ["arm64-v8a"]`（模块级 build-profile）；**明确不做 phone**（§0.3/§1 表）；x86_64 决策不做（`openItems[2]`） |
| **权限（库声明面）** | `ohos.permission.INTERNET` + `ohos.permission.GET_NETWORK_INFO` | 库自己确实需要的开放权限 | 「按需最小化」，不照抄旧壳 21 条（§9.4）；⚠️ ACL（JIT 必需）**由消费方按自己包名申请**——与规划 §9.4「库成对声明」的写法不同，见 §5 |
| **许可** | 本库 **MIT**（`LICENSE`，Copyright 2026 fellow99）；随包分发的 Node 运行时适用上游许可 | 合规交付物 | 红线 G4：**第三方许可清单必须随包**（Node.js MIT + V8/OpenSSL 等），来源与 SHA-256 已固化在 `runtime.lock.json`（`source.license` + `sha256`）；⚠️ 目前**尚无随包的许可清单文件**（交付物缺口，Phase 2/3） |
| **Node 侧工具链语言** | 纯 JS/`.mjs`（Node 24 内置 `fetch`/`crypto`/`child_process`），`.py` 仅用于排障检查器 | `provision.mjs` / `ohos-selfsign.mjs` / `elf-inspect.py` | 「一个 `node` 就能跑」⇒ CI 与消费方机器零依赖；`fetch` 不引第 3 方 HTTP 库（代价：代理需 `NODE_USE_ENV_PROXY=1`，已实测并在失败时打印正确命令） |
| **包管理/发布** | ohpm（`@fellow99/node-bridge` HAR）；锁文件 + 投放工具另行随仓库分发 | 分发 | HAR 不带 120 MB 二进制（附录 G.8）；消费方构建期跑一次投放（与旧壳从版本目录取运行时同构） |

---

## 2. 被**否掉**的选型及替代方案

| 被否对象 | 否掉理由（一手依据） | 替代方案（现状） |
|---|---|---|
| **Electron / Chromium**（`libelectron.so` 181 MB） | ① 上架合规：同型工程被 AppGallery 以「渲染打开网页时未使用 ArkWeb 组件」**P0 驳回**；② 包内浏览器内核触碰 G3；③ 换来的只是「渲染一个本地页面」（规划 §2.1/§4.8） | 本库只跑 Node，**不参与渲染**；渲染交宿主 ArkWeb（C1 / §5.1） |
| **子进程形态**（`childProcessManager` / spawn 一个 node 可执行文件） | `801` 平台不支持（🔶）；`spawn` 事件语义历史上有两份互斥证据；先例实测 app 子进程内 `execve` **全 EACCES**（§4.4/§4.5/§5.10 ⑯）；且「崩了能重启」这个唯一卖点被 `node::Start` 一进程一次的语义从根上废掉 | 进程内 `dlopen` + `node::Start`（路线 J）；崩溃=终态 → UX 契约 + 崩溃取证（C5/C6） |
| **`--jitless` 作为产品路径**（路线 I） | `--jitless` **关闭 WebAssembly**：`WebAssembly is not defined`、`fetch` 直接失败；首个在册负载（Next 的 WASM SWC、undici 的 llhttp WASM）会**直接废掉**；性能代价量化 ~9×（热循环 299 ms/5 轮 vs JIT 6–9 ms/2e6）（§4.7/§D.8/§D.10） | **路线 J（JIT）**：`ALLOW_WRITABLE_CODE_MEMORY` 是刚性前置 ACL，视为可得；`--jitless` **仅作诊断开关**（C4/§5.3）；路线 I 降为「ACL 被拒时的触发式备选」且改造项属消费方载荷 |
| **PIE 形态产物**（`PT_INTERP != 0`） | `dlopen` 成功但 V8 在首次堆分配即崩（TLS 别名），症状极易误判（硬约束 ① / 症状 #1）；`hqzing/ohos-node` 的产物正是 PIE（`PT_INTERP=1`，无 SONAME，且不发共享库） | 把「`PT_INTERP` 计数 = 0」做成**硬失败门禁**（`provision.mjs` 门禁 ② / `elf-inspect.py` VERDICT）；不合格就换产物（R2） |
| **自建 `libnode.so`（v1 主线）** | 数小时级交叉编译（首次拉 OHOS SDK + LLVM-19 约 3 GB、`make -j2` 防 OOM）+ V8 release 补丁 + 版本补丁；**不应阻塞链路可行性**（规划 §0.3/§5.8/附录 D/§G.5） | **延后到 Phase 3**，配方归档在附录 D，`tools/rt-build/` 未落地 ⬜；库只依赖 ELF 属性与 `node::Start` 符号，产物可随时替换（C7） |
| **HAR 携带 `libnode.so`** | ① 120 MB 二进制进 ohpm 包 ⇒ 每个使用者都被迫下载；② 各消费方可能需要不同版本/签名策略；③ 二进制走 Release / 本地目录比走包管理器合适；④ GitHub 单文件 100 MiB 硬限使「入库」也不可能（§7.5 / 附录 G.5/G.8） | HAR 只带引导件（+ 实测还带了 `libc++_shared.so`，见 STRUCTURE §8.1）+ 投放工具；消费方跑 `provision.mjs`（`runtime.lock.json` 锁版本与哈希） |
| **制品库**（Nexus / OSS / 私有 registry） | 本工程与消费方都没有现成制品库；为一枚可校验的 `.so` 引入一套服务，运维成本 > 收益（附录 G.5） | 仓库内运行时缓存 `runtime/`（仅 `*.so` 不入库，`OHOS_NODE_RUNTIME_DIR` 可覆盖；2026-10-18 自父工程 `../ohos-node-runtime/` 迁入）+ 三级来源优先级 + 公开镜像 Release 待建（`openItems[0]` ⬜） |
| **git submodule / 直接 commit 二进制** | submodule 指向上游构建仓库拿到的只是脚本（上游不动二进制）；直接 commit 撞 GitHub 100 MiB 单文件硬限，LFS 会把 clone 变成必须联网的重操作（附录 G.5） | 锁文件入库 + 二进制不入库（S10） |
| **路线 J′（无 ACL 拿可执行内存：预签名 ELF 模板 + `mprotect` 翻转 + `mremap`）** | 属**对平台代码签名控制的绕行**，红线 G11：**不得进入发布物**；且 App 域是否成立未验证（P0-15 不立项，因 ACL 已获批）（§4.7 / 附录 D）。**其自签算法**被单独合法复用（`ohos-selfsign.mjs`） | 主线走路线 J（ACL）；J′ 只允许存在于设计文档与本机 PoC，与发布分支物理隔离 |
| **`llvm-objcopy --add-section .codesign=…`** | 实测落成 `sh_addralign=1`、偏移非页对齐（`0x78eedb5`）⇒ 不满足形态要求（§D.5） | 自实现 `ohos-selfsign.mjs add-section`：页对齐 4096 B 全零段 + 重建段表 + 扩 shstrtab，**原字节一字不动**（产出与真实已签产物形态一致） |
| **`llvm-strip` 二次裁剪 `libnode.so`** | Node 官方产物**已 strip**（无 `.symtab`，`.dynsym` 115,182 条）⇒ 收益 0（§5.9） | **不做**；仅自建路线在 `llvm-strip` 之后自签 |
| **`compressNativeLibs` 写在 `build-profile.json5`** | schema 会拒且不告诉你正确位置（症状 #11；🔶 notes §7） | 写在 **`module.json5` 的 module 级** ⬜ **当前未落**（见 §5）——体积复核必须**查 HAP 的 `compress_type==8`**，不查磁盘 |
| **在 `library/` 内写应用语义**（pi / Next / 鉴权 / 窗口） | 触碰 C1 一票否决；R15「库 API 面膨胀」 | 六个 API 面 + 消费方自建；判定口径「这一条是不是宿主语义？」 |
| **`systemPreferences.callArkTSFunction`**（旧壳桥） | 只支持「取一个偏好值」，≤3 参、仅原始类型，不是能力调用（§2.2/§5.3） | 自建 **JSON 字符串**载体的桥（不受参数个数/类型限制），明确超时（默认 10 s）与 `capBytes` 上限 ⬜ 未实现（Phase 2） |
| **运行期改 `execArgv` / 进程内重启 Node** | 平台语义封死（`node.cc` `limit_called.exchange(true)`），假装恢复会误导用户（C4/C5、硬约束 ⑥） | `flags` 一次性输入；失败态只允许「读日志 / 读崩溃记录 / 提示重启应用」 |

---

## 3. 版本矩阵与兼容口径

| 维度 | 值 | 来源 |
|---|---|---|
| 库版本 | `@fellow99/node-bridge` **0.1.0**（骨架） | `library/oh-package.json5:3` ✅ |
| 引导件版本串 | `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`（Phase 0 骨架期为 `node_bridge/0.1.0`） | `js_version()` ✅ |
| 运行时版本 | Node **v24.2.0**（`active.node`） | `runtime.lock.json:3` ✅ |
| NODE_MODULE_VERSION | **137**（= `SONAME` 尾号 `libnode.so.137`） | `runtime.lock.json:7,13` ✅ |
| 运行时 ABI | `arm64-v8a` | `runtime.lock.json:8` ✅ |
| 引擎下限 | `process.version >= 22.19.0`（低于则启动即 warn，不静默） | 规划 §5.8；⬜ 当前未实现该 warn |
| 工程 SDK | `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)` / `runtimeOS HarmonyOS` | `build-profile.json5` ✅ |
| 样例 App | `minAPIVersion 17` / `targetAPIVersion 24` | `AppScope/app.json5` ✅ |
| 真机基线 | **HAD-W24 / 7.0.0.107(SP7C00E100R13P5) / API 26 / OpenHarmony-7.0.0.105 / arm64-v8a** | `runtime.lock.json:44` ✅ + §D.8/§D.9/§D.10 |
| 兼容矩阵（规划口径） | `node-bridge vX.Y` × `libnode 22.19+/24.x` × `API 17+/24/26` × `deviceTypes 2in1/tablet` | 规划 §7.5 |

---

## 4. 依赖清单（运行时 / 构建期）

| 依赖 | 谁提供 | 何时需要 | 缺失后果 |
|---|---|---|---|
| `libace_napi.z.so` | ohos-sdk（系统库） | 构建 + 运行 | 引导件链不上（`CMakeLists.txt:16`） |
| `libhilog_ndk.z.so` | ohos-sdk（系统库） | 构建 + 运行 | 同上 |
| `libnode.so` | **消费方**用 `provision.mjs` 投放 | 运行 | `dlopen` 失败 → 只写日志后 `return NULL`，ArkTS 侧仍显示 `starting` ⚠️（无结构化失败回报） |
| `libc++_shared.so` | 同上（`provision.mjs` 从 SDK 取） | 运行 | `dlopen` 失败（**静默**，硬约束 ②） |
| `libc.so` | 系统 | 运行 | — |
| Node.js（host 侧 ≥ 24） | 开发机 | 构建期 | `provision.mjs` / `ohos-selfsign.mjs` 跑不了（前者需内置 `fetch`） |
| Python 3 | 开发机 | 排障/CI | 仅 `elf-inspect.py` 不可用（`provision.mjs` 自带同口径实现，不影响门禁） |
| LLVM 交叉工具链 | ohos-sdk | 构建引导件 | 无引导件 |
| DevEco Studio 6.1 / hvigor | 开发机 | 构建 | 无 HAR/HAP |
| `@ohos/hvigor-ohos-plugin` | hvigor 内置 | 构建 | — |

> **库对 npm 的依赖为 0**：`library/oh-package.json5:15` `dependencies: {}`、根 `oh-package.json5` 全空 ⇒ **完全离线可构建** ✅（选型理由，非偶然）。

---

## 5. 选型层面的未决 / 风险（⚠️ / ⬜）

| # | 项 | 现状 | 处置建议 |
|---|---|---|---|
| 1 | 工程 `targetSdkVersion = 6.1.1(24)`，真机基线是 **API 26** | ⚠️ 文档口径常写「API 26」，工程配置是 API 24 / minAPI 17 | 明确两者不冲突（设备 API ≥ 工程 target 是允许的），但**规格文档必须写工程值 + 基线设备值两个数**，不要混用 |
| 2 | `module.json5` 的 `compressNativeLibs` / `extractNativeLibs` | ✅ **已落地（2026-10-17，B4/R2）**：消费方 `pi-desktop-ark/entry/src/main/module.json5` 在 module 级声明两者（库自身 HAR 不产 HAP，不声明）；实测签名 HAP **46,031,244 B**、三个 `.so` 全部 `compress_type=8`（此前 129,535,202 B / 全 0） | 保持：换消费方模块时须复查 HAP `compress_type==8` |
| 3 | 库声明 ACL 的方式与规划 §9.4 不同 | ⚠️ 规划写「库在 `module.json5` 里与 `requestPermissions`/`definePermissions` **成对声明**」；实现只声明 2 条开放权限，并把 ACL 明确留给消费方 | **以实现为准**（更符合 C1 与「按自己包名申请」）；需把规划 §9.4 的措辞与 `module.json5:13-15` 的注释对齐，否则后续评审会当成缺项 |
| 4 | 默认 `flags` 与规划草案不一致 | ✅ **已定案（2026-10-17，B5/R2，文档化偏差）**：实现默认 `flags = '--no-verify-heap'`（真机验证值、最小可用集；`NodeRuntime.ets`、`js_start()` 空值兜底）；`--expose-internals` **仅在载荷走 internal-module stub 路线时必需**，由消费方经 `flags`/`execArgv` 显式传入（库不静默追加，C4） | 保持；规划 §5.3 草案默认值已被取代 |
| 5 | `--inspect` 调试通道（B12/P0-9） | ⬜ 未实现；`flags` 可手工传入但不区分 buildMode | release 必须**强制**关闭（旧壳 R7：默认开启等于把宿主交出去）；建议在库侧按 `BuildProfile` 判定并拒绝 |
| 6 | 第三方许可清单（G4） | ⚠️ 交付物缺口：`LICENSE` 只有本库 MIT；Node/V8/OpenSSL 清单未随包 | Phase 2/3 交付物；可基于锁文件生成（`source.license` 已存在） |
| 7 | 供应链 | ⚠️ R8：来源现成（`electerm/ohos-node-shared`），无法复现的黑盒二进制进上架包 | 已登记：SHA-256 锁定 + `verifiedOn/verifiedDevice` + 配方归档（附录 D）；Phase 3 自建替换（§G.6 路线 C） |
| 8 | 公开镜像 Release | ⬜ `mirror.kind = null`（`openItems[0]`） | 第三方 ohpm 使用者暂时只能按 `source.url` 自取 + SHA-256 校验 |

---

## 6. 关键技术口径（实现必须对齐的硬数据）

### 6.1 七项 ELF 门禁（任一不过 = **硬失败**，`exit 2`）

| # | 判据 | 实测值 | 实现落点 |
|---|---|---|---|
| ① | `e_type == ET_DYN` | `3` ✅ | `provision.mjs:179` / `elf-inspect.py:156` |
| ② | **`PT_INTERP` 计数 == 0** | `0` ✅（PIE 直接拒） | `provision.mjs:180` / `elf-inspect.py:160` |
| ③ | `e_machine == AArch64` | `0xB7` ✅ | `provision.mjs:181` / `elf-inspect.py:158` |
| ④ | `DT_NEEDED` 含 `libc++_shared.so` | `[libc++_shared.so, libc.so]` ✅ | `provision.mjs:182` / `elf-inspect.py:150` |
| ⑤ | `node::Start`（`_ZN4node5StartEiPPc`）在 `.dynsym` **已定义且导出** | 命中 ✅（`GLOBAL FUNC`，size 856） | `provision.mjs:183,150-166` / `elf-inspect.py:151,162` |
| ⑥ | SHA-256 与锁文件一致 | `3019bf5f…51a1` ✅ | `provision.mjs:184,273,278-280` |
| ⑦ | 大小与锁文件一致 **且** 版本串存在 | `126,809,264 B` + `v24.2.0` ✅ | `provision.mjs:185,168` |

**附加（只打印，不判死）**：`.codesign` / `.note.ohos.ident` / `expose-internals` 字符串命中（`provision.mjs:191-193`）。

### 6.2 体积口径（库侧增量，附录 C）

| 条目 | 值 | 证据等级 |
|---|---|---|
| `libnode.so` 未压缩 | `126,809,264 B`（120.9 MiB） | ✅ `runtime.lock.json:11` |
| `libnode.so` DEFLATE 后 | **≈43 MB** | 🔶 第三方实测；⬜ 以真实签名 HAP 复核 |
| `libc++_shared.so` | `1,262,504 B`（≈1.2 MB） | ✅ HAR 实测 |
| `libnode_bridge.so` | **14,208 B**（≈14 KB） | ✅ HAR 实测（HAR 内 `package/libs/arm64-v8a/libnode_bridge.so`） |
| `payload/*.js` + `selfcheck.js` | < 100 KB | 规划附录 C |
| **HAR 发布物** | **441,353 B**（≈431 KB） | ✅ 实测（`library/build/default/outputs/default/library.har`） |
| **库侧合计（进 HAP，DEFLATE 口径）** | **≈44 MB** | 规划附录 C（⚠️ 前提是 `compressNativeLibs` 落地，见 §5 第 2 项） |

### 6.3 性能与行为基线（真机实测，可与回归对比）

| 指标 | `--jitless`（路线 I） | 有 ACL（路线 J） | 出处 |
|---|---|---|---|
| `WebAssembly.validate` | `false`（`WebAssembly is not defined`） | **`true`** | §D.8 / §D.10 ✅ |
| 热循环 | **≈ 299 ms / 5 轮**（另一口径 ≈59 ms / 2e6） | **6–9 ms / 2e6** | §D.8 / §D.10 ✅ |
| 相对性能 | 基线（≈7–10× 慢） | 快 | §D.10 ✅ |
| `fetch` | 失败（`TypeError: fetch failed`） | 可用 | §D.8 ✅ |
| 无 ACL + 不带 `--jitless` | — | **启动即 SIGTRAP(sig=5) + Cpp Crash** | §D.8 ✅ |

### 6.4 运行时偏差（写代码时必须假设成立）

| 观测点 | 真机值 | 设计含义 |
|---|---|---|
| `dlopen` 路径 | **只有裸名 `libnode.so` 成功**；绝对路径全失败（HAP 内实际落 `/data/storage/el1/bundle/libs/arm64/`） | 引导件先试绝对路径、最后落裸名（`bootstrap()` 的 4 候选链） |
| `process.execPath` | `/system/bin/appspawn` | **不得**依赖它重新拉起 Node |
| `process.cwd()` | `/` | 一律绝对路径（S4） |
| `os.cpus()` | 长度 `0` | 不得用做并发/版本探测（返回空数组而非报错） |
| `os.homedir()` / `tmpdir()` | 默认指向沙箱外 ⇒ `EPERM` | 必须重定向 `HOME`/`TMPDIR`（§5.6） |
| `io_uring_setup(425)` | 本机返回 **8**（无 seccomp trap）⇒ SIGSYS shim **未触发** | shim 保留作防御，不是必需（与 notes 设备不同） |
| `os.networkInterfaces()` | `lo, wlan0, ancowlan0` | loopback 存在（宿主 ArkWeb 可访问 `127.0.0.1`） |
| `worker_threads` | `Worker` 存在 | O3 待 Phase 1 深测 |
| `spawn('/system/bin/sh')` | `data`/`exit`/`close` **三事件齐全、无僵尸** | 推翻旧壳 R14；库只当能力标志上报（§4.5） |
| `flock(2)` / `link(2)` / `symlink` | 平台不支持 | 单进程语义视为成功 / 用 `open(dst,'wx')`+`rename` / 一律 copy（§4.4） |

### 6.5 命令速查（host 侧，与规划附录 A 同口径）

| 目的 | 命令 |
|---|---|
| 只校验运行时 | `node tools/provision.mjs --check` |
| 打印锁定项 | `node tools/provision.mjs --list` |
| 投放 | `node tools/provision.mjs --out <模块>/libs/arm64-v8a` |
| 联网兜底（国内必带代理开关） | `NODE_USE_ENV_PROXY=1 node tools/provision.mjs --download --out <dir>` |
| ELF 排障 | `python tools/elf-inspect.py <模块>/libs/arm64-v8a/libnode.so` |
| 自签（仅独立分发） | `node tools/ohos-selfsign.mjs add-section → sign → verify` |
| 出 HAR | `hvigorw --mode module -p module=library@default assembleHar --no-daemon` |
| 体积核对（**查 HAP 不查磁盘**） | `python -c "import zipfile;z=zipfile.ZipFile('x.hap');print([(i.filename,i.compress_type) for i in z.infolist() if i.filename.endswith('.so')])"` ⇒ `compress_type` 必须是 `8` |
