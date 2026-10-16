# 004-payload-bootstrap-entry-resolver —— 载荷引导 · 解包与入口解析（`spec.md`）

> - **模块编号**：`004-payload-bootstrap-entry-resolver`（工程规划 §7.3 表项名 `004-payload-bootstrap`；本目录名以任务书为准）
> - **阶段**：**Phase 1 范围内**（工程规划 §8「最小可用运行时」明确列出 `004-payload-bootstrap`）
> - **载体**：`payload/*.js`（纯 CommonJS，在 **Node 线程内**运行；不参与 ArkTS 编译）
> - **最高约束**：`specs/constitution.md` **C3「让最终使用者去读」为核心**，另受 C2（不隐藏平台真相）、C4（启动参数不可事后修改）、C6（诊断优先）、C7（零上游补丁）与 S4（路径一律绝对）、S9（日志双通道）约束
> - **证据标记**：✅ 本工程可复核的一手证据（源码 `path:line`）· 🔶 沿用外部/同型工程一手真机记录（本工程未复现）· ⬜ 待验证 · ⚠️ 冲突或风险
> - **结论以 `docs/000-工程规划.md`（v0.9）为准**；本文只做细化与验收，不复述其正文

---

## 1. 模块概述

### 1.1 目的

回答一个问题：**「Node 已经起来了，怎么让真正的应用跑起来？」**

模块覆盖「`node::Start` 成功返回之后、应用逻辑执行之前」的那一段：载荷定位 → 载荷就绪（幂等）→ 入口解析 → 环境装配 → 异常兜底 → 自检与日志可读回。它是「能起 Node」（`001`/`002`）与「能承载真实服务端」（规划 §3.1 第 3 条：一份载荷 + 入口脚本 + 环境变量 + `argv` 就能跑起真实服务端）之间**唯一缺失的一环**。

### 1.2 解决的问题

| 现状 | 问题 | 本模块的答复 |
|---|---|---|
| `payload/bootstrap.js` 是**骨架**（✅ 64 行） | 只能按约定探测一个入口并裸 `require`；无解包、无幂等、无 CJS/ESM 兼容、无异常兜底 | 补全规划 §5.5 的载荷契约 |
| 骨架期消费方只能跑**自检脚本**（`selfcheck.js`，✅ `pi-desktop-ark/entry/src/main/ets/common/Constants.ets:18`） | 「Node 起来了」≠「应用能跑」——规划 §3.1 第 3 条未达成 | 入口解析 + 载荷就绪 + 环境契约三段闭环 |
| 27.2k 文件 / 884 MB 的载荷（✅ `pi-desktop-ark/docs/000-工程规划.md:176`） | 首启解包是最大的耗时与失败面（🔶 旧壳真机解压 27,279 文件、首启到就绪约 15 s） | **只读直读优先**：路线 ① 零解压、零首启等待（🔶 §5.5 / §5.10 ⑩） |
| 端口冲突曾让**整个 App 进程 abort**（✅ §D.10 ⑰） | 载荷里任何未捕获异常都是应用级事故（进程内 Node 无优雅退出路径） | 强制 `uncaughtException` / `unhandledRejection` 兜底 + 独立日志通道（⑱） |

### 1.3 范围

| 含 | 不含（归属） |
|---|---|
| 载荷**定位**（只读直读路径 / `tar.gz` 归档路径）、可写性判定 | 服务端口选择与**探活策略**（消费方契约，规划 §6.1；`001.markRunning()` 由消费方调用） |
| 载荷**就绪幂等**（SHA-256 marker + 入口可读性复检） | 日志环、hilog、`last-crash.json`（`006-observability`） |
| `tar.gz` **自解包**（`zlib` + `fs`，Node 自己写业务文件） | 宿主能力桥 `@fellow99/node-bridge/host` 的实现（`003-host-bridge`） |
| **入口解析**（CJS/ESM、绝对路径、优先级） | 载荷**内容与裁剪**、投放时机、加载页与错误页（消费方） |
| **环境消费**（`HOME`/`TMPDIR` 断言 + 消费方 `env` 传入的应用语义变量） | 环境**注入**本体（`002-napi-bootstrap`，✅ `library/src/main/cpp/node_bridge.c:142-149`） |
| 异常**兜底**与日志「谁写谁读」的读回通道 | 渲染（库**不参与**，规划 §5.1）与 `--inspect` 调试开关（消费方） |
| 载荷自检脚本的**端点与字段口径**（`/facts`、`/log`） | 自检项的**执行实现之外**的真机判定基线（`006` 与消费方证据文档） |

---

## 2. 用户故事

### US-004-001 宿主应用开发者（消费方 ArkTS 侧）
> 我把一份真实的 Node 服务端载荷放进 HAP，希望**一次启动就能跑起来**：给库一个入口与载荷根，不需要我懂 tar、不需要我写解包代码、不需要我处理「解包到一半被杀」的中间态。第二次启动必须**明显更快**（跳过解包），并且我能从日志里读回「它到底做了哪几步」。

