# overall-plan.md —— `@fellow99/node-bridge` 整体技术方案

> **性质**：项目级**实现计划**（怎么做、按什么顺序做、合规如何逐条对齐、跨切面怎么处理）。
> **上位约束**：`specs/constitution.md`（C1–C7 / S1–S10 / G3/G4/G5/G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）。本文引用其 § 号，不复制其正文。
> **标记**：✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突或风险。
>
> ⚠️ **引用基准**：源文件行号取自 **2026-10-16 成稿快照**（`node_bridge.c` 295 行 / ArkTS 侧 5 个文件共 328 行）；此后 `cpp/` 与 `ets/` 均有**并行实现**推进 ⇒ **以函数名 / 类名为准**。本文 §2 的合规结论按**当时快照**给出，若与最新代码不符以代码为准。
> **版本**：v1.0 · 2026-10-16 · 状态：**Phase 0 已完成、Phase 1 未开工**。

---

## 1. Technical Context

### 1.1 运行环境（目标）

| 项 | 值 | 证据 |
|---|---|---|
| 设备类型 | `2in1` / `tablet`（**不做 phone**） | `library/src/main/module.json5:5-8` ✅ / 规划 §1 |
| 芯片/ABI | `arm64-v8a`（**不做 x86_64**） | 模块 `build-profile.json5:8-10` ✅ / `runtime.lock.json:62` |
| 真机基线 | HAD-W32 / HarmonyOS **6.1.0** / **API 26** / arm64-v8a | `runtime.lock.json:44` ✅ + 规划 §D.8/§D.9/§D.10 |
| 工程 SDK 声明 | `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)` | 根 `build-profile.json5:23,26` ✅ ⚠️（与设备 API 26 是**两个数**，不可混用，见 TECH §5） |
| 宿主进程模型 | Node 跑在**宿主应用自己的进程**内（无子进程、无守护） | 规划 §4.6 路线 A / §5.2 |
| 刚性前置权限 | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（`system_basic` / API 14+ / 仅平板+2in1 / `system_grant`）—— **由消费方按自己的包名申报** | 规划 §9.4 + §D.8（无它即 SIGTRAP）+ §D.10（消费方真机已达成）✅ |

### 1.2 关键依赖与版本

| 依赖 | 版本/标识 | 锁定位置 |
|---|---|---|
| Node 运行时 | **v24.2.0**（`SONAME libnode.so.137`，`modules=137`，120.9 MiB，SHA-256 `3019bf5f…51a1`） | `runtime.lock.json:3,7,11-13` ✅ |
| C++ 运行时 | `libc++_shared.so`（从 ohos-sdk 取，**不固化哈希**） | `runtime.lock.json:48-53` ✅ |
| NAPI / hilog | `libace_napi.z.so` / `libhilog_ndk.z.so` | `library/src/main/cpp/CMakeLists.txt`（`target_link_libraries`）✅ |
| 构建 | DevEco Studio 6.1 / hvigor（`@ohos/hvigor-ohos-plugin`）/ CMake ≥ 3.5.0（工具链实测 3.28.2）/ C11 + `CMAKE_C_EXTENSIONS ON` + `_GNU_SOURCE` | `CMakeLists.txt` ✅ |
| host 侧工具 | Node ≥ 24（`provision.mjs`、`ohos-selfsign.mjs`）· Python 3（`elf-inspect.py`，仅排障） | `tools/` ✅ |
| 库版本 | `@fellow99/node-bridge` **0.1.0**（骨架） | `library/oh-package.json5:3` ✅ |

### 1.3 已闭环的平台事实（方案的基石，全部一手）

