# 测试（host 侧门禁 + 真机自检）

> 契约出处：`logs/20261016-1/IMPLEMENTATION_CONTRACT.md` **§4**（host 侧工具与测试）· 规划 **§7.4 ③**（构建流水线）· 宪法 **C2/C3/C6/C7**。
> **口径**：本目录的用例只回答「**本机**能不能判」；「**设备上能不能跑**」必须由真机取证回答（下文四条读回通道）。
> 判据纪律见 **§禁止的判据**；任何"看起来成功"都不算证据（C6）。

## 一、三层结构（含**当前真实状态**）

| 层 | 载体 | 现状（2026-10-16 本机实测） | 依赖 |
|---|---|---|---|
| ① 运行时产物门禁（七项 ELF + SHA-256） | `tools/provision.mjs --check` | ✅ 已实现，可直接进 CI（本机 7 项全过，`v24.2.0 / arm64-v8a`） | 本地存在 `libnode-arm64.so`（缺则**明确 SKIP**，不假装通过） |
| ② ELF 独立交叉校验（六项，不含 SHA-256） | `tools/elf-inspect.py <so>` | ✅ 已实现（本机对 `pi-desktop-ark/entry/libs/arm64-v8a/libnode.so` → `VERDICT: PASS`） | python3 |
| ③ **host 侧门禁（不接真机）** | `tools/smoke-host.mjs` | ✅ **本次实现**；本机实测 `SMOKE: PASS`（4/4 段全 PASS，③ 段 6 个用例文件全 exit 0） | Node 24（`node` 在 PATH）+ ①② 的前置 |
| ④ 真机自检（端到端证书） | `payload/selfcheck.js` + `hdc fport` + `curl` | ✅ 脚本已实现（`/facts` `/log` `/rport` `/diag`）；⬜ **每轮真机都要重跑**（本文件给不出真机结论） | 已签名 HAP + 真机 + ACL（见 §三） |
| ⑤ 交叉编译引导件 | `tools/build-bridge.mjs` | ✅ 本次实现；⬜ **本次未运行**（hvigor 全量构建，且 `library/**` 正被并行修改 —— 见 §五） | `DEVECO_SDK_HOME` + `hvigorw.bat` |

**三层之外的一个重要区分**：`library/**`（ArkTS + NAPI 原生件）**没有任何 host 侧单测** —— 它的行为判定只能靠真机
（`/facts`、`/log`、`hilog`、崩溃记录）。不要用"编译过了"当运行期证据。

## 二、命令速查（本机可直接复制）

```bash
# ① 运行时产物门禁（七项 ELF + SHA-256；缺二进制时会明确报"三条出路"）
node tools/provision.mjs --check
node tools/provision.mjs --list            # 打印锁定项（版本 / SHA-256 / 门禁结果）

# ② ELF 独立核对（排障用；与 ① 的六项等价，不含 SHA-256）
python tools/elf-inspect.py ../pi-desktop-ark/entry/libs/arm64-v8a/libnode.so

# ③ host 侧门禁（本次新增；不接真机）
node tools/smoke-host.mjs                  # 4 段全跑：锁+产物 / ELF / payload 单测 / 契约漂移
node tools/smoke-host.mjs --skip-tests     # 只跑① ② ④（并行开发时先看契约漂移）
node tools/smoke-host.mjs --json "$PI_SCRATCH_DIR/smoke-report.json"   # 额外落机器可读报告

# ③′ 单个用例文件（调试用；smoke-host 会把它们各起一个子进程）
node tests/payload/tar-extract.test.mjs
node tests/payload/idempotency.test.mjs
node tests/payload/entry-resolution.test.mjs
node tests/payload/host-bridge.test.mjs
node tests/payload/log-format.test.mjs
node tests/payload/selfcheck-endpoints.test.mjs

# ⑤ 交叉编译引导件（走 hvigor externalNativeOptions；需要 DEVECO_SDK_HOME）
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
node tools/build-bridge.mjs --abi arm64-v8a
```

