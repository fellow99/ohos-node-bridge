# ARCHITECTURE.md —— `ohos-node-bridge` 整体架构（as-built + 设计）

> **性质**：项目级架构规格。回答「分几层、线程怎么跑、启动怎么发生、硬约束落在哪一行、和消费方怎么分界、怎么观测」。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10 / G3/G4/G5/G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）· 源码 ✅实测（行号即本仓库当前行号）。
> **标记**：✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突或风险。凡标注「⬜ 规划未实现（Phase N）」的，代码里**确实没有**。
> **版本**：v1.1 · 2026-10-16 · 状态：Phase 0 完成（P0-1/P0-2/P0-6/P0-7/P0-14 ✅）；Phase 1 中 `002-napi-bootstrap` 已并行实现（见下方引用基准）。
>
> ⚠️ **引用基准（重要）**：本文行号最初取自 **2026-10-16 成稿快照**；**2026-10-17 实测校订**为
> `NodeRuntime.ets` **798 行** / `Types.ets` **159 行** / `HostBridge.ets` **231 行** / `Logger.ets` **198 行** / `Env.ets` **92 行** / `cpp/node_bridge.c` **924 行**。
> 此后 `cpp/`（002）与 `ets/`（001/003/006）继续并行推进（`node_bridge.c` 新增 stdio pipe + 独立 reader 线程、
> 组件输出过滤、`last-crash.json`、`stage()`/`lastError()`、C 侧单例守卫 `g_dispatched`、`envPairs` 注入）⇒ **C 侧一律以函数名为准；ArkTS 侧以类名/成员名为准；行号仅作定位线索**。

---

## ① 分层架构

```
┌─ 宿主应用（消费方，如 pi-desktop-ark / Pi Desktop V2） ─────────────────────────┐
│  Ability + 窗口 + ArkWeb 组件 + 加载/错误页 + 目录选择器 + 外链 + 通知              │
│  Node 侧启动脚本：环境装配 → 载荷就绪 → 起本地服务 → 就绪判定                       │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ ArkTS API（@fellow99/node-bridge / 唯一出口 Index.ets）
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  libnode_bridge.so（本库 NAPI 引导件，随 HAP 编译；只链 NAPI + hilog）            │
│   ├─ ArkTS 侧注册（nativeModule）：start / isRunning / version  ← 只有 3 个（S8） │
│   ├─ 宿主能力桥：napi_threadsafe_function 队列（Node ⇄ ArkTS，JSON）  ⬜ Phase 2   │
│   ├─ detached bootstrap 线程：dlopen → dlsym → node::Start(argc, argv)  ✅         │
│   ├─ SIGSYS shim（io_uring_setup → 正好 -1）+ setenv(UV_USE_IO_URING=0)  ✅         │
│   ├─ 崩溃 handler（SIGSEGV/ILL/BUS/ABRT/FPE/TRAP → node.log）  ✅（结构化记录文件 ⬜）│
│   └─ stdio：dup2 到 node.log  ✅ ｜ ⬜「1 MB pipe + 独立 reader 线程」§5.10 ⑤        │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL)   ← 先试绝对路径，再落裸名
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  HAP libs/arm64-v8a/：libnode.so（120.9 MiB）+ libc++_shared.so + libnode_bridge.so │
│  resfile/rawfile：宿主载荷（消费方提供）+ payload/bootstrap.js · selfcheck.js       │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ 沙箱可写目录 <filesDir>（HOME / TMPDIR 重定向到这里）
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  Node 运行时（libnode v24.2.0，自带 libuv 事件循环，跑在自己的 pthread 上）        │
│   bootstrap.js：⬜ 自解包（zlib+fs）→ 入口解析 → require/import → 应用逻辑          │
│   宿主桥：⬜ require('@fellow99/node-bridge/host').invoke('perm.check', …)          │
└────────────────────────────────────────────────────────────────────────────────┘
```

**一条关键边界（C1 / 规划 §5.1）**：库**不参与渲染**。ArkWeb 页面、加载页、错误页、Cookie 注入、导航围栏全部是消费方的事；库只保证「**本地服务在端上跑着**」。判定口径：「这一条是不是宿主语义？」—— 是则一票否决。

