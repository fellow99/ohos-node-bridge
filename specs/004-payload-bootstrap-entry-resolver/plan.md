# 004-payload-bootstrap-entry-resolver —— 载荷引导 · 解包与入口解析（`plan.md`）

> - **对应规格**：[`spec.md`](./spec.md)（FR-004-001…040 / AC-004-001…009 / NFR-004-001…008）
> - **模块编号**：`004-payload-bootstrap-entry-resolver`（工程规划 §7.3 表项名 `004-payload-bootstrap`；Phase 1 范围内，§8）
> - **技术无关的「要什么」在 `spec.md`；本文只写「怎么做、为什么这么做、影响面」**
> - **证据标记**：✅ 本工程一手可复核 · 🔶 沿用外部/同型工程一手真机记录（本工程未复现）· ⬜ 待验证/待实现 · ⚠️ 冲突或风险
> - **本模块零 C / 零 ArkTS 代码**：仅 `payload/*.js`（纯 JS，Node 线程内运行）

---

## 1. 技术上下文

| 项 | 取值 | 依据 |
|---|---|---|
| 运行时 | **Node v24.2.0**（`process.platform='openharmony'`、`arch='arm64'`、`versions={v8 13.6.233.10-node.17, uv 1.51.0, modules 137}`） | ✅ `runtime.lock.json`（`active` 指向 `ohos-node-shared-v24.2.0`，SHA-256 `3019bf5f…51a1`）· ✅ §D.9 |
| 库版本要求 | `process.version ≥ 22.19.0`（低于则 warn，不静默） | 🔶 §5.8「版本要求」 |
| 语言 / 模块系统 | 纯 **CommonJS**（`'use strict'`）；不引入 TypeScript、打包器、转译器 | ✅ `payload/bootstrap.js:10-13`、`payload/selfcheck.js:13-17` 既有形态 |
| 允许的内置模块 | `zlib`（gunzip）、`fs`（流与同步写）、`path`、`url`（`pathToFileURL`）、`crypto`（`createHash('sha256')`）、`http`（自检端点）、`os`（快照/临时目录） | ✅ `payload/*.js` 现状 · 🔶 §5.5「谁解包」 |
| 明确不用 | `child_process`（§4.5 事件语义曾有互斥证据，且本模块无需子进程）、`worker_threads`、`net`/`tls`、任何 npm 包 | ✅ §4.5 · ✅ NFR-004-005（HAR 不带 `node_modules`） |
| 运行位置 | **Node 线程内**（引导阶段事件循环无并发任务 ⇒ 允许同步阻塞；解包不在 ArkTS 侧、不在 UI 线程） | ✅ §5.2「载荷解包」行 · ✅ §5.1 分层图第 407 行 |
| 启动参数形态 | `argv = ["node", <flags…>, <scriptPath>]`，由 002 组好；`--expose-internals` / `--no-verify-heap` 由消费方经 `flags` 一次性给定 | ✅ `library/src/main/cpp/node_bridge.c:194-216` · ✅ §5.3 `execArgv` · ✅ **C4** |
| 环境注入 | `UV_USE_IO_URING=0`、`HOME`/`USERPROFILE`、`TMPDIR`/`TMP`/`TEMP`、`NODE_ENV=production`、`unsetenv(NODE_OPTIONS)` —— 全部在 `node::Start` 之前 | ✅ `node_bridge.c:142-149` |
| stdio | fd1/fd2 `dup2` → `<filesDir>/payload/node.log`（`O_APPEND`） | ✅ `node_bridge.c:185-188` · ⚠️ ⑱ 要求改 pipe + 独立 reader（属 002） |
| 宿主侧可测 | 开发机 Node（≥22，实测工程用 22.17.0 亦可）+ 本机 `tar`/`zlib`；`tests/smoke-host.mjs` ⬜ Phase 1 | ✅ `tests/README.md`（host 侧门禁 ⬜） |
| 目标设备 | `2in1`/`tablet`；单核可用（`os.cpus()` 长度 **0**） | ✅ §D.8 偏差表 · 🔶 §5.10 ⑫ |
| 载荷量级（首个在册负载） | **884,167,367 B / ≈27.2k 文件** → `tar.gz` **156,592,393 B**；裁剪后预估 70–90 MB ⬜ | ✅ `pi-desktop-ark/docs/000-工程规划.md:176` |

---

## 2. 宪法合规检查（`specs/constitution.md`）

### 2.1 七条原则

| 条目 | 要求 | 本模块的落点 | 结论 |
|---|---|---|---|
| **C1 库 / 壳分离** | 库不得出现 `pi`/`pi-web`/`PI_*` 语义 | 本模块是**库侧分发物**（`payload/`）：入口探测、归档内顶层目录名、日志文案都必须与具体应用无关；应用变量只经消费方 `env` 传入 | ✅ 已修复（2026-10-17）：`payload/bootstrap.js` 的 `PI_WEB_ENTRY` 兼容别名**已删除**（入口只认 `NODE_BRIDGE_ENTRY`；契约 §3.1 同步删除该行） |
| **C2 不隐藏平台真相** | 失败必须可见（结构化错误 / 日志 / 状态机） | 每类失败有唯一文本 + 处置（本文 §6.3）；解包失败不写 marker；`chdir`/`HOME` 失败不得静默 | ✅ 满足（FR-004-011/025/026/033/039） |
| **C3 让最终使用者去读** | 「写成功」判据一律改为「最终使用者读一遍」；解包必须 Node 自己做；写日志必须有读回通道 | ① 解包者 = `zlib`+`fs`（Node 自己）；② 解包后**由 Node 复检**入口（`require`/`readFileSync`），禁止 `statSync` 当成功判据；③ 日志读回 = `/log` 端点 + `Logger.tail` | ✅ **本模块的核心约束**（FR-004-012/008/034/036） |
| **C4 启动参数不可事后修改** | `execArgv` 只能在 `node::Start` 前定死 | 本模块**不提供**任何追加参数路径；ESM 兼容只能靠 `import()`，不能靠新增 flag | ✅ 满足（NFR-004-007） |
| **C5 单例与不可重启** | 不做看门狗 / 自动重启；失败是终态 | 引导器不实现重启；`uncaughtException` 兜底只记录不恢复；失败文案指向「读日志 / 重启应用」 | ✅ 满足（FR-004-030/031/033） |
| **C6 诊断优先于修码** | 先建观测通道；判据必须真机可见 | `/facts`（能力证书）、`/log`（日志尾）、`node.log`、载荷自有日志；固定前缀便于 grep | ✅ 满足（NFR-004-006） |
| **C7 零上游补丁 / 二进制可替换** | 能用现成机制解决就不打补丁 | 入口兼容靠 `require`→`import()`；`cwd` 适配靠 `chdir`；解包自己实现（不引入 npm 依赖、不改载荷、不改 `libnode.so`） | ✅ 满足（NFR-004-008） |

### 2.2 代码规约

| 条目 | 与本模块的关系 | 结论 |
|---|---|---|
| **S1 ArkTS 严格模式 / `.d.ts` 接入原生模块** | 本模块是纯 JS，不经 ArkTS 编译；不得新增 `.ets`/`.d.ts` | ✅ 不适用（只需不越界） |
| **S2 barrel 唯一出口** | 本模块不新增 ArkTS 出口；若为载荷字段改 `Types.ets`，必须**同时**改 `library/Index.ets` 与 `specs/README.md` 编号表（§六 变更流程 1） | ⬜ 待 `001` 协同（§8 P1-11） |
| **S3 类型改动即破坏性变更** | `NodeRuntimeOptions` 增 `entry/payloadRoot/archive/archiveSha256/env/cwd` 属对外契约变更 | ⚠️ 必须与 `001` 同批 + 版本号提升 |
| **S4 路径一律绝对** | 所有路径来自显式绝对入参；`cwd`/`execPath` 仅进日志；需要相对语义时靠 `chdir` | ✅ 满足（FR-004-002/021/025/028） |
| **S5 信号上下文禁用 stdio** | 本模块日志**不在**信号上下文内（崩溃 handler 在 C 侧，属 002） | ✅ 不违反 |
| **S6 native 产物落点** | 不涉及（本模块零 native 产物） | ✅ 不适用 |
| **S7 引导件不链接 libnode** | 不涉及 | ✅ 不适用 |
| **S8 C 侧接口只有 3 个** | 不涉及（本模块不改 `.c`，不改 `.d.ts`） | ✅ 不适用 |
| **S9 日志双通道 + 读失败占位串** | `/log` 读失败返回 `(read failed: …)` 且不抛异常；载荷日志同时写 stdout（⇒ 进 `node.log`/hilog 通道） | ✅ 满足（FR-004-034/036） |
| **S10 二进制不入库** | `payload/*.js` 是纯文本 ⇒ 可入库；载荷本体（`tar.gz`/`pi-web` 产物）不入库，由消费方投放 | ✅ 满足（`.gitignore` 由消费方保证） |

