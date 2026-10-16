# spec.md —— `006-observability-logring-crash`（观测 · 日志环与崩溃取证）

> 模块编号：`006`。工程规划 §7.3 与本目录表中的简写是 `006-observability`，本规格按任务口径使用
> `006-observability-logring-crash`（目录名与编号表的对应关系在 `plan.md` §0 说明；改编号表本身不在本模块范围内）。
>
> 上游权威：`docs/000-工程规划.md`（v0.9，**结论以它为准**）· `specs/constitution.md`（v1.0）。
> 本文件只写「要什么 / 验收判据」；「怎么做」在 `plan.md`。规格**不复制**规划正文，只回引 § 号。
>
> 版本 v1.0 · 状态：**待评审**（Phase 1 范围，§8 Phase 1 出口判据 ②③⑤⑥；本模块在范围内）。

---

## 1. 模块概述

### 1.1 目的

在**同一个进程**里（应用域，非独立 Node 进程）建立一套**可回读、可截图、可 curl、崩溃后仍可用**的观测面：
日志（双通道 + 有界日志环 + 按需读尾）、崩溃取证（信号/地址/寄存器 + 跨启动可读的崩溃记录）、
端到端自检证书（`/facts`）、以及**每条写入通道各自的读回通道**。

对应宪法 **C6「诊断优先于修码」**：任何新增能力落地前必须回答「怎么在真机上看见它」（截图 / HTTP 端点 / hilog / 日志环）✅；
对应 **C3「让最终使用者去读」**：凡「写入成功」的判据一律改为「最终使用者读一遍」✅。

### 1.2 要解决的问题（每条都是本工程可复核的一手证据）

| # | 问题 | 现象（可搜的原文） | 依据 |
|---|---|---|---|
| ① | **真机无法 attach** | 进程内 `node::Start` 不是子进程，没有可 attach 的 Node 进程；`process.execPath = /system/bin/appspawn`、`cwd = /` | 规划 §D.8 偏差表 ✅ |
| ② | **沙箱日志 `hdc` 读不到** | debug 签名也不让 `hdc` 读沙箱内文件（`permission denied`）⇒ 观测点**必须是应用域**（HTTP 端点 / 界面 / hilog） | 宪法 §三 纪律 2 ✅ · 附录 B 症状 16 ✅ |
| ③ | **hilog 不可作执行判据** | 「应用侧 INFO 常不进 hilog dump 缓冲」⇒ hilog 里没有某行**不能**推断「没执行」 | 规划 §5.7「禁止的判据」✅ · 附录 B 症状 17 ✅ |
| ④ | **崩溃后无证据** | 进程内崩溃是**终态**（`node::Start` 每进程一次，硬约束 ⑥），无法自动重启 ⇒ 没有证据就只能猜 | 宪法 C5 ✅ · 规划 §5.2 ✅ |
| ⑤ | **宿主原生输出污染日志** | `dup2` 到同一个 `node.log` 会把 **ArkWeb/Chromium 的原生输出**写进去：本轮 `/log` 返回的 16 KB 里几乎全是 `arkweb/chromium_ext/…` | 规划 §D.10 ⑱ ✅ · §5.10 ⑤ ✅（登记 R19） |
| ⑥ | **不排空管线会阻塞宿主** | stdio 接文件而不持续排空，输出量大时阻塞 ArkWeb 的 IO 线程 ⇒「Web 组件不绘制」（最难查的一类白屏） | 规划 §5.10 ⑤ ✅（R19） |
| ⑦ | **假判据混入验收** | 用 `VmSize` 判 V8 是否起来（ArkTS/ArkWeb 自占约 40 GB 虚拟地址空间）；用 hilog 有无该行判执行；用「点击看起来生效」判 UI | 规划 §5.7 ✅ · 附录 B 症状 18 ✅ · 宪法 C6 ✅ |
| ⑧ | **本机 `uitest dumpLayout` 拿不到结果** | 原计划的 UI 判据不可用 ⇒ 判据改用 **HTTP 端点读回** | 规划 §D.8「首启可见性」行 ✅ |

### 1.3 范围

**含**（本模块负责）：

- ArkTS 侧 `Logger`（`info`/`warn`/`error` 经 hilog；`tail(path, maxBytes)` 读日志尾且**失败不抛**）；
- `Env`（`payloadDir` / `tmpDir` / `logPath` / `ensureDir` / `ensureRuntimeDirs` / `materializeRawfile`）——路径与环境装配；
- 原生侧日志（`log_line` → hilog + 文件；`raw_write` 信号安全；崩溃 handler 写 `CRASH …` 行）；
- **stdio 重定向策略**（含「必须排空 + 必须与宿主原生输出分离」这条硬要求的落地）；
- **有界日志环**（规划 `logs(): NodeLogEntry[]`，默认 500 行）；
- **崩溃记录文件**（规划 `<filesDir>/node-bridge/last-crash.json` + `lastCrash(): CrashRecord`，跨启动可读）；
- **端到端证书**（`payload/selfcheck.js` 的 `/facts` 与 `/log` + `hdc fport` + `curl`）；
- **调试通道**（`--inspect` 仅 debug，release 必须关闭）；
- 每条日志的**「谁写谁读」读回通道矩阵**与**禁止的假判据**清单。

**不含**（明确划出，避免越界到消费方或别的模块）：

- **诊断面板 / 错误页 / 阶段文案 / 截图**——属消费方（规划 §6.1「观测」行的消费方列 ✅；
  `pi-desktop-ark/entry/src/main/ets/pages/Index.ets:69-71` 的 `refreshLog()` 至今是 `TODO(Phase 1)` 占位 ✅）；
