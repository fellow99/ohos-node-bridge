# 002-napi-bootstrap-native-loader —— NAPI 引导 · 原生加载与启动（plan.md）

> **配套 spec**：`specs/002-napi-bootstrap-native-loader/spec.md`（FR-002-001…027 / NFR-002-01…07 / 验收场景 §5.1–5.8）。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）· 代码 as-built（行号为 `library/src/main/cpp/node_bridge.c`，共 295 行）。
> **版本**：v1.0 · 2026-10-16 · **状态**：as-built 已闭环（骨架级）；未完成项见 §9。
> **标记**：✅ 实测 · 🔶 沿用（外部一手） · ⬜ 待验证/未实现 · ⚠️ 冲突或风险。

---

## 1. 技术上下文

### 1.1 运行环境

| 项 | 值 | 依据 |
|---|---|---|
| 形态 | HarmonyOS App **进程内**原生引导件（stage model，`apiType: stageMode`），随 HAP 编译；模块类型 HAR（`type: har`，`deviceTypes: [2in1, tablet]`） | `library/build-profile.json5:2` · `library/src/main/module.json5:2-8` |
| ABI | **仅 `arm64-v8a`**（`abiFilters`）；ELF 为 `AArch64` | `library/build-profile.json5:8-10` · 规划 §5.8 门禁 ③ |
| 工程 SDK 口径 | `targetSdkVersion 6.1.1(24)` / `compatibleSdkVersion 5.0.5(17)` | 根 `build-profile.json5:23-26` · TECH §5 #1 |
| 真机基线（证据来源设备） | `HAD-W32 / HarmonyOS 6.1.0 / **API 26** / arm64-v8a` | 规划 §D.8–§D.10 ✅ |
| 语言与标准 | **C11**（刻意不用 C++：引导件不需要 C++ 运行时，避免与 `libc++_shared.so` 版本纠缠） | `CMakeLists.txt:4` · TECH §1 |
| 构建 | CMake **3.5.0** 下限（实测工具链 CMake 3.28.2）；hvigor `externalNativeOptions.path = ./src/main/cpp/CMakeLists.txt`，`cppFlags` 空 | `CMakeLists.txt:1` · `library/build-profile.json5:4-11` · TECH §1 ✅ |
| 全局构建开关 | 根 `build-profile.json5` 的 `nativeLib.collectAllLibs = true`（决定了 HAR 会一并收集 `libc++_shared.so`） | 根 `build-profile.json5:27-30` · STRUCTURE §3 ✅ |
| 静态检查 | 仓库根 `.clang-tidy`（9 项检查）+ `.clangd`（`-Wunreachable-code-aggressive`、移除 hwasan/tsan、`UnusedIncludes: Strict`、`misc-unused-parameters.StrictMode: true`）；**没有** `library/` 级配置 | `.clang-tidy:1` · `.clangd:1-14` ✅ |
| 对象生命周期 | 进程内与宿主同寿；无窗口/无渲染语义（C1） | 规划 §5.1 |

### 1.2 依赖与链接面

| 面 | 内容 | 依据 |
|---|---|---|
| **链接（构建期）** | `libace_napi.z.so`（NAPI 注册与 `napi_*`）+ `libhilog_ndk.z.so`（系统日志）；**只有这两个** | `CMakeLists.txt:16` ✅ |
| **刻意不链接** | `libnode.so` —— 运行期用 `dlopen` 加载，使引导件与运行时版本解耦（换 Node 版本不重编译本库） | `CMakeLists.txt:13-15` · **S7** · **C7** |
| 产物落点 | `CMAKE_LIBRARY_OUTPUT_DIRECTORY` → `<module>/libs/${OHOS_ARCH}`（实际 = `library/libs/arm64-v8a/`，HAR 内为 `package/libs/arm64-v8a/libnode_bridge.so`，14,208 B ✅） | `CMakeLists.txt:10-11` · **S6** · STRUCTURE §3 |
| 运行期依赖（由 `005` 投放） | `libnode.so`（Node v24.2.0，126,809,264 B，SHA-256 `3019bf5f…51a1`，SONAME `libnode.so.137`，投放名 `libnode.so`）+ `libc++_shared.so`（1,262,504 B） | `runtime.lock.json` ✅ · 规划 §5.8 |
| ELF 门禁（上游契约） | 七项：`ET_DYN` / `PT_INTERP=0` / `AArch64` / `DT_NEEDED` 含 `libc++_shared.so` / 导出 `node::Start` / SHA-256 / 大小+版本串 | 规划 §5.8 门禁 ①②③④⑤⑥⑦ ✅ |
| 调试通道所有权 | `--inspect` 仅 debug；release 必须关闭 —— 属本模块的**参数入口**约束 | 规划 §5.7 · TECH §5 #5 ⬜ |

---

## 2. 宪法合规检查

### 2.1 原则 C1–C7

| 原则 | 判定 | 理由 / 证据 |
|---|---|---|
| **C1** 库/壳分离 | ✅ 合规 | 引导件只认识「运行时目录 / 入口脚本 / 参数串 / 家目录 / 日志路径 / 环境变量对」6 个通用入参，无窗口、无路由、无包名、无应用变量语义；`PI_*` 解释不出现（`payload/` 的 `PI_WEB_ENTRY` 兼容别名已于 2026-10-17 删除，C1 / FR-004-020） |
| **C2** 不隐藏平台真相 | ⚠️ 未达标（部分） | 投递失败（`pthread_create` 错误码）可见 ✅（`:261-266`）；但加载/符号解析失败只写日志、不回传（D8）、日志通道自身失效时静默（D7）、入参非法时静默继续（D2） |
| **C3** 让最终使用者去读 | ✅ 合规（写侧） | 本模块是「写侧」：日志文件 + 崩溃记录均由**应用域**读回（`006` 的 `tail()` / `/facts`；沙箱日志 `hdc` 读不到 ⇒ 规划 附录 B #16） |
| **C4** 启动参数不可事后修改 | ✅ 合规 | 参数只在投递时封送一次进上下文副本，此后无任何追加/修改入口；C 侧 5 个符号（S8，2026-10-17 扩充）中不存在改参 API |
| **C5** 单例与不可重启 | ⚠️ 未达标（部分） | C 侧无单次启动兜底、无「保留首次原因」（D1）；但**不提供**任何重启路径 ✅；崩溃是终态 ✅（handler re-raise，`:110-111`） |
| **C6** 诊断优先于代码 | ⚠️ 未达标（部分） | 有 4 类可观测输出（hilog、日志文件、探针、`CRASH` 行）✅；但 `CRASH` 只有文本一行、无结构化落盘，且记录点只有信号（无阶段/时间戳/tid）（D10） |
| **C7** 零上游补丁 / 二进制可替换 | ✅ 合规 | 只依赖 ELF 属性 + 入口符号名；不打补丁；换运行时只改 `runtime.lock.json`（附录 G.6 路线）；本模块用现成机制（env、`dlopen`、信号处理）而非 patch |

### 2.2 代码规约 S1–S10