---

## 3. 研究结论（关键取舍与依据）

### 3.1 为什么零解压优先
- **结论**：默认路线是 ①「载荷原样放 `resfile/<app>/`、Node 从只读安装目录直读」，只有在载荷**必须可写**时才走 ② `tar.gz` + Node 自解包。
- **依据**：🔶 同形态**在售**做法（`electerm-harmony` 的 `resfile/electerm/` 直读，规划 §5.10 ⑩）；✅ 免掉 27.2k 文件、884 MB 的首启解包耗时与失败面（✅ `pi-desktop-ark/docs/000-工程规划.md:176`）。
- **代价/反例**：路线 ① 需要「只读安装目录里的文件可被 Node 直读」成立；🔶 规划 §4.2 ④ 有同型证据，但**本工程 P0-13 未做**（⬜）⇒ 路线 ① 必须先真机实测 `require` 全链。
- **可写性边界**：只有缓存目录需要可写时，把缓存指向宿主可写目录（`env` 给出 `NEXT_*`/`TMPDIR` 之类），**不**为可写把整份载荷再解一份（🔶 §5.5）。

### 3.2 为什么解包必须由 Node 自己完成
- **结论**：解包器用 `zlib` + `fs` 在 Node 侧实现；**任何** OHOS/ArkTS 侧解压器写业务文件都禁止。
- **依据**：✅ **C3**（`specs/constitution.md:42-43`）+ ✅ §4.2 ④ + notes 硬约束 ④：**同 uid 同目录下也读不到别人写的文件**，症状是 `MODULE_NOT_FOUND` 且 `requireStack: []`（即「文件明明在，Node 就是读不到」）；`library/src/main/ets/util/Env.ets:47-49` 的注释同样记录该结论。
- **落地含义**：① 归档本体**可以**是 ArkTS 投放的（只读文件，Node 能读）；② 解出来的**业务文件**必须由 Node 写；③ 写完必须**由 Node 再读一遍**（`require` 入口 / `readFileSync` 抽样），不得用 `statSync` 判定成功（§8 P0-5 的判据原文）。

### 3.3 为什么幂等用 SHA-256 marker 而不是 mtime / 大小
- **结论**：marker 文件内容 = 归档的 SHA-256（64 位小写 hex），命中且入口复检通过才跳过解包。
- **依据**：🔶 旧壳 `main.js:499-500` 的注释是**一线教训**：「只比目录存在性 ⇒ 就地升级不生效，必须 `hdc uninstall` 重装」；旧壳因此改成「marker 内容 === 期望 SHA-256」并额外做入口复检（`main.js:517-524`）。
- **为什么不是 mtime**：源解包器**不恢复条目 mtime**（`tar-extract.js` 不调用 `utimes`），解出来的文件 mtime = 解包时刻 ⇒ 无法区分「两次解包」与「同一载荷」；用 mtime 判据还会要求「先 stat 全部 27.2k 文件」。
- **为什么不是大小**：内容变化不一定改大小（例如同长度替换）；大小只能证明「像」，不能证明「是」。
- **为什么 marker 与归档同目录**：`<payloadRoot>/<archive 基名>.sha256` 随目标目录一起清理，不污染归档内容（🔶 旧壳把 marker 写在 `<userData>/`，不写进 `pi-dist` 内，见 `main.js:44-45`）。
- **幂等的复检闭环**：marker 一致 **且** 入口可读 ⇒ 跳过；否则强制重解包（解压中途被杀会留下「看似完整」的树）。

### 3.4 为什么 `require` 失败要退 `import()`
- **结论**：`require(abs)` → 命中 `ERR_REQUIRE_ESM` / `ERR_REQUIRE_ASYNC_MODULE` / `ERR_REQUIRE_CYCLE_MODULE` 之一时退 `import(pathToFileURL(abs).href)`；其它错误码**照抛**。
- **依据**：✅ 旧壳 `main.js:581-592` 的同型实现（注释原文：「CJS `require`，必要时退 ESM 动态 `import`（Next 16 的 dist 仍有 CJS，但不做假设）」）；🔶 §5.5 入口行要求兼容 CJS/ESM 混用。
- **为什么不能只改载荷**：载荷由消费方维护（且可能来自上游 `next` 的产物），改上游 = 打补丁（违 C7）；`import()` 是 Node 现成机制。
- **为什么错误码要白名单**：若把 `MODULE_NOT_FOUND` 也拿去 `import()`，错误信息会变成误导性的 `ERR_MODULE_NOT_FOUND`，掩盖真正的「依赖缺失」（C2 要求如实上报）。
- **异步性代价**：`import()` 返回 Promise ⇒ 引导器的 ESM 分支必须是异步的（`await` 或 `.catch` 收口），否则一个新引入的 `unhandledRejection` 会绕过同步 `try/catch`（FR-004-023）。

### 3.5 为什么必须 `chdir`
- **结论**：可写/解包路线必须 `process.chdir(<载荷根>)`；只读路线若载荷依赖 `resolve(process.cwd(),'package.json')` 类约定同样需要。
- **依据**：✅ §D.8 偏差表：真机 `process.cwd() = /`「启动脚本**必须显式 `chdir`**（或全程绝对路径）——直接决定 `resolve(cwd,'package.json')` 类约定能否成立」；🔶 §5.5 入口行（先例为满足 `resolve(process.cwd(),'package.json')` 而 `chdir` 到载荷目录）。
- **为什么不是「给载荷传 `PWD`」**：`process.cwd()` 读的是内核 cwd，不是环境变量；`fs.resolve` 一类约定不会读 `PWD`。
- **为什么不是「改载荷」**：改载荷 = 打补丁（C7）；`chdir` 是现成机制，且**必须在加载入口之前**执行（模块顶层若读 `cwd` 就晚了）。

### 3.6 为什么顶层 `try/catch` 刻意**不** `process.exit`
- **结论**：同步 FATAL 只写 `[bootstrap] FATAL <stack>` 到 stderr/日志，保持进程存活（✅ `bootstrap.js:59-64` 既有取舍）。
- **依据**：进程内 Node 与宿主**共享同一进程**（`001` 单例、`002` detached 线程）；`process.exit` 会连带终止宿主进程与 ArkWeb 渲染进程 ⇒ 「一个载荷脚本错误 = 整个应用被杀」。§D.10 ⑰ 的实测事故（未捕获异常 ⇒ 整个 App abort）正是要避免的形态。
- **代价（必须写进文档，不能假装没有）**：
  1. **`node::Start` 返回值不足以区分成功/失败**：主脚本正常返回也会让 `node::Start` 返回 0（✅ `node_bridge.c:220-223` 只记录 rc）。⇒ 失败判据必须落在**日志文本 + `/facts`** 上。
  2. **主脚本返回且无 pending handle ⇒ Node 事件循环空转结束、Node 线程退出**（⬜ 待真机确认该形态的 `isRunning()` 行为；规划 §5.2 的观察是「`node::Start` 直到进程结束才返回」，那是**服务端载荷**持续占住事件循环的情形）。⇒ 引导器在「无载荷可加载」时**必须留一条可见证据**，不能静默返回（FR-004-004/§6.3）。
  3. 因此：**不允许**把「Node 起来了」判定为「应用能跑」；就绪判定仍归消费方（端口探活，§6.1）。

