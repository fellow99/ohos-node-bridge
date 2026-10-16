# REVIEW_REPORT.md —— 代码评审批次记录

> 工程：`ohos-node-bridge`（`@fellow99/node-bridge`）· 需求：**000-scaffold 工程搭建** · Phase 1 MVP
> 评审对象：工作区未提交改动（相对上一版提交的基线：`node_bridge.c` 295 行、`NodeRuntime.ets` 115 行、
> `HostBridge.ets` 46 行、`Logger.ets` 53 行、`Env.ets` 65 行、`Types.ets` 49 行、`payload/bootstrap.js` 64 行）
> 评审技能：**`requesting-code-review`**（派独立 `code-reviewer` 子代理）→ **`receiving-code-review`**（逐条核验后处置）
> 日期：2026-10-16 · 本轮轮次：**R1**

---

## 一、派评审（requesting-code-review）

| 项 | 内容 |
|---|---|
| 形态 | 独立 `code-reviewer` 子代理（只读：Read/Glob/Grep），**不给会话历史**，只给工件与要求 |
| DESCRIPTION | Phase 1 MVP：原生引导件重写（stdio 双 pipe + 排空线程 / 日志行格式 / 崩溃记录 JSON / 信号安全格式化 / `lastError()`+`stage()` / `envPairs`）、ArkTS 层重写（6 态状态机 / 完整 options / `waitUntilRunning` / `logs` / `lastCrash` / `shutdown` / `HostBridge` 加固）、Node 侧载荷（自解包 + 幂等 marker + 入口解析 + 异常兜底 + `host.js`）、host 工具与测试、24 份规格文档 |
| PLAN_OR_REQUIREMENTS | `specs/constitution.md`（C1–C7 / S1–S10 / G3·G4·G5·G11）· `logs/20261016-1/IMPLEMENTATION_CONTRACT.md`（冻结契约 §1–§5）· `docs/000-工程规划.md` §8 Phase 1 出口判据 ①–⑥ |
| 范围 | 逐条对契约核验 + 并发/信号安全/fd 生命周期/路径安全/两侧口径一致性 + **「注释是否声称了代码没做的事」** |
| 结果 | **Critical 0** · **Important 10** · **Minor 9** |

**评审结论（原文）**：*「Not ready for device verification as-is, but close.」* 主要理由：多条发现属于
「功能声称已完成/可见，但它的证据或契约文本是错的」—— 而这正是真机轮次要认证的东西。

---

## 二、收评审（receiving-code-review）—— 逐条核验与处置

处置口径：**先核验再动手**；正确的直接改，**不写客套话**；不正确的**用技术理由反驳**。

