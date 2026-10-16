# plan.md —— `006-observability-logring-crash`（观测 · 日志环与崩溃取证）

> 与 `spec.md` 配对。上游权威：`docs/000-工程规划.md`（v0.9）· `specs/constitution.md`（v1.0）。
> 本文件只写「怎么做 / 取舍 / 影响面」，**不复制**规划正文，只回引 § 号。
> 回引约定：`§5.7` = 工程规划 §5.7；`C6`/`S9` = 宪法原则；`附录 B 17` = 规划附录 B 症状 17。
> 版本 v1.0 · 状态：**待评审**（Phase 1 范围）。

## 0. 编号与目录

| 项 | 值 | 说明 |
|---|---|---|
| 模块编号 | `006` | 规划 §7.3「观测：日志环 + hilog + 崩溃记录 + `selfcheck` /facts」✅ |
| 规划里的简写名 | `006-observability` | 规划 §7.3 · `specs/README.md:22` |
| 本规格目录名 | `006-observability-logring-crash` | 任务口径；**编号未变**（`006`），只是把「日志环与崩溃取证」写进目录名 |
| 需要同步改的文件 | `specs/README.md` 编号表、规划 §7.3、受影响模块 `plan.md` | 宪法 §六 变更流程 1；**本次不改**（超出本模块范围，仅登记为待办） |
| 目录内容 | `spec.md`（要什么）· `plan.md`（怎么做） | 规划 §10 的目录规则 ✅（`tests.md`/`tasks.md` 按需追加） |

---

## 1. 技术上下文

| 层 | 技术 | 具体用法 | 证据 |
|---|---|---|---|
| ArkTS | `@kit.PerformanceAnalysisKit` → `hilog` | `hilog.info/warn/error(DOMAIN, 'NODE_BRIDGE', '%{public}s', msg)`；DOMAIN = `0xD0033` | ✅ `Logger.ets:1,4,14-24` |
| ArkTS | `@kit.CoreFileKit` → `fileIo as fs` | `statSync`/`openSync(READ_ONLY)`/`readSync(fd, buf, {offset, length})`/`closeSync`；`mkdirSync`；`OpenMode.CREATE\|READ_WRITE\|TRUNC` | ✅ `Logger.ets:2,29-42`、`Env.ets:2,30-36,57-61` |
| ArkTS | `@kit.LocalizationKit` → `resourceManager` | `getRawFileContentSync(name): Uint8Array`（物化 rawfile 到沙箱） | ✅ `Env.ets:3,56` |
| ArkTS（规划） | `@kit.ArkTS` → `util.TextDecoder` / `buffer` | 字节 → UTF-8 字符串（**替代现状的逐字节 `String.fromCharCode`**） | ⬜ 待实现；见 §6.2 |
| C | `hilog/log.h` | `#undef LOG_DOMAIN/LOG_TAG` → `0xD0033` / `"NODE_BRIDGE"`（**必须**与 ArkTS 侧 `Logger.ets` 相同，A1/R2）；`OH_LOG_Print(LOG_APP, LOG_INFO, …)` | ✅ `node_bridge.c` |
| C | POSIX | 信号上下文只用 `open(O_WRONLY\|O_CREAT\|O_APPEND, 0644)`/`write`/`close`；`sigaction(SA_SIGINFO\|SA_RESETHAND)`；`signal(SIG_DFL)` + `raise`；`dup2`/`pipe`/`pthread_create`（Phase 1） | ✅ `node_bridge.c:53-60,108-121,185-192,257` |
| Node（载荷侧） | `node:http` + `node:fs` + `node:os` | `http.createServer` 暴露 `/facts`、`/log`；`fs.readFileSync`/`os.homedir()/tmpdir()/networkInterfaces()/cpus()` | ✅ `selfcheck.js:15-17,30-79` |
| Node（host 侧工具，Phase 1） | `node:fs` + 正则 + JSON | `tools/smoke-host.mjs` 做不接真机的门禁：崩溃行解析、`/facts` schema 断言、tail 算法 fixture 测试 | ⬜ 规划 §7.2/§7.4（`tools/smoke-host.mjs`，Phase 1） |

---

## 2. 宪法合规检查（逐条）

> 结论列：✅ 合规 · 🔶 部分（有实现但不满足全部）· ⚠️ **需改**（现实现违反）。

| 条款 | 本模块相关要求 | 现状（可复核） | 结论 |
|---|---|---|---|
| **C1** 库/壳分离 | 日志内容、`hint` 文案、自检项不得含宿主语义（`pi`/`pi-web`/Next/`PI_*`） | `Logger.ets`/`Env.ets`/`node_bridge.c`/`selfcheck.js` 无业务语义 ✅；诊断面板属消费方 ✅ | ✅ 合规（新 `hint` 文案必须写成通用处置） |
| **C2** 不隐藏平台真相 | 每条失败都要能被调用方看见 | ⚠️ `Env.ensureDir` 空 `catch`（`Env.ets:33-35`）；`/log` 的失败文本 ✅（`selfcheck.js:71-73`）；`Logger.tail` 占位串 ✅ | ⚠️ **需改**（`ensureDir` + `materializeRawfile` 的失败要留落点） |
| **C3** 让最终使用者去读 | 「写成功」判据改「读回」 | 读回通道两条 ✅（`Logger.tail`、`/log`）；但 `logs()`/`lastCrash()` 缺失 ⇒ 崩溃证据与日志环**无读回** | 🔶 部分（Phase 1 补 `logs()`/`lastCrash()`） |
| **C4** `execArgv` 不可事后改 | 本模块不得新增运行期改 `execArgv` 的路径 | 本模块只读 `flags` 字符串（`node_bridge.c:201-210` 一次解析）✅；`--inspect` 属「启动前定死」 | ✅ 合规（`--inspect` 守卫只能加在**启动前**） |
| **C5** 单例与不可重启 | 不得暗示/实现重启；失败态只允许「读日志/读崩溃记录/提示重启应用」 | `crash_handler` 不 swallow ✅；`NodeRuntime` 无重启路径 ✅ | ✅ 合规（崩溃记录是失败态 UX 的输入） |
| **C6** 诊断优先于修码 | 必须在真机上**看得见**；崩溃必须留**结构化证据**；禁用假判据 | `CRASH …` 行 ✅（`node_bridge.c:100-112`）；`/facts` ✅（`selfcheck.js:60-64`）；⬜ 日志环/崩溃记录 JSON/级别选择缺失 | 🔶 部分（本模块主体工作就是补齐 C6） |
| **C7** 零上游补丁 | 用现成机制；不打补丁 | 只用 hilog/fileIo/POSIX/http/fs ✅；无补丁、无 LD_PRELOAD、不碰 G11（路线 J′）✅ | ✅ 合规 |
| **S1** ArkTS 严格模式 + `.d.ts` | 不出现 `any`/`unknown`；原生模块只经环境声明 | `Logger.ets`/`Env.ets` 无 `any` ✅（`data.buffer as ArrayBuffer` 是断言）；原生经 `import nodeBridge from 'libnode_bridge.so'` + `index.d.ts` ✅ | ✅ 合规（新增 `logs()` 时保持 JSON 字符串边界，避免 `any`） |
| **S2** barrel 唯一出口 | 新公共 API 必须同改 `Index.ets` + `Types.ets` | ✅ 已加：`Types.ets` 含 `NodeLogEntry`/`CrashRecord`，`NodeRuntime` 提供 `logs()`/`lastCrash()`/`logRingSize`；`Index.ets` 已导出 `NodeRuntime`/`Logger`/`Env` ✅ | ✅ 合规（FR-006-028） |
| **S3** 类型改动即破坏性变更 | `Types.ets` 是对外契约 | ✅ `Types.ets:1-5` 已声明；`NodeLogEntry`/`CrashRecord` 已落地（契约 §2.5 冻结；此前的「属破坏性变更」判断已按变更流程执行） | ✅ 已执行变更流程 |
| **S4** 路径一律绝对 | 不依赖 `cwd`/`execPath` | `Env` 全部基于 `context.filesDir` ✅；⚠️ `selfcheck.js:67` 用 `process.env.HOME + '/payload/node.log'` 拼路径（`HOME` 空时变成 `/payload/node.log`） | ⚠️ **需改**（改由库显式传入/环境变量 `NODE_BRIDGE_LOG_PATH`） |
| **S5** 信号上下文禁用 stdio | handler 内只允许裸 `open`/`write`/`close`，禁止 `printf`/`vsnprintf`/`OH_LOG_Print` | ✅ 已修（2026-10-17）：`crash_handler` 手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` + **单次 `write()`**；handler 区间 0 命中 stdio/malloc/getenv | ✅ 合规（D6 关闭） |
| **S6** native 产物落点 | CMake 设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` | ✅ `CMakeLists.txt` 已设 → `libs/${OHOS_ARCH}` | ✅ 不受影响 |
| **S7** 引导件不链接 libnode | `dlopen` 运行期完成 | ✅ `CMakeLists.txt` 只链 `libace_napi.z.so`/`libhilog_ndk.z.so` | ✅ 不受影响 |
| **S8** C 侧接口 | 扩展 NAPI 面必须同改 `.d.ts` | ✅ 现状 **5 个符号**（`start`/`isRunning`/`version`/`lastError`/`stage`，`start` 6 参；`Init()` + `index.d.ts` 同步；契约 §1.1） | ✅ 合规（2026-10-17 扩充） |
| **S9** 日志双通道 + 读失败返回占位串 | 关键信息同时进 hilog 与文件；文件读取失败**不抛** | 🔶 ArkTS `Logger.info/warn/error` **只有 hilog**（`Logger.ets:14-24`）；C 侧 `log_line` 双通道 ✅；`tail` 失败返回占位串 ✅ | ⚠️ **需改**（ArkTS 侧补落盘通道，或明确「ArkTS 侧日志只进 hilog」的例外并存档） |
| **S10** 二进制不入库 | — | 本模块不引入二进制 ✅ | ✅ 不受影响 |
| 红线 G3/G4/G5/G11 | 无浏览器内核 / 许可 / ELF / 不绕签名 | 本模块只改源码与文档；不引入内核、不改 ELF、不碰 J′ ✅ | ✅ 不触红线 |

