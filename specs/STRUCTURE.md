# STRUCTURE.md —— `ohos-node-bridge` 目录与文件结构（as-built）

> **性质**：项目级结构规格（现状快照 + 规划落点）。本文件只描述「文件在哪、干什么、进不进 git/包」。
> **依据**：`specs/constitution.md`（治理原则 C1–C7 / 规约 S1–S10 / 红线 G3/G4/G5/G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）· 本仓库工作区实际文件清单 ✅实测。
> **版本**：v1.1 · 2026-10-16 成稿 / **2026-10-17 校订** · 状态：Phase 0 已完成；Phase 1 的 `001`/`002`/`003`/`004`/`006` 已落地（并行实现），真机验收仍待做。
> **标记**：✅实测（本仓库可复核）/ 🔶沿用（外部一手记录）/ ⬜待验证 / ⚠️冲突或风险。
>
> ⚠️ **引用基准**：文中的源文件行号最初取自 **2026-10-16 成稿快照**；**2026-10-17 实测校订**为
> `NodeRuntime.ets` **798 行** / `Types.ets` **159 行** / `HostBridge.ets` **231 行** / `Logger.ets` **198 行** / `Env.ets` **92 行** / `node_bridge.c` **924 行** ⇒ **以类名 / 函数名 / 成员名为准，行号仅作定位线索**。
>
> **一句话边界**：`library/` 是**唯一产品**（HAR，发布到 ohpm）；`payload/` `tools/` `specs/` `tests/` `samples/` `docs/` 是**配套物**，彼此不反向依赖（规划 §7.2 纪律）。

---

## 1. 顶层目录树（2–3 层，逐文件一行用途）

```
ohos-node-bridge/                       # pi-workspace 的 submodule；工程根 == DevEco 工程根
├── README.md                           # 库总览：定位/六 API 面/三步接入/四条已实测限制
├── LICENSE                             # MIT（本库自身）；随包分发的 Node 运行时许可另计（G4）
├── runtime.lock.json                   # ★ 运行时唯一事实源（入库）：active + 版本 + SHA-256 + 七项门禁 + 真机记录
├── oh-package.json5                    # 工程级 ohpm 元数据（modelVersion 6.1.1；deps 刻意留空 ⇒ 离线可构建）
├── build-profile.json5                 # 工程级构建配置：products(API 17/24) / modules[] / signingConfigs ⚠️见 §8
├── hvigorfile.ts                       # appTasks + 签名材料注入（env → signing.<mode>.local.json → 未签名包）
├── signing.debug.local.json.sample     # 签名材料模板；真值文件 signing.*.local.json 已 gitignore
├── AppScope/                           # ⚠️ 仅服务本仓库自测；HAR 本身**不带** bundleName
│   ├── app.json5                       # 样例标识 org.fellow99.nodebridge.sample（minAPI 17 / targetAPI 24）
│   └── resources/base/element/string.json   # app_name = "Node Bridge Self-test"
├── library/                            # ★★ 唯一发布物：`@fellow99/node-bridge` HAR
│   ├── Index.ets                       # barrel —— 对外唯一出口（S2）
│   ├── oh-package.json5                # HAR 元数据：name/version 0.1.0/main=Index.ets/license=MIT
│   ├── build-profile.json5             # 模块级：externalNativeOptions → cpp/CMakeLists.txt，abiFilters=[arm64-v8a]
│   ├── hvigorfile.ts                   # harTasks（无自定义插件）
│   ├── BuildProfile.ets                # hvigor 每次构建重写的常量文件（**不入库**）
│   ├── README.md                       # 面向消费方的 HAR 说明（30 秒用法 + 消费方三件事 + 限制）
│   ├── .ohpmignore                     # 发布排除清单（libnode.so / build / .cxx / oh_modules / *.har）
│   └── src/main/
│       ├── module.json5                # HAR 模块声明：type=har / deviceTypes=[2in1,tablet] / 2 条开放权限
│       ├── ets/                        # ArkTS 实现（runtime / bridge / log / util）→ §4 映射表
│       └── cpp/                        # NAPI 引导件源码（002-napi-bootstrap）
├── payload/                            # 随库分发的 Node 侧 JS（纯 JS，不参与 ArkTS 编译）
├── tools/                              # host 侧工具链（Node/Python，**不随包**）
├── specs/                              # 规格体系（本目录；编号对齐规划 §7.3）
├── tests/                              # 测试说明与自检入口（host 侧 + 真机）
├── samples/                            # 样例工程（Phase 1；当前**只有 README**）
├── docs/                               # 工程规划（唯一权威）
├── .clang-tidy / .clangd               # C 侧静态检查与 clangd 索引配置
└── .gitignore                          # 构建产物 + 签名材料 + libnode.so / libc++_shared.so
```