- 状态机与生命周期（`001-runtime-core`）、`dlopen`/`argv`/SIGSYS shim（`002-napi-bootstrap`）、
  宿主能力桥（`003-host-bridge`）、载荷解包与入口解析（`004-payload-bootstrap`）、产物校验（`005-provision-verify`）；
- 应用业务日志的内容（C1：库**不认识** `pi` / `pi-web` / `PI_*`，规划 §0.3 ✅）。

---

## 2. 用户故事

| 编号 | 角色 | 故事 | 期望的可观测判据 |
|---|---|---|---|
| US-006-1 | **宿主应用开发者** | 我要在自己的应用里起 Node，并在不出 DevEco、不接调试器的情况下知道「起来了没有、卡在哪一步、报了什么错」 | 诊断面板里能读到日志尾（`Logger.tail`）与状态；`hdc fport` + `curl /facts` 返回 200 JSON；失败时界面有**可截图**的文字（规划 §3.1 目标 2/7 ✅） |
| US-006-2 | **值班排障者** | 用户在真机上遇到崩溃/白屏，我要在**不重装、不改包**的前提下拿到证据 | `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…` 行 + `last-crash.json`（下次启动可读）+ `/log` 尾 8192 B + `hilog -x \| grep NODE_BRIDGE`；四条通道各跑一次即可交付（规划 §5.7） |
| US-006-3 | **审计者** | 我要判断「这台设备的这个进程里 Node 到底能用什么」，而不是相信文档或推断 | `/facts` 的 **16 项**检查（+响应级 `at`）一次性给出 `node`/`platform`/`arch`/`execArgv`/`versions`/`homedir`/`tmpdir`/`homedir_redirected`/`tmpdir_redirected`/`netifaces`/`cpus`/`spawn`/`wasm.validate`/`wasm.error`/`fs_write_readback`/`hotloop_ms_5rounds`；**这条 JSON 就是一次真机成功运行的证书**（规划 §5.7 ✅） |
| US-006-4 | **载荷开发者（消费方）** | 我要知道「我的 stdout/stderr 去了哪里、谁在读它」，以及日志会不会被宿主 Web 容器的原生输出污染 | 读回通道矩阵（§4.4）+ 日志通道分离的验收场景 AC-006-05；`node.log` 里不出现 `arkweb/chromium_ext/…`（规划 §D.10 ⑱ ✅） |

---

## 3. 功能需求

> 现状列标记：✅ 已实现（可复核）· 🔶 部分实现 · ⚠️ 现实现**违反**既有纪律/契约 · ⬜ 规划未实现（Phase 1/2）。
> 所有「现状 ✅」均给出源码 `path:line`。

