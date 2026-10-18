# 真机探针证据 —— 样例 `minimal-app`（2026-10-18）

> 产出方式：`node tools/probe.mjs --preset N`（一条命令覆盖 build → install → force-stop/start → `/facts` → 落盘）。
> 设备：HAD-W24 · `7.0.0.107(SP7C00E100R13P5patch01)` · API 26 · arm64 · 序列号 `3QC0226526001227`
> 应用：`org.fellow99.nodebridge.sample`（本仓库的样例 bundle）· 模块 `minimalapp`

| 文件 | 是什么 |
|---|---|
| `facts-preset0.json` | 档 0（`--jitless --no-verify-heap`）的 `/facts` 原始 JSON |
| `facts-preset2.json` | 档 2（`--jitless --expose-internals --no-verify-heap`）的 `/facts` 原始 JSON |
| `summary.md` | `tools/probe.mjs` 生成的人读摘要（只陈述实测值） |
| `sample-ui-preset0.jpeg` | 样例界面截图（状态 / 阶段 / 当前 flags / 日志面板） |

## 三档实测（同一台设备，同一份 HAP）

| 档 | flags | 结果 |
|---|---|---|
| 0 | `--jitless --no-verify-heap` | ✅ `/facts` 200 · `node=v24.2.0` `platform=openharmony` `arch=arm64` `execPath=/system/bin/appspawn` `cpus=0` · `wasm=ERR:WebAssembly is not defined` · `hotloop=~300 ms` · `fs_write_readback=OK` · `spawn.events={data,exit,close}=true, zombie=false` · `fetch_self=ERR:fetch failed`（jitless 下 llhttp 的 WASM 不可用） |
| 1 | `--no-verify-heap`（真 JIT） | ❌ `CRASH sig=5`（SIGTRAP）、进程消失 —— 该 Profile **无 JIT ACL**（与规划 §D.8 结论 2、能力矩阵 #55 一致） |
| 2 | `--jitless --expose-internals --no-verify-heap` | ✅ `/facts` 200 · `expose_internals=OK`（`require('internal/modules/cjs/loader')` 成功）· 其余同档 0 |

## 与历史结论的对照

- **`spawn` 三事件齐全、无僵尸** → 库能力矩阵 #8 的**第二个独立复现**（第三个 bundle 上）。
- **`os.cpus()` = 0**、**`execPath=/system/bin/appspawn`** → 与 #19 / §D.8 一致。
- **JIT 取决于 Profile 的 ACL，而不是设备** → 本证据是第三个 bundle 上的 SIGTRAP 复现（#55）。
- ⚠️ `facts-preset*.json` 里的 uid/path 是设备事实，不含任何凭据；可直接归档。