| # | 事实 | 等级 |
|---|---|---|
| 1 | 进程内 `dlopen` + `node::Start` **可行**（Node v24.2.0 在 App 进程内跑通，`platform=openharmony`/`arch=arm64`） | ✅ 规划 §D.8 |
| 2 | **无 ACL 即 SIGTRAP**；声明开放权限**不能**替代 ACL ⇒ ACL 是刚性前置 | ✅ 规划 §D.8（O10 关闭） |
| 3 | **ACL 生效后 JIT 可用**（`wasm.validate=true`，热循环 6–9 ms/2e6） | ✅ 规划 §D.10 |
| 4 | `--jitless` 下 **WebAssembly 全废**（`WebAssembly is not defined`、`fetch` 失败、热循环 ≈299 ms/5 轮） | ✅ 规划 §D.8 |
| 5 | **HAP 内原生库不需要 `.codesign`**（无签名段的产物 `dlopen` 成功，`hilog` 中 `xpm`/`unsigned file` 0 命中） | ✅ 规划 §D.6/§D.9（R22 关闭） |
| 6 | `dlopen` **只认裸名**；`execPath=/system/bin/appspawn`；`cwd=/`；`os.cpus()` 长度 0 | ✅ 规划 §D.8 偏差表 |
| 7 | 端口冲突 ⇒ 载荷未捕获异常 ⇒ **整个 App 进程 abort**；`dup2` 的日志会混入 ArkWeb 原生输出 | ✅ 规划 §D.10 ⑰⑱ |

---

## 2. 宪法合规检查（逐条）

### 2.1 七条治理原则（C1–C7）

| 原则 | 判定 | 理由（含证据） | 待处置 |
|---|---|---|---|
| **C1 库/壳分离** | ✅ **符合** | 库侧 ArkTS/原生代码零应用语义 ✅；`module.json5` 只有 2 条开放权限，并明文把 ACL 留给消费方 ✅；✅ 2026-10-17：随库分发的 `payload/bootstrap.js` 的 `PI_WEB_ENTRY` 兼容别名**已删除**（入口只认 `NODE_BRIDGE_ENTRY`，C1 / FR-004-020） | 保持：评审按「是不是宿主语义」一票否决 |
| **C2 不隐藏平台真相** | ✅ **符合（2026-10-17 补齐）** | 未注册能力返回结构化 `{"ok":false,"error":"unregistered"}` ✅（`HostBridge.ets`）；处理器抛错也结构化 ✅；`provision.mjs` 门禁不过即 `exit 2` ✅；C 侧 `stage()`/`lastError()` 写入所有原生失败路径 ✅；**ArkTS 侧已接线**：`getStage()`/`getLastError()` 可读，原生错误非空时置 `failed`（`NodeRuntime.ets`）✅ | 剩余：版本下限（`>=22.19.0`）无 warn ⬜ |
| **C3 让最终使用者去读** | ✅ **符合** | 读回通道齐备：`Logger.tail()`（不抛）✅、自检 `/log` 端点 ✅；✅ 2026-10-17：`payload/bootstrap.js` 已实现 **Node 自解包（`zlib`+`fs`，含 `skipped` 计数）** + `.ready-<sha256 前 12 位>` 幂等 marker + `uncaughtException`/`unhandledRejection` 兜底写 `app.log`（谁写谁读闭环） | 保持 |
| **C4 启动参数不可事后修改** | ✅ **符合** | `flags` 一次性传入（`NodeRuntime.ets:76,82`），公共 API 无追加参数入口；`--jitless` 在类型注释中被明确定位为「无 ACL 的兜底/诊断」（`Types.ets:20-23`）；原生层在启动前一次性切词（`bootstrap()` / `split_next()`） | 保持；评审时检查任何新 API 不得引入 push |
| **C5 单例与不可重启** | ⚠️ **部分符合** | 单例 + 幂等保护 ✅（`NodeRuntime.ets:26-31,62-69`，返回结构化失败并带当前状态）；无看门狗/自动重启 ✅。**缺口**：`markFailed` 只落状态与一条 hilog，**不保留「首次失败原因」结构**（`NodeRuntime.ets:108-114`）；`failed` 未携带 `stage` + 原始错误/信号（规划 §5.2 要求） | Phase 1：`failed` 载体扩展（stage / signal / 原始错误） |
| **C6** 诊断优先于修码 | ✅ **符合（2026-10-17 补齐）** | 崩溃 handler 记录 `CRASH …` ✅ 且写 `<HOME>/node-bridge/last-crash.json`（+ `hint` 阶段提示）✅；`/facts` 16 键自检 ✅；双日志通道 + pipe 排空 ✅；**ArkTS 侧已实现 `lastCrash()`（含降级）与 `logs()`/`logRingSize`** ✅；仅内存日志环未做 | 保持；`--inspect` buildMode 门禁 ⬜（Phase 1 收尾） |
| **C7** 零上游补丁 / 二进制可替换 | ✅ **符合** | 引导件**不链接** libnode（`CMakeLists.txt`）⇒ 换版本只需改 `runtime.lock.json` 一行；供应链纪律齐备（`source` + `sha256` + `license` + `verifiedOn/verifiedDevice/verifiedNotes`）✅；七项门禁把「PIE 产物」做成硬失败 ✅；未对上游打任何补丁 ✅ | 保持；新增运行时必须走锁文件 + 门禁 + 真机复验（宪法 §六变更流程 2） |