### 1.1 `library/src/main/`（发布物的源码面）

```
library/src/main/
├── module.json5                        # 模块声明（见下方 §2 表）
├── ets/
│   ├── runtime/Types.ets               # 对外类型契约：NodeState / NodeRuntimeOptions / NodeStartResult / HostBridgeHandler
│   ├── runtime/NodeRuntime.ets         # 001 单例 + 幂等状态机 + 启动投递 + markRunning/markFailed
│   ├── bridge/HostBridge.ets           # 003 注册表 + list() + dispatch()（结构化错误；**无**线程安全通道）
│   ├── log/Logger.ets                  # 006 hilog 双/三级别 + tail() 读回（失败返回占位串，不抛）
│   └── util/Env.ets                    # 006 沙箱路径（payload/tmp/log）+ materializeRawfile（ArkTS→沙箱落盘）
└── cpp/
    ├── CMakeLists.txt                  # C11 / SHARED / 输出落 libs/${OHOS_ARCH} / 只链 libace_napi.z.so + libhilog_ndk.z.so
    ├── node_bridge.c                   # 002 引导件实现（Phase 1 已重写；2026-10-17 实测 924 行；见 §4.1 函数锚点索引）
    └── types/libnode_bridge/
        ├── index.d.ts                  # 环境声明：start/isRunning/version/lastError/stage（5 个；S1：原生模块只经 .d.ts 接入）
        └── oh-package.json5            # 类型包的 ohpm 元数据（供 `import ... from 'libnode_bridge.so'` 解析）
```

### 1.2 `tools/`、`payload/`、`tests/`、`samples/`、`docs/`、`specs/`

```
payload/                                # Node 侧 JS（随库分发；消费方可直接复制范式）
├── bootstrap.js                        # 消费方入口参考实现：运行根决策 + Node 自解包（幂等 marker）+ CJS/ESM 入口解析 + 异常兜底
├── selfcheck.js                        # 端到端自检：/facts（16 项）+ /log + /rport + /diag
└── README.md                           # 载荷分发契约（只读直读为首选 / 谁写谁读 / 绝对路径）

tools/                                  # host 侧工具链（不随包）
├── provision.mjs                       # ✅ 投放 + 七项 ELF 门禁 + SHA-256 + 幂等 + --check/--list/--from/--download/--sign
├── elf-inspect.py                      # ✅ 纯 Python 只读 ELF 检查器（排障 / CI；与 provision.mjs 同口径）
├── ohos-selfsign.mjs                   # ✅ add-section / sign / verify / selftest（纯 SHA-256 Merkle + fs-verity，无私钥）
├── build-bridge.mjs                    # ⬜ Phase 1：交叉编译 NAPI 引导件（规划 §7.4 步骤 ②）
├── smoke-host.mjs                      # ✅ host 侧门禁（不接真机：lock/ELF/单测/契约漂移四段）
└── rt-build/                           # ⬜ Phase 3：自建 libnode.so 配方（规划附录 D / 附录 G.6 路线 C）

tests/
└── README.md                           # 三层测试现状表 + 快速自检命令 + 真机自检基线
                                        # ⬜ tests/smoke-host.mjs（Phase 1）

samples/
└── README.md                           # 两个规划样例的说明与「如何在 build-profile 里挂载」
                                        # ⬜ samples/minimal-app/、samples/arkweb-http/（Phase 1）

docs/
├── 000-工程规划.md                     # ★ 唯一权威（1298 行，v0.9）
├── 能力矩阵.md                         # ⬜ Phase 0 出口产物（规划 §8 出口判据明文要求，**当前不存在**）
└── 真机验证记录.md                     # ⬜ 累积产物（**当前不存在**；证据暂存在消费方 evidence 目录）

specs/
├── constitution.md                     # 治理原则（C1–C7 / S1–S10 / 证据纪律 / 红线 / 评审清单）
├── README.md                           # 编号分配 + 文档规则（spec.md / plan.md / tests.md）
├── STRUCTURE.md · TECH.md · ARCHITECTURE.md · overall-*.md   # ← 本批七份项目级规格
└── NNN-<name>/{spec.md,plan.md,tests.md}   # ⬜ 模块级规格（001–007；当前**全部待补**，见 §7）
```