| 编号 | 需求 | 现状 | 依据 |
|---|---|---|---|
| **FR-006-001** | **双通道输出**：库的关键事件必须**同时**进 hilog 与日志文件；任何单通道实现都视为未完成 | 🔶 ArkTS 侧 `info/warn/error` **只有 hilog**（`Logger.ets:14-24`）；C 侧 `log_line` 双通道 ✅（`node_bridge.c:69-71`）；Node 侧 stdout/stderr 只落文件 ⚠️（`node_bridge.c:185-192`） | 宪法 S9 ✅ · 规划 §5.7 ✅ |
| **FR-006-002** | **写读配对**：每条写入通道必须声明它的**读回通道**与**读回者**；不允许只有「写成功」的断言 | ✅ 通路齐备：hilog→hilog、文件→`Logger.tail`/`/log`、**崩溃记录 → `lastCrash()`（`NodeRuntime.ets`）**、**进程 stdout/stderr → `logs()`（按行解析 §1.3 前缀）** | 宪法 C3 ✅ · 规划 §5.7 ✅ |
| **FR-006-003** | **有界日志环**：`logs(): NodeLogEntry[]` 返回最近 N 行（N 由 `logRingSize` 决定，**默认 500**）；内存占用有硬上界；溢出策略为「丢最旧 + 可观测丢弃计数」，**不得**静默丢弃 | ⬜ 不存在；`logRingSize` 选项也不存在（`Types.ets:16-34` 无该字段） | 规划 §5.7 / §5.3 ✅ |
| **FR-006-004** | **按需读尾**：`Logger.tail(path, maxBytes)` 只读文件尾 `maxBytes` 字节；**空文件**返回固定占位串；**文件不存在 / 不可读 / 跑在信号错误路径上**一律返回占位串，**绝不抛异常** | ✅ `Logger.ets:27-52`（空文件 `'(log empty)'`:31-32；异常 `'(read log failed: …)'`:49-51；`finally` 关 fd:40-42） | 宪法 S9 ✅ · C3 ✅ |
| **FR-006-005** | **读尾的多字节正确性**：读尾结果必须是**合法 UTF-8 文本**；截断点落在多字节字符或行中间时，必须丢掉被截断的首行/首字符而不是输出乱码 | ⚠️ 现状逐字节 `String.fromCharCode` 拼串（`Logger.ets:45-47`）⇒ 任何非 ASCII 字节（中文日志、`%{public}` 的路径、载荷输出）**必乱码** | 本模块缺陷（见 `plan.md` §6.2） |
| **FR-006-006** | **读尾的入参边界**：`maxBytes` 必须有默认值与上界（防「一次读 1 GB 把宿主 OOM」）；`maxBytes ≤ 0` 时的行为必须**确定**且与「空文件」可区分 | ⚠️ 现状无默认值、无上界；`maxBytes ≤ 0` 会返回空串 `''`，与「读成功但没内容」不可区分（`Logger.ets:34-48`） | 本模块缺陷 |
| **FR-006-007** | **原生单行日志**：`log_line(fmt, …)` 生成一条完整行（含换行），同时进 hilog 与文件；**一条日志只允许一次文件写**（不得把 `"\n"` 拆成第二次 `open/write/close`） | 🔶 `log_line` 存在（`node_bridge.c:62-73`），但换行是**第二次** `raw_write`（:70-71）⇒ 两个 fd 各自 append，跨线程时可交错出半行；级别固定 `LOG_INFO`（:69） | 规划 §5.7 ✅（级别选择） |
| **FR-006-008** | **信号上下文安全**（硬要求）：崩溃/信号 handler 内**只允许**裸 `open`/`write`/`close`(+ `clock_gettime`/`sigaction`/`signal`/`raise`/静态表访问)；**禁止**任何 stdio 与格式化函数（`printf`/`snprintf`/`vsnprintf`/`OH_LOG_Print`/`malloc`/`getenv`） | ⚠️ `crash_handler` 用 `snprintf` + `strlen`（`node_bridge.c:103-107,109`）⇒ **违反 S5**（`snprintf` 不在 POSIX async-signal-safe 列表内，可能自死锁或在 handler 里二次崩溃） | 宪法 S5 ✅ · 规划 §5.10 ② ✅ |
| **FR-006-009** | **崩溃结构化取证**：崩溃行必须包含**信号号 + 地址 + 程序计数 + 返回地址 + 栈指针 + 首参寄存器**，格式固定为 `CRASH sig=%d si_addr=%p pc=%p lr=%p sp=%p r0=%p`（ARM64: `lr = regs[30]`、`sp = uc_mcontext.sp`、`r0 = regs[0]`） | ✅ `node_bridge.c:100-112`（字段与映射齐备；`buf[512]` 栈缓冲足够） | 宪法 C6 ✅ · 规划 §5.7 / §5.10 ⑬ ✅ |
| **FR-006-010** | **信号集**：至少覆盖 `SIGSEGV(11)`/`SIGILL(4)`/`SIGBUS(7)`/`SIGABRT(6)`/`SIGFPE(8)`/`SIGTRAP(5)`；`SIGTRAP` 必须在列（无 ACL 时 V8 的 JIT 失败就是 `sig=5`，是本形态最常见崩溃） | ✅ `node_bridge.c:115` | 规划 §D.8 ①（`CRASH sig=5`）✅ |
| **FR-006-011** | **不吞崩溃**：证据写完后必须恢复默认处置并重新抛出信号（`SIG_DFL` + `raise`），**禁止**在 handler 里「记录后继续跑」 | ✅ `node_bridge.c:110-111` | 宪法 C2 ✅ · 规划 §5.7 ✅ |
| **FR-006-012** | **handler 不可重入死锁**：处置必须在进入时被重置（`SA_RESETHAND`），二次故障直接 `SIG_DFL` 终止，不得无限递归 handler | ✅ `node_bridge.c:119`（`SA_SIGINFO \| SA_RESETHAND`） | 规划 §5.10 ⑬ ✅ |
| **FR-006-013** | **崩溃记录文件**：崩溃时写 `<home>/node-bridge/last-crash.json`（每次崩溃覆盖），字段至少 `at`/`stage`/`signal`/`hint`（+ `logTail` 由 ArkTS 侧补）；写入必须是**单次 `write`**（不依赖堆、不做 JSON 库），且失败不得影响 `CRASH` 行落盘 | ✅ C 侧 `crash_handler` 覆盖写（`at`/`stage`/`signal`/`hint`，整块单次 `write`）；`logTail` 由 `NodeRuntime.lastCrash()` 补 20 行 | 规划 §5.7 ✅ |
| **FR-006-014** | **跨启动可读**：`lastCrash(): CrashRecord \| null` 在**下次启动**可读到上次记录；进程内不可重启（C5）⇒ 这是失败态 UX 契约的输入之一 | ✅ 已实现：`NodeRuntime.lastCrash()`（`NodeRuntime.ets`，全文 **798 行**，含 `logs`/`lastCrash`/`shutdown`/`waitUntilRunning`）；读的是投递时**实际生效**的 `home`（`options.homeDir` 或 `filesDir`），与原生 handler 同源；`logTail` 由 ArkTS 补 20 行 | 宪法 C5 ✅ · 规划 §5.2/§5.3 ✅ |
| **FR-006-015** | **崩溃记录的降级路径**：JSON 缺失/损坏/半写时，`lastCrash()` 必须能从日志尾里的 `CRASH` 行解析出**降级记录**（至少 `signal` 与原始行），而不是返回「无崩溃」 | ✅ 已实现：缺文件 ⇒ `null`（契约明文）；文件存在但 JSON 不可解析/零字节 ⇒ 从日志尾 `sys … CRASH ` 行重建 `at`/`signal` 的降级记录（`stage:''` + 常驻 `logTail`），并 `warn` 指名走了哪条路径（`NodeRuntime.degradedCrashFromLog`） | 宪法 C2 ✅ |
| **FR-006-016** | **`hint` 的可操作性**：`hint` 必须把「症状 → 处置」写成人可读的一步（如 `sig=5` ⇒ 查 ACL/W^X；`SIGABRT` + 崩溃栈含 `libnode_bridge.so` ⇒ 查载荷未捕获异常，如端口 `EADDRINUSE`） | ⬜ 只有信号号，无提示（`node_bridge.c:104`） | 规划 附录 B 症状 19 ✅ |
| **FR-006-017** | **自检端点 `GET /facts`**：返回 `200` + `application/json`，结构为 `{ at, checks:{…} }`，`checks` **至少**含 **16 项**（`node`/`platform`/`arch`/`execArgv`/`versions`/`homedir`/`tmpdir`/`homedir_redirected`/`tmpdir_redirected`/`netifaces`/`cpus`/`spawn`/`wasm.validate`/`wasm.error`/`fs_write_readback`/`hotloop_ms_5rounds`）+ 响应级 `at`；任一项抛异常必须以 `\"ERR:…\"` 字符串留在 JSON 里，**不得**让端点整体 500 | ✅ `payload/selfcheck.js`（16 键冻结，`tools/smoke-host.mjs` 阶段④逐键对齐） | 规划 §5.7 ✅ · §D.9 ✅ |
| **FR-006-017a** | **自检端点集合**：`/facts` `/log` `/rport`（POST）`/diag` 四条路径；其它路径一律 `404`；只绑 `127.0.0.1` | ✅ `payload/selfcheck.js`；`/diag` 返回 `{at, lastError, appLogTail, hostBridge}` | 规划 §5.7 ✅ |
| **FR-006-018** | **`/facts` 即证书**：一次真机成功运行必须能仅凭该 JSON 判定「libnode 已加载、Node 起来了、事件循环在跑、HTTP 在听、fs 可用、loopback 可达」；不接受「截图看起来对」或「VmSize 很大」作为替代判据 | ✅ 字段齐备（`wasm.validate` + `fs_write_readback=OK` + `hotloop_ms_5rounds` + `homedir/tmpdir` 沙箱前缀） | 宪法 C6 ✅ · 规划 §5.7 ✅ · §D.9 ✅ |
| **FR-006-019** | **`GET /log`**：返回 `200` + `text/plain`，正文为日志尾（默认 ≤ 8192 B）；**只读尾部**（不得把整个日志读进内存）；读失败时返回可读的失败文本而不是 500/空；其它路径一律 `404` | 🔶 存在（`selfcheck.js:66-79`），但用 `fs.readFileSync(whole)` 再 `slice(-8192)` ⇒ **超大日志会整份进内存**，且 `slice` 按 UTF-16 码元切分（不是字节） | 规划 §5.7 ✅ · §D.8 ✅ |
| **FR-006-020** | **日志通道分离**：`node.log` 中**只允许**出现 Node/桥件/载荷自己的输出；宿主 Web 容器（ArkWeb/Chromium）的原生输出**不得**混入 | ✅ 已按 C1 落地：reader 线程**按行过滤**含 `arkweb/chromium_ext` / `chromium` 的组件输出（不写入文件），并在**首见**与**每个 reader 退出**时各写一条 `sys` 行报累计丢弃行数（不静默）；`out`/`err` 的口径已修订为「进程 stdout/stderr」（契约 §1.3） | 规划 §D.10 ⑱ ✅ · §5.10 ⑤ ✅ · §6.2 共享事实 2 ✅ |
| **FR-006-021** | **stdout/stderr 必须被持续排空**：重定向形态必须保证「写入方永不被管道写满阻塞」（1 MB pipe + 独立 reader 线程），否则宿主 IO 线程被阻塞 ⇒ 白屏 | ⬜ 现在是直接写文件（无 reader）；`fd0` 也未接 `/dev/null` | 规划 §5.10 ⑤ ✅（R19）· §8 Phase 1 ⑥ ✅ |
| **FR-006-022** | **日志文件有界**：必须有轮转/截断策略，避免长跑后日志无限增长（`/log` 与 `tail` 的可预测性依赖它）；轮转必须对「正在写」的进程安全（rename + 重开或 size cap） | ⬜ 无任何轮转；`O_APPEND` 无限增长（`node_bridge.c:55,185`） | 规划 §5.7（有界性）✅ |
| **FR-006-023** | **级别与缓冲可见性**：日志级别必须可配；且**至少存在一条能进 hilog dump 缓冲的输出路径**（应用侧 `INFO` 常不进）；不能用「hilog 里没有那一行」反推「没执行」 | ⚠️ C 侧固定 `LOG_INFO`（`node_bridge.c:69`）；ArkTS 侧 `info/warn/error` 三档 ✅（`Logger.ets:14-24`）；无级别配置项 | 规划 §5.7 ✅ · 附录 B 症状 17 ✅ |
| **FR-006-024** | **调试通道必须可关闭**：`--inspect` 只允许出现在 **debug** 构建；release 必须**没有**它；开关只允许有一个生效点（options → flags），不允许散落在载荷代码里 | ⬜ `flags` 是自由字符串（`Types.ets:25`、`NodeRuntime.ets:76`），无任何 debug/release 守卫；`BuildProfile.ets` 有 `DEBUG = true` 但无人使用 | 规划 §5.7「调试通道」✅ · §8 Phase 1 ⑤ ✅ |
| **FR-006-025** | **自检载荷的 `spawn` 项**：`/facts` 应含一项可复现 P0-4 的检查（`spawn('/system/bin/sh')` 的 `data`/`exit`/`close` 全送达、无僵尸），因为「`spawn` 是否可用」是消费方决策的输入 | ✅ `payload/selfcheck.js` 的 `spawn` 项（`{pid, stdout, events:{data,exit,close}, zombie, procState}`，5 s 超时）；`/facts` 16 键冻结（`tools/smoke-host.mjs` 阶段④逐键对齐） | 规划 §D.8 结论 3 ✅ · P0-4 ✅ |
| **FR-006-026** | **禁止的假判据**（必须写进库的文档与消费方契约，且不得出现在本库任何验收脚本里）：<br>① 用 hilog「有没有那一行」判执行；<br>② 用 `VmSize` 判 V8 是否起来（ArkTS/ArkWeb 自占约 40 GB 虚拟地址空间）；<br>③ 用「点击看起来生效」判 UI（本机 `uitest dumpLayout` 也拿不到结果 ⇒ 改用 HTTP 端点读回） | 🔶 `selfcheck.js` 本身不含假判据 ✅；但库内没有任何地方**落文**这条纪律 | 宪法 C6 ✅ · 规划 §5.7 ✅ · 附录 B 18 ✅ · §D.8 ✅ |
| **FR-006-027** | **失败可见**：本模块的每条失败路径都必须有**落点**（返回占位串 + hilog / JSON 内 `ERR:` / `CRASH` 行 / 崩溃记录），不允许空 `catch` 静默吞掉 | ⚠️ `Env.ensureDir` 的 `catch` 体为空（`Env.ets:33-35`），注释声称「不吞诊断信息」但实际既不记日志也不上报 | 宪法 C2 ✅ |
| **FR-006-028** | **公共 API 纪律**：本模块新增的公共 API（`logs()` / `lastCrash()` / `logRingSize` / 崩溃记录类型）必须**同时**改 `library/Index.ets` 与 `runtime/Types.ets`，并走 `specs/README.md` 编号表 + 受影响模块 `plan.md` 的变更流程；`Types.ets` 改动即破坏性变更 | ✅ 现状：`Index.ets:20-21` 已导出 `Logger`/`Env`；⬜ 新 API 未加 | 宪法 S2/S3 ✅ · §六 变更流程 ✅ |
| **FR-006-029** | **不得引入宿主语义**：日志内容、`hint` 文案、自检项都不得出现 `pi`/`pi-web`/Next.js/`PI_*` 的解释；库只提供通道与结构 | ✅ 现状合规（`Logger.ets`/`Env.ets`/`node_bridge.c` 无业务语义） | 宪法 C1 ✅ · 规划 §0.3 ✅ |
| **FR-006-030** | **不得暗示可重启**：观测面不得提供「崩了自动重启」「重新起一个 Node」的能力或文案；失败态只允许「读日志 / 读崩溃记录 / 提示重启应用」 | ✅ 现状合规（`NodeRuntime.ets` 无重启路径；`crash_handler` 不 swallow） | 宪法 C5 ✅ · 规划 §5.2 ✅ |
| **FR-006-031** | **取证实务可复现**：库交付物必须含**可复制执行**的真机取证命令（`hdc fport` + `curl /facts`、`curl /log`、`hilog -x \| grep NODE_BRIDGE`、`snapshot_display` 截图、`uitest uiInput click` 输入），并写明命令的**预期输出** | 🔶 规划 附录 A ✅ 有命令，但 `grep -E "node-bridge\|Cpp Crash"` 的大小写与实际 tag `NODE_BRIDGE` 不符（`node_bridge.c:39`）⇒ 照抄会漏行 | 规划 附录 A ✅ · §5.7 ✅ |

