# 第三方许可清单（THIRD-PARTY-NOTICES）

> 红线出处：`specs/constitution.md` **G4**（「第三方许可清单必须随包」）· 工程规划 **§4.8 / §9.5 G4 / §7.5**。
> 口径纪律（宪法 §三）：**不要把推断当实测**。本文件里 ✅ = 本机可复核（有 `path` / SHA-256 / 命令），
> 🔶 = 沿用上游材料的声明，⬜ **待人工确认** = 本仓库无法验证、发布前必须人工补齐。
> **凡标 ⬜ 的条目，在补齐前不得对外声称「许可已合规」。**

---

## 0. 发布物的构成（先说清楚"随什么包"）

| 发布物 | 内容 | 是否含二进制 |
|---|---|---|
| **ohpm 包（HAR，`@fellow99/node-bridge`）** | ArkTS 源码 + NAPI 引导件源码/types + `payload/`（JS）+ `runtime.lock.json` + 投放工具 | **不含 `libnode.so`**（✅ 本机实测：`library/build/default/outputs/default/library.har` 内 `package/libs/arm64-v8a/` 只有 `libc++_shared.so` + `libnode_bridge.so`）· 设计依据 §7.5 / 附录 G.8 |
| **消费方 HAP** | HAR 内容 + 由 `tools/provision.mjs` 投放的 `libnode.so`（= 上游资产 `libnode-arm64.so`）+ `libc++_shared.so` | 含 **120.9 MiB** 的 Node 运行时 |
| **独立分发（可选）** | 用 `tools/ohos-selfsign.mjs` 自签后的 `libnode.so` | 含二进制；仅在"脱离 HAP 独立分发"时使用（§5.8 / §D.6） |

**G3（包内不得含第三方浏览器内核）**：本库随包只有 `libnode.so` + 引导件 + JS 载荷，**不含 Chromium**
（✅ 本机实测：`payload/` 与 `library/` 无浏览器内核二进制/依赖；依据 §4.8）。
**G11（不得包含绕过平台代码签名 / 可执行内存控制的组件）**：✅ 本机实测 `grep -rniE "wxjit|LD_PRELOAD|mremap|jit-patch" library/ payload/ tools/`
只命中 `tools/ohos-selfsign.mjs` 的**署名注释**（见 §4）；路线 J′ 的实现不在本仓库发布物内（§4.8 / R23 / §9.5 G11）。

---

## 1. 本库自身：MIT

`@fellow99/node-bridge` 采用 **MIT**（与仓库根 `LICENSE` 逐字一致）：

```text
MIT License

Copyright (c) 2026 fellow99

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 随包分发的 Node.js 运行时（`libnode.so`）

### 2.1 二进制溯源（唯一事实源 = `runtime.lock.json`）

| 字段 | 值 |
|---|---|
| 来源类型 | `github-release` |
| 仓库 | `electerm/ohos-node-shared` |
| Tag | `ohos-node-shared-v24.2.0` |
| 资产 | `libnode-arm64.so`（入库后由 `deployAs` 统一改名 `libnode.so`） |
| URL | `https://github.com/electerm/ohos-node-shared/releases/download/ohos-node-shared-v24.2.0/libnode-arm64.so` |
| 大小 | **126,809,264 B**（120.9 MiB） |
| SHA-256 | `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` |
| SONAME | `libnode.so.137`（Node 版本 **v24.2.0**，`process.versions.modules = 137`） |
| `DT_NEEDED` | `libc++_shared.so`, `libc.so` |
| 内嵌资源 | `icu: true`、`v8Snapshot: true`（无需外置 ICU/快照文件，附录 D） |
| 构建配方（上游声明） | `OHOS SDK + LLVM-19；./configure --shared --cross-compiling --openssl-no-asm --v8-disable-temporal-support` |
| 已记录许可字段 | `["Node.js (MIT)", "build scripts (MIT, electerm/ohos-node-shared)"]` |
| 签名段 | `.codesign = false`、`.note.ohos.ident = true`；**HAP 内原生库不需要 `.codesign`**（§D.6/§D.9，G5） |
| `verifiedOn` / `verifiedDevice` | `2026-10-16` · `HAD-W32 / HarmonyOS 6.1.0 / API 26 / arm64-v8a` |