### 2.2 十条代码规约（S1–S10）

| 规约 | 判定 | 现状与证据 |
|---|---|---|
| **S1** ArkTS 严格模式；原生模块只经 `.d.ts` 接入 | ✅ **符合** | `Types.ets` 无 `any`/`unknown`；原生模块经 `cpp/types/libnode_bridge/index.d.ts` 声明后以裸名 import（`NodeRuntime.ets:2`）——与规划 §7.2「不要把 `.so` 当包内模块导入」的意图一致（走 hvigor 的 CMake+ProcessLibs 流程 + 环境声明） |
| **S2** barrel 唯一出口 | ✅ **符合** | `Index.ets:16-21` 导出 8 个符号（`NodeRuntime` / `NodeState` / `NodeRuntimeOptions` / `NodeStartResult` / `HostBridgeHandler` / `HostBridge` / `Logger` / `Env`）；新增公共 API 必须同改 `Index.ets` 与 `Types.ets` |
| **S3** 类型改动即破坏性变更 | ✅ **符合** | `Types.ets:4` 文件头明文声明契约属性 |
| **S4** 路径一律绝对（不依赖 `cwd`/`execPath`） | ⚠️ **部分符合** | 库侧全部用 `context.*Dir` 与 `Env` 拼绝对路径 ✅（`Env.ets:15-27`、`NodeRuntime.ets:73-75`）；`payload/bootstrap.js:27-28` 明确注释两者不可依赖 ✅。**缺口**：规划 §5.5 的「`cwd` 选项」⬜ 未实现（当前无 `cwd` 设置入口） |
| **S5** 信号上下文禁用 stdio | ✅ **符合（2026-10-17 修复）** | `sigsys_handler` 只做寄存器操作 ✅；`crash_handler` 已改为手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` 拼栈缓冲 + **单次 `write()`**，handler 区间 **0 命中** `printf`/`snprintf`/`vsnprintf`/`OH_LOG_Print`/`malloc`/`getenv`（`vsnprintf` 只在非信号路径 `log_line()`）；`sig_name`/`stage_hint` 只剩纯比较 | 保持（改 handler 必须重跑静态审查） |
| **S6** native 产物落点固定 | ✅ **符合** | `CMakeLists.txt` 显式设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` → `<module>/libs/${OHOS_ARCH}`；HAR 实测含 `package/libs/arm64-v8a/libnode_bridge.so`（14,208 B，**为 Phase 0 骨架构建产物**）✅ |
| **S7** 引导件不链接 libnode | ✅ **符合** | `CMakeLists.txt` 的 `target_link_libraries(node_bridge PUBLIC libace_napi.z.so libhilog_ndk.z.so)`（Phase 1 另加 `_GNU_SOURCE` 定义与 `CMAKE_C_EXTENSIONS ON`） |
| **S8** C 侧接口保持极窄（初版 3 个） | ✅ **符合（已按扩展口径执行）** | `Init()` 现注册 **5 个**：`start`/`isRunning`/`version`/`lastError`/`stage`；`index.d.ts` **已同步**（含 `start()` 第 6 参 `envPairs`）⇒ 满足「扩展必须同时改 `.d.ts`」 |
| **S9** 日志双通道；文件读取失败返回占位串不抛 | ⚠️ **部分符合** | C 侧已升级为 `write_line()`/`raw_write_fd()`：**hilog + 单次 `write()` 到常开日志 fd**（`O_APPEND`，行格式 `<stream> <epochMs> <text>`），由独立 reader 线程持续排空 ✅；ArkTS `Logger.tail` 失败返回 `'(read log failed: …)'` ✅（`Logger.ets:49-51`）。**缺口**：ArkTS 侧 `Logger.info/warn/error` **只进 hilog、不落盘** |
| **S10** 二进制不入库 | ✅ **符合** | `.gitignore:19-24`（`**/libnode.so`、`**/libc++_shared.so`、`library/libs/`、`library/src/main/libs/`、`*.har`）；`library/.ohpmignore:11`；`git ls-files` 无任何 `.so` ✅ |