---

## 4. 关键实体

| 实体 | 说明 | 关键属性 | 现状 |
|---|---|---|---|
| **日志条目** `NodeLogEntry` | 日志环里的一行（ArkTS 侧可见的结构化条目） | `at: number`（epoch ms）· `stream: 'stdout' \| 'stderr' \| 'system'` · `text: string`（不含换行） | ✅ `runtime/Types.ets` 定义；`NodeRuntime.logs()` 从日志尾逐行解析 §1.3 前缀返回（无内存环，见 FR-006-003） |
| **崩溃记录** `CrashRecord` | 一次崩溃的**跨启动**证据 | `at: number` · `stage: string`（崩溃时所处引导阶段：`stdio`/`dlopen`/`dlsym`/`start`/`running`）· `signal?: string`（如 `SIGTRAP`）· `hint?: string`（人可读下一步）· `logTail: string[]` | ✅ `runtime/Types.ets` 定义；`NodeRuntime.lastCrash()` 读回（含降级路径） |
| **崩溃行** `CRASH` line | 信号 handler 唯一能安全写出的、脱离堆的证据 | `sig`/`si_addr`/`pc`/`lr`/`sp`/`r0` 六个字段（`%p` 十六进制）；单行、≤ 512 B、单次 `write` | ✅ `node_bridge.c:100-112` |
| **日志文件** `node.log` | **进程** stdout/stderr 落点（崩溃取证的**唯一文件通道**）；组件原生输出被过滤 | 绝对路径 `<filesDir>/payload/node.log`（`Env.ets:25-27`）；`O_APPEND` + 0644；**无轮转**；含 `arkweb/chromium_ext` 或 `chromium` 的行由 reader 过滤并计数（C1） | ✅ 实现 / ✅ 组件输出过滤（丢弃行数可见） |
| **崩溃记录文件** `last-crash.json` | 崩溃时覆盖写、下次启动读取的记录 | 路径 `<home>/node-bridge/last-crash.json`（`home` = 实际生效的 `homeDir`/`filesDir`）· 单次 `write` · 字段 `at`/`stage`/`signal`/`hint`（`logTail` 由 ArkTS 侧补） | ✅ C 侧 handler 写、`lastCrash()` 读（含降级路径） |
| **自检结果** `/facts` 响应 | 「一次真机成功运行」的证书 | `{ at: string(ISO-8601), checks: { 16 键 + … } }`；每项要么是期望值，要么是 `"ERR:…"` | ✅ `payload/selfcheck.js` |
| **读回正文** `/log` 响应 | 沙箱文件不可 `hdc` 读时的**应用域**回传通道 | `text/plain`，尾 ≤ 8192 B | ✅ `payload/selfcheck.js` |
| **环境路径** `EnvPaths` | 库对外的沙箱路径约定（S4：一律绝对路径） | `payloadDir = <filesDir>/payload` · `tmpDir = <filesDir>/tmp` · `logPath = <filesDir>/payload/node.log` · `crashPath = <filesDir>/node-bridge/last-crash.json` | ✅ 四项齐备（`Env.ets`） |