### 3.7 为什么解包器是「流式状态机」而不是 `gunzipSync` 全量
- **结论**：`fs.createReadStream` → `zlib.createGunzip` → 512 B header 状态机 → 文件数据随到随写（移植并加固 `pi-desktop-hos/src-main/tar-extract.js`，214 行）。
- **依据**：✅ 该文件头注释记录了**旧实现的真实故障**：「号称流式，却要求把整个 tar 条目连续缓冲进一块 `Buffer` 后才落盘（`if (buf.length < paddedEnd) break`），每收到一个 gunzip chunk 都 `Buffer.concat` 全量复制 → 对超大条目退化为 O(n²) 内存拷贝，真机单核 100% 且永不结束」。
- **量级对照**：本载荷压缩态 156.6 MB、展开态 884 MB（✅ `pi-desktop-ark/docs/000-工程规划.md:176`）⇒ 全量方案要么 156.6 MB 输入缓冲 + 884 MB 输出缓冲，要么 O(n²) 复制，两条都不可接受（NFR-004-003）。
- **移植时必须补的四件事**（源头没有）：① 路径穿越 / 绝对路径 / 空名校验（⚠️ `tar-extract.js:21-44` 无任何校验）；② `L`/`x`/`g` 头处理（源头把 `L`/`x` 当 skip ⇒ 长路径条目名被静默截断）；③ 顶层目录名前缀参数化（源头硬编码 `pi-dist/`，违 C1）；④ 逐条非法条目日志 + 计数（C2）。

---

## 4. 数据模型

### 4.1 `env()` 返回对象（环境快照）

| 字段 | 类型 | 真机期望值 | 用途 / 约束 | 现状 |
|---|---|---|---|---|
| `home` | string | `<filesDir>`（沙箱内，可写） | 一切沙箱路径的根；缺失 ⇒ 抛错 | ✅ `bootstrap.js:21-24` |
| `cwd` | string | `/` | **仅进日志**，禁止用于拼路径 | ✅ `:27` |
| `execPath` | string | `/system/bin/appspawn` | **仅进日志**，禁止用于重启 | ✅ `:28` |
| `platform` | string | `openharmony` | 版本/能力分支判据 | ✅ `:29` |
| `arch` | string | `arm64` | 同上 | ✅ `:30` |
| `node` | string | `v24.2.0` | 版本矩阵判据（≥22.19.0） | ✅ `:31` |
| `modules` | string | `137` | 原生模块 ABI 判据 | ✅ `:32` |
| （Phase 1 新增）`tmpdir` | string | `<filesDir>/tmp` | 写-读回探针 + `/facts` | ⬜ FR-004-027 |
| （Phase 1 新增）`sandboxOk` | boolean | `true` | `home`/`tmpdir` 均在沙箱前缀下的断言结果 | ⬜ FR-004-027 |

### 4.2 `NodeRuntimeOptions` 中与载荷相关的字段

| 字段 | 规划 §5.3 语义 | 现状（`library/src/main/ets/runtime/Types.ets:16-34`） | 归属 |
|---|---|---|---|
| `entry` | 入口 JS：相对 `payloadRoot` 的路径，或绝对路径 | ⬜ 不存在（现有 `scriptPath: string` 是**引导脚本**路径，语义不同） | `001` + 本模块消费（§8 P1-11） |
| `payloadRoot` | Node 可写根，默认 `<filesDir>/node-bridge/payload` | ⬜ 不存在 | `001` |
| `archive` | 载荷 `tar.gz`：资源名（rawfile）或真实路径；**给出即自解包** | ⬜ 不存在 | `001` |
| `archiveSha256` | 幂等 marker 判据；缺省则由库计算一次并落盘记下 | ⬜ 不存在 | `001` + 本模块消费（FR-004-007） |
| `argv` | 传给 Node 的 `argv`（默认 `['node', <entry abs>]`） | ⬜ 不存在（`002` 的 C 侧自组 argv：`node <flags…> <scriptPath>`） | `001`/`002` |
| `env` | 合并进进程环境（`HOME`/`TMPDIR`/`PI_*`/`NO_PROXY`…） | ⬜ 不存在（`002` 只注入固定项） | `001`/`002` |
| `cwd` | 默认 `payloadRoot` | ⬜ 不存在 | `001` + 本模块执行 `chdir` |
| `logRingSize` | 日志环容量，默认 **500 行** | ⬜ 不存在 | `006`/`001` |
| `flags` | 启动参数（一次性） | ✅ `:25`（默认 `--no-verify-heap`） | `001` |
| `libDir`/`homeDir`/`logPath` | 运行时/沙箱/日志位置 | ✅ `:28-33` | `001` |
| `scriptPath` | **引导脚本**绝对路径（= `payload/bootstrap.js`） | ✅ `:26-27` | 消费方传 |

### 4.3 `/facts` JSON schema（完整字段表）

顶层：`{ "at": "<ISO8601 字符串>", "checks": { … } }`；`checks` 的每个值失败时编码为 `"ERR:<message>"`（骨架的 `safe()` 口径，✅ `selfcheck.js:22-28`）。

| 键 | 含义 | 真机期望值 / 判定基线 | 现状 |
|---|---|---|---|
| `at` | 响应时刻 | ISO8601（⚠️ 与 `checks` 的**采集时刻**不同——见 4.7） | ✅ `:63` |
| `node` | `process.version` | `"v24.2.0"` | ✅ `:30` |
| `platform` | `process.platform` | `"openharmony"` | ✅ `:31` |
| `arch` | `process.arch` | `"arm64"` | ✅ `:32` |
| `execArgv` | `process.execArgv` | ACL 生效：`["--no-verify-heap"]`（+ 可能的 `--expose-internals`）；`--jitless` 路线：含 `"--jitless"` | ✅ `:33` · ✅ §D.10 |
| `versions` | `process.versions` | `modules="137"`、`uv="1.51.0"`、`v8="13.6.233.10-node.17"` | ✅ `:34` · ✅ §D.9 |
| `homedir` | `os.homedir()` | 沙箱内（= 注入的 `HOME`），**不是** `/storage/Users/currentUser` | ✅ `:35` · ✅ §4.2 ⑥ · ⬜ 无沙箱断言（FR-004-027） |
| `tmpdir` | `os.tmpdir()` | `<filesDir>/tmp` | ✅ `:36` · ⬜ 无断言 |
| `netifaces` | `Object.keys(os.networkInterfaces())` | 含 `lo`（loopback 存在） | ✅ `:37` · ✅ §D.8 结论 3 |
| `cpus` | `os.cpus().length` | **`0`**（不得据此算并发） | ✅ `:38` · ✅ §D.8 偏差表 |
| `wasm.validate` | `WebAssembly.validate(<8B wasm>)` | ACL 生效 `true`；`--jitless` `false` | ✅ `:40` · ✅ §D.10（`wasm.available=true`、`wasm.validate=true`） |
| `wasm.error` | `typeof WebAssembly === 'undefined' ? 'WebAssembly is not defined' : ''` | `--jitless`：非空串；正常：`""` | ✅ `:41` |
| `fs_write_readback` | 写→读回比对（`os.tmpdir()/selfcheck.txt`） | `"OK"`（谁写谁读） | ✅ `:43-49` · ⚠️ 固定文件名 + 字符串拼接（见 §7.2 E17） |
| `hotloop_ms_5rounds` | 5 轮 2e6 次整数热循环耗时 | `--jitless` ≈**300 ms**（✅ 299/296 ms 实测）；JIT ≈ 1/9（✅ §D.10 热循环 6–9 ms/2e6 ⇒ 约 30–45 ms / 5 轮） | ✅ `:51-58` · ✅ §D.8/§D.9/§D.10 |
| `hostBridge` | 宿主桥是否已注册/可用 | 规划 §5.7 要求字段；`003` 落地后填 `{registered:[…]}` 或 `"ERR:…"` | ⬜ **Phase 2 追加**（`006/core` 不消费该键；`/diag` 里有 `hostBridge` 的只读快照） |
| `state` | 运行时状态（`starting`/`running`/…） | 规划 §5.7 要求字段；载荷侧只能上报「引导阶段完成/未完成」 | ⬜ **缺失**（真正的状态机在 ArkTS 侧） |
| `wasm.available` | 是否可用 WASM | §D.10 的验收口径用到该字段（`wasm.available=true`）；等价信息现在只能从 `wasm.error` 推 | ⬜ **缺失**（建议补，保持与实证口径一致） |
| `spawn` | `spawn('/system/bin/sh',['-c','echo ok'])` 三事件是否齐全 | ✅ §D.8 已实测「完整可用」 | ✅ 已实现（`payload/selfcheck.js` 的 `spawn` 项；`/facts` 16 键冻结，与 README 一致） |
| （Phase 1 建议新增）`payload` | 载荷形态与就绪信息 | `{mode:'resfile'|'archive'|'none', entry, marker, files, unpackMs}` | ⬜ 供 AC-004-001/002 断言 |

### 4.4 幂等 marker 文件布局与命名规则（**2026-10-17 改为冻结契约口径**：`.ready-<sha12>`）