### US-004-002 端上服务端载体作者（载荷作者）
> 我的载荷用 `require` 写（CJS），也可能含 ESM 入口；它在桌面环境依赖 `process.cwd()` 和我自己的 `PI_*` 环境变量。在端上我只要：① 入口被正确加载（CJS/ESM 都行）；② `cwd` 落在我的载荷目录；③ 我的 `PI_*` 变量原样送达；④ 我自己抛出的异步异常**不要把整个 App 打崩**，而是留下可读的日志。

### US-004-003 排障者（在真机上判断「到底走到哪一步」）
> 我只有 `hdc fport` + `curl` 和一张日志截图。我需要：① `/facts` 一次问清这个进程里的 Node 能力面；② `/log` 读回日志**尾部**（含上一次崩溃记录）；③ 入口缺失、解包失败、marker 命中跳过这三类结局在日志里**文本可区分**（可 grep）。

---

## 3. 功能需求

> 编号连续；「依据」列给证据标记 + 规划锚点。`✅` 项为**已落地需保持**，`⬜` 项为 Phase 1 **待实现**。

### 3.1 载荷定位与形态

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-001** | 载荷形态**两种二选一**，按「是否需要可写」判定：① **只读直读**（首选）：载荷原样放 `resources/resfile/<app>/`，Node 从安装目录直读 ⇒ 零解压、零首启等待；② **单个 `tar.gz` + Node 自解包**，仅当载荷必须可写（如 Next 的 `.next/cache`）时使用 | 🔶 §5.5 载荷形态行 · 🔶 §5.10 ⑩ · ✅ `payload/README.md:19-20` |
| **FR-004-002** | 只读路线的载荷根必须由**消费方传入的绝对路径**给出（`context.bundleCodeDir`/`resourceDir` 派生），库侧不得猜测安装目录、不得用 `process.cwd()` 拼接 | ✅ S4 · ✅ §D.8 偏差表（`cwd=/`） · ✅ `library/src/main/ets/runtime/Types.ets:26-27` |
| **FR-004-003** | 可写性边界：若载荷只需要**一块可写缓存**，应把缓存目录指向宿主可写目录（经 `env` 给出），**不得**为了可写把整份载荷再解一份 | 🔶 §5.5 可写性边界行 |
| **FR-004-004** | 大载荷必须支持**分卷**（如 `payload-core.tar.gz` + `payload-app.tar.gz`）独立幂等判定，避免单文件过大影响升级粒度 | 🔶 §5.5 大载荷建议行 |
| **FR-004-005** | 解包**只在**「显式给出 `archive` 且目标不可用/校验不通过」时发生；未给 `archive` 时不得尝试任何解包路径 | ⬜ §5.3 `NodeRuntimeOptions.archive` · 🔶 §5.5 |

### 3.2 就绪幂等

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-006** | 幂等判据 = **归档 SHA-256**：读 marker → 与期望值比对 → 命中即跳过解包。**禁止**用「目标目录是否存在」「文件大小」「mtime」作判据 | 🔶 §5.5 幂等行 · ✅ `pi-desktop-hos/src-main/main.js:499-500`（只比存在性 ⇒ 就地升级不生效，必须卸载重装） |
| **FR-004-007** | 期望哈希来源优先级：消费方传入的 `archiveSha256` > 归档同目录的 `<archive>.version` 文件 > **本地计算一次并落盘记下**（第三档必须 warn，明确「tar 变化仍会触发重解压」） | 🔶 旧壳 `main.js:507-512` 同型做法 |
| **FR-004-008** | marker 命中后**必须复检入口可读性**（`require`/`existsSync` 一次）；复检失败 ⇒ 强制重解包并 warn。禁止让「marker 一致但载荷不完整」静默通过 | ✅ `main.js:517-524`（解压中途被杀会留下「看似完整」的树）· ✅ C2 |
| **FR-004-009** | marker 写入必须**原子**（写 `<marker>.tmp.<pid>` → `renameSync`，且在解包**全部完成并复检通过之后**写入）；`link(2)` 不可用，不得依赖它 | 🔶 §4.4（`link` → `EACCES`；已确认不存在 → `rename`） |
| **FR-004-010** | marker 内容格式 = `^[0-9a-f]{64}$`（小写 hex）；读到非法内容按「无 marker」处理并记日志，不得抛错 | 🔶 旧壳 `main.js:545-552` 的 `readMarker` 口径 |
| **FR-004-011** | 解包失败必须**不写 marker**（下次启动自然重试），并输出可见文本：失败阶段 + 原始错误 + 已写条数 | ✅ C2 · ✅ §3.1 第 7 条「失败可见」 |