**评审清单对照**（宪法 §五）：C1 ✅ / C2 ⚠️ / C3 🔶 / C4 ✅ / C5 ✅ / **C6 🔶（本模块主战场）** / C7 ✅ / 证据标记 ✅（本文件全程标）/ G11 ✅。

---

## 3. 研究结论（设计问答）

| # | 问题 | 结论 | 推理与依据 | 对实现的影响 |
|---|---|---|---|---|
| 1 | **为什么日志要落盘，而不只进 hilog？** | 必须落盘 | ① 沙箱文件 `hdc` 读不到（宪法 §三 纪律 2 ✅），但**应用域**能读（`fileIo` / `/log`）；② hilog 是**有界环形缓冲**，应用侧 INFO 常不进 dump 缓冲（§5.7 ✅、附录 B 17 ✅）⇒ 长跑后早期行会被冲掉；③ 崩溃后进程消失，hilog 只留系统视角的一小段，而文件里的 `CRASH` 行是唯一能**跨启动**读到的自证 | 文件是「主通道」，hilog 是「辅助通道」；两者都要有，但断言只用文件/HTTP |
| 2 | **为什么信号 handler 只能裸 `open`/`write`/`close`？** | 只有这几个是 async-signal-safe 的够用集 | stdio 与 `snprintf` 会取 libc 内部锁/用 locale/可能分配（`malloc` 在 handler 内取堆锁）——若被中断的线程正持该锁 ⇒ **自死锁**；若堆已损坏 ⇒ **二次崩溃**，崩溃证据一起丢。POSIX 明确把 `printf`/`snprintf`/`malloc` 排除在 async-signal-safe 之外；`strlen` 无锁但同样不在列表内（纯计算，风险低，也应手写化以统一纪律） | handler 内：静态字符串表 + 手写 `fmt_dec`/`fmt_hex`（写进栈缓冲）+ 单次 `write`；**零堆、零锁、零 stdio** |
| 3 | **为什么 handler 要 `SIG_DFL` + `raise`，而不是记录后吞掉？** | 必须恢复默认处置并重抛 | ① 进程内 Node **没有优雅退出路径**（硬约束 ⑥ ✅）：吞掉信号后 VM/事件循环处于未定义状态，而 ArkTS 侧状态机仍显示 `running` ⇒ **假成功**，直接违反 C2；② 重抛让系统按真实信号杀进程，从而产生系统的 `Cpp Crash` 记录与 tombstone（**第二条独立证据链**）；③ 崩溃是终态 ⇒ 失败态 UX 由消费方接管（§5.2 ✅） | `signal(sig, SIG_DFL); raise(sig);` 保持不变（`node_bridge.c:110-111`）；`g_node_running` 的置位/清零不足以表达失败，需 `lastCrash()` 补齐 |
| 4 | **为什么要 `SA_RESETHAND`？** | 防「handler 自己再崩」时的无限递归/自死锁 | handler 内若发生二次故障（如又一次非法访问），默认处置已被重置为 `SIG_DFL` ⇒ 立刻终止；否则同一个 handler 会被重复进入（尤其 `SIGSEGV` 在栈已溢出时），表现为挂死而不是崩溃，取证与重启都做不了。`SA_NODEFER` **不**用于崩溃处理器（只用于 SIGSYS shim，见 `node_bridge.c:93` 与 :119 的区别） | 保持 `SA_SIGINFO \| SA_RESETHAND`；写文档说明「本库只捕获一次」 |
| 5 | **为什么 `/facts` 的 JSON 就是一次真机成功运行的证书？** | 因为它由**端上进程自己**产出，且一次性覆盖「加载—启动—事件循环—网络—fs—沙箱—JIT」 | 能返回 200 即证明：`dlopen('libnode.so') -> OK`、`node::Start` 已进入、libuv 事件循环在跑、`node:http` 在 `127.0.0.1` 监听、`hdc fport` + host `curl` 链路通、`node:fs` 在沙箱内写后自读一致（`fs_write_readback=OK` ⇒ C3 的「谁写谁读」在设备上成立）、`WebAssembly/热循环` 反映 ACL 是否生效（§D.9：`/facts` 200 + `fs_write_readback=OK` + `hotloop 296 ms/5 轮` ✅）。带 `at` 时间戳 ⇒ 可对时、可归档为回归基线 | `/facts` 的字段**不得**随意改名（消费方与回归脚本依赖）；新增字段只能追加。本模块的验收 = 这条 JSON，而不是截图 |
| 6 | **为什么不用 hilog 的「有没有那行」判执行？** | 负证据不可靠 | hilog 有级别过滤、缓冲丢弃、日志轮转、写入延迟；应用侧 INFO 常不进 dump（§5.7 ✅、附录 B 17 ✅）。「没看到该行」的三种成因（没执行 / 级别被滤 / 缓冲冲掉）不可区分 ⇒ 断言必然误判。**可以**用 hilog 作**正**证据（看到即执行过），不可用作反证据 | 验收脚本只允许「功能性判据」：`/facts` 200 + 字段值、`/log` 正文命中哨兵串、`logger.tail` 命中；hilog 仅辅助留档 |
| 7 | **为什么 `VmSize` 不可作判据？** | 与 V8 是否起来无因果关系 | ArkTS/ArkWeb（渲染与 GPU 进程、图形缓冲）自占约 **40 GB** 虚拟地址空间（附录 B 18 ✅）⇒ 总 `VmSize` 被宿主主导，V8 是否映射了堆/代码区在总量上看不出来；同理 `os.cpus()` 本机长度 **0**（§D.8 ✅）⇒ 任何「按 CPU 数估算并发」的判据也失效 | 「V8 起来了」只能由 `/facts` 的 `node`/`versions`/`wasm.validate`/`hotloop_ms_5rounds` + 端口探活判定 |
| 8 | **为什么 `tail` 失败返回占位串而不是抛异常？** | 因为它是**失败态诊断**的唯一入口 | ① 宪法 S9 明文（文件读取失败返回占位串而不抛）；② 调用点正是「已经出问题」时的诊断面板/失败页，抛异常会把「能解释失败的工具」变成「新的失败」；③ 占位串是**可区分且可断言**的（`'(read log failed: …)'` 带原因 JSON），并且 ArkTS 侧日志会把它记进 hilog ⇒ C2 不被破坏；④ 空文件单独返回 `'(log empty)'`，避免把「读成功但空」误判为失败 | 保持返回字符串契约；占位串文案视为**稳定契约**（消费方与测试会断言）；**绝不**改成 `throw` |

---

## 4. 数据模型

### 4.1 `NodeLogEntry`（规划字段，`Types.ets` 新增）

| 字段 | 类型 | 必填 | 含义 / 取值 | 备注 |
|---|---|---|---|---|
| `at` | `number` | ✔ | 该行进入日志环的 epoch 毫秒（由 reader 线程/桥件打点） | 现状日志行**无时间戳** ⚠️；不写进行内，只在环条目上打点（保持向后兼容） |
| `stream` | `'stdout' \| 'stderr' \| 'system'` | ✔ | 来源流：Node 侧 `stdout`/`stderr`；桥件自身的 `log_line` 与状态行 = `'system'` | 规划 §5.3 原文 ✅ |
| `text` | `string` | ✔ | 单行正文，**不含**换行；长度上限 `logLineMaxBytes`（默认 2048），超出截断并追加 `…[truncated]` | 上界是内存上界的前提（NFR-006-002） |

### 4.2 `CrashRecord`（规划字段，`Types.ets` 新增）

| 字段 | 类型 | 必填 | 含义 | 谁填 |
|---|---|---|---|---|
| `at` | `number` | ✔ | 崩溃时刻（handler 用 `clock_gettime(CLOCK_REALTIME)` 取，async-signal-safe ✅） | C handler |
| `stage` | `string` | ✔ | 崩溃时所处阶段：`boot` / `env` / `dlopen` / `node_start` / `node_running` | C handler 从静态 `g_stage` 拷贝（由 `log_line` 阶段标记更新） |
| `signal` | `string?` | ✔（实际总会有） | 形如 `SIGTRAP(5)`、`SIGSEGV(11)`、`SIGABRT(6)` | C handler（静态名表 + 十进制号） |
| `hint` | `string?` | ✔ | 人可读的下一步（症状 → 处置），见 §4.5 映射表 | ArkTS `lastCrash()` 生成（handler 不做文案拼接，省栈省逻辑） |
| `logTail` | `string[]` | ✔ | 崩溃前的最后若干行（默认 ≤ 20 行，取自 `Logger.tail(logPath, 4096)` 按 `\n` 切分） | ArkTS `lastCrash()` 生成 |

