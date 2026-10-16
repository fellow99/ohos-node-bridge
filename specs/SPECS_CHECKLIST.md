# SPECS_CHECKLIST.md —— 规格文档完成度追踪

> 工程：`ohos-node-bridge`（`@fellow99/node-bridge`）· 需求：**000-scaffold 工程搭建**
> 规范文档存放目录：`specs/` · 生成日期：**2026-10-16**
> 权威规划文档：[`../docs/000-工程规划.md`](../docs/000-工程规划.md)（v0.9，**结论以它为准**）
>
> 状态口径：✅ 已完成 · ⚠️ 已完成但含未闭合项（见备注）· ⬜ 待生成

---

## 一、项目级文档

| # | 文档 | 路径 | 状态 | 说明 |
|---|---|---|---|---|
| P-01 | 项目宪法 | [constitution.md](./constitution.md) | ✅ | 7 条不可协商原则（C1–C7）+ 10 条代码规约（S1–S10）+ 证据纪律 + 合规红线 + 评审清单 |
| P-02 | 整体架构 | [ARCHITECTURE.md](./ARCHITECTURE.md) | ✅ | 分层、进程/线程模型、启动时序、硬约束落点对照表、关键决策、责任分界、观测面 |
| P-03 | 技术选型 | [TECH.md](./TECH.md) | ✅ | 技术/版本/用途/选型理由，含被否掉的方案与理由、体积与许可 |
| P-04 | 目录结构 | [STRUCTURE.md](./STRUCTURE.md) | ✅ | 目录树 + 逐文件用途 + 模块编号映射 + 不入库清单 |
| P-05 | 整体规格 | [overall-spec.md](./overall-spec.md) | ✅ | 技术无关的能力需求（`FR-OVR-*`）、非功能需求、系统边界、可证伪验收判据 |
| P-06 | 整体技术方案 | [overall-plan.md](./overall-plan.md) | ✅ | 技术上下文、宪法合规检查、实现策略、跨切面、测试与分发策略 |
| P-07 | 数据模型 | [overall-data-model.md](./overall-data-model.md) | ✅ | `runtime.lock.json` 全字段、ArkTS 类型、状态机、宿主桥消息、文件系统实体、环境契约 |
| P-08 | 测试用例索引 | [overall-test-cases.md](./overall-test-cases.md) | ✅ | 五层测试 + `TC-OVR-*`/`TC-0NN-*` 用例族索引 + 真机四通道 + 禁止的判据 |
| P-09 | 规格检查清单 | SPECS_CHECKLIST.md | ✅ | 本文件 |
| P-10 | 规格索引 | [README.md](./README.md) | ✅ | 项目/文档介绍 + 全量文件索引 + 模块编号一览 + 快速导航 |
| — | `API.md` / `overall-api.md` | — | ⛔ 刻意不生成 | 本库**不对外提供 HTTP/RPC API**：它是一组 ArkTS 类/函数（8 个导出符号）。对外契约面已在 `overall-spec.md` §3、`overall-plan.md` §5.1 与各模块 `plan.md` 的「接口契约」中给出；数据面（HTTP/SSE）属**消费方** `pi-desktop-ark`（见其规划 §4）。 |

---

## 二、模块级文档（编号依规划 §7.3）