**结论**：**0 条严重违背原则（C1–C7 无 ❌）· 0 条规约明确违背（S5 已由 ⚠️ 转 ✅）· 少量规约仍在收敛（如 S4 的 `cwd` 选项、S9 的 ArkTS 侧落盘）**。合规检查的完整待办清单见 §3.5。

---

## 3. 实现策略总览

### 3.1 Phase ↔ 模块编号 ↔ 现状

| Phase | 目标 | 模块（规划 §7.3） | 现状 |
|---|---|---|---|
| **Phase 0** 可行性探针（不写业务逻辑） | 把结构性未知一次问清 | 库侧 P0-1/P0-2/P0-5/P0-6/P0-7/P0-8/P0-9/P0-11/P0-13/P0-14 | ✅ P0-1/P0-2/P0-6/P0-7/P0-14 已答；⬜ P0-5（自解包，首选路线已改零解压故降级）/P0-8（HAR 带 .so，不影响设计）/P0-9（调试通道）/P0-11（Addon 符号可见性）/P0-13（零解压载荷）。⚠️ 出口判据要求的 `docs/能力矩阵.md` **未产出** |
| **Phase 1** 最小可用运行时（MVP） | 真机上稳定跑起真实服务端 + 最小观测面 | `001-runtime-core` · `002-napi-bootstrap` · `004-payload-bootstrap` · `006-observability`（**不含桥**） | 骨架：`001` 部分、`002` 骨架闭环、`004` 只有参考实现、`006` 部分 |
| **Phase 2** 库完备 | 桥 + 获取/校验三件套 + 分发骨架 + 样例 | `003-host-bridge` · `005-provision-verify` · `007-distribution` · `samples/*` | `005` ✅ 已实现并实测；`003` 纯 JS 骨架；`007` 骨架；`samples` 只有 README |
| **Phase 3** 分发与合规 | ohpm 首发 + 许可清单 + 回归基线；自建运行时为并行可选项 | `007` 收口 · `tools/rt-build/` | ⬜ 未开工 |

### 3.2 Phase 1 的六个出口判据 → 实现项映射

| 判据（规划 §8 Phase 1） | 要做的实现 | 落到哪个文件 |
|---|---|---|
| ① 自检载荷与消费方载荷都能起 | 载荷入口解析 + `resfile` 只读直读路径（绝对路径） | `payload/bootstrap.js`、`004` |
| ② 状态机与日志环在 ArkTS 可见 | 有界日志环 + `logs()`；`stopping/stopped` | `library/src/main/ets/log/Logger.ets`、`runtime/NodeRuntime.ets` |
| ③ 崩溃记录可读 | `last-crash.json` 落盘 + `lastCrash()` 读取 | `library/src/main/cpp/node_bridge.c`（写）+ ArkTS（读） |
| ④ 载荷就绪幂等（二次启动跳过） | 摘要 marker + 命中即跳过 | `payload/bootstrap.js`（`004`） |
| ⑤ release 构建无 `--inspect` | buildMode 判定的开关门禁 | `runtime/NodeRuntime.ets`（按 `BuildProfile`） |
| ⑥ 落实 §5.10 ⑰⑱ | 随机端口（消费方载荷约定）+ 载荷异常兜底 + stdio 改 pipe + 独立 reader 线程 | `payload/bootstrap.js` + `library/src/main/cpp/node_bridge.c` |

### 3.3 Phase 1 顺带必须修的「存量缺陷」（来自 §2 合规检查）