**内部扩展键**（不属公共类型，JSON 里额外存在，解析器必须容忍）：`si_addr`/`pc`/`lr`/`sp`/`r0`（十六进制字符串）、`pid`、`version`（记录格式版本，便于以后演进）。消费方若需要符号化，把 `pc`/`lr` 交给
`llvm-addr2line -e libnode_bridge.so 0x…`（**离线**做，见 §3 #2 与 §9 P1-006-13）。

### 4.3 `CRASH` 行格式（现有，**冻结**）

| 字段 | 占位符 | 含义 | 来源寄存器 / 结构成员 | 语义注意 |
|---|---|---|---|---|
| `sig` | `%d` | 信号号 | handler 入参 | `5=SIGTRAP`（无 ACL 时 V8 W^X 拒绝，§D.8 ①）· `11=SIGSEGV` · `6=SIGABRT`（断言/`abort()`，常对应载荷未捕获异常，§D.10 ⑰）· `4=SIGILL` · `7=SIGBUS` · `8=SIGFPE` |
| `si_addr` | `%p` | 故障地址 | `si->si_addr`（`siginfo_t*`） | 仅对 SEGV/BUS/ILL/FPE/TRAP 有地址语义；`SIGABRT` 下常为 NULL 或噪声（不要据此下结论） |
| `pc` | `%p` | 故障指令地址 | `uc_mcontext.pc` | 与 `si_addr` **恒不相等**也可成立（§5.10 ③ 的教训：判据必须读指令编码，不能比地址） |
| `lr` | `%p` | 返回地址（上一层调用点） | `uc_mcontext.regs[30]`（X30 = LR） | 用于「崩在 libnode 还是载荷 addon」的初判 |
| `sp` | `%p` | 栈指针 | `uc_mcontext.sp` | 与 `/proc/<pid>/maps` 对照可判栈溢出 |
| `r0` | `%p` | 首参/返回值（X0） | `uc_mcontext.regs[0]` | 常见是 `this` 指针或返回码；⚠️ 不要把它当「崩溃原因」 |

- **冻结理由**：`CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…` 已经写进宪法 C6 与规划 §5.7/§5.10 ⑬，并与 §D.8 的既有真机记录一致 ✅；改格式会让历史证据不可解析。
- 行前缀：`CRASH` 行**没有** `[node_bridge]` 前缀（现状 `node_bridge.c:104`）；解析器同时容忍两种。
- ⬜ 可选增强（§9 P1-006-13）：追加 `si_code`（区分 `SEGV_MAPERR`/`SEGV_ACCERR`，对 W^X 判定有用）——只能追加在行尾，不得重排。

### 4.4 `/facts` 响应完整 schema 与判定阈值

响应体：`{ "at": "<ISO-8601>", "checks": { … } }`（`selfcheck.js:63` ✅；`Content-Type: application/json`）。
字段口径：`checks` 内 **13 项**（下表去掉首行 `at` 后的 13 行）+ 响应级 `at` = **14 个字段**；任务与规划说「14 项检查」即指此。

| 检查项 | 现状值 / 期望 | 判定阈值与含义 | 依据 |
|---|---|---|---|
| `at` | ISO-8601 字符串（响应级字段） | 与 host `date -u` 差 < 60 s；否则时钟/时区异常 | `selfcheck.js:63` ✅ |
| `node` | `v24.2.0` | `>= v22.19.0`（库的门槛；不满足 ⇒ warn 且**可见**，C2） | §5.8 ✅ · `selfcheck.js:30` |
| `platform` | `openharmony` | ≠ ⇒ 载荷不在本库的运行时里（判成环境错误，不是协议错误） | §D.8 ✅ |
| `arch` | `arm64` | ≠ ⇒ 装错 ABI（`libs/arm64-v8a`） | §D.8 ✅ |
| `execArgv` | `['--no-verify-heap']`（有 ACL） | **不得**含 `--inspect`（release，§8 Phase 1 ⑤）；`--jitless` 存在 ⇒ 预期 WASM 关 | `selfcheck.js:33` ✅ |
| `versions` | `{v8: '13.6.233.10-node.17', uv: '1.51.0', modules: 137, …}` | `modules == 137` 与锁文件一起对；`v8` 前缀与运行时版本一致 | §D.8 ✅ · §D.9 ✅ |
| `homedir` | `<filesDir>`（如 `/data/storage/el2/base/haps/.../files`） | 必须以应用 `filesDir` 开头；等于 `/storage/Users/currentUser` ⇒ `HOME` 重定向失效 | §5.6 ✅ · 附录 B 10 ✅ |
| `tmpdir` | `<filesDir>/tmp` | 同上；`/tmp` 或不存在 ⇒ 环境注入失效 | §5.6 ✅ |
| `netifaces` | `['lo','wlan0','ancowlan0']`（至少含 `lo`） | 不含 `lo` ⇒ loopback 不可用（消费方的本地服务路线不成立） | §D.8 ✅ |
| `cpus` | `0`（状态值，**非**错误） | 只能判「本机不可依赖 `os.cpus()` 做并发估算」；**不得**用它判性能 | §D.8 ✅ · 附录 B 18 同族教训 |
| `wasm.validate` | `true`（有 ACL）/ `false`（`--jitless`） | 与 `wasm.error` 组合判定：`true` ⇒ JIT+WASM 可用；`false` + `WebAssembly is not defined` ⇒ 解释器模式 | §D.8 ② ✅ · §D.10 ✅ |
| `wasm.error` | `''`（可用）/ `'WebAssembly is not defined'` | 非空 ⇒ 记录原因原文（不解释、不改写） | `selfcheck.js:41` ✅ |
| `fs_write_readback` | `'OK'` | ≠ `OK`（`MISMATCH`/`ERR:…`）⇒ 沙箱 fs 语义异常（C3 的「谁写谁读」不成立） | `selfcheck.js:43-49` ✅ · §D.9 ✅ |
| `hotloop_ms_5rounds` | 有 ACL：**6–9 ms**；`--jitless`：**~296–299 ms**（5 轮 2e6 次；折算约 59 ms/2e6） | `< 50 ms` ⇒ JIT 生效；`> 200 ms` ⇒ 解释器基线；两者必须**显式区分**，不许「数值小就是好」地混判 | §D.8 ② ✅ · §D.10 ✅ |

**规划提及但现状缺失字段**：`hostBridge`、`state`（§5.7 的 `/facts` 字段表写的是 `{node, platform, arch, execArgv, hostBridge, state}`）⇒ ⚠️ 文档与实现不一致；本模块把它们登记为 **Phase 2 追加字段**（依赖 `003-host-bridge` 与 `001` 的状态回传），Phase 1 只保证 14 项 + `at` 不被改名。

### 4.5 日志文件布局、轮转与截断规则

| 项 | 规则 | 现状 |
|---|---|---|
| 路径 | `<filesDir>/payload/node.log`（现状，`Env.ets:25-27`）；规划写 `<filesDir>/node-bridge/…`（§5.3/§5.7）⇒ **必须二选一**（§9 P1-006-15） | ⚠️ 冲突 |
| 权限 / 打开方式 | `0644`，`O_WRONLY \| O_CREAT \| O_APPEND`（`node_bridge.c:55,185`） | ✅ |
| 行上限 | 单行 ≤ 2048 B（超出截断 + `…[truncated]`），保证环条目有界 | ⬜ |
| 文件上限与轮转 | `nodeLogMaxBytes`（默认 8 MiB）；超限时 `rename(node.log → node.log.1)` 后重开，只保留 `.1` 一代 | ⬜ 无任何轮转 |
| 尾部读回 | `tail(path, maxBytes)`：`start = max(size - maxBytes, 0)`；`/log` 同算法但**必须用 offset 读**（不得全量 `readFileSync`） | ⚠️ `/log` 全量读（`selfcheck.js:70`） |
| 截断点落在多字节字符/行中间 | 解码后若 `start > 0`，丢弃第一个 `\n` 之前的内容（半个字符 + 半行一并丢）；解码用 UTF-8（§6.2） | ⚠️ 现状逐字节转码（乱码） |
| 二进制/乱码内容 | 按 UTF-8 容错解码（替换字符可接受）；不得抛异常、不得返回 NUL 串 | ⚠️ 现状会返回 NUL/垃圾 |
| 宿主原生输出 | **不得**出现在 `node.log`（通道分离 + pipe + reader 线程） | ⚠️ `dup2` 同 fd（`node_bridge.c:187-188`） |

### 4.6 `hint` 文案映射（症状 → 处置，来源：附录 B 16/17/18/19 + §D.8/§D.10）

