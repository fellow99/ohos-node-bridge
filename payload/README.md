# 载荷（Node 侧 JS，随**仓库**分发——不随 HAR）

> ⚠️ 本目录**不在** `library/` 里，hvigor 只收 `library/` 内文件 ⇒ 这些脚本**不会**被打进发布包。
> 消费方从本仓库取用/复制，放进自己的模块（`resources/resfile/<app>/` 首选）。
> 主包 HAR 里随包的是**运行期线索**（`runtime.lock.json`、`THIRD-PARTY-NOTICES.md`，走 rawfile），不是本目录代码。

本目录是**库自带的 Node 侧脚本**（纯 JS，不参与 ArkTS 编译，零 npm 依赖）：

| 文件 | 作用 | 契约 |
| --- | --- | --- |
| `bootstrap.js` | 载荷引导器：读环境 → 幂等解包/选运行根 → 解析入口 → CJS/ESM 加载；顶部装异常兜底 | §3.1–§3.4 |
| `lib/tar-extract.js` | 流式 ustar(`.tar.gz`) 解包器（`zlib`+`fs`+`path`），含路径穿越拒绝 | §3.7 |
| `host.js` | Node 侧宿主能力桥客户端（`invoke`/`handle`/`list`/`facts`/传输接线） | §3.5 |
| `selfcheck.js` | 端到端自检端点（`/facts` `/log` `/rport` `/diag`） | §3.6 |

库**不替消费方决定**业务怎么起；这里提供的是「能直接复制的引导范式 + 真机取证通道」。

## 一、两条加载路线（按「载荷是否需要可写」二选一）

| 路线 | 形态 | 环境变量 | 代价 |
| --- | --- | --- | --- |
| **① 只读直读（首选）** | 载荷原样放 `resources/resfile/<app>/`，Node 从**安装目录直读** | `NODE_BRIDGE_READONLY_ROOT=<绝对路径>`（+ `NODE_BRIDGE_ENTRY`） | **零解压、零首启等待** |
| **② tar.gz + Node 自解包** | 单个 `*.tar.gz` 放可写目录，**Node 自己**流式解包（`lib/tar-extract.js`） | `NODE_BRIDGE_ARCHIVE=<绝对路径>`（+ 可选 `NODE_BRIDGE_ARCHIVE_SHA256`） | 首启解包耗时（可观测 ms） |

- **谁解包**：路线 ② 必须由 **Node 自己**做（`zlib` + `fs`）——**禁止**用 ArkTS/鸿蒙侧解压器写 Node 要读的业务文件（C3：写出的文件 Node 读不到，`MODULE_NOT_FOUND`）。
- **幂等（路线 ②）**：目标 = `<payloadRoot>/<sha256 前 12 位>`，就绪 marker = `<payloadRoot>/.ready-<sha256 前 12 位>`（JSON：`sha256`/`files`/`bytes`/`skipped`/`at`，**原子写**：`.tmp.<pid>` → `rename`）。**命中 marker 且目标目录存在 ⇒ 跳过**并打印 `[bootstrap] payload ready (skip)`；缺 marker ⇒ 重做解包（宁可重做也不留半成品）。`skipped` = 被跳过的条目数（链接/设备/pax 头），解包树不完整时可审计。
- 若只需要**一块可写缓存**，把缓存目录指到宿主可写目录（用 `env` 传 `*_CACHE`/`TMPDIR` 之类），**不要**为了可写把整份载荷再解一份。
- 大载荷建议按目录分卷（`payload-core.tar.gz` + `payload-app.tar.gz`），各自独立幂等。

**运行根决策（冻结顺序）**：① 解包目录 → ② `NODE_BRIDGE_READONLY_ROOT`（必须存在且是目录，否则**大声 warning** 后回退）→ ③ `NODE_BRIDGE_PAYLOAD_ROOT` → ④ `<HOME>/payload`。