| # | 严重度 | 发现（要点） | 核验结论 | 处置 |
|---|---|---|---|---|
| A1 | Important | `envPairs` >4096 B 被截断却**不写 `sys` 日志行**（契约 §1.2 明确要求），且 `get_str_arg` 的截断返回值被忽略、`lastError` 又被覆盖 ⇒ 静默降级 | 成立：`get_str_arg` 返回 1、`js_start` 只测 `< 0` | ✅ 改：截断必写 `sys` 行；路径类参数视为致命（`bad=1` → `-2`）；成功路径不再清空 `last_error` |
| A2 | Important | `g_last_error` **丢更新**：`pthread_create` 之后才清空，而引导线程可能已写入日志打开失败 | 成立（日志打开失败是现实路径） | ✅ 改：清空移到 `pthread_create` **之前** |
| A3 | Important | `g_stage` 永远不会是 `"running"` ⇒ `getStage()` 不可达、`stage_hint("running")` 死代码、**正常运行期崩溃被记成 `start` 并给错诊断** | 成立 | ✅ 改：`stage` 提示覆盖两种成因；**收到 Node 第一行输出时提升为 `running`**（以真实证据为代理） |
| A4 | Important | `SIGSYS non-svc` 诊断行**违反冻结日志格式**（无 `epochMs`、文本不以 `[node_bridge] `/`CRASH` 开头）⇒ 两侧解析器都判为不可解析 | 成立 | ✅ 改：按冻结格式重写（含 `epochMs` 与 `[node_bridge] `） |
| A5 | Important | `CRASH` 行用 ~20 次 `write()` 拼出 ⇒ 可被其他线程插断；注释却声称「单次写整行原子」 | 成立（O_APPEND 只保证**单次** write 原子） | ✅ 改：整行先在栈上组装，**单次 `write()`**；仍禁用 `snprintf`（S5） |
| A6 | Minor | 早期失败路径不置 `exited` ⇒ `waitUntilRunning` 早退分支永不触发，宿主固定等满 15 s | 成立 | ✅ 改：每条失败 `return NULL` 前置 `exited` |
| A7 | Minor | `get_str_arg` 对**恰好填满**缓冲的字符串误报「已截断」 | 成立 | ✅ 改：先用 `napi_get_value_string_utf8(…, NULL, 0, &needed)` 取真实长度再比较 |
| A8 | Minor | `.d.ts` 未记载 `-2`；`NodeRuntime` 把任何非 0 rc 都归因 `pthread_create` | 成立 | ✅ 改：`.d.ts` 记载 `0 / >0 / -1 / -2`；ArkTS 按符号分支消息 |
| A9 | Minor | `io_uring_setup` 日志把负数一律标 `armed(devices-with-seccomp-trap)`，而 shim 在探测**之前**就已装载 ⇒ 无法区分 ENOSYS/EPERM 与 trap | 成立 | ✅ 改：文案改为 `shim-armed-before-probe`，保留原始 rc/errno |
| B1 | Important | `lastCrash()` 恒读 `<filesDir>/…`，而原生写 `<homeDir>/…` ⇒ 自定义 `homeDir` 时崩溃记录**写在没人读的地方**，`lastCrash()` 返回 `null` | 成立 | ✅ 改：记住 `start()` 时的**有效 home** 并据此构造路径 |
| B2 | Important | `last-crash.json` 撕裂/损坏 ⇒ `null`，而 `specs/006` FR-006-015 要求**降级记录**（从日志尾的 `CRASH ` 行解析） | 成立（契约只说**缺文件**⇒null，不说损坏⇒null） | ✅ 改：JSON 不可解析时回退解析 `CRASH` 行返回降级记录；**缺文件**仍 `null` |
| B3 | Minor | `JSON.stringify(e)` 在「永不抛」catch 里遇到**循环引用**会抛 ⇒ 逃出 `dispatch`/`logs()` | 成立 | ✅ 改：stringify 包 try/catch，退回固定串 |
| B4 | Minor | `utf8Len` 兜底注释称「保守偏大」，而 `string.length` 对非 ASCII **偏小** ⇒ 可能**放行**超限载荷 | 成立（方向写反了） | ✅ 改：注释改为真实方向，并使兜底安全 |
| B5 | Minor | `Logger.tail` 在**非空文件读失败**时返回 `(log empty)`，与其自身文档（IO 错 ⇒ `(read log failed: …)`）矛盾 | 成立 | ✅ 改：两类可区分 |
| C1 | Important | stdio 改 pipe **只解决了排空，没有解决污染**：`dup2(pipe[1],1/2)` 仍收下进程内任何组件写到 fd1/2 的输出（含 ArkWeb/Chromium）并全部标 `out/err` | **成立且重要**：本仓库自己的实测（§D.10 ⑱）是**共享 fd** 的性质，不是「dup2 到文件」的性质 | ✅ 改：reader 侧按特征**过滤** ArkWeb/Chromium 原生行并**打印丢弃计数**（不静默）；同时**修订契约 §1.3** 把 `out`/`err` 定义为**进程级** stdout/stderr、并指明载荷自有通道是 `app.log` |
| C2 | Important | `payload/bootstrap.js` 读 `PI_WEB_ENTRY` ⇒ 库载荷解释 `PI_*`，违反 **C1**（一票否决）；而契约把它冻结成「兼容别名」 | 成立：两份绑定文档真实冲突，**C1 优先** | ✅ 改：移除 `PI_WEB_ENTRY` 回退（只留 `NODE_BRIDGE_ENTRY`）；**修订契约 §3.1**（消费方经 `options.env` 传，且在 `NODE_BRIDGE_*` 之后应用故仍生效） |
| C3 | Important | `selfcheck.js` 固定 15577、无空闲端口探测 ⇒ 端口被占时自检载荷跑不起来（出口判据 ⑥ 的「随机端口」未证） | **部分成立** | ⚠️ **部分接受 + 部分反驳**：固定 15577 是**已文档化的诊断契约**（所有文档/命令都用 `hdc fport tcp:15577`），改默认值会破掉它；**但**采纳其风险点 —— 增加 `EADDRINUSE` 时**回退到临时端口并大声打印所选端口**，保留 `SELFCHECK_PORT` 覆盖 |
| C4 | Minor | tar 头块「首字节为 0」即判结束，**其余 511 字节非零也照判** ⇒ 后续条目被静默丢弃，`finish()` 通过，bootstrap 还会为**不完整**的树写就绪 marker | 成立（真实正确性问题） | ✅ 改：要求整块 512 字节全零；并记录 skipped 计数 |
| C5 | Minor | `host.js` 与 `HostBridge.ets` 的载荷计量/错误形态一致性 | 部分已被前轮修（两侧都按 UTF-8 字节） | ✅ 改：与 B4 同步 |
| D | —— | 规格/契约与代码的**具体陈旧断言**（NAPI 3 符号、`lastError/stage` 未消费、`NodeRuntime` 115 行无 `logs/lastCrash/shutdown`、`/facts` 14 项、marker 名、`PI_WEB_ENTRY`、缺 `/diag`） | 成立（规格是按**改造前基线**写的） | ✅ 改：按实测值逐条订正规格与契约 |

