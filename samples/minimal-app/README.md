# `minimal-app` —— 最小样例 + 内置探针（HAP）

> **一句话**：这是 `ohos-node-bridge` 的**参考实现**与**真机探针**——40 行 ArkTS 把 Node 跑进应用进程，
> 再用一个纯 JS 载荷（`rawfile/probe.js`）把「这台设备的这个进程里 Node 能用什么」一次问清。
>
> 它承接 Phase 0 探针的检查口径（同一套 `/facts`），并按库的分工重构：
> ① 不自带任何原生件（引导件与运行时都不带），改为**消费两个包**：主包 `file:../../library` + 运行时包 `file:../../runtime-har`；
> ② 载荷写盘从只读的 `__dirname` 改到可写的 `<HOME>/payload`；
> ③ 传参改为**档位索引**（`aa start --ps` 只送得动一个 token，多词 flags 会被截断——真机踩过）。

---

## 1. 一次性准备

```bash
# ① 运行时**不用手工投放**：样例的 oh-package.json5 已声明
#      "@fellow99/node-runtime": "file:../../runtime-har"
#    该模块里的 121 MB libnode.so 由（一次性）投放产生，不入库：
node tools/provision.mjs --out runtime-har/libs/arm64-v8a
#    本地来源默认 runtime/（仓库内，仅 *.so 不入库）；没有就 --download（国内需代理）或 --from <path|url>

# ② 签名（二选一）
#    a) DevEco：File → Project Structure → Signing Configs → 勾选自动生成（需登录）→ 直接写进 build-profile.json5
#    b) 本机：signing.debug.local.json（gitignored，见根 hvigorfile.ts 的字段说明）
#    两者都没有 ⇒ 构建**产出未签名包**（能编译、不能装机）
```

> 两个包已于 2026-10-22 提交中心仓审核；样例刻意仍用 `file:` 依赖（离线可构建、不依赖审核结果）。

`ohpm install` 会把 `file:../../library` 与 `file:../../runtime-har` 当成本地包现场打 HAR——
**不需要**先把两个包发布到 ohpm。

> 也可以走「纯离线」形态：不装运行时包，改把 `.so` 直接投放到本模块
> `node tools/provision.mjs --out samples/minimal-app/libs/arm64-v8a`，同时删掉上面那条依赖。
> **两种方式择一**，别让同名 `.so` 出现两份。

## 2. 构建 / 装机 / 取证（一条命令）

```bash
node tools/probe.mjs                  # 构建 → 装机 → force-stop+start(档位 0) → 取 /facts → 落证据
node tools/probe.mjs --preset 2       # ③ 档位：--jitless + --expose-internals
node tools/probe.mjs --no-build       # 只装机 + 跑
node tools/probe.mjs --facts-only     # 已启动时只取 /facts
```

不想要脚本时的等价手抄命令：

```bash
hdc install -r samples/minimal-app/build/default/outputs/default/minimalapp-default-signed.hap
hdc shell "aa force-stop org.fellow99.nodebridge.sample"
hdc shell "aa start -a EntryAbility -b org.fellow99.nodebridge.sample --ps probePreset 0 --ps probeAuto true"
hdc fport tcp:15577 tcp:15577
curl -s http://127.0.0.1:15577/facts | head -40
```

界面本身也是一条取证通道（下半区就是 `node.log` 的尾巴 + 状态机事实）：
`hdc shell snapshot_display -f /data/local/tmp/s.jpeg` + `hdc file recv`。

## 3. 三档 flags（`--ps probePreset <0|1|2>`）

| 档 | flags | 预期 | 本机实测（HAD-W24 / API 26） |
|---|---|---|---|
| **0**（默认） | `--jitless --no-verify-heap` | 无 ACL 也能跑；WASM 全废 | ✅ `wasm=ERR:WebAssembly is not defined`、`hotloop=294 ms`（5×2e6）、`internals=ERR` |
| **1** | `--no-verify-heap`（真 JIT） | 需要 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` ACL | ❌ 本样例的调试 Profile **没有** ACL ⇒ `CRASH sig=5`（SIGTRAP，与规划 §D.8 结论 2 一致） |
| **2** | `--jitless --expose-internals --no-verify-heap` | 内部模块桩路线可用 | ✅ `internals=OK`（`require('internal/modules/cjs/loader')` 成功） |

> **档位怎么选**：先用 0 确认「Node 能跑」；要在本机拿真 JIT，得先给 `org.fellow99.nodebridge.sample`
> 换一份带 ACL 的 Profile（DevEco 里申请 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`），再跑 1。
> 换 flags 必须 `aa force-stop` 后重开——**进程内 Node 每进程只能启动一次**（宪法 C5）。

## 4. 怎么读 `/facts`

| 观察 | 含义 |
|---|---|
| 有 JSON、`node=v24.x` | ✅ 进程内 Node 真的起来了 |
| `execPath=/system/bin/appspawn` | 正常：本平台没有独立 node 可执行文件，**不要拿它去 spawn** |
| `cpus=0` | 正常：`os.cpus()` 在本平台返回空数组，版本/并发探测**不得**依赖它 |
| `wasm.validate=true` | ✅ 真 JIT 生效（路线 J） |
| `wasm.validate=ERR:WebAssembly is not defined` + `hotloop` 数百 ms | 落回解释器（路线 I 的代价，规划 §D.8） |
| `expose_internals=OK` | ✅ 内部模块桩路线可用（需 `--expose-internals`） |
| `spawn.events.{data,exit,close}` 全 `true` 且 `zombie=false` | ✅ 子进程三事件齐全（与库能力矩阵 #8 一致） |
| `fetch_self=ERR:fetch failed`（jitless 下） | undici 的 llhttp 走 WASM ⇒ **fetch 与 JIT 强耦合**，jitless 下必然失败 |

## 5. 与库自带 `payload/selfcheck.js` 的分工

| | `payload/selfcheck.js`（库自带） | `rawfile/probe.js`（本样例） |
|---|---|---|
| 定位 | **契约冻结**的诊断面 | 样例 + 扩展探针 |
| 端点 | `/facts` `/log` `/rport` `/diag`（4 个，其余 404） | `/facts` `/log` |
| checks 键 | 16 个，`tools/smoke-host.mjs` ④ 做漂移检查 | 20+ 个，含 `expose_internals` / `worker_threads` |
| 谁能改 | 改契约才能改 | 随便改（它就是例子） |

想直接用库那份：把 `payload/selfcheck.js` 也放进 `src/main/resources/rawfile/`，把 `Index.ets` 里
`Env.materializeRawfile(..., 'probe.js', ...)` 的 `'probe.js'` 改成 `'selfcheck.js'` 即可。

## 6. 已知限制（真机实测，不是推测）

- **档 1 在本机必崩**：Profile 无 JIT ACL ⇒ `CRASH sig=5`。这是**平台前置**，不是样例 bug。
- **jitless 下 `fetch` / WASM 全废**：所以档 0 的 `fetch_self` 永远是失败——这本身是判据。
- **`aa start --ps` 只送得动一个 token**：多词 flags 会被截断/丢弃（表现是"选①跑②"）。故一律走 `probePreset`。
- HAP ≈ 129 MB（其中 `libnode.so` ≈ 121 MB）；该文件**来自运行时包 `@fellow99/node-runtime`**（HAR 内 `libs/arm64-v8a/`，构建时由 hvigor 合并进 HAP），本模块不含它。