**退出码约定**：`smoke-host.mjs` = 0 全 PASS（SKIP 不算失败）/ 2 任一 FAIL；每个 `tests/payload/*.test.mjs` = 0 全过 / 1 有失败；
`provision.mjs` / `build-bridge.mjs` 失败一律 **2**。

## 三、真机自检（第四条：端到端证书）

```bash
hdc install -r <已签名 HAP>
hdc shell "aa start -a EntryAbility -b <bundleName>"

# ★ 一次真机成功运行的证书：/facts 的 JSON
hdc fport tcp:15577 tcp:15577
curl -s http://127.0.0.1:15577/facts | python -m json.tool

# 另外三条读回通道
curl -s http://127.0.0.1:15577/log                       # 日志尾 8192 B（含 CRASH 行）
curl -s -X POST --data 'ping' http://127.0.0.1:15577/rport  # 转发到 127.0.0.1:${RPORT_PORT}（缺省 19999）
curl -s http://127.0.0.1:15577/diag                      # 诊断面（契约 §3.6 端点表外的扩展）
hdc shell hilog -x | grep -E "node-bridge|Cpp Crash"     # 辅助留档（**不作反证据**，见 §禁止的判据）
```

- ⚠️ **端口冲突会让整个应用进程 abort**（§D.10 ⑰ 实测）：探针应用与消费方应用会争端口 ⇒ **测谁就先 force-stop 另一个**。
- `selfcheck.js` 在应用域绑定 `127.0.0.1`，端口取 `SELFCHECK_PORT`（缺省 15577）；`hdc fport` 只是把宿主端口接到设备上。
- 沙箱里的 `node.log` **`hdc` 读不到**（debug 签名也 `permission denied`，宪法 §三 纪律 2）⇒ 一律用 `/log` 读回。

### 真机判定基线（规划 §D.8 / §D.9，HAD-W32 / HarmonyOS 6.1.0 / API 26 / arm64-v8a）

| 轮次 | flags | 期望（可证伪） |
|---|---|---|
| ① JIT（无 ACL） | `--no-verify-heap` | ❌ `CRASH sig=5`（SIGTRAP），`si_addr == pc`，系统判 `Cpp Crash` |
| ①′ JIT（无 ACL + 两个开放权限） | 同上 | ❌ **仍 SIGTRAP** ⇒ 开放权限**不能**替代 ACL |
| ② 解释器 | `--jitless --no-verify-heap` | ✅ 全绿：`platform=openharmony`、`arch=arm64`、`versions={v8 13.6.233.10-node.17, uv 1.51.0, modules 137}`；`/facts` 200；`fs_write_readback=OK`；`worker_threads=true`；`os.networkInterfaces()` 含 `lo`；`os.cpus()` 长度 0；`cwd=/`；`execPath=/system/bin/appspawn`；热循环 **299 ms / 5 轮**（§D.9 复验 296 ms）；`spawn` 的 `data`/`exit`/`close` 三事件齐全 |
| ②′ 锁定产物复验 | 同 ② | ✅ HAP 内 `libnode.so` SHA-256 = 锁值；`hilog` 中 `xpm`/`unsigned file` **0 命中**；绝对路径 `dlopen` 全失败、**裸名成功** |
| ③ 内部模块 | `--jitless --expose-internals --no-verify-heap` | ✅ `require('internal/modules/cjs/loader')` 成功 |
| ④ ACL 生效（消费方真机） | 不带 `--jitless` | ✅ 无 `Cpp Crash`；`wasm.validate=true`；热循环 **6–9 ms / 2e6**（约 7–10× 提速） |

⇒ `--jitless` **不是**可用降级路径（WASM 全废、`fetch failed`）；**`ALLOW_WRITABLE_CODE_MEMORY`（ACL）是刚性前置**（§4.7 / §D.8 / §D.10）。

