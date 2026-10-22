# 样例

本工程的**产品**是 `library/` 里的 HAR；样例用来做两件事：
① 证明「库能被消费、能装进 HAP」；② 当**真机探针**与**参考实现**（新消费方照着抄）。

| 样例 | 作用 | 状态 |
| --- | --- | --- |
| [`minimal-app/`](./minimal-app/README.md) | 最小样例 + **内置探针**：40 行 ArkTS 把 Node 跑进进程，载荷 `/facts` 一次问清平台能力；三档 flags（jitless / 真 JIT / +`--expose-internals`） | ✅ **已落地并真机跑通**（2026-10-18） |
| `arkweb-http/` | ArkWeb 加载本地服务的最小页（Phase 0 P0-3 的复用形态） | ⬜ 未做（消费方 `pi-desktop-ark` 已覆盖该形态） |

## 一条命令跑样例（真机取证）

```bash
# 前置：运行时由**运行时包**提供（样例的 oh-package.json5 已声明 file:../../runtime-har）
#       包内是 121 MB 的 libnode.so，需要先把它投放进该模块（不入库）：
node tools/provision.mjs --out runtime-har/libs/arm64-v8a

node tools/probe.mjs                  # 构建 → 装机 → 启动(档位 0) → 取 /facts → 落证据到 logs/<date>-probe/
node tools/probe.mjs --preset 2       # 换档位（0/1/2，见 minimal-app/README.md §3）
```

> 旧方式（把 `.so` 直接投进 `samples/minimal-app/libs/arm64-v8a`）仍可用，但**两种方式择一**：
> 同时存在两份同名 `.so` 会让「这份到底从哪来」无法自证。

判据表与已知限制见 [`minimal-app/README.md`](./minimal-app/README.md) §4 / §6。

> 两个包已于 2026-10-22 **上架**：[`@fellow99/node-bridge@0.1.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99/node-bridge) / [`@fellow99/node-runtime@24.2.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99/node-runtime)；
> 样例仍走 `file:` 依赖，**离线可构建**。

## 在本仓库内自测时要记住的两件事

1. 样例挂在根 `build-profile.json5` 的 `modules[]` 里（`srcPath: ./samples/minimal-app`）——
   **那个文件在开发机上会被 DevEco 写入本机签名材料**（`.cer/.p12/.p7b` 路径 + 加密口令），
   `git status` 里它经常是 `M`：**提交前必须只挑自己的 hunk**，别把签名材料带进仓库。
2. 库是主角，样例只是消费者：任何「只有样例能用」的能力都不该进库的公共 API（宪法 S2）。