| 触发 | `signal` / 证据 | `hint`（一步可执行） |
|---|---|---|
| 无 ACL 跑 JIT | `SIGTRAP(5)` + 崩溃栈无载荷帧 | 「V8 W^X 拒绝：确认 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` 已在 Profile 生效；临时兜底可加 `--jitless`（WASM 全废）」§D.8 ① ✅ |
| 载荷未捕获异常（端口冲突等） | `SIGABRT(6)` + 崩溃栈含 `libnode_bridge.so` / `libnode.so` | 「查载荷 `uncaughtException` 兜底与端口占用（`EADDRINUSE`）；端口改随机/先探测空闲」§D.10 ⑰⑱ ✅ |
| 参数构造错误 | `SIGSEGV(11)`，`pc` 落在 `node_bridge.so` 起始阶段 | 「查 `argc`/`argv` 构造（多算 `NULL` 哨兵会 5 ms 内段错误）」附录 B 3 ✅ |
| libuv 初始化 | `SIGSYS` 相关行 | 「查 `io_uring_setup` 是否被 seccomp trap（本机返回 8 ⇒ 未触发；shim 保留为防御）」§D.8 ✅ |
| dlopen 失败 | 日志 `FATAL: 无法加载 libnode.so` | 「确认用 `tools/provision.mjs` 投放运行时；真机只认裸名 `libnode.so`」§D.9 ✅ |
| 无法判定 | 其它 | 「导出 `last-crash.json` + `/log` 尾部 + `hilog -x \| grep NODE_BRIDGE`；附设备型号/版本」FR-006-031 ✅ |

---

## 5. 接口契约

### 5.1 本模块**提供**的接口

**ArkTS `Logger`**（`library/src/main/ets/log/Logger.ets`，经 `Index.ets:20` 导出）

| 方法 | 签名 | 行为契约 | 现状 |
|---|---|---|---|
| `info` | `static info(msg: string): void` | `hilog.info(0xD0033, 'NODE_BRIDGE', '%{public}s', msg)`；**不抛** | ✅ :14-16 |
| `warn` | `static warn(msg: string): void` | 同上，`warn` 级别 | ✅ :18-20 |
| `error` | `static error(msg: string): void` | 同上，`error` 级别（关键失败走这档） | ✅ :22-24 |
| `tail` | `static tail(path: string, maxBytes: number): string` | 只读尾；空文件 `'(log empty)'`；任何异常 `'(read log failed: <json>)'`；`finally` 关 fd；**不抛** | ✅ :27-52 / ⚠️ 解码与入参边界待修（§6.2） |

**ArkTS `Env`**（`library/src/main/ets/util/Env.ets`，经 `Index.ets:21` 导出）

| 方法 | 签名 | 行为契约 | 现状 |
|---|---|---|---|
| `payloadDir` | `static payloadDir(context: common.Context): string` | `<filesDir>/payload`（绝对路径，S4） | ✅ :15-17 |
| `tmpDir` | `static tmpDir(context: common.Context): string` | `<filesDir>/tmp` | ✅ :20-22 |
| `logPath` | `static logPath(context: common.Context): string` | `<filesDir>/payload/node.log` | ✅ :25-27 |
| `crashPath`（规划） | `static crashPath(context: common.Context): string` | `<filesDir>/node-bridge/last-crash.json` | ✅ 已实现（`Env.ets:40-41`，与 C 侧 `g_crash_path` 同源） |
| `ensureDir` | `static ensureDir(path: string): void` | 幂等建目录（不递归）；失败**必须可见** | 🔶 :30-36（空 `catch` ⚠️） |
| `ensureRuntimeDirs` | `static ensureRuntimeDirs(context: common.Context): void` | 建 `payload/` + `tmp/` | ✅ :39-42 |
| `materializeRawfile` | `static materializeRawfile(mgr: resourceManager.ResourceManager, rawName: string, destPath: string): string` | 把 rawfile 落到沙箱并返回路径 | ✅ 已实现；**A5 已修**：只写视图覆盖的字节（`byteOffset`/`byteLength`，`Env.ets`），不再有「多写 backing buffer」风险 |

**`NodeRuntime` 新增方法（规划，属 001 的类型扩展）**

| 方法 | 签名 | 行为契约 | 状态 |
|---|---|---|---|
| `logs` | `logs(count?): NodeLogEntry[]` | 读日志尾成条目数组（≤ `logRingSize`，默认 500 行，时间序）；不抛（失败返回 `[]` 并在 hilog 留 `warn`） | ✅ 已实现（`NodeRuntime.ets`；B3/R2 复核） |
| `lastCrash` | `lastCrash(): CrashRecord \| null` | 读 `<filesDir>/node-bridge/last-crash.json`；失败降级解析 `CRASH` 行；都没有 ⇒ `null` | ✅ 已实现（`NodeRuntime.ets`，含降级路径；B3/R2 复核） |

**HTTP 端点**（`payload/selfcheck.js` 提供；观测面唯一不依赖 `hdc` 文件权限的读回通道）

| 方法与路径 | 状态码 / 类型 | 正文契约 | 现状 |
|---|---|---|---|
| `GET /facts` | `200` + `application/json` | `{at, checks{16}}`（16 个冻结键，含 `spawn`）；单项失败以 `"ERR:…"` 留在 JSON 内，端点本身不 500 | ✅ `payload/selfcheck.js`（`smoke-host` 阶段④逐键对齐） |
| `GET /log` | `200` + `text/plain` | 日志尾（默认 ≤ 8192 B）；读失败 ⇒ `200` + `(read failed: …)` | 🔶 :66-77（全量读 + 码元切 ⚠️） |
| 其它路径 | `404` | `not found` | ✅ :78-79 |
| 监听 | `127.0.0.1:${SELFCHECK_PORT \|\| 15577}` | 仅 loopback；⚠️ 与消费方应用/探针应用**会争端口**（§D.10 ⑰）⇒ 测谁就 force-stop 另一个 | ✅ :19,82-84 |

### 5.2 本模块**消费**的接口

| 依赖 | 用法 | 约束 |
|---|---|---|
| `hilog`（`@kit.PerformanceAnalysisKit`） | `info/warn/error(domain, tag, '%{public}s', msg)` | `%{public}` 必须保留（否则真机按隐私策略打印 `<private>`），S9 |
| `fileIo`（`@kit.CoreFileKit`） | `statSync`/`openSync`/`readSync`/`closeSync`/`mkdirSync`/`writeSync` | 只 `READ_ONLY` 读日志；不改文件的其它属性 |
| `resourceManager.getRawFileContentSync`（`@kit.LocalizationKit`） | 物化 rawfile | 大载荷走 `resfile` 直读（§5.5），不走这里 |
| `node:http` | `createServer` + `listen(PORT, '127.0.0.1')` | 只监听 loopback；不做鉴权（消费方决定，§6.1） |
| `node:fs` | `writeFileSync`/`readFileSync`（现状）/`openSync`+`readSync`（Phase 1） | 路径一律绝对（S4）；`os.tmpdir()` 而非 `/tmp` |
| `node:os` | `homedir`/`tmpdir`/`networkInterfaces`/`cpus` | `cpus` 可能为 0（§D.8 ✅） |
| 原生 `libnode_bridge.so`（经 `index.d.ts`） | `start`/`isRunning`/`version`（+Phase 1 扩展） | S8：扩展必须同改 `.d.ts`；库侧不 import `.so` 本体之外的实现 |

### 5.3 日志协议（文本层约定）

| 项 | 约定 | 现状 |
|---|---|---|
| 桥件行前缀 | `[node_bridge] `（例：`[node_bridge] dlopen('libnode.so') -> OK`、`[node_bridge] io_uring_setup(425) -> 8 (errno=0)`、`[node_bridge] node::Start returned rc=… errno=…`） | ✅ `node_bridge.c:139,156,170,174,179,181,216-217,223,262,268` |
| 崩溃行 | `CRASH sig=%d si_addr=%p pc=%p lr=%p sp=%p r0=%p`，**无前缀**，单行，单次 `write` | ✅ :104-109 |
| 载荷行 | 无强制前缀；参考实现用 `[bootstrap] `（`bootstrap.js:17`）与 `[selfcheck] `（`selfcheck.js:83`） | ✅ |
| hilog tag | 统一 `NODE_BRIDGE`；domain **两侧已统一为 `0xD0033`**（A1/R2，2026-10-17 关闭缺陷 4） | ✅ |
| 换行 | 固定 `\n`（不用 `\r\n`） | ✅ |
| 行时间戳 | **不写进行内**（历史证据无时间戳，加进去会让解析器分叉）；时间只存在于日志环条目 `at` 与崩溃记录 `at` | ⚠️ 现无时间信息（`Logger.tail` 无法给出时刻） |
| 行上限 | ≤ 2048 B（超出截断 + `…[truncated]`） | ⬜ |

---

## 6. 实现策略

### 6.1 架构模式：三处写入 + 两个读回

```
写入 ① ArkTS Logger.info/warn/error ──▶ hilog（domain 0xD0033, tag NODE_BRIDGE）
                                        ⬜ + 文件（S9 的双通道；待定：写 node.log 还是 node-bridge/arkts.log）
写入 ② C 桥件 log_line ──▶ OH_LOG_Print（domain 0xD0033）+ node.log（raw_write）
       崩溃 handler ──▶ node.log 的 CRASH 行（裸 write）
                       ⬜ + <filesDir>/node-bridge/last-crash.json（单次 write）
写入 ③ Node 侧 stdout/stderr ──▶ 现状：dup2(fd,1|2) 直接进 node.log
                                 ⬜ Phase 1：1 MB pipe + 独立 reader 线程 → 有界日志环 + node.log（业务通道）