| # | 缺陷 | 文件:行 | 修法 |
|---|---|---|---|
| 1 | ✅ **已修（2026-10-17）**：S5 口径复核 —— 崩溃 handler 曾用**栈上 `snprintf`** | `crash_handler()` / `u64_to_dec()` / `u64_to_hex()` | 已改为纯手写转换（十进制 + 十六进制） + `lb_append*` + 单次 `write()`；handler 区间 0 命中 stdio/malloc/getenv |
| 2 | ✅ **已修（2026-10-17）**：C1 越界 `PI_WEB_ENTRY` | `payload/bootstrap.js` | 兼容别名已删除；入口只认 `NODE_BRIDGE_ENTRY`，应用语义由 `env` 传入（C1 / FR-004-020） |
| 3 | ⑱ 不符合：只有顶层 `try/catch` | `payload/bootstrap.js:59-64` | 增加 `process.on('uncaughtException'/'unhandledRejection')` + 独立日志通道 |
| 4 | ✅ **已修（2026-10-17）**：C2 缺口 —— C 侧 `stage()`/`lastError()` 探针已接入状态机 | `NodeRuntime.ets` | `getStage()`/`getLastError()` 可读，原生错误非空即置 `failed`（并写 `node.log`）；不再依赖探活超时 |
| 5 | ✅ **已定案（2026-10-17，文档化偏差）**：默认 `flags` = `--no-verify-heap`（真机验证值、最小可用集） | `NodeRuntime.ets`、`js_start()` 的空值兜底 | `--expose-internals` **仅当载荷走 internal-module stub 路线**时必需，由消费方经 `flags`/`execArgv` 显式传入；规划 §5.3 草案默认值被取代（B5/R2） |
| 6 | ✅ **已在消费方落地（2026-10-17，B4/R2）**：压缩开关 | 消费方 `pi-desktop-ark/entry/src/main/module.json5`（module 级 `compressNativeLibs: true` + `extractNativeLibs: true`）；库自身 `library/src/main/module.json5` 不声明（HAR 不产 HAP，由消费方模块决定） | 实测（2026-10-17）：签名 HAP **46,031,244 B**，三个 `.so` 全部 `compress_type=8`（DEFLATE；此前 129,535,202 B / 全 0） |
| 7 | 版本下限无 warn | `NodeRuntime.ets` / 原生层 | 启动后校验 `process.version >= 22.19.0` 并可见告警 |
| 8 | C5 缺口：失败原因不结构化 | `NodeRuntime.ets:108-114` | `FailedDetail{stage, signal?, rawError?}` |
| 9 | 工作区把签名材料写进受版本控制的构建配置 | 根 `build-profile.json5:5-19` | 还原为 `signingConfigs: []`，改用 `signing.<mode>.local.json`（`hvigorfile.ts` 已支持） |

### 3.4 依赖顺序（不可并行者）

```
① S5 修复 + module.json5 压缩开关 + 默认 flags 统一      ← 无依赖，先做（改动小、影响大）
② 004 载荷引导（只读直读 → 自解包 → 幂等 marker → 入口解析）
        └─ 依赖 ⑥ 的 stdio 改造？否；但②的「Node 读回」判据依赖 006 的日志通道可见
③ 006 观测（日志环 + lastCrash + stdio pipe/reader）      ← 必须先于 ②的验收（C6：先建观测）
④ 001 状态机收口（stopping/stopped、waitUntilRunning、失败态结构化）
⑤ 003 桥（threadsafe_function + 超时 + capBytes）         ← 依赖 001 的状态与 006 的日志
⑥ 007 分发（HAR 内容对齐 §7.5、许可清单、版本矩阵）
⑦ 005 已实现 → 只需在 Phase 3 补「换版本时的复验流程」与镜像 Release
```

> **纪律（C6）**：③ 未完成前，②／④ 的任何「成功」都不算验收通过——因为看不见。

### 3.5 合规检查的收敛条件（Release Gate）

| 检查项 | 收敛条件 |
|---|---|
| C1 | `payload/` 与 `library/` 内不出现任何应用特有标识（含变量名、注释里的产品名以外的引用） |
| C2 | 平台缺口都有能力标志或结构化错误；无任何吞掉失败的 `catch` 返回空值 |
| C3 | 所有「写成功」的判据都换成「最终使用者读一遍」 |
| C4 | 公共 API 中不存在运行期改启动参数的入口 |
| C5 | 失败态可读且无重启路径 |
| C6 | 每条新能力都附一条真机可执行的观测命令 |
| C7 | 门禁全过 + 锁文件字段齐备 + 无上游补丁 |
| S1–S10 | 全部 ✅（S5 修复后） |
| G3 | 包内文件清单只含运行时 + 引导件 + JS 载荷 |
| G4 | 第三方许可清单随包 |
| G5 | HAP 内不要求逐件签名（已实测）；`--sign` 只服务独立分发 |
| G11 | 发布物与发布分支中不存在路线 J′ 相关实现 |

