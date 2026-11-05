# DEV_CHECKLIST.md —— 101-probe-app 构建勘察清单

> 日期：2026-11-05 · 工程：`ohos-node-bridge`（分支 main）· 任务：specs/101-probe-app + probe-app HAP
> 状态口径：✅ 完成 · ⬜ 待真机/待签名（如实登记）· ⚠️ 风险/共享变更

---

## 1. 环境事实（本机实测）

| 项 | 值 |
|---|---|
| 设备 | `hdc list targets` = **`[Empty]`**（无在线鸿蒙设备） |
| 签名 | 无 `signing.debug.local.json` / 无环境变量签名 ⇒ 产出**未签名** HAP（hvigorfile.ts 的既定降级） |
| 运行时 | `runtime.lock.json` active = `v26.13.0`（SONAME `libnode.so.147`）；**仓库内无 libnode.so** |
| CLT | `D:/oh-workspace/command-line-tools/bin/ohpm.bat`（6.1.2.285）/ `hvigorw.bat` |
| hdc | `D:/oh-workspace/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe` |

## 2. 构建记录

```bash
cd D:/node-bridge-workspace/ohos-node-bridge
D:/oh-workspace/command-line-tools/bin/ohpm.bat install --all
# → "install completed in 10s 326ms"（file:../library 离线解；minimal-app 的 @fellow99/node-runtime ^24.2.0 在线解析为 24.22.1.har）

D:/oh-workspace/command-line-tools/bin/hvigorw.bat assembleHap --mode module \
  -p product=default -p module=probeapp@default -p buildMode=debug --no-daemon
# → BUILD SUCCESSFUL in 35 s 714 ms（:probeapp:default@CompileArkTS 9 s 无 ERROR）
```

- **一次修复记录**：`00303053 Configuration Error`（build-profile 模块名 `probe-app` ≠ module.json5 `probeapp`）
  → 统一为 `probeapp` 后通过（见报告 §阻塞项）。
- 警告（WARN 非 ERROR）：`probeapp` / `@fellow99/node-bridge` 版本号不符 SemVer（0.x 工程惯例）；
  `EntryAbility.ets:27` 可能抛异常提示（与 minimal-app 同款模式，非阻塞）；
  `Env.ets` / `libnode_bridge.so` 原生验证提示（library 既有）。

## 3. 产物

| 产物 | 路径 | 大小 |
|---|---|---|
| HAP（未签名，debug） | `probe-app/build/default/outputs/default/probeapp-default-unsigned.hap` | 1,648,183 B（≈1.6 MB） |

HAP 内容核对（unzip -l）：`resources/rawfile/probe-app.js`（12,055 B）、`resources/rawfile/host.js`（21,548 B）、
`libs/arm64-v8a/libnode_bridge.so`（41,360 B）+ `libnode_host_client.so` + `libc++_shared.so`；
**不含** libnode.so（运行时未投放，符合离线构建姿态）。

## 4. 判据登记（三态如实）

| 探针 | 判定面 | 本批状态 | 说明 |
|---|---|---|---|
| PRB-01 加载 | bridgeVersion | ⬜ 待真机 | 构建通过；`.so` 在真机上才真正加载 |
| PRB-02 启动 | start ok + stage=running | ⬜ 待真机 | 无设备；无 libnode.so |
| PRB-03 起服 | /facts 200 + 16 键 + 健康键 | ⬜ 待真机 | 载荷 host 冒烟已验（Node v24）：16/16 键、fs_write_readback=OK |
| PRB-04 host桥 | echo 信箱往返 | ⬜ 待真机 | 载荷 host 冒烟：无 ArkTS 泵 ⇒ 结构化 timeout 如实呈现（非假 PASS） |
| PRB-05 版本契约 | Index 常量 vs /facts | ⬜ 待真机 | 构建期常量已落 Index.ets |

## 5. 阻塞 / 待办

1. **无设备**（`hdc list targets`=[Empty]）＋ **无签名材料** ⇒ 真机 D-xx 全部 ⬜。
2. **无 libnode.so** ⇒ PRB-02/03 真机断言需先 `tools/provision.mjs` 投放（v26.13.0）并入依赖。
3. **共享变更登记**：`AppScope/app.json5` bundleName → `org.fellow99.nodebridge.probe`（全工程唯一，
   影响 samples/minimal-app 的 bundle；`tools/probe.mjs` BUNDLE 仍写 …sample，**不再命中新 bundle**，
   属另一 agent 领地，probe-app 等价命令见 probe-app/README.md §4）。
4. `tools/probe.mjs` 尚无 probe-app 目标（--bundle 待办，tasks.md T-15）。