---

## 2. 关键配置文件位置

| 文件 | 层级 | 关键内容（现状 ✅实测） | 规划锚点 |
|---|---|---|---|
| `oh-package.json5`（根） | 工程 | `modelVersion 6.1.1`；`dependencies/devDependencies` 均为 `{}` ⇒ **完全离线可构建** | — |
| `build-profile.json5`（根） | 工程 | products: `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)` / `runtimeOS HarmonyOS` / `nativeLib.collectAllLibs=true`；modules: `library`；`signingConfigs` 见 §8 ⚠️ | §7.5 |
| `library/build-profile.json5` | 模块 | `apiType: stageMode`；`externalNativeOptions.path = ./src/main/cpp/CMakeLists.txt`；`abiFilters: ["arm64-v8a"]` | §5.9 |
| `library/src/main/module.json5` | 模块 | `type: har`；`deviceTypes: [2in1, tablet]`；`requestPermissions: [INTERNET, GET_NETWORK_INFO]`；**刻意不写 description**（避免资源重名） | §7.5 / §9.4 ⚠️ |
| `library/src/main/cpp/CMakeLists.txt` | 构建 | `cmake_minimum_required 3.5.0`；`CMAKE_C_STANDARD 11` + `CMAKE_C_EXTENSIONS ON` + `_GNU_SOURCE`（Phase 1 新增，用于暴露 `sigaction`/`ucontext_t`/`dlopen`/`clock_gettime` 声明）；`set(CMAKE_LIBRARY_OUTPUT_DIRECTORY …/libs/${OHOS_ARCH})`；只链 NAPI + hilog | §5.9 / S6 / S7 |
| `library/.ohpmignore` | 发布 | `**/libnode.so` / `build/` / `.hvigor/` / `.cxx/` / `oh_modules/` / `node_modules/` / `*.har` | §7.5 / 附录 G.8 |
| `runtime.lock.json` | 运行时 | 严格 JSON，字段模型见 `overall-data-model.md` §1 | §5.8 / 附录 G.7 |
| `.gitignore` | 仓库 | 构建产物 + `signing.*.local.json` + `*.p12/*.p7b/*.cer` + `**/libnode.so` + `**/libc++_shared.so` + `*.har` + `BuildProfile.ets` | S10 / 附录 G.1 |
| `hvigorfile.ts`（根） | 构建 | 签名材料优先级：环境变量 → `signing.<SIGN_MODE>.local.json` → build-profile 内联 → **产出未签名包** | 规划 §7.2 纪律 |

---

## 3. 构建产物落点（as-built）