---

## 4. 跨切面关注点

### 4.1 错误处理

| 层 | 策略 | 依据 |
|---|---|---|
| ArkTS 公共 API | 不用异常表达业务失败：`NodeStartResult{ok,code,state,message}`；桥的 `dispatch` **永不抛**（未注册/处理器抛错都返回结构化 JSON） | `Types.ets:36-46`、`HostBridge.ets:31-45`、C2 |
| 原生层 | 失败写日志 + `set_error()`/`set_stage()`（ArkTS 可经 `lastError()`/`stage()` 读）+ 返回错误码（`pthread_create` 的 rc 直接回传 ArkTS）；**不得**把 C 异常穿透到 ArkTS | `js_start()` / `bootstrap()` |
| host 侧工具 | 硬失败 `exit 2`，错误消息给出**三条明确出路**（本地放置 / `--from` / `--download`），绝不就地找替代品 | `provision.mjs:49,258-266`、附录 G.4 |
| Node 侧载荷 | 顶层兜底 + （待补）异步异常兜底 + 独立日志通道；**不刻意 `process.exit`**，保持现场供原生层记录 `node::Start` 返回值 | `payload/bootstrap.js:59-64`（⬜ 补齐 ⑱） |
| 失败可见性口径 | 任何「失败」都要能被调用方看见：结构化错误 / 日志 / 状态机三者至少其一 | C2 |

### 4.2 日志

| 通道 | 写方 | 读方 | 现状 |
|---|---|---|---|
| hilog（DOMAIN `0xD0033` / TAG `NODE_BRIDGE`；**C 侧同为 `0xD0033`**，A1/R2） | ArkTS `Logger` + C `log_line` | `hdc shell hilog`（级别需能进 dump 缓冲） | ✅ |
| 文件日志 `<filesDir>/payload/node.log` | C 侧 `raw_write`（信号安全）+ stdio `dup2` | ArkTS `Logger.tail()`、自检 `/log` | ✅ ⚠️ 会混入 ArkWeb 原生输出（⑱） |
| 有界日志环（默认 500 行） | ArkTS（规划） | `logs()` → 界面诊断面板 | ⬜ Phase 1 |
| 崩溃记录 `last-crash.json` | 原生 handler（规划） | `lastCrash()` | ⬜ Phase 1 |

**纪律**：关键信息必须双通道（S9）；日志读回失败返回占位串而不抛（S9/C3）；**不得**用「hilog 里有没有那行」判执行（C6）。

### 4.3 观测

四条真机通道（缺一不可）：`snapshot_display` 截图 · `uitest uiInput` 点按（**判定用前后两次 `dumpLayout` 差异**）· `hdc rport` + 端上 POST 回传 · `hdc fport` + `curl` 端到端。库侧已实现其中最强的一条（`/facts`）+ `/log`（规划 §2.3 / §5.7）。**三条禁止的判据**见 `overall-test-cases.md` §4。

### 4.4 安全 / 权限（ACL）

| 项 | 策略 |
|---|---|
| 库声明面 | 只声明自己确实需要的开放权限（INTERNET、GET_NETWORK_INFO）✅；**不照抄旧壳 21 条** |
| ACL | `ALLOW_WRITABLE_CODE_MEMORY` 由**消费方按自己的包名**申报（换包名必须重新申报）；获批后创建/重建 **Profile**（Profile 不含 ACL 时 `hdc install` 直接被拒，已实测 `code:9568289`） |
| 本库不申请 | 二进制证书（`certType:4`）、`ALLOW_EXTERNAL_NATIVE_CODE`、`kernel.LOAD_INDEPENDENT_LIBRARY`、`CUSTOM_SANDBOX`/`RUN_ANY_CODE` 等 —— 本库不分发自有**可执行** ELF |
| 调试通道 | `--inspect` **只在 debug 构建**；release 必须关闭（旧壳 R7：默认开启等于把宿主交出去）⬜ 门禁待实现 |
| 桥的边界 | 只回传沙箱内**路径**不回传内容；单次载荷上限默认 8 MiB；选择器不走内容通道 |