### 2.2 运行时内部组件（Node.js 及其打包的第三方）

**Node.js 本体**：**MIT**（Copyright © Node.js contributors / OpenJS Foundation）——🔶 上游声明 + 业界一致口径。
`libnode.so` 是把 Node v24.2.0 以 `--shared` 方式链接出的**共享库**，因此 **Node 源码树里的全部内置依赖都随该文件一起分发**，
典型包括（🔶 组件存在性由 Node 官方 `LICENSE` 汇总确认，本仓库无法逐字复核）：

| 组件 | 常见许可 |
|---|---|
| V8 | BSD-3-Clause |
| OpenSSL | Apache-2.0（OpenSSL 3.x） |
| ICU | Unicode/ICU License |
| llhttp | MIT |
| zlib | zlib License |
| libuv | MIT |
| nghttp2 | MIT |
| c-ares | MIT |
| brotli | MIT |
| ada / simdjson / undici 等 | MIT / Apache-2.0（以官方 `LICENSE` 为准） |

> ⬜ **待人工确认（必须做，且不能凭印象抄）**：上面这张表**只登记"有哪些组件、许可族别"**，
> **不是许可原文**。发布前必须从**该次构建对应的上游 `nodejs/node` 源码树的 `LICENSE` 文件**逐字抄录/并入发布物
> （Node 的 `LICENSE` 汇总了全部第三方许可全文）。
> 原因：本仓库只锁定了一个二进制（`runtime.lock.json` 的 `source.builtWith` 未逐项记录依赖版本），
> 从本仓库**无法**推导出该二进制实际内嵌的组件版本清单 ⇒ 不能在这里发明许可文本。
> 同时需要确认 `electerm/ohos-node-shared` 构建脚本自身的 MIT 许可是否需要随包附上原文（锁文件只记了许可名）。

---

## 3. `libc++_shared.so`（来自 ohos-sdk）

| 项 | 值 |
|---|---|
| 来源规则 | `runtime.lock.json` → `libcxx: { file: "libc++_shared.so", from: "ohos-sdk", sdkRelPath: "native/llvm/lib/aarch64-linux-ohos/libc++_shared.so", abi: "arm64-v8a" }` |
| 本机实际落点（✅ 实测） | `<CLT-SDK>/default/openharmony/native/llvm/lib/aarch64-linux-ohos/libc++_shared.so` |
| 大小 / SHA-256（✅ 实测） | `1,262,504 B` / `388e0df23d7bfddc2ea01b4e87f8dc359e33df1a7a44705e0a672609ee45b2f9`（与 §D.9 记录、`pi-desktop-ark/entry/libs/arm64-v8a/libc++_shared.so` 三方一致） |
| 投放方式 | `node tools/provision.mjs --out <模块>/entry/libs/arm64-v8a` 一并投放（幂等，§G.4） |

> ⬜ **待人工确认（必须做）**：**本仓库无法验证 ohos-sdk 的许可条款**。
> 已知线索（不足以作为合规依据）：LLVM 系 `libc++` 常见为 `Apache-2.0 WITH LLVM-exception` 或 `MIT + University of Illinois NCSA` 双许可；
> HarmonyOS/OpenHarmony SDK 自带许可声明，且 SDK 内存在多处同族副本（本机实测 `.../hms/native/BiSheng/...` 下的副本 SHA-256 为
> `3bf7b804928df05ea2fd08a7666433253c0eb53707878fb1d07d89c695293afb`，**与投放所用副本不同字节**）⇒
> **以 SDK 自带 LICENSE 原文 + 上架材料要求为准**，不要以本文件的推测替代。

---

## 4. `tools/ohos-selfsign.mjs`：对 `Bibapcs/ohos-node-jit-patch` 的 MIT 署名