| 产物 | 落点 | 现状 | 说明 |
|---|---|---|---|
| NAPI 引导件 `libnode_bridge.so` | `library/libs/arm64-v8a/` | ✅ | 由 `CMakeLists.txt:10-11` 的 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` 决定；**不设它 HAP 里就没有 `libs/`**（不报错但功能不通，规划 §5.9 / 症状表 #12） |
| `libnode.so`（120.9 MiB） | **消费方模块** `<module>/libs/arm64-v8a/`（`provision.mjs --out`） | ✅ 工具就绪 / ⬜ 本仓库未投放 | 本仓库**不入库、不落盘**（S10；`.gitignore:19`） |
| `libc++_shared.so`（1,262,504 B） | 与 `libnode.so` 同目录（`provision.mjs` 从 ohos-sdk 一并投放） | ✅ 工具就绪 | 缺它 `dlopen` **静默失败**（硬约束 ②） |
| HAR 发布物 | `library/build/default/outputs/default/library.har` | ✅ **441,353 B**（2026-10-16 21:35 构建，**Phase 0 骨架**口径） | 与规划附录 C「HAR 441 KB」逐字节吻合；重跑 `assembleHar` 后必须重新核对 |
| HAP（样例/消费方） | `<module>/build/default/outputs/default/*.hap` | ⬜ 本仓库当前无 entry 模块 ⇒ 不产 HAP | 规划 §7.4 步骤 ④ |
| 自签中间产物 | **系统临时目录**（`os.tmpdir()`），进程退出清理 | ✅ | 落 `libs/<abi>/` 会被打进 HAP（`provision.mjs:317-320`） |

**HAR 实测内容（✅ `library.har` 27 条目，gzip+tar；⚠️ 该产物构建于 **Phase 0 骨架**状态下（2026-10-16 21:35），此后 `cpp/` 已被 Phase 1 重写 ⇒ 引导件大小会变）**：

| 包内路径 | 大小 | 结论 |
|---|---|---|
| `package/Index.d.ets` | 1,104 B | ArkTS 公共声明面 |
| `package/ets/modules.abc` | 15,228 B | 编译后的 ArkTS 字节码 |
| `package/ets/sourceMaps.map` | 10,462 B | 源码映射 |
| `package/libs/arm64-v8a/libnode_bridge.so` | 14,208 B（≈14 KB） | ✅ 与附录 C「引导件 14 KB」一致 |
| `package/libs/arm64-v8a/libc++_shared.so` | 1,262,504 B | ⚠️ **HAR 实际带了 libc++_shared.so**（`collectAllLibs: true` 收集），规划 §7.5 只写「引导件 + 锁文件 + 投放工具」 |
| `package/src/main/module.json` | 820 B | 模块声明（json5 → json 编译产物） |
| `package/src/main/ets/**/*.d.ets` | 5 份 | bridge / log / runtime×2 / util 的对外声明 |
| — | — | ⚠️ **不含** `payload/`、`runtime.lock.json`、`tools/provision.mjs`（规划 §7.5 要求 HAR 带后两者） |

---

## 4. `library/src/main/ets/*` ↔ 模块编号映射（规划 §7.3）

| 目录 / 文件 | 模块编号 | 内容 | 现状 |
|---|---|---|---|
| `ets/runtime/NodeRuntime.ets` | `001-runtime-core` | 单例、状态机、启动参数装配、投递 | ✅ 已实现（**798 行**）：`waitUntilRunning`（含 `stage==='exited'` 快路径）/ `logs` / `lastCrash`（含降级）/ `shutdown` / `host` 均在；仅状态机 `stopping/stopped` 为标记位语义（契约 §2.6） |
| `ets/runtime/Types.ets` | `001` + `003` | 对外类型契约（改动即破坏性变更，S3） | ✅ 已实现（4 个类型） |
| `cpp/node_bridge.c` + `cpp/CMakeLists.txt` | `002-napi-bootstrap` | dlopen/dlsym/argv/SIGSYS shim/崩溃 handler + 崩溃记录/32 MB detached 线程/stdio pipe + reader 线程（含组件输出过滤）/`stage()`+`lastError()`/`envPairs` | ✅ **Phase 1 已实现**（2026-10-17 实测 **924 行**）；剩余：`napi_threadsafe_function` 桥；函数锚点见 §4.1 |
| `ets/bridge/HostBridge.ets` | `003-host-bridge` | ArkTS 侧注册表 + 结构化错误分发 | ✅ 纯 JS 骨架 ⚠️（无 `napi_threadsafe_function`、无超时/上限、无反向通道） |
| `payload/bootstrap.js` | `004-payload-bootstrap` | tar.gz 自解包、`.ready-<sha12>` 幂等（含 `skipped`）、CJS/ESM 入口解析、异常兜底写 `app.log` | ✅ 已实现（库侧**不再**解释 `PI_*`：`PI_WEB_ENTRY` 已删除，C1 / FR-004-020） |
| `tools/provision.mjs` + `runtime.lock.json` + `tools/elf-inspect.py` + `tools/ohos-selfsign.mjs` | `005-provision-verify` | 获取/投放/七项门禁/自签/版本矩阵 | ✅ 已实现并实测 |
| `ets/log/Logger.ets` + `ets/util/Env.ets` + `payload/selfcheck.js` + `cpp/node_bridge.c`（日志/崩溃部分） | `006-observability` | hilog + 日志读回 + 崩溃记录 + `/facts`（自检面） | ✅ 已实现：hilog ✅、`tail()`/`tailLines()` ✅、`/facts`（16 键）✅、C 侧日志行格式 + pipe 排空 + **组件输出过滤** ✅、`<home>/node-bridge/last-crash.json` 写入 ✅、ArkTS 侧 `logs()` + `lastCrash()`（含降级）✅；仅**内存日志环**未做 |
| `library/oh-package.json5` + `.ohpmignore` + `library/README.md` | `007-distribution` | ohpm 包形态、版本策略、许可清单、接入文档 | ⚠️ 骨架（无第三方许可清单交付物、无 `specs/NNN-*` 模块规格） |
| `samples/*`、`tests/*` | `2NN-*`（201 起） | 样例与测试 | ⬜ Phase 1 |

### 4.1 `library/src/main/cpp/node_bridge.c` 函数锚点索引（评审常用）

> ⚠️ **只给函数名锚点，不给行号**：该文件在 002 模块并行实现中由 295 行重写为 **924 行**（Phase 1），行号会持续变化。

| 函数 / 常量 | 内容 | 关联 |
|---|---|---|
| `MAX_ARGS=12` / `ENV_PAIRS_LEN=4096` / `LINE_BUF_LEN=4096` | argv 上限 / `envPairs` 上限 / 单行缓冲 | ③ / ⑰ |
| `raw_write_fd()` | 裸 `open/write/close` 语义的单次 `write()`（**信号上下文安全**） | **S5 合规面** |
| `u64_to_dec()` | 异步信号安全的十进制输出（无锁、无分配） | S5 / C6 |
| `write_line()` / `open_log_fd()` | 日志行 `<stream> <epochMs> <text>`：hilog + 常开日志 fd（`O_APPEND`） | §5.7 / S9 |
| `log_line()` | `vsnprintf` + hilog + 落盘（**只在非信号路径**；信号路径禁用） | §5.7 / S9 |
| `sigsys_handler()` | 读指令编码 `0xd4000001`、返回**正好 -1**（不是 `-ENOSYS`） | §5.10 ③④ |
| `install_sigsys_shim()` | `SA_SIGINFO\|SA_NODEFER` | §5.10 ③ |
| `crash_handler()` / `sig_name()` / `stage_hint()` | 日志内 `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=… stage=…`（**整行单次 `write`**）+ 写 `<home>/node-bridge/last-crash.json`（整块单次 `write`）；只用 `u64_to_dec/hex` + `strlen`，**不用 `snprintf`** | C6 / S5 ✅ |
| `install_crash_handlers()` | SEGV/ILL/BUS/ABRT/FPE/TRAP | C6 |
| `redirect_stdin_to_devnull()` / `stdio_reader()` / `start_drain_threads()` / `reader_emit_line()` | fd0 → `/dev/null`；fd1/fd2 → 各自 pipe + 独立 reader 线程持续排空；**过滤 ArkWeb/Chromium 组件行并报丢弃计数**，首行 Node 输出把 stage 提升为 `running` | §5.10 ⑤ / R19 / C1 / A3 |
| `set_stage()` / `set_error()` | 原生阶段（`init\|stdio\|dlopen\|dlsym\|start\|running\|exited`）与最近失败原因 ⇒ 暴露为 `stage()` / `lastError()` | C2 |
| `apply_env_pairs()` / `split_next()` | `K=V` 逐行注入环境（上限 4096 B，覆盖式）；argv 切词 | §5.6 |
| `bootstrap()` | stdio → sigsys → env → dlopen 4 候选（`<libDir>/libs/arm64-v8a/` → `<libDir>/` → `<libDir>/libs/arm64/` → **裸名**，`RTLD_NOW\|RTLD_GLOBAL`）→ dlsym → argv（`argc` **不含** NULL 哨兵）→ `node::Start` | ①②③⑤⑥ / §D.8 / R18 |
| `js_start()` | 入参 → `g_ctx` → `g_dispatched` 单例守卫 → `install_crash_handlers()` → `pthread_create`(32 MB 栈) → `pthread_detach`；失败写 `set_error()` | §5.2 / §5.10 ① |
| `js_is_running()` / `js_version()` / `js_last_error()` / `js_stage()` | 4 个只读探针（版本串 `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`） | S8 |
| `Init()` | 注册 **5 个** NAPI 接口：`start`/`isRunning`/`version`/`lastError`/`stage`（`.d.ts` 已同步） | S8 的「扩展须同步」口径 |

---

## 5. `payload/` 清单（随库分发的 Node 侧 JS）

| 文件 | 行数 | 作用 | 现状 |
|---|---|---|---|
| `payload/bootstrap.js` | 409 | 消费方入口参考实现：运行根决策（只读直读/可写）、Node 自解包 + `.ready-<sha12>` 幂等、CJS/ESM 入口解析、`uncaughtException`/`unhandledRejection` 兜底写 `app.log` | ✅ 已实现（入口只认 `NODE_BRIDGE_ENTRY`） |
| `payload/selfcheck.js` | 385 | 端到端自检：`/facts` 返回 **16 项**冻结判据（含 `spawn`、`*_redirected`）、`/log` 尾 8 KB、`/rport` 转发、`/diag` 聚合 | ✅ 可用；`SELFCHECK_PORT` 默认 **15577**，被占用时回退临时端口并**大声**报新端口（C3） |
| `payload/README.md` | 21 | 「库不替消费方决定服务怎么起」+ 载荷分发契约（只读直读首选 / 谁写谁读 / 绝对路径） | ⚠️ §8 记载一处与代码不符 |

---

## 6. `tools/` 清单（host 侧，**不随包**）

| 文件 | 行数 | 现状 | 关键能力（✅ 实测） |
|---|---|---|---|
| `provision.mjs` | 341 | ✅ | 纯 JS 自解析 ELF（不依赖 python/llvm）；七项门禁 + SHA-256/大小硬校验（`exit 2`）；幂等投放；`--check`/`--list`/`--from`/`--download`/`--sign`/`--force`/`--quiet`/`--node`/`--abi`/`--sdk`；来源优先级 本地目录（`OHOS_NODE_RUNTIME_DIR` 可覆盖）→ `--from` → 镜像 → 上游；代理未开 `NODE_USE_ENV_PROXY` 时打印正确命令；中转文件进程退出清理 |
| `elf-inspect.py` | 169 | ✅ | 零依赖只读检查：`e_type`/`e_machine`/`PT_INTERP` 计数/`DT_NEEDED`/`SONAME`/`node::Start` 导出/`.codesign` 与 `.note.ohos.ident`/SHA-256/段表解析完整度 → `VERDICT: PASS\|FAIL` |
| `ohos-selfsign.mjs` | 291 | ✅ | `add-section`（自实现页对齐段 + 重建段表 + 扩 shstrtab，**原字节一字不动**）/`sign`/`verify`（十项检查）/`selftest`（清零重签应逐字节一致）；`--relro-align8` 默认关闭（依据 `wxjit.so` 实测） |
| `build-bridge.mjs` | — | ⬜ Phase 1 | 规划 §7.4 步骤 ② |
| `smoke-host.mjs` | — | ✅ 已实现（四段：lock/ELF/单测/契约漂移） | 规划 §7.4 步骤 ③ |
| `rt-build/` | — | ⬜ Phase 3 | 规划附录 D 配方（`--shared` / V8 maglev 补丁 / `-DNDEBUG` / `-fno-emulated-tls` / strip → 自签） |

---

## 7. 模块规格目录（规划 §7.3；specs/README.md 已登记）

| 编号 | 目录 | 现状（✅实测：目录不存在） |
|---|---|---|
| `001-runtime-core` | `specs/001-runtime-core/{spec.md,plan.md,tests.md}` | ⬜ 待补 |
| `002-napi-bootstrap` | `specs/002-napi-bootstrap/…` | ⬜ 待补 |
| `003-host-bridge` | `specs/003-host-bridge/…` | ⬜ 待补 |
| `004-payload-bootstrap` | `specs/004-payload-bootstrap/…` | ⬜ 待补 |
| `005-provision-verify` | `specs/005-provision-verify/…` | ⬜ 待补 |
| `006-observability` | `specs/006-observability/…` | ⬜ 待补 |
| `007-distribution` | `specs/007-distribution/…` | ⬜ 待补 |
| `201-sample-arkweb` 等 | `specs/2NN-*` | ⬜ 待补（从 201 起） |

---

## 8. 「不入库」清单（S10 + 红线）

| 对象 | 位置 | 机制 | 依据 |
|---|---|---|---|
| `libnode.so`（120.9 MiB） | `<module>/libs/arm64-v8a/` | `.gitignore:19` `**/libnode.so` + `library/.ohpmignore:11` + `runtime.lock.json` 只记哈希 | S10 · 附录 G.1（GitHub 单文件 100 MiB 硬限） |
| `libc++_shared.so`（1.26 MB） | 同上 | `.gitignore:20`（但**随 HAR 分发**，由 `collectAllLibs` 收集） | `.ohpmignore:7` 注释 |
| `build/`、`.hvigor/`、`.cxx/`、`.preview/`、`.idea/`、`oh_modules/` | 各层 | `.gitignore:1-9` | — |
| `*.har` | `library/build/…` | `.gitignore:25` + `.ohpmignore:17` | — |
| `library/BuildProfile.ets` | 模块根 | `.gitignore:28`（hvigor 每次构建重写） | — |
| 签名材料：`signing.*.local.json` / `*.p12` / `*.p7b` / `*.cer` | 任意 | `.gitignore:12-15` | 规划 §7.2 · README「仓库内不含任何密钥」 |
| 运行时缓存二进制 `libnode-arm64.so`（120.9 MiB） | 仓库内 `runtime/node-<版本>/` | `.gitignore:28` `/runtime/**/*.so`（同目录 README/SHA256SUMS/PROVENANCE **入库**；2026-10-18 前缓存位于父工程 `../ohos-node-runtime/`） | 附录 G.1/G.2 |
| 自签中间产物 / 下载中转 | `os.tmpdir()` | `provision.mjs:36-38` 退出清理 | 附录 G.4 |

### 8.1 ⚠️ 结构层面发现的三处「规划与代码不一致」（评审必读）

1. **受版本控制的 `build-profile.json5` 里出现了真实签名材料**：工作区版本含 `certpath/profile/storeFile` 绝对路径（`C:\Users\Administrator\.ohos\config\default_ohos-node-bridge_-*.{cer,p7b,p12}`）与 AES-GCM 密文口令 `keyPassword`/`storePassword`，而文件头注释与 `.gitignore` 都声明「签名材料不入库」。`git show HEAD:build-profile.json5` 里 `signingConfigs` 为 `[]` ⇒ **当前只是工作区改动（`git status` 显示 ` M build-profile.json5`），尚未提交**；一旦整体提交即触碰「仓库内不含任何密钥」的纪律。属 DevEco「自动生成签名」直接写 build-profile 的行为（`hvigorfile.ts:106-135` 对此有注释）。
2. **HAR 实际内容 ≠ 规划 §7.5 的发布物清单**：规划要求 HAR 带 `payload/` + `runtime.lock.json` + 投放工具；实测 HAR **不含**这三者（`payload/` 与 `runtime.lock.json` 位于仓库根、不在 `library/` 内），却**含** `libc++_shared.so`。⇒ 消费方拿到 HAR 后**无法自证**该投放哪版运行时（校验值必须回到仓库根读锁文件）。
3. **（已于 2026-10-17 修复）`payload/bootstrap.js` 的 `PI_WEB_ENTRY`**：库侧曾直接解释应用语义变量（违 C1 / specs/004 FR-004-020）⇒ 已删除该兼容别名，入口只认 `NODE_BRIDGE_ENTRY`；同轮修正 `payload/README.md` 与 `payload/selfcheck.js` 的 `spawn` 断言不一致（代码与文档现在都含 `spawn`，`/facts` 冻结 16 键）。

---

## 9. 规划中存在、当前**不存在**的路径（防误引用）

| 规划路径 | 规划锚点 | 现状 |
|---|---|---|
| `library/src/main/libs/arm64-v8a/` | §7.2 | ⬜ 不存在（实际 CMake 输出到 `library/libs/arm64-v8a/`） |
| `docs/能力矩阵.md` | §8 Phase 0 出口判据 | ⬜ 不存在 |
| `docs/真机验证记录.md` | §7.2 / §10 | ⬜ 不存在（证据在消费方 `docs/evidence/`） |
| `tests/smoke-host.mjs` | §7.2 / §7.4 | ⬜ 不存在 |
| `samples/minimal-app/`、`samples/arkweb-http/` | §7.2 | ⬜ 不存在 |
| `tools/rt-build/` | 附录 D / G.6-C | ⬜ 不存在 |
| `specs/NNN-*/`（001–007） | §7.3 / §10 | ⬜ 不存在 |
| `samples/minimal-app`（真机探针 + 最小样例） | §D.7–§D.9 · `samples/README.md` | ✅ **在本仓库**（消费 `library` 的 HAP；一键取证 `node tools/probe.mjs`） |
