# 规格文档索引 —— `ohos-node-bridge`

**项目名称：** `ohos-node-bridge`（ohpm 包名 `@fellow99/node-bridge`）
**需求：** **000-scaffold 工程搭建** · 规范文档存放目录：`specs/`
**库版本：** `0.1.0`（骨架；Phase 0 已验证，Phase 1 进行中）
**技术栈：** ArkTS 组件库（HAR）+ NAPI 引导件（C11/CMake）+ Node.js v24.2.0（`libnode.so`，进程内 `dlopen` + `node::Start`）+ host 侧纯 Node/Python 工具链
**文档生成时间：** 2026-10-16 · **最后更新：** 2026-10-16

> **权威规划文档是 [`../docs/000-工程规划.md`](../docs/000-工程规划.md)（v0.9）。**
> 本目录是它的**收敛/展开版**：只做细化与验收，**不复制粘贴**，所有结论回引规划的 § 号，避免两份文档漂移。
> 新增平台结论必须先写进规划文档，再回到这里引用。

---

## 一、文档总览

| 层级 | 分类 | 文档数量 | 说明 |
|---|---|---|---|
| 整体 | 项目级顶层文档 | 5 | `constitution.md` · `ARCHITECTURE.md` · `TECH.md` · `STRUCTURE.md` · `SPECS_CHECKLIST.md` |
| 整体 | 整体规格文档 | 4 | `overall-spec.md` · `overall-plan.md` · `overall-data-model.md` · `overall-test-cases.md` |
| 模块 | 运行时核心（`001`–`002`） | 4 | 生命周期与状态机 · NAPI 原生加载 |
| 模块 | 能力与载荷（`003`–`004`） | 4 | 宿主能力桥 · 载荷引导与入口解析 |
| 模块 | 供给与观测（`005`–`007`） | 6 | ELF 门禁与投放 · 日志环与崩溃取证 · HAR 分发 |
| 索引 | 本索引 | 1 | `README.md` |
| **合计** | **8 目录 / 24 文件** | | 其中模块目录 7 个，模块文档 14 份 |

> **刻意不生成** `API.md` 与 `overall-api.md`：本库**不对外提供 HTTP/RPC 接口**，它是一组 ArkTS 类与函数
> （`Index.ets` 导出 8 个符号）。对外契约面见 [`overall-spec.md`](./overall-spec.md) §3 与各模块 `plan.md` 的
> 「接口契约」；HTTP/SSE 数据面属**消费方** `pi-desktop-ark`（见其规划 §4）。

---

## 二、项目级顶层文档

全局性的架构、技术、宪法与结构文档，定义项目基线与开发准则。