| 规约 | 判定 | 理由 / 证据 |
|---|---|---|
| **S1** ArkTS 严格模式 + 原生只经 `.d.ts` | ✅ 合规 | 5 个符号的声明在 `cpp/types/libnode_bridge/index.d.ts`（`start` 6 参，2026-10-17 扩充）；`oh-package.json5` 的 `name = libnode_bridge.so` 与 import 说明符一致（`NodeRuntime.ets:2`）；本模块不新增 ArkTS 类型 |
| **S2** barrel 唯一出口 | ✅ 不受影响 | 本模块不导出 ArkTS 符号；消费面经 `001` 的 `NodeRuntime` 收口（`library/Index.ets`） |
| **S3** 类型改动即破坏性变更 | ✅ 不触发 | 不改 `Types.ets`；若未来新增符号（D8 的回传），必须同步改 `Index.ets` / `Types.ets` / `specs/README.md`（宪法 §六 变更流程） |
| **S4** 路径一律绝对 | ✅ 合规 | 引导件不调用 `getcwd`、不使用 `process.execPath`（真机 `/system/bin/appspawn`，规划 §D.8）；`argv` 里的脚本路径由调用方给出绝对路径，引导件只做拼接与长度校验 |
| **S5** 信号上下文禁用 stdio | ✅ **合规**（D6 已关闭，2026-10-17） | `raw_write_fd` 只裸 `write`；`crash_handler` 改用手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` 拼栈缓冲 + **单次 `write()`**，0 命中 `printf`/`snprintf`/`vsnprintf`/`OH_LOG_Print`（`sig_name`/`stage_hint` 只剩纯比较）。`sigsys_handler` 亦合规（无 stdio、无平台 API） |
| **S6** native 产物落点固定 | ✅ 合规（顺序待加固） | `CMakeLists.txt:10-11` 设置输出目录；⚠️ 该 `set()` 位于 `add_library()`（第 6 行）**之后**，而 CMake 文档口径是「变量在 target 创建时初始化属性」⇒ 当前正确性依赖工具链/构建系统行为（D11） |
| **S7** 引导件不链接 libnode | ✅ 合规 | `CMakeLists.txt:16` 只链 NAPI + hilog；`readelf -d` 门禁见 §7.1 |
| **S8** C 侧接口 = 5 个符号 | ✅ 合规 | `Init()` 注册 `start`/`isRunning`/`version`/`lastError`/`stage`（`start` 6 参，2026-10-17 扩充），`.d.ts` 与 `logs/20261016-1/IMPLEMENTATION_CONTRACT.md` §1.1 一一对应 |
| **S9** 日志双通道 | ✅ 合规（写侧） | `log_line` 同时 `OH_LOG_Print` + 落盘（`:62-73`）；文件读取失败返回占位串不抛，属 `006` |
| **S10** 二进制不入库 | ✅ 不触发 | 引导件由源码编译产生；`libnode.so`/`libc++_shared.so` 由 `provision.mjs` 投放，均不在 git / HAR（`.ohpmignore`、附录 G.1） |

### 2.3 证据纪律

- 本模块多数结论来自**本工程实测**（`library.har` 内 14,208 B 引导件、`runtime.lock.json` 门禁、规划 §D.8/§D.9）✅；
- **必须标 🔶/⬜ 的三处**：① SIGSYS 拦截器的**命中路径**（本机无 trap，`io_uring_setup` 返回 8，规划 §D.8）；② 32 MB 栈与「先例旧版本因 UI 线程启动被杀」的因果（🔶 §5.10 ①）；③ 原生扩展 SONAME 解析（R18 / P0-11 ⬜ 未验）。

---

## 3. 研究结论（为什么这么做 / 替代方案）

| # | 结论 | 为什么 | 被否的替代方案 |
|---|---|---|---|
| R-01 | 启动线程用 **detached**，不用 join | `node::Start` **只在进程退出时返回**（规划 §5.2 / 硬约束 ⑥）⇒ 任何 join 都是永久阻塞；UI 线程必须能继续退出 | ① join 在 UI 线程（=ANR/永久卡死）② 另建 join 线程（多一条线程只为等一个永不返回的调用）③ 不建线程直接在 UI 线程跑（`APP_INPUT_BLOCK`，规划 §5.10 ①） |
| R-02 | 栈容量 **32 MB** | 运行时在深递归/正则回溯/大分配路径上需要大栈；先例同形态同数值（🔶 §5.10 ①） | 默认栈（1–8 MB）⇒ 深调用崩溃；`pthread_attr_setstack`（自管内存，还得处理 malloc 对齐与释放）——不必要 |
| R-03 | 判定拦截命中**必须读指令编码** `0xd4000001` | `si_addr` 在 SIGSYS 上的填充依赖内核/设备行为，「PC 与 `si_addr` 相等」在部分设备恒不成立 ⇒ 拦截器静默失效、libuv 初始化直接崩（须读指令编码，§5.10 ③） | ① 比较 PC 与 `si_addr`（设备相关，❌）② 只看 `si_signo` 不判位置（无法区分 syscall trap 与其它 GNU/Linux 语义）③ 靠 `UV_USE_IO_URING=0` 单点（部分 libuv build 里 `getenv` 被优化掉，S 级风险，§5.10 ④） |
| R-04 | 拦截后返回**正好 `-1`** | 调用方把返回值当 fd 用；`-ENOSYS`/`-38` 会进入 fd 空间检查并触发 `assert(fd > STDERR_FILENO)`；同时 musl 的 `syscall()` 只在返回值落在 `[-4095,-1]` 时设置 errno ⇒ `-1` 恰好是「失败且不污染 errno」的形态（§5.10 ③④） | ① 返回 `-ENOSYS`（必崩，❌）② 返回 0（伪装成功，C2 违规，❌）③ 改 PC 不设返回值（调用方拿垃圾值，❌） |
| R-05 | `dlopen` 用 `RTLD_NOW \| RTLD_GLOBAL` | `RTLD_GLOBAL` 让运行时的符号进入全局作用域，后续原生扩展（NAPI addon）才能解析 `napi_*` 等符号（R18 / P0-11）；`RTLD_NOW` 立即绑定，把「符号缺失」提前成**可见的加载失败**而不是运行中途崩 | ① `RTLD_LOCAL`（addon 解析失败，❌）② `RTLD_LAZY`（缺失符号延后到调用点崩，C6 不利）③ `RTLD_NOLOAD`（不存在即失败，无意义） |
| R-06 | 裸名候选放在链尾是**现状**，应改为链首或至少保留 | HAP 内原生库实际落在 `/data/storage/el1/bundle/libs/arm64/`，**只有裸名 `libnode.so` 成功**，`<bundleCodeDir>/libs/arm64-v8a/…` 全失败（规划 §D.8 结论 4 / §D.9 ✅）。现状顺序是「先 3 个必然失败的绝对路径」，仅多 3 次失败 `dlopen`（D3） | ① 只留裸名（丢失「消费方把运行时投放在自定义目录」的场景）② 只留绝对路径（本机必败，❌）。**修正建议**：裸名优先，绝对候选作为兼容分支保留 |
| R-07 | 崩溃处理器内**禁用 stdio** | 信号到达时 stdio 可能正持有内部锁（信号可在任意指令处到达）⇒ 在 handler 内调用会死锁或二次崩溃；同理平台日志 API 也不安全（S5 / §5.10 ②） | ① 用 `printf`/`snprintf`（D6，**已于 2026-10-17 关闭**：改手写十进制/十六进制 + 单次 `write`）② 用 hilog（同样非信号安全）⇒ 合规面是裸 `open`/`write`/`close` + 无锁纯计算 |
| R-08 | 处理完崩溃后 **re-raise**，不吞 | 吞掉会留下一个状态未知的进程（运行时已损坏），且掩盖真实故障；系统侧 `CppCrash` 上报与决策依赖默认处置（§D.8 用 `sig=5` 判 JIT 被 W^X 拒绝，正是靠默认处置留下的记录） | ① 吞掉继续跑（C2/C5 双违规，❌）② `_exit(1)`（丢失系统侧堆栈与上报，取证变差） |
| R-09 | 崩溃处理器用 `SA_RESETHAND` | 保证「handler 自身再崩 ⇒ 不再重入 handler」，并确保 re-raise 时走默认处置；代码里再加一次 `signal(sig, SIG_DFL)` 作双保险（`:110`） | 不设 `SA_RESETHAND` + 手工 `signal()`：handler 重入窗口仍在（栈溢出连发信号场景） |
| R-10 | 拦截器用 `SA_NODEFER` | 允许在 handler 内再次接收同类信号（拦截路径不该屏蔽自身；若目标指令判定失败需要可见地失败而不是被屏蔽） | 默认屏蔽：会把「连续 trap」表现为静默卡住（更差） |
| R-11 | 环境注入放**启动之前**一次性完成（`:142-149`） | 运行时初始化即读环境（libuv 探测、`os.homedir()`/`tmpdir()` 缓存）；错过后改无效（§5.6；真机 `homedir` 默认指向沙箱外 ⇒ `EPERM`，规划 附录 B #10） | ① 由消费方各自设置（缺失即 `EPERM`，靠人记）② 改 `LD_LIBRARY_PATH` 等加载器变量（会连带影响宿主，§5.6 明确「不改」） |
| R-12 | HAP 内原生库**不需要** `.codesign` | 真机实测：无签名段的锁定产物 `dlopen` 成功、`hilog` 中 `xpm`/`unsigned file` 0 命中（§D.6/§D.9 ✅）⇒ `provision --sign` 只服务独立分发（属 `005`） | 随包自签（无收益，且引入密钥面，R7 已关闭） |

---

## 4. 数据模型

### 4.1 `bridge_ctx`（一次性入参副本，`:126-133`）

| 字段 | 声明 | 长度常量 | 写入点｜来源 | 约束 / 备注 |
|---|---|---|---|---|
| `lib_dir` | `char[512]` | `CTX_PATH_LEN = 512`（`:43`） | `js_start` 第 1 实参（`:241`）｜上游 `NodeRuntime.ets:73` = `context.bundleCodeDir` | 仅用于拼 3 个绝对候选；空值 ⇒ 候选链退化为裸名 |
| `script` | `char[512]` | `CTX_PATH_LEN` | `js_start` 第 2 实参（`:242`）｜`options.scriptPath` | 必须是绝对路径（S4）；>511 B **静默截断**（D2） |
| `flags` | `char[256]` | 字面量 | `js_start` 第 3 实参（`:243`）；空 ⇒ `--no-verify-heap`（`:246`） | 空格分词；无引号/转义；>10 token 静默丢弃（D2） |
| `home` | `char[512]` | `CTX_PATH_LEN` | `js_start` 第 4 实参（`:244`）｜`context.filesDir` | 注入 `HOME`/`USERPROFILE` |
| `tmp` | `char[512]` | `CTX_PATH_LEN` | 派生 `home + "/tmp"`（`:247`）+ `mkdir(0755)`（`:249`，返回值未检查） | 注入 `TMPDIR`/`TMP`/`TEMP` |
| `log` | `char[512]` | `LOG_PATH_LEN = 512`（`:42`） | `js_start` 第 5 实参（`:245`）｜`Env.logPath()` | 复制进 `g_log_path`；标准输出/错误重定向目标；`O_APPEND` 打开（`:185`） |

### 4.2 全局状态

| 名字 | 声明 | 写入点 | 语义 / 关键属性 |
|---|---|---|---|
| `g_log_path` | `static char[512]`（`:47`） | `:248` 写入；`:263` 在投递失败时清空 | 文件日志通道的**唯一坐标**；清空后 `raw_write` 直接返回（D7） |
| `g_node_running` | `static volatile int`（`:48`） | `:218` 置 1、`:222` 置 0 | 健康探针；`isRunning()` 只读它（`:275`）；崩溃即进程消失 ⇒ 不承诺崩溃后语义 |
| `g_ctx` | `static bridge_ctx`（`:135`） | `:239` `memset` 清零、`:241-245` 逐字段写入 | 进程级单份、**无同步**：调用线程写、引导线程读（D1） |
| `argbuf` | `static char[12][512]`（`:196`） | `:205`（flags token）、`:211`（脚本） | 约 6 KB `.bss`；是 argv 各项的实际存储，`argv` 只存指针 |
| `argv0` | `static char[] = "node"`（`:195`） | 编译期 | `argv[0]` 常量（不含路径，符合 Node 约定） |
| `cand[4][640]` | 栈上局部（`:160`） | `:162-165` | 候选链字符串；`snprintf` 结果未检查长度（640 足以容纳 512+前缀） |

### 4.3 信号 → 处置表

| 信号 | 处理器 | 标志 | 行为 | 依据 |
|---|---|---|---|---|
| `SIGSYS` | `sigsys_handler`（`:77-87`） | `SA_SIGINFO \| SA_NODEFER`（`:93`） | 读 PC 处指令；命中 `0xd4000001` ⇒ 置 `regs[0] = -1`、`pc += 4`；未命中 ⇒ **直接返回**（D4） | §5.10 ③④ |
| `SIGSEGV` | `crash_handler`（`:100-112`） | `SA_SIGINFO \| SA_RESETHAND`（`:119`） | 拼 `CRASH …` 行 → 裸 `O_APPEND` 写 `g_log_path` → `signal(DFL)` → `raise(sig)` | C6 / §5.10 ⑬ |
| `SIGILL` / `SIGBUS` / `SIGABRT` / `SIGFPE` / `SIGTRAP` | 同上 | 同上 | 同上（`SIGTRAP` 是「无 ACL 时 JIT 被 W^X 拒绝」的真机症状信号，§D.8） | §D.8 · 附录 B #19 |

安装时机：`install_crash_handlers()` 在 `js_start` 内（`:251`，ArkTS 线程）调用；拦截器在引导线程内最先安装（`:141`）。**未包含** `SIGPIPE`/`SIGKILL`（不可捕获）/`SIGSTOP`。

### 4.4 常量

`MAX_ARGS = 12` · `LOG_PATH_LEN = CTX_PATH_LEN = 512` · 候选路径 640 B · `log_line` 行缓冲 1024 B · 崩溃记录缓冲 640 B · 栈 `32 MiB` · 候选数 4 · 探针入参 `8` · 被 trap 的调用号 `425` · 指令编码 `0xd4000001` · `LOG_DOMAIN 0xD0033` / `LOG_TAG "NODE_BRIDGE"`（**必须**与 ArkTS 侧 `Logger.ets` 的 `DOMAIN` 相同，A1/R2）· 版本串 `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`。

---

## 5. 接口契约

### 5.1 提供（NAPI 面，唯一对外契约）

| 符号 | C 签名 | `.d.ts` 声明 | 返回值语义 |
|---|---|---|---|
| `start` | `js_start` | `start(libDir, scriptPath, flags, home, logPath, envPairs): number`（`index.d.ts`，**6 参**） | `0` = 已投递到后台线程（**不代表已起来**）；非 `0` = 校验/`pthread_create` 的**错误码**（非负 errno 值或 `-2` 非法参数） |
| `isRunning` | `js_is_running` | `isRunning(): number`（`index.d.ts`） | `1` = 已进入运行时入口且未返回；`0` = 未进入/已返回 |
| `version` | `js_version` | `version(): string`（`index.d.ts`） | `node_bridge/0.2.0 (ohos-node-bridge Phase 1)`，构建期常量，排障第一读数 |
| `lastError` | `js_last_error` | `lastError(): string`（`index.d.ts`） | 最近一次原生层失败原因；无失败返回 `""`（C2，2026-10-17 扩充） |
| `stage` | `js_stage` | `stage(): string`（`index.d.ts`） | `init`/`stdio`/`dlopen`/`dlsym`/`start`/`running`/`exited`（2026-10-17 扩充） |

- 模块注册：`NAPI_MODULE(node_bridge, Init)`（`:295`）；import 说明符由类型包名决定（`types/libnode_bridge/oh-package.json5:2` → `libnode_bridge.so`），与 clang-tidy `misc-napi-macro-module-name` / `misc-napi-module-name` 的检查口径一致。
- 参数全部为**字符串**（`start` 6 参；`argc` 上限 6，多余实参被忽略）；缺省值见 §4.1；失败/截断均有可见证据（2026-10-17）。
- 失败-可见性矩阵（现状）：

| 失败点 | 日志（hilog / 文件） | 返回值 | 上游能否判定 |
|---|---|---|---|
| `pthread_create` 失败 | `pthread_create failed rc=%d`（`:262`） | 非 0 错误码 | ✅ 直接可判 |
| 入参非法（类型/空） | 无 | `0`（假成功） | ❌（D2） |
| 运行时库定位失败 | 4 条候选 + `FATAL`（`:170,174`） | `0` | 只能读日志（D8） |
| 符号缺失 | `dlsym(...) -> 0x0` + `FATAL`（`:179,181`） | `0` | 只能读日志（D8） |
| 运行时入口提前返回 | `node::Start returned rc=%d errno=%d`（`:223`） | 无新调用 | `isRunning()` 归 0 ✅（部分） |
| 崩溃 | `CRASH …`（`:103-107`） | 进程消失 | 只能读日志（结构化 ⬜） |

### 5.2 消费（平台 API 与依据）

| API 类别 | 具体调用（行号） | 依据 / 约束 |
|---|---|---|
| 动态加载 | `dlopen` / `dlsym` / `dlerror`（`:167-183`） | 候选链 + `RTLD_NOW\|RTLD_GLOBAL`（R-05/R-06）；`dlerror()` 只在失败分支取用 |
| 线程 | `pthread_attr_init/setstacksize/destroy`、`pthread_create`、`pthread_detach`（`:253-267`） | detached 语义（R-01）、32 MB 栈（R-02） |
| 信号 | `sigaction`（`:95,121`）、`signal`（`:110`）、`raise`（`:111`） | S5：handler 内只允许裸 I/O（R-07/R-08/R-09/R-10） |
| 环境 | `setenv`×7（`:142-148`）+ `unsetenv`（`:149`） | §5.6：`UV_USE_IO_URING=0`、`HOME`/`USERPROFILE`、`TMPDIR`/`TMP`/`TEMP`、`NODE_ENV=production`、清空 `NODE_OPTIONS`；**不**改 `LD_LIBRARY_PATH` |
| 文件/描述符 | `open`（`:55,108,185`）、`write`（`:57,109`）、`close`、`dup2`（`:187-188`）、`mkdir`（`:249`）、`setvbuf`（`:191-192`） | `O_WRONLY\|O_CREAT\|O_APPEND, 0644`；`stdout` 行缓冲、`stderr` 无缓冲 |
| 系统调用直通 | `syscall(SYS_gettid)`（`:139`）、`syscall(425, 8, &p)`（`:155`） | 探针**只记录不判定**（§D.8：本机返回 8）；tid 用于排障 |
| 格式化 | `vsnprintf`（`log_line`）、`snprintf`（候选链/参数装配等） | 均在**非**信号上下文；崩溃 handler 内 **0 命中**（D6 已于 2026-10-17 关闭）；`strtok` 非线程安全（D12） |
| 平台日志 | `OH_LOG_Print`（`:69`） | 只在 `log_line` 内（非信号上下文），`%{public}s` + 域/标签见 §4.4 |
| NAPI | `napi_get_cb_info` / `napi_get_value_string_utf8` / `napi_create_int32` / `napi_create_string_utf8` / `napi_define_properties`（`:234-292`） | 返回值/`status` 多数未检查（D2） |

### 5.3 日志协议

- **`raw_write(s)`**（`:53-60`）：把 `s` 原样 `O_APPEND` 写入 `g_log_path`；**不**自动补换行、**不**加时间戳；`g_log_path` 为空或 `open` 失败时**静默返回**（D7）。信号上下文唯一允许的写路径（S5）。
- **`log_line(fmt, ...)`**（`:62-73`）：`vsnprintf` 到 1024 B 栈缓冲 → `OH_LOG_Print(INFO)` → `raw_write(buf)` + `raw_write("\n")`。约定：一行一次调用；超过 1023 B 被截断（无提示）。
- **稳定行格式（评审/脚本可 grep）**：

| 事件 | 格式 | 触发点 |
|---|---|---|
| 线程启动 | `[node_bridge] thread start; tid=%ld` | `:139` |
| 探针 | `[node_bridge] io_uring_setup(425) -> %ld (errno=%d)` | `:156` |
| 候选尝试 | `[node_bridge] dlopen('%s') -> OK\|<dlerror()>` | `:170` |
| 候选全败 | `[node_bridge] FATAL: 无法加载 libnode.so（请确认已用 tools/provision.mjs 投放运行时）` | `:174` |
| 符号 | `[node_bridge] dlsym(node::Start) -> %p` / `FATAL: dlsym 失败: %s` | `:179,181` |
| argv 自检 | `[node_bridge] argv[%d]=%s` + `calling node::Start(argc=%d) ...` | `:216-217` |
| 入口返回 | `[node_bridge] node::Start returned rc=%d errno=%d（正常应只在退出时返回）` | `:223` |
| 投递 | `[node_bridge] bootstrap thread created (detached)` / `pthread_create failed rc=%d` | `:268,262` |
| 崩溃（裸写，唯一无前缀行） | `CRASH sig=%d si_addr=%p pc=%p lr=%p sp=%p r0=%p` | `:103-107` |

- 已知协议缺口：文件行**无时间戳**、无阶段字段 ⇒ 与 hilog 对齐只能靠顺序（D10）。

---

## 6. 实现策略

### 6.1 架构模式

```
ArkTS（001-runtime-core）                     libnode_bridge.so（本模块）
  NodeRuntime.start(...) ── 5 字符串 ──▶  js_start
                                            ├─ memset/拷贝 g_ctx（无锁）
                                            ├─ 缺省值装配（flags/tmp）
                                            ├─ install_crash_handlers()   ← ArkTS 线程
                                            └─ pthread_create(32 MB) ─┐
                                              pthread_detach；return 0  │
                                                                        ▼
                                              bootstrap()（引导线程）
                                                setenv×7 / unsetenv
                                                syscall(425) 探针（只记录）
                                                dlopen 候选链 → dlsym
                                                dup2 1/2 → node.log
                                                argv 构造（无 NULL 哨兵）
                                                g_node_running = 1
                                                node::Start(argc, argv)  ← 直到进程退出