## 四、本目录的文件（host-only vs device-only）

| 文件 | 角色 | host | device |
|---|---|---|---|
| `lib/mini-assert.mjs` | 零依赖 ESM 微测试框架（`test/assert/assertEq/assertThrows`，失败 → 退出码 1） | ✅ 仅 host | — |
| `lib/util.mjs` | 公共设施：载荷加载（缺文件报 `MISSING:`）、临时目录、子进程、`expectRejects`（带看门狗） | ✅ 仅 host | — |
| `lib/tar-fixtures.mjs` | **手写 512 字节 tar 头**生成夹具（ustar + `prefix` + GNU `L` + pax `x`/`g` + 结束零块） | ✅ 仅 host | — |
| `lib/log-format.mjs` | 契约 §1.3 的参考解析器 + "手写前缀"检测器 | ✅ 仅 host | — |
| `payload/tar-extract.test.mjs` | 解包器 13 项（普通/嵌套/prefix/L/x/g/空/300 KB/穿越/绝对路径/截断/零块/无零块） | ✅ 仅 host | 被测对象 `payload/lib/tar-extract.js` 在设备上跑 |
| `payload/idempotency.test.mjs` | 归档就绪幂等：首次解包 + marker / 二次 skip 且 mtime 不变 / 哈希不符硬失败 | ✅ 仅 host | 被测对象 `payload/bootstrap.js` 在设备上跑 |
| `payload/entry-resolution.test.mjs` | 契约 §3.3 四条：绝对 / 相对 / 缺席→`index.js` / `package.json` main（+ESM） | ✅ 仅 host | 同上 |
| `payload/host-bridge.test.mjs` | `payload/host.js`：默认 reject `transport-unavailable` / 超限 / `ok:false` reject / `ok:true` resolve / 超时 / 注册表 | ✅ 仅 host | 真传输层（`napi_threadsafe_function`）属 Phase 2 |
| `payload/log-format.test.mjs` | §1.3 行格式解析 + `selfcheck.js` 不得自己拼前缀（含检测器正/负控） | ✅ 仅 host | 前缀由原生 reader 线程生成（仅设备） |
| `payload/selfcheck-endpoints.test.mjs` | 随机端口起 `selfcheck.js`，`fetch` `/facts` `/log` `/diag` `/rport` + 404 + 冻结 checks 键 | ✅ 仅 host（用宿主 Node 跑同一个脚本） | 同一脚本在设备上由 `node::Start` 加载 |
| `../tools/smoke-host.mjs` | host 门禁总入口（含**契约漂移**检查） | ✅ 仅 host | — |
| `../payload/selfcheck.js` | 端到端证书脚本 | ✅（host 测试把它当被测对象） | ✅ **主战场**（`/facts`） |
| `../library/**` | ArkTS + NAPI 引导件 | ❌ 无 host 用例 | ✅ 只能真机判（`/facts`、`/log`、`hilog`、`last-crash.json`） |

## 五、与并行实现的接口约定（避免"测的是另一份接口"）

1. **候选路径**：`payload/lib/tar-extract.js`（契约 §3.7 冻结路径，报错文本以它为准）→ `payload/tar-extract.js`（`specs/004 plan.md` 记的变体）。
   测试按此顺序加载，两处都没有时才会报 `MISSING: payload/lib/tar-extract.js — 期望导出 extractTarGz`。
2. **异步契约**：`extractTarGz(archive, dest, opts?)` 返回 **Promise**（流式实现）；越界条目是 **reject**，不是同步 throw。
   测试两种形态都接受（同步实现同样通过），但**必须是"抛/拒"而不是"静默跳过"**（契约 §3.7「必须抛错」）。
