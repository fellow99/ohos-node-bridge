# plan.md —— `007-distribution-har-package`（分发 · HAR 包与接入契约）实现方案

> 上游规划：[`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) §7.5 / §7.2 / §7.3 / §7.4 / §6.1 / §8 / §9.3 / §9.4 / §9.5 / §4.8 / 附录 C / 附录 G.1·G.8。
> 宪法：[`../constitution.md`](../constitution.md)（C1–C7、S1–S10、G3/G4/G5/G11、证据纪律）。
> 配套需求：[`spec.md`](./spec.md)（FR-007-001 至 FR-007-017 / AC-007-01 至 AC-007-13）。
> 证据标记：✅ 实测 · 🔶 沿用外部/同型工程 · ⬜ 待验证/未落地 · ⚠️ 冲突或风险。
> **不复制粘贴规划**：本文只给设计与取舍，结论一律回引 § 号。

---

## 1. 技术上下文

### 1.1 运行环境（本机实测，2026-10-16）

| 项 | 值 | 来源 |
|---|---|---|
| ohpm | `6.1.2.285` | `D:\oh-workspace\command-line-tools\bin\ohpm.bat -v` ✅ |
| hvigor | `6.24.4`；工程 `modelVersion 6.1.1` | `hvigorw.bat -v` / `oh-package.json5:2`、`hvigor/hvigor-config.json5:2` ✅ |
| compile SDK | `6.1.1.125`（HAR 内 `module.json` 的 `compileSdkVersion`） | 产物实测 ✅ |
| SDK 根 | `D:\oh-workspace\command-line-tools\sdk`（`sdk/default/openharmony/native/llvm/lib/aarch64-linux-ohos/libc++_shared.so` 1,262,504 B） | 与 `runtime.lock.json:48-53` 的 `sdkRelPath` 一致 ✅ |
| host Node | `v24.7.0`（`provision.mjs`/`elf-inspect.py` 用；`provision.mjs` 要求 ≥18） | `node -v` ✅ |
| 目标设备 | HAD-W24 / 7.0.0.107(SP7C00E100R13P5) / API 26 / OpenHarmony-7.0.0.105 / arm64-v8a | `runtime.lock.json:44` ✅ |
| HAR 构建命令 | `cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default assembleHar --no-daemon"` | `README.md:37-41` + 消费方脚本同口径（`../pi-desktop-ark/scripts/build-bridge-har.sh:31`）✅ |
| HAP 构建命令（验证用） | `DEVECO_SDK_HOME=<CLT>/sdk hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` | §7.4 ④（探针工程实测 **34 s 出 HAP** 🔶） |
| 发布命令 | `ohpm publish <assembleHar 产出的 .har>`（**不对源码目录 publish**） | `library/.ohpmignore:9-10`（推荐口径）；⬜ 未实测 |

### 1.2 依赖

| 类别 | 内容 |
|---|---|
| **运行时依赖（库 → 平台）** | **零第三方包**：`library/oh-package.json5:15` 的 `dependencies` 为空；ArkTS 只用平台 Kit——`@kit.AbilityKit`（`common.Context`）、`@kit.CoreFileKit`（`fileIo`）、`@kit.LocalizationKit`（`resourceManager`）、`@kit.PerformanceAnalysisKit`（`hilog`）✅ |
| **运行时依赖（库 → 原生）** | `libnode_bridge.so` **只经 `.d.ts` 环境声明**接入（S1）：`import nodeBridge from 'libnode_bridge.so'`（`NodeRuntime.ets:2`）+ `types/libnode_bridge/index.d.ts`；`.so` 不是包依赖，`import` 也不是相对路径 |
| **运行时依赖（库 → `libnode.so`）** | 只经 `dlopen("libnode.so")` + `dlsym("_ZN4node5StartEiPPc")`（S7）；**不链接**、不做 `DT_NEEDED`（`CMakeLists.txt:13-16`） |
| **构建依赖** | ohos-sdk（CMake + OHOS toolchain + `libace_napi.z.so` / `libhilog_ndk.z.so`）；CLT 的 hvigor/ohpm；host Node（工具链脚本） |
| **host 工具依赖** | `tools/provision.mjs`（341 行）只用 Node 内置模块（`node:crypto/fs/path/child_process/url/os`）✅；`tools/elf-inspect.py`（169 行）纯 Python、不依赖 llvm |
| **刻意不引入** | 制品库 / 远端包 / 测试框架（根 `oh-package.json5:4-5` 注释理由：离线可构建）✅ |

---

## 2. 宪法合规检查

### 2.1 七条原则

| # | 原则 | 判定 | 理由（落到本模块） |
|---|---|---|---|
| **C1** | 库/壳分离 | ✅ | HAR 内无窗口/页面/路由/ArkWeb/包名/签名主体/鉴权/`pi` 语义：`library/` 全树只有 `runtime`/`bridge`/`log`/`util` + `cpp`；样例只在 `samples/`（§7.2 纪律）。发布物**语言层面**也拦得住：应用语义字符串 0 命中 |
| **C2** | 不隐藏平台真相 | ⚠️ | 「拿不到运行时」是硬失败（`provision.mjs` `exit 2` + 三条出路）✅；但**库运行期没有版本可见性**：`bridgeVersion()` 返回的是引导件串 `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`，**不是** `process.version`；`>=22.19.0` 只在构建期门禁检查（`runtime.lock.json`）。⇒ Phase 2 必须把「运行时版本可用性」做成可见标志（spec FR-007-008） |
| **C3** | 谁写谁读 | ✅ | 发布物层面：`Env.materializeRawfile` 注释写明「Node 读不到包内只读条目」并给出 `resfile` 直读首选（`Env.ets:44-50`）；`payload/README.md:17-21` 把「Node 自己解包」写成契约；`Logger.tail` 提供读回通道（`Logger.ets:27`） |
| **C4** | `execArgv` 启动即固定 | ✅ | `NodeRuntimeOptions.flags` 是一次性输入（`Types.ets:17-25`），barrel 上**没有**任何 push/追加参数的 API（`Index.ets` 全量导出面见 §4.3） |
| **C5** | 单例不可重启 | ✅ | 单例 + 幂等保护 ✅（`NodeRuntime.ets` 二次 `start()` 返回失败）；`shutdown(reason)` 已实现（只标记 `stopping` + 记 reason + warn「进程内无法优雅停止」，**不假装能停**）；无任何重启路径 ✅；Node 侧 `onShutdown` 钩子仍属 Phase 2 |
| **C6** | 诊断优先于修码 | ✅ | 崩溃结构化证据（`node_bridge.c:100-112` 的 `CRASH sig= si_addr= pc= lr= sp= r0=`）+ 真机判据写在 `tests/README.md:18-28`；发布物不承诺「点击看起来生效」类判据 |
| **C7** | 零补丁 & 二进制可替换 | ✅ | 无上游补丁；换运行时只改 `runtime.lock.json`（`active` + `runtimes[]`）+ 重跑门禁；引导件与运行时版本解耦（S7）；供应链记录齐备（来源/SHA-256/许可/`verifiedOn`/`verifiedDevice`） |

### 2.2 代码规约

| # | 规约 | 判定 | 理由 |
|---|---|---|---|
| S1 | ArkTS 严格模式 / `.d.ts` 环境声明 | ✅ | `NodeRuntime.ets:2` 经 `libnode_bridge.so` 环境声明；`index.d.ts` 只声明 3 个函数 |
| S2 | barrel 唯一出口 | ⚠️ | 出口存在且唯一 ✅；但导出面把 `Env`/`Logger`（内部工具类）一起暴露 ⇒ 契约面膨胀（R15）。建议：`0.2.0` 起把二者降为「**不承诺稳定**」并在表里标注（§4.3 已标注），新增符号前先登记 |
| S3 | 类型改动即破坏性变更 | ✅ | `Types.ets:1-5` 文件头写明；4 个声明全部在 barrel 上 |
| S4 | 路径一律绝对 | ✅ | `Env` 全部以 `context.filesDir` 为根拼绝对路径（`Env.ets:15-27`）；`payload/bootstrap.js:27` 注释明确「`cwd` 只用于日志」 |
| S5 | 信号上下文禁用 stdio | ✅ | `raw_write_fd` 只用裸 `write`；`crash_handler` 已改手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` + **单次 `write()`**（2026-10-17，D6 关闭）；`log_line`（用 `vsnprintf`+`OH_LOG_Print`）只在非信号路径调用 |
| S6 | native 产物落点固定 | ✅ | `CMakeLists.txt:10-11` 显式设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` → `<module>/libs/${OHOS_ARCH}`；实测 `library/build/.../intermediates/libs/default/arm64-v8a/libnode_bridge.so` 与 HAR 内 `libs/arm64-v8a/` 一致 |
| S7 | 引导件不链接 libnode | ✅ | `CMakeLists.txt:16` 只链接 NAPI + hilog；`node_bridge.c:159-172` 运行期 `dlopen`，且**裸名兜底**在候选表最后 |
| S8 | C 侧接口 5 个（`start` 6 参，2026-10-17 扩充） | ✅ | `node_bridge.c` `Init()` 注册 `start`/`isRunning`/`version`/`lastError`/`stage`，与 `index.d.ts` 逐项一致 |
| S9 | 日志双通道 | ✅ | hilog ✅（`Logger.ets`）+ 文件 ✅（C 侧 `write_line()`/常开 fd，`<stream> <epochMs> <text>` 单次 write）；stdio 已改 **1 MB pipe + 独立 reader 线程持续排空**（含组件输出过滤），不再有「大输出阻塞 ArkWeb IO」问题 |
| S10 | 二进制不入库 | ✅ | 根 `.gitignore:17-24`（`**/libnode.so`、`**/libc++_shared.so`、`library/libs/`、`library/src/main/libs/`、`*.har`）+ `library/.ohpmignore:11`；实测 HAR 内无 `libnode.so` |

### 2.3 合规红线

| # | 红线 | 判定 | 理由与**可执行判据** |
|---|---|---|---|
| **G3** | 包内不得含第三方浏览器内核 | ✅ | HAR 27 个条目全清单（§4.1）无内核文件；HAP 库侧增量只有 3 枚 `.so`。判据：枚举 `package/**`，断言文件名不含 `chromium`/`cfx`/`nw`/`electron` 且最大体积条目为 `libc++_shared.so` |
| **G4** | 第三方许可清单必须随包 | ❌ | 仓库只有根 `LICENSE`（MIT，21 行）与 `runtime.lock.json:27` 的 `source.license` 字符串数组；**无独立清单文件**、HAR 内也没有。判据（补齐后）：HAR 内存在许可文件，且含 Node.js/V8/OpenSSL 等条目 + 来源 + SHA-256。见 §9 第 1 项 |
| **G5** | ELF 合规 | ✅ | HAP 内原生库不需要 `.codesign`（§D.6/§D.9 实测）；`provision --sign` 仅服务独立分发（`provision.mjs` 头注释 + §G.4） |
| **G11** | 不得含绕过平台代码签名/可执行内存控制的组件 | ✅ | 发布分支无 `wxjit`/`LD_PRELOAD`/内联自签实现；`tools/ohos-selfsign.mjs`（291 行）只做 `add-section`/`sign`/`verify` 且**不随 HAR**（HAR 不含 `tools/`）。判据：对 HAR 解包 + `library/` 全树检索 `wxjit|LD_PRELOAD|mremap|fake_codesign|Merkle`（正则，`\|` 为或），`library/` 必须 0 命中 |

---

## 3. 研究结论（为什么这么定）

### 3.1 为什么 HAR **不带** `libnode.so`（定案，§7.5 / 附录 G.8）

| # | 理由 | 展开 |
|---|---|---|
| ① | **每个使用者都要下 120 MB** | `libnode.so` 126,809,264 B；ohpm 包一旦含它，任何 `ohpm install` 都变成 120 MB 起步，且这只是「运行时」，业务载荷另算（附录 C 已把两笔账分开：库侧 ≈44 MB vs 载荷另计） |
| ② | **不同消费方需要不同版本 / 不同签名策略** | 消费方可能自建产物（§G.6 路线 C）、可能用镜像（路线 B）、也可能走独立分发自签（`provision --sign`）；把某一个二进制钉进 HAR 等于把这三条路封死（附录 G.8 ②） |
| ③ | **二进制走 Release / 本地目录比走包管理器合适** | 包管理器管代码，制品管二进制；本工程无制品库 ⇒ 用「锁文件 + 投放工具 + 本地目录（`../ohos-node-runtime`）」的等价形态（附录 G.1/G.5，与旧壳从 `harmonypc-electron-versions/` 取运行时同构） |

**代价与兜底**：第三方必须多做一步（`provision.mjs`）。因此 HAR **必须**给出线索（FR-007-005）——这是本模块当前最大的未闭合项（§4.1 的 `runtime.lock.json` / `payload/` 两行为 ⬜）。兜底判据：`provision.mjs` 三条明确出路（本地放置 / `--from` / `--download`）+ 硬失败 `exit 2`，绝不静默降级。

### 3.2 为什么 `module.json5` 刻意**不写** `description`

HAR 的资源与消费方资源在合并时同名即告警：写 `"description": "$string:module_desc"` 会与消费方自己的 `module_desc` 撞名（`module_desc` / `node_bridge_module_desc` 都在实测中撞过）。**取舍**：HAR 的用途说明交给 `oh-package.json5` 的 `description`（383 B 文件里已有完整中文说明）与 `library/README.md`（随包，3,152 B ✅ 实测在 HAR 内）——两者都不参与资源合并，零告警。**判据**：发布版 `module.json` 内不存在 `description` 字段（实测成立）。

### 3.3 为什么库只声明 2 项开放权限

- `INTERNET`：Node 侧起 loopback HTTP 服务、加载页探活（§6.1「本地服务在端上跑着」）；
- `GET_NETWORK_INFO`：网络状态判断（Node 侧与宿主诊断都用得上）。
**不声明**的：受限 ACL（JIT 必需）——它的申报主体是**应用包名**，库替它声明既不生效也不道德（§9.4：`provisionEnable=true` 的权限必须按包名获批并写进 Profile）；`KEEP_BACKGROUND_RUNNING` / `PREPARE_APP_TERMINATE` / `RUNNING_LOCK` 等属宿主生命周期语义（`../pi-desktop-ark/entry/src/main/module.json5:51-80` 已按自己包名声明）⇒ 库侧声明面保持最小（§5.10 ⑮ 同口径：先例也「权限面极小、没有受限 ACL」）。

### 3.4 为什么消费方必须用 `.har` 而不是源目录（`useNormalizedOHMUrl` 下的硬约束）

`useNormalizedOHMUrl: true` 时 hvigor 拒绝「跨工程以相对路径导入外部模块源码」，报 `00309001 Cannot import files from an external module using relative paths`。消费方已踩并固化：`../pi-desktop-ark/oh-package.json5:9-12`、`scripts/build-bridge-har.sh:4-11`、其 `docs/000-工程规划.md:516`（✅ 实测）。**设计含义**：

1. 本库的「交付单元」必须是**构建产物 `.har`**，而不是 `library/` 目录 ⇒ 任何让第三方「clone 后直接 `file:` 源码目录」的文档都必须标注适用条件（自己没开 `useNormalizedOHMUrl`）；
2. `.har` 也更贴近 ohpm 真实形态（从 ohpm 拿到的就是 `.har`），因此本模块的验收一律以 `.har` 为被测对象；
3. 由此推出：`assembleHar` 必须是**一条命令可复现**的（README 已给命令），否则第三方拿不到可用单元。

### 3.5 为什么 `payload/` 的落点是必须解决的**结构性**问题

现状：`payload/` 在**仓库根**（`payload/bootstrap.js` 64 行、`selfcheck.js` 84 行、`README.md` 21 行），而 HAR 只收 `library/` 子树 ⇒ **实测 HAR 内没有 `payload/`**。但 `payload/README.md:1` 与规划 §7.5 / 附录 G.8 都写「`payload/` 随库分发」——**代码与规划在此处不一致**。不解决的后果：

- 第三方拿不到可跑的入口范式（`bootstrap.js` 是他们唯一的「环境契约可执行样例」）；
- `selfcheck.js`（`/facts` 端到端自检）是「库是否可用」的**唯一可移植判据**，却不在发布物里 ⇒ AC-007-09/13 无法闭合；
- 消费方文档与实际交付物不一致，审计时无法解释。

**两种修法（Phase 2 二选一，倾向 A）**：

| 方案 | 做法 | 优点 | 风险 / 需实测 |
|---|---|---|---|
| **A（推荐）** | 在 `library/` 内落 `payload/`（`bootstrap.js`/`selfcheck.js`）与 `runtime.lock.json` 的**同步副本**，由 host 脚本从仓库根**单一事实源**拷贝（拷贝时比 SHA-256，禁止手改） | 包内线索自闭合；随包 = 随版本，不依赖 GitHub 可达性；`payload/README.md:1` 与 §7.5 的说法成立 | ⬜ 必须实测「`assembleHar` 是否把 `library/payload/*.js` 与 `library/runtime.lock.json` 收进 HAR」（已知规则：`library/` 顶层文件会被收，README.md 就是例证；但 `src/main/` 之外的目录需实测确认），并把结果写进 `.ohpmignore` 注释与 §7.5 |
| **B（不改结构）** | 保持根 `payload/`，在 `library/README.md` 与 `oh-package.json5.description` 里给出**可下载 URL + SHA-256**，把 `payload/` 定性为「包外参考实现」 | 零包结构改动 | 「拿得到」寄托在 GitHub 可达性上（与 §G.5 否掉 submodule 的理由同类）；第三方离线/受限网络时无法闭合；且规划 §7.5 必须同步改写 |

两条路都必须同时修**文档口径**：`payload/README.md:1`（「随库分发」）与 `.ohpmignore:3-4`（「HAR 只带引导件 + 锁文件 + 投放工具」——实测不成立）要么改为事实，要么被实现追平。

### 3.6 为什么 `Types.ets` 的类型改动必须提版本

`NodeRuntimeOptions` / `NodeStartResult` / `NodeState` / `HostBridgeHandler` 是第三方唯一能看到的编译期契约（S3）。非破坏性扩展（加**可选**字段）⇒ `minor`；改字段名/类型、删字段、改枚举字面量 ⇒ `major`（`0.x` 阶段按 `minor` 但也必须写迁移说明）。理由：

- 消费方是**编译期**通过 `.d.ets` 看到这些声明的（HAR 内实测只有 `Types.d.ets`，无 `.ets` 源码）⇒ 改类型 = 消费方编译失败，比运行期失败更早、更硬；
- 枚举字面量（`'idle' | 'starting' | 'running' | 'failed'`）是**字符串**，会被日志/UI 直接展示 ⇒ 改字面量等于改对外可见行为；
- 宪法 §六 1 要求：改公共 API ⇒ 同时改 `specs/README.md` 与受影响 `plan.md`，且 semver 必须提。

---

## 4. 数据模型

### 4.1 HAR 包内容清单（**实测**，`library/build/default/outputs/default/library.har`，441,353 B）

> 格式实测：**gzip 包裹的 tar**（魔数 `1f8b0800`，内层根为 `package/`），解压后 1,334,784 B，共 **27 个条目 = 14 文件 + 13 目录**。核对命令见 §6.2。

| 包内路径 | 体积 (B) | 随包 | 理由 / 现状 |
|---|---|---|---|
| `package/Index.d.ets` | 1,104 | ✅ | `oh-package.json5.types` 指向它；**对外唯一入口的类型声明**（S2） |
| `package/oh-package.json5` | 732 | ✅ | 发布元数据（源文件 383 B → 构建期补齐 `types`/`nativeComponents`/`metadata`，见 §4.2） |
| `package/README.md` | 3,152 | ✅ | 30 秒用法 + 三步接入 + 已知限制；**不写进资源表，故不会重名**（§3.2） |
| `package/src/main/module.json` | 820 | ✅ | 权限声明面（§4.4）；**刻意无 `description`** |
| `package/libs/arm64-v8a/libnode_bridge.so` | 14,208 | ✅ | 引导件（S6 落点 / S7 不链接 libnode）；`metadata.nativeComponents` 登记它 |
| `package/libs/arm64-v8a/libc++_shared.so` | 1,262,504 | ✅ | 引导件依赖的 C++ 运行时（来自 ohos-sdk，与 SDK 内同名文件同尺寸）；体积上界由此决定 |
| `package/ets/modules.abc` | 15,228 | ✅ | 已编译 ArkTS 字节码（`metadata.byteCodeHar: true`） |
| `package/ets/sourceMaps.map` | 10,462 | ✅ | 源码映射（排障用） |
| `package/src/main/ets/{runtime/NodeRuntime,runtime/Types,bridge/HostBridge,log/Logger,util/Env}.d.ets` | 2,174 / 2,143 / 1,395 / 719 / 1,734 | ✅ | 5 个 `.d.ets` **声明**（**没有 `.ets` 源码**）⇒ 第三方看到的只有契约面 |
| `package/src/main/resources/base/element/` | 0（空目录） | ✅ | 库无资源（有意：不引入资源重名面） |
| `package/ResourceTable.txt` | 0 | ✅ | hvigor 生成（空） |
| **`libnode.so`** | — | ❌ | **不随包**（S10 / §7.5 / §G.8，理由见 §3.1） |
| **`runtime.lock.json`** | — | ⬜ **当前不随包** | FR-007-005 要求随包（或等效可达）；修法见 §3.5 方案 A |
| **`payload/bootstrap.js`、`payload/selfcheck.js`** | — | ⬜ **当前不随包** | 同上；`payload/` 在仓库根，不在 `library/` 内 |
| **`tools/provision.mjs`** | — | ⬜ **当前不随包** | 规划 §7.5 写「投放工具随包」，实测未随包 ⇒ 第三方的可闭合性靠 GitHub（§7 交付物第 3 项） |
| 任何浏览器内核 | — | ❌ | G3（§2.3） |

### 4.2 `oh-package.json5` 字段表（源文件 vs 发布版）

| 字段 | 源文件（`library/oh-package.json5`） | HAR 内发布版（构建期注入） | 含义 |
|---|---|---|---|
| `name` | `@fellow99/node-bridge` | 同 | ohpm 包名；scope 归属待人工确认（§9.3 第 1 项） |
| `version` | `0.1.0` | 同 | semver；改公共 API 必须提（§3.6） |
| `description` | 1 行中文说明 | 同 | HAR 用途说明的**唯一位置**（§3.2） |
| `main` | `Index.ets` | （构建后由 `types` 承担入口声明） | barrel 入口 |
| `types` | 无 | `Index.d.ets` | 消费方编译期看到的入口 |
| `author` / `license` / `keywords` | `fellow99` / `MIT` / 5 个 | 同 | G4 的库侧部分（库自身许可明确） |
| `dependencies` | `{}` | `{}` | 零运行时依赖（NFR-6） |
| `artifactType` | 无 | `obfuscation` | 构建器产物类型 |
| `metadata.byteCodeHar` / `sourceRoots` / `debug` / `nativeDebugSymbol` / `useNormalizedOHMUrl` | 无 | `true` / `["./src/main"]` / `true` / `true` / `true` | 字节码 HAR 标记 + 调试信息保留（release 需复核 ⬜） |
| `compatibleSdkVersion` / `compatibleSdkType` | 无 | `17` / `HarmonyOS` | 与 `AppScope/app.json5:11` 的 `minAPIVersion: 17` 一致（兼容矩阵的 API 下界） |
| `nativeComponents` | 无 | `[{"name":"libnode_bridge.so","compatibleSdkVersion":17,"compatibleSdkType":"HarmonyOS","linkLibraries":[]}]` | 让 hvigor 把 HAR 内 `.so` 收进消费方 HAP（与消费方 `collectAllLibs` 配合） |
| `nativeComponents.linkLibraries` | 无 | `[]` | 引导件不链接 `libnode.so`（S7 的元数据侧体现） |

### 4.3 `Index.ets` 导出面（barrel 全表，**8 个符号 / 6 条 export**）

| 导出名 | 种类 | 来源文件:行 | 公共契约？ |
|---|---|---|---|
| `NodeRuntime` | `class` | `runtime/NodeRuntime.ets:19` | ✅ 是（`start`/`getState`/`isRunning`/`markRunning`/`markFailed`/`getLogPath`/`getOptions`/`bridgeVersion`/`getInstance`） |
| `NodeState` | `enum`（字符串枚举） | `runtime/Types.ets:8` | ✅ 是（字面量对外可见，改动 = 破坏性，§3.6） |
| `NodeRuntimeOptions` | `interface` | `runtime/Types.ets:16` | ✅ 是（`flags?`/`scriptPath`/`libDir?`/`homeDir?`/`logPath?`） |
| `NodeStartResult` | `interface` | `runtime/Types.ets:37` | ✅ 是（`ok`/`code`/`state`/`message`） |
| `HostBridgeHandler` | `type` | `runtime/Types.ets:49` | ✅ 是（`(argsJson: string) => string`） |
| `HostBridge` | `class` | `bridge/HostBridge.ets:14` | ⚠️ 声明为公共，但实现是**纯 JS 骨架**（`HostBridge.ets:6-11` 列出 Phase 2 三项缺口）；`0.1.0` 期间按「实验」对待 |
| `Logger` | `class` | `log/Logger.ets:13` | ⚠️ 同上（内部工具类，暴露给消费方做诊断面板；语义稳定但非核心契约） |
| `Env` | `class` | `util/Env.ets:13` | ⚠️ 同上（路径装配工具；含 `materializeRawfile` 这类可能随契约演进的工具方法） |
| （**未导出**）`HAR_VERSION` | `const` | `library/BuildProfile.ets:4` | ⬜ 应在后续版本经 barrel 暴露，使第三方**在运行期自证库版本**（FR-007-008 的前置） |

### 4.4 `module.json5` 权限表（发布版 `module.json` 实测）

| 字段 | 值 | 说明 |
|---|---|---|
| `module.name` | `library` | 模块名（不是包名） |
| `module.type` | `har` | HAR 形态 |
| `module.deviceTypes` | `["2in1","tablet"]` | 不做 phone（A5） |
| `module.packageName` | `@fellow99/node-bridge` | 构建期注入 |
| `module.requestPermissions` | `ohos.permission.INTERNET`、`ohos.permission.GET_NETWORK_INFO` | **只有 2 项开放权限**（§3.3） |
| `module.definePermissions` | 无 | 受限权限归消费方（FR-007-007） |
| `module.description` | **不存在** | 刻意（§3.2） |
| `module.virtualMachine` / `compileMode` | `ark12.0.6.0` / `esmodule` | 构建器注入 |
| `app.*`（打包进 HAR 的壳） | `bundleName: org.fellow99.nodebridge.sample` 等 | **仅本仓库自测样例的包名**（`AppScope/app.json5:5`）；消费方合并时以**自己**的 `app.json5` 为准（`AppScope/app.json5:3-4` 注释已声明） |

**消费方必须成对声明的 ACL（库侧不声明）**：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` ⇒ `requestPermissions` + `definePermissions` 两处都要有（实测样例：`../pi-desktop-ark/entry/src/main/module.json5:65` 与 `:162`），且**获批后写进 Profile**，Profile 变了要重建（§9.4）。

### 4.5 版本矩阵（`runtime.lock.json` 实测字段 → 矩阵行）

| bridge 版本 | libnode 版本 | `abi` | `deployAs`（HAP 内名） | SONAME | `size` (B) | SHA-256 | 门禁 | 真机验证 |
|---|---|---|---|---|---|---|---|---|
| **`0.1.0`**（`library/oh-package.json5:3`；HAR 内同） | `v24.2.0`（`nodeModuleVersion: 137`） | `arm64-v8a` | `libnode.so` | `libnode.so.137` | 126,809,264 | `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` | 7 项全过（`typeDyn`/`ptInterp=0`/`machineAArch64`/`neededLibcxx`/`exportsNodeStart`/`sha256Match`/`versionGeq2219`） | `2026-10-16` · `HAD-W24 / 7.0.0.107(SP7C00E100R13P5) / API 26 / OpenHarmony-7.0.0.105 / arm64-v8a` |

**矩阵的两个缺口**（Phase 2 补齐，FR-007-008）：

1. 锁文件里**没有 bridge 版本字段** ⇒ 「哪个 bridge 版本对哪个 libnode 版本」今天只能靠人工对照 `library/oh-package.json5` 与 `runtime.lock.json` 两份文件；建议在锁文件内新增 `bridge: { package, version, harSha256 }` 段（换 HAR 时重新计算）；
2. `runtime.lock.json` **不随 HAR**（§3.5）⇒ 第三方拿不到矩阵。两条修法：随包（方案 A）或把矩阵渲染进随包的 `README.md`（已在做，但只覆盖当前单一版本，不含历史版本）。

**升级路径（协议化，§9.2 要求）**：① 改 `active` + 追加/替换 `runtimes[]` 条目 → ② `node tools/provision.mjs --check` 必须全过 → ③ 真机回归**四件套**（`/facts` JSON、`node.log` 无异常退出、崩溃记录可读、HAP 内 `.so` SHA-256 = 锁值）→ ④ 回写 `verifiedOn`/`verifiedDevice`/`verifiedNotes`（宪法 §六 2）。

### 4.6 兼容矩阵（§7.5 口径 → 可断言形式）

| 维度 | 取值 | 现状 |
|---|---|---|
| `node-bridge` | `0.1.0`（`0.x`：允许 minor 破坏，但必须写迁移） | ✅ 包元数据可见 |
| `libnode` | `>= 22.19.0`；当前锁定 `24.2.0` | ✅ 锁文件 + 门禁 |
| API | `compatibleSdkVersion 17` / `targetSdkVersion 24` / 真机实测 API 26 | ✅ 构建元数据（`AppScope/app.json5:11-12`、发布版 `module.json` 的 `compatibleSdkVersion: 17`） |
| `deviceTypes` | `2in1`、`tablet` | ✅ `module.json5:5-8` |
| ABI | `arm64-v8a`（**无 x86_64**，A5） | ✅ `library/build-profile.json5:8-10` |
| 消费方前置 | `useNormalizedOHMUrl: true` 工程必须用 `.har`（§3.4）；`collectAllLibs: true`（否则预置原生库可能不被收进 HAP） | ✅ 消费方 `entry/build-profile.json5` 与根 `build-profile.json5` 已如此配置 |
| **缺口** | 需要一个**机读**矩阵文件（如 `compat.json` 或锁文件内 `compat` 段），使 CI/第三方可断言；同时写明「低版本 `libnode` 即使 ELF 门禁过也可能运行期崩」的边界 | ⬜ §9 第 4 项 |

### 4.7 `.ohpmignore` 规则表

| 模式 | 意图 | 会不会误伤引导件 / `libc++_shared.so` |
|---|---|---|
| `**/libnode.so` | 排除运行时二进制（S10） | ❌ 不会（文件名不同；引导件叫 `libnode_bridge.so`） |
| `build/` | 排除本模块构建目录 | ❌ 不会（HAR 收集阶段在构建之后，且引导件在 `libs/`） |
| `.hvigor/` | 排除 hvigor 缓存 | ❌ 不会 |
| `.cxx/` | 排除 CMake 缓存 | ❌ 不会 |
| `oh_modules/`、`node_modules/` | 排除依赖安装目录 | ❌ 不会（库无依赖） |
| `*.har` | 排除历史产物（避免把旧 HAR 塞进新 HAR） | ❌ 不会 |

**两条必须写进文档的口径**（`.ohpmignore:6-10` 已写，需保留）：

1. 引导件与 `libc++_shared.so` **要随包**——它们由 CMake/`ProcessLibs` 产出，本文件**不排**它们（实测 HAR 内二者都在，分别 14,208 B / 1,262,504 B）；
2. 推荐发布方式为 **`assembleHar` → `ohpm publish <产出的 .har>`**；`ohpm publish` 直接吃**源码目录**会缺构建产物（本文件只作兜底保护）。⚠️ 由此产生一个待验证点：**`.ohpmignore` 对「publish 一个已构建 `.har`」是否还有约束力**（⬜ 需实测；若不生效，则「HAR 不该带什么」必须靠**构建期**保证，例如在 `library/hvigorfile.ts` 里加产物断言）。

---

## 5. 接口契约

### 5.1 提供（消费方可见）

**A. 8 个导出符号的签名/语义**（来源 §4.3，逐条给出调用面）

```ts
// 001-runtime-core
NodeRuntime.getInstance(): NodeRuntime                      // NodeRuntime.ets:26（进程内单例）
runtime.getState(): NodeState                               // :33
runtime.start(context: common.Context, o: NodeRuntimeOptions): NodeStartResult  // :61（投递语义；仅 IDLE 可调）
runtime.isRunning(): boolean                                // :38（原生探针：Node 主循环是否仍在跑）
runtime.bridgeVersion(): string                             // :43（引导件版本串，排障先看它；**不是** process.version）
runtime.getLogPath(): string                                // :47
runtime.getOptions(): NodeRuntimeOptions | undefined        // :51
runtime.markRunning(): void                                 // :102（探活成功后由消费方调用）
runtime.markFailed(reason: string): void                    // :109（探活超时/读到崩溃记录时调用）

// 003-host-bridge（骨架）
bridge.register(name: string, handler: HostBridgeHandler): void   // HostBridge.ets:18
bridge.list(): string[]                                            // :23
bridge.dispatch(name: string, argsJson: string): string            // :35（**永不抛异常**，结构化 JSON）

// 006-observability
Logger.info/warn/error(msg: string): void                     // Logger.ets:14/18/22
Logger.tail(path: string, maxBytes: number): string           // :27（读回通道；失败返回占位串）
Env.payloadDir/tmpDir/logPath(context): string                // Env.ets:15/20/25
Env.ensureDir / ensureRuntimeDirs(context): void               // :30/:39
Env.materializeRawfile(mgr, rawName, destPath): string         // :51（仅小文件；大载荷用 resfile 直读）
```

**语义要点（消费方必须知道的 5 条）**：① `start()` 成功只代表**已投递**，判「起来了」靠探活（`NodeRuntime.ets:55-59`）；② `NodeState.FAILED` 是**终态**，不可重启（C5）；③ `flags` 一次性（C4），无 ACL 时用 `--jitless` 会失去 WebAssembly；④ `libDir` 默认 `context.bundleCodeDir`，但真机只有**裸名** `libnode.so` 能 `dlopen`（引导件已内置候选表）；⑤ 载荷必须放 `resources/resfile/`（零解压直读）或沙箱，路径一律绝对（S4）。

**B. HAR 依赖的两种写法**

| 形态 | 写法 | 适用 | 判据 |
|---|---|---|---|
| **版本号**（ohpm 已发布） | `"@fellow99/node-bridge": "0.1.0"`（或 `^0.1.0`） | 第三方 | ⬜ 未发布（Phase 3，A8） |
| **`file:` 指向 `.har`**（推荐本阶段） | `"@fellow99/node-bridge": "file:./libs/@fellow99/node-bridge.har"` | 所有开了 `useNormalizedOHMUrl` 的工程 | ✅ 消费方实测（`../pi-desktop-ark/oh-package.json5:12`） |
| `file:` 指向源目录 | `"@fellow99/node-bridge": "file:../ohos-node-bridge/library"` | **仅**未开 `useNormalizedOHMUrl` 的工程 | ⚠️ 开了就 `00309001`（§3.4） |

**C. `provision.mjs` 作为「包外工具」的调用契约**（`005` 实现，本模块只约定调用面）

| 参数 / 变量 | 语义 | 退出码 |
|---|---|---|
| `--out <模块>/libs/arm64-v8a` | 投放目标（**必须是消费方模块自己的 `libs/<abi>/`**） | `0` 成功（含幂等跳过） |
| `--check` | 只校验（SHA-256 + 7 项 ELF 门禁），可进 CI | `0` 全过 / `2` 任一不过 |
| `--list` | 打印锁定项（版本/SHA-256/门禁） | `0` |
| `--from <path 或 url>` / `--download` | 显式来源；`--download` 依次试 `mirror` → `source` | 全失败 `2` |
| `--sign` | 补 `.codesign` + 自签（**只为独立分发**，G5） | `0`/`2` |
| `--force` / `--node <ver>` / `--abi <abi>` / `--sdk <path>` / `--quiet` | 强制重投 / 选版本 / 选 ABI / 指定 SDK / 降噪 | — |
| 环境变量 `OHOS_NODE_RUNTIME_DIR` | 覆盖本地运行时目录（CI / 另一台机器） | — |
| 环境变量 `NODE_USE_ENV_PROXY=1` | 联网下载时**必须**显式开（Node 内置 `fetch` 默认不读代理） | — |
| 副作用面 | **只写** `<out>/libnode.so` 与 `<out>/libc++_shared.so`；中间产物落系统临时目录 | — |

### 5.2 消费（发布物对外部环境的依赖）

| 项 | 契约 | 依据 / 现状 |
|---|---|---|
| `ohpm install` | `file:` 依赖会被链进 `oh_modules`；`file:<dir>` 与 `file:<*.har>` 都可，但跨工程开 `useNormalizedOHMUrl` 时必须后者 | ✅ 消费方 |
| hvigor 打包规则（库 → HAP） | HAR 内 `libs/<abi>/*.so` 由 `nativeComponents` 登记，消费方 **`buildOption.nativeLib.collectAllLibs: true`** 保证预置原生库与 HAR 原生库都被收进 HAP `libs/<abi>/` | ✅ 实测：HAP 内 `libs/arm64-v8a/` 有 3 枚 `.so`（`libnode.so` 来自消费方投放、`libnode_bridge.so` + `libc++_shared.so` 来自 HAR） |
| 原生库压缩（**module 级**） | `module.json5` 的 **`module` 级** `"compressNativeLibs": true` + `"extractNativeLibs": true`（§5.9 / §5.10 ⑦）。**不要**写进 `build-profile.json5`——写那里会被 schema 拒且**不告诉你正确位置** | ⚠️ 未落地：实测消费方已签名 HAP 的 3 枚 `.so` 全为 `compress_type = 0`（未压缩，HAP ≈129 MB），与附录 C 的「库侧压后 ≈44 MB」不符 |
| native 符号保留（release） | `nativeLib.debugSymbol.strip = false` 以支持崩溃取证（§5.10 ⑬）；当前 debug 构建的 HAR 元数据 `metadata.nativeDebugSymbol: true`，**release 构建需复核** | ⚠️ ⬜ release 未实测 |
| `abiFilters` | `library/build-profile.json5:8-10` 固定 `arm64-v8a`；消费方 **module 级 `nativeLib` 不接受 `abiFilters`**（写错 schema 报错）⇒ 消费方只放 `arm64-v8a` 目录即可 | ✅ 消费方踩坑固化（其 `docs/000-工程规划.md:516`） |
| 签名 | 库**无签名主体**：HAR 不带签名材料，`hvigorfile.ts` 只在有本地材料时注入（根 `hvigorfile.ts:98-150`）；样例包名 `org.fellow99.nodebridge.sample`（§4.4） | ✅ 仓库内不含密钥（`.gitignore:11-15`、`signing.debug.local.json.sample`） |
| `.codesign` | HAP 内原生库不需要（G5）；独立分发才用 `provision --sign` | ✅ §D.6/§D.9 |

### 5.3 版本/事件协议

| 事件 | 触发 | 必须做的事 | 判据 |
|---|---|---|---|
| **换运行时版本** | 改 `runtime.lock.json` 的 `active` + `runtimes[]` | ① `provision --check` 全过 → ② 真机回归四件套（`/facts`、`node.log`、崩溃记录、HAP 内 SHA = 锁值）→ ③ 回写 `verifiedOn`/`verifiedDevice`/`verifiedNotes` | 宪法 §六 2；§4.5 升级路径 |
| **加/改公共 API** | 改 `Index.ets` 或 `Types.ets` | ① 提 semver（§3.6）→ ② 改 `specs/README.md` 编号表与受影响 `plan.md` → ③ 在本文件 §4.3 表内补一行（未登记即不得新增，FR-007-001） | 宪法 §六 1 |
| **换 ohpm scope / 首发** | Phase 3 | 确认 `@fellow99` 归属（§9.3 第 1 项）→ `ohpm publish <har>`；发布前跑 `provision --check` + 许可清单存在性门禁 | §8 Phase 3 |
| **消费方接入 / 换包名** | 新消费方接入 | 重新申报 ACL（按新包名）+ 重新生成调试材料（证书与 `bundleName` 绑定，`signing.debug.local.json.sample:7`） | §9.4 |
| **发布失败/缺件** | 包内缺引导件或体积异常 | 一律**硬失败**（不允许「少一个 `.so` 也能发」）：发布前跑 §6.2 的产物核对断言 | C2 |

---

## 6. 实现策略

### 6.1 架构模式：**HAR + 锁文件 + 包外投放工具**三件套

```
第三方工程
  ├─ oh-package.json5           "@fellow99/node-bridge": "file:./libs/@fellow99/node-bridge.har"   ← 代码与引导件（441 KB 量级）
  ├─ entry/libs/arm64-v8a/      libnode.so + libc++_shared.so             ← 由 provision.mjs 投放（121 MB，不入库）
  └─ module.json5               自己包名的 ACL（requestPermissions + definePermissions 成对）
                                + module 级 compressNativeLibs/extractNativeLibs
产物链：assembleHar → HAR（ArkTS 字节码 + .d.ets + 引导件 + README）
        assembleHap → HAP（3 枚 .so 压缩后 ≈44 MB 口径）
```

边界纪律：`library/` 里不放任何 pi/Next/应用语义；`samples/` 不被 `library/` 依赖（§7.2）。发布物**只**由 `library/` 决定（这是 `payload/` 落点问题的根因，§3.5）。

### 6.2 关键算法与产物核对

**A. `assembleHar` 产物形成过程**（实测任务链，来自 `library/build/default/cache/default/` 与 `intermediates/`）

| 阶段 | 任务（实测名） | 输入 → 输出 |
|---|---|---|
| ① ArkTS 编译 | `default@HarCompileArkTS` | `library/Index.ets` + `src/main/ets/**` → `package/ets/modules.abc` + 各 `*.d.ets`（**源码不入包**） |
| ② C++ 交叉编译 | CMake（`externalNativeOptions.path`，`library/build-profile.json5:4-11`） | `src/main/cpp/node_bridge.c` → `intermediates/cmake/default/obj/arm64-v8a/libnode_bridge.so`；S6 再由 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` 落到 `<module>/libs/arm64-v8a/` |
| ③ 原生库处理 | `ProcessLibs` / `stripped_native_libs` | `intermediates/libs/default/arm64-v8a/` → `intermediates/stripped_native_libs/`（符号处理，release 保留口径见 §5.2） |
| ④ 组装 | `default@PackageHar` | 收 `Index.d.ets` + `README.md` + `oh-package.json5`(补元数据) + `ets/**` + `libs/<abi>/**.so` + `src/main/module.json` → `library.har`（**gzip tar**，`package/` 前缀） |
| ⑤ 签名 | `default@PackageSignHar` | 产出签名变体（库无签名主体时按无签名处理） |

**B. 产物核对（发布前门禁，必须**查包不查磁盘**）**

```bash
# ① HAR：当前 hvigor 产出的是 gzip 包裹的 tar（魔数 1f8b0800），先 gunzip 再 tar
python - <<'EOF'
import gzip, io, tarfile
raw = open('library/build/default/outputs/default/library.har','rb').read()
t = tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)))
names = t.getnames()
assert not any(n.endswith('libnode.so') for n in names), 'HAR 不得含 libnode.so'      # S10
assert any(n.endswith('libs/arm64-v8a/libnode_bridge.so') for n in names)             # FR-007-004
assert any(n.endswith('Index.d.ets') for n in names)                                  # S2
print(len(names), '条目', len(raw), 'B')
EOF

# ② HAP：`.so` 的 compress_type 期望 8（DEFLATE），当前实测为 0（未压缩）——见 §5.2 与 §9 第 8 项
python -c "import zipfile;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');print([(i.filename,i.compress_type) for i in z.infolist() if i.filename.endswith('.so')])"

# ③ HAP 内 libnode.so 必须是锁值（实测已成立）
python -c "import zipfile,hashlib;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');print(hashlib.sha256(z.read('libs/arm64-v8a/libnode.so')).hexdigest())"
#    期望 3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1
```

**C. 体积核对口径**（附录 C）：`libnode.so` 未压缩 126,809,264 B；HAR 441,353 B（gzip tar，含未压缩的 `libc++_shared.so` 1,262,504 B + 引导件 14,208 B）；HAP 侧压缩后 ≈44 MB 是**声明口径**，当前未达成（§5.2）。**不要把「库侧体积」与「应用载荷体积」合并估算**（附录 C 末注）。

### 6.3 错误处理：接入失败的四类典型错误与定位方法

| 症状（搜这个） | 真因 | 定位方法 | 处置（写进 README 的「排障」段） |
|---|---|---|---|
| HAP 里**没有** `libs/` 目录（构建不报错、功能不通） | CMake 没设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` | 查 `library/build/default/intermediates/libs/default/<abi>/` 是否有 `libnode_bridge.so`；再查 HAP | S6：产物落点固定为 `<module>/libs/${OHOS_ARCH}`（`CMakeLists.txt:10-11`） |
| `arkts-no-any-unknown` 编译失败 | 原生模块没接上类型 | 看报错是否指向 `libnode_bridge.so` 的 import | S1：只用 `cpp/types/libnode_bridge/index.d.ts` 环境声明，**不要**把 `.so` 当包内模块/相对路径 import |
| `00309001 Cannot import files from an external module using relative paths` | `useNormalizedOHMUrl: true` 下用源目录依赖 | 看 `oh-package.json5` 的依赖写法 | §3.4：改成 `file:` **`.har`**（先 `assembleHar`） |
| `Schema validate failed` | `compressNativeLibs` 写错位置 | 看写在哪：`build-profile.json5` ⇒ 错 | §5.9：写到 `module.json5` 的 **module 级**（schema 不会告诉你正确位置） |
| （附加）`dlopen` 失败、ArkTS 只拿到 `undefined` | 缺 `libc++_shared.so` 或未投放运行时 | `node.log` 里 `[node_bridge] dlopen(` 开头的行（`node_bridge.c:170`，会打印每个候选路径的结果或 `dlerror()`） | `provision.mjs --out <模块>/libs/arm64-v8a`；`--check` 先排 ELF |

### 6.4 性能

| 项 | 值 / 现状 |
|---|---|
| HAR 构建 | 增量构建秒级、全量依赖 ArkTS 编译 + CMake；本模块**不引入**新的构建步骤（发布门禁是脚本断言，不参与 hvigor 任务图）⚠️ 未单独计时（对照：探针工程 `assembleHap` **34 s** 🔶，§7.4） |
| 发布物体积 | HAR 441,353 B；HAP 库侧 121 MB（未压缩）/ ≈44 MB（压缩口径，⬜ 未达成） |
| 接入侧成本 | 第三方三步里只有「投放运行时」是重操作（126.8 MB 拷贝，`provision.mjs` 幂等 ⇒ 第二次跳过） |
| 运行期成本 | 本模块**零运行期开销**：只是包形态与文档；`Env`/`Logger`/`HostBridge` 均已存在（属 003/006） |

---

## 7. 测试考虑

### 7.1 可测点（默认不需要真机；真机项单独标注）

| # | 测点 | 命令 / 判据 | 现状 |
|---|---|---|---|
| T1 | `assembleHar` 成功 | `hvigorw --mode module -p module=library@default assembleHar --no-daemon` → 退出码 0 且 `library/build/default/outputs/default/library.har` 存在 | ✅ 产物已在 |
| T2 | **HAR 内容清单断言** | §6.2 脚本：**含** `Index.d.ets`、`libs/arm64-v8a/libnode_bridge.so`、`libs/arm64-v8a/libc++_shared.so`、`oh-package.json5`、`README.md`、`src/main/module.json`；**不含** `libnode.so`、任何内核文件名 | ✅ 27 条目已核对；⬜ 断言脚本未落地 |
| T3 | `module.json` 权限面断言 | 断言 `requestPermissions` 恰好 2 项、无 `definePermissions`、**无** `description` | ✅ 实测；⬜ 断言未落地 |
| T4 | 消费方 `assembleHap` 成功 + HAP 内两枚 `.so` | `libs/arm64-v8a/libnode.so`（SHA-256 = 锁值）与 `libs/arm64-v8a/libnode_bridge.so`（来自 HAR） | ✅ 实测（已签名 HAP 内核对通过） |
| T5 | HAP 内 `.so` 的 `compress_type` 断言（期望 8） | §6.2 ② | ⚠️ 实测 **0**（未压缩）⇒ 先修口径再加断言 |
| T6 | release native 符号保留断言 | `nativeLib.debugSymbol.strip=false` 生效 + `nativeDebugSymbol: true` | ⬜ 未做 release 实测 |
| T7 | `provision --check` 进 CI | 退出码 0；任一失败 `exit 2` | ✅ 本机门禁全过；⬜ 未接 CI |
| T8 | G11 审计 | 对 HAR 解包内容 + `library/` 全树检索 `wxjit\|LD_PRELOAD\|mremap\|fake_codesign\|Merkle` | ✅ 现为 0 命中；⬜ 未脚本化 |
| T9 | G3 审计 | 断言包内无内核文件；最大条目为 `libc++_shared.so` | ✅ |
| T10 | 许可清单存在性 | HAR 内含许可文件且条目覆盖 Node.js/V8/OpenSSL + 来源 + SHA-256 | ⬜（G4 缺口） |
| T11 | 版本矩阵一致性 | `library/oh-package.json5.version` ↔ 锁文件新增 `bridge.version` ↔ `BuildProfile.ets` 的 `HAR_VERSION` 三者一致 | ⬜（矩阵字段缺失） |
| T12 | 真机端到端（消费方或探针工程） | `payload/selfcheck.js` 起 `/facts`：`node`/`platform`/`arch`/`wasm.validate`/`fs_write_readback` 正确，且无 ACL 时 SIGTRAP（判据基线见 `tests/README.md:18-28`） | ✅ 消费方已跑通（JIT 生效） |

### 7.2 边界与异常

| # | 边界 | 期望行为 |
|---|---|---|
| E1 | **无签名材料**（仓库常态） | 产出**未签名**包，且 `hvigorfile.ts` 明确打印「本次构建产出未签名包」——**不静默**（`hvigorfile.ts:111-117`） |
| E2 | 换 Node 版本 | 只改锁文件；`--check` 必须重跑；库代码 0 改动（AC-007-11）；旧版本仍留在 `runtimes[]` 里便于回滚 |
| E3 | 换 ohpm scope / 包名 | 库代码 0 改动（只改 `library/oh-package.json5.name`）；但**消费方 ACL 与调试证书必须重做**（证书与 `bundleName` 绑定）⇒ 文档必须点明这两个不同性质的变化 |
| E4 | 消费方用不同 `libnode`（自建/自签） | 允许：只要求过 7 项门禁 + `--check` 与锁值一致；不一致时**必须显式改锁文件**（禁止「就地凑合」，§G.4） |
| E5 | 第三方离线 | `provision.mjs` 报三条出路并 `exit 2`（不静默降级）；镜像未建时明确说明（`runtime.lock.json:60` openItems） |
| E6 | 包内缺 `payload/` / 锁文件（现状） | 文档**不得**声称「随包」——当前必须在 README 里写清「这些在仓库里」（§3.5 修法落地前） |

---

## 8. 文件清单（真实行数 / 字节数，2026-10-16 实测）

| 路径 | 行 | 字节 | 本模块相关度 |
|---|---|---|---|
| `library/oh-package.json5` | 16 | 383 | ★ 包元数据（FR-007-001/010/015） |
| `library/Index.ets` | 21 | 1,083 | ★ barrel（8 个符号） |
| `library/README.md` | 56 | 3,152 | ★ 三步接入 + 已知限制（随包） |
| `library/.ohpmignore` | 17 | 772 | ★ 排除规则（S10） |
| `library/build-profile.json5` | 18 | 288 | ★ `abiFilters: arm64-v8a` + CMake 入口 |
| `library/hvigorfile.ts` | 6 | 229 | HAR 任务插件 |
| `library/src/main/module.json5` | 24 | 918 | ★ 权限面 + 无 `description` |
| `library/src/main/cpp/CMakeLists.txt` | 16 | 755 | S6/S7（落点与不链接） |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | 15 | 398 | S1（环境声明） |
| `library/src/main/cpp/types/libnode_bridge/oh-package.json5` | 6 | 151 | 声明包元数据 |
| `library/src/main/cpp/node_bridge.c` | 295 | 10,621 | 引导件实现（002） |
| `library/src/main/ets/runtime/NodeRuntime.ets` | 115 | 4,233 | 导出面 001 |
| `library/src/main/ets/runtime/Types.ets` | 49 | 2,036 | ★ 类型即契约（S3） |
| `library/src/main/ets/bridge/HostBridge.ets` | 46 | 1,957 | 导出面 003（骨架） |
| `library/src/main/ets/log/Logger.ets` | 53 | 1,763 | 导出面 006 |
| `library/src/main/ets/util/Env.ets` | 65 | 2,436 | 导出面 006 |
| `library/BuildProfile.ets` | 17 | 519 | `HAR_VERSION = 0.1.0`（构建期生成、**不入库**） |
| `runtime.lock.json` | 64 | 2,876 | ★ 版本矩阵事实源（⬜ 未随包） |
| `payload/bootstrap.js` | 64 | 3,010 | ★ 入口参考实现（⬜ 未随包） |
| `payload/selfcheck.js` | 84 | 2,732 | ★ `/facts` 端到端判据（⬜ 未随包） |
| `payload/README.md` | 21 | 1,228 | ⚠️ 声称「随库分发」（与实测不符） |
| `tools/provision.mjs` | 341 | 15,621 | ★ 包外投放工具（005） |
| `tools/elf-inspect.py` | 169 | 6,883 | 6 项 ELF 门禁（排障） |
| `tools/ohos-selfsign.mjs` | 291 | 12,711 | 仅独立分发（G5/G11 审计对象） |
| `README.md`（根） | 77 | 4,527 | ★ 三步接入 + 快速开始 |
| `LICENSE` | 21 | 1,086 | MIT（G4 的库侧部分） |
| `oh-package.json5`（根） | 8 | 378 | 根工程零依赖 |
| `build-profile.json5`（根） | 61 | 1,906 | ★ `useNormalizedOHMUrl: true` + `collectAllLibs` + 样例包名 |
| `hvigorfile.ts`（根） | 155 | 6,154 | 签名材料注入（无材料 ⇒ 未签名包） |
| `hvigor/hvigor-config.json5` | 11 | 119 | `modelVersion 6.1.1` |
| `AppScope/app.json5` | 14 | 417 | ★ 样例包名 `org.fellow99.nodebridge.sample`、API 17/24 |
| `AppScope/resources/base/element/string.json` | 8 | 99 | `app_name`（样例） |
| `signing.debug.local.json.sample` | 15 | 1,350 | 签名材料模板（仓库不含密钥） |
| `.gitignore` | 28 | 762 | ★ S10（二进制与签名材料不入库） |
| `samples/README.md` | 18 | 1,005 | ⬜ 样例未落地 |
| `tests/README.md` | 28 | 1,108 | ★ 判据基线 |
| `specs/constitution.md` | 163 | 9,885 | 治理 |
| `specs/README.md` | 25 | 1,196 | 编号表（本模块需在 Phase 2 改为「已补规格」） |
| **产物** `library/build/default/outputs/default/library.har` | — | **441,353** | ✅ 实测被测对象 |
| **消费方** `../pi-desktop-ark/entry/build/default/outputs/default/entry-default-signed.hap` | — | ≈129 MB | ✅ 端到端证据（含 3 枚 `.so`） |

---

## 9. Phase 2 / Phase 3 交付物清单（逐条 + 验收判据）

> Phase 2 归属（§8）：`007-distribution`（ohpm 包形态、版本矩阵、许可清单、接入文档）+ 样例；Phase 3（§8）：ohpm 首发 + 第三方许可清单 + 接入文档回归 + 真机回归基线。

| # | 交付物 | 阶段 | 验收判据（可证伪） |
|---|---|---|---|
| **1** | **第三方许可清单文件**（如 `library/THIRD-PARTY-NOTICES.md` / `NOTICE`） | Phase 2→3 | ① 文件存在且**在 HAR 内**（§6.2 断言）；② 覆盖 Node.js（MIT）、V8、OpenSSL、ICU、libuv、zlib/brotli 等（以 `runtime.lock.json` 的 `source`/`embeds` 为锚）；③ 每条给出**来源 URL + SHA-256**（引用锁文件，不复制）；④ `libc++_shared.so` 单独标注来源为 ohos-sdk（`runtime.lock.json:48-53`，**不固化哈希**）。**现状 ⬜（G4 ❌）** |
| **2** | **`payload/` 落点修法**（方案 A：`library/payload/` 同步副本；或方案 B：包外 + URL/SHA） | Phase 2 | 方案 A：`assembleHar` 后 HAR 内含 `payload/bootstrap.js` 与 `payload/selfcheck.js`（⬜ 先实测收集规则）；同步脚本比 SHA-256 且 CI 检查「两份一致」；`payload/README.md` 与 `.ohpmignore:3-4` 的措辞与事实一致。方案 B：README 给出 URL + SHA-256，且 §7.5 同步改写。**现状 ⬜** |
| **3** | **锁文件 / 投放工具线索随包**（`runtime.lock.json` 随 HAR 或渲染进随包 README） | Phase 2 | 第三方在**不读仓库**的前提下能拿到锁定版本 + SHA-256 + 门禁结论 + 投放命令（AC-007-009 闭合）。**现状 ⬜** |
| **4** | **版本矩阵 + 兼容矩阵机读化**（锁文件新增 `bridge`/`compat` 段，或独立 `compat.json`） | Phase 2 | ① 三条版本来源（`oh-package.json5.version` / `BuildProfile.ets:HAR_VERSION` / 锁文件）一致断言通过；② 矩阵含 `libnode` 下界 `>=22.19.0`、ABI `arm64-v8a`、`deviceTypes`、API 上/下界与「消费方必须 `useNormalizedOHMUrl` ⇒ 用 `.har`」的条件行。**现状 ⬜** |
| **5** | **样例工程 `samples/minimal-app` + `samples/arkweb-http`** 与 `build-profile.json5.modules[]` 注册 | Phase 2（§8） | ① 两个样例可独立 `assembleHap`；② `minimal-app` 装机后可起 Node 并在日志面板看到 `node.log` 尾；③ 样例依赖写 `file:<har>`（不用源目录）；④ `library/` 对 `samples/` **零反向依赖**（grep 断言）。**现状 ⬜（`samples/` 仅 README）** |
| **6** | **发布门禁脚本**（`tools/` 下新增「HAR/HAP 产物断言」，等价 §6.2） | Phase 2 | 一条命令跑完：HAR 清单断言（T2/T3/T10）+ `provision --check`（T7）+ G3/G11 检索（T8/T9）+ HAP `.so` 哈希与 `compress_type` 断言（T4/T5）；任一失败非零退出。**现状 ⬜** |
| **7** | **接入文档回归**（根 `README.md` + `library/README.md`） | Phase 2→3 | 三步 + 两种依赖写法 + 四类错误的排障段 + 「ACL 按自己包名成对声明」+ 「`useNormalizedOHMUrl` 必须用 `.har`」全部在文档里可复制执行；文档与 `.ohpmignore`/`payload/README.md` 的措辞与实测一致（当前有 2 处不一致，见 §3.5）。**部分 ✅** |
| **8** | **消费方打包口径回填 + 断言**（module 级 `compressNativeLibs`/`extractNativeLibs`；release `nativeLib.debugSymbol.strip=false`） | Phase 2 | 消费方 HAP 内 3 枚 `.so` 的 `compress_type = 8` 且 HAP 体积回到 ≈44 MB 口径（附录 C）；release HAR 的 `metadata.nativeDebugSymbol` 行为已复核并写进文档。**现状 ⚠️（实测 `compress_type = 0`）** |
| **9** | **ohpm 首发**（`@fellow99/node-bridge`） | Phase 3（§8） | ① `@fellow99` scope 归属确认（§9.3 第 1 项）；② `ohpm publish <har>` 成功后，第三方仅用 `"@fellow99/node-bridge": "0.1.0"` 即可 `ohpm install` + 构建通过（AC-007-01）；③ 发布前门禁（第 6 项）全过。**现状 ⬜** |
| **10** | **真机回归基线**（签名包哈希、首启耗时、包体） | Phase 3（§8） | 每次发版记录：签名 HAP 的 SHA-256、首启到 `/facts` 可用的耗时、HAP 体积与 `.so` 压缩状态；与上一版**可 diff**。**现状 ⬜** |
| **11** | 附：`tools/build-bridge.mjs` 的「引导件构建可复现」 | 归属 `002`（Phase 1，§7.4 ②） | 本模块消费它的产物（HAR 内 `libnode_bridge.so`）；未落地前，引导件只能在既有构建目录里取得 ⇒ 发布物「一条命令可复现」这条承诺不完整。**现状 ⬜（不属本模块，但影响 FR-007-011 的判据）** |
| **12** | 附：SPEC 索引更新 | Phase 2 | `specs/README.md:23` 的 `007-distribution` 行从「骨架」改为「已补规格（spec+plan）」。**已完成（本文件与 `spec.md`）** |