### 3.3 解包器（谁写谁读）

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-012** | 解包者**必须是 Node 自己**（`zlib` + `fs`）；**禁止**任何 OHOS/ArkTS 侧解压器写业务文件 | ✅ constitution **C3** · ✅ §4.2 ④ · ✅ `library/src/main/ets/util/Env.ets:47-49`（Node 读不到安装包内只读条目；ArkTS 写的文件也要自己读一遍） |
| **FR-004-013** | 解包必须**流式**：`fs.createReadStream` → `zlib.createGunzip` → `512 B header` 状态机 → 随到随写；**禁止**整包 `readFileSync`/全量 `gunzipSync` 缓冲（单卷 156.6 MB 压缩态 / 884 MB 展开态） | ✅ `pi-desktop-hos/src-main/tar-extract.js:1-9`（旧实现 `Buffer.concat` 全量复制 ⇒ 对超大条目退化 O(n²)、真机单核 100%、永不结束）· ✅ `pi-desktop-ark/docs/000-工程规划.md:176` |
| **FR-004-014** | 条目名**安全校验**（强制）：`path.resolve(destRoot, name)` 后必须仍在 `destRoot` 内（`startsWith(destRoot + path.sep)`）；拒绝含 `..` 段、绝对路径、空名的条目并记日志 | ⚠️ 搬运源 `tar-extract.js:21-44` **无任何校验**：`../` 会越出目标目录（真机上等于写沙箱任意位置） |
| **FR-004-015** | 只允许 `typeflag ∈ {0, '\0', 5}`；`L`（GNU long name）与 `x`（pax extended header）按受控方式处理（见 `plan.md` §6.2）；符号链接 / 硬链接 / 设备文件 / FIFO 一律**跳过**并记日志，绝不 `symlink()`/`mknod()` | ✅ §4.4（真机 `symlink` 应用域 `EACCES`）· ⚠️ 搬运源把 `L`/`x` 当「skip 载荷」⇒ 长路径条目名被截断 |
| **FR-004-016** | 目录条目必须**幂等**（`mkdirSync(recursive)`），文件写入前必须 `mkdir -p` 父目录；同一目录重复条目不得报错 | ✅ `tar-extract.js:166-183` 同型做法 |
| **FR-004-017** | 解包条目名的**应用前缀必须参数化剥离**（如归档内顶层目录名），库侧**不得**硬编码任何应用目录名（现源实现硬编码 `pi-dist/`） | ✅ **C1**（库不得出现应用语义）· ⚠️ `tar-extract.js:31-33` |
| **FR-004-018** | 解包必须输出**过程可观测**：开始（归档绝对路径 + 目标 + 期望哈希）、完成（文件数 + 耗时 ms + marker 路径 + 入口绝对路径）、跳过（命中 marker） | ✅ C6 · ✅ §5.7「端到端证书」口径 · 🔶 旧壳日志形态 `pi-desktop-hos/docs/真机验证记录.md:232` |

### 3.4 入口解析与工作目录

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-019** | 入口定位优先级：① 消费方显式传入（`options.entry`，绝对路径或相对 `payloadRoot`）→ ② `env` 传入的**中立变量名**所指路径 → ③ 约定 `<payloadRoot>/app/index.js` → ④ `<payloadRoot>/package.json` 的 `"main"`。命中即停，四条都未命中 ⇒ 可见失败 | ✅ 已实现（`payload/bootstrap.js` `resolveEntry`：`NODE_BRIDGE_ENTRY` 绝对/相对 → `package.json` 的 `main` → `index.js`；未命中打印 `ENTRY_MISSING` 并返回）。② 由 `NODE_BRIDGE_ENTRY` 承担；库侧**不再**解释 `PI_*` | 
| **FR-004-020** | 库侧**不得**解释 `PI_*` 等应用语义变量名，也不得为它们提供默认值；此类变量由消费方经 `env` 传入、由载荷自己解释 | ✅ **C1** 已落地：`payload/bootstrap.js` 的 `PI_WEB_ENTRY` 兼容别名**已删除**（入口只认 `NODE_BRIDGE_ENTRY`）；消费方这类值走 `options.env`（envPairs 在 `NODE_BRIDGE_*` 之后应用 ⇒ 仍可覆盖） |
| **FR-004-021** | 入口解析结果**必须是绝对路径**（`path.resolve` + `path.isAbsolute` 双校验）；禁止用 `process.cwd()`、`process.execPath`、`__dirname` 之外的相对假设拼路径 | ✅ **S4** · ✅ §D.8 偏差表（`cwd=/`、`execPath=/system/bin/appspawn`） |
| **FR-004-022** | CJS/ESM 兼容：先 `require(absPath)`；**仅当** `err.code ∈ {ERR_REQUIRE_ESM, ERR_REQUIRE_ASYNC_MODULE, ERR_REQUIRE_CYCLE_MODULE}` 时退 `import(pathToFileURL(absPath).href)`；其它错误码**不得**吞掉重试 | 🔶 §5.5 入口行 · ✅ `pi-desktop-hos/src-main/main.js:581-592`（`loadModule` 同型实现 + 三条错误码白名单） |
| **FR-004-023** | `import()` 返回的是 Promise ⇒ 引导器必须能 `await` 或显式挂 `.catch`，保证 ESM 入口抛错同样进入异常兜底通道（不得产生 unhandledRejection） | ✅ 同上 + FR-004-031 |
| **FR-004-024** | 工作目录：解包/可写路线必须 `process.chdir(<载荷根绝对路径>)`，且 chdir 前校验目标存在且是目录；只读直读路线若载荷依赖 `resolve(cwd,'package.json')` 类约定同样需要 chdir。`cwd` 由消费方指定（`options.cwd`，默认载荷根） | ✅ §D.8 偏差表（`cwd=/` ⇒ 直接决定 `resolve(cwd,'package.json')` 类约定能否成立）· 🔶 §5.5 入口行 · ⬜ `bootstrap.js` 无 `chdir` |
| **FR-004-025** | `process.chdir` 失败（目录不存在/权限）必须可见：写日志后用**绝对路径**继续（不得静默继续依赖相对路径） | ✅ C2 · ✅ 同 FR-004-021 |