### 4.4 读回通道矩阵（「谁写谁读」——C3 的落地表）

| 写入者 | 写到哪里 | 读回通道 | 读回者 | 现状 |
|---|---|---|---|---|
| ArkTS `Logger.info/warn/error` | hilog（domain `0xD0033`、tag `NODE_BRIDGE`、`%{public}s`） | `hdc shell hilog -x \| grep NODE_BRIDGE` | 值班排障者 | ✅ `Logger.ets:14-24`（⚠️ 未落盘 ⇒ 违反 S9 的「双通道」） |
| C 桥件 `log_line` | hilog（domain `0xD003300`）+ `node.log` | 同上的 hilog；`Logger.tail`；`/log` | 排障者 / 诊断面板 | ✅ `node_bridge.c:62-73` |
| C 桥件 `crash_handler` | `node.log` 的 `CRASH` 行 + `last-crash.json` | `Logger.tail` 解析 / `lastCrash()` | 值班排障者 / 消费方失败态 UI | ✅ 行 + 记录文件都齐 |
| Node 侧 stdout/stderr（载荷） | `node.log`（组件原生输出已过滤）；⬜ 日志环 + hilog | `Logger.tail` / `/log` / ✅ `logs()` | 诊断面板 / 回归基线 | ✅ 文件 + `logs()` 解析 |
| 自检载荷 | HTTP 响应（内存内） | `hdc fport` + `curl /facts`、`curl /log` | 审计者 / CI 记录 | ✅ `selfcheck.js` |

