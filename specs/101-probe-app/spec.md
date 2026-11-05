# spec.md —— `101-probe-app`（PRB 探针应用 · 消费侧/探针侧规范）

> 上游规划：[`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) §7.2 样例 / §6.1 状态机与探活 / §5.6 环境契约 / §D.6 HAP 原生库 / §D.8 JIT 与 ACL / §5.4 宿主桥。
> 宪法：[`../constitution.md`](../constitution.md) C1 库/壳分离 / C2 不隐藏平台真相 / C4 启动参数不可事后修改 / C5 单例与不可重启 / S2 / S3 / S10。
> 既有结论（只引用不复制）：[`overall-spec.md`](../overall-spec.md) §3 / [`overall-data-model.md`](../overall-data-model.md) 状态机与宿主桥消息 / [`payload/selfcheck.js`](../../payload/selfcheck.js)（契约 §3.6 的 16 冻结键）。
> 本文**技术无关**：只写「要什么、怎么算通过」，不写实现细节（实现与真实文件见 `plan.md`）。
> 证据标记：✅ 实测 · 🔶 沿用外部/同型工程 · ⬜ 待验证/未落地 · ⚠️ 冲突或风险。
> 关键术语用英文（RFC 2119：MUST / SHOULD / MAY / MUST NOT）。

---

## 1. 概述

### 1.1 目的

`probe-app/` 是一个**只消费 `@fellow99/node-bridge`、自带结构化探针**的 HAP（feature 模块）。
它回答一句话：「**这台真机、这个电量/权限/ACL 环境、这份 `libnode` 里，Node 到底起动没有、能不能被宿主桥叫到**」。

与 `samples/minimal-app`（最小样例 + `/facts` 手工取证）的分工：
- `minimal-app` 是**参考实现**，页面按 flags 档位启动、把 `/facts` 挂到固定端口让人 `curl`；
- `probe-app` 是**判据化探针**：把『Node 起动 + 起服 + 宿主桥往返 + 版本契约』拆成 PRB-xx 五项，
  每项**独立超时、三态判定（PASS / FAIL / SKIP）**，全程无人值守可跑（`--ps probeAuto true`），
  结果落**沙箱文件**（`<filesDir>/probe-report.json`）并可导出。

### 1.2 它解决什么问题

| # | 问题 | 本规范的回答 |
|---|---|---|
| 1 | 「Node 起动成功」被当成黑盒：`ok=true` 只代表**已投递** | PRB-02 要求观测 `getStage()` 到 `running`（探活命中才算），不猜 |
| 2 | `/facts` 的 200 与「Node 真能用」之间隔着什么 | PRB-03 断言 node 版本 + 健康键（16 冻结键子集）全真 |
| 3 | Node→ArkTS 宿主桥**有没有通**，怎么自证 | PRB-04 用文件信箱做一次 `echo` 往返，要求**读回**才是 PASS（C3 谁写谁读） |
| 4 | 消费方（页面）与运行时（libnode）的版本契约散在文档里 | PRB-05 把 Index 常量 vs `/facts` 元数据对拍 |
| 5 | 设备缺 / 无法判定的环节被误报为「通过」 | 三态含 **SKIP**（无法判定的前置），设备侧判据一律只填 ⬜，不编造 |

### 1.3 范围

**在范围内**：`probe-app/` 模块的目录与构建注册、PRB-01…05 五项探针的**判据**与**结果落盘/导出**、
无头自动化入口（`--ps probeAuto`）、权限声明面、以及「无设备/无签名时如何如实登记」的判据口径。

**不在范围内**：

- `library/` 的公共 API（属 `001`–`007`），本规范只**消费**它；
- `libnode.so` 的获取与投放（属 [`005-provision-verify`](../005-provision-verify-elf-gates/)）；
- 具体的上架 / 分发 / 版本策略（属 `007-distribution-har-package`）；
- `tools/probe.mjs` 本身（属 `samples/minimal-app` 的取证通道；本规范只**引用**其等价命令形）。

---

## 2. 用户故事

| 角色 | 故事 |
|---|---|
| **真机验收人**（有设备+签名） | 我要一条命令让 Node 起来、并看到 PRB-01…05 的 PASS/FAIL，然后把报告导出存档，证明「这个环境 Node 可用」。 |
| **CI / 自动化** | 我要 `aa start --ps probeAuto true` 无人值守跑完，报告落沙箱；退出时页面状态可截图/可拉日志。 |
| **集成者**（无设备、只有构建机） | 我要 `assembleHap` 能编译通过，且明确知道「哪些判据没验、为什么没验（⬜）」。 |
| **排障者** | 我要每次 SKIP/FAIL 都**带原因**（stage / lastError / logPath / timeout），不出现「判不出来却显示通过」。 |

---

## 3. 功能需求

> 编号连续，`FR-101-PROBE-001` 起。**现状**列区分「已建成 ✅」「构建通过但未真机 ⬜」「有风险 ⚠️」。
> 行内引用 `plan.md` § 号作为实现落点；**本文不**出现文件路径（只出现能力名）。

### 3.1 加载与启动

| ID | 需求（RFC 2119） | 判据 | 现状 |
|---|---|---|---|
| **FR-101-PROBE-001** | 消费方 MOST 从 `@fellow99/node-bridge` 取得 `NodeRuntime` 单例，且取得过程 MUST NOT 抛异常（`loadLibrary` 路径不抛） | `getInstance()` + `bridgeVersion()` 返回非空且未抛 | ✅ 已建成（页面 PRB-01） |
| **FR-101-PROBE-002** | 启动前 MOST 先物化载荷到**可写**沙箱（C3：ArkTS 写的 Node 才读得到），并对 `start(ctx, {flags, scriptPath, env})` 的 **投递语义** 做显式断言（`ok` 与 `code` 分开看） | `ok===true` 才继续 PRB-03；`ok===false` 时把 `code`/`message` 记录为 FAIL 原因 | ✅ 已建成（页面 PRB-02） |
| **FR-101-PROBE-003** | Node 起动 MUST 以**探活命中**为准，而不是投递成功；`getStage()` 进入 `running`（或 `waitUntilRunning` 成功）才算起动 PASS | 独立超时（默认 20 s）内 `stage` 前缀为 `running` | ✅ 已建成（页面 PRB-02） |
| **FR-101-PROBE-004** | 每进程 MUST 只投递一次（C5）；换 flags MUST 要求 `force-stop` 后重开 | 页面起动一次后按钮锁定 | ✅ 已建成 |

### 3.2 起服 `/facts`

| ID | 需求 | 判据 | 现状 |
|---|---|---|---|
| **FR-101-PROBE-005** | 载荷 MUST 起一个只绑 `127.0.0.1` 的 loopback HTTP 服务（默认端口 15577，占用回退并**喊出声**，契约 §3.6） | `/facts` 返回 200 + `application/json` | ✅ 已建成（复用自检载荷，端口回退写日志） |
| **FR-101-PROBE-006** | `/facts` MUST 含冻结的 16 个 checks 键（契约 §3.6：node / platform / arch / execArgv / versions / homedir / tmpdir / homedir_redirected / tmpdir_redirected / netifaces / cpus / spawn / wasm.validate / wasm.error / fs_write_readback / hotloop_ms_5rounds） | 16 键**键名**齐全即 PASS，键名增删即 FAIL（不判值，值判在 PRB-06） | ✅ 已建成（载荷按 selfcheck 契约实现） |
| **FR-101-PROBE-007** | 健康键判据：`node` 以 `v26.13.0` 开头（目标运行时 `runtime.lock.json` active=`v26.13.0`）；`fs_write_readback === 'OK'`；`homedir_redirected === true`；`tmpdir_redirected === true`；`wasm.validate` 为布尔；`cpus === 0` 属本平台**正常**（版本/并发探测不得依赖它，D.8 偏差表） | 全部成立 ⇒ PASS；任一不成立 ⇒ FAIL（如实报实测值） | ✅ 已建成（页面 PRB-03；⚠️ 真机未验，⬜） |

### 3.3 宿主桥（文件信箱）往返

| ID | 需求 | 判据 | 现状 |
|---|---|---|---|
| **FR-101-PROBE-008** | 页面 MUST 在**同一个沙箱目录**上：① 注册 `echo` 级 handler（ArkTS 侧）；② 起动文件信箱泵；③ 让 Node 侧 `host.useFileMailbox(dir)` 指向同一目录 | `startMailbox` 返回 `started`，Node 侧 `/diag` 的 `hostBridge.transport === 'custom'` | ✅ 已建成（页面 PRB-04） |
| **FR-101-PROBE-009** | `echo` 往返 MUST 满足「写出去必须自己读回来」（C3）：ArkTS 注册的 handler 收到 Node 的 `invoke('probe.echo', {ping})` 后原样回 `{pong}`，Node 读回并**比对一致**才算往返 PASS | 载荷把往返结果暴露在 `/facts` 的 `host_roundtrip` 键，且经页面显式 POST `/rport` 复验 | ✅ 已建成（页面 PRB-04；⚠️ 真机未验，⬜） |
| **FR-101-PROBE-010** | 宿主桥 MUST NOT 静默降级：传输未接线 / 目录不可写 MUST 以**结构化失败**呈现（`transport-unavailable` / `mailbox-write-failed`），页面把错误名写进 FAIL 原因 | FAIL 文案含错误名 | ✅ 已建成 |

### 3.4 版本契约

| ID | 需求 | 判据 | 现状 |
|---|---|---|---|
| **FR-101-PROBE-011** | 页面 MUST 暴露一组**索引级常量**（库版本、目标运行时版本=锁文件 `active.node`、目标 arch） | 常量存在于源码且可读（构建期即可验证） | ✅ 已建成（页面 PRB-05） |
| **FR-101-PROBE-012** | 运行时元数据 MUST 与常量对拍：`/facts` 的 `node` 对常量 `TARGET_NODE`、`arch` 对常量 `TARGET_ARCH`；`bridgeVersion()` 与库版本常量同源声明 | 对拍一致 ⇒ PASS；不一致 ⇒ FAIL（记录两侧实测值） | ✅ 已建成（⚠️ 真机未验，⬜） |

### 3.5 报告与无头

| ID | 需求 | 判据 | 现状 |
|---|---|---|---|
| **FR-101-PROBE-013** | 每项探针 MUST 有**独立超时**；超时 ⇒ FAIL（原因含 `timeout`，附 timeoutMs），绝不让单项卡死整条流水线 | 页面 `Promise.race` + 每项独立 `timeoutMs` | ✅ 已建成 |
| **FR-101-PROBE-014** | 结果 MUST 落**沙箱文件**（`<filesDir>/probe-report.json`），结构含 `{ at, bundle, version, probes:[{id,status,detail}] }` | 文件可 `hdc shell cat` 读出 | ✅ 已建成 |
| **FR-101-PROBE-015** | 结果 MUST 同时经 `hilog` 逐行打标（`PROBE_REPORT <json>`），便于无界面拉日志 | `hilog` 行含完整 JSON | ✅ 已建成 |
| **FR-101-PROBE-016** | MUST 支持**无头**：`aa start -a EntryAbility -b <bundle> --ps probeAuto true` 后免手点自动跑完全部探针 | `probeAuto==='true'` 且前置无错时页面 `aboutToAppear` 自动开跑 | ✅ 已建成 |
| **FR-101-PROBE-017** | `probePreset` 缺省 MUST 为空串（不覆盖档位）；多词 flags 走档位索引（`aa start --ps` 只送得动一个 token，真机实测） | 档位 0 默认 `--jitless --no-verify-heap` | ✅ 已建成 |

### 3.6 三态语义

| ID | 需求 | 判据 |
|---|---|---|
| **FR-101-PROBE-018** | 每项探针 MUST 终止在 **PASS / FAIL / SKIP** 三态之一：前置未达成（如起动失败致无法起服）/ 无判定面 ⇒ SKIP；判定面齐但条件不成立或超时 ⇒ FAIL；全部成立 ⇒ PASS | 状态枚举只取三态之一 |
| **FR-101-PROBE-019** | **SKIP/FAIL MUST 带原因字段**，且原因 MUST 是**页面观测到的**事实（stage / lastError / logPath / 实测值），不许编造 | detail 非空 | 

---

## 4. 关键实体

| 实体 | 说明 |
|---|---|
| `PRB` 探针项 | 5 项：`PRB-01 加载` / `PRB-02 启动` / `PRB-03 起服` / `PRB-04 host桥` / `PRB-05 版本契约`。每项含 `id`、`title`、判据函数、独立超时。 |
| 探针状态 | `idle → running → pass\|fail\|skip`（页面内三态渲染）。 |
| `/facts` checks | 16 冻结键 + 扩展键 `host_roundtrip`（仅宿主桥往返用，不参与 16 键漂移判据）。 |
| 报告 | `probe-report.json`：`{ at, bundle, version, flags, probes:[{id,status,detail}] }`。 |
| 自检载荷 | 页面物化的**载荷脚本**（16 键 /facts + 宿主桥往返），与 `payload/selfcheck.js` 契约保持一致；`host.js` 一并物化（Node 侧宿主桥客户端）。 |

---

## 5. 验收场景

### AC-101-01（有声有设备）三分钟真机取证
有设备+签名的人按 `plan.md` §6 运行：`force-stop` → `aa start --ps probePreset 0 --ps probeAuto true` → 打开报告。**判据**：报告五项全部 PASS 或明确 SKIP（带原因），无一项「无理由 FAIL」之外的情况；`probe-report.json` 与 `hilog PROBE_REPORT` 一致。

### AC-101-02（有设备、JIT 档）档位切换
`--ps probePreset 1`（真 JIT，需 ACL）。**判据**：若 Profile 无 ACL ⇒ PRB-02 起动 FAIL（`CRASH sig=5`，页面如实 FAIL，**不是** SKIP 也不是 PASS）；有 ACL ⇒ PRB-03 `wasm.validate===true`。

### AC-101-03（无设备/无签名）构建即验收
仅 `assembleHap`。**判据**：构建 BUILD SUCCESSFUL；产物为**未签名 HAP**；`plan.md` §8 的 test-cases 设备侧 D-xx 全部 ⬜（如实登记，不编造通过）。

### AC-101-04 载荷漂移看守
`/facts` 的 16 冻结键键名增删必须被**host 测试**（`tests/payload/selfcheck-endpoints.test.mjs` `/facts 冻结键` 用例）抓住。**判据**：改键 ⇒ host 侧用例 FAIL。

### AC-101-05 无头可复现
两次 `aa start --ps probeAuto true`（中间 `force-stop`）跑出**同一套** PASS/SKIP 分布（允许时序细节差异，状态分布必须一致）。**判据**：分布一致。

---

## 6. 非功能需求

| # | 需求 | 判据 / 现状 |
|---|---|---|
| NFR-1 | **arm64 唯一**：`deviceTypes` 只 `2in1`/`tablet`，不编造 phone/x86_64（🔶 同工程既有口径） | `module.json5` deviceTypes 只两项 |
| NFR-2 | **App 域**：全部能力经 `@fellow99/node-bridge` 消费；不 import 其它第三方包 | `oh-package.json5` 只一条 `file:../library` 依赖 |
| NFR-3 | **无外部网络**：载荷只绑 `127.0.0.1`；报告/日志只在沙箱与 loopback | 载荷监听地址 `127.0.0.1`（MUST NOT `0.0.0.0`） |
| NFR-4 | **JIT 需 ACL**：无 ACL 时 MUST 用 `--jitless`（默认档）；真 JIT 档 MUST 声明 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 或在判据表注明 → 否则 SIGTRAP | 档位 0 默认带 `--jitless`；ACL 声明见 `module.json5` |
| NFR-5 | **离线可构建**：依赖用本地 `file:` 路径，不要求 ohpm 在线源 | `ohpm install` 离线可解 |
| NFR-6 | **失败可见**：任何 FAIL/SKIP 带原因；不出现「判不出却显示通过」（C2） | 判据 FR-101-PROBE-019 |
| NFR-7 | **一次只跑报告一套键**：键名冻结（16 + `host_roundtrip`），键值可漂但键名不可漂（契约 §3.6） | host 用例看守 |

---

## 7. 假设与约束

| # | 假设 / 约束 | 依据 |
|---|---|---|
| A1 | 目标运行时为 `v26.13.0`（`runtime.lock.json` active，SONAME `libnode.so.147`）；**仓库内无 `.so`** ⇒ 本批真实机断言 ⬜ | `library/src/main/resources/rawfile/node_bridge/runtime.lock.json` |
| A2 | 本机**无在线设备、无签名材料**：`hdc list targets`=[Empty]；只能 `assembleHap` 出未签名包 ⇒ 设备侧 D-xx 全部 ⬜ | 本机实测（2026-11-05） |
| A3 | AppScope 的 `bundleName` 全局唯一，probe-app 与 minimal-app 共用（工程模型所限）；取 `org.fellow99.nodebridge.probe` | AppScope/app.json5 |
| A4 | `probe-app` 是第二个 HAP ⇒ 模块类型必须 `feature`（minimal-app 已占 `entry`） | Stage 模型约束 |
| A5 | `aa start --ps` 只送得动一个 token ⇒ 一律走档位索引 | minimal-app 真机实测 |
| A6 | 页面/载荷不得引入应用语义（C1）；库不认识探针键 | 宪法 C1 |

---

## 8. 依赖

| 方向 | 依赖对象 | 说明 |
|---|---|---|
| **上游（必须已实现）** | `001`–`007` 的 library 公共 API（`NodeRuntime` / `HostBridge` / `Env` / `Types`） | 本模块只消费；导出面冻结在 `library/Index.ets:18-24` |
| **上游（事实源）** | `runtime.lock.json` | 版本断言（`TARGET_NODE=v26.13.0`）来自它，只引用不复制 |
| **上游（载荷）** | `payload/selfcheck.js` 契约、`payload/host.js` | 载荷脚本按同一契约实现；`host.js` 原样随包 |
| **测试（host）** | `tests/payload/*.test.mjs` | host 侧判据（16 键漂移、host-bridge 语义、selfcheck 端点） |
| **构建期** | CLT `ohpm`/`hvigorw`、hvigor 6.1.1 模型 | `ohpm install` → `hvigorw assembleHap` |
| **下游** | 无（它是消费端；产物是 HAP） | — |