### 3.5 环境消费

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-026** | 启动时断言 `HOME` 存在且**非空**；缺失即抛错并被顶层捕获为可见 FATAL（不得静默用 `''` 拼路径） | ✅ `payload/bootstrap.js:20-24` 已实现 · ✅ §5.6 `HOME` 行 |
| **FR-004-027** | 启动时对 `HOME` 与 `TMPDIR` 各做一次**写-读回**探针（`谁写谁读`），结果进日志与 `/facts`；断言二者落在可写沙箱内（路径不以 `/` 裸根或沙箱外前缀开头即告警） | ⬜ 现状只记录值（`selfcheck.js:35-36,43-49`），无断言 · ✅ C3 · ✅ §D.8「`homedir`/`tmpdir` 重定向生效」 |
| **FR-004-028** | 环境快照必须先进日志：`node`/`platform`/`arch`/`modules` 版本行 + `home`/`cwd`/`execPath` 行；`cwd`/`execPath` **只用于日志**，不得参与任何路径或重启逻辑 | ✅ `bootstrap.js:38-39` · ✅ §D.8（`execPath=/system/bin/appspawn`） |
| **FR-004-029** | 消费方经 `env` 传入的应用语义变量必须**原样可见**（载荷侧 `process.env.X` 读回一致）；库侧不得过滤、覆盖、改名；仅允许库侧强制项（`UV_USE_IO_URING`/`NODE_OPTIONS`/`HOME`/`TMP*`）优先 | ✅ §5.6 全表 · ✅ `node_bridge.c:142-149`（注入时机在 `node::Start` 之前） · ✅ **C4** |

### 3.6 异常兜底与日志读回

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-030** | 必须注册 `process.on('uncaughtException')`：写一条含 `stack` 的日志，然后**不抛出、不 `process.exit`**，让应用进程存活（`node::Start` 单例、无重启） | ✅ §D.10 ⑱ · ✅ §D.10 ⑰（端口冲突 ⇒ 未捕获异常 ⇒ 整个 App abort） · ✅ 已实现（`bootstrap.js` `installExceptionGuard()`：写 `<HOME>/payload/app.log` + stderr + `globalThis.__nodeBridgeLastError`，绝不 `process.exit`） |
| **FR-004-031** | 必须注册 `process.on('unhandledRejection')`：同样写日志且不抛出；与 `uncaughtException` 共用同一段文本协议 | ✅ §D.10 ⑱ · ✅ 已实现（`bootstrap.js` `installExceptionGuard()` 两个处理器共用 `recordError()`） |
| **FR-004-032** | 载荷侧必须写**独立日志通道**（自有文件，如 `<home>/payload/app.log`），不得只依赖 `node.log`：`dup2` 会把宿主 ArkWeb/Chromium 的原生输出混进 `node.log` | ✅ 已实现：兜底写 `<HOME>/payload/app.log` + stderr；C 侧 reader 同时**过滤**含 `arkweb/chromium_ext`/`chromium` 的组件行并报丢弃计数（C1 修订，契约 §1.3） |
| **FR-004-033** | 同步顶层失败：写 `[bootstrap] FATAL <stack>` 到 stderr 与日志，**刻意不** `process.exit`；同时必须给出「失败与成功如何区分」的可见判据（日志文本 + `/facts`，因为 `node::Start` 返回值不足以区分） | ✅ `bootstrap.js:59-64` 的取舍 · ✅ `node_bridge.c:220-223`（rc 记录） · ⚠️ 见 `plan.md` §5.3 |
| **FR-004-034** | 日志「谁写谁读」：写日志的一方必须提供**读回通道**（`/log` 端点 / ArkTS `Logger.tail(path, maxBytes)`）；读失败返回**占位串**而不抛异常 | ✅ **C3** · ✅ S9 · ✅ `library/src/main/ets/log/Logger.ets:26-52`（`tail` 返回 `(read log failed: …)`） |

### 3.7 载荷自检端点

