# test-cases.md —— `101-probe-app` 判据表

> 判据口径：**PRB-xx** = 页面探针五项；**H-xx** = host 侧（Node 24 + `tests/payload/*.test.mjs`，本机可跑）；
> **D-xx** = 设备侧（真机 + 签名后），本批**无设备/无签名 ⇒ 一律 ⬜**，如实登记，不编造。
> 每行独立 `#` 前缀以利 grep。生成：2026-11-05。

---

## 1. PRB 判据表（页面 `Index.ets`，五项各独立超时，三态 PASS/FAIL/SKIP）

| ID | 判定面 | PASS 判据 | FAIL 判据 | SKIP 判据 | spec |
|---|---|---|---|---|---|
| #PRB-01 | 加载 | `NodeRuntime.getInstance()` 成功且 `bridgeVersion()` 非空、未抛 | 取得/读版本抛异常（如 `.so` 未投放）⇒ FAIL（原因=异常） | — | FR-001 |
| #PRB-02 | 启动 | `start()` 返回 `ok===true`；随后 `getStage()` 前缀 `running`（或 `waitUntilRunning(20s)` 不抛） | `ok===false` ⇒ FAIL（code+message）；25 s 内 stage 未到 running ⇒ FAIL（附 stage/lastError/logPath） | — | FR-002/003/004/017 |
| #PRB-03 | 起服 | GET `http://127.0.0.1:15577/facts` 200；16 冻结键键名齐；健康键（`node` 前缀 `v26.13.0` / `fs_write_readback==='OK'` / `homedir_redirected===true` / `tmpdir_redirected===true`）成立 | 非 200 / 键名缺 / 健康键不成立 ⇒ FAIL（附实测值/HTTP code） | PRB-02 FAIL ⇒ SKIP（原因=前置） | FR-005/006/007 |
| #PRB-04 | host桥 | `runtime.host.register('probe.echo')` + `startMailbox(payloadDir,100)` 返回 `started`；POST `/rport` 200 且 `reply.ping==='pong'`；`/facts.host_roundtrip.ok===true` | 超时 25 s / 响应非 200 / `ok!==true`（含 `transport-unavailable`、`mailbox-write-failed` 等结构化错误）⇒ FAIL | PRB-02 FAIL ⇒ SKIP | FR-008/009/010 |
| #PRB-05 | 版本契约 | `/facts.node` 前缀==`TARGET_NODE`('v26.13.0')；`/facts.arch` 前缀==`TARGET_ARCH`('arm64-v8a')；`bridgeVersion()` 非空 | 对拍不一致 ⇒ FAIL（记录两侧值） | 无 `/facts` ⇒ SKIP | FR-011/012 |

> 三态收口：每项最终只落 `pass|fail|skip` 之一（FR-018），且 `fail`/`skip` 必须带原因（FR-019）。

---

## 2. host 用例（本机 Node 24 可直接跑，`tests/payload/*.test.mjs`）

> 下列为**已有** host 用例，本模块**直接引用**（漂移看守，不重复实现）：

| ID | 用例文件 | 覆盖 | 与 probe-app 关系 |
|---|---|---|---|
| #H-01 | `tests/payload/selfcheck-endpoints.test.mjs:200` | `/facts` 200 + 冻结 16 个 checks 键 | `rawfile/probe-app.js` 键面必须同源（清单§4 NFR-7） |
| #H-02 | `tests/payload/host-bridge.test.mjs:47-124` | invoke 无传输 reject / payload-too-large / 自定义传输 ok / timeout | PRB-04 的结构化错误语义同源 |
| #H-03 | `tests/payload/host-bridge.test.mjs:127` | handle/list/facts() 字段面 | Node 侧 `host.handle('probe.echo')` 语义 |
| #H-04 | `tests/payload/sample-wiring.test.mjs:20-85` | modules[] 注册样式 / file: 依赖 / 权限成对 / 载荷只绑 127.0.0.1 | probe-app 模块注册与权限同样式可对拍 |
| #H-05 | `tests/payload/selfcheck-endpoints.test.mjs:221-262` | /log /diag /rport /404 四端点 | PRB-04 的 `/rport` 语义可参照 |