```
- 边界：C 侧**不**持有状态机、不做轮询/超时/重试、不关心端口与渲染；状态机由 `001` 拥有，C 侧只贡献 1 个探针位与日志/崩溃证据。
- 一次性：从 `js_start` 到 `node::Start` 的路径设计为**不可重复**（`node::Start` 每进程一次，硬约束 ⑥），Phase 1 补 C 侧兜底（D1）。

### 6.2 关键算法

**① 候选链加载（`:159-176`）**

```
for i in 0..3:
    h = dlopen(cand[i], RTLD_NOW|RTLD_GLOBAL)
    log_line("dlopen('%s') -> %s", cand[i], h ? "OK" : dlerror())
    if h: break
if !h: log_line(FATAL 投放提示); return NULL      // 线程以 NULL 结束（返回值不可回收，见 D8）
```
候选：`<libDir>/libs/arm64-v8a/libnode.so` → `<libDir>/libnode.so` → `<libDir>/libs/arm64/libnode.so` → `libnode.so`。真机只有第 4 个命中（🔶 §D.8 / ✅ §D.9 复验）⇒ 顺序待调（D3）。

**② argv 构造（`:194-214`）与边界证明**

```
argv0 = "node"; argc = 1
for tok in split(flags, ' '):
    if argc >= MAX_ARGS-1 (11): 丢弃其余 token（D2：应告警）
    argbuf[argc] = tok; argv[argc] = argbuf[argc]; argc++