| ID | 需求 | 依据 |
|---|---|---|
| **FR-004-035** | `/facts` 返回 `200` + `application/json`，结构 = `{ at, checks }`；`checks` **冻结 16 键**（`node`/`platform`/`arch`/`execArgv`/`versions`/`homedir`/`tmpdir`/`homedir_redirected`/`tmpdir_redirected`/`netifaces`/`cpus`/`spawn`/`wasm.validate`/`wasm.error`/`fs_write_readback`/`hotloop_ms_5rounds`）；`hostBridge`/`state` 属 Phase 2 追加（规划 §5.7 口径） | ✅ `payload/selfcheck.js`（16 键；`tools/smoke-host.mjs` 阶段④逐键对齐）· 🔶 §5.7「端到端证书」 |
| **FR-004-036** | `/log` 返回 `200` + `text/plain`，内容 = `<HOME>/payload/node.log` 的**尾部有界切片（默认 8192 B）**；读失败返回 `200` + `(read failed: <msg>)` 占位串 | ✅ `selfcheck.js:66-77` · ✅ S9 · ✅ `Logger.tail` 同型口径 |
| **FR-004-037** | 端点集合：`/facts`（GET）· `/log`（GET）· `/rport`（POST）· **`/diag`（GET）**；其它路径返回 `404`；`selfcheck.js` 必须以 `127.0.0.1` 绑定（不得 `0.0.0.0`），端口取 `SELFCHECK_PORT`、默认 `15577` | ✅ `payload/selfcheck.js`（`/diag` 返回 `{at, lastError, appLogTail, hostBridge}`）；默认端口是**文档化取证契约**，被占用时回退内核临时端口并打印 `[selfcheck] WARN 15577 被占用 → 改用 <port>`（C3） |
| **FR-004-038** | `selfcheck.js` 的检查项集合必须与 `payload/README.md` 声明的集合**一致**（含 `spawn`） | ✅ 已一致：`/facts` 16 个冻结键（含 `spawn`、`homedir_redirected`/`tmpdir_redirected`），README 同步；`tools/smoke-host.mjs` 阶段④逐键对齐 |
| **FR-004-039** | 自检 HTTP 服务必须处理 `server.on('error')`（端口占用等）：写日志、**不得让异常逃逸**（未捕获异常 = 应用级 abort） | ✅ `payload/selfcheck.js`：`server.on('error', …)`；`EADDRINUSE` ⇒ 回退临时端口（C3），其它错误写 stderr，绝不抛 |
| **FR-004-040** | 自检端点是**诊断面**，不是产品面：必须在文档中声明「同设备其他应用也能访问 loopback 端口」，故 `/log` 输出不得成为敏感信息的唯一泄漏面（发布构建须能关闭自检端口） | ✅ 声明在 `payload/README.md` / `selfcheck.js` 头注释（固定端口 + 无鉴权 + `/log` 回显日志的现状如实标注）· ✅ C2 · 规划 §5.7「release 必须关闭 `--inspect`」同型纪律 |

---

## 4. 关键实体

| 实体 | 载体 / 类型 | 关键字段与约定 | 现状 |
|---|---|---|---|
| **载荷（Payload）** | 只读：`resources/resfile/<app>/` 目录树；可写：单个（可分卷）`*.tar.gz` | 形态二选一；只读优先；可写性判定见 FR-004-001/003 | ⬜ 仅 `pi-desktop-ark` 里存在空目录占位 + README（✅ `entry/src/main/resources/resfile/pi-web/README.md`） |
| **载荷根（payloadRoot）** | 绝对路径字符串 | 可写路线的解包根；默认 `<filesDir>/payload`（**实现值**；规划 §5.3 草案的 `<filesDir>/node-bridge/payload` 已被取代，B6/R2）；只读路线为 `readonlyRoot`（默认 `context.resourceDir`） | ✅ 已实现（`Types.ets` `payloadRoot?`；`Env.payloadDir`） |
| **入口（Entry）** | 绝对路径字符串 + `require`/`import` 结果 | 四条优先级（FR-004-019）；CJS/ESM 双通道；未 CJS/ESM 兼容前只有裸 `require` | ✅ 部分（`bootstrap.js:49-56`） |
| **幂等 marker** | 文件 `<payloadRoot>/.ready-<sha256 前 12 位>`（JSON：完整 `sha256` + `files` + `bytes` + `skipped` + `at`） | 原子写（`.tmp.<pid>` → `rename`）；命中且目标目录存在 ⇒ 跳过；非法/缺失按缺失处理 | ✅ 已实现（`payload/bootstrap.js`；路径以冻结契约 §3.2 为准） |
| **解包目标目录** | `<payloadRoot>/<sha256 前 12 位>/` | 目录幂等；路径穿越拒绝；跳过的条目计数随 marker 落盘（`skipped`） | ✅ 已实现（`payload/lib/tar-extract.js` + `bootstrap.js`） |
| **环境快照（EnvSnapshot）** | `env()` 返回对象 | `home`/`cwd`/`execPath`/`platform`/`arch`/`node`/`modules` | ✅ `bootstrap.js:20-34`（`cwd`/`execPath` 仅供日志） |
| **自检结果对象（Facts）** | `{ at: ISO8601, checks: Record<string, unknown> }` | **16 项**实测检查（冻结键名）+ 规划要求的 `hostBridge`/`state`（Phase 2 追加）；单值失败编码为 `'ERR:<message>'` | ✅ `payload/selfcheck.js` |
| **日志通道（LogChannel）** | ① 进程 `stdout/stderr → <home>/payload/node.log`（组件原生行被过滤并计数）；② 载荷自有日志文件 `<HOME>/payload/app.log`；③ 读回：`/log` / `/diag` / `Logger.tail` | 「谁写谁读」：写入方必须提供读回；读失败返回占位串 | ✅ ①②③ 均已实现 |