### 4.5 崩溃取证

| 项 | 现状 |
|---|---|
| 内核级证据 | 6 类信号 handler；日志内 `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…` **且** 写 `<HOME>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`）✅（`crash_handler()`） |
| 系统侧证据 | `hdc shell hilog -x \| grep -E "node-bridge\|Cpp Crash"`；进程内 Node 崩溃系统会判 `Cpp Crash` 杀进程 ✅（§D.8 ①） |
| 结构化记录 | ✅ 两侧齐备：**C 侧写** `<HOME>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`）✅；**ArkTS 侧 `lastCrash()` 读取接口已实现**（含 JSON 损坏时从日志尾 `CRASH` 行降级重建，`NodeRuntime.ets`）✅ |
| 符号 | release **保留 native 符号**（`nativeLib.debugSymbol.strip=false`，规划 §5.10 ⑬）⬜ 待确认工程配置 |
| UX 契约 | 崩溃是终态 ⇒ 只允许「读日志 / 读崩溃记录 / 提示重启应用」（C5） |
| 已知最易混淆的一条 | 端口冲突导致的载荷未捕获异常会让**整个 App 进程** abort（崩溃栈含引导件）⇒ 必须靠 ⑰⑱ 预防，而不是靠崩溃取证事后追（§D.10） |

### 4.6 体积

| 控制点 | 做法 | 现状 |
|---|---|---|
| 运行时压缩 | `module.json5` **module 级** `compressNativeLibs` + `extractNativeLibs` | ⬜ 未落（⚠️ 前提缺失） |
| 核对口径 | **查 HAP 的 `compress_type == 8`**，不查磁盘；点文件被 hvigor 排除是正常行为 | 方法已固化 ✅ |
| 二次 strip | 不做（Node 官方产物已 strip，收益 0） | ✅ |
| 预算 | 库侧增量 ≈44 MB（`libnode.so` DEFLATE ≈43 MB + 引导件 14 KB + `libc++_shared.so` ≈0.4 MB + JS < 100 KB） | ⚠️ 待真实签名 HAP 复核 |
| 不要合并估算 | 应用载荷体积（首个在册消费方 ≈884 MB 未压 / 156.6 MB 压后）是**另一笔账**，属消费方 | 规划附录 C 口径 ✅ |

---

## 5. 测试策略

### 5.1 分层

| 层 | 内容 | 是否需要真机 | 现状 |
|---|---|---|---|
| **L1 host 侧门禁** | 七项 ELF 门禁 + SHA-256/大小 + 投放幂等 + 篡改即失败 | 否 | ✅ 已实现（`provision.mjs --check`） |
| **L2 host 侧单元** | 载荷解包（Node 自己解包 → 读回）、桥的 JSON 契约、入口解析（CJS/ESM） | 否 | ⬜ Phase 1（`tools/smoke-host.mjs`） |
| **L3 真机自检** | 自检载荷 `/facts` + `/log`，与基线数值比对 | 是 | ✅ 载荷已可用；库侧待 Phase 1 复跑 |
| **L4 真机端到端** | 真实消费方载荷（起服务 → 宿主 Web 容器加载 → 探活） | 是 | ✅ 已由消费方在真机跑通一次（规划 §D.10）；库侧回归 ⬜ |
| **L5 回归基线** | 签名 HAP SHA-256、首启耗时、包体、`/facts` 快照 | 是 | ⬜ Phase 3 |

### 5.2 判据来源

每条判据必须**可证伪**，并来自以下之一：① 规划某 § 的出口判据；② `runtime.lock.json` 的锁定值；③ 真机一次运行的 `/facts` 输出；④ HAP 内的 `compress_type`。用例索引见 `overall-test-cases.md`。

### 5.3 证据纪律

`🔶沿用` 的结论**不得**作为对外承诺的依据（鸿蒙生态里「声明存在」≠「设备可用」）；凡涉及运行时可见性的结论，**观测点必须在应用域**（沙箱日志连 debug 签名也不让 `hdc` 读）。证据随用例记录在真机验证记录里（`docs/真机验证记录.md` ⬜ 未产出 ⇒ 当前证据散落在消费方 `docs/evidence/`）。