| 层 | 归属 | 进哪个发布物 | 现状 |
|---|---|---|---|
| 运行时层（dlopen / 线程 / 载荷 / 环境 / 观测 / 桥） | **本库** | HAR + 引导件 `.so` | 骨架（Phase 0 探针已闭环） |
| 应用宿主层（Ability / 窗口 / ArkWeb / 鉴权 / 选择器） | 消费方 | 消费方 HAP | 不在本仓库（规划 §0.1 拆分） |
| 上游层（`pi` / `pi-web`） | 上游 | 消费方载荷 | 原样复用，只允许幂等补丁 |

---

## ② 进程 / 线程模型

| 项 | 设计 | 代码落点（✅实测） | 不这样做的后果 |
|---|---|---|---|
| **一个进程** | Node 跑在**宿主应用自己的进程**内（`pid` = 宿主 pid），无子进程、无守护 | `bootstrap()`（同进程 `node::Start`） | 子进程形态平台封死（`801` / `execve` EACCES），且崩了能重启的卖点被 ⑥ 废掉 |
| **一条 detached bootstrap 线程** | `pthread_create` + **32 MB 栈**（`pthread_attr_setstacksize`）+ 立即 `pthread_detach` | `js_start()` / `bootstrap()` | 在 UI 线程做 `dlopen`/`node::Start` ⇒ `APP_INPUT_BLOCK`（先例旧版被系统 ANR 杀掉） |
| **线程与 ArkTS 完全解耦** | ArkTS 只做「投递启动参数 + 查状态 + 读日志」，**绝不 join** | `NodeRuntime.ets:61-96`（投递即返回） | `node::Start` 直到进程结束才返回 ⇒ join 等于永久阻塞 UI |
| **单例 + 不可重启** | 进程内唯一实例；非 `IDLE` 再 `start()` ⇒ 返回结构化失败并保留首次原因 | `NodeRuntime.ets:26-31,62-69` | 第二次命中 `node.cc` 的 `limit_called.exchange(true)` 断言（硬约束 ⑥） |
| **崩溃 = 终态** | 无看门狗、无自动重启；只允许「读日志 / 读崩溃记录 / 提示重启应用」 | `NodeRuntime.ets:108-114`（`markFailed`） | 「假装恢复」会误导用户（C5） |
| **stdio 重建与排空** | ✅ 已按 §5.10 ⑤ 重建：fd0 ← `/dev/null`、fd1/fd2 ← **各自的 pipe**，由**独立 reader 线程**持续排空并落盘（行格式 `<stream> <epochMs> <text>`） | `redirect_stdin_to_devnull()` / `stdio_reader()` / `start_drain_threads()` | 不排空管线会**阻塞 ArkWeb 的 IO 线程 ⇒ Web 组件不绘制**（R19 白屏）；且旧的 `dup2` 直写文件方案会把宿主/Web 容器的原生输出混进 `node.log`（⑱ 实测） |
| **信号处理** | `SIGSYS` shim（`SA_SIGINFO\|SA_NODEFER`）+ 6 个崩溃信号（`SA_SIGINFO\|SA_RESETHAND`） | `install_sigsys_shim()` / `install_crash_handlers()` | libuv 初始化无条件探测 `io_uring_setup(425)`，被 seccomp trap 时无 shim 即崩（症状 #4） |
| **进程退出** | ⬜ `shutdown()`（在 Node 线程跑应用注册的 `onShutdown` 钩子）**未实现**；真正的停止只能是进程退出 | — | 「关停」API 面缺口（规划 §5.2/§5.3） |

---

## ③ 启动时序（as-built 的真实调用链）