| 文档 | 路径 | 说明 |
|---|---|---|
| **项目宪法** | [constitution.md](./constitution.md) | 7 条不可协商原则（C1 库/壳分离 · C2 不隐藏平台真相 · C3 让最终使用者去读 · C4 启动参数不可事后修改 · C5 单例与不可重启 · C6 诊断优先于修码 · C7 零上游补丁优先）+ 10 条代码规约（S1–S10）+ 证据纪律 + 合规红线 + 评审清单 |
| **整体架构** | [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层与责任边界、进程/线程模型、启动时序、六条硬约束与 ⑰⑱ 的实现落点对照表、关键架构决策、观测面 |
| **技术选型** | [TECH.md](./TECH.md) | 技术/版本/用途/选型理由；含**被否掉的方案**（Electron、子进程、`--jitless` 产品路径、PIE 产物、HAR 带 `.so`）与体积/许可口径 |
| **项目结构** | [STRUCTURE.md](./STRUCTURE.md) | 完整目录树 + 逐文件用途 + 目录↔模块编号映射 + 构建产物落点 + 不入库清单 |
| **检查清单** | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | 规格文档完成度追踪（项目级 + 模块级）+ 质量检查 + 未闭合项 |

### 整体规格文档

跨模块的全局规格、方案、数据模型与测试索引。

| 文档 | 路径 | 说明 |
|---|---|---|
| **整体规格** | [overall-spec.md](./overall-spec.md) | 技术无关的能力需求（`FR-OVR-*`，RFC 2119）、非功能需求、系统边界、可证伪验收判据 |
| **整体方案** | [overall-plan.md](./overall-plan.md) | 技术上下文、宪法合规检查、实现策略与阶段对应、跨切面关注点、测试与分发策略 |
| **数据模型** | [overall-data-model.md](./overall-data-model.md) | `runtime.lock.json` 全字段、ArkTS 对外类型、运行时状态机、宿主桥消息模型、文件系统实体、环境变量契约 |
| **测试用例索引** | [overall-test-cases.md](./overall-test-cases.md) | 五层测试分层 + `TC-OVR-*` / `TC-0NN-*` 用例族索引 + 真机四条取证通道 + **禁止的判据** + 真机基线数值 |

---

## 三、运行时核心（`001`–`002`）

### 001 — 运行时核心 · 生命周期与状态机 (`runtime-core-lifecycle`)

> ArkTS 侧的运行时单例与生命周期编排：进程内唯一实例、`idle → starting → running → failed` 状态机、
> `start()` 的**投递语义**与幂等保护、原生探针、`NodeRuntimeOptions`/`NodeStartResult`/`NodeState` 对外契约。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [001-runtime-core-lifecycle/spec.md](./001-runtime-core-lifecycle/spec.md) | 运行时核心功能规格（需求、用户故事、验收场景） |
| 技术方案 | [001-runtime-core-lifecycle/plan.md](./001-runtime-core-lifecycle/plan.md) | 生命周期与状态机技术实现方案（含一致性/幂等保障） |

### 002 — NAPI 引导 · 原生加载与启动 (`napi-bootstrap-native-loader`)

> 进程内原生引导件 `libnode_bridge.so` 的全部 C 侧职责：NAPI 模块注册、detached pthread（32 MB 栈）、
> `SIGSYS` shim、`dlopen`/`dlsym`、argv 构造（**不含尾部 NULL 哨兵**）、stdio 通道重建与排空、崩溃取证。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [002-napi-bootstrap-native-loader/spec.md](./002-napi-bootstrap-native-loader/spec.md) | NAPI 引导件功能规格 |
| 技术方案 | [002-napi-bootstrap-native-loader/plan.md](./002-napi-bootstrap-native-loader/plan.md) | NAPI 引导件技术实现方案（含真实文件行数与缺陷登记） |

---

## 四、能力与载荷（`003`–`004`）

### 003 — 宿主能力桥 · JSON 传输与注册表 (`host-bridge-json-transport`)

> Node ⇄ ArkTS 双向调用桥：ArkTS 侧注册表与分发、**永不抛异常**的结构化错误、语言中立的可序列化载体、
> 超时与载荷上限；库只提供寄存器与传输，**每个能力的实现属消费方**。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [003-host-bridge-json-transport/spec.md](./003-host-bridge-json-transport/spec.md) | 宿主能力桥功能规格 |
| 技术方案 | [003-host-bridge-json-transport/plan.md](./003-host-bridge-json-transport/plan.md) | 宿主能力桥技术实现方案（含 JSON 构造缺陷与修法） |

### 004 — 载荷引导 · 解包与入口解析 (`payload-bootstrap-entry-resolver`)

> 「Node 起来之后、应用逻辑之前」的那一段：载荷定位（**只读直读优先** / `tar.gz` 自解包）、SHA-256 幂等、
> CJS/ESM 入口解析、工作目录约束、环境契约消费、未捕获异常兜底与独立日志通道。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [004-payload-bootstrap-entry-resolver/spec.md](./004-payload-bootstrap-entry-resolver/spec.md) | 载荷引导功能规格 |
| 技术方案 | [004-payload-bootstrap-entry-resolver/plan.md](./004-payload-bootstrap-entry-resolver/plan.md) | 载荷引导技术实现方案（含 ustar 状态机与路径安全） |

---

## 五、供给与观测（`005`–`007`）

### 005 — 运行时获取与校验 · ELF 门禁与投放 (`provision-verify-elf-gates`)

> host 侧工具链：`runtime.lock.json` 作为唯一事实源、**七项 ELF 门禁** + SHA-256 硬校验、幂等投放、
> 来源优先级与自动回退、中间产物不外泄进 HAP、自签（仅服务独立分发）。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [005-provision-verify-elf-gates/spec.md](./005-provision-verify-elf-gates/spec.md) | 运行时获取与校验功能规格 |
| 技术方案 | [005-provision-verify-elf-gates/plan.md](./005-provision-verify-elf-gates/plan.md) | 投放与门禁技术实现方案（含候选产物评估与演进路线） |

### 006 — 观测 · 日志环与崩溃取证 (`observability-logring-crash`)

> 双通道日志（hilog + 落盘）、信号安全的崩溃写入、有界日志环、跨启动可读的崩溃记录、
> 端到端自检端点（`/facts` 即一次真机成功运行的证书）与「读回优先于写成功断言」的纪律。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [006-observability-logring-crash/spec.md](./006-observability-logring-crash/spec.md) | 观测与崩溃取证功能规格 |
| 技术方案 | [006-observability-logring-crash/plan.md](./006-observability-logring-crash/plan.md) | 观测技术实现方案（含日志行格式与判据纪律） |

### 007 — 分发 · HAR 包与接入契约 (`distribution-har-package`)

> 发布物形态与接入契约：HAR **不含** `libnode.so`、barrel 导出面、权限声明最小化、语义化版本与运行时版本矩阵、
> 消费方三步接入、以及为什么在同一 `useNormalizedOHMUrl` 工程下必须用 `.har` 而不是源目录。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [007-distribution-har-package/spec.md](./007-distribution-har-package/spec.md) | 分发与接入功能规格 |
| 技术方案 | [007-distribution-har-package/plan.md](./007-distribution-har-package/plan.md) | 分发技术实现方案（含 HAR 实测内容清单与体积核对） |

---

## 六、模块编号一览

| 编号 | 模块名 | 二级模块 | 英文名 | 分类 | 规划出处 |
|---|---|---|---|---|---|
| 001 | 运行时核心 | 生命周期与状态机 | runtime-core-lifecycle | 运行时 | §7.3 |
| 002 | NAPI 引导 | 原生加载与启动 | napi-bootstrap-native-loader | 运行时 | §7.3 |
| 003 | 宿主能力桥 | JSON 传输与注册表 | host-bridge-json-transport | 能力 | §7.3 |
| 004 | 载荷引导 | 解包与入口解析 | payload-bootstrap-entry-resolver | 载荷 | §7.3 |
| 005 | 运行时获取与校验 | ELF 门禁与投放 | provision-verify-elf-gates | 供给 | §7.3 |
| 006 | 观测 | 日志环与崩溃取证 | observability-logring-crash | 观测 | §7.3 |
| 007 | 分发 | HAR 包与接入契约 | distribution-har-package | 分发 | §7.3 |
| 2NN | 扩展 / 样例 | 从 201 起 | `201-sample-*` … | 样例 | §7.2（⬜ 未开始） |

> 编号 `008`–`099` 与 `2NN` 为**预留编号**（规划 §7.3 约定：扩展/样例自 `201` 起）。

---

## 七、模块文档结构规范

每个模块目录 `NNN-<模块>-<二级模块>/` 下**必须成对**提供以下两份文档：

| 文件 | 命名 | 说明 |
|---|---|---|
| 功能规格 | `spec.md` | **技术无关**：模块目的、解决的问题、范围边界、用户故事、功能需求（`FR-0NN-NNN`，RFC 2119 的 MUST/SHOULD/MAY）、关键实体、验收场景（Given/When/Then，编号 `AC-0NN-NN`）、非功能需求、假设与约束、依赖 |
| 技术方案 | `plan.md` | **实现特定**：技术上下文与依赖版本、宪法合规检查（逐条 ✅/⚠️/❌ + 理由）、研究结论与替代方案、数据模型、接口契约（提供/消费/事件协议）、实现策略（架构模式/关键算法/错误处理/性能）、测试考虑（呼应 `overall-test-cases.md` 的 `TC-0NN-*`）、文件清单（**真实行数**）、待实现清单 + 验收判据 |

> 复杂模块可再追加：
> - `tasks.md` — 任务拆解、依赖关系、里程碑
> - `test-cases.md` — 模块级测试用例（本库当前统一由 `overall-test-cases.md` 的用例族覆盖，未单独立文件）

**三条纪律**：

1. `spec.md` 写「做什么、验收判据是什么」；`plan.md` 写「怎么做」。两份都**回引** `docs/000-工程规划.md` 的 § 号。
2. `spec.md` 不出现框架名与文件路径；`plan.md` 不出现没有源码依据的断言。
3. as-built 与 planned 必须逐条区分：未实现的写 `⬜ 规划未实现（Phase N）`，**不得**把规划当既成事实。

---

## 八、快速导航

| 目标读者 | 推荐阅读顺序 |
|---|---|
| **新加入开发者** | `constitution.md` → `STRUCTURE.md` → `overall-spec.md` → `ARCHITECTURE.md` → 目标模块的 `spec.md` |
| **架构师 / Tech Lead** | `ARCHITECTURE.md` → `TECH.md` → `overall-plan.md` → `overall-data-model.md` → 规划文档 §4/§5 |
| **库的实现者** | `constitution.md` §二（代码规约）→ 目标模块 `plan.md` → 该模块 `spec.md` → 规划文档对应 § 与 §D.8 实测 |
| **库的消费方（`pi-desktop-ark`）** | 规划文档 **§6 对接契约** → `overall-spec.md` → `007-distribution-har-package/plan.md` §5（接入契约）→ `overall-data-model.md`（环境契约） |
| **测试 / QA** | `overall-test-cases.md` → `SPECS_CHECKLIST.md` → 各模块 `plan.md` §7（测试考虑） |
| **合规 / 上架** | `constitution.md` §四（合规红线）→ 规划文档 §4.8 / §9.5 → `007-distribution-har-package/spec.md` |
| **排障 / 值班** | `006-observability-logring-crash/plan.md` → 规划文档 §5.7 + **附录 B（症状 → 处置映射）** + §D.8 |

### 快照命令（先看证据，再看结论）

```bash
node tools/provision.mjs --check                                    # 七项 ELF 门禁 + SHA-256
node tools/provision.mjs --list                                     # 打印锁定项
python tools/elf-inspect.py <模块>/libs/arm64-v8a/libnode.so        # 六项自解析检查
node tools/smoke-host.mjs                                           # host 侧门禁（不接真机）
hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts   # ★ 端到端证书
```

---

**文档维护者：** `ohos-node-bridge` 开发团队 · **权威来源：** [`../docs/000-工程规划.md`](../docs/000-工程规划.md)