```
<payloadRoot>/
├── .ready-<sha256 前 12 位>       # marker：JSON {sha256(完整), files, bytes, skipped, at}
├── .ready-<sha256 前 12 位>.tmp.<pid>  # 原子写中间态（rename 前；崩溃残留 ⇒ 下次启动清理）
└── <sha256 前 12 位>/             # 解包目标目录（见 4.5）
```

> 本节原写 `<archive 基名>.sha256`（旧壳先例）；**冻结契约 §3.2 从 Phase 1 起就是
> `<payloadRoot>/.ready-<sha256 前 12 位>`**（目标目录 = `<sha256 前 12 位>`），实现与
> `tests/payload/idempotency.test.mjs` 均按契约口径断言 ⇒ 文档已对齐契约，不再要求「归档基名」形式。

| 规则 | 内容 | 依据 |
|---|---|---|
| 命名 | `.ready-<sha256 前 12 位>`（如 `<payloadRoot>/.ready-4f3a2b1c9d8e`） | ✅ 冻结契约 §3.2 · `payload/bootstrap.js` |
| 内容 | JSON：完整 `sha256`（小写 hex）+ `files` + `bytes` + `skipped`（跳过的条目数）+ `at` | ✅ 契约 §3.2 / §3.7 |
| 写时机 | 解包**全部完成**之后（入口复检由下次启动 `resolveEntry` 承担） | ✅ `ensurePayload()` |
| 原子性 | 写 `<marker>.tmp.<pid>` → `renameSync`；**不用** `link(2)`（真机 `EACCES`） | ✅ |
| 期望值来源 | 入参 `archiveSha256`；缺省用实算值并 `warn`（tar 变化会触发重解压） | ✅ |
| 命中后行为 | marker 存在 **且** 目标目录存在 ⇒ **跳过**并打印 `[bootstrap] payload ready (skip)` + marker 内容 | ✅ 契约 §3.2 |
| 清理 | 缺 marker 但目录存在 ⇒ `rm -rf` 目标目录后重解包（宁可重做也不留半成品） | ✅ |
| 不使用 | 目录存在性单独判定 / 大小 / mtime / inode | ✅ FR-004-006 |

### 4.5 解包目标目录布局

```
<payloadRoot>/<sha256 前 12 位>/
├── package.json                     # 载荷根（若归档含）；chdir 目标
├── node_modules/…                   # 约 27.2k 文件（✅ 量级）
├── <剥离后的条目路径…>
└── （无 marker —— marker 在 <payloadRoot> 层，避免污染载荷内容）
```

| 规则 | 内容 |
|---|---|
| 顶层目录前缀剥离 | ⬜ 未实现（FR-004-017）：当前按归档内条目原路径落盘，未按调用方参数剥离归档顶层目录名（库侧也不得硬编码应用名） |
| 条目名归一化 | 去掉前导 `./`；拒绝 `..`/绝对路径/空名（FR-004-014）；`prefix[155]` 与 `name` 拼接 |
| 目录条目 | `mkdirSync(recursive)` 幂等 |
| 文件条目 | 先 `mkdir -p(dirname)`；`open(w)` 直写（同一路径重复出现 ⇒ 后写覆盖，与 `tar` 语义一致） |
| 权限 | 不恢复 `mode`/`mtime`（省 27.2k 次 `chmod`/`utimes`；文件默认 0644） |
| 链接/设备/FIFO/pax 头 | 一律**跳过 + 日志 + 计数**（`skipped` 随结果回 marker，解包树不完整可审计） |
| 归档结束 | 结束块必须**整块 512 B 全 0**；「首字节 0、其余非 0」= 畸形头 ⇒ **抛错**（不得静默截断归档，C4） |
| 目标根 | 由 `payloadRoot` 决定（`<sha256 前 12 位>` 子目录）；写入前 `mkdirSync(recursive)` |

### 4.6 日志文件路径与轮转 / 上限约定

| 通道 | 路径 | 写入者 | 上限 / 轮转 | 读回 |
|---|---|---|---|---|
| 进程 stdout/stderr | `<filesDir>/payload/node.log` | 原生层 pipe + reader（✅ `node_bridge.c` `stdio_reader()`） | `O_APPEND` 追加；**无轮转**（上限策略归 `006`）；✅ 含 `arkweb/chromium_ext`/`chromium` 的组件行被**过滤**并报丢弃计数（C1） | `/log` 端点（尾 8192 B）· ArkTS `Logger.tail(path, 8192)` ✅ |
| 载荷自有日志（Phase 1 新增） | `<filesDir>/payload/app.log` | 本模块（同步 `appendFileSync` 或持有 fd） | 追加；建议单条上限 8 KB、文件上限由 `006` 定 | 同上（`/log?src=app` 或第二个端点 ⬜ 待定） |
| 崩溃记录 | `<filesDir>/node-bridge/last-crash.json` | `002` 崩溃 handler | 覆盖写（只留最近一次） | ArkTS `lastCrash()`（⬜ `001` 未实现） |
| 日志环 | 内存（ArkTS/原生） | `002`/`006` | `logRingSize` **默认 500 行**（✅ §5.3） | ArkTS `logs()` ⬜ |
| 自检端点 | `http://127.0.0.1:${SELFCHECK_PORT:-15577}` | `selfcheck.js` | 无状态、每次请求重新读文件 | `curl` |

> **口径**：`/log` 只读 `node.log`（含原生层注入的 `CRASH sig=…` 与引导器行），**不**做聚合、不做格式化——保持「原始字节尾部」语义，便于与 ArkTS `Logger.tail` 对照（C3）。

### 4.7 时序与一致性注意事项

- `at` 是**响应时刻**，`checks` 是**脚本启动时刻**的快照 ⇒ 两者时间差不可见。建议补 `checksAt`（⬜），否则「热循环/写回」这类有时序意义的判据无法归因（⚠️ 现状缺陷，见报告）。
- `/facts` 的检查在模块加载期一次性执行（✅ `selfcheck.js:30-58`）⇒ 同一进程内多次 `curl` 结果恒定；这是「证书」语义（🔶 §5.7）而非监控语义——监控归消费方。

---

## 5. 接口契约

### 5.1 本模块提供

**（a）`payload/bootstrap.js` 的输入（环境变量 + 约定路径）**

| 变量 / 输入 | 谁设 | 现状 | Phase 1 目标 |
|---|---|---|---|
| `HOME` / `USERPROFILE` | `002`（原生层） | ✅ 注入；引导器断言非空 | 保持 + 沙箱前缀断言（FR-004-027） |
| `TMPDIR` / `TMP` / `TEMP` | `002` | ✅ 注入 | 保持 + 写-读回探针 |
| `NODE_ENV=production`、`UV_USE_IO_URING=0`、`NODE_OPTIONS`（清空） | `002` | ✅ | 保持（载荷不得改） |
| `PI_WEB_ENTRY` | ~~消费方（应用语义）~~ | ✅ **已删除（2026-10-17）**：库侧不得解释 `PI_*`（C1 / FR-004-020）⇒ 入口只认 `NODE_BRIDGE_ENTRY`；消费方这类值走 `options.env`（在 `NODE_BRIDGE_*` 之后应用，仍可覆盖） | ✅ 符合 FR-004-020 |
| `NB_PAYLOAD_ROOT` / `NB_ARCHIVE` / `NB_ARCHIVE_SHA256` / `NB_CWD` | `001`/消费方 | ⬜ 不存在 | 与 `options.*` 二选一，显式传入优先 |
| `SELFCHECK_PORT` | 消费方/探针 | ✅ `selfcheck.js:19`（默认 15577） | 保持；发布构建须能关闭自检端口（FR-004-040） |

**（b）`payload/selfcheck.js` 的 HTTP 端点**

| 方法 | 路径 | 状态码 | `Content-Type` | 响应体 | 依据 |
|---|---|---|---|---|---|
| GET | `/facts` | 200 | `application/json` | `{at, checks{…}}`（16 个冻结键，见 4.3） | ✅ `payload/selfcheck.js` |
| GET | `/log` | 200 | `text/plain` | `node.log` 尾 ≤8192 B；读失败 → `(read failed: <msg>)` | ✅ `payload/selfcheck.js` |
| POST | `/rport` | 200 | `text/plain` | 请求体原文转发到 `127.0.0.1:${RPORT_PORT}`（缺省 19999） | ✅ `payload/selfcheck.js` |
| GET | `/diag` | 200 | `application/json` | `{at, lastError, appLogTail, hostBridge}` | ✅ `payload/selfcheck.js` |
| — | 其它 | 404 | `text/plain` | `not found` | ✅ |
| — | 监听地址/端口 | — | — | `127.0.0.1:${SELFCHECK_PORT:-15577}` | ✅ `:82-84` |
| GET | `/facts` 的 `checks` 扩展键名 | — | — | `payload`（形态/入口/文件数/耗时，⬜ 建议） | AC-004-001/002 需要 |