```
① 消费方（ArkTS）:  NodeRuntime.getInstance().start(ctx, { scriptPath, flags?, libDir?, homeDir?, logPath? })
        └─ Env.ensureRuntimeDirs(ctx)                       # <filesDir>/payload + <filesDir>/tmp
        └─ 幂等保护：state !== IDLE ⇒ { ok:false, code:-1, state, message }   （NodeRuntime.ets:62-69）
        └─ 组装 5 个参数：libDir(bundleCodeDir) / scriptPath / flags(默认 --no-verify-heap) / home(filesDir) / logPath
        └─ state = STARTING；调 nodeBridge.start(...) → 返回 rc
                                                                  （NodeRuntime.ets:71-96）
② 原生 start()（`js_start()`）: napi 取字符串 → g_ctx → 派生 tmp=/tmp → g_log_path → mkdir(tmp)
        └─ 单例守卫 g_dispatched：已投递过 ⇒ 返回 -1（不重复起线程）
        └─ install_crash_handlers()                                    （install_crash_handlers）
        └─ pthread_create(bootstrap, 32 MB 栈) → rc!=0 则 set_error 并返回错误码；成功则 detach 后立即返回 0
③ bootstrap 线程（非 UI 线程！）:
        └─ set_stage("stdio") → 重建 fd0/1/2 + 起 2 条 reader 线程      （stdio_reader / start_drain_threads）
        └─ install_sigsys_shim()                                        （install_sigsys_shim）
        └─ setenv: UV_USE_IO_URING=0 / HOME / USERPROFILE / TMPDIR / TMP / TEMP / NODE_ENV=production
           unsetenv: NODE_OPTIONS                                       （bootstrap）
        └─ apply_env_pairs(envPairs)：K=V 逐行（上限 4096 B，覆盖式）    （apply_env_pairs）
        └─ 探针 syscall(425, 8, &p) 并记录返回值（本机 8，无 seccomp trap）
        └─ set_stage("dlopen") → dlopen 4 个候选，命中即停：
              <libDir>/libs/arm64-v8a/libnode.so → <libDir>/libnode.so → <libDir>/libs/arm64/libnode.so → "libnode.so"
              flags = RTLD_NOW | RTLD_GLOBAL                            （bootstrap）
              失败 ⇒ set_error(...) 后 return NULL（ArkTS 侧可经 lastError()/stage() 读到）
        └─ set_stage("dlsym") → dlsym(h, "_ZN4node5StartEiPPc")；失败 ⇒ set_error 后 return  （bootstrap）
        └─ 组 argv：argv[0]="node" → flags 按空格切词（split_next，上限 MAX_ARGS-1）→ scriptPath → NULL 哨兵
              argc **不含**哨兵                                        （bootstrap）
        └─ set_stage("start") → g_node_running = 1 → 逐行打印 argv[] 自检（bootstrap）
④ node::Start(argc, argv)  ← 直到进程结束才返回（正常路径永不返回）     （bootstrap）
        └─ reader 见到**第一行未被过滤的 Node 输出** ⇒ set_stage("running")（A3 的代理判据：`node::Start` 返回前进程内无其它信号）
        └─ Node 侧：payload/bootstrap.js（或 selfcheck.js）开始执行
⑤ 就绪判定（**消费方契约**）: 库不猜。消费方轮询宿主服务端口 / 读 /facts；
   成功则 NodeRuntime.markRunning()，超时/读到崩溃则 markFailed(reason)
                                                                        （NodeRuntime.ets:98-114）
```

**两条时序红线**

1. **`execArgv` 只能在 ④ 之前定死**：`flags` 是**一次性**输入，库不提供运行期 `push`（C4 / 硬约束 ⑤、规划 §6.2 共享事实 5）。
2. **ArkTS 的 `start()` 返回 `ok=true` 只代表「已投递」**，不代表 Node 已起来（`Types.ets:36-46` 注释明文）。判「起来了」靠**功能性判据**（端口探活 / `/facts`），不靠 hilog、不靠 `VmSize`（C6 / §5.7）。

---

## ④ 六条硬约束 + ⑰⑱ 的实现落点对照（评审用）