argbuf[argc] = script; argv[argc] = …; argc++
argv[argc] = NULL                      // 哨兵；**不计入**传给 node::Start 的 argc
```
- 上界：`argc ≤ 1 + 10 + 1 = 12 = MAX_ARGS`；脚本写入索引 `≤ 11 < 12` ⇒ `argbuf[12][512]` **不越界** ✅。
- 指针数组：`char *argv[MAX_ARGS+1]` = 13 槽，最大写入索引 `12`（NULL）⇒ **不越界** ✅。
- 硬约束：传给入口的 `argc` **不含**尾部 NULL 哨兵（多算一个 ⇒ 入口拿到 NULL ⇒ 5 ms 内段错误，附录 B #3）。

**③ 拦截判定（`:77-87`）**

```
insn = *(uint32_t *)pc                  // 读被 trap 指令（AArch64 定长 4 B；D14：无保护读）
if (insn == 0xd4000001) { regs[0] = (uint64_t)-1; pc += 4; }   // 其余分支：静默返回（D4）
```
不变量：命中后调用方看到「返回 -1 且 errno 未被修改」（R-04）；本机无 trap ⇒ 该分支未被执行过（🔶/⬜）。

**④ 崩溃取证写入路径（`:100-112`）**

```
lb_append* 手写组装 "CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…"   // 2026-10-17：D6 已关闭（原实现为 snprintf）
fd = g_log_path[0] ? open(g_log_path, O_WRONLY|O_CREAT|O_APPEND, 0644) : -1
if (fd >= 0) { write(fd, buf, strlen(buf)); close(fd); }           // 无 fsync（可接受：进程即将终止）
signal(sig, SIG_DFL); raise(sig);                                   // 交还默认处置
```
Phase 1 目标：改为「裸写 + 结构化 JSON 双落点」，见 §9.1 ②。

### 6.3 错误处理（每条失败路径的文本与可见性）

| # | 失败路径 | 现状文本 | ArkTS 可见性（现状 → 目标） |
|---|---|---|---|
| E1 | 投递线程创建失败 | `pthread_create failed rc=%d`（`:262`） | 返回非 0 ✅（唯一直接可见的失败） |
| E2 | 候选全败（缺库/缺 `libc++_shared.so`） | 4 条候选 + `FATAL: 无法加载 libnode.so…`（`:170,174`） | 只读日志 → 结构化回传（§9.1 ③） |
| E3 | 符号缺失 | `dlsym(node::Start) -> 0x0` + `FATAL: dlsym 失败: %s`（`:179,181`） | 同上 |
| E4 | 入参类型错/为空 | **无文本** | 假成功（D2）→ 拒绝 + 明确日志 |
| E5 | 超长/超量丢弃（flags/scriptPath/token） | 无文本（仅 argv 自检可间接看出） | D2 → 告警行 |
| E6 | 日志文件不可写（目录不存在/权限） | **无文本**（`raw_write`/`dup2` 静默，`:56,186`） | D7 → hilog 降级提示 + 返回码/状态 |
| E7 | 家目录下 `tmp/` 创建失败 | **无文本**（`mkdir` 返回值未检查，`:249`） | D7 → 告警（否则表现为载荷侧 `ENOENT`） |
| E8 | 入口提前返回（如参数非法被 Node 拒绝） | `node::Start returned rc=%d errno=%d`（`:223`） | `isRunning()` 归 0 ✅；原因需读日志（或结构化 ⬜） |
| E9 | 崩溃（6 信号） | `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…`（`:103-107`） | 日志文件 ✅；结构化 JSON ⬜（§9.1 ②） |
| E10 | 拦截器遇非目标指令 | **无文本**（`:86` 直接返回） | D4 → 记录 + 默认处置（否则活锁） |
| E11 | 探针系统调用成功（无 trap 机型） | `io_uring_setup(425) -> 8 (errno=0)`（`:156`） | ✅（同时暴露 D5 的越界写风险） |

### 6.4 性能

| 项 | 事实 / 取舍 |
|---|---|
| 投递开销 | `pthread_attr_*` + `pthread_create` + `pthread_detach` 后立即返回；**不**等待加载、不做握手、不加锁 ⇒ UI 线程返回时间与运行时体积无关（NFR-002-03） |
| 线程栈 | `pthread_attr_setstacksize(32 MiB)` 只申请**虚拟**地址空间，物理页按需提交；真机 RSS 增量应远小于 32 MB（⬜ 未单独量测） |
| 加载耗时 | `dlopen` 一个 120.9 MiB、带 V8 快照与 ICU 的共享库的耗时**未实测**（⬜；参考基线：自检载荷首启可见性记录见 §D.8）⇒ 记入 Phase 1 回归项 |
| stdio 行为 | 现状直接 `dup2` 到文件（`:185-190`）：`stdout` 行缓冲 ⇒ 每行一次 `write`；`stderr` 无缓冲 ⇒ 每次调用一次 `write`；输出量大时形成 syscall 压力，且与宿主渲染组件的原生输出**混流**（§D.10 ⑱，D9）。Phase 1 目标 = 1 MB 管道 + 独立排空线程（§5.10 ⑤ / R19） |
| 热路径 | 引导线程内无循环、无定时器；`isRunning()` 只读 `volatile int`（`:275`）⇒ 调用成本与 NAPI 边界成本同阶 |
| 内存 | `argbuf` 6 KB `.bss`；候选串 2.5 KB 栈；`log_line` 1 KB 栈；崩溃缓冲 512 B 栈 ⇒ 引导件稳态静态内存 < 10 KB（附录 C：14,208 B 产物） |
| 日志增长 | 无上限、无轮转（D9）⇒ 长跑会话下 `<filesDir>` 增长需消费方兜底（`006`/消费方） |

---

## 7. 测试考虑

### 7.1 host 侧可测点（不接真机）

| # | 检查 | 期望 / 判据 | 现状 |
|---|---|---|---|
| H1 | 链接面 | `readelf -d library/libs/arm64-v8a/libnode_bridge.so \| grep NEEDED` ⇒ 只有 `libace_napi.z.so`、`libhilog_ndk.z.so`（**无** `libnode.so`，S7） | 代码 ✅ / 门禁 ⬜（无脚本） |
| H2 | 落点 | 产物路径 = `library/libs/arm64-v8a/libnode_bridge.so`（S6；不设输出目录则 HAP 内无 `libs/`，附录 B #12） | ✅（HAR 条目印证） |
| H3 | 符号面 | `strings` 断言存在 `_ZN4node5StartEiPPc`、`node_bridge`、`node_bridge/0.2.0 (ohos-node-bridge Phase 1)`、`UV_USE_IO_URING`、`NODE_ENV`、`NODE_OPTIONS`、`io_uring_setup(425)`、`CRASH sig=`；`readelf -x .init_array` 非空（NAPI 模块构造函数） | ⬜ |
| H4 | **信号安全门禁**（S5） | 抽取两个 handler 的函数体，断言 0 命中 `printf\|snprintf\|vsnprintf\|OH_LOG_Print\|malloc\|free` | ✅ **已过**（2026-10-17：`crash_handler` 只用 `u64_to_dec/hex` + `lb_append*` + 单次 `write`；见 R2） |
| H5 | 编译告警 | `-Wall -Wextra`（建议再加 `-Werror`）下 0 告警 | ⬜ 现状未开（NFR-002-05） |
| H6 | 静态检查 | 仓库根 clang-tidy 9 项 + clangd `UnusedIncludes: Strict` 通过；重点 `misc-napi-module-name` / `misc-napi-macro-module-name`（模块名与 import 名一致）、`misc-unused-parameters` | ⬜ 未纳入流水线 |
| H7 | 边界单测（argv / 候选链 / SIGSYS 判定） | 把 `bootstrap` 的 argv 段与 handler 判定抽成可测函数，在 host 上用桩替换 `dlopen/dlsym`：断言 argc、哨兵位置、丢弃告警、`insn==0xd4000001` ⇒ `regs[0]==(uint64_t)-1 && pc==old+4` | ⬜ 无测试基建（`tests/smoke-host.mjs` 不存在） |
| H8 | 工具链口径 | `cmake_minimum_required(VERSION 3.5.0)`；`CMAKE_C_STANDARD 11` 生效 | ✅ |

### 7.2 真机可测点（四条通道；规划 §5.7 / 附录 A / §D.8）

| 通道 | 读法 | 判据 |
|---|---|---|
| ① hilog | `hdc shell hilog \| grep NODE_BRIDGE` | 出现 `thread start; tid=`、候选链结果、`argv[n]=`、`created (detached)` 等行；⚠️ 应用 INFO 常不进 dump 缓冲 ⇒ **不得**用「有没有那行」判执行（§5.7 禁止判据） |
| ② 日志文件 | 仅**应用域**可读：`/log` 端点（`payload/selfcheck.js` 尾 8 KB）或消费方诊断面板 | 文件里出现同一批行 + Node 自身输出；⚠️ `hdc` 直读沙箱日志 `permission denied`（附录 B #16） |
| ③ 探针（状态） | `NodeRuntime.isRunning()`（`001`） | 启动后为 1；载荷主动退出或入口返回后为 0 |
| ④ 端到端证书 | `hdc fport tcp:<port> tcp:<port>` + `curl /facts` | 200 + JSON（`node/platform/arch/execArgv/…`）——「一次真机成功运行」的证书（§5.7） |
| 补充 | 崩溃取证 | 触发 6 个信号之一（如载荷内 `process.abort()`）：日志出现完整 `CRASH …` 行；系统侧仍记 `Cpp Crash`（re-raise 生效） |

### 7.3 边界用例

| # | 输入 | 期望行为 | 关联 |
|---|---|---|---|
| B1 | `flags = ''` | 使用缺省 `--no-verify-heap` | FR-002-004 ✅ |
| B2 | `flags` 长 256 B（超上限） | 截断**告警**；argv 仍自洽 | D2 ⬜ |
| B3 | `flags` 含 12 个 token | 保留 10 个 + 脚本，其余丢弃并告警 | D2 ⬜ |
| B4 | `scriptPath` 512+ 字符 | 拒绝或告警；不得静默截断后启动错文件 | D2 ⬜ |
| B5 | `scriptPath = ''` | 拒绝且**不消耗**唯一启动机会 | FR-002-005 ⬜ |
| B6 | 非字符串实参（number/undefined/缺参） | 拒绝 + 明确日志；不得假成功 | D2 ⬜ |
| B7 | `libDir = ''` | 候选链退化为裸名；仍能加载（若库在搜索路径上） | §4.1 ✅ |
| B8 | 缺 `libnode.so` | 4 条候选 + `FATAL`；进程存活（Node 未起） | §5.1 ✅ |
| B9 | 缺 `libc++_shared.so` | `dlopen` 失败，`dlerror` 文本含缺失库名（附录 B #2） | ✅ |
| B10 | 运行时无 `node::Start` 导出 | `dlsym -> 0x0` + `FATAL: dlsym 失败` | §5.2 ✅ |
| B11 | 日志目录不存在 | **可见**降级提示（现在无） | D7 ⬜ |
| B12 | 二次投递 | 拒绝、不覆写上下文、返回「已拒绝」 | D1 ⬜ |
| B13 | 无 ACL + 不带 `--jitless` | 进程 SIGTRAP（真机既定事实，§D.8）⇒ 崩溃记录必须可定位 | §D.8 ✅（属平台前置，非本模块缺陷） |

### 7.4 可证伪的补测判据（把 🔶/⬜ 变 ✅）

| 待验证 | 判据（可证伪） |
|---|---|
| 拦截器**命中路径** | 在 host 侧单测里以构造的 `ucontext`（PC 指向含 `0xd4000001` 的内存、`regs[0]=0`）调用抽取后的判定函数，断言 `regs[0]==(uint64_t)-1` 且 PC 前进 4；再以非目标指令断言「记录 + 默认处置」分支被走到。真机层面只有在会 trap 的机型上才能端到端复现（本机返 8，§D.8）⇒ 该路径证据等级在真机侧维持 🔶 |
| `UV_USE_IO_URING=0` 是否在锁定 libuv build 里生效 | 在真机 `--jitless` 载荷里读 `/proc/self/environ` 或打印该变量确认传入；结合拦截器是否被触发判定「双保险是否只有一层」 |
| 32 MB 栈是否必要 | 把栈降到 2 MB 跑同一自检载荷，观察是否出现栈溢出类崩溃（若同样通过，则 32 MB 是余量而非下限）——**结论只用于文档口径，不改变实现** |
| SONAME（R18 / P0-11） | 编一个最小 NAPI addon，`DT_NEEDED=libnode.so.137`，在真机 `process.dlopen` 加载：成功 ⇒ 无需处理；失败 ⇒ 投放时同时提供 `libnode.so.137`（或改 addon 链接名），并把结论写回规划 §5.8/G.7 |

---

## 8. 文件清单（真实 `wc -l`，2026-10-16）

| 文件 | 行数 | 本模块角色 |
|---|---|---|
| `library/src/main/cpp/node_bridge.c` | **295** | 引导件全部实现（NAPI 3 符号 / 线程 / 拦截 / 崩溃 / 日志 / argv） |
| `library/src/main/cpp/CMakeLists.txt` | **16** | C11、SHARED、输出落点、链接面（S6/S7） |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | **15** | 环境声明：`start`/`isRunning`/`version`（S1/S8） |
| `library/src/main/cpp/types/libnode_bridge/oh-package.json5` | **6** | 类型包元数据（`name = libnode_bridge.so`，`version 0.1.0`） |
| `library/build-profile.json5` | **18** | `apiType: stageMode`；`externalNativeOptions` → CMake；`abiFilters=[arm64-v8a]` |
| `library/src/main/module.json5` | **24** | `type: har`、`deviceTypes`、2 条开放权限（ACL 留给消费方，§9.4） |
| `.clang-tidy`（仓库根） | **1** | 9 项检查（NAPI 命名、未用变量/参数、系统能力等） |
| `.clangd`（仓库根） | **16** | 诊断与 clang-tidy 选项、`UnusedIncludes: Strict` |
| 根 `build-profile.json5` | **61** | `nativeLib.collectAllLibs=true`（HAR 会带 `libc++_shared.so`）、SDK 口径、签名配置 ⚠️（见 STRUCTURE §8.1 #1） |
| `library/src/main/ets/runtime/NodeRuntime.ets` | 798 | **下游**：唯一允许的接入点（消费 5 个符号） |
| `library/src/main/ets/runtime/Types.ets` | 49 | 下游类型契约（S3；本模块不触发变更） |
| `library/src/main/ets/log/Logger.ets` | 53 | 下游：hilog 双通道 + `tail()` 读回 |
| `library/src/main/ets/util/Env.ets` | 65 | 下游：沙箱路径（`logPath`/`filesDir` 来源，S4） |
| `library/Index.ets` | 21 | barrel（S2） |
| `specs/002-napi-bootstrap-native-loader/spec.md` · `plan.md` | **226** · 本文件 | 本规格对 |

> 规划 §7.2 写的是 `library/src/main/libs/arm64-v8a/`，as-built 实际为 `library/libs/arm64-v8a/`（STRUCTURE §3/§9 已登记）；本模块以 as-built 为准。

---

## 9. Phase 1 未完成项清单

### 9.1 必做（规划明文要求）

| # | 事项 | 依据 | **具体验收判据** |
|---|---|---|---|
| ① | **标准输出/错误改「1 MB 管道 + 独立 reader 线程持续排空」**（标准输入接 `/dev/null`） | §5.10 ⑤ · R19 · §D.10 ⑱ · spec FR-002-018 / NFR-002-02 | A) 载荷向标准输出连续写 ≥10 MB（或 `for(;;)console.log(...)` 10 s）时，`server.listen()` 正常、ArkWeb 页面正常绘制、**无**白屏、**无** ANR；B) reader 线程逐行转投（hilog + 文件）后，`/log` 尾 8 KB **只含** Node 输出，不再混入宿主渲染组件的原生输出（对比 §D.10 ⑱ 的 16 KB 记录）；C) 管道容量满（1 MB）时写方阻塞而非丢失，且 1 s 内被排空恢复；D) 进程退出/`fd` 关闭时 reader 线程能退出，无死锁、无「最后 N 行丢失」 |
| ② | **崩溃记录结构化落盘** `<filesDir>/node-bridge/last-crash.json` | C6 · §5.7 · §5.10 ⑬ · spec §5.5 | A) 触发 SIGSEGV/SIGABRT/SIGTRAP 后文件**存在**且 `JSON.parse` 成功；B) 必含字段 `at`（时间）、`stage`（`load`/`symbol`/`stdio`/`start`）、`signal` 号与名、`si_addr`、`pc`、`lr`、`sp`、`r0`、`tid`、`logTail`（≤8 KB 或末 50 行）；C) 生成过程只用裸 `open`/`write`/`close`（H4 门禁 0 命中 stdio）；D) 下次启动 `006-observability` 的 `lastCrash()` 能读回并转成 `CrashRecord`；E) `.clang-tidy` + H4 门禁通过；F) 产物仍 ≤ 1 MB（NFR-002-04） |
| ③ | **加载/符号/入口返回值回传 ArkTS** | C2 · spec FR-002-027 | A) 新增回传面（如 `lastError(): string` 或回调）后，缺库 / 缺符号 / 入口提前返回三种场景下，ArkTS **不读日志**即可拿到 `{stage, code, detail}`；B) 同步更新 `index.d.ts` + `specs/README.md` 编号表（S8 + 宪法 §六 变更流程）；C) **`detached` 线程返回值不可回收** ⇒ 必须走共享状态（原子/受锁结构）而非线程返回值；D) 重复调用语义与 `001` 状态机一致（`FAILED` 携带原因） |
| ④ | **`--inspect` 仅 debug 构建** | §5.7 · TECH §5 #5 · 旧壳 R7 | release 构建下 `flags` 含 `--inspect` 时必须**拒绝并记日志**（不能只靠文档约定）；debug 下可用 `hdc fport tcp:9229` + DevTools 连上并 `Runtime.evaluate` |
| ⑤ | **多版本 `libnode.so` 的 SONAME 处理** | R18 · P0-11（⬜ 未验）· 锁文件 `soname=libnode.so.137` / `deployAs=libnode.so` | 见 §7.4 末条判据；结论必须写回规划 §5.8 / 附录 G.7 |
| ⑥ | **默认 `flags` 定案（偏差已记录）** | §5.3（草案缺省含 `--expose-internals`）· §4.2 ⑤ · TECH §5 #4 | **已定案**：库默认 `flags = '--no-verify-heap'`（真机验证过的值，最小可用集）；`--expose-internals` **只在载荷走 internal-module stub 路线时才必需**，由消费方经 `flags`/`execArgv` 显式传入（规划 §5.3 草案默认值被本行取代；不再算不一致） |

### 9.2 缺陷登记（评审必读：现状与代码/规划不一致或真实风险）

| ID | 缺陷 | 位置（行号） | 影响 | 修法 / Phase |
|---|---|---|---|---|
| **D1** | 上下文为**进程级单份**且无同步；C 侧无单次启动兜底 | `g_ctx:135`、写 `:239-245`、读 `:138-217` | 二次投递会 `memset` 掉引导线程正在读的字段 ⇒ 路径变垃圾（数据竞争）；违反 C5 的「保留首次原因」 | 在 `js_start` 首部加「已投递」原子标志并拒绝二次调用；`bootstrap` 改读**局部快照**（复制 `g_ctx`）。Phase 1（FR-002-002/009） |
| **D2** | 无前置校验 + 静默截断/丢弃 | `:241-245`（`napi_get_value_string_utf8` 的 `status`/`len` 未检查）、`:204`（token 上限丢弃）、`:205,211`（`snprintf` 截断）、`:239`（未判 `argc`） | 非法调用返回「已投递」⇒ 消耗唯一启动机会且失败不可见（C2 违规） | 校验必填/类型/长度；截断与丢弃打告警行；非法调用返回非 0 且不建线程。Phase 1 |
| **D3** | 候选顺序与 §D.8「应优先裸名」相反 | `:162-165` | 每次启动多做 3 次必败 `dlopen`（并写 3 行噪声日志）；掩盖「库不在搜索路径」的真因 | 裸名置首（绝对候选保留为兼容分支）；或命中裸名后短路。Phase 1（FR-002-010） |
| **D4** | 拦截器遇**非目标指令**直接返回 ⇒ **无限重投同一故障**（活锁） | `:83-86` | 设备/内核行为差异时表现为「启动卡死无输出」，最难查的一类 | 未命中分支：裸写一行标记 → `signal(SIGSYS, SIG_DFL)` → `raise(SIGSYS)`（可见失败，不静默）。Phase 1（FR-002-014） |
| **D5** | 探针把内核写回的 `struct io_uring_params`（120 B）写进 **8 B** 的局部变量 `void *p`；成功时不关闭返回的 fd | `:153-156` | 无 trap 机型（**本机就是这样**）⇒ **栈越界写** + fd 泄漏（当前 `rc=8` 未被使用也未关闭） | 传入 ≥256 B 对齐缓冲（`char pbuf[256] __attribute__((aligned(8)))`）；`rc >= 0` 时 `close(rc)`。Phase 1（FR-002-016） |
| **D6** | 崩溃处理器内用 `snprintf`（stdio，非信号安全） | 历史：`:103-107`（行号属旧快照） | 违反 **S5**；信号到达时若 stdio 持锁 ⇒ 死锁/二次崩溃 ⇒ **丢了本该留下的崩溃证据** | ✅ **已修（2026-10-17）**：手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` + 单次 `write`；H4 门禁已过（FR-002-022 / NFR-002-01） |
| **D7** | 日志通道失效全静默 | `raw_write` `:56`、`dup2` 分支 `:185-190`、`mkdir` `:249`、投递失败清空 `:263` | 目录不存在/无权限时「启动了但没有任何日志」，与 C2 冲突；载荷侧表现为莫名的 `ENOENT` | 打开失败时至少 `OH_LOG_Print` 一条降级提示（非信号上下文）并置可见状态。Phase 1（FR-002-024） |
| **D8** | 加载/符号/入口返回值不回传；`detached` 线程返回值**不可回收** | `:167-183`（失败只 `return NULL`）、`:220-223` | 上游 `state=FAILED` 只能靠日志文本或探活超时推断；「靠 pthread 返回码」在本实现里**不成立**（`pthread_detach` 已丢弃返回值） | 共享状态 + 可选 threadsafe function 回传（§9.1 ③）。Phase 1（FR-002-027） |
| **D9** | 日志文件**无上限、无轮转**；与宿主渲染组件的原生输出**混流**同一 fd | `:185-190` · §D.10 ⑱ | 长跑会话下沙箱磁盘增长不可控；诊断时噪声淹没 Node 输出 | §9.1 ①（管道 + 通道分离）+ 消费方/`006` 侧轮转策略。Phase 1/2 |
| **D10** | 崩溃取证面不足：无 backtrace/`dladdr`、无阶段/时间戳/tid、安装时机在 `start` 时、覆盖他人已装 handler；release 未配置保留 native 符号 | `:100-122`（安装）、`:119`（覆盖语义）· §5.10 ⑬ 要求 `nativeLib.debugSymbol.strip=false`（`library/build-profile.json5` 未配） | `pc/lr` 在 strip 后难以符号化 ⇒ 取证价值下降 | 结构化 JSON（§9.1 ②）+ `library/build-profile.json5` 增加符号保留配置（属构建配置，需评审后改）。Phase 1/2 |
| **D11** | `set(CMAKE_LIBRARY_OUTPUT_DIRECTORY …)` 位于 `add_library()` **之后** | `CMakeLists.txt:6` vs `:10-11` | CMake 文档口径是「变量在 target 创建时初始化属性」⇒ 落点正确性依赖工具链/构建系统行为（as-built 已实测产物在 `library/libs/arm64-v8a/` ✅，故为**潜在**风险而非现行故障） | 把 `set()` 提到 `add_library()` 之前（零成本消除顺序依赖）。Phase 1（FR-002-025 / S6） |
| **D12** | `strtok` 非线程安全（使用内部静态状态） | `:203,208` | 同进程其他线程并发调用 `strtok` 时会互相破坏（当前窗口很短，风险低） | 换 `strtok_r`。Phase 1 |
| **D13** | 默认 `flags` 与规划 §5.3 草案不一致（缺 `--expose-internals`） | `js_start` · `NodeRuntime.ets` | 缺它 ⇒ 走 stub 路线的载荷 `internal/modules/*` 全 `MODULE_NOT_FOUND`（附录 B #6） | ✅ **已定案（2026-10-17）**：默认值保持 `--no-verify-heap`（真机验证值）；`--expose-internals` 仅在 stub 路线必需，由消费方显式传入（见 §9.1 ⑥） |
| **D14** | 拦截器无条件解引用 PC（无保护读） | `:82` | 若故障 PC 落在不可读页（野跳转/栈溢出后），handler 内二次 SIGSEGV ⇒ 证据丢失 | 命中前先判定 PC 有效性（如 `msync`/`signal` 保护窗口，或至少用一次性 `sigsetjmp` 兜底）。Phase 2（⬜ 属加固项，不在 Phase 1 范围） |