### 明确反驳（不改）

| # | 发现 | 反驳依据 |
|---|---|---|
| F17 | 「`Logger.ets` 使用 `JSON` 但没有 `import { JSON } from '@kit.ArkTS'`，文件可能无法编译」——评审者因为没有 shell 无法编译验证 | **反驳成立**：库在本轮多次 `hvigorw assembleHar` 成功（`BUILD SUCCESSFUL`，**0 ArkTS 错误**），`JSON` 在此 SDK 无需该 import。不改。 |

### 保留为「已知未闭合」（不阻塞本需求）

| # | 项 | 理由 |
|---|---|---|
| F18 | ArkTS 侧解析器（`NodeRuntime.parseLogLine` / `Logger.tailLines` / `HostBridge`）**没有自动化覆盖**，`tests/lib/log-format.mjs` 只验自己的参考正则 | 本工程无 ArkTS 测试运行器（`oh-package.json5` 无 hypium 依赖）。已把「日志行格式」的**唯一事实源**收敛到契约 §1.3，并在本轮用镜像脚本对 `CRASH` / SIGSYS / 边界行做了交叉验证；补 ArkTS 侧 runner 列入 Phase 2 |
| F19 剩余 | 规格中可能仍有其他陈旧断言（评审者按 grep 抽查，未通读 1300 行规划） | 本需求范围内已订正**评审者点名**的全部条目；其余在下次规格回归时统一 |
| —— | 无真机验证 | 本会话无设备；所有真机判据（ArkWeb 可达性、SSE、路由 ①/② 的 `require` 链、返回键、外链）均标注 ⬜ |

---

## 三、裁决汇总

| 类别 | 数量 | 说明 |
|---|---|---|
| Critical | **0** | 评审核验后仍为 0 |
| Important | 10 | **10/10 已处置**（C3 为部分接受 + 有理由的部分反驳） |
| Minor | 9 | 8 已改；F18 保留为已知未闭合（有理由）；F17 反驳成立 |
| 反驳 | 1 | F17（`JSON` import）—— 由构建成功证据否定 |
| 出口判据 | —— | 无 Critical 残留 ⇒ **Phase 门禁通过**，可进入真机验证轮 |

> 处置纪律（`receiving-code-review`）：**逐条核验后才动手**；正确的不致谢、直接给出改动位置；
> 不确定的先问或明确标注；与既有架构决策冲突的（C2 的 `PI_*` 解释权）以宪法优先并**修订契约**而不是绕过。

---

## R2（迟到报告整合）· 2026-10-17

> 背景：002/005/006/001 等规格代理的最终报告写于**后续实现与 code-review-fix 轮之前**；本轮逐条复核后，
> 已修的不重复动、仍开着的按「精确清单」修复，并回写规格。R1 内容保持原样。

### 1. 复核后确认「早已修复」的条目（不重复处置）

stdio 管道 + reader 线程排空 · 日志行格式 `<stream> <epochMs> <text>` · ArkWeb/Chromium 行过滤 ·
崩溃行单次 `write` · `stage()` 提升到 `running` · `envPairs` 截断告警 · `g_last_error` 清空时序 ·
失败早退 `set_stage("exited")` · `get_str_arg` 需要长度查询 · `.d.ts` 记录 `-2` · `io_uring` 标签文案 ·
`pi-desktop-ark` 的 `compressNativeLibs`/`extractNativeLibs`、`launchType: singleton`、载荷缺陷修复、
`probeFlags` debug 门控。