---

## 6. 分发策略

### 6.1 发布物形态

| 项 | 设计 | 现状 |
|---|---|---|
| 组件包 | `@fellow99/node-bridge`（HAR）：ArkTS 源码 + 引导件源码/types + **Node 侧参考脚本** + **锁文件** + **投放工具** | ⚠️ 实测 HAR **不含** 后三者（见 STRUCTURE §8.1）；且实测 HAR **含** `libc++_shared.so`（1.26 MB）——比规划多、也比规划少 |
| 运行时 | **不随包**，由消费方在构建流水线跑一次投放 | ✅ 工具就绪 |
| 版本 | 语义化版本；组件包版本 ↔ 运行时版本矩阵固化在锁文件 | ✅ |
| 许可 | 本库 MIT；随包分发运行时时附第三方许可清单 | ⚠️ 清单缺口 |
| 兼容矩阵 | `node-bridge vX.Y` × `libnode 22.19+/24.x` × `API 17+/24/26` × `devices 2in1/tablet` | ✅（规划 §7.5） |

### 6.2 消费方接入三步（分发侧的验收基线）

1. `oh-package.json5` 加依赖（`file:../ohos-node-bridge/library` 或版本号）；
2. 投放运行时：`node ohos-node-bridge/tools/provision.mjs --out <模块>/libs/arm64-v8a`；
3. 按**自己的包名**申请并声明 ACL，并把开放权限合进自己的 `module.json5`。

**三步都要在消费方侧留一条可证伪的验收**（依赖解析成功 / 投放后 `libnode.so` 的 SHA-256 = 锁值 / ACL 生效后 `/facts` 报 `wasm.validate=true`）。第 3 步已由消费方真机达成（规划 §D.10）✅。

### 6.3 版本演进（附录 G.6 三条路线）

| 路线 | 何时启动 | 要做的事 | 现状 |
|---|---|---|---|
| **A 现状**（本地目录 + 锁文件） | 默认 | 本机/内网跑投放，离线可用 | ✅ |
| **B 公开镜像** | 第三方需要自取产物时 | 新建镜像 Release，资产逐字节复制 + `SHA256SUMS`，回填 `lock.runtimes[].mirror` | ⬜ `mirror.kind = null`（`openItems[0]`） |
| **C 自建配方** | 需要非 v24.2.0 版本 / 供应链必须自控 | 按附录 D 配方（`--shared`、V8 maglev release 补丁 + `-DNDEBUG`、版本补丁、`-fno-emulated-tls`、`llvm-strip` → 自签）；配方 vendor 进 `tools/rt-build/` | ⬜ 未落地（2026-10-16 决策延后） |

### 6.4 变更流程（宪法 §六，落实为可执行步骤）

| 触发 | 必须做的事 |
|---|---|
| 改公共 API（`Index.ets` / `Types.ets`） | 同步改 `specs/README.md` 编号表 + 受影响模块 `plan.md`；提语义化版本 |
| 改 `runtime.lock.json`（换运行时版本） | 重跑 `provision.mjs --check` + 真机 `/facts`，并把 `verifiedOn`/`verifiedDevice` 写回 |
| 新增平台结论 | **先**写进 `docs/000-工程规划.md`（唯一权威），规格文档只引用 § 号，不复制粘贴 |

### 6.5 发布前的最终检查清单（库侧）

- [ ] `node tools/provision.mjs --check` 全过（七项门禁 + SHA-256）
- [ ] `assembleHar` 产物清单核对（引导件在 `libs/`、无 `libnode.so`、`payload/` 与锁文件是否按 §6.1 决策放入）
- [ ] 真机 `/facts` 与基线一致（版本/平台/架构/`wasm.validate`/热循环）
- [ ] HAP 内 `.so` 的 `compress_type == 8`，体积增量 ≈44 MB
- [ ] 第三方许可清单随包（G4）
- [ ] 发布物中不存在路线 J′ 相关实现（G11）
- [ ] 仓库内无密钥/签名材料（`git status` 干净、`build-profile.json5` 无内联 `signingConfigs`）