## 二、环境变量契约（§3.1；`HOME`/`TMPDIR` 由原生引导件注入，见规划 §5.6）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_BRIDGE_PAYLOAD_ROOT` | `<HOME>/payload` | Node **可写**根（解包目标、marker 落点） |
| `NODE_BRIDGE_ENTRY` | — | 入口：绝对路径直接用；相对路径按**运行根**解析 |
| `NODE_BRIDGE_ARCHIVE` | — | 载荷 `tar.gz` 绝对路径；**给了才走解包路线** |
| `NODE_BRIDGE_ARCHIVE_SHA256` | — | 幂等判据；给了就与实算值比对，**不一致 ⇒ 硬失败**（不解包、不继续） |
| `NODE_BRIDGE_READONLY_ROOT` | — | `resfile` 只读直读根（优先级低于解包根、高于 `payloadRoot`） |
| `NODE_BRIDGE_CWD` | 运行根 | `process.chdir` 目标（真机 `cwd=/`，必须显式设）；失败 ⇒ `WARN chdir failed` 后继续 |
| `SELFCHECK_PORT` | `15577` | `selfcheck.js` 监听端口（只绑 `127.0.0.1`）。**默认 15577 是文档化的取证契约**（所有真机命令都用 `hdc fport tcp:15577`）；若它被占用 ⇒ **回退到内核临时端口**并打印 `[selfcheck] WARN 15577 被占用 → 改用 <port>`（绝不静默换端口、也不反复撞占用端口） |
| `RPORT_PORT` | `19999` | `/rport` 的转发目标端口 |
| `HOME` / `USERPROFILE` / `TMPDIR` / `TMP` / `TEMP` | 原生层注入 | 原生引导件重定向到应用沙箱；载荷只读，不覆盖 |

入口解析（§3.3）：`NODE_BRIDGE_ENTRY` 绝对/相对 → 缺席时 `<runRoot>/package.json` 的 `main` → `<runRoot>/index.js`；缺文件 ⇒ 打印 `[bootstrap] ENTRY_MISSING <abs>` + 运行根前 20 项并**返回**（不 `process.exit`，让原生层记录 `node::Start` 的返回值）。
加载：先 `require(abs)`，仅当 `ERR_REQUIRE_ESM`/`ERR_REQUIRE_ASYNC_MODULE` 时退 `await import(pathToFileURL(abs).href)`；打印 `[bootstrap] entry=<abs> mode=<cjs|esm> root=<runRoot> cwd=<cwd>`。

**日志前缀**：payload 只写文本，固定前缀 `[bootstrap] ` / `[tar] ` / `[selfcheck] `；`<stream> <epochMs> ` 由原生层 reader 线程加（§1.3），payload **不得**自己拼。

**异常兜底（§3.4 / D.10 ⑱）**：`bootstrap.js` 顶部注册 `uncaughtException` / `unhandledRejection`，把 `时间戳 + 类型 + message + stack` 追加到**独立通道** `<HOME>/payload/app.log` + stderr，并写 `globalThis.__nodeBridgeLastError`；**绝不 `process.exit`**（保留现场）。进程内 Node 没有优雅退出路径，任何未捕获异常都是应用级事故。

## 三、自检端点（§3.6；只绑 loopback）

| 端点 | 响应 |
| --- | --- |
| `GET /facts` | `200 application/json`，`{at, checks:{…}}`；`checks` 键名**冻结**：`node` `platform` `arch` `execArgv` `versions` `homedir` `tmpdir` `homedir_redirected` `tmpdir_redirected` `netifaces` `cpus` `spawn` `wasm.validate` `wasm.error` `fs_write_readback` `hotloop_ms_5rounds`（共 16 项，键名不得增删；单值失败编码 `ERR:<message>`；`spawn` = `{pid, stdout, events:{data,exit,close}, zombie, procState}`，5 s 超时） |
| `GET /log` | `200 text/plain`，`<HOME>/payload/node.log` 尾部 8192 字符（读失败 ⇒ `200` + `(read failed: …)` 占位串） |
| `POST /rport` | `200 text/plain`，把请求体原文转发到 `127.0.0.1:${RPORT_PORT}`（第三条取证通道）；上游不可达/非 2xx ⇒ `502` + 错误文本 |
| `GET /diag` | `200 application/json`，`{at, lastError, appLogTail, hostBridge:{transport:'unavailable'|'custom', handles:[…]}}` |
| 其它路径 | `404 text/plain` |