---

## 5. 验收场景

> 每条给出可证伪判据。真机判定基线见规划 §D.8；host 侧复现见 `plan.md` §7。

### AC-004-001 只读直读加载成功（路线 ①）
- **Given** 载荷原样放在只读安装目录（`resfile/<app>/`），消费方给出入口绝对路径与载荷根
- **When** `NodeRuntime.start()` 后 Node 线程执行引导器
- **Then** 日志出现「载荷形态=只读直读」+ 入口绝对路径；**不出现**任何解包耗时行；入口 `require` 成功（观察点：载荷自己的首行日志 / 其监听端口可 `curl`）
- **判据**：零解包（日志无「解包」字样）、入口加载后运行期可读回（✅ C3）

### AC-004-002 `tar.gz` 首启解包 + 二次启动跳过
- **Given** 可写路线：给出 `archive` + `archiveSha256`，目标目录为空
- **When** 第一次启动 → 进程结束后第二次启动（同一 marker 文件）
- **Then** 第一次：日志含「归档 SHA-256 = …」「解压完成：N 个文件，耗时 T ms」「marker 已写入 …」「入口 = …」，且 marker 文件内容 = 期望哈希；第二次：日志含「产物已就位（marker 一致），跳过解压」且**不重写** marker（`mtime` 不变）
- **判据**：文件数 N 与归档清单一致；二次启动解包耗时 ≈ 0；入口复检通过（FR-004-006/008/018）

### AC-004-003 `require` 失败退 `import`（CJS/ESM 混用）
- **Given** 入口是纯 ESM（`export default` / `import`），或 CJS 顶层 `await`
- **When** 引导器解析入口
- **Then** 依次尝试 `require` → 命中 `ERR_REQUIRE_ESM`/`ERR_REQUIRE_ASYNC_MODULE`/`ERR_REQUIRE_CYCLE_MODULE` 之一 → 退 `import(pathToFileURL(abs).href)` 并成功；日志记录「require 失败（code=X）→ import」
- **判据**：入口模块副作用发生（探针文件被写/端口被监听）；**未**出现 `[bootstrap] FATAL`（FR-004-022/023）

### AC-004-004 入口不存在时的可见失败
- **Given** 载荷就位但入口四候选全不存在
- **When** 引导器执行
- **Then** 日志出现入口搜索列表与「入口不存在」文本，包含**四条候选的绝对路径**；进程不 abort；`/log` 能读回该行；`/facts` 的 `state`/载荷相关字段反映「未加载」
- **判据**：一条可截图/可 `curl` 的失败文本；`node::Start` 返回值不足以区分成功失败这一点在文档中已声明（FR-004-033/035）

### AC-004-005 异步未捕获异常不导致应用级 abort
- **Given** 载荷里 `setTimeout(() => { throw new Error('boom') })` 与 `Promise.reject(new Error('boom2'))`
- **When** 异常触发
- **Then** 应用进程存活（ArkWeb 页面不白屏、宿主 Ability 不重启）；载荷自有日志与 `/log` 里各出现一条含 `boom` / `boom2` 的 stack 文本
- **判据**：进程存活 + 两条日志可读回（FR-004-030/031/032/034；✅ §D.10 ⑱）

### AC-004-006 `/facts` 读回自检
- **Given** Node 已在真机起来（`--jitless` 或 ACL 生效两种组合）
- **When** `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts`
- **Then** `200` + JSON：`at` 为 ISO8601；`checks.node = "v24.2.0"`；有 ACL 时 `checks['wasm.validate'] = true`，`--jitless` 下为 `false` 且 `checks['wasm.error'] = "WebAssembly is not defined"`；`checks.versions.modules = 137`；`checks.homedir`/`checks.tmpdir` 落在沙箱内
- **判据**：这条 JSON 即「一次真机成功运行的证书」（🔶 §5.7）· ✅ §D.10（`wasm.available=true` / `wasm.validate=true`）

### AC-004-007 `/log` 读回日志尾
- **Given** `<home>/payload/node.log` 已写入多行（含崩溃记录 `CRASH sig=…`）
- **When** `curl -s http://127.0.0.1:15577/log`
- **Then** `200` + `text/plain`，内容为文件**尾部 ≤8192 B**（含最后一行）；HOME 缺失或文件不可读时返回占位串且仍为 `200`
- **判据**：读回内容与 ArkTS 侧 `Logger.tail(logPath, 8192)` 一致（✅ C3、S9；FR-004-036）