> #H-01..05 本批「对照复核」= 人工核对 `rawfile/probe-app.js` 键面与 `selfcheck` 契约一致
>（未改 `tests/` 任何文件 —— 那是另一 agent 领地，Task T-15 已登记工具侧待办）。

---

## 3. 载荷冒烟（host Node，不替代真机）

| ID | 步骤 | 判据 |
|---|---|---|
| #S-01 | `node probe-app/src/main/resources/rawfile/probe-app.js`（设 `PROBE_MAILBOX_DIR=<tmp>`） | 打印 `listening 127.0.0.1:<port>`；`/facts` 200 且 16 键齐；host Node 无 ArkTS 信箱泵 ⇒ `host_roundtrip={ok:false,wired:true,err:invoke:timeout…}`（结构化失败如实呈现）；`/rport` 返回 502 + 同样原因（本批实测通过，Node v24.7.0） |


> ⬜ 本批在构建后进行（见验证段）；Node v24 与目标 v26.13.0 行为差异如实记录，不默认为一致。

---

## 4. 设备侧判据（D-xx）—— 本批无一可跑

> **前置**：在线鸿蒙设备（`hdc list targets` 非 Empty）+ 签名材料（`signing.debug.local.json` 或
> DevEco AUTO）+ `libnode.so` 已投放（`runtime.lock.json` active=v26.13.0）。三者本机 2026-11-05 均不具备。

| ID | 步骤 | 期望（就绪后） | 本批状态 |
|---|---|---|---|
| #D-01 | install signed HAP（bundle `org.fellow99.nodebridge.probe`） | `install -r` success | ⬜ 无设备/无签名/无 signed HAP |
| #D-02 | `aa force-stop` + `aa start --ps probePreset 0 --ps probeAuto true` | 起动成功，页面自动跑完 | ⬜ |
| #D-03 | `cat …/files/probe-report.json` | 五项 PASS（或明确 SKIP 带原因） | ⬜ |
| #D-04 | `hdc fport tcp:15577 tcp:15577` + `curl /facts` | 200 + `node=v26.13.0…` | ⬜ |
| #D-05 | 档位 1（真 JIT） | 无 ACL ⇒ PRB-02 FAIL（CRASH sig=5）；有 ACL ⇒ `wasm.validate===true` | ⬜ 无 ACL Profile |
| #D-06 | 无头复现两次（D-02 ×2） | PASS/SKIP 分布一致 | ⬜ |

---

## 5. 禁止判据（MUST NOT，任何报告不得出现）

- 把「**构建成功**」写成「**真机通过**」——两者是不同事实；
- 无 `.so` 时把 PRB-02/03 判成 PASS（`.so` 未投放 ⇒ 必须如实 FAIL 或 SKIP，不可 PASS）；
- FAIL/SKIP 不带原因、或用「看起来通过」的推断替代实测值（C2）；
- 16 冻结键增删后仍报「键面合规」（被 #H-01 看守，除非同时改契约）；
- `module.json5` 声明 `0.0.0.0` 监听或把报告/载荷日志写到应用沙箱外。

---

## 6. 构建产物登记（2026-11-05 实测，任务 §三）

| 项 | 值 |
|---|---|
| 产物（无签名） | `probe-app/build/default/outputs/default/probeapp-default-unsigned.hap`（1,648,183 B，2026-11-05 实证） |
| 构建结果 | `ohpm install --all` ✅ · `hvigorw assembleHap (probeapp@default)` **BUILD SUCCESSFUL** in 35 s |
| 载荷 host 冒烟（#S-01） | ✅ 通过（Node v24.7.0）：16/16 冻结键、`fs_write_readback=OK`、host_roundtrip 结构化 timeout |
| 证据 | `logs/20261105-1/DEV_CHECKLIST.md` |
