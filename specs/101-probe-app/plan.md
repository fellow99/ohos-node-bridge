# plan.md —— `101-probe-app`（PRB 探针应用）实现方案

> 上游规划：[`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) §7.2 / §6.1 / §5.6 / §D.6 / §D.8。
> 宪法：[`../constitution.md`](../constitution.md) C1 / C2 / C4 / C5 / S2 / S3 / S10。
> 对应 spec：[`spec.md`](./spec.md)（FR-101-PROBE-001…019）。
> 证据标记：✅ 实测 · 🔶 沿用 · ⬜ 待验证 · ⚠️ 风险。全部行号/字节为 **2026-11-05** 实测。

---

## 1. 技术上下文

### 1.1 运行环境（本机实测，2026-11-05）

| 项 | 实测值 |
|---|---|
| 工程 | `ohos-node-bridge`，分支 `main`，git tree clean |
| CLT | `D:/oh-workspace/command-line-tools/bin/hvigorw.bat` / `ohpm.bat`（ohpm `6.1.2.285`） |
| hdc | `D:/oh-workspace/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe`（路径含空格） |
| 设备 | `hdc list targets` = **`[Empty]`**（本机无在线鸿蒙设备） |
| 签名 | 仓库根 `hvigorfile.ts:16-150`：无 `signing.debug.local.json` / 环境变量 ⇒ **产出未签名包** |
| host Node | `node` 在 PATH，v24 |
| 库 | `@fellow99/node-bridge@0.2.0`，导出面 `library/Index.ets:18-24`（8 符号） |
| 目标运行时 | `runtime.lock.json` `active.node = v26.13.0`，SONAME `libnode.so.147`，abi `arm64-v8a`；**仓库内无 `.so`** |
| 根 SDK 档 | `compatibleSdkVersion 5.0.5(17)` / `targetSdkVersion 6.1.1(24)` / `runtimeOS HarmonyOS`（根 `build-profile.json5:9-12`） |

### 1.2 关键事实（复用 minimal-app 的既定结论，不重复研究）

- 载荷必须先物化到**可写**沙箱（C3）：`Env.materializeRawfile(ctx.resourceManager, 'probe-app.js', '<filesDir>/payload/probe-app.js')`（`library/src/main/ets/util/Env.ets:78-97`）。
- `start()` 是**投递语义**：`ok=true` 不代表 Node 已起来；探活命中由消费方负责（`NodeRuntime.ets:164-172`/`352-372`）。
- 传输泵 MUST 在 `start()` 之前已起（`NodeRuntime.ets:284-294` 注释）；文件信箱泵由消费方显式 `startMailbox(dir, ±100)`（`HostBridge.ets:229-260`）。
- `aa start --ps` 只送得动一个 token ⇒ 档位走索引（`EntryAbility.ets` 同 minimal 口径）。
- Node 每进程一次（C5）；换 flags 必须 `force-stop` 后重开。

---

## 2. 宪法合规检查

- **C1 库/壳分离** ✅：探针语义全部在 `probe-app/`（壳）；`library/` 不新增任何公共 API。
- **C2 不隐藏平台真相** ✅：页面只呈现库返回的事实；SKIP/FAIL 只报观测值。
- **C4 启动参数不可事后修改** ✅：`flags` 只在 `start()` 投递前定稿，页面不提供运行期改参入口。
- **C5 单例与不可重启** ✅：起动按钮点过即锁；换档 `force-stop`。
- **S2 导出面冻结** ✅：不动 `library/Index.ets` / `Types.ets`。
- **S10 无大二进制** ✅：模块内不含任何 `.so`。

---

## 3. 目录与构建注册

### 3.1 新模块目录（真实文件，2026-11-05）

```
probe-app/
  build-profile.json5          # apiType stageMode + targets[default]
  hvigorfile.ts                # hapTasks（同 samples/minimal-app/hvigorfile.ts:11-14）
  oh-package.json5             # name probeapp · @fellow99/node-bridge: "file:../library"
  README.md                    # 用法 + 判据表 + 缺陷登记
  src/main/module.json5        # type feature · mainElement EntryAbility · 4 权限
  src/main/ets/entryability/EntryAbility.ets   # 命令行传参 → AppStorage
  src/main/ets/pages/Index.ets                 # PRB-01..05 五项探针页
  src/main/resources/base/element/string.json
  src/main/resources/base/element/color.json
  src/main/resources/base/profile/main_pages.json
  src/main/resources/base/media/icon.png       # 复用 minimal-app 的 144×144 PNG
  src/main/resources/base/media/startIcon.png
  src/main/resources/rawfile/probe-app.js      # 自检载荷（16 冻结键 + 宿主桥往返）
  src/main/resources/rawfile/host.js           # 原样复制 payload/host.js（宿主桥客户端）
```

### 3.2 根工程改动（仅两处）

| 文件 | 改动 | 行 |
|---|---|---|
| `build-profile.json5` | `modules[]` 追加 `{name:"probe-app", srcPath:"./probe-app", targets:[{name:"default",applyToProducts:["default"]}]}` | 60 之后 |
| `AppScope/app.json5` | `bundleName` `org.fellow99.nodebridge.sample` → `org.fellow99.nodebridge.probe` | 第 5 行 |

> ⚠️ `bundleName` 是 AppScope 级（全工程唯一）。改后 minimal-app 与 probe-app 同属
> `org.fellow99.nodebridge.probe` 这个 App；`tools/probe.mjs` 的 `BUNDLE`（=……sample）将不再命中 probe-app，
> 属于**共享变更**，已在 A3 / 报告登记。

### 3.3 为什么 `type: feature` 而不是 `entry`

`minimal-app` 已占用 `type: entry`（`samples/minimal-app/src/main/module.json5:4`）。Stage 模型下一产品
最多一个 entry，故 probe-app 用 **feature**（同样可以是带 UI 的 HAP，能力完全够）。

---

## 4. 载荷设计（`rawfile/probe-app.js`）

### 4.1 职责

- 与契约 §3.6 **同一套** 16 冻结 checks 键（复制 `payload/selfcheck.js:178-211` 的 `buildChecks()` 语义，键名一字不差）；
- loopback HTTP 服务：`GET /facts`、`GET /log`、`GET /diag`（含 `hostBridge` 段）、`POST /rport`（正文原样回转，等价转发语义）；
- **宿主桥往返（PRB-04 的 Node 半边）**：当 `process.env.PROBE_MAILBOX_DIR` 非空时，
  ① `host.useFileMailbox(dir)`；② `host.handle('probe.echo', …)` 注册 Node 侧钩子；③ 起动后立刻
  `host.invoke('probe.echo', {ping:'pong', ts})`，把结果写进 `checks.host_roundtrip`（`{ok, reply, err, wired}`）；
 ④ `/rport` 收到 body 时就地做一次**新的** roundtrip 读出并经 HTTP 回给页面 —— 这是页面显式触发的复验通道。
- 只绑 `127.0.0.1`；默认端口 `PROBE_PORT`（页面传 `15577`）；EADDRINUSE 回退临时端口并打印 `[probe] WARN`。
- 任何检查项异常都被编码成 `'ERR:<msg>'`，**绝不**让未捕获异常把 App 打挂（D.10 ⑰）。

### 4.2 16 冻结键 ↔ PRB 映射

| 键 | PRB-03 判据 |
|---|---|
| node | `startsWith('v26.13.0')` |
| arch | `==='arm64'`（PRB-05 对拍 `TARGET_ARCH='arm64-v8a'` 前缀） |
| homedir_redirected / tmpdir_redirected | `true` |
| fs_write_readback | `'OK'` |
| wasm.validate | 布尔（无 ACL + `--jitless` 时为 `'ERR:…'` 都算「如实」，健康键判定只见上面四项 + node） |
| cpus | `0` 属正常（D.8 偏差表，本平台 `os.cpus()` 空） |
| 其余 9 键 | 键名在场即参与 PRB-03 的 16 键键名检查 |

### 4.3 host.js 随包

`rawfile/host.js` = `payload/host.js` 的**原文复制**（532 行）。载荷 `require('./host.js')`（以脚本同目录解析）。
凡与库侧 `HostBridge.ets` 的协议常量两侧必须同口径（`.req/.tmp/.wip/.done/.fail`，100 ms 轮询）。

---

## 5. 页面实现（`pages/Index.ets`）

### 5.1 结构

```
Index (struct)
 ├─ 常量区：LIBRARY_VERSION='0.2.0' · TARGET_NODE='v26.13.0' · TARGET_ARCH='arm64-v8a'（来自 runtime.lock.json 只读引用）
 ├─ PRESETS[0..2]：flags 三档（同 minimal 口径，档 0 默认 --jitless --no-verify-heap）
 ├─ ProbeResult（interface）：{ id, status:'pass'|'fail'|'skip', detail }
 ├─ runProbes()：PRB-01 → 02 → 03 → 04 → 05 顺序流水，每步 Promise.race(独立超时)
 ├─ withTimeout(promise,ms) / sleep(ms)
 ├─ writeReport(ctx) / hilog 打标
 └─ build()：标题 / 档位 / 起动按钮 / 每项探针行(状态徽标+detail) / 日志尾
```

### 5.2 每项探针判据（↔ spec FR）

| ID | 实现 | 超时 | 三态转出 | spec |
|---|---|---|---|---|
| PRB-01 加载 | `NodeRuntime.getInstance()`；`runtime.bridgeVersion()` 非空即 pass；抛错 fail | 5 s | pass/fail | FR-001 |
| PRB-02 启动 | `Env.ensureRuntimeDirs` + 物化 `probe-app.js`/`host.js` 到 `<filesDir>/payload`；`start(ctx,{flags,scriptPath,env:{PROBE_PORT:'15577',PROBE_MAILBOX_DIR:payloadDir}})`；随后轮询 `getStage()` 前缀 `running` 或 `waitUntilRunning(20s)`；`start` 返回 `ok===false` ⇒ fail（原因=code+message） | 25 s | pass/fail | FR-002/003/004/017 |
| PRB-03 起服 | `http` GET `http://127.0.0.1:15577/facts`；200 + `JSON.parse`；16 键键名齐 + 健康键（node 前缀 / fs_write_readback/ redirected ×2）成立 ⇒ pass | 20 s | pass/fail | FR-005/006/007 |
| PRB-04 host桥 | 注册 `runtime.host.register('probe.echo', (args)=>{回 args 原样})` + `runtime.host.startMailbox(payloadDir,100)`；然后 POST `/rport` body=`{"probe":"echo"}`，期望响应 200 且 `JSON.parse(res).reply.ping==='pong'`；同时读 `/facts` 的 `host_roundtrip.ok===true` | 25 s | pass/fail/skip（PRB-02 fail → skip，原因=前置） | FR-008/009/010 |
| PRB-05 版本契约 | 常量对拍：`/facts.node↔TARGET_NODE`、`/facts.arch↔TARGET_ARCH` 前缀、`runtime.bridgeVersion()↔LIBRARY_VERSION`（非空即与常量同源声明） | 10 s | pass/fail/skip（无 /facts → skip） | FR-011/012 |

### 5.3 报告

`writeReport` 写 `<filesDir>/probe-report.json`：

```json
{ "at":"<ISO>", "bundle":"org.fellow99.nodebridge.probe", "version":"0.1.0",
  "flags":"<effective>", "probes":[{"id":"PRB-01","status":"pass|fail|skip","detail":"…"}] }
```

同时 `hilog.info(DOMAIN, TAG, 'PROBE_REPORT ' + json)` 每行一条。

### 5.4 自动化入口（EntryAbility.ets）

与 `samples/minimal-app/src/main/ets/entryability/EntryAbility.ets:29-63` 同构：读
`want.parameters` 的 `probePreset` / `probeFlags` / `probeAuto`，写入 `AppStorage`；页面 `aboutToAppear`
里 `AppStorage.get('probeAuto')==='true'` 且前置无错 ⇒ 自动 `runProbes()`。

---

## 6. 运行用法（真机/设备就绪时）

### 6.1 构建（本次仅此一步闭环）

```bash
cd D:/node-bridge-workspace/ohos-node-bridge
D:/oh-workspace/command-line-tools/bin/ohpm.bat install --all
D:/oh-workspace/command-line-tools/bin/hvigorw.bat assembleHap --mode module -p product=default -p module=probeapp@default -p buildMode=debug --no-daemon
# 产物：probe-app/build/default/outputs/default/probe-app-default-unsigned.hap（无签名材料时）
```

### 6.2 真机（设备+签名就绪后；本次 ⬜）

```bash
HDC="D:/oh-workspace/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
"$HDC" install -r probe-app/build/default/outputs/default/probe-app-default-signed.hap
"$HDC" shell "aa force-stop org.fellow99.nodebridge.probe"
"$HDC" shell "aa start -a EntryAbility -b org.fellow99.nodebridge.probe --ps probePreset 0 --ps probeAuto true"
"$HDC" shell "cat /data/app/el2/100/base/org.fellow99.nodebridge.probe/haps/probeapp/files/probe-report.json"
"$HDC" fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts | head -40
```

> `tools/probe.mjs` 面向 `minimal-app`（bundle=org.fellow99.nodebridge.sample / module=minimalapp）；
> probe-app 的等价取证命令见上（见 §3.2 的共享变更说明）。

### 6.3 FR ↔ 命令交叉引用

| FR（spec §3） | 落点 |
|---|---|
| 001–004 | `Index.ets` PRB-01/02 + `EntryAbility.ets` |
| 005–007 | `rawfile/probe-app.js` + `Index.ets` PRB-03 |
| 008–010 | `Index.ets` PRB-04 + `rawfile/probe-app.js` |
| 011–012 | `Index.ets` 常量区 + PRB-05 |
| 013–017 | `Index.ets` withTimeout/writeReport/hilog/probeAuto |
| 018–019 | `Index.ets` ProbeResult 状态机 |

---

## 7. 测试考虑

- **host 测试已有**（`tests/payload/*.test.mjs`）：`selfcheck-endpoints.test.mjs:200`（16 冻结键）、
  `host-bridge.test.mjs`（invoke 语义 / mailbox / transport）、`sample-wiring.test.mjs:20-85`（modules[] 注册样式）。
  本模块的 `rawfile/probe-app.js` 键面与 `selfcheck` 契约同源，**漂移由同一组 host 用例看守**。
- **构建验证**（本次）：`assembleHap`（见 §6.1）。✅ / 设备断言：⬜。
- **载荷本体化冒烟**：`node <sandbox>/payload/probe-app.js` 在 host Node 上应能起 `/facts`
  （对拍 16 键）；本机 `node` v24 可作加载冒烟（不替代真机）。

## 8. 文件清单与字节（2026-11-05 实证）

| 文件 | 字节 |
|---|---|
| `probe-app/build/default/outputs/default/probeapp-default-unsigned.hap`（未签名 HAP 产物） | 1,648,183 |
| `probe-app/src/main/resources/rawfile/probe-app.js`（探针载荷） | 12,055 |
| `probe-app/src/main/resources/rawfile/host.js`（= payload/host.js 原样） | 21,548 |
| `probe-app/src/main/ets/pages/Index.ets`（PRB-01…05） | 21,692 |
| `probe-app/src/main/ets/entryability/EntryAbility.ets` | 2,947 |

完整证据链见 [`../../logs/20261105-1/DEV_CHECKLIST.md`](../../logs/20261105-1/DEV_CHECKLIST.md)。