---

## 5. 验收场景

**AC-006-01 崩溃后下次启动能读到记录**（C5 + C6 + C3）
- **Given** 应用曾因载荷未捕获异常崩溃（如端口冲突 `EADDRINUSE` ⇒ 整个 App 进程 abort，附录 B 19 ✅）
- **When** 重新启动应用（新进程）并调用 `lastCrash()`
- **Then** 返回 `CrashRecord`（非 `null`）：`at` 落在上次运行的时间窗内、`signal` 与日志尾里 `CRASH sig=…` 的号码一致、`hint` 非空且指向可执行动作、`logTail` 含崩溃前最后若干行
- **降级**：把 `last-crash.json` 删掉/截断后重跑 ⇒ 仍能返回由 `CRASH` 行解析出的降级记录（`signal` + 原始行），**不得**返回「无崩溃」

**AC-006-02 日志文件被 `hdc` 拒绝读取时走 HTTP 读回**（宪法 §三 纪律 2 + 附录 B 16）
- **Given** 真机上 `<filesDir>/payload/node.log` 存在且非空
- **When** `hdc shell cat …/node.log` 返回 `permission denied`（预期 ✅），改走 `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/log`
- **Then** 返回 `200` + `text/plain`，正文为该日志尾（与 `Logger.tail` 读回的尾部一致），且不依赖 `hdc` 的文件访问权限

**AC-006-03 日志为空**
- **Given** `node.log` 存在且 `size == 0`
- **When** 调 `Logger.tail(path, 4096)`（以及 `curl /log`）
- **Then** `tail` 返回 `'(log empty)'`；`/log` 返回 `200` 且正文可读（空正文或同一占位串），**不抛异常、不返回 5xx**

**AC-006-04 日志超大时只读尾部**
- **Given** `node.log` 为 100 MiB（前置：把文件写到该大小，或制造长跑日志）
- **When** 调 `tail(path, 8192)` / `curl /log`
- **Then** 两者都只返回**尾部**内容；宿主进程 RSS **无明显峰值**（`/log` 不得把整份日志读进内存）；截断点落在行中间时丢掉被截断的首行

**AC-006-05 日志不被宿主原生输出污染**（§D.10 ⑱）
- **Given** 应用已加载 ArkWeb 页面（会持续输出 `arkweb/chromium_ext/…` 原生日志）
- **When** 启动 Node 并让载荷写 200 行带唯一哨兵串的日志，然后 `curl /log`
- **Then** 返回正文里**只有**桥件/载荷行；`arkweb`/`chromium_ext` 命中数为 **0**；且 `node.log` 里不含宿主原生输出

**AC-006-06 信号 handler 内不调 stdio**（宪法 S5 + §5.10 ②）
- **When** 静态审查 + `grep -nE 'printf|snprintf|vsnprintf|OH_LOG_Print|malloc|getenv' library/src/main/cpp/node_bridge.c`
- **Then** 命中只允许出现在 **非信号上下文**的函数里（如 `log_line`/`bootstrap`）；`crash_handler` 与 `raw_write` 内**零命中**；handler 只用 `open`/`write`/`close`/手写数字格式化/`signal`/`raise`
- **现状**：⚠️ 不通过 —— `crash_handler` 含 `snprintf`（`node_bridge.c:103`）与 `strlen`（:109）

**AC-006-07 `/facts` 一次成功运行即证书**（规划 §5.7 / §D.9）
- **Given** 真机 + 已装 HAP（库侧不签名主体，装机走消费方或探针工程）
- **When** `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts | python -m json.tool`
- **Then** HTTP **200**、可解析 JSON、`at` 为 ISO-8601、**16 项检查齐备**（冻结键名，见 FR-006-017）；且满足：`platform == 'openharmony'`、`arch == 'arm64'`、`node ≈ v24.2.0`、`homedir`/`tmpdir` 以 `<filesDir>` 开头、`netifaces` 含 `lo`、`fs_write_readback == 'OK'`、`wasm.validate` 与 ACL 状态一致（有 ACL ⇒ `true`；`--jitless` ⇒ `false` + `wasm.error == 'WebAssembly is not defined'`）、`hotloop_ms_5rounds < 50`（JIT 生效）或 `> 200`（解释器基线，二者都必须被**显式识别**，不得混判）
- 端点集合：`/facts` `/log` `/rport`（POST）`/diag`；其它路径 `404`；只绑 `127.0.0.1`