| # | 硬约束（规划 §2.3 / §5.10 / §D.10） | 违反后的症状 | 实现落点（✅ 已落 / ⬜ 未落） |
|---|---|---|---|
| ① | `libnode.so` 必须是**真共享库**（`ET_DYN` 且 `PT_INTERP = 0`） | `dlopen` 成功但 V8 首次堆分配即崩（TLS 别名）；症状极易误判 | ✅ `provision.mjs` 门禁②（`elfGate()`）+ `elf-inspect.py` 的 VERDICT + `runtime.lock.json.gates.ptInterp = 0` |
| ② | `libc++_shared.so` 必须**一起进 HAP** | `dlopen` 失败，ArkTS 侧**只拿到 `undefined`**（不报错） | ✅ `provision.mjs` 的 `findLibcxx()` + 投放分支 + 门禁④ + `runtime.lock.json.libcxx`；HAR 实测已含该 so |
| ③ | `argc` **不能**把 `argv` 末尾 `nullptr` 哨兵算进去 | Node 拿到 `NULL` 参数，**5 ms 内段错误** | ✅ `bootstrap()`（`argc++` 只到 scriptPath，最后才写 `argv[argc] = NULL`） |
| ④ | JS 载荷走 `rawfile` + `resourceManager`，且**谁写谁读** | 解包出的文件 `MODULE_NOT_FOUND`（`requireStack: []`） | ✅ 已落：ArkTS→沙箱落盘（`Env.materializeRawfile`）；`payload/bootstrap.js` 实现「只读直读 → 只读根 → 可写根」运行根决策、**Node 自解包（`zlib`+`fs`）**、就绪标记 `<payloadRoot>/.ready-<sha256 前 12 位>`（幂等命中即跳过）与解包统计（含 `skipped`） |
| ⑤ | `--expose-internals` 必须出现在**启动参数**里 | `internal/modules/*` 全部 `MODULE_NOT_FOUND` | ⚠️ 机制已具备：`bootstrap()` 把 `flags` 切词进 argv；产物支持已验（`runtime.lock.json.flags.exposeInternals` + `provision.mjs` 附加探测）。**但默认 `flags` 只有 `--no-verify-heap`**（`NodeRuntime.ets:76` / `js_start()`），与规划 §5.3 默认值不一致 ⇒ 见 §⑤ 决策 D4 |
| ⑥ | 同进程内 `node::Start` **只能调用一次** | 第二次命中 `node.cc` 断言 `limit_called.exchange(true)` | ✅ 双侧保护：ArkTS `NodeRuntime.ets:62-69`（返回 `code=-1` + 当前状态）；C 侧 `g_dispatched` 守卫（`js_start()` 返回 `-1`）。⚠️ 仍缺「首次失败原因」的**结构化字段**（C5 缺口） |
| **⑰** | **运行时端口必须随机（或先探测空闲）+ 宿主单实例** | 端口冲突 ⇒ 载荷 `EADDRINUSE` 未捕获异常 ⇒ **整个 App 进程 abort**（崩溃栈含 `libnode_bridge.so`） | ⚠️ 库侧无端口概念（不越界）；`payload/selfcheck.js` 默认端口 **15577**（文档化诊断契约）但**被占用时会回退到内核临时端口并打印 `[selfcheck] WARN 15577 被占用 → 改用 <port>`**（C3）；产品侧随机端口 + 单实例 ⬜ 消费方负责（其规划 §11/§13） |
| **⑱** | **载荷必须自装 `uncaughtException`/`unhandledRejection` 兜底并写独立日志通道** | 进程内 Node **没有优雅退出路径**；且旧 `dup2` 方案会把宿主/Web 容器原生输出混进 `node.log` | ✅ 已落：`payload/bootstrap.js` 顶部注册 `process.on('uncaughtException'/'unhandledRejection')`，写 `<HOME>/payload/app.log` + stderr，**不 `process.exit`**；C 侧 reader 过滤组件原生输出并报丢弃计数（C1） |
| 补充 | **stdio 必须重建并持续排空**（§5.10 ⑤） | 不排空管线会阻塞 ArkWeb 的 IO 线程 ⇒ **Web 组件不绘制**（R19，最难查的白屏） | ✅ 已落：fd0 → `/dev/null`、fd1/fd2 → 各自 pipe + 独立 reader 线程（`stdio_reader()` / `start_drain_threads()`） |
| 补充 | **SIGSYS handler 内禁用 stdio**；判「是否跳过 svc」必须**读指令编码** | 信号上下文调 stdio 二次崩溃；比 PC 与 `si_addr` 在部分设备恒不相等 ⇒ shim 静默失效 | ✅ `sigsys_handler()`：读 `uc_mcontext.pc` 指向的 `0xd4000001`、返回**正好 `-1`**（不是 `-ENOSYS`）、只改 `regs[0]` 与 `pc` |
| 补充 | **`dlopen` 只认裸名**（绝对路径全失败） | 装上了但功能不通 | ✅ `bootstrap()`：裸名是第 4 个候选，必试 |
| 补充 | 崩溃必须留**结构化证据**（C6） | 「崩了」无法定位 | ✅ 双份：日志内 `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=… stage=…`（整行**单次 write**，`crash_handler()`）；并写 `<home>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`，整块单次 write）。**ArkTS 侧 `lastCrash()` ✅ 已实现**（含 JSON 损坏时的日志降级重建） |