真机基线（§D.8 / §D.10）：无 ACL 且不带 `--jitless` ⇒ 启动即 SIGTRAP；`--jitless` 下 `WebAssembly is not defined`、热循环约 299 ms/5 轮；有 ACL ⇒ `wasm.validate === true`、热循环 6–9 ms/2e6；`os.cpus()` 长度 **0**（版本/并发探测不得依赖它）；`spawn('/system/bin/sh')` 完整可用（无僵尸）。

> ⚠️ 自检端点是**诊断面**，不是产品面：同设备其他应用也能访问 loopback 端口，且 `/log` 会回显日志。发布构建**不要**把 `selfcheck.js` 当载荷入口。

## 四、宿主能力桥 `host.js`（§3.5）

```js
const host = require('<载荷绝对目录>/host.js');

host.setTransport(async (name, argsJson) => { /* Phase 2：napi_threadsafe_function */ });
await host.invoke('perm.check', { name: 'ohos.permission.X' });   // → 已解析的对象
host.handle('shutdown', async (payload) => { /* Node 侧钩子 */ }); // 本地注册表，宿主经桥回注调用
host.list();        // → string[]（已注册的 Node 侧钩子名）
host.unhandle('shutdown');                       // → boolean（是否真的删掉了）
host.facts();       // → {node, platform, arch, execArgv, pid, versions, HOME, TMPDIR, cwd}
host.getTransport();                             // → fn | null
```

- **默认没有传输层**：`invoke()` **reject** 结构化错误 `{ok:false, error:'transport-unavailable', name, hint}`，**绝不**静默返回 `undefined`/空值（C2）。
- 其它结构化错误：`timeout`（默认 **10000 ms**，`opts.timeoutMs` 覆盖）、`payload-too-large`（默认 **8388608 B**，`opts.capBytes` 覆盖）、`bad-response`（响应非 JSON/非对象）、`transport-error`（传输抛错）、`bad-args`（载荷不可序列化）。
- 传输返回字符串 ⇒ `JSON.parse`；返回对象且 `ok === false` ⇒ reject 并把字段原样上抛，否则 resolve。
- 能力名 v1 清单（冻结命名）：`runtime.facts` `perm.check` `perm.openAppInfo` `fs.pickFiles` `fs.pickFolder` `shell.openExternal` `notify.show` `log.hilog` —— 库只做寄存器与传输，**每个能力的实现属消费方**。

## 五、「谁写谁读」（C3）—— 每条写路径都要有读回命令

| 写的人 | 写了什么 | 读回通道（真机命令） |
| --- | --- | --- |
| 原生层 stdio reader | `<HOME>/payload/node.log` | `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/log \| tail -n 40` |
| 载荷兜底 / 业务 | `<HOME>/payload/app.log` | `curl -s http://127.0.0.1:15577/diag` → `appLogTail`（末 4096）；或调试包 `hdc file recv <沙箱>/files/payload/app.log ./app.log` |
| Node 自解包 | `<payloadRoot>/.ready-<sha256 前 12 位>` + 解出目录 | 二次启动必须打印 `[bootstrap] payload ready (skip)` + marker 内容；`curl -s .../diag` 与日志行 `extracted … files=<n> bytes=<n> ms=<n>` 对账 |
| 宿主桥 | 能力调用结果 | `curl -s http://127.0.0.1:15577/diag` → `hostBridge`；失败必须是结构化错误而不是空值 |

判断「载荷到底起来了没有」**不能**只看 `node::Start` 的返回值（文件轮询足以区分成功/失败）：以 `/facts` 的那份 JSON 作为**端到端证书**（🔶 §5.7）。

## 六、与消费方的关系

库提供引导范式与取证通道；**载荷内容与裁剪、投放时机、首启加载页、每个宿主能力的实现**都由消费方负责（§6.1 责任分界）。运行期**不要**依赖 `process.cwd()`（真机是 `/`），一律用绝对路径；也不要依赖 `process.execPath`（真机是 `/system/bin/appspawn`）重新拉起 Node。