读回 ① Logger.tail(path, maxBytes)  ← ArkTS/诊断面板（应用域直读）
读回 ② HTTP /log（尾 8192 B）、/facts（14 项证书）  ← host 侧 curl（不依赖 hdc 文件权限）
       ⬜ 读回 ③ NodeRuntime.logs()（日志环快照）· lastCrash()（跨启动崩溃记录）
```

**分工原则**：`002-napi-bootstrap` 拥有 stdio 与桥件日志的**写入侧**；本模块定义**通道语义、读回契约与判据**
（含日志环/崩溃记录的结构与验收），并在 ArkTS 侧提供 `Logger`/`Env` + `logs()`/`lastCrash()` 的**读回实现**。
跨模块改动（NAPI 接口、`.d.ts`、`Types.ets`、`Index.ets`）按 S2/S8 与宪法 §六 流程同步。

### 6.2 关键算法

**(A) `tail` 的偏移计算、读取与 UTF-8 解码（含现状缺陷的修法）**

现状（`Logger.ets:27-52`）逻辑正确但**转码错误**：`for (…) out += String.fromCharCode(bytes[i])` 把每个字节当
一个 Latin-1 字符 ⇒ 任何 UTF-8 多字节序列（中文、emoji、真实路径）都变成乱码；此外未用 `readSync` 的**实际返回字节数**，
文件被并发写/截断时会读回零填充的 NUL。

修法（保持「失败不抛」契约）：

```ts
import { util } from '@kit.ArkTS';                       // 或 import { buffer } from '@kit.ArkTS'
const TAIL_DEFAULT = 4096;                                // 默认值（FR-006-006）
const TAIL_MAX = 1024 * 1024;                             // 上界，防 OOM

static tail(path: string, maxBytes: number = TAIL_DEFAULT): string {
  const want: number = maxBytes > 0 ? Math.min(maxBytes, TAIL_MAX) : 0;
  if (want === 0) return '(tail maxBytes must be > 0)';   // 与「空文件」可区分
  try {
    const size: number = fs.statSync(path).size;
    if (size === 0) return '(log empty)';
    const start: number = size > want ? size - want : 0;
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    let text: string;
    try {
      const buf = new ArrayBuffer(size - start);
      const n: number = fs.readSync(file.fd, buf, { offset: start, length: buf.byteLength }); // 用实际字节数
      const view = new Uint8Array(buf).subarray(0, n > 0 ? n : 0);
      text = util.TextDecoder.create('utf-8').decodeToString(view);   // 一次正确解码
      if (start > 0) {                                    // 丢掉被截断的首行（含半个多字节字符）
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
        else text = '';                                   // 整段都在一行的中间 ⇒ 无可读内容
      }
    } finally {
      fs.closeSync(file);
    }
    return text;
  } catch (e) {
    return '(read log failed: ' + JSON.stringify(e) + ')';
  }
}
```

要点：① 默认值/上界（`TAIL_DEFAULT`/`TAIL_MAX`）让调用方无法用一次调用打爆内存；② `readSync` 返回值参与解码，
不再出现 NUL 填充；③ 丢首行让「半个字符」不出现在返回值里；④ `util.TextDecoder.create()` 与 `decodeToString()`
需在真机复核（⬜：`@kit.ArkTS` 的 `TextDecoder` 在 API 17+ 的可用形态；不可用时回退 `buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf-8')`）；
⑤ 解码器只在需要时构造（`tail` 非热路径，但不要在循环里构造）。

**(B) `/log` 端点的尾部读（现状缺陷修法）**

现状 `fs.readFileSync(logPath, 'utf8').slice(-8192)` 有**两个**问题：全量读入内存（100 MiB 日志 ⇒ 100 MiB 峰值）
与「按 UTF-16 码元切 8192」（不是 8192 字节，且会切碎多字节字符）。修法：

```js
function readTail(file, maxBytes) {                 // 与 Logger.tail 同算法，Node 侧实现
  const size = fs.statSync(file).size;
  if (size === 0) return '(log empty)';
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString('utf8');
    if (start > 0) { const i = text.indexOf('\n'); text = i >= 0 ? text.slice(i + 1) : ''; }
    return text;
  } finally { fs.closeSync(fd); }
}
```

**(C) 崩溃地址 / 寄存器映射（ARM64，`ucontext_t`）**

| 输出字段 | 来源 | 为什么取它 | 常见误用（禁止） |
|---|---|---|---|
| `pc` | `uc->uc_mcontext.pc` | 故障指令地址 ⇒ 符号化的**主锚点** | 用它跟 `si_addr` 比较来判「是否 `svc`」（§5.10 ③ 明确禁止：部分设备恒不相等） |
| `lr` | `uc->uc_mcontext.regs[30]` | X30 = 上一层调用返回地址 ⇒ 区分「崩在 V8/桥件/载荷」 | 把它当**唯一**调用栈（只有一层） |
| `sp` | `uc->uc_mcontext.sp` | 对照 `/proc/<pid>/maps` 判栈溢出/栈越界 | — |
| `r0` | `uc->uc_mcontext.regs[0]` | 首参（常为 `this`）或返回值 | 把 `r0` 当「错误码」解释（ABI 上它只是寄存器） |
| `si_addr` | `si->si_addr` | 读/写故障地址 | 对 `SIGABRT` 解释它（无地址语义） |

**(D) 信号集选择理由**

| 信号 | 号 | 本形态下的实际触发场景 | 处置 |
|---|---|---|---|
| `SIGTRAP` | 5 | **无 ACL 时 V8 走 JIT ⇒ W^X 拒绝**（§D.8 ① 实测 `CRASH sig=5` ✅） | **必须在列**（最常见、最容易误判为「脚本问题」） |
| `SIGSEGV` | 11 | 空指针/越界（argv 哨兵多算 ⇒ 5 ms 内段错误，附录 B 3 ✅） | 必须在列 |
| `SIGABRT` | 6 | `abort()`/断言/载荷未捕获异常（`node.cc` 的 `limit_called` 断言、端口 `EADDRINUSE` 后整进程 abort，§D.10 ⑰ ✅） | 必须在列 |
| `SIGILL` | 4 | 非法指令/CPU 特性不匹配 | 必须在列 |
| `SIGBUS` | 7 | 未对齐访问 / 映射文件被截断 | 必须在列 |
| `SIGFPE` | 8 | 整数除零（V8 内部 bug 或 addon） | 必须在列 |
| （不加）`SIGSYS` | 31 | 由 **SIGSYS shim** 单独处理（`node_bridge.c:89-96`，`SA_SIGINFO \| SA_NODEFER`，**不**做取证、不回抛） | 保持现状：shim 是功能修复不是取证 |

**(E) 崩溃记录文件的写入（handler 侧）**

`g_stage` 是**静态** 32 B 缓冲，由 `log_line` 在阶段标记处更新（`boot`/`env`/`dlopen`/`node_start`/`node_running`）；
handler 只做：`clock_gettime` → 手写 JSON 到**预分配的静态缓冲**（如 2 KB）→ `open(O_WRONLY|O_CREAT|O_TRUNC)` → **一次** `write` → `close`。
所有十进制/十六进制都由手写 `fmt_dec`/`fmt_hex` 生成（禁用 `snprintf`，S5）。JSON 模板（字段顺序固定，便于离线解析）：

```
{"v":1,"at":1730000000123,"pid":12345,"stage":"node_running","signal":"SIGTRAP","signum":5,
 "si_addr":"0x0","pc":"0x7f…","lr":"0x7f…","sp":"0x7f…","r0":"0x0"}
```

`hint`/`logTail` **不在** handler 里生成：前者要文案与判定（属 ArkTS），后者要读文件（与正在写的 fd 竞争）。

**(F) 日志环（有界、无锁、可快照）**

- 结构：`NodeLogEntry ring[logRingSize]`（默认 500）+ 单写者（reader 线程）/多读者（NAPI 调用）模型；
  写入用 `ring[i % cap]`，读快照时取「已写条数」与「当前下标」两个 `volatile` 值，按序复制出 ≤ cap 条（可能看到瞬时不一致 ⇒ 允许，条目自洽即可，不需要全局一致快照）。
- 触发自动释放：快照后立即释放，不长期持有（避免与写入者互相等待）。
- 溢出：`dropped += 1`；快照最后追加一条 `stream:'system'` 的 `[(dropped) lines dropped]`（**不得**静默丢弃）。
- 内存上界：`cap × (lineMax + 固定头)` ≤ `500 × (2048 + 64) ≈ 1.05 MiB`（NFR-006-002）。
- ⬜ 待定：环放在 C 侧还是 Node 侧。**倾向 C 侧**（能同时覆盖「桥件在 Node 起来之前的行」与「Node 起来之后的行」，且 ArkTS 只需一次 NAPI 调用拿 JSON 字符串，S1/S8 边界最干净）；代价是 `logRingSize` 需经 `start()` 的第 6 参或单独 setter 传入 ⇒ 属 002 接口扩展。

### 6.3 错误处理：每条失败路径的可见落点