### 5.2 本模块消费（Node 侧 API 面）

| 消费项 | 用途 | 约束 |
|---|---|---|
| `process.env` | 读 `HOME`/`TMPDIR`/消费方变量 | 只读；不得 `delete`/覆盖库侧强制项（FR-004-029） |
| `process.cwd()` | **仅日志** | 真机 `=/`；禁拼路径（S4） |
| `process.execPath` | **仅日志** | 真机 `=/system/bin/appspawn`；禁用于重启 |
| `process.stdout.write` / `stderr.write` | 日志落 `node.log` | 同步写入；不得依赖 `console` 颜色/格式 |
| `process.on('uncaughtException'/'unhandledRejection')` | 异常兜底 | 处理器内不得再抛（FR-004-030/031） |
| `process.chdir` | 载荷根工作目录 | 目标必须先校验（FR-004-024/025） |
| `fs.*`（`createReadStream`/`openSync`/`writeSync`/`mkdirSync`/`renameSync`/`readFileSync`/`existsSync`/`statSync`） | 解包与读回 | `renameSync` 做原子写；**`linkSync` 不可用** |
| `zlib.createGunzip` | 解压 | 流式；错误事件必须收口 |
| `crypto.createHash('sha256')` | 归档哈希（流式 update） | 🔶 旧壳 `main.js:455-463` 同型 |
| `http.createServer` | 自检端点 | 必须处理 `error` 事件（FR-004-039） |
| `os.homedir()`/`tmpdir()`/`cpus()`/`networkInterfaces()` | `/facts` | `cpus().length = 0` 是**正常值** |
| `url.pathToFileURL` | ESM 兜底 | 必须传绝对路径（FR-004-021/022） |

### 5.3 事件协议

**（a）顶层异常捕获协议（载荷侧）**

| 触发点 | 处理器 | 输出 | 是否终止 |
|---|---|---|---|
| 同步（`main()` 内 throw） | 顶层 `try/catch` | `[bootstrap] FATAL <stack>` → stderr（⇒ `node.log`）+ `app.log` | **否**（刻意不 `exit`） |
| 异步 throw / 回调内 throw | `process.on('uncaughtException')` | `[bootstrap] UNCAUGHT <stack>` → `app.log` + `node.log`；计数器 +1 | **否** |
| 未处理 Promise | `process.on('unhandledRejection')` | `[bootstrap] UNHANDLED <reason>`（含 stack 若可） | **否** |
| ESM 入口加载失败 | `import()` 的 `await`/`.catch` | 复用同步 FATAL 通道（不得泄漏成 unhandledRejection） | 否 |
| 解包失败 | 解包器 `reject` | `[tar] 解包失败 stage=<…> written=<n>` | 否（marker 不写，下次重试） |

**（b）原生层 `node::Start` 返回值协议（跨模块事实，消费方判据据此写）**

| `rc` | 可能含义 | 载荷侧伴随证据 | 消费方应如何判定 |
|---|---|---|---|
| `0` | ① 主脚本正常返回；② 载荷同步/异步异常但被兜底（主脚本返回）；③ 事件循环空转结束 | 日志里**没有** FATAL/UNCAUGHT | **不能**判成功；须靠端口探活（§6.1） |
| `0` + 日志含 `FATAL` | 引导失败但进程被保留 | `[bootstrap] FATAL …` | 判「载荷引导失败」→ 进失败态 UX（读日志 / 提示重启应用） |
| `≠0` | 已见 `node_bridge.c:220-223` 只记录、未定义语义；须实测（⬜） | `[node_bridge] node::Start returned rc=…` | 判「Node 已退出」；结合 `isRunning()===false` |

> 结论：**「Node 起来了」的判定权不在本模块**（规划 §6.1：消费方轮询端口）。本模块的职责是让每一步都留下可读文本（C2/C6）。

---

## 6. 实现策略

### 6.1 架构模式

```
payload/
├── bootstrap.js      # 唯一入口（消费方 scriptPath 指向它）：环境快照 → 载荷就绪 → 入口解析 → 加载
├── tar-extract.js    # 纯解包器（无应用语义、可单测、依赖注入 fs/zlib/path）⬜ 待移植加固
└── selfcheck.js      # 自检（独立运行；不 import bootstrap，避免相互污染）
```

- **无框架、无依赖注入容器**：`bootstrap.js` 只 `require('path'|'fs'|…)` + `require('./tar-extract.js')`。
- **依赖注入用于可测性**：`extractTarGz(archive, dest, deps = {fs, zlib, path})`，host 侧可注入假 fs 做失败路径测试（🔶 源实现已如此，保持）。
- **文件数上限纪律**：`bootstrap.js` 目标 ≤ ~200 行；超了才考虑拆 `loader.js`（入口解析）/`marker.js`（幂等）——否则宁可长一些也不增加文件（分发的成本在消费方拷贝）。
- **数据流**：`env() → readiness(archive?) → entryResolve() → chdir → load(cjs|esm) → （应用逻辑接管）`；每一步输出固定前缀日志（`[bootstrap]`/`[tar]`）。

### 6.2 关键算法

#### 6.2.1 USTAR 块解析状态机

`header(512) → data(size) → padding((512 - size%512)%512) → header …`，遇零块终止。

| 字段 | 偏移 | 长度 | 解析方式 | 备注 |
|---|---|---|---|---|
| `name` | 0 | 100 | C 字符串（首个 `\0` 截断，UTF-8） | 与 `prefix` 拼接 |
| `mode` | 100 | 8 | 八进制 | **忽略**（不 chmod） |
| `size` | 124 | 12 | 八进制（`parseInt(s, 8)`，空白填充） | ⚠️ GNU base-256（首字节 `&0x80`）须显式拒绝或解码，不得当 0 |
| `mtime` | 136 | 12 | 八进制 | **忽略**（不做幂等判据、不恢复） |
| `checksum` | 148 | 8 | 八进制 | 建议校验：header 损坏 ⇒ 立即失败而非写出垃圾 |
| `typeflag` | 156 | 1 | ASCII | 见下表 |
| `magic` | 257 | 6 | `ustar\0` / `ustar  ` | 可用于识别格式（不强制） |
| `prefix` | 345 | 155 | C 字符串 | USTAR 长路径；与 `name` 以 `/` 拼接 |

| `typeflag` | 语义 | 本模块处置 |
|---|---|---|
| `'0'` / `'\0'` / `''` | 普通文件 | 写文件（路径校验后） |
| `'5'` | 目录 | `mkdir -p`（Set 去重） |
| `'L'` | GNU long name | **缓冲其载荷**（= 下一条目的名字），长度上限（如 4096 B）内有效；超限 ⇒ 明确失败。⚠️ 源头把 `L` 当 skip ⇒ 名字被静默截断 |
| `'x'` | pax extended header | 解析 `path=<值>` 记录（格式 `<len> key=value\n`），应用到下一条目；其它键忽略。⚠️ 同上 |
| `'g'` | pax 全局头 | 跳过（记录一条日志） |
| `'1'` / `'2'` | 硬链接 / 符号链接 | **跳过载荷**，日志 `skip link name=…`；绝不创建链接 |
| `'3'`/`'4'`/`'6'`/其它 | 字符/块设备、FIFO、未知 | 跳过 + 日志 |
| 两个连续零块 | 归档结束 | `finished = true`，忽略其后字节（允许尾部填充） |

**不变式**：① `carry` 缓冲 ≤ 512 B（只可能是 header 残片或 padding 残片）；② 文件数据**随到随写**，不按条目大小分配内存；③ 每条目消费字节数 = `512 + size + padding`；④ `finish()` 时若 `state !== 'header'` 或 `carry.length > 0` ⇒ 抛「tar 数据不完整」（截断包必须失败，不得当成功）。

#### 6.2.2 `gunzipSync` + 同步写 vs 流式写