| # | 模块 | 目录 | spec.md | plan.md | 状态 | 备注 |
|---|---|---|---|---|---|---|
| M-01 | 运行时核心 · 生命周期与状态机 | [`001-runtime-core-lifecycle/`](./001-runtime-core-lifecycle/) | ✅ | ✅ | ⚠️ | `stopping`/`stopped`、`waitUntilRunning`、`logs`、`lastCrash`、`shutdown`、`host` 属 Phase 1/2 未实现 |
| M-02 | NAPI 引导 · 原生加载与启动 | [`002-napi-bootstrap-native-loader/`](./002-napi-bootstrap-native-loader/) | ✅ | ✅ | ⚠️ | Phase 1 已在 `node_bridge.c` 落地 stdio pipe+reader、崩溃记录 JSON、`lastError()`/`stage()`；剩余 `--inspect` 与 Addon 符号可见性（R18/O11） |
| M-03 | 宿主能力桥 · JSON 传输与注册表 | [`003-host-bridge-json-transport/`](./003-host-bridge-json-transport/) | ✅ | ✅ | ⚠️ | ArkTS 侧注册表与结构化错误已落地；**`napi_threadsafe_function` 传输层属 Phase 2**（当前为同线程直调） |
| M-04 | 载荷引导 · 解包与入口解析 | [`004-payload-bootstrap-entry-resolver/`](./004-payload-bootstrap-entry-resolver/) | ✅ | ✅ | ⚠️ | tar.gz 自解包 + SHA-256 幂等 + CJS/ESM 入口解析 + 异常兜底属 Phase 1 待补 |
| M-05 | 运行时获取与校验 · ELF 门禁与投放 | [`005-provision-verify-elf-gates/`](./005-provision-verify-elf-gates/) | ✅ | ✅ | ✅ | 七项门禁 / 幂等投放 / 自签三件套均已实现并实测 |
| M-06 | 观测 · 日志环与崩溃取证 | [`006-observability-logring-crash/`](./006-observability-logring-crash/) | ✅ | ✅ | ⚠️ | 日志环/崩溃记录 JSON 形态已定；stdio 通道分离与 hilog 级别策略属 Phase 1 待补 |
| M-07 | 分发 · HAR 包与接入契约 | [`007-distribution-har-package/`](./007-distribution-har-package/) | ✅ | ✅ | ⚠️ | HAR 形态已实测；**第三方许可清单与 `payload/` 落点**为 Phase 2 交付物（G4） |

**每个模块目录下必须成对提供 `spec.md`（需求与验收）与 `plan.md`（设计与实现方案）**；复杂模块可再追加 `tasks.md` / `test-cases.md`（当前 7 个模块均由 `overall-test-cases.md` 的用例族覆盖，未单独立文件）。

---

## 三、生成顺序与依据

1. **先整体、后模块**：项目级文档（P-01…P-08）先建立术语、证据口径与模块编号，模块文档再细化 —— 避免前后引用不存在的文件。
2. **最后生成索引**：`README.md` 与 `SPECS_CHECKLIST.md` 在全部文档完成后按**实际目录内容**扫描生成，不预测结构。
3. **不复制粘贴**：所有结论回引 `docs/000-工程规划.md` 的 § 号，避免两份文档漂移；新增平台结论必须先落规划文档。
4. **证据标记**：每条非显然结论带 ✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突 之一（口径见 `constitution.md` §三）。

---

## 四、质量检查

| 检查项 | 结果 |
|---|---|
| 每条结论可回溯到源码或规划 § 号 | ✅ |
| 无占位内容（`TODO` / `TBD` / 「待补充」） | ✅ |
| `spec.md` 不含实现细节（框架名、文件路径） | ✅ |
| `plan.md` 引用真实文件路径与真实行数 | ✅ |
| `plan.md` 交叉引用本模块 `spec.md` 的 `FR-0NN-*` | ✅ |
| 每个模块都同时有 `spec.md` 与 `plan.md` | ✅（7/7） |
| 模块边界在 spec 与 plan 之间一致 | ✅ |
| `README.md` 链接全部指向存在的文件 | ✅ |
| 模块数与 `NNN-*/` 实际目录数一致 | ✅（7/7） |
| as-built 与 planned 已逐条区分（⬜ 标记） | ✅ |

---

## 五、未闭合项（不属文档缺失，属**实现**阶段工作）

| 项 | 归属 | 依据 |
|---|---|---|
| `tools/build-bridge.mjs` / `tools/smoke-host.mjs`（host 侧门禁与「一条命令可复现构建」） | Phase 1 | 规划 §7.4 |
| `samples/minimal-app` / `samples/arkweb-http`（样例工程与 `build-profile.json5` 注册） | Phase 1/2 | 规划 §7.2 |
| 第三方许可清单文件（G4） | Phase 2/3 | 规划 §9.5 G4 |
| ohpm 首发与 `@fellow99` scope 归属确认 | Phase 3 | 规划 §9.3 |
| 公开镜像 Release（附录 G 路线 B） | 触发式 | 规划 附录 G.6 |
| 自建 `libnode.so`（附录 G 路线 C） | 触发式 | 规划 附录 D |
| `--inspect` 调试通道（仅 debug 构建） | Phase 1 | 规划 §5.7 / P0-9 |
| NAPI Addon 符号可见性（R18 / O11） | Phase 1 | 规划 §5.8 / §9.2 |