**AC-006-08 release 无 `--inspect`**（规划 §8 Phase 1 ⑤）
- **Given** release 构建的 HAP（`BuildProfile.DEBUG == false`）
- **When** 检查实际 `process.execArgv`（只能从 `/facts` 读 ✅）
- **Then** `execArgv` 不含 `--inspect`/`--inspect-brk`；`hdc fport tcp:9229` 连不上 DevTools（或库拒绝开启该开关并留下可见日志）；debug 构建下 `--inspect` 可用且能 `Runtime.evaluate`

**AC-006-09 hilog 里没有某行不能判「没执行」**（宪法 C6 + 附录 B 17）
- **Given** 「应用侧 INFO 常不进 hilog dump 缓冲」
- **When** 只凭 `hdc shell hilog -x` 的输出判断「Node 没起来」
- **Then** 该判据**被判定为无效**：必须改用 `/facts` 的 `node`/`platform`/`versions` 字段或 `logger.tail` 的日志尾；库文档与任何验收脚本都不得出现「hilog 无该行 ⇒ 未执行」的断言

**AC-006-10 有界日志环与超量输出**
- **Given** 载荷连续输出 5,000 行（> 默认 500 行容量）
- **When** 调 `logs()`
- **Then** 返回**恰好 ≤ `logRingSize` 条**（默认 500），条目顺序 = 时间顺序，`stream` 区分 `stdout`/`stderr`/`system`，溢出计数可从返回值或系统条目看到（不得静默丢弃）；进程内存不随输出行数线性增长

**AC-006-11 读尾的多字节正确性**
- **Given** 日志里有一行包含中文与 emoji（多字节 UTF-8）的输出
- **When** 用 `maxBytes` 恰好把该行截断在中间后调 `tail`
- **Then** 返回文本是合法 UTF-8、无 `ï¿½` 类乱码、无 NUL 填充；被截断的首行被丢弃
- **现状**：⚠️ 不通过 —— `Logger.ets:45-47` 逐字节 `String.fromCharCode` 破坏所有非 ASCII 字节

**AC-006-12 失败必留落点**（C2）
- **Given** `Env.ensureDir` 因权限/磁盘原因失败；或 `last-crash.json` 写入失败
- **When** 触发这两条路径
- **Then** 至少有 hlog 一条 `warn`/`error` 或返回结构里可见的失败标志；**不允许**空 `catch` 静默通过
- **现状**：⚠️ `Env.ensureDir` 空 `catch`（`Env.ets:33-35`）

---

## 6. 非功能需求

| 编号 | 需求 | 判据 |
|---|---|---|
| NFR-006-001 | **信号上下文安全** | 崩溃/信号 handler 内只用 async-signal-safe 原语；静态审查（AC-006-06）+ 真机注入一次崩溃不二次崩（能拿到完整 `CRASH` 行） |
| NFR-006-002 | **有界内存** | 日志环 ≤ `logRingSize × 单行上限`（建议单条 ≤ 2 KB ⇒ 默认 500 行 ≤ 1 MiB）；崩溃路径只用栈缓冲（≤ 512 B）+ 静态缓冲，**零堆分配** |
| NFR-006-003 | **读取不抛异常** | `Logger.tail` 与任何读回 API 在「文件不存在 / 空 / 权限不足 / 二进制内容」下都返回字符串（占位串或内容），绝不抛出（宪法 S9 硬约束） |
| NFR-006-004 | **对首启耗时的影响可忽略** | 新增观测面（日志环、reader 线程、崩溃记录初始化）在启动路径上只允许「1 次 `open` + 1 条线程创建」，不引入额外同步 I/O 等待；reader 线程栈 ≤ 256 KB；禁止 `fsync` |
| NFR-006-005 | **可 curl** | 每条应用域回读通道都能用 `hdc fport` + `curl` 在 host 侧取到（`/facts`、`/log`）；命令与预期输出写进交付文档（FR-006-031） |
| NFR-006-006 | **可截图（责任边界）** | 库只保证「可 curl + 状态可读」；**界面截图**由消费方诊断面板负责（规划 §6.1 ✅）；库不提供页面/组件（C1） |
| NFR-006-007 | **性能：每行日志的 syscall 预算** | 稳态每行 ≤ 2 次 syscall 量级（常开 fd + 单次 `write`）；**不得**每行 `open/write/close` 两次（现状 ⚠️ 6 次）；量化与改善方向见 `plan.md` §6.4 |
| NFR-006-008 | **读回成本可预测** | `tail`/`/log` 单次调用只做常量次数的文件操作（无全量读）；轮询方（诊断面板）约定 ≥ 500 ms 间隔，库不提供高频推送 |
| NFR-006-009 | **可测试性** | 崩溃行、`/facts`、`/log`、日志环都必须是**文本可断言**的格式（正则可解析；无二进制帧） |
| NFR-006-010 | **兼容性** | API 17+/24/26、`2in1`/`tablet`、arm64-v8a（规划 §7.5 兼容矩阵 ✅）；只依赖 `@kit.PerformanceAnalysisKit`、`@kit.CoreFileKit`、`@kit.LocalizationKit`（S1：原生模块**只经 `.d.ts`** 接入） |

---

## 7. 假设与约束