| 方案 | 峰值内存 | 阻塞 | 适用性 |
|---|---|---|---|
| A. `readFileSync` + `gunzipSync` + 纯同步解析写盘 | 压缩态 156.6 MB **+** 展开态 884 MB（要么全量、要么分块 `zlib.inflateSync` 手工喂） | 全程阻塞（引导阶段无并发任务 ⇒ 阻塞本身可接受） | ❌ 用于发布路径（NFR-004-003） |
| B. `createReadStream` → `createGunzip` → 状态机 → 随到随写 | 常数级（读块 highWaterMark + 512 B header + 目录 Set） | 逐块回调；写用 `fs.writeSync`（同线程同步写） | ✅ **发布路径唯一选择**（NFR-004-003） |
| C. B 的「同步版」：host 侧小载荷单测可用 | 常数级 | 全阻塞 | ✅ 仅 host 测试（小 tar.gz）简化实现 |

**结论**：发布路径用 B；A/C 只允许出现在 host 侧测试与开发自检里。**决定因素是内存而非阻塞**（引导阶段没有其他任务需要事件循环，`selfcheck` 也还没起来）。

#### 6.2.3 幂等判定流程（编号步骤）

1. `archive` 为空 ⇒ **不解包**，直接进入口解析（只读直读路线 / 目标目录已存在）。
2. `archive` 不存在 ⇒ warn `[tar] 归档缺失 path=…`；若目标目录已存在则继续（可能上一次已解好），否则进「入口缺失」可见失败路径。
3. 取期望哈希：`archiveSha256` → `<archive>.version` → 本地流式计算（warn）。
4. 读 marker：文件不存在 / 内容不匹配 `^[0-9a-f]{64}$` ⇒ 视为缺失（warn 仅第二种）。
5. marker ≠ 期望 ⇒ 日志「marker 与当前归档不一致（升级或换包），重新解包」→ 跳到 7。
6. marker === 期望 ⇒ **入口复检**（`existsSync` + `require` 试加载或 `readFileSync` 抽样）：通过 ⇒ 日志「产物已就位（marker 一致），跳过解包；entry=…」→ 返回入口（结束）；失败 ⇒ warn「marker 一致但载荷不完整，强制重解包」→ 7。
7. 清理目标目录（`rm -rf`，保留 marker 文件本身）→ `mkdir -p` 目标根。
8. 解包：`createReadStream → createGunzip → 状态机`；期间每 2000 个文件输出一行进度；失败 ⇒ 不写 marker、保留半成品、输出 `stage` 与已写条数（第 9 步不执行）。
9. 解包完成 ⇒ **入口复检**（同 6）⇒ 通过则原子写 marker（tmp → rename）并输出「文件数 N / 耗时 T ms / marker / entry」；复检失败 ⇒ 不写 marker，报错（下次启动重来）。

伪代码（关键分支）：

```js
function ensurePayload(opt) {                       // 同步；引导阶段无并发任务
  if (!opt.archive) return { mode: 'resfile' };     // 路线 ①：零解压
  const expected = expectedHash(opt);               // ①入参 ②.version ③本地算
  if (!fs.existsSync(opt.archive)) { warnMissing(); return maybeExisting(); }
  if (readMarker(opt.marker) === expected) {
    const entry = probeEntry(opt);                  // 入口复检（读到才算）
    if (entry) { log('产物已就位（marker 一致），跳过解包；entry=' + entry); return { mode: 'archive', entry, skipped: true }; }
    warn('marker 一致但载荷不完整，强制重解包');
  }
  rmrf(opt.dest); mkdirp(opt.dest);
  const files = extractTarGz(opt.archive, opt.dest, { stripPrefix: opt.stripPrefix }); // 失败 ⇒ 不写 marker
  const entry = probeEntry(opt); if (!entry) throw new Error('解包完成但入口仍不可读：' + opt.dest);
  atomicWrite(opt.marker, expected);                // tmp + renameSync
  return { mode: 'archive', entry, files, unpackMs: Date.now() - t0 };
}
```

#### 6.2.4 入口解析决策树

```js
function resolveEntry(opt, payload) {
  const candidates = [];
  if (opt.entry) candidates.push(path.resolve(opt.payloadRoot || payload.root, opt.entry)); // ① 显式
  if (process.env[opt.entryEnvName]) candidates.push(path.resolve(process.env[opt.entryEnvName])); // ② 中立变量名
  candidates.push(path.join(payload.root, 'app', 'index.js'));                             // ③ 约定
  const pkg = path.join(payload.root, 'package.json');                                     // ④ package.json main
  if (fs.existsSync(pkg)) { try { const m = JSON.parse(fs.readFileSync(pkg,'utf8')).main;
      if (typeof m === 'string' && m) candidates.push(path.resolve(payload.root, m)); } catch (e) { warn('package.json 解析失败：' + e.message); } }
  const list = candidates.filter(p => path.isAbsolute(p));                                  // 绝对路径硬校验（S4）
  const hit = list.find(p => fs.existsSync(p));
  if (!hit) { log('入口不存在；候选（' + list.length + '）：\n  ' + list.join('\n  ')); return null; }
  log('入口 = ' + hit); return hit;
}

async function loadEntry(abs) {                       // 返回 Promise（ESM 分支必须可 await）
  try { return require(abs); }
  catch (err) {
    if (['ERR_REQUIRE_ESM','ERR_REQUIRE_ASYNC_MODULE','ERR_REQUIRE_CYCLE_MODULE'].includes(err.code)) {
      log('require 失败（code=' + err.code + '）→ import(' + pathToFileURL(abs).href + ')');
      return import(pathToFileURL(abs).href);         // 调用方 await / .catch ⇒ 不泄漏 unhandledRejection
    }
    throw err;                                        // 其它错误码如实上报（C2）
  }
}
```

`chdir` 插在 `loadEntry` **之前**（模块顶层代码读 `cwd` 才有效），目标 = `opt.cwd || payload.root`，先 `statSync().isDirectory()` 校验。

### 6.3 错误处理（失败面 → 可见落点）

| 失败类别 | 可见落点 | 日志文本（前缀固定，可 grep） | 处置 |
|---|---|---|---|
| `HOME` 缺失/空 | FATAL 通道（stderr→`node.log` + `app.log`） | `[bootstrap] FATAL HOME 未注入：原生引导件应设置 HOME/USERPROFILE/TMPDIR` | 不 `exit`；保留现场 |
| `HOME`/`TMPDIR` 不在沙箱 / 不可写 | 日志 + `/facts.checks['fs_write_readback']` | `[bootstrap] WARN sandbox home=<...> readonly` / `ERR:<msg>` | 继续尝试（读回失败才算失败） |
| 归档缺失 | 日志 | `[tar] 归档缺失 path=<abs>` | 若目标目录已存在则继续；否则走入口缺失路径 |
| marker 非法内容 | 日志 | `[tar] marker 内容非法（按缺失处理）：<前 40 字节>` | 视为缺失 ⇒ 重解包 |
| 归档哈希与 marker 不一致 | 日志 | `[tar] marker 与当前归档不一致（升级或换包），重新解包` | 清理 + 重解包 |
| gunzip 失败（坏包/截断） | 日志 | `[tar] 解包失败 stage=gunzip written=<n>` | **不写 marker**；半成品保留（下次清理重解） |
| header 非法 / checksum 不符 / base-256 size | 日志 | `[tar] 解包失败 stage=header offset=<n>` | 同上 |
| 非法条目（`..`/绝对/空名/超长） | 逐条日志 | `[tar] 忽略非法条目 name=<原始名>（逃逸目标根）` | 跳过该条目，继续解包；总数进日志 |
| 链接/设备/FIFO 条目 | 逐条日志 | `[tar] 跳过非普通条目 typeflag=<c> name=<n>` | 跳过（不创建） |
| 写文件失败（`ENOSPC`/`EPERM`） | 日志 | `[tar] 解包失败 stage=write written=<n> errno=<code> path=<abs>` | 不写 marker；保留半成品 |
| 流提前结束 / 数据不齐 | 日志 | `[tar] 解包失败 stage=truncated（流结束时条目未写完）` | 不写 marker |
| 入口四候选全不存在 | 日志（**可读回**） | `[bootstrap] 入口不存在；候选（N）：<逐行绝对路径>` | 正常返回（不 `exit`）；`/facts` 反映未加载 |
| `require` 非白名单错误 | FATAL 通道 | `[bootstrap] FATAL <stack>`（含 `err.code`） | 不 `exit`；不降级成 `import()` |
| `chdir` 失败 | 日志 | `[bootstrap] WARN chdir 失败 target=<abs>：<msg>；继续用绝对路径` | 继续（依赖绝对路径） |
| 异步未捕获异常 | `app.log` + `node.log` | `[bootstrap] UNCAUGHT <stack>` / `[bootstrap] UNHANDLED <reason>` | 不 `exit`；计数器累加 |
| 自检端口占用 | 日志 | `[selfcheck] listen 失败 127.0.0.1:<port>：EADDRINUSE` | 不抛（`server.on('error')` 收口）；进程存活 |
| `/log` 读失败 | HTTP 200 + 占位串 | — | `(read failed: <msg>)`（S9） |