3. **marker 冲突已登记**：契约 §3.2 冻结 `<payloadRoot>/.ready-<sha256 前 12 位>`（内含完整 sha256），
   而 `specs/004 plan.md` §4.4 写的是 `<payloadRoot>/<archive 基名>.sha256`。**测试按冻结契约断言**，
   失败文本会一并打印实际目录内容，便于裁决。
4. `/diag` **不在**契约 §3.6 的端点表内（表里只有 `/facts` `/log` `/rport` + "其它 ⇒ 404"）：
   测试允许 404（默认）或 200（扩展诊断面），但 **5xx 一律 FAIL**。
5. `/rport` 的对端按**混合形态**实现：既接受裸 TCP 转发，也能应答 HTTP forward（消费方那条通道讲 HTTP）。
6. `PI_WEB_ENTRY`：契约 §3.1 列为"兼容保留"，`specs/004 FR-004-020` 要求库侧不得解释 `PI_*`（C1）⇒
   `smoke-host` 的漂移检查**不要求**它存在（只提示），其余 6 个 `NODE_BRIDGE_*` 名字齐全才算 PASS。

## 六、禁止的判据（写进库的纪律，验收脚本里不许出现）

1. ❌ 用 `hilog`「**有没有那一行**」判执行 —— 应用侧 INFO 常不进 dump 缓冲；"没看到"的三种成因（没执行 / 被级别滤 / 被缓冲冲掉）不可区分。
   hilog 只能作**正**证据（看到即执行过），**不能**作反证据。
2. ❌ 用 `VmSize` 判 V8 是否起来 —— ArkTS/ArkWeb 自占约 **40 GB** 虚拟地址空间，总量看不出 V8。
3. ❌ 用「点击看起来生效」判 UI —— 本机 `uitest dumpLayout` 也拿不到结果 ⇒ UI 判据必须用**前后两次 dumpLayout 差异**或 HTTP 读回。
4. ❌ 把 `/log` 里的噪声（`dup2` 时代混进来的 `arkweb/chromium_ext/…`）当失败判据 —— 它是宿主输出，不是载荷错误。
5. ❌ 用 `statSync`/"写入成功"判载荷就位 —— 一律**读回**（C3：`require`/`readFileSync` 一次，或 `/log` 端点）。

## 七、已知未覆盖（诚实的空白清单）

| 项 | 为什么没覆盖 | 应该怎么补 |
|---|---|---|
| ArkTS 侧（`library/**`）：状态机、`logs()` 环、`lastCrash()`、`Logger.tail` 的 UTF-8 | host 上跑不了 ArkTS/NAPI | 真机 + 消费方诊断面板；`/log` 读回 |
| 真传输层（Node ⇄ ArkTS 的 `napi_threadsafe_function`） | Phase 2 才实现；现在只有"未接线必须结构化 reject" | Phase 2 的 spec/plan 用例 + 真机 |
| `libnode.so` 真机行为（ACL、裸名 `dlopen`、`spawn` 事件语义） | 只有设备能给答案 | `_test/test_node_probe` 探针（§D.7）+ 本目录 §三 |
| 零解压只读直读（`resfile/`，P0-13） | 本工程未做 | 消费方 payload 落地后真机 `/facts` |
| `compressNativeLibs` 的实际压缩结果（`compress_type == 8`） | 需查**签名 HAP**，不查磁盘（§5.9） | 附录 A 的 `zipfile` 一行命令 |
| 大载荷解包耗时（27.2k 文件 / 884 MB，P0-5） | 需要真机 + 真实载荷 | 真机 + 日志里的解包耗时行 |
| 运行时版本升级矩阵（v22.19+ / 24.x × API 17/24/26） | 未做兼容矩阵回归 | 换锁文件后按 §D.8 五个轮次重跑 |
| `mini-assert` 无超时保护：某个用例若卡在**同步**调用上会挂住 | 零依赖刻意不做进程级看门狗（异步路径已有 `expectRejects` 看门狗） | CI 侧给每个用例文件加超时（`smoke-host` 已设 300 s 子进程超时） |