| 失败点 | 现象 | 可见落点（必须存在） | 现状 |
|---|---|---|---|
| 日志文件 `open` 失败（桥件） | `raw_write` 直接 `return` | ⬜ Phase 1：bootstrap 阶段（非信号上下文）探测一次 `open`，失败则 `log_line("[node_bridge] WARN: cannot open log %s errno=%d")` 进 hilog | ⚠️ 只有静默 `return`（`node_bridge.c:54,56`） |
| `Logger.tail` 任何异常 | — | 返回 `'(read log failed: …)'`（含原因 JSON） | ✅ |
| `Logger.tail` 空文件 | — | 返回 `'(log empty)'` | ✅ |
| `/log` 读失败 | — | `200` + `(read failed: …)`（正文可读，不 5xx） | ✅ |
| `/facts` 单项异常 | — | 该项值 = `"ERR:<message>"`，端点仍 200 | ✅ |
| 崩溃记录写失败 | 磁盘满/权限 | 仍保留 `CRASH` 行（先写行、再写 JSON）；⬜ 下次启动 ArkTS 读不到 JSON 时走降级解析并在 hilog 打 `error` | ⬜ |
| `Env.ensureDir` 失败 | 目录不可建 | 不得空 `catch`：`Logger.error`/`warn` 记一次（C2） | ⚠️ 空 `catch`（`Env.ets:33-35`） |
| `Env.materializeRawfile` 写失败 | 载荷缺失 | 异常向上抛（调用方可见）+ hilog | ✅（异常不吞） |
| pipe / reader 线程创建失败 | Phase 1 | 回退到「文件直写」并 hilog 打 `error`（明确降级，不静默）+ 在 `/facts` 追加能力标志 | ⬜ |
| 端口被占（自检载荷） | `listen` 失败 | `uncaughtException` 兜底写日志（⑱）+ 退出前留 `CRASH`/日志行 | ⬜ |

### 6.4 性能：syscall / IPC 成本与改善方向

| 路径 | 现状开销 | 改善方向 | 目标 |
|---|---|---|---|
| 桥件每行日志 | `raw_write(buf)` + `raw_write("\n")` = **2 次 `open` + 2 次 `write` + 2 次 `close`**（`node_bridge.c:70-71,53-60`） | 常开 fd（`bootstrap` 里 `open` 一次）+ 单次 `write`（把 `\n` 拼进同一缓冲） | 2 syscall / 行，且行不可被交错 |
| 稳态高频输出（reader 线程，Phase 1） | 若逐行 `raw_write` ⇒ 每行 3 syscall；10k 行/s ⇒ **30k syscall/s** | ① 常开 fd；② **批量 flush**（≥ 1 KiB 或 ≥ 100 ms 触发一次 `write`） | ≤ 2 syscall / 批 |
| 关键量级说明（为什么「每次 ioctl/陷入」不可忽略） | OHOS 上每次 `open`/`write`/`close` 都是一次内核陷入（`svc`），另有 fd 表查找、沙箱与安全检查 hook、VFS 路径解析（`open` 是 `write` 的数倍）；`open`/`close` 还要做 fd 分配/释放与引用计数。对比 Linux 裸 syscall，应用域的文件操作普遍更贵（OHOS 还把 ArkTS `fileIo` 走成跨线程调用，见下一行） | 减少 `open`/`close` 次数（一次打开、长期持有）比减少 `write` 次数收益大；分文件（业务 vs 宿主）也要各只打开一次 | — |
| ArkTS `Logger.tail` 一次调用 | `statSync` + `openSync` + `readSync` + `closeSync` = **4 次 ArkTS→文件服务的跨线程调用**（不是 4 次裸 syscall），外加一次 `ArrayBuffer` 分配 | ① 诊断面板轮询 ≥ 500 ms；② 可选：复用一个固定尺寸缓冲区（减少 GC）；③ 只请求增量（记上次 size） | 1 Hz 轮询下 ≤ 4 IPC/s |
| `/log` 一次请求 | 现状 `readFileSync` **全量** O(size) 读 + 一次 UTF-8 整份解码 + `slice`（100 MiB 日志 ⇒ 峰值 ≥ 100 MiB） | 改 offset 读（§6.2 B），O(8192) | 峰值与日志大小解耦 |
| 首启耗时 | 现状：1 次 `open`（日志）+ 崩溃 handler 装 6 个信号（`sigaction`） | 未新增同步 I/O、未 `fsync`；reader 线程栈 ≤ 256 KB（对比 bootstrap 的 32 MB `node_bridge.c:255`） | 首启增量 < 10 ms（不可测则视为可忽略；NFR-006-004） |

### 6.5 现实现真实缺陷清单（含定位与修法）