### AC-004-008 解包路径穿越被拒（安全）
- **Given** 构造的归档含条目 `../escaped.txt`、`/abs.txt`、符号链接条目 `link -> /etc/passwd`、超长路径（>100 B 名 + `L` 头）
- **When** 解包
- **Then** `../`、绝对路径、符号链接条目被拒绝/跳过并**逐条记日志**；目标根之外**不产生任何文件**（用 `fs.readdirSync(destRoot)` + 全盘抽查断言）；超长路径要么按 `L`/`prefix` 正确重建，要么**明确失败**（不允许静默截断成错误路径）
- **判据**：越界文件 0 个；日志条数 = 非法条目数（FR-004-014/015；⚠️ 源实现无此校验）

### AC-004-009 就绪幂等对「marker 命中但载荷被截断」的反应
- **Given** marker 内容 = 期望哈希，但入口文件被删/截断
- **When** 启动
- **Then** 日志 warn「marker 一致但入口缺失，强制重解包」→ 重新解包 → 复检通过 → 入口加载成功
- **判据**：不允许「marker 一致即成功」（FR-004-008；✅ `main.js:517-524`）

---

## 6. 非功能需求

| ID | 需求 | 判据 / 依据 |
|---|---|---|
| **NFR-004-001** | **首启时长与可观测**：可写路线单卷 156.6 MB（⇒ 884 MB / 27.2k 文件）的解包耗时必须可从日志读出（阶段打点：开始 / 完成 / 文件数 / ms）。目标：不劣于 🔶 旧壳同形态基线（Electron 环境首启到就绪约 **15 s**，其中 T+13 s 解压完 27,279 文件）；零解压路线应为 **0 s** 额外开销 | ⬜ 本工程未实测（P0-5 未做，§4.3 B8）· ✅ `pi-desktop-ark/docs/000-工程规划.md:176`（体积/文件数）· 🔶 `pi-desktop-hos/docs/真机验证记录.md:232,316` |
| **NFR-004-002** | **失败面可控**：每类失败都有唯一日志文本与明确处置（重试 / 跳过 / FATAL）；解包失败**不写 marker**、可安全重试；部分写入不得被当成功 | ✅ C2 · ⬜ 待实现（FR-004-011） |
| **NFR-004-003** | **内存占用**：解包全程内存与条目大小无关（header 缓冲 ≤512 B，数据随到随写）；禁止整包读入内存（压缩态 156.6 MB > 真机可用堆的合理余量） | ✅ `tar-extract.js:1-9` 的设计意图 · ⬜ 待真机验证 RSS 曲线（⬜） |
| **NFR-004-004** | **路径安全**：解包目标根之外零写入；拒绝 `..`/绝对路径/链接条目；载荷根自身必须显式给出、不接受隐式 cwd 推导 | ✅ `plan.md` §7 边界测试清单（FR-004-014/015） |
| **NFR-004-005** | **依赖面**：载荷侧只允许 Node **内置模块**（`zlib`/`fs`/`path`/`url`/`crypto`/`http`/`os`），**零 npm 依赖**（HAR 不带 `node_modules`） | ✅ `payload/README.md` 定位「纯 JS，不参与 ArkTS 编译」· ✅ §7.5（HAR 内容） |
| **NFR-004-006** | **真机可观测**（C6）：每个新能力都必须回答「怎么在真机上看见它」——落脚点 = `/facts`、`/log`、`node.log`、ArkTS `logs()`/`tail()`；位点必须含可 grep 的固定前缀（`[bootstrap]` / `[tar]` / `[selfcheck]`） | ✅ C6 · ✅ `selfcheck.js:83`、`bootstrap.js:17,62` 的既有前缀习惯 |
| **NFR-004-007** | **不新增启动参数**：本模块**不得**要求运行期追加 `execArgv`（`--expose-internals` 等必须由 `execArgv`/`flags` 在 `node::Start` 之前给定） | ✅ **C4** · ✅ `Types.ets:25`（`flags` 为一次性输入） |
| **NFR-004-008** | **不改上游产物**：入口兼容、`cwd` 适配必须靠引导器完成，**不得**要求给载荷或 `libnode.so` 打补丁 | ✅ **C7** · 🔶 §5.5 入口行（零补丁的等价手段是 `chdir` + 双通道加载） |

---

## 7. 假设与约束