### 6.4 性能

| 项 | 数值 / 预期 | 依据 |
|---|---|---|
| 载荷规模（首个在册负载） | 884,167,367 B / ≈27.2k 文件；`tar.gz` 156,592,393 B | ✅ `pi-desktop-ark/docs/000-工程规划.md:176` |
| 旧壳同形态基线 | 真机 T+13 s 解压完 **27,279** 文件、T+15.2 s 到「就绪」（🔶 Electron 环境，同族 2in1） | 🔶 `pi-desktop-hos/docs/真机验证记录.md:232,316` · 🔶 §4.3 B8 |
| 本模块预期（⬜ 待实测） | 解包（顺序写 + 512 B 状态机）目标 ≤ 旧壳同级；瓶颈预估在 **27.2k 次 `open/write/close` 的 syscall**（单核），`inflate` 本身约 2–3 s（156.6 MB / 单核 zlib 50–100 MB/s 量级） | ⬜ P0-5 未做（§4.3 B8） |
| 零解压路线 | 额外开销 **0 s**（无解包、无拷贝）；代价转移到首次 `require` 的 OS 页缓存与 `stat` 链（⬜ 待实测） | 🔶 §5.5 · ⬜ P0-13 |
| 优化手段（已决定） | ① 目录 `mkdir` Set 去重；② 不恢复 `mtime`/`mode`（省 ~54k 次 syscall）；③ 顺序写（不并发，`cpus=0`）；④ `createReadStream` highWaterMark 1 MiB；⑤ 目录条目命中即跳过 | ✅ 本文 §4.5/6.2.1 |
| 日志开销 | 每 2000 文件一行进度 ⇒ 27.2k 文件约 14 行（避免日志爆炸；`node.log` 无轮转） | ✅ 本文 §6.3 |
| 分卷建议 | `payload-core.tar.gz`（`node_modules` 骨架）+ `payload-app.tar.gz`（应用代码/静态资源）：各自 marker，升级只重解变动卷；单卷压缩态建议 ≤100 MB（升级粒度 vs 单次失败代价） | 🔶 §5.5 大载荷建议行 · ✅ FR-004-004 |
| 报告可观测 | 每次解包输出 `files=<n> unpackMs=<t> bytes=<b>`，供消费方在加载页显示阶段 | ✅ C6 · ✅ NFR-004-001 |

---

## 7. 测试考虑

### 7.1 host 侧可测（不需要真机，本机 Node ≥ 22）

| # | 用例 | 构造 / 断言 |
|---|---|---|
| T1 | 小归档端到端 | 用本机 `tar`（或本模块的写入端）造含 1000 文件 + 中文名 + 空目录的 `.tar.gz` → 解包 → 断言**文件数**与**逐文件 SHA-256**（读回，不是 `statSync`） |
| T2 | 幂等命中 | 连续跑两次 `ensurePayload` → 第二次日志含「跳过解包」，marker `mtime` 不变，且不再写文件（用只读目录断言「没写」） |
| T3 | marker 命中但入口缺失 | 删入口后跑 → 强制重解包并成功（AC-004-009） |
| T4 | 期望哈希变化 | 改 `archiveSha256` → 触发重解包且不残留旧文件 |
| T5 | CJS / ESM 双通道 | 分别造 `.js`（`module.exports`）与 `.mjs`/`"type":"module"` 入口 → `require` / `import` 命中路径正确（AC-004-003） |
| T6 | 入口不存在 | 断言日志含 4 条候选绝对路径且进程未退出（AC-004-004） |
| T7 | 异步异常兜底 | 子进程里 `setTimeout(()=>{throw new Error('boom')})` → 进程存活 + `app.log` 出现 `UNCAUGHT`（AC-004-005） |
| T8 | `/facts`、`/log` | 起 `selfcheck.js`（`SELFCHECK_PORT` 用随机高位端口）→ `http.get` 断言状态码/内容类型/`checks` 键集合；`/log` 读回与直接 `readFileSync().slice(-8192)` 逐字节一致 |
| T9 | 内存不随条目增长 | 造单文件 200 MB 的 tar.gz → 采样 `process.memoryUsage().rss` 峰值增量 < 64 MB（NFR-004-003） |
| T10 | 相对性能基线 | 合成 27.2k 小文件归档 → 记录 `files/unpackMs` 作为回归基线（host 数值**不可**当承诺，只作趋势） |
| T11 | 幂等并发安全（弱） | marker 为只读文件时写失败 → 不致命，下次启动重解包（日志可见） |

**测试工具位置**：`tests/smoke-host.mjs`（规划 §7.4 第 ③ 步，⬜ Phase 1）；纯 Node，无依赖，`node tests/smoke-host.mjs` 一键跑。

### 7.2 边界清单（host 侧必须覆盖的构造）

| # | 边界 | 期望 |
|---|---|---|
| E1 | 条目 `../../escape.txt` / `..%2f` 变体 | 拒绝 + 日志；目标根外零文件（AC-004-008） |
| E2 | 绝对路径条目 `/tmp/x` | 拒绝 + 日志 |
| E3 | 中间段 `a/../b` | 归一化后若仍在根内可接受；越界则拒绝 |
| E4 | 超长路径：`name`(100) 截断 + `prefix`(155) 拼接；>255 B 用 `L` 头；>4096 B | 正确重建；超上限 ⇒ 明确失败（不允许静默截断成错误路径） |
| E5 | 符号链接 / 硬链接条目 | 跳过 + 日志；不创建链接（真机 `EACCES`） |
| E6 | `mtime = 0` / 负 mtime / 非八进制 | 忽略 mtime；不因它失败 |
| E7 | 单个大于内存的文件（如 3 GB 稀疏） | 流式写；内存常数；不 OOM |
| E8 | 含中文 / 非 ASCII 名 | UTF-8 正确还原 |
| E9 | 空 tar（仅两个零块） | 0 文件、成功（marker 可写）；入口复检失败 ⇒ 明确报错 |
| E10 | 零条目 tar（单零块） | 与 E9 同 |
| E11 | 截断 tar（中途结束 / 缺结束块） | `finish()` 抛「数据不完整」；不写 marker |
| E12 | header checksum 错误 / base-256 size | 立即失败（`stage=header`） |
| E13 | 重复目录条目 / 同名文件两次 | 幂等 / 后写覆盖；不报错 |
| E14 | 只读目标目录 / `ENOSPC` | `stage=write` 失败 + 已写条数；不写 marker |
| E15 | `HOME` / `TMPDIR` 不存在 | 可见 WARN/FATAL；不静默用 `''` 拼路径 |
| E16 | marker 内容非法（非 64 hex） | 按缺失处理 + warn |
| E17 | `selfcheck.js` 的 `os.tmpdir() + '/selfcheck.txt'` 固定文件名 | ⚠️ 并发/重入会互相覆盖（真实缺陷，见报告）；建议 `process.pid` 或随机后缀 |

---

## 8. 文件清单（真实 `wc -l`）