---

## ⑤ 关键架构决策表

| # | 决策 | 取舍理由 | 替代方案（为何不选） | 状态 |
|---|---|---|---|---|
| **D1** | **进程内 `dlopen` + `node::Start`**（路线 A） | 唯一同时满足「无 Chromium」与「上架合规」的形态；两条核心链路都有一手真机证据 | ① Electron 只当 Node 宿主 —— 包内仍带 Chromium，合规口径不确定，且要维护两套运行时（登记为排期滑落时的**回退**）；② 子进程 + 看门狗 —— `801` 封死；③ Node→ArkTS 移植 —— 等于重写上游 | ✅ 已实现 |
| **D2** | **bootstrap 走 detached pthread（32 MB 栈）** | UI 线程做 `dlopen`/`node::Start` 会 `APP_INPUT_BLOCK` | 在 ArkTS worker 里做 —— 拿不到 `dlopen` 语义与 C 栈控制 | ✅ 已实现 |
| **D3** | **原生层启动失败必须可被 ArkTS 看见**：新增 `stage()`（`init\|stdio\|dlopen\|dlsym\|start\|running\|exited`）与 `lastError()` 两个只读探针 | 对 C2 的落地：stdio/`dlopen`/`dlsym`/`pthread_create` 失败、参数校验失败与重复投递都写 `set_error()`，ArkTS 侧可读 | 曾一度只有日志（必须读日志才能发现失败）⇒ 已按 C2 加探针；**ArkTS 侧已接入**：`getStage()`/`getLastError()` 公开读回、`waitUntilRunning()` 用 `stage==='exited'` 提前失败、`start()` 按 `-1`/`-2`/`>0` 分流文案 | ✅ 已实现（C 侧 + ArkTS 侧） |
| **D4** | **默认 `flags = '--no-verify-heap'`（不含 `--expose-internals`）** | 实现取「最小可用」默认值 | 规划 §5.3 默认 `['--expose-internals','--no-verify-heap']`；硬约束 ⑤ 要求 `--expose-internals` **必须在启动参数里** | ⚠️ **规划/实现不一致**，Phase 1 需统一 |
| **D5** | **`dlopen` 用 `RTLD_NOW \| RTLD_GLOBAL`** | SONAME 是 `libnode.so.137` 而 HAP 内名是 `libnode.so` ⇒ 任何以 `DT_NEEDED = libnode.so.137` 链接的 addon 运行期**找不到**；改依赖「符号进全局表」（R18 / O11） | 先例用 `RTLD_LOCAL`（因为它**没有任何 Addon**，我们没有这个自由） | ✅ 已实现（`bootstrap()` 的 `dlopen` 调用） |
| **D6** | **引导件不链接 `libnode.so`**（只 `dlopen`） | 引导件与运行时版本解耦：换 Node 版本不需重编库（S7 / C7） | `target_link_libraries(... libnode.so)` —— 会把版本钉死，且 `dlopen` 的绝对路径问题依旧 | ✅ 已实现（`CMakeLists.txt:13-16`） |
| **D7** | **C 侧接口保持极窄**（初版 3 个；Phase 1 扩到 **5 个**：`start`/`isRunning`/`version`/`lastError`/`stage`，`.d.ts` 同步更新，且 `start()` 新增第 6 参 `envPairs`） | API 面越小越稳（R15）；扩展必须**同时**改 `.d.ts`（S8 的执行口径） | 把 logs/hostBridge/shutdown 全下沉到 C —— 会把线程安全、超时、队列全部塞进 C 层，成本高且难测 | ✅ 已实现（`Init()` 注册 5 个；`index.d.ts` 已同步）；S8 字面「只有 3 个」需按「扩展须同步 `.d.ts`」重述 |
| **D8** | **状态机由 ArkTS 持有，`running` 由消费方 `markRunning()` 触发** | 库不替消费方猜探活策略（端口/退避/超时属消费方契约）；且库无法可靠地「知道」服务已就绪 | 库自己轮询端口 —— 需要知道端口，等于把应用语义塞进库（C1） | ✅ 已实现（`NodeRuntime.ets:98-114`） |
| **D9** | **载荷首选「只读直读、零解压」**（`resfile/` 直读） | 免掉首启解压数万文件的耗时与失败面（§5.5 / §5.10 ⑩） | 单个 `tar.gz` + 自解包 —— 仅当载荷**必须可写**时退到这条；且解包必须由 Node 自己做（硬约束 ④） | ✅ 已实现（`payload/bootstrap.js` 运行根决策 + `lib/tar-extract.js`） |
| **D10** | **`HOME`/`TMPDIR` 由原生层强制重定向到沙箱**，`NODE_OPTIONS` 清空；另接受 `envPairs`（`K=V` 逐行分隔，上限 4096 B）注入应用语义变量 | `os.homedir()` 默认指向沙箱外 ⇒ 文件选择器 `EPERM`（症状 #10）；宿主环境污染会改变 Node 行为；应用语义变量由消费方显式传入（C1） | 由消费方在 `env` 选项里传 —— ✅ 已实现：C 侧 `apply_env_pairs()`；ArkTS 侧 `NodeRuntimeOptions.env` 已接线（`buildEnvPairs` 把 `NODE_BRIDGE_*` 与用户项拼成第 6 个参数） | ✅ 已实现（两层） |
| **D11** | **崩溃不被库捕获成「可恢复」**：handler 记录（日志 + `last-crash.json`）后 `signal(sig, SIG_DFL); raise(sig)` | 让系统 CppCrash 正常归档 + 保留现场证据；不假装恢复（C5/C6） | swallow 信号继续跑 —— 会以更隐蔽的方式炸 | ✅ 已实现（`crash_handler()`） |
| **D12** | **观测优先**：库自带 `/facts` 自检载荷 | 「先建观测通道，再动代码」（C6）；`/facts` 的一次真机 JSON 就是成功运行的证书 | 只靠 hilog —— 应用侧 INFO 常不入 dump 缓冲（症状 #17），且沙箱日志 `hdc` 读不到 | ✅ 已实现（`payload/selfcheck.js:60-80`） |
| **D13** | **桥用 JSON 字符串载体 + 未注册即结构化报错** | 不受参数个数/类型限制（旧壳 `callArkTSFunction` ≤3 参仅原始类型）；未注册返 `{"ok":false,"error":"unregistered"}` 而不是解引用空指针（旧壳 `ExternalWeb.Open` 曾把整个应用打崩，R15） | 直接抛异常穿透 —— 在 Node 侧会变成难以定位的 `unhandledRejection` | ⚠️ 部分：`HostBridge.ets:35-45` 已实现结构化错误；**线程安全通道/超时/上限 ⬜ Phase 2** |
| **D14** | **二进制不入库、锁文件入库、投放幂等**（S10 / 附录 G） | 120.9 MiB > GitHub 单文件 100 MiB 硬限；`diff` 即审计；离线可用 | submodule / 直接 commit / 制品库 / 等自建 —— 逐条否掉见 TECH §2 与附录 G.5 | ✅ 已实现 |
| **D15** | **不提供「ArkTS 调 Node 函数」的通用入口** | 只有两条方向 2 通道：`start()` 参数、`shutdown()`；应用语义走 HTTP/文件 ⇒ API 面小（§5.4） | 通用双向 RPC —— 会把应用语义吸进库（R15） | ✅ 已实现（当前连 `shutdown` 都没有） |