### 2. 本轮新修（A1–A6）

| # | 缺陷 | 处置 | 位置 |
|---|---|---|---|
| A1 | hilog domain 两侧不一致（C `0xD003300` vs ArkTS `0xD0033`） | **C 侧改为 `0xD0033`**；两文件加「必须相同」注释；构建产物反汇编佐证 `mov w2,#0x33; movk w2,#0xd,lsl #16`（= 0x000D0033）后再 `bl OH_LOG_Print` | `library/src/main/cpp/node_bridge.c:46`、`library/src/main/ets/log/Logger.ets:9` |
| A2 | `elf-inspect.py` 的 `VERDICT: FAIL` 仍 `return 0`（CI 假绿） | 改为 `return 0 if not verdict else 2`；docstring 写明退出码；stdout 文本不变（`smoke-host` 阶段② 解析不受影响） | `tools/elf-inspect.py:14,170` |
| A3 | `--from <url>` 名义支持、实际按本地路径（`ENOENT` 栈） | `--from` 命中 `http(s)://` 时走与 `--download` 同一 `acquire()` fetch 路径；代理提示抽成 `proxyHint()` 复用（不新增依赖） | `tools/provision.mjs:52,245-256` |
| A4 | 截断/畸形 ELF 抛 `RangeError`；`--from` 给目录抛 `EISDIR` | 读/解析包 `try/catch` + `isFile()` 判定 ⇒ 一行 `✗` + `exit 2`；`elf-inspect.py` 同步加异常兜底（一行 `✗` + `exit 2`） | `tools/provision.mjs:283-295`、`tools/elf-inspect.py:176-180` |
| A5 | `Env.materializeRawfile` 忽略视图 `byteOffset`/`byteLength` | 只写视图覆盖的字节（offset=0 且等长时零拷贝，否则 `slice` 精确副本）；签名与行为不变，ArkTS 严格模式保持 | `library/src/main/ets/util/Env.ets:83-92` |
| A6 | 覆盖非锁定目标静默 | 覆盖时打印旧/新 SHA-256（短式）一行（`libnode.so` 与 `libc++_shared.so` 各一行）；**不**改成拒绝（目标必须等于 lock 值是文档化契约） | `tools/provision.mjs:315-324,336-343` |

### 3. 规格回写（B1–B7）

| # | 修复 |
|---|---|
| B1 | 宪法 S8 改为「C 侧 = 5 符号、`start` 6 参、扩展需同步 `.d.ts` + 契约 §1.1」，行号引用改为符号级锚点（`Init()` 的 `napi_property_descriptor desc[]`）；**全库规格内所有「3 个符号/`0xD003300`」表述一并订正**（ARCHITECTURE / TECH / 001 / 002 / 003 / 004 / 005 / 006 / 007 / overall-*） |
| B2 | S5 全部改 ✅ 并写明新机制（手写 `u64_to_dec`/`u64_to_hex` + `lb_append*` + 单次 `write`，handler 区间 0 命中 stdio/malloc/getenv）：constitution、002 spec/plan、006 spec/plan、overall-plan/overall-spec/overall-test-cases（TC-002-007）、001/007 plan |
| B3 | 6 态口径落地：001 spec（FR-001-004/006/007/009/046）、001 plan §3.1/§4.1/§6.1/§7.2/§9（第 1/15 条）、overall-test-cases TC-001-009、overall-data-model §3.1/§3.3；「不在进程内重启」的理由保留；TC-001-009 状态口径冲突消解（脚本侧钩子仍标 Phase 2） |
| B4 | `pi-desktop-ark` HAP 压缩：`overall-data-model.md` §6.1/§6.2（含产生命令与原始输出）、`overall-test-cases.md` TC-ARK-007/B7/B9、`SPECS_CHECKLIST.md`、107 spec/plan、ARCHITECTURE。实测：签名 HAP **46,031,244 B**、三个 `.so` 全 `compress_type=8`；`rawfile/resfile` 仍为 `0`，规划附录 A 的「全部为 8」按实测收敛为「原生库为 8」 |
| B5 | `--expose-internals` 统一记为**文档化偏差**（默认 `--no-verify-heap` 为真机验证值；`--expose-internals` 仅在 internal-module stub 路线必需、由消费方经 `flags`/`execArgv` 显式传入）：001 plan §3.5/§9-8、002 spec/plan、ARCHITECTURE D4、TECH #4、overall-plan #5、overall-test-cases TC-001-010 |
| B6 | 沙箱路径以实现为准并标注规划草案被取代：payload 根 `<filesDir>/payload`、日志 `<filesDir>/payload/node.log`、崩溃记录 `<filesDir>/node-bridge/last-crash.json`（overall-data-model、001 plan §9-2、004 plan/spec、006 plan/spec；不改 `docs/000-工程规划.md`） |
| B7 | 就绪 marker 统一为 `.ready-<sha256 前 12 位>`（004 plan §3.3/§4.4）；`/facts` 16 个冻结键（含 `spawn`）+ 四条端点 `/facts` `/log` `/rport` `/diag`；`bootstrap.js` 已无 `PI_WEB_ENTRY`（002/001/overall 各处的 ⚠️ 一并转 ✅） |