| 路径 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `payload/bootstrap.js` | **409** | ✅ 已实现 | 环境快照 + 运行根决策 + 幂等解包 + CJS/ESM 入口解析 + 异常兜底（不 exit） |
| `payload/host.js` | **231** | ✅ | Node 侧宿主桥客户端（§3.5） |
| `payload/lib/tar-extract.js` | **382** | ✅ 已实现 | 流式 ustar 解包（含路径穿越拒绝 / 整块零结束块校验 / `skipped` 计数） |
| `tests/smoke-host.mjs` | **0** | ⬜ 待新增（当前为 `tools/smoke-host.mjs`，415 行） | host 侧门禁（§7.1 T1–T11） |
| `library/src/main/ets/runtime/Types.ets` | **159** | ✅ | `NodeRuntimeOptions` 契约（S3：改动即破坏性变更） |
| `library/src/main/ets/runtime/NodeRuntime.ets` | **798** | ✅ 已实现 | 单例/状态机/投递 + `waitUntilRunning`/`logs`/`lastCrash`/`shutdown`/`host` |
| `library/src/main/ets/util/Env.ets` | **92** | ✅ | 路径约定（`payloadDir`/`tmpDir`/`logPath`/`crashPath`/`materializeRawfile`）——本模块的路径**唯一来源** |
| `library/src/main/ets/log/Logger.ets` | **198** | ✅ | `tail`/`tailLines` 读回通道（S9 口径） |
| `library/src/main/cpp/node_bridge.c` | **924** | ✅ 已实现 | 环境注入、argv、stdio pipe + reader（组件输出过滤）、崩溃 handler（单次 write） |
| `library/src/main/cpp/types/libnode_bridge/index.d.ts` | **45** | ✅ | `start` 6 参 + `isRunning`/`version`/`lastError`/`stage`（5 符号） |
| `tests/README.md` | 存在 | ✅ | 三层测试说明（host 门禁标 ⬜） |
| `payload/README.md` | **95** | ✅ | 载荷分发契约（含端口回退说明；与代码一致） |
| `library/Index.ets` | **21** | ✅ | barrel（若 `Types.ets` 变更需同步，S2） |
| `tools/provision.mjs` / `tools/elf-inspect.py` / `tools/ohos-selfsign.mjs` | **341** / **169** / **291** | ✅ | 非本模块（`005`），列为参照 |
| `../pi-desktop-hos/src-main/tar-extract.js` | **214** | ✅ 参照实现 | 流式 ustar 解包器（依赖注入、可单测） |
| `../pi-desktop-hos/src-main/main.js` | **1314** | ✅ 参照实现 | `:40-45` 归档/版本/marker 常量 · `:455-463` `sha256File` · `:502-543` `ensureArtifact` · `:581-592` `loadModule` |

> ⚠️ **分发缺口（真实）**：`payload/` 位于仓库根、**不在 `library/` 内**，实测消费方 HAR（`pi-desktop-ark/oh_modules/@fellow99/node-bridge/`）**不含 `payload/`**（只有 `Index.d.ets`/`README.md`/`ets`/`libs`/`src`）⇒ 规划 §7.5「HAR 带 `payload/`」未达成，消费方只能自己拷贝脚本（现状：把 `selfcheck.js` 放 `rawfile/` 再物化，✅ `Constants.ets:18`）。Phase 1 应把 `payload/` 挪进 `library/` 或加进打包流程（本文 §9 P1-15）。

---

## 9. Phase 1 待实现清单（逐条 + 验收判据）

| # | 待实现 | 验收判据 | 关联 |
|---|---|---|---|
| **P1-1** | **解包器**（`payload/tar-extract.js`）：移植 214 行流式实现 + 四项加固（路径校验 / `L`+`x`+`g` 头 / 前缀参数化 / 非法条目日志） | host 侧 T1/E1–E13 全绿；AC-004-008 通过（越界文件 0 个） | FR-004-012…018 · NFR-004-003/004 |
| **P1-2** | **SHA-256 幂等 marker**：期望值三级来源、命中后入口复检、原子写、失败不写 | AC-004-002（二次启动跳过）、AC-004-009（命中但截断 ⇒ 重解） | FR-004-006…011 |
| **P1-3** | **入口解析四优先级**：显式 → 中立变量名 → 约定路径 → `package.json main`；结果绝对路径双校验；**删除 `PI_*` 硬编码**（C1 修复） | AC-004-004；日志出现候选列表；`grep -rn "PI_" payload/` 为空（除注释说明「由消费方传入」） | FR-004-019/020/021 · **C1** |
| **P1-4** | **CJS/ESM 双通道**：`require` → 三错误码白名单 → `import(pathToFileURL)`；调用方 `await`/`.catch` 收口 | AC-004-003；ESM 入口抛错不产生 unhandledRejection（T5/T7） | FR-004-022/023 |
| **P1-5** | **`process.chdir`** 到载荷根（先校验存在/为目录；失败 warn + 绝对路径继续） | AC-004-001/002 后 `process.cwd()` 打印为载荷根；`require(pkg)` 类约定生效 | FR-004-024/025 · §D.8 |
| **P1-6** | **环境断言**：`HOME`/`TMPDIR` 写-读回 + 沙箱前缀 + 结果进 `/facts`（新增 `wasm.available` 之外的 `sandbox` 字段） | AC-004-006 的 `checks.fs_write_readback='OK'` 且 `checks.homedir`/`tmpdir` 在沙箱内 | FR-004-026/027 · C3 |
| **P1-7** | **异常兜底**：`uncaughtException` + `unhandledRejection` 处理器（不抛、不 exit、计数） | AC-004-005：进程存活 + 两条日志可读回 | FR-004-030/031 · ⑱ |
| **P1-8** | **独立日志通道**：`<home>/payload/app.log`（含时间戳、固定前缀）+ 读回通道（`/log?src=app` 或第二端点） | 崩溃/异常日志在 `app.log` 与 `node.log` 均可读回；AC-004-005/007 | FR-004-032/034 · ⑱ |
| **P1-9** | **selfcheck 补项**：`spawn`（三事件）、`wasm.available`、`state`、`hostBridge`（无桥时 `"ERR:not registered"`）、`checksAt`；`server.on('error')` 收口；`selfcheck.txt` 文件名唯一化 | AC-004-006；`/facts` 键集合 = README 声明的集合；端口占用不 abort | FR-004-035/038/039 · ⑰ |
| **P1-10** | **只读直读路线**（`resfile`）：路径解析由消费方给出、库侧中立；`/facts.checks.payload.mode='resfile'`；零解压日志 | AC-004-001：日志无「解包」字样且入口加载成功（真机 ⬜ P0-13） | FR-004-001/002 · §5.5 |
| **P1-11** | **载荷字段落入类型面**：`NodeRuntimeOptions` 增 `entry`/`payloadRoot`/`archive`/`archiveSha256`/`env`/`cwd`（与 `001` 同批；同步 `library/Index.ets` + `specs/README.md` 编号表 + 版本号） | 消费方能传 `archive`/`entry`；重建 HAR 无编译错误；契约文档同步 | S2/S3 · §五/§六 变更流程 |
| **P1-12** | **host 侧门禁** `tests/smoke-host.mjs`（T1–T11） | `node tests/smoke-host.mjs` 全绿；纳入 §7.4 第 ③ 步流水线 | tests/README.md · §7.4 |
| **P1-13** | **（跨模块，登记）** stdio 由 `dup2` 改 **pipe + 独立 reader 线程**（002），使 `node.log` 不再混入 ArkWeb/Chromium 输出 | §D.10 ⑱ 的 `/log` 输出里 `arkweb/chromium_ext` 命中为 0（真机 ⬜） | ⑱ · §5.10 ⑤ · `002` |
| **P1-14** | **文档同步**：`payload/README.md` 的检查项清单与 `selfcheck.js` 一致；`bootstrap.js` 注释里的 `@fellow99/node-bridge/bridge` 改为规划 §5.3 的 `.../host` | 两份文件逐项对照无差异；`grep -rn "node-bridge/bridge" payload/` 为空 | C2 · §5.3 |
| **P1-15** | **分发缺口修复**：让 `payload/` 进入发布物（挪到 `library/payload/` 或在 `assembleHar` 后拷贝 + `.ohpmignore` 校验），使消费方无需手工拷贝脚本 | 解包 `.har` 后存在 `payload/bootstrap.js`/`tar.gz` 解包器/`selfcheck.js`（`unzip -l library.har` 断言） | §7.5 · 本文 §8 缺口 |

**未实现项边界声明**（避免虚报）：① tar.gz 自解包与 ② SHA-256 幂等与 ③ CJS/ESM 入口解析与 ④ `process.chdir` 与 ⑤ 异步异常兜底/独立日志与 ⑥ `resfile` 只读直读加载与 ⑦ `homedir`/`tmpdir` 沙箱断言与 ⑧ selfcheck 的 `spawn` 项与 ⑨ `@fellow99/node-bridge/host` 内置模块 —— **全部 ⬜ 未实现**（现状见 `spec.md` §1.2 与本文 §8；其中 ⑨ 属 `003-host-bridge`）。