| # | 假设 / 约束 | 证据 | 对本模块的影响 |
|---|---|---|---|
| A1 | **`process.cwd()` 在真机上恒为 `/`** | ✅ §D.8 偏差表 | 一切路径必须绝对；需要相对路径语义时靠 `process.chdir` 到载荷根（FR-004-024） |
| A2 | **`process.execPath` = `/system/bin/appspawn`** | ✅ §D.8 偏差表 | 不得用 execPath 重启 Node / 派生相对路径（FR-004-028） |
| A3 | **`os.cpus()` 长度 0**（返回空数组，不是报错） | ✅ §D.8 偏差表 | 解包并发度不得依赖 `os.cpus().length`；只能用固定小并发或纯串行 |
| A4 | **同 uid 同目录也读不到别人写的文件** | ✅ constitution C3（notes 硬约束 ④） | 「写入成功」的判据一律改为**最终使用者读一遍**：解包后必须由 Node 自己 `require`/`readFileSync` 复检；禁止 `statSync` 当成功判据（§8 P0-5 判据） |
| A5 | **进程内 Node 无优雅退出路径**（`node::Start` 一进程一次） | ✅ §4.4 · ✅ §5.2 | 引导器不得实现看门狗/重启；异常只能兜底 + 记录，不能靠「重启恢复」（C5） |
| A6 | **`link(2)` 不可用**（`EACCES`）；`symlink` 亦被拒 | ✅ §4.4 | marker 原子写用 `rename`；物化大载荷只能 copy + 解包（FR-004-009/015） |
| A7 | **`execArgv` 启动即固定** | ✅ §4.7 · ✅ C4 | 「ESM 入口需要额外 flag」不可行 ⇒ 只能靠 `import()` 动态加载（FR-004-022） |
| A8 | **`UV_USE_IO_URING=0` 与 `HOME/TMPDIR/NODE_OPTIONS` 由原生层在 `node::Start` 前写环境** | ✅ `node_bridge.c:142-149` | 本模块只**消费**与**断言**，不重复设置；`NODE_OPTIONS` 已被清空 ⇒ 载荷不得依赖它传递配置（FR-004-029） |
| A9 | **`node.log` 会被宿主原生输出污染**（`dup2` 把 fd1/fd2 指向同一文件） | ✅ §D.10 ⑱ · ⚠️ `node_bridge.c:185-188` | 载荷必须有自有日志通道（FR-004-032）；`/log` 的「噪音」不作为失败判据 |
| A10 | **只读安装目录里的文件可被 Node 直读**（`resfile` 路线的前提） | 🔶 §5.5 · ⬜ 本工程 P0-13 未做 | 路线 ① 需真机实测（`require` 全链）；未通过则退路线 ②（消费者风险 A1） |

---

## 8. 依赖

| 方向 | 依赖 | 交付内容 | 现状 |
|---|---|---|---|
| 上游 | **`001-runtime-core`** | `NodeRuntimeOptions` 的载荷相关字段（`entry`/`payloadRoot`/`archive`/`archiveSha256`/`argv`/`env`/`cwd`）、投递与状态机、`scriptPath` 指向本模块的 `bootstrap.js` | ⚠️ 部分：✅ `Types.ets:16-34` 只有 `flags`/`scriptPath`/`libDir`/`homeDir`/`logPath`；规划 §5.3 的载荷字段 ⬜ |
| 上游 | **`002-napi-bootstrap`** | 环境注入（`HOME`/`USERPROFILE`/`TMPDIR`/`TMP`/`TEMP`/`NODE_ENV`/`UV_USE_IO_URING`）、`argv` 构造（含 `scriptPath`）、stdout/stderr 落盘、崩溃记录、`node::Start` 返回值记录 | ✅ 骨架已闭环（`node_bridge.c:142-149,185-223`）；⬜ pipe + 独立 reader（⑱ 的原生侧） |
| 上游 | **`006-observability`** | 日志环（默认 500 行，`logRingSize`）、hilog 双通道、崩溃记录文件 `last-crash.json`、`Logger.tail(path, maxBytes)` | ⚠️ 部分：✅ `Logger.tail`（`Logger.ets:26-52`）、hilog；⬜ 日志环 / `lastCrash` |
| 上游 | **`003-host-bridge`** | `@fellow99/node-bridge/host` 内置模块（`host.invoke` / `host.handle('shutdown', …)`）；`/facts` 的 `hostBridge` 字段来源 | ⬜ 未实现（`bootstrap.js:44` 只在注释里描述形态，且写成 `.../bridge` 与规划 §5.3 的 `.../host` 名称不一致） |
| 下游 | **消费方 `pi-desktop-ark`** | 载荷内容与裁剪流水线（`102-payload-pipeline`）、投放时机（`resfile/pi-web/` 或 `tar.gz`）、首启加载页、`env` 传入的 `PI_*` 变量、探活与端口策略 | ✅ 部分：骨架期物化 `selfcheck.js`（`Constants.ets:18`）并轮询 `/facts`（`PROBE_ATTEMPTS=20`） |
| 下游 | **消费方载荷（`pi-web`/Next）** | 通过本模块契约获得的：绝对入口、`cwd`、`HOME`/`TMPDIR`、CJS/ESM 双通道、异常兜底 | ⬜ Phase 1 |

---

## 9. 明确不在本模块范围（防误引用）

| 事项 | 归属 |
|---|---|
| 端口随机化 / 单实例 / 探活退避 | 消费方（规划 §6.1、§6.2 第 1 条）；库只保证「服务在端上跑着」 |
| `--inspect` 调试通道与其 release 关闭 | 消费方（规划 §5.7） |
| 日志环容量与 hilog 级别选择 | `006-observability`（`logRingSize` 属 `001` 的类型面） |
| 沙箱外路径访问、系统文件选择器 | `003-host-bridge` 能力实现（消费方注册） |
| 载荷裁剪（四项）与首启加载页 | 消费方（`pi-desktop-ark` §7.2） |