| # | 缺陷 | 定位 | 影响 | 修法 |
|---|---|---|---|---|
| 1 | **UTF-8 转码错误**：逐字节 `String.fromCharCode` | `Logger.ets:45-47` | 所有非 ASCII 日志（中文/emoji/UTF-8 路径）读到的是乱码；诊断面板与 `/log` 可读性受损 | §6.2 A：`util.TextDecoder`（或 `buffer`）一次解码 + 丢截断首行 |
| 2 | **未用 `readSync` 的实际字节数** | `Logger.ets:37-48` | 并发写/截断时尾部可能带 NUL 填充 | 用返回值 `n` 做 `subarray(0, n)` |
| 3 | **`maxBytes` 无默认值/上界，`≤0` 语义未定义** | `Logger.ets:27,34-48` | 调用方传巨大值 ⇒ 一次分配打爆内存；传 0 ⇒ 返回 `''`（与「读成功但空」不可区分） | §6.2 A：`TAIL_DEFAULT`/`TAIL_MAX` + 显式占位串 |
| 4 | **hilog domain 两侧不一致**（ArkTS `0xD0033` vs C `0xD003300`） | `Logger.ets`、`node_bridge.c` | 用一条 `hilog -D` 过滤**拿不到全部**库日志；排障者要试两个域（或不过滤） | ✅ **已修（A1/R2，2026-10-17）**：**统一为 `0xD0033`**（改 C 侧 `LOG_DOMAIN`，与 ArkTS 侧及消费方 `pi-desktop-ark` 的 `Constants.ets` 一致）；两文件均加「必须相同」注释，构建产物 `mov w2,#0x33; movk w2,#0xd,lsl#16` 佐证 |
| 5 | **`crash_handler` 用 `snprintf` / `strlen`** | 历史：`node_bridge.c:103,109`（行号属旧快照） | 违反宪法 S5；理论上有自死锁/二次崩溃风险，崩溃证据可能一起丢 | ✅ **已修（2026-10-17）**：手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` 栈缓冲 + 单次 `write`（§6.2 E） |
| 6 | **`materializeRawfile` 忽略 `byteOffset`/`byteLength`** | `Env.ets`（旧 `fs.writeSync(file.fd, data.buffer as ArrayBuffer)`） | 若 `getRawFileContentSync` 返回的是池化缓冲上的视图，会多写尾部字节 ⇒ 载荷损坏（且是「写成功」型隐蔽 bug） | ✅ **已修（A5/R2，2026-10-17）**：按 `byteOffset`/`byteLength` 只写视图覆盖的字节（offset=0 且等长时零拷贝） |
| 7 | **`Env.ensureDir` 空 `catch`** | `Env.ets:33-35` | 违反 C2：目录没建成也只能等后续 `open` 失败，排查无落点 | catch 里 `Logger.error('ensureDir failed: ' + path + ' ' + JSON.stringify(e))`（不重抛，保持幂等） |
| 8 | **`log_line` 把换行拆成第二次 `open/write/close`** | `node_bridge.c:70-71` | 成本翻倍；多线程下两个 fd 各自 `O_APPEND` ⇒ 行可被交错 | 单次写（缓冲内拼 `\n`）+ 常开 fd（§6.4） |
| 9 | **`dup2` 同 fd 混流** | `node_bridge.c:187-188` | 宿主 ArkWeb/Chromium 原生输出混进 `node.log`（§D.10 ⑱ 实测）；`/log` 16 KB 里几乎全是 `arkweb/chromium_ext/…` | Phase 1：pipe + 独立 reader 线程 + 通道分离（§9 P1-006-01/02） |
| 10 | **`fd0` 未接 `/dev/null`** | `node_bridge.c:185-190`（只做 `dup2(fd,1)`/`dup2(fd,2)`） | 继承宿主 stdin：Node 侧读到宿主终端/管道 ⇒ 阻塞或收到垃圾输入 | 用 `/dev/null` 打开后 `dup2` 到 `0`（§5.10 ⑤） |
| 11 | **`/log` 全量读 + 按 UTF-16 码元切** | `selfcheck.js:70` | 大日志内存峰值 O(size)；「尾 8192 B」实际是「尾 8192 码元」 | §6.2 B |
| 12 | **`/log` 的日志路径来自 `HOME` 环境变量** | `selfcheck.js:67` | `Home` 被清空或 `NodeRuntimeOptions.logPath` 被覆盖时，端点读到错误/不存在路径（不是绝对路径推导） | 由库显式注入路径（env `NODE_BRIDGE_LOG_PATH` 或 `argv` 约定），`selfcheck.js` 优先读它 |
| 13 | **日志无轮转、无行上限、无时间戳** | `node_bridge.c:55,185` | 长跑后文件无限增长；`/log`/`tail` 的可预测性与内存上界失去保障；读回的文本无法定位时刻 | §4.5 的轮转规则 + 行上限；时间只在环条目上打点（兼容） |
| 14 | **`payload/README.md` 声称自检含 `spawn`，实现里没有** | `payload/README.md:9` vs `selfcheck.js:30-58` | 文档与实现不一致 ⇒ 审计者按文档取证据会落空 | 要么补检查项（FR-006-025），要么改文档（二选一，**不得**两边都放着） |
| 15 | **规划附录 A 的 hilog 过滤命令大小写不符** | `docs/000-工程规划.md:910`：`grep -E "node-bridge\|Cpp Crash"` vs tag `NODE_BRIDGE`（`node_bridge.c:39`） | 照抄命令会**漏掉**本库的所有 hilog 行（`grep` 区分大小写） | 改用 `grep -E "NODE_BRIDGE\|Cpp Crash"` 或加 `-i`；本规格 FR-006-031 的交付文档必须用可命中的模式 |
| 16 | **`Env.ets`/`NodeRuntime.ets` 的路径与规划草案不一致** | 实现：`<filesDir>/payload`（`Env.ets`）、日志 `<filesDir>/payload/node.log`、崩溃记录 `<filesDir>/node-bridge/last-crash.json` | 规划 §5.5/§5.7 **草案**写 `payloadRoot = <filesDir>/node-bridge/payload` | ✅ **已定案（B6/R2，2026-10-17）**：以**实现值**为准（payload 根 = `<filesDir>/payload`；崩溃记录 = `<filesDir>/node-bridge/last-crash.json`；三处同源：`Env`/`Types`/`NodeRuntime`）；规划草案措辞已被本决策取代（`docs/000-工程规划.md` 保留历史措辞，不再作为实现口径） |
| 17 | **`Logger.info/warn/error` 只有 hilog、不落盘** | `Logger.ets:14-24` | 宪法 S9 的「双通道」在 ArkTS 侧未满足；ArkTS 侧关键事件（`NodeRuntime.ets:85,94,112`）在 hilog 缓冲里可能被冲掉 | 二选一：① 让 `Logger` 也追加到文件（新通道 `arkts.log`，避免与 Node stdout 混行）；② 明确记录「ArkTS 侧只进 hilog」的**例外**并经评审（C2 要求失败可见，`hilog` 通常足够，但长跑会丢）。推荐 ① |

> 说明：#1/#2/#3（`tail` 的 UTF-8、实际字节数、入参边界）与 #8/#9/#10（ioctl/混流/排空）是本模块最靠前的两类真实缺陷；
> #4/#15/#16/#17 是「文档与实现分叉」，属于必须先决策再动手的项。

---

## 7. 测试考虑

### 7.1 host 侧（不接真机；`tools/smoke-host.mjs`，Phase 1）

| 用例 | 输入 | 判据 |
|---|---|---|
| `tail` 算法 · 空文件 | 0 B fixture | 返回 `'(log empty)'` |
| `tail` 算法 · 超大 | 100 MiB fixture（`truncate`/`head -c` 生成） | 耗时与内存与 size 解耦；只返回尾部分；**换行对齐**（返回文本以整行开头） |
| `tail` 算法 · 不存在 | 不存在的路径 | 返回 `'(read log failed: …)'`，**不抛** |
| `tail` 算法 · 二进制 | 含 `\x00`/非法 UTF-8 序列的 fixture | 不抛、不含 NUL、替换字符可接受 |
| `tail` 算法 · 多字节边界 | 中文/emoji 行 + 精确切在字符中间的 `maxBytes` | 输出合法 UTF-8、首个部分行被丢弃（**这条在 host 侧用同一算法实现验证；设备侧再用 `Logger.tail` 复验**） |
| 崩溃行解析 | `CRASH sig=5 si_addr=0x0 pc=0x7f1 lr=0x7f2 sp=0x7f3 r0=0x0`（+ 变体：`(nil)`、带 `[node_bridge] ` 前缀） | 正则提取 6 字段；`(nil)` 归一为 `0x0`；前缀容忍 |
| `/facts` schema 断言 | 既有 `facts.json` 样本（§D.9 证据目录） | 14 键齐备；类型正确（`wasm.validate: boolean`、`execArgv: array`、`hotloop_ms_5rounds: number`）；`ERR:`/`MISMATCH` 只允许出现在值里 |
| `/log` 尾部读 | fixture + 起点偏移 | 与 `tail` 实现**同一判据**（同样输入 ⇒ 同样输出），防两处算法漂移 |
| 假判据扫描 | `specs/` + `tools/` 全文 | 不出现「hilog 无该行 ⇒ 未执行」「`VmSize` ⇒ V8 已起」的断言（FR-006-026） |

### 7.2 真机（消费方应用或探针工程；库侧不签名主体，附录 A ✅）

| 通道 | 命令 | 判据 |
|---|---|---|
| ① 状态/证书 | `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts \| python -m json.tool` | 200 + §4.4 逐项阈值（`platform=openharmony`、`fs_write_readback=OK`、`wasm.validate/与 ACL 一致`、`hotloop` 落在 JIT 或解释器区间） |
| ② 日志读回 | `curl -s http://127.0.0.1:15577/log` | 200 + 尾 8192 B；含载荷哨兵串；不含 `arkweb/chromium_ext` |
| ③ hilog | `hdc shell hilog -x \| grep -E "NODE_BRIDGE\|Cpp Crash"` | 看到桥件行与崩溃行（**正**证据）；不作反证据（AC-006-09） |
| ④ 崩溃取证 | 注入一次崩溃（如临时把 `flags` 设为 JIT 路径而不给 ACL，或让载荷 `throw` 未捕获异常） | `node.log` 出现 `CRASH sig=…` 行；下次启动 `lastCrash()` 非 `null`（AC-006-01） |
| ⑤ 截图 | `hdc shell snapshot_display -f /data/local/tmp/s.png` + `hdc file recv` | 诊断面板/失败页有**可截图**的文字（消费方侧能力；库侧只保证提供了数据源） |
| ⑥ 输入 | `hdc shell uitest uiInput click <x> <y>` | 只用于**驱动**（点击刷新按钮）；**读取**必须走 ②/③/⑤（本机 `uitest dumpLayout` 拿不到结果 ✅） |
| ⑦ 调试通道 | debug：`hdc fport tcp:9229 tcp:9229` + DevTools；release：同命令 | debug 可连、可 `Runtime.evaluate`；release **连不上**且 `/facts` 的 `execArgv` 不含 `--inspect`（AC-006-08） |
| ⑧ 可选回传 | `hdc rport tcp:18080 tcp:18080`（让设备侧把日志 POST 到 host 收集器） | ⬜ 未实测；仅在 ①/② 都不可达（端口被占、载荷未起 HTTP）时作为兜底，须自带「不可达即放弃」的超时，**不得**阻塞 Node 主循环 |

### 7.3 边界与对抗用例

| 场景 | 期望行为 |
|---|---|
| 日志被**别的进程**写（另一实例/探针工程，§D.10 ⑰） | 不崩、不阻塞；读回内容可能混入他人行 ⇒ 由行前缀与哨兵串区分；`O_APPEND` 保证单次 `write` 原子 |
| 日志文件被**删除**（`rm`）后再写 | 常开 fd 仍可写（写到已 unlink 的 inode）⇒ 读回为空/占位串；必须有可检测信号（`/log` 返回 `(log empty)` 或 size=0），并在 hilog 留一次 `warn` |
| **磁盘满**（`ENOSPC`） | 写日志失败**不得**影响 Node 主流程：`raw_write` 静默返回 ⇒ 必须有 hilog 侧一次性 `warn`；`last-crash.json` 写失败仍保留 `CRASH` 行 |
| 日志极大（> 8 MiB） | 触发轮转（§4.5）；`/log` 与 `tail` 只读尾部；轮转期间读回不出现半行 |
| 崩溃发生在 **`node::Start` 之前**（如 `dlopen` 阶段） | `stage` = `dlopen`；`lastCrash()` 仍可读（`g_log_path` 已在 `start()` 内设好，`node_bridge.c:248`） |
| 连续两次崩溃 | `SA_RESETHAND` ⇒ 第二次直接 `SIG_DFL`；记录文件保留**最后一次**（`O_TRUNC` 覆盖） |
| 首次启动（`payload/` 不存在） | `ensureRuntimeDirs` 建目录；失败必须可见（缺陷 7 修法） |

---

## 8. 文件清单（真实 `wc -l`）

| 路径 | 行数 | 本模块角色 |
|---|---|---|
| `library/src/main/ets/log/Logger.ets` | **53** | ✅ `info/warn/error` + `tail`（UTF-8/边界缺陷在 #1-#3） |
| `library/src/main/ets/util/Env.ets` | **65** | ✅ 路径/目录/物化（缺陷 #6/#7） |
| `library/src/main/ets/runtime/Types.ets` | **49** | ⚠️ 待加 `NodeLogEntry`/`CrashRecord`/`logRingSize`（S2/S3） |
| `library/src/main/ets/runtime/NodeRuntime.ets` | **115** | 🔶 待加 `logs()`/`lastCrash()`；现有 `getLogPath()`/`markFailed()` 被观测面使用 |
| `library/src/main/cpp/node_bridge.c` | **295** | ✅ `log_line`/`raw_write`/`crash_handler`/`dup2`（缺陷 #5/#8/#9/#10） |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | **15** | ⚠️ 若扩 NAPI 面必须同步（S8） |
| `library/Index.ets` | **21** | ✅ 已导出 `Logger`/`Env`；待导出新类型（S2） |
| `library/src/main/cpp/CMakeLists.txt` | **16** | ✅ 输出目录已固定（S6），本模块不改 |
| `payload/selfcheck.js` | **84** | ✅ `/facts` + `/log`（缺陷 #11/#12；待加 `spawn` 项） |
| `payload/bootstrap.js` | **64** | ✅ 载荷侧参考实现（观测面载体；待加 `uncaughtException` 兜底 ⑱） |
| `payload/README.md` | **21** | ⚠️ 与实现不一致（缺陷 #14） |
| `tests/README.md` | **28** | ✅ 三层测试说明（真机在探针工程） |
| `specs/constitution.md` | **163** | 上游约束（S5/S9/C3/C6） |
| `specs/README.md` | **25** | ⚠️ 编号表待补本模块目录名（§0） |
| `specs/006-observability-logring-crash/spec.md` | 见仓库（本文件对） | 本模块规格（要什么） |
| `specs/006-observability-logring-crash/plan.md` | 本文件 | 本模块方案（怎么做） |
| `tools/smoke-host.mjs` | ⬜ 不存在 | Phase 1 新建：host 侧门禁（§7.1）；规划 §7.2/§7.4 已登记 |

