# `probe-app` —— PRB 探针应用（HAP，feature 模块）

> **一句话**：一个只消费 `@fellow99/node-bridge` 的判据化探针 HAP —— 把「Node 起动 + 起服 +
> 宿主桥往返 + 版本契约」拆成 PRB-01…05 五项，每项**独立超时、三态（PASS/FAIL/SKIP）**，
> 结果落 `<filesDir>/probe-report.json`，支持 `aa start --ps probeAuto true` 无头跑。
> 规范见 `specs/101-probe-app/`。

## 1. 与 `samples/minimal-app` 的分工

| | `minimal-app` | `probe-app` |
|---|---|---|
| 定位 | 参考实现 + `/facts` 手工取证 | 判据化探针（PRB-xx 五项） |
| 模块类型 | `entry` | **`feature`**（entry 已被 minimal-app 占用） |
| 载荷 | `rawfile/probe.js`（20+ 键扩展探针） | `rawfile/probe-app.js`（16 冻结键 + host_roundtrip） |
| 判定 | 人读 `/facts` | 页面三态 + `probe-report.json` |
| bundle | 现与 probe-app 同属 `org.fellow99.nodebridge.probe`（AppScope 全工程唯一） | |

## 2. PRB 判据（详见 `specs/101-probe-app/test-cases.md` §1）

| ID | 判定面 | 要点 |
|---|---|---|
| PRB-01 | 加载 | `NodeRuntime.getInstance()` + `bridgeVersion()` 不抛 |
| PRB-02 | 启动 | `start()` ok + stage 到 `running`（探活命中才算） |
| PRB-03 | 起服 | `/facts` 200 + 16 冻结键 + 健康键（node=v26.13.0 前缀等） |
| PRB-04 | host桥 | `probe.echo` 注册 + 文件信箱 + POST `/rport` 往返 + `/facts.host_roundtrip.ok` |
| PRB-05 | 版本契约 | Index 常量（`TARGET_NODE=v26.13.0` / `TARGET_ARCH=arm64-v8a`）vs `/facts` 对拍 |

## 3. 构建（本机无签名材料 ⇒ 未签名 HAP）

```bash
cd D:/node-bridge-workspace/ohos-node-bridge
D:/oh-workspace/command-line-tools/bin/ohpm.bat install --all
D:/oh-workspace/command-line-tools/bin/hvigorw.bat assembleHap --mode module \
  -p product=default -p module=probeapp@default -p buildMode=debug --no-daemon
# 产物：probe-app/build/default/outputs/default/probe-app-default-unsigned.hap
```

> `libnode.so`（v26.13.0）不在仓库：有设备/签名后先 `node tools/provision.mjs --out <runtime-har>/libs/arm64-v8a`
> 并让依赖带上运行时包，再装机（见 `samples/minimal-app/README.md` §1 同口径）。

## 4. 真机取证（设备+签名就绪后；本批 ⬜）

```bash
HDC="D:/oh-workspace/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
"$HDC" install -r probe-app/build/default/outputs/default/probe-app-default-signed.hap
"$HDC" shell "aa force-stop org.fellow99.nodebridge.probe"
"$HDC" shell "aa start -a EntryAbility -b org.fellow99.nodebridge.probe --ps probePreset 0 --ps probeAuto true"
"$HDC" shell "cat /data/app/el2/100/base/org.fellow99.nodebridge.probe/haps/probeapp/files/probe-report.json"
"$HDC" fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts
```

## 5. 已知限制 / 缺陷登记

- **无设备/无签名**：本批只到 `assembleHap`（未签名）；PRB 真机 PASS ⬜（`hdc list targets`=[Empty]）。
- **JIT 档需 ACL**：档 1（真 JIT）无 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 会 `CRASH sig=5`；
  默认档 0 带 `--jitless` 无此问题。
- **`tools/probe.mjs` 仍面向 minimal-app**（旧 bundle/module）：对 probe-app 的 `--bundle` 支持属待办
  （见 `specs/101-probe-app/tasks.md` T-15）。
