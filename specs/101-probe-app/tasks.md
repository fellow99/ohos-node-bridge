# tasks.md —— `101-probe-app` 任务清单

> 状态口径：✅ 完成 · ⬜ 待做（含「待真机/待签名」）· ⚠️ 部分。
> 生成：2026-11-05。本文件无 TODO/TBD（待验证项用 ⬜ + 原因）。

| # | 任务 | 归属 | 依赖 `spec` | 状态 |
|---|---|---|---|---|
| T-01 | 建 `specs/101-probe-app/` 四件套（README/spec/plan/tasks/test-cases） | 规范 | — | ✅ 本批 |
| T-02 | 建 `probe-app/` 模块目录骨架（module.json5 / build-profile / hvigorfile / oh-package / resources） | 实现 | T-01 | ✅ 本批 |
| T-03 | `rawfile/probe-app.js`：16 冻结键 /facts + loopback 服务 + 宿主桥往返 | 实现 | spec FR-005…010 | ✅ 本批（静态构建验证） |
| T-04 | `rawfile/host.js`：随包复制 `payload/host.js` | 实现 | spec FR-008 | ✅ 本批 |
| T-05 | `EntryAbility.ets`：`probePreset/probeFlags/probeAuto` 传参 | 实现 | spec FR-016/017 | ✅ 本批 |
| T-06 | `Index.ets`：PRB-01…05 + 独立超时 + 三态 + 落盘/hilog | 实现 | spec FR-001…019 | ✅ 本批（静态构建验证） |
| T-07 | 根 `build-profile.json5` 注册 `probe-app` 模块 | 实现 | plan §3.2 | ✅ 本批 |
| T-08 | `AppScope/app.json5` 换 bundleName `org.fellow99.nodebridge.probe` | 实现 | plan §3.2 | ✅ 本批 |
| T-09 | `ohpm install --all`（离线 file: 依赖） | 构建 | — | ✅ 本批（见报告） |
| T-10 | `hvigorw assembleHap --mode module -p module=probeapp@default` | 构建 | — | 见报告（BUILD SUCCESSFUL / 报错原文） |
| T-11 | 记录产物 HAP 路径（unsigned），落 `logs/20261105-1/DEV_CHECKLIST.md` | 证据 | — | ✅ 本批（构建后补事实行） |
| T-12 | host 侧 16 键漂移看守：`tests/payload/selfcheck-endpoints.test.mjs` 对 `rawfile/probe-app.js` 键面复核 | 测试 | AC-101-04 | ✅ 本批（对照复核，见 test-cases） |
| T-13 | 真机 PRB-01…05 全 PASS 取证（bundle `org.fellow99.nodebridge.probe`，preset 0） | 真机 | AC-101-01 | ⬜ 无设备 / 无签名材料（`hdc list targets`=[Empty]） |
| T-14 | 档位 1（真 JIT / ACL）真机验证 | 真机 | AC-101-02 | ⬜ 无 ACL Profile ± 无设备 |
| T-15 | `tools/probe.mjs` 增加 probe-app 目标（新 bundle/模块/hap 路径）与 `--bundle` 参数 | 工具 | plan §3.2 注 | ⬜ 未做（共享工具，另一 agent 领地；已登记） |