`tools/ohos-selfsign.mjs`（**host 侧工具**，用于"脱离 HAP 独立分发"时给 ELF 补 `.codesign` 并自签，§5.8）是
**MIT 许可项目** [`Bibapcs/ohos-node-jit-patch`](https://github.com/Bibapcs/ohos-node-jit-patch) 中自签名算法的 **JS 移植**。
其文件头已保留署名与算法出处（✅ 实测 `tools/ohos-selfsign.mjs:7-16`）：

```text
// 格式（依据与算法出处，MIT）：
//   https://github.com/Bibapcs/ohos-node-jit-patch
//   （tools/selfsign.py + src/wxjit.c:merkle_root/self_sign_image —— 逆向自
//    `binary-sign-tool sign -selfSign 1`，并与该工具输出做过字节级比对）
// 本文件是该算法的 JS 移植 + verify 模式 + round-trip 自测。
```

> ⚠️ **只借算法，不借产物**：`Bibapcs/ohos-node-jit-patch` 的 `prebuilt/wxjit.so`（RX 代码池 + `LD_PRELOAD`）属
> **路线 J′**，按 **G11 / R23 / §9.5** **不得进入任何发布物**；本仓库只保留其 MIT 算法在自签工具中的实现，
> 且该工具不随 HAR 分发（HAR 内容见 §0，✅ 实测不含 `tools/`）。
> ⬜ **待人工确认**：把上游 `LICENSE`（MIT，含版权行）原文一并附在本清单里 —— 需要先从上游仓库取回原文，本仓库未缓存其全文。

---

## 5. 如何重新生成 / 复核（附录 D 的两条命令 + 本机门禁）

```bash
# ① 重新取回上游二进制并自证哈希（附录 D「可复现的核验命令」）
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
curl -fL -o libnode-arm64.so \
  https://github.com/electerm/ohos-node-shared/releases/download/ohos-node-shared-v24.2.0/libnode-arm64.so
sha256sum libnode-arm64.so    # 期望 3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1
python tools/elf-inspect.py libnode-arm64.so   # 期望 VERDICT: PASS（六项）

# ② 与锁文件 + 七项门禁对齐（可进 CI；国内联网需 NODE_USE_ENV_PROXY=1）
node tools/provision.mjs --check
node tools/provision.mjs --list

# ③ 本库 host 侧门禁（含契约漂移与载荷单测）
node tools/smoke-host.mjs
```

**改运行时版本时的强制动作**（宪法「变更流程」第 2 条）：改 `runtime.lock.json` ⇒
必须重跑 `node tools/provision.mjs --check` + 真机 `/facts`，并把 `verifiedOn` / `verifiedDevice` 写回锁文件；
同时按 §2.2 的 ⬜ 项重新生成许可清单。

---

## 6. ⬜ 待人工确认清单（发布前逐条关闭）

| # | 事项 | 为什么本仓库给不出结论 |
|---|---|---|
| 1 | Node v24.x 源码树 `LICENSE` 全文（含 V8/OpenSSL/ICU/llhttp/zlib… 逐项版本与原文） | 锁文件只固定了一个二进制与构建开关，未记录内嵌依赖版本；必须回到上游源码树抄录 |
| 2 | `electerm/ohos-node-shared` 的 MIT 原文与版权行（构建脚本许可） | 本仓库只登记了许可名（`source.license`），未缓存上游 `LICENSE` 全文 |
| 3 | `libc++_shared.so` 的 SDK 许可条款与署名要求 | SDK 自带 LICENSE 为准；本机存在多份不同字节的副本，口径需人工裁决 |
| 4 | `Bibapcs/ohos-node-jit-patch` 的 MIT 原文（算法来源署名） | 需要从上游取回 `LICENSE` 原文 |
| 5 | 上架材料对「许可清单随包形式」的具体要求（文件位置 / 页面入口） | 属应用侧上架材料（消费方文档 §13），不由本库单独决定 |