### 9.3 明确**不做**（非目标，避免评审误判为缺项）

| 事项 | 归属 | 理由 |
|---|---|---|
| 崩溃后自动重启运行时 | 不存在（C5） | `node::Start` 每进程一次；假恢复会误导用户 |
| ArkTS 状态机 / 单例 / 探活策略 | `001-runtime-core` / 消费方 | 本模块只贡献「探针 + 证据」 |
| 载荷解包、入口解析、异常兜底（⑱ 主体） | `004-payload-bootstrap` / 消费方载荷 | 谁写谁读（C3）；⑰ 随机端口同理 |
| 日志环 / `lastCrash()` / `/facts` | `006-observability` | 本模块只写；读回与呈现属观测模块 |
| 原生扩展（NAPI addon）加载与符号可见性 | `003-host-bridge` / 消费方 | 本模块只保证 `RTLD_GLOBAL` 的前置条件（R-05） |
| 独立存在的可执行文件签名（`.codesign`） | `005-provision-verify` | HAP 内不需要（§D.6/§D.9）；自签只服务独立分发 |
| `module.json5` 的 `compressNativeLibs` / `extractNativeLibs` | `007-distribution` | 体积预算（≈44 MB）前提，属打包面（TECH §5 #2） |
| 自建 `libnode.so` 配方 | Phase 3（附录 D / G.6 路线 C） | 本模块只依赖 ELF 属性与符号名（C7） |