| # | 假设 / 约束 | 证据 | 对设计的影响 |
|---|---|---|---|
| A1 | **沙箱日志 `hdc` 读不到**（debug 签名亦然，`permission denied`） | 宪法 §三 纪律 2 ✅ · 附录 B 16 ✅ | 观测点必须在**应用域**：HTTP 端点 + 日志环 + hilog；「把文件拷出来」不是可用路径 |
| A2 | **应用侧 INFO 常不入 hilog dump 缓冲** | 规划 §5.7 ✅ · 附录 B 17 ✅ | hilog 只能作为**辅助**通道；级别要选能进缓冲者；且不得把「hilog 无该行」当反证 |
| A3 | **`VmSize` 不可作判据**（ArkTS/ArkWeb 自占约 40 GB 虚拟地址空间） | 规划 §附录 B 18 ✅ | 「V8 起来了没有」只能用功能性判据（`/facts` 的 `node`/`versions`/`wasm.*`、端口探活） |
| A4 | **本机 `uitest dumpLayout` 拿不到结果** | 规划 §D.8「首启可见性」✅ | UI 判据改用 **HTTP 端点读回**；`uitest` 只用于**输入**（`uiInput click`），不作为读取判据 |
| A5 | **`dup2` 会把宿主原生输出混进 `node.log`** | 规划 §D.10 ⑱ ✅ | stdio 必须改「pipe + 独立 reader 线程」，并**物理分离**业务日志与宿主原生输出（Phase 1 硬项） |
| A6 | 进程内 Node **不可重启**，崩溃是终态 | 硬约束 ⑥ ✅ · 规划 §5.2 ✅ | 崩溃记录必须**跨启动**可读；观测面不得提供「重启」暗示 |
| A7 | `process.cwd() == '/'`、`execPath == /system/bin/appspawn`、`os.cpus()` 长度 **0** | 规划 §D.8 ✅ | 路径**一律绝对**（S4）；`cpus` 不可作并发判据；不得依赖 cwd/execPath 定位日志 |
| A8 | `dlopen` 只认**裸名** `libnode.so`；`io_uring_setup(425)` 本机返回 **8**（无 seccomp trap） | 规划 §D.8 ✅ · §D.9 ✅ | 日志里必须保留 `dlopen(...) -> OK/err` 行作为「哪条候选命中」的证据 |
| A9 | 端口冲突会把**整个 App 进程** abort（载荷未捕获异常） | 规划 §D.10 ⑰ ✅ · 附录 B 19 ✅ | 崩溃记录必须能区分「载荷异常（SIGABRT + 栈含 `libnode_bridge.so`）」与「V8 W^X 拒绝（SIGTRAP）」 |
| A10 | 库**不签名主体**，装机走消费方或探针工程 | 规划 附录 A ✅ | 本模块的真机验收必须在消费方应用或探针工程内执行，库侧只交付命令与判据 |
| A11 | 库侧 **C 接口只有 3 个**（`start`/`isRunning`/`version`），扩展必须同步 `.d.ts` | 宪法 S8 ✅（`node_bridge.c:285-293`、`index.d.ts:8-15`） | `logs()`/崩溃记录若由原生实现，属 **002 的接口扩展**，需两个模块同时改 |
| A12 | 规划 §5.7 要求崩溃处理器「写 `last-crash.json` **+ hilog**」，但 §5.10 ② 与 S5 禁止在信号上下文调 `OH_LOG_Print` | ⚠️ 规划内部冲突 ✅ | 取 S5/§5.10 ②（更硬）：handler **只写文件**；hilog 由下次启动的 `lastCrash()`/ArkTS 侧补打 |
| A13 | 规划 §5.7/§5.3 的路径是 `<filesDir>/node-bridge/…`，代码是 `<filesDir>/payload/…` | ⚠️ 代码与规划不一致 ✅（`Env.ets:15-27`） | Phase 1 必须**二选一并统一**（见 `plan.md` §9）；本规格以「统一后一致」为验收条件 |

---

## 8. 依赖

| 方向 | 依赖对象 | 具体接口 / 事实 | 状态 |
|---|---|---|---|
| 上游 | `002-napi-bootstrap` | `g_log_path` 与 `log_line`/`raw_write`/`crash_handler`/`dup2` 策略；`start(libDir, script, flags, home, logPath)` 的第 5 参就是日志路径；`flags` 字符串是唯一 `execArgv` 入口（C4） | 🔶 落地（`node_bridge.c:47,53-73,100-122,185-192,234-271`） |
| 上游 | `001-runtime-core` | 状态机与失败态（`failed` 终态、`markFailed(reason)`）；`getLogPath()`；失败态 UX 契约只允许「读日志 / 读崩溃记录 / 提示重启应用」 | 🔶 落地（`NodeRuntime.ets:33-49,102-114`） |
| 上游 | `004-payload-bootstrap` | `selfcheck.js` 与 `bootstrap.js` 是观测面的**载荷侧载体**；载荷必须自装 `uncaughtException`/`unhandledRejection` 兜底（⑱） | 🔶 `selfcheck.js` ✅ / 兜底 ⬜ |
| 上游 | 环境契约 | `HOME`/`USERPROFILE`/`TMPDIR`/`TMP`/`TEMP` → 沙箱；`NODE_ENV=production`；`NODE_OPTIONS` 已清空 | ✅ `node_bridge.c:143-149`（规划 §5.6 ✅） |
| 上游 | `005-provision-verify` | `/facts` 的 `versions`/`node` 字段要与 `runtime.lock.json` 的锁定值对得上（`verifiedOn`/`verifiedDevice`） | ✅ 规划 §5.8 / 附录 G ✅ |
| 下游 | 消费方诊断面板（`pi-desktop-ark`） | `Logger.tail` → `pages/Index.ets` 的 `refreshLog()`（**现状 `TODO(Phase 1)`** ✅）；`logs()`/`lastCrash()` → 失败态 UI | ⬜ 未接线 |
| 下游 | 回归基线（Phase 3） | 每轮真机回归把 `/facts` JSON + `/log` 尾部 + `hilog -x` 命中存档为基线证据 | ⬜ 规划 §8 Phase 3 ✅ |
| 下游 | 消费方契约 | 「观测」行承诺：日志环 + hilog + `lastCrash()` + `/facts`；消费方自建诊断面板（规划 §6.1 ✅） | 🔶 承诺已写，实现 ⬜ |

---

> 相关文件：`plan.md`（本模块设计与实现方案）· `../constitution.md`（宪法）· `../../docs/000-工程规划.md`（唯一权威规划）。
