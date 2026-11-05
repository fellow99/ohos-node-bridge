# specs/101-probe-app —— 说明

> 工程：`ohos-node-bridge` · 本目录生成日期：2026-11-05

## 这是什么

本目录是一份**消费侧 / 探针侧规范**（编号 101+），与 `specs/001`–`007` 的**模块规范**（M-01…M-07，
描述 `library/` 自身的内部件）相区分：

- `001`–`007`：描述 **`library/` 这个 HAR 的内部件**（运行时核心 / NAPI 引导 / 宿主桥 / 载荷 / 供给 / 观测 / 分发）。
- `101-probe-app`：描述**一个新的 HAP 消费样例 `probe-app/`**——它消费 `@fellow99/node-bridge`，
  用结构化探针逐项验证「Node 真的起来了、起服了、宿主桥通了、版本契约吻合」，并落沙箱报告。

因此 `101-*` 不挤占模块编号位，也不改 `SPECS_CHECKLIST.md`（那是模块文档的追踪表）。本目录
自带 `spec.md` / `plan.md` / `tasks.md` / `test-cases.md` 四件套作为它自己的完成度追踪。

## 依赖的既有结论（只引用，不复制）

- `specs/overall-spec.md` / `overall-plan.md` / `overall-data-model.md` / `overall-test-cases.md`
- `specs/constitution.md`（C1…C7 / S1…S10）
- `payload/selfcheck.js`（16 个冻结 checks 键，契约 §3.6）
- `payload/host.js`（Node 侧宿主桥客户端 + 文件信箱协议）
- `library/src/main/ets/**`（`NodeRuntime` / `HostBridge` / `Env` / `Types` 的公共 API）
- `docs/000-工程规划.md`（权威规划）
