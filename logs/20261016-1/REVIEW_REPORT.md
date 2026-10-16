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