---

## ⑥ 与消费方 `pi-desktop-ark` 的责任分界（规划 §6.1）

**目标形态（一句话）**：ArkTS 宿主起本库 → 本库在**同一进程**内跑 Node → Node 起 `pi-web` 服务端（同源 HTTP + SSE）→ **ArkWeb** 渲染 `http://127.0.0.1:<随机端口>/`。**无 Electron、无 Chromium。**

| 面 | **本库承诺**（走 HAR 与引导件） | **消费方必须自建** |
|---|---|---|
| 运行时 | `dlopen` + `node::Start`、单例状态机、启动参数、SIGSYS shim、崩溃取证、自检载荷 | **无**（不写 C++） |
| 载荷 | `entry` / `scriptPath` / `payloadRoot` / `archive` / `cwd` / `env` 选项；就绪幂等（`.ready-<sha12>`）；CJS/ESM 入口解析 | 载荷内容与裁剪、投放时机、首启加载页 |
| 观测 | hilog + `Logger.tail`/`logs()`（读文件尾，`logRingSize` 默认 500）+ `lastCrash()`（含 JSON 损坏时的日志降级）+ `/facts` `/log` `/rport` `/diag` 自检端点 | 诊断面板、错误页、阶段文案、真机取证 |
| 宿主能力 | 桥的**传输层**（线程安全 JSON、超时、未注册即报错）（⬜ 仅注册表与结构化错误已实现） | 每个能力的**实现**（权限、选择器、外链、通知） |
| 渲染 | **不参与**（只保证「本地服务在端上跑着」） | ArkWeb `Web` 组件、加载页、Cookie 注入、导航围栏 |
| 生命周期 | `start()` / `waitUntilRunning()` / `markRunning()` / `markFailed()` / `shutdown()`（`shutdown` **如实说明无法优雅停止**，不假装） | `onPrepareToTerminate` 接线、失败态 UX |
| 平台真相 | 如实上报能力标志（不静默降级） | 把失败暴露到 UI（可截图、可断言） |
| **权限/ACL** | 在 `module.json5` 里声明**自己确实需要**的开放权限（INTERNET、GET_NETWORK_INFO）✅ | 按**自己的包名**申请并声明 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（JIT 刚性前置），并跑 `provision.mjs` 投放运行时 |