> 说明：`library/` 下的 `build/`、`.cxx/` 为构建产物，不计入；`libnode.so`/`libc++_shared.so` **不入库**（S10、附录 G.1）。

---

## 9. Phase 1 待实现清单（逐条 + 验收判据）

> 优先级：**P0 = Phase 1 出口判据**（规划 §8 Phase 1 ⑥：落实 §5.10 ⑰⑱），**P1 = 本模块验收必需**，**P2 = 完善项**。

| 编号 | 项 | 内容 | 验收判据 | 优先级 |
|---|---|---|---|---|
| P1-006-01 | **stdio pipe + 独立 reader 线程** | `fd0=/dev/null`；`fd1/2` 接 1 MB pipe；`pthread_create` 一条 reader 线程持续排空（栈 ≤ 256 KB），逐行切分后入环 + 落业务日志 | 载荷连打 100k 行宿主不卡；ArkWeb 页面仍绘制（无白屏 R19）；`/proc/self/fd/1` 是 pipe | **P0**（§5.10 ⑤ · §8 Phase 1 ⑥） |
| P1-006-02 | **日志通道分离** | 业务日志（Node/桥件/载荷）与宿主原生输出物理分离；`node.log` 不再收 `arkweb/chromium_ext` | `curl /log` 中 `arkweb\|chromium_ext` 命中 = 0（AC-006-05） | **P0**（§D.10 ⑱） |
| P1-006-03 | **有界日志环 + `logs()`** | C 侧 ring（默认 500 行，`logLineMaxBytes=2048`，`dropped` 计数）+ NAPI 返回 JSON 字符串 + ArkTS 解析为 `NodeLogEntry[]` + `Types.ets`/`Index.ets` 同步 | 5,000 行输入 ⇒ 返回 ≤ 500 条、时间序、`stream` 正确、溢出可见（AC-006-10）；内存不随行数增长 | **P0**（C3/C6） |
| P1-006-04 | **崩溃记录 JSON + `lastCrash()`** | handler 单次 `write` 写 `<filesDir>/node-bridge/last-crash.json`（§6.2 E）；ArkTS 读回并补 `hint`/`logTail`；JSON 缺失/损坏时降级解析 `CRASH` 行 | AC-006-01 两条路径都通过（正常 + 降级） | **P0**（C6/C5） |
| P1-006-05 | **`tail` UTF-8 与边界修复** | §6.2 A：`TextDecoder`/`buffer` 解码；`TAIL_DEFAULT=4096`/`TAIL_MAX=1 MiB`；`maxBytes ≤ 0` 返回显式占位串；用实际读到的字节数；丢截断首行 | AC-006-11 通过；host 侧 fixture 全过（§7.1）；`tail` 在空/不存在/二进制下都不抛 | **P1**（FR-006-005/006） |
| P1-006-06 | **`/log` 改 offset 读** | §6.2 B；并把日志路径由「`HOME` 拼接」改为显式注入（缺陷 #12） | 100 MiB 日志下 `/log` 只读尾、宿主无内存峰值（AC-006-04）；路径与 `Env.logPath` 一致 | **P1** |
| P1-006-07 | **观测选项进公共 API** | `logRingSize?: number`（默认 500）与 `onLog?: (e: NodeLogEntry) => void` 写入 `Types.ets` 并实施（`NodeRuntimeOptions` 目前无此二者） | 编译通过；`logRingSize=10` 时 `logs()` 恰好 ≤ 10 条；`Index.ets`/`Types.ets` 同改（S2/S3 检查通过） | **P1** |
| P1-006-08 | **`--inspect` 仅 debug** | 单一开关点：`NodeRuntimeOptions.flags` 由 `BuildProfile.DEBUG` 守卫；release 拒绝并留 hilog `warn` | AC-006-08 通过；`/facts` 的 `execArgv` 在 release 不含 `--inspect` | **P1**（§8 Phase 1 ⑤） |
| P1-006-09 | **级别选择与缓冲可见性** | C 侧 `log_line` 增加级别参数（`error`/`warn`/`info` 映射 `LOG_ERROR`/`LOG_WARN`/`LOG_INFO`）；启动首个关键行与崩溃后首次读取用能进 dump 缓冲的级别；文档写清「hilog 正证据而非反证据」 | 崩溃后能在 `hilog -x` 看到 `error` 级行（正证据）；文档无「hilog 无该行 ⇒ 未执行」表述（AC-006-09） | **P1**（附录 B 17） |
| P1-006-10 | **日志轮转与行上限** | `nodeLogMaxBytes`（默认 8 MiB）+ `.1` 单代轮转；行 ≤ 2048 B（超出截断） | 长跑后 `node.log` ≤ 上限 + 一个块；轮转期间读回不出现半行；`tail`/`/log` 行为不变 | **P1**（FR-006-022） |
| P1-006-11 | **自检载荷补 `spawn` 项** | `/facts.checks` 增加 `spawn`（异步收集 `data`/`exit`/`close` 三事件 + `pid`），失败写 `ERR:…` | 真机上 `spawn` 项返回三事件齐备（或明确的 `ERR:…`）；`payload/README.md` 与实现一致（缺陷 #14） | **P2**（P0-4 判据） |
| P1-006-12 | **`log_line` 单次写 + 常开 fd** | §6.4：拼 `\n` 进同一缓冲；`bootstrap` 内 `open` 一次并复用；`crash_handler` 仍各自 `open`（保证信号上下文独立） | 稳态每行 ≤ 2 syscall（代码审查 + 计数）；行不再交错（`log_line` 与 reader 输出混合压测无半行） | **P1**（NFR-006-007） |
| P1-006-13 | **崩溃取证完善（可选）** | 追加 `si_code`（行尾）；`pc`/`lr` 的**离线**符号化流程写进文档（`llvm-addr2line`）；`nativeLib.debugSymbol.strip=false` 保留 native 符号（§5.10 ⑬ 的 strip 部分 ✅，`dladdr` 在 handler 内**不做**——动态链接器会加锁，非 async-signal-safe） | 崩溃行尾部多一个 `si_code` 字段且旧解析器不破；文档给出可复制的符号化命令与预期输出 | **P2** |
| P1-006-14 | **失败可见收口** | `Env.ensureDir` 的失败记 hilog（缺陷 #7）；`materializeRawfile` 的 `byteOffset/byteLength`（缺陷 #6）；pipe 创建失败回退可见（§6.3） | AC-006-12 通过；无空 `catch`（静态扫描 `catch (e) { }` 命中 0） | **P1**（C2） |
| P1-006-15 | **路径统一决策** | 二选一：日志/崩溃记录统一到 `<filesDir>/node-bridge/`（推荐，与 §5.3/§5.7 一致）或统一到 `<filesDir>/payload/`；同步 `Env`/`Types.ets` 注释/规划 §5.3/§5.7；旧路径提供一次只读回退探测 | 规划与代码**逐字一致**；旧证据目录仍可解析；`/log`、`lastCrash()`、`/facts` 三处读到同一路径 | **P1**（缺陷 #16） |
| P1-006-16 | **ArkTS 侧日志落盘通道** | 让 `Logger.info/warn/error` 除 hilog 外追加到 `arkts.log`（与 Node stdout 物理分离），满足 S9 双通道 | 关键失败（`NodeRuntime.ets:85,94,112`）能在文件读回中出现；`arkts.log` 与 `node.log` 分离（不串行） | **P1**（缺陷 #17） |
| P1-006-17 | **交付文档与命令** | 真机四条通道命令 + 预期输出 + 禁止判据清单（含附录 A 大小写修正，缺陷 #15）；文档内 `hilog grep` 模式必须可命中 | 照抄文档命令能在真机上得到文档所示输出（至少 `/facts` 200 与 `CRASH` 行两条） | **P1**（FR-006-031） |

**明确不做（Phase 1 边界）**：诊断面板/错误页/截图（消费方）· 自动重启或看门狗（C5 禁止）· 用 hilog 做反证据 · release 里保留 `--inspect` · 在 handler 内做 backtrace/`dladdr` · 引入第三方日志库/JSON 库 · 观测面承载宿主业务语义（C1）。

---

> 相关文件：`spec.md`（本模块规格）· `../constitution.md`（宪法）· `../../docs/000-工程规划.md`（唯一权威规划）。