### 4. 明确**反驳/不处置**的一条

- **「`--sign` 会静默覆盖已签名目标」不是缺陷**：工具契约是「部署目标必须等于锁定的 SHA-256」⇒ 把目标恢复成
  锁定原件是**正确行为**，不引入拒绝分支；只按 A6 补充旧/新 SHA-256 可见行（005 plan D-6 已改为 🟩 政策确认）。

### 5. 本轮验证输出（原文摘录）

```text
$ node tools/smoke-host.mjs
[1/4] lock + runtime gate ............... PASS
[2/4] ELF inspect ....................... PASS
[3/4] payload unit tests ................ PASS
[4/4] contract drift .................... PASS
SMOKE: PASS        （exit 0）

$ python tools/elf-inspect.py ../pi-desktop-ark/entry/libs/arm64-v8a/libnode.so
VERDICT         : PASS (可 dlopen 的真共享库)          exit 0

$ python tools/elf-inspect.py <合成 PIE：PT_GNU_RELRO→PT_INTERP 等长改写>
VERDICT         : FAIL -> PT_INTERP present (PIE!)      exit 2

$ node tools/provision.mjs --from <截断 100 B 的 ELF> --check
✗ 无法读取/解析 ELF：…\libnode-trunc.so —— The value of "offset" is out of range. It must be >= 0 and <= 96. Received 120
exit 2（无 RangeError 栈）

$ node tools/provision.mjs --from <目录> --check
✗ 无法读取/解析 ELF：…\scratch\b1548005-… —— 不是普通文件（目录？）      exit 2

$ node tools/provision.mjs --from http://127.0.0.1:18777/libnode-arm64.so --check
  下载：http://127.0.0.1:18777/libnode-arm64.so
  实测 SHA-256 = 3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1
  ⑦ 项门禁全 OK（② PT_INTERP 计数 == 0）
✓ --check：门禁全过（未投放）      exit 0

$ python tools/elf-inspect.py <截断> / <目录>            → 一行 ✗ …（unpack requires a buffer of 56 bytes / Permission denied）exit 2
$ node tools/provision.mjs --from <合成 PIE> --check     → 门禁 ② FAIL（实测 1）→ ✗ 产物与 lock 不符 …  exit 2
$ node tools/provision.mjs --from <真产物> --out <预置改动目标>
  ⟳ 覆盖 libnode.so：旧 SHA-256 f81f36f58f6e319f… → 新 3019bf5f9a279d98…
  ⟳ 覆盖 libc++_shared.so：旧 SHA-256 eb22cc97535218c3… → 新 388e0df23d7bfddc…

$ hvigorw --mode module -p module=library@default assembleHar --no-daemon
> hvigor BUILD SUCCESSFUL in 10 s 901 ms        （exit 0；`ArkTS:ERROR` = 0 行）

$ llvm-objdump -d <构建产物> | grep -B2 OH_LOG_Print
      4468: mov  w2, #51
      446c: movk w2, #13, lsl #16        ; w2 = 0x000D0033 = 0xD0033
      4478: bl   OH_LOG_Print@plt
```

B4 实测命令与原始输出见 `pi-desktop-ark/specs/overall-data-model.md` §6.2（HAP 46,031,244 B；三个 `.so` `compress_type=8`；`rawfile/resfile` 仍 `0`）。