**双方共享的事实（任一方改动都要同步，§6.2）**：① 端口由 Node 侧随机/先探测空闲 + 宿主单实例（⑰）；② 载荷必须自装异常兜底并写独立日志通道（⑱）；③ `HOME`/`TMPDIR` 由库重定向，应用语义变量由消费方经 `env` 传入；④ 鉴权策略归消费方（首选 loopback 免密）；⑤ `execArgv` 启动前定死；⑥ 库**不认识** `pi` / `pi-web` / `PI_WEB_PASSWORD` / Next.js。

---

## ⑦ 观测面（四条通道 + 三条禁止判据）

| # | 通道 | 实现/命令 | 状态 |
|---|---|---|---|
| ① | **端到端证书**：端上 HTTP 自检端点 | `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts` → `{at, checks{...}}`（16 项冻结键） | ✅ `payload/selfcheck.js` |
| ② | **日志读回**：文件日志 + `/log` 端点 | `curl -s http://127.0.0.1:15577/log`（尾 8 KB，组件原生输出已被过滤）· ArkTS `Logger.tail(path, maxBytes)` | ✅ `payload/selfcheck.js` / `Logger.ets` |
| ③ | **hilog** | `hdc shell hilog -x \| grep NODE_BRIDGE`（DOMAIN `0xD0033` / TAG `NODE_BRIDGE`；C 侧 `0xD003300`） | ✅ `Logger.ets` / `write_line()` |
| ④ | **崩溃取证** | 日志内 `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=… stage=…` **＋** `<home>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`）；ArkTS 侧 `lastCrash()` ✅（JSON 损坏时从日志尾 `CRASH` 行降级重建） | ✅ C 侧 `crash_handler()` + ArkTS 侧读回 |
| ⑤ | **诊断聚合**：`GET /diag` | `curl -s http://127.0.0.1:15577/diag` → `{at, lastError, appLogTail, hostBridge}` | ✅ `payload/selfcheck.js` |
| ⑥ | **反向回传**：`POST /rport` | `curl -X POST --data-binary @file http://127.0.0.1:15577/rport` → 转发到 `127.0.0.1:${RPORT_PORT}`（缺省 19999） | ✅ `payload/selfcheck.js` |
| — | **UI 取证** | `snapshot_display` 截图 · `uitest uiInput` 点按 + 前后两次 `dumpLayout` 差异 | 消费方/探针工程 |
| — | **调试通道** | `--inspect` + `hdc fport tcp:9229`（**debug 构建才允许**；release 必须关闭，旧壳 R7） | ⬜ 未实现 |
| — | **⬜ 日志环** | 有界环形缓冲（默认 500 行）+ `logs()` —— 规划 §5.7 的核心「ArkTS 读取」面 | 🔶 `logs()` 已实现（按 `logRingSize` 读文件尾并逐行解析 §1.3）；**内存环 + 丢弃计数 ⬜ 未实现** |

**三条禁止的判据（C6 / 规划 §5.7，附录 B 症状 17/18）**

1. **hilog 里没有那一行 ≠ 没执行**（应用侧 INFO 常不进 dump 缓冲）。
2. **`VmSize` 很大 ≠ V8 起来了**（ArkTS/ArkWeb 自占约 40 GB 虚拟地址空间）。
3. **点击「看起来生效」≠ 生效**（判据是前后两次 `dumpLayout` 的差异，或 `/facts` 的功能性输出）。

---

## ⑧ 架构层面的已知缺口（Phase 划分）

| 缺口 | 归属 Phase | 影响 |
|---|---|---|
| `napi_threadsafe_function` 桥的传输层（队列有界、溢出报错、超时、`capBytes`） | Phase 2（`003`） | Node → ArkTS 能力调用不可用 |
| ✅ 载荷 `tar.gz` 自解包 + `.ready-<sha12>` 幂等 marker（含 `skipped` 计数）+ CJS/ESM 入口解析 | ~~Phase 1（`004`）~~ **已完成** | 可写载荷已可落地；只差真机验收 |
| ArkTS 侧观测面：日志环 + `logs()` + `lastCrash()`；崩溃记录 JSON 的写入侧与读回侧（含降级路径） | Phase 1（`006`） | ✅ 已完成（`logs()` 走文件尾解析；`lastCrash()` 走 JSON + 日志降级）；仅**内存日志环**未做 |
| ArkTS 侧消费原生探针 `stage()` / `lastError()` 并据此分流失败 | Phase 1（`001`+`002`） | ✅ 已完成（`getStage()`/`getLastError()`、`waitUntilRunning` 的 `exited` 快路径、`start()` 的 `-1`/`-2`/`>0` 文案） |
| 载荷侧异步异常兜底（`uncaughtException`/`unhandledRejection`）+ 入口名去应用语义 | Phase 1（`004`） | ✅ 已完成（`bootstrap.js` 顶部兜底写 `app.log`；`PI_WEB_ENTRY` 已从库侧删除，C1） |
| ✅ stdio pipe + 独立 reader 线程（含组件原生输出过滤） | ~~Phase 1~~ **已完成** | 只剩真机压测取证（TC-002-010） |
| `waitUntilRunning` / `shutdown` / `stopping` / `stopped` 状态 | Phase 1–2（`001`） | ✅ `waitUntilRunning`/`shutdown` 已实现（`shutdown` 如实标注「无法优雅停止」） |
| `compressNativeLibs` / `extractNativeLibs`（module 级） | Phase 1 | ≈44 MB 体积预算前提未成立 |
| `version >= 22.19.0` 的启动 warn | Phase 1（`001`） | C2 缺口（版本不满足时静默继续） |
| 第三方许可清单随包（G4） | Phase 2/3（`007`） | 上架合规缺口 |
