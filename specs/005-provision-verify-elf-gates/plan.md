# 005-provision-verify-elf-gates — 模块计划（plan.md）

> **模块**：运行时获取与校验 · ELF 门禁与投放（host 侧工具链）
> **性质**：技术实现计划（选型结论、数据模型、接口契约、算法、错误面、测试与遗留）。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10 / G3–G5 / G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」：§5.8 · 附录 G 全文 · 附录 D.4–D.6/D.9 · §7.4 · §9.3 · §4.1 第 10/14 项 · R2/R8/R20/R21/R22）· `specs/STRUCTURE.md` / `TECH.md` 口径 · 本仓库与 `../ohos-node-runtime/` 实测。
> **标记**：✅实测 / 🔶沿用 / ⬜待验证 / ⚠️冲突或风险。**本文件的行号一律指 as-built 文件**（`tools/*` 与 `runtime.lock.json` 本次逐行读过）。
> **版本**：v1.0 · 2026-10-16 · 状态：实现已落地（三件套 + 锁文件），未落地项见 §9。

---

## 1. 技术上下文

### 1.1 运行环境

| 项 | 值 | 说明 |
|---|---|---|
| 开发机 | Windows + **Git-Bash**（`bash` 语义、`/d/...` 路径） | 仓库与缓存目录都在同一台机器的 `D:` 盘；`/d/pi-workspace/{ohos-node-bridge,ohos-node-runtime}` |
| 工具链 Node | 本机 ✅ `node v24.7.0` | 脚本要求 **Node ≥ 18**（用到内置 `fetch` 与 `node:` 前缀导入）；其中 **`NODE_USE_ENV_PROXY` 需 Node ≥ 24**（工具自己的提示文本就这么写：`provision.mjs:253`） |
| 仅排障用 Python | Python 3（`hashlib` / `struct` / `sys`，无 pip 包） | 只服务 `tools/elf-inspect.py`；门禁不依赖它（`provision.mjs:85` 注释点明「不依赖 python/llvm」） |
| 目标 ABI | `arm64-v8a`（AArch64） | 只做真机；x86_64 明确不做（`openItems[2]`） |
| 真机基线 | HAD-W32 / HarmonyOS 6.1.0 / **API 26** / arm64-v8a | 锁文件 `verifiedDevice`；与工程 `targetSdkVersion 6.1.1(24)` 不是同一个口径（TECH §5-1） |
| 产物落点 | `<模块>/entry/libs/<abi>/`（消费方）· `library/libs/arm64-v8a/`（本仓库 CMake 输出） | 规划 §7.2 写的是 `library/src/main/libs/...`，实际 CMake 输出在 `library/libs/...`（STRUCTURE §8.1）⚠️ 与 `--out` 的取值有关，但不改变工具行为 |

### 1.2 依赖（零第三方）

| 侧 | 依赖 | 用途 | 缺失后果 |
|---|---|---|---|
| `tools/provision.mjs` | `node:crypto`（`createHash`）· `node:fs` · `node:path` · `node:child_process`（`spawnSync`）· `node:url`（`fileURLToPath`）· `node:os`（`tmpdir`） | 哈希、读写、子进程调自签工具、定位仓库根、临时目录 | — |
| `tools/ohos-selfsign.mjs` | `node:fs` · `node:crypto` | 读写 ELF、SHA-256 | — |
| `tools/elf-inspect.py` | `hashlib` · `struct` · `sys` | 只读自解析 | 只影响排障，不影响门禁 |
| 外部程序 | 无（**不需要** `llvm-objcopy` / `llvm-readelf` / Java / `binary-sign-tool`） | — | — |
| 运行期外部输入 | ohos-sdk（取 `libc++_shared.so`）· 本地运行时缓存 · （可选）网络 | 见 §5.2 | 缺 SDK ⇒ 投放硬失败（`exit 2`）；缺缓存 ⇒ 给三条出路 |

✅ 实测零依赖：本文件全部命令只用了 `node`、`python`、`sha256sum`、`bash` 内建。

---

## 2. 宪法合规检查（逐条）

| 原则 | 结论 | 依据 |
|---|---|---|
| **C1 库/壳分离** | **合规**：`tools/` 与 `runtime.lock.json` 不含任何宿主语义（无 `PI_*`、无窗口/路由）；`provision.mjs` 打印的「下一步」只是构建命令 | `provision.mjs:338` |
| **C2 不隐藏平台真相** | **基本合规，一处缺口**：失败一律 stderr + `exit 2`；缺 `libc++_shared.so` 时明说「`dlopen` 会**静默失败**」；缺产物时给三条出路；代理未开时打印正确命令。⚠️ 缺口：`elf-inspect.py` 的 `VERDICT: FAIL` **仍返回 0**（§6.3-⑪），CI 若直接把它当门禁会**假绿** | `provision.mjs:49,255,258-266,302-303` · `elf-inspect.py:165` |
| **C3 让最终使用者去读** | **合规**：幂等判定就是「**读回**目标文件的 SHA-256 再比」（不是「我拷过了」）；`--sign` 之后当场对**落地文件**跑 `verify` | `provision.mjs:292,307,333` |
| **C4 启动参数不可事后修改** | **不适用**：本模块不装配 `execArgv`，也不提供运行期改参数的路径 | — |
| **C5 单例不可重启** | **不适用**：纯 host 侧工具；也不输出任何「崩了自动重投/自动重试」的暗示 | — |
| **C6 诊断优先于修码** | **合规**：本模块只声明 host 侧**必要条件**；功能判据留给真机 `/facts`（§D.8/§D.9 证据链）。`--check` 的输出本身就是可粘贴的证据 | spec §7-A9 · §D.9 |
| **C7 零上游补丁 / 二进制可替换** | **合规（本模块的核心）**：① 不改上游产物的**语义字节**（自签只在尾部**追加**页对齐段，`add-section` 原字节一字不动）；② 默认**不改** `PT_GNU_RELRO.p_align`（§D.4 实测校正），只在显式 `--relro-align8` 时对齐官方工具行为；③ 库只依赖 ELF 属性 + `node::Start` 符号 ⇒ 换运行时 = 改锁文件一行；④ 供应链三件套（来源 + SHA-256 + 许可）+ `verifiedOn/verifiedDevice` | `ohos-selfsign.mjs:17-18,81-90,213-261` · 锁文件 `source`/`verified*` |
| **S1–S3（ArkTS 严格模式 / barrel / 类型即契约）** | **不适用**（无 ArkTS 代码）；但锁文件字段可视作**跨模块契约**：新增字段要同步 `specs/` 与本表 | — |
| **S4 路径一律绝对** | **合规**：`REPO` 由 `import.meta.url` 推导；`--out` 相对路径显式按 `process.cwd()` 解析；本地缓存路径用 `resolve`；**不依赖**运行期 cwd 之外的隐式状态 | `provision.mjs:30-32,75-82,287` |
| **S5 信号上下文禁用 stdio** | **不适用**（无 C 代码） | — |
| **S6 native 产物落点固定** | **相邻模块（002）**；本模块的 `--out` 要与它一致（`<module>/libs/${OHOS_ARCH}`） | 规划 §5.9 |
| **S7 引导件不链接 libnode** | **相邻模块（002）**；本模块的投放顺序不假设任何链接关系 | — |
| **S8 C 侧只有 3 个接口** | **不适用** | — |
| **S9 日志双通道** | **类推适用**：progress 走 stdout、失败走 stderr；`--quiet` 只静默 stdout（**不静默失败**） | `provision.mjs:47-49` |
| **S10 二进制不入库** | **合规（本模块的核心）**：120.9 MiB 产物**只**存在于 `../ohos-node-runtime/`（父工程 `.gitignore`）与消费方 `libs/<abi>/`；仓库里只有锁文件 + 工具；HAR 侧另有 `library/.ohpmignore:11` | 附录 G.1 · STRUCTURE §8 |
| **G3 不含浏览器内核** | 不引入任何渲染物 | — |
| **G4 第三方许可随包** | 本模块**提供素材**（`source.license` + `sha256`）；⚠️ 真正随包的清单文件仍缺（TECH §5-6） | §9.3 第 2 项 |
| **G5 ELF 合规** | 明确「HAP 内原生库**不需要** `.codesign`」⇒ 默认不签；`--sign` 只服务独立分发 | §D.6/§D.9 · R22 关闭 |
| **G11 不得含绕过代码签名/W^X 的组件** | **不触碰**：本模块只做「合法自签」；附录 D 的技术②（无 ACL 拿可执行内存）**不在**本模块实现内，只登记为路线 J′ | §9.5 · R23 |

---

## 3. 研究结论（为什么这样选）

### 3.1 为什么选定 `electerm/ohos-node-shared` v24.2.0，否掉另外两个候选

| 候选 | 产物形态（实测判据） | 结论 |
|---|---|---|
| **`electerm/ohos-node-shared`** tag `ohos-node-shared-v24.2.0` | Release 资产 `libnode-arm64.so`：`e_type=DYN`、**`PT_INTERP=0`**、`SONAME=libnode.so.137`、`DT_NEEDED=[libc++_shared.so, libc.so]`、`node::Start` **已导出**、SHA-256 与仓库声明**逐字节一致**、带 `.note.ohos.ident`；ICU/V8 快照**内嵌**（`icudtl.dat` / `snapshot_blob.bin` 零命中）⇒ HAP 只需 2 个 `.so` | ✅ **选定**（附录 D 候选表 · 本机复核 `--check` 七项全过） |
| `hqzing/ohos-node` | `bin/node` 是 **PIE 可执行文件**（`PT_INTERP=1`、无 SONAME）；release 上 `libnode-arm64.so` / `libnode.so` / `libnode-v22.19.0-arm64.so` **全部 404**（不发共享库） | ❌ **不能嵌入**（`dlopen` PIE 必崩）；🔶 外部实测，非本机复现 |
| `nilpwoer/build-ohos-node` | **无 tag / 无 release**（无产物可下）；脚本是 hqzing 的降级副本（缺 `-fno-emulated-tls`、缺 v22 的 `-std=c++20` 补丁、用旧 OHOS 每日构建 API） | ❌ **无可取产物** |
| `Bibapcs/ohos-node-jit-patch` | **不是产物来源**：给独立 `node` 进程用的 `LD_PRELOAD` shim（本工程是 App 进程内 `dlopen`，没有这一层）。但它给出**自签算法**与「无 ACL 拿可执行内存」两条技术 | ✅ 只**合法复用**其算法（MIT 归属写进文件头），产物不用 |

### 3.2 为什么 `PT_INTERP = 0` 是硬门槛

PIE 产物**能 `dlopen` 成功**，但 V8 在 `Isolate::Initialize` 的**首次堆分配**就崩（TLS 别名问题），症状是一条指向运行时的崩溃，极易被误判为「库的问题」「平台的问题」（硬约束 ① · R2）。因此不能靠「跑一下看看」，必须在上游字节层面判死：
把「`PT_INTERP` 计数 = 0」做成**门禁② + `elf-inspect.py` 的 VERDICT 项**，不合格**直接换产物**；Phase 3 才有自建兜底（§G.6-C）。

### 3.3 为什么**锁文件入库**而**二进制不入库**

| 维度 | 锁文件（~2.9 KB JSON） | 二进制（120.9 MiB） |
|---|---|---|
| git | ✅ `diff` 即审计，无体积/版权问题 | ❌ GitHub 单文件 **100 MiB 硬限**（直接 commit 不可能） |
| LFS | — | ❌ 会让 clone 变成「必须联网 + 装 LFS」的重操作 |
| 历史 | 每次换版本只留一行 diff | ❌ 每次换版本在历史里留下**永久**的 120 MB |
| 获取 | — | 本机缓存（可重建）→ `--from` → `--download`；三条出路有明确文本 |

⇒ 结论：**clone 本库能回答「该用哪个二进制、校验值多少、怎么投放、验过没有」**，但不会把 120 MB 塞进仓库（附录 G.1/G.5 · S10）。

### 3.4 为什么否掉 submodule / 制品库 / 「等自建再开工」

| 做法 | 否掉理由（一手依据） | 现在用什么替代 |
|---|---|---|
| git submodule 指向上游构建仓库 | 上游**不动二进制**（无 release）⇒ 拿到的只是构建脚本；且把「取产物」变成「必须联网 clone 别人的仓库」 | 锁文件 + 本地缓存 |
| 直接 commit 二进制 | 见 §3.3 | 同上 |
| 引入制品库（Nexus / OSS / 私有 registry） | 本工程与消费方**都没有**现成制品库；为一枚可校验的 `.so` 引入一套服务，运维成本 > 收益 | 本机缓存 + 三级来源；镜像 Release 待建（§9 路线 B） |
| 等自建产物再开工 | 自建是**数小时级**构建（首次拉 SDK/LLVM ~3 GB、V8 release 补丁）⇒ **不该阻塞链路可行性**；库只依赖 ELF 属性与 `node::Start` 符号 | 先用现成产物（风险 R8 显式登记），相位 3 再替换 |

### 3.5 为什么 `libc++_shared.so` **不固化哈希**；以及「版本项」的三处口径 ⚠️

- `libc++_shared.so` 是 **ohos-sdk 的交付物**（`native/llvm/lib/aarch64-linux-ohos/`），随 SDK 版本变化 ⇒ 锁文件只固化**来源规则**（`libcxx.sdkRelPath`），运行时从本机 SDK 取并**按内容做幂等**（目标 sha == 源 sha 才跳过）。把它固化哈希会让「SDK 小版本升级」变成锁文件维护事故（附录 G.7 · PROVENANCE §5）。
- **版本项口径不一（⚠️ 本次实际发现）**：
  | 出处 | 说法 |
  |---|---|
  | 规划 §5.8 / 锁文件 `gates.versionGeq2219` | 运行时须满足 `process.version >= 22.19.0` |
  | `provision.mjs` 门禁⑦（`:185`） | 只判「**大小一致** + 产物含锁定的版本串 `v24.2.0`」——**没有任何数值比较** |
  | `tools/elf-inspect.py` | 六项**不含版本项**（只有 e_type/e_machine、PT_INTERP、DT_NEEDED、`node::Start`、`.codesign`、SHA-256） |
  | 谁读 `gates`？ | **没有任何工具读**（`grep -c gates tools/*` → `provision.mjs:2`，两处都是函数名/字段名，非 `entry.gates`）⇒ 锁里的 `gates` 是**只写文档**，可以静默漂移 |
  ⇒ 当前「版本矩阵」是**名义合规**：形态门禁通过 ≠ 引擎下限被验证。补法见 §10 D-3（要么实现比较，要么把措辞降级为「版本串存在」）。

### 3.6 为什么自签可以**离线自足**

- `binary-sign-tool sign -selfSign 1` 的算法被完整逆向：**纯 SHA-256 Merkle（4K 页）+ fs-verity descriptor**，`ElfSignInfo(8B)+descriptor(256B)+SHA256(descriptor)(32B)=296 B` 填进页对齐的 4096 B `.codesign` 段，**无私钥、无证书**（`FLAG_SELF_SIGN=0x10`、`csVersion=3`）。
- 本机自实现 `add-section`（llvm-objcopy **做不到**页对齐：实测 `sh_addralign=1`、偏移非页对齐）⇒ 去掉对 SDK Java 工具与 LLVM 的依赖，整条自签链**离线自足**（§D.4/§D.5）。
- ✅ 本轮进一步在**锁定的 120.9 MiB 真实产物**上验证：`add-section → sign → verify`（十项全过）→ `selftest` = **IDENTICAL**（附录 D 原先只在 35 KB `wxjit.so` 上验过 `selftest`）。
- ⚠️ 但设备侧**不需要**它：HAP 签名即授予其自带原生库执行权限（§D.6 + §D.9 复验，`hilog` 中 `xpm`/`unsigned file` 0 命中）⇒ `--sign` 只服务「脱离 HAP 独立分发」（G5 · R22 关闭）。

### 3.7 为什么保留上游资产**原名**而用 `deployAs` 改名

库里放的是「**某次 release 的某个资产**」：改名后就无法自证它对应哪个 URL，`SHA256SUMS` / PROVENANCE / 与上游比对也失去锚点。统一改名只发生在**投放那一刻**（`deployAs: "libnode.so"`）——HAP 里必须是 `libnode.so`（引导件按裸名 `dlopen`，§D.8 偏差表），但缓存目录里必须是 `libnode-arm64.so`（附录 G.2）。

---

## 4. 数据模型（`runtime.lock.json` 逐字段）

### 4.1 顶层

| 字段 | 类型 | 必填 | 含义 / 约束 | 当前值 | 谁读 |
|---|---|---|---|---|---|
| `schema` | number | ✅ | 结构版本；当前 `1` | `1`（`:2`） | ⚠️ 无工具读（§10 D-12） |
| `active` | object | ✅ | `{node, abi}`：当前选用的产物；**换版本就是改这一行**（§G.7） | `{"node":"v24.2.0","abi":"arm64-v8a"}`（`:3`） | `provision.mjs:57,58,67` |
| `runtimes[]` | array | ✅ | 每个可用产物一条（见 4.2） | 1 条（`:4-47`） | `provision.mjs:59,66` |
| `libcxx` | object | ✅ | `libc++_shared.so` 的**来源规则**（不固化哈希） | 见 4.5 | `provision.mjs:199,305` |
| `localStore` | object | ✅ | 本地缓存目录约定 | 见 4.5 | `provision.mjs:74,77` |
| `openItems[]` | array\<string\> | ✅ | **未闭环事项**（故意留在文件里，让「未完成」跟着代码走，§G.7） | 3 条（`:59-63`） | ⚠️ 无工具读（人读） |

### 4.2 `runtimes[i]` 字段表

| 字段 | 类型 | 必填 | 含义 / 约束 | 当前值（`:6-45`） | 谁读 |
|---|---|---|---|---|---|
| `node` | string | ✅ | Node 版本串，必须**同时**是产物内可命中的字面串 | `v24.2.0` | `provision.mjs:59,168（版本串）,185` |
| `nodeModuleVersion` | number | ✅ | `NODE_MODULE_VERSION`，决定原生 addon ABI；应等于 `SONAME` 尾号 | `137` | ⚠️ 无工具读（D-12） |
| `abi` | string | ✅ | 目标 ABI；与 `active.abi` 配对选择 | `arm64-v8a` | `provision.mjs:59` |
| `file` | string | ✅ | 缓存目录里的**上游资产原名**（不改名，§3.7） | `libnode-arm64.so` | `provision.mjs:79-81` |
| `deployAs` | string | ⬜ 可选 | HAP 内的落点文件名；缺省 `libnode.so` | `libnode.so` | `provision.mjs:290` |
| `size` | number | ✅ | 字节数；门禁⑦ 比对 | `126809264` | `provision.mjs:274,185` |
| `sha256` | string(64 hex) | ✅ | 原始**未签名**产物的 SHA-256；门禁⑥ 比对 | `3019bf5f…51a1` | `provision.mjs:273,278` |
| `soname` | string | ✅ | `SONAME`；与 addon ABI 相关（R18） | `libnode.so.137` | ⚠️ 仅 `elf-inspect.py` **打印**，不是判据（D-12） |
| `needsLibcxx` | bool | ✅ | 是否需要随行投放 `libc++_shared.so` | `true` | ⚠️ 锁字段无工具读；门禁④ 是**重新解析产物**得到（`provision.mjs:132`） |
| `embeds` | object | ✅ | `{icu, v8Snapshot}`：是否内嵌（决定 HAP 是否需要外置数据文件） | `{icu:true, v8Snapshot:true}` | ⚠️ 无工具读（D-12） |
| `flags` | object | ✅ | `{exposeInternals, emitJitless}`：产物内已编译进去的 flag | `{exposeInternals:true, emitJitless:true}` | ⚠️ 无工具读（D-12） |
| `signed` | object | ✅ | `{codesign:bool, note}`：上游资产自带签名段与否 + 处置说明 | `{codesign:false, note:"…"}` | ⚠️ 无工具读（人读；`--sign` 是**运行期探测** `.codesign`，`provision.mjs:322`） |
| `source` | object | ✅ | 出处（见 4.4） | 见 4.4 | `repo`（`:68`）· `url`（`:239,265`） |
| `mirror` | object | ✅ | 镜像（可选存在）：`kind:null` 表示未建立 | `{kind:null, note:"…"}` | `provision.mjs:239`（`mirror?.url`） |
| `gates` | object | ✅ | 七项门禁的**存档**（见 4.3） | 七项全过 | ⚠️ **无任何工具读**（D-3/D-12） |
| `verifiedOn` | string(date) | ✅ | 真机验证日期（宪法 §六.2 要求换版本时写回） | `2026-10-16` | ⚠️ 无工具读（审计用） |
| `verifiedDevice` | string | ✅ | 机型 / 系统 / API / ABI | `HAD-W32 / HarmonyOS 6.1.0 / API 26 / arm64-v8a` | ⚠️ 同上 |
| `verifiedNotes` | string | ✅ | 验证结论与**前置条件**（例：无 ACL 必带 `--jitless`，否则 SIGTRAP 是平台前置） | 见 `:45` | ⚠️ 同上 |

### 4.3 `gates` 七项子字段

| 子字段 | 期望 | 与工具的关系 | 当前值 |
|---|---|---|---|
| `typeDyn` | `true` | 对应门禁①（`provision.mjs:179`） | `true` |
| `ptInterp` | `0`（**数值**，不是 bool） | 对应门禁②（`:180`） | `0` |
| `machineAArch64` | `true` | 对应门禁③（`:181`） | `true` |
| `neededLibcxx` | `true` | 对应门禁④（`:182`） | `true` |
| `exportsNodeStart` | `true` | 对应门禁⑤（`:150-166,183`） | `true` |
| `sha256Match` | `true` | 对应门禁⑥（`:273,278`） | `true` |
| `versionGeq2219` | `true` | **无实现**：门禁⑦ 只查「大小 + 版本串」（`:185`）⚠️ | `true` |

> 约束：这七项是**结论存档**，工具每次都重新解析产物；因此**改了产物必须同步改这里**，否则文件自相矛盾（没有人会拦你 —— D-3）。

### 4.4 `source` 子字段

| 子字段 | 类型 | 含义 | 谁读 |
|---|---|---|---|
| `kind` | string | 来源类型（当前 `"github-release"`） | ⚠️ 无工具读 |
| `repo` | string | 上游仓库 `owner/name` | `--list` 输出（`:68`）、错误提示 |
| `tag` | string | Release tag（`ohos-node-shared-v24.2.0`） | ⚠️ 无工具读 |
| `asset` | string | 资产名（应与 `file` 一致） | ⚠️ 无工具读 |
| `url` | string | 资产直链；`--download` 的目标、错误提示里的「上游」 | `provision.mjs:239,265` |
| `license` | string[] | 许可清单素材（G4） | ⚠️ 无工具读（`007-distribution` 用） |
| `builtWith` | string | 上游构建方式（可复现线索，R8） | ⚠️ 无工具读 |

### 4.5 `libcxx` / `localStore` 子字段

| 对象 | 子字段 | 含义 | 当前值 | 谁读 |
|---|---|---|---|---|
| `libcxx` | `file` | 投放进 `libs/<abi>/` 的文件名 | `libc++_shared.so` | `provision.mjs:305` |
| | `from` | 来源类别（`"ohos-sdk"`） | `ohos-sdk` | ⚠️ 无工具读 |
| | `sdkRelPath` | SDK 内相对路径 | `native/llvm/lib/aarch64-linux-ohos/libc++_shared.so` | `provision.mjs:199` |
| | `abi` | 适用 ABI | `arm64-v8a` | ⚠️ 无工具读（D-12） |
| `localStore` | `path` | 缓存目录（相对**仓库根**） | `../ohos-node-runtime` | `provision.mjs:77` |
| | `envOverride` | 覆盖用环境变量名 | `OHOS_NODE_RUNTIME_DIR` | `provision.mjs:74` |
| | `layout` | 目录/命名约定的**人读**描述 | `node-<version>/<上游资产原名>.so + SHA256SUMS` | ⚠️ 无工具读 |

### 4.6 `openItems` 语义

不是注释、不是 TODO 列表，而是**随代码走的未闭环登记**（§G.7）：当前 3 条 = ① 公开镜像 Release 未建（第三方只能按 `source.url` 自取 + SHA-256）；② 自建配方只归档未 vendor（`tools/rt-build/` 不存在）；③ x86_64 不做（决策已定）。**闭环时要删条目**，而不是留着一串永远为真的句子。

### 4.7 写入规则（换运行时版本时必须同步什么）

| 步 | 动作 | 必须同步 / 校验 | 依据 |
|---|---|---|---|
| 1 | 取候选产物，放 `<缓存>/node-<版本>/`（**保留上游原名**） | 目录名 = `node-<上游版本>` | §G.2 |
| 2 | 实测 `size` 与 `sha256`（`sha256sum`、`stat`），**不许手抄** | 二者必须来自真实文件 | §5.8 |
| 3 | `runtimes[]` 追加一条：`node` / `nodeModuleVersion` / `abi` / `file` / `deployAs` / `size` / `sha256` / `soname` / `needsLibcxx` / `embeds` / `flags` / `signed` / `source` / `mirror` / `gates` | `nodeModuleVersion` ↔ `soname` 尾号一致 | §G.7 |
| 4 | 改 `active`（一行）切换 | 只改这一行即可换版本（C7） | §G.7 |
| 5 | 重跑 `node tools/provision.mjs --check` | 七项全过；失败即停（不要先改锁再改产物） | 宪法 §六.2 |
| 6 | 跑真机探针并把 `verifiedOn` / `verifiedDevice` / `verifiedNotes` 写回 | 宪法 §六.2 明文要求 | §D.9 |
| 7 | 更新缓存目录 `SHA256SUMS` 与 `node-<版本>/PROVENANCE.md` | `sha256sum -c SHA256SUMS` 必须通过 | 缓存 `README.md` §4 |
| 8 | `openItems` 增删（闭环即删；新缺口即加） | 镜像一旦建好，回填 `mirror` 并删第 1 条 | §G.6-B |

**不得做的事**：篡改产物后「就地把锁文件哈希改掉」（PROVENANCE §7 明文禁止）；把签名版当原件记进 `sha256`（签名改变文件内容 —— `--check` 只认未签名原件）。

---

## 5. 接口契约

### 5.1 提供：CLI 参数、退出码、输出文本

| 参数 | 取值 | 默认 | 效果 | 落点 |
|---|---|---|---|---|
| `--out <dir>` | 目录（相对/绝对） | 无；投放时必填 | 投放目标；不存在则递归创建；相对路径按 `process.cwd()` 解析 | `:285-288` |
| `--check` | flag | off | 只校验；**在任何写入之前**返回 | `:282` |
| `--list` | flag | off | 打印锁定清单后 `exit 0` | `:65-71` |
| `--from <path>` | 文件路径 | 无 | 显式来源，**优先于本地目录**；⚠️ **不支持 URL**（见 D-4） | `:234,236` |
| `--download` | flag | off | 仅当没有任何本地来源命中时，按 `mirror.url` → `source.url` 联网获取 | `:238-257` |
| `--sign` | flag | off | 投放后：无 `.codesign` 则 `add-section` → `sign` → `verify` | `:315-335` |
| `--node <ver>` | 版本串 | `active.node` | 选择 `runtimes[]` 条目；不存在 ⇒ `exit 2` + 可用清单 | `:57,60-63` |
| `--abi <abi>` | ABI | `active.abi ?? "arm64-v8a"` | 同上 | `:58` |
| `--sdk <path>` | SDK 根 | 无 | `libc++_shared.so` 定位的第一优先根 | `:201` |
| `--force` | flag | off | 忽略幂等跳过，强制重拷两个文件 | `:292,307` |
| `--quiet` | flag | off | 静默 **stdout 进度**；**失败仍走 stderr** | `:47-49` |

| 工具 | 退出码 | 语义 |
|---|---|---|
| `provision.mjs` | `0` | 校验/投放成功（含幂等跳过） |
| | `2` | 硬失败：锁缺失/非法、版本不存在、非 ELF、门禁不过、SHA 不符、缺 `libc++_shared.so`、缺 `--out`、下载全败、**未捕获异常**（经 `main().catch` → `fail()`） |
| `ohos-selfsign.mjs` | `0` / `1` / `2` / `3` | 正常 / `verify`/`selftest` 失败 / 用法错误 / 异常 |
| `elf-inspect.py` | `0` / `2` | 解析成功（⚠️ **含 VERDICT FAIL**）/ 非 ELF 或 32 位 |

**输出文本契约（稳定格式，便于 grep 与 CI 断言）**

- `--list` 每行：`<node>  <abi>  <size> B  <sha256[0:16]>…  <source.repo>[ ← active]`（`:68`）
- 门禁块（七行，前缀 `OK`/`FAIL`，缩进 4 空格）：
  ```
    门禁：
      OK   ① e_type == ET_DYN(3)  (实测 3)
      FAIL ② PT_INTERP 计数 == 0  (实测 1)
      …
    附加：.codesign=<bool> .note.ohos.ident=<bool> expose-internals=<bool>
  ```
  ①–⑤ 带「实测值」，⑥ 无实测值，⑦ 带锁定版本串（`reportGates` `:177-195`）。
- 失败一律：空行 + `✗ <消息>`（stderr）；成功结尾：`✓ 投放完成：<dir>`（`：337`）。

**注（来源优先级的实际语义）** ⚠️：`--from` 一旦给出就**覆盖**本地目录（`:234-237`），而规划 §G.3 的表格把「本地目录」列在 `--from` 之前。两者都可自圆其说（表格描述的是「默认路径的优先顺序」，代码实现的是「显式参数优先」），但文档应按实现写清，否则评审会当成行为缺陷。

### 5.2 消费：外部输入

| 输入 | 形式 | 用途 / 约束 | 落点 |
|---|---|---|---|
| 上游 release URL | `source.url`（`https://github.com/electerm/ohos-node-shared/releases/download/ohos-node-shared-v24.2.0/libnode-arm64.so`） | `--download` 的最后一档；`fetch` + `redirect:'follow'`；非 2xx ⇒ 抛错并尝试下一个来源 | `:216-226,239` |
| 本地运行时缓存 | `localStore.path`（`../ohos-node-runtime`），或 **`OHOS_NODE_RUNTIME_DIR`** 覆盖 | 三个候选布局依次探测；命中即不联网 | `:73-82` |
| ohos-sdk 路径 | `--sdk` > `OHOS_SDK_NATIVE/../../..` > `DEVECO_SDK_HOME/default/openharmony` > 两个硬编码本机路径 | 取其 `libcxx.sdkRelPath`；**本机实测 `DEVECO_SDK_HOME` 命中** | `:198-212` |
| 代理开关 | `HTTPS_PROXY`/`HTTP_PROXY`（大小写均认）+ **`NODE_USE_ENV_PROXY=1`** | 内置 `fetch` 默认**不读**代理变量；只检测到代理未开开关时打印可粘贴命令 | `:247-256` |
| 校验和自证 | `<缓存>/SHA256SUMS`（`sha256sum -c`） | 缓存目录自证工具，不属门禁 | 缓存 `README.md` |

### 5.3 ELF 解析协议（自解析，不依赖任何外部工具）

| 类别 | 读取内容 | 用途 |
|---|---|---|
| `e_ident` | 魔数（LE u32 == `0x464c457f`）· `[4]==2`（64 位）· `[5]==1`（小端） | 前置拒绝：`not an ELF` / `not 64-bit little-endian`（`provision.mjs:88-89`） |
| ELF 头 | `e_type@16` · `e_machine@18` · `e_phoff@32(u64)` · `e_shoff@40(u64)` · `e_phentsize@54` · `e_phnum@56` · `e_shentsize@58` · `e_shnum@60` · `e_shstrndx@62` | 门禁①③ + 后续所有遍历的基址 |
| Program headers | `p_type@0`（`PT_LOAD=1` / `PT_DYNAMIC=2` / `PT_INTERP=3`）· `p_offset@8` · `p_vaddr@16` · `p_filesz@32` | 门禁②；用 `PT_LOAD` 把 `DT_STRTAB` 的 VA 映射回文件偏移；取 `.dynamic` 段 |
| `.dynamic` | 每条 16 B：`d_tag` / `d_val`；用到 `DT_NEEDED=1` · `DT_STRTAB=5` · `DT_NULL=0` | 门禁④（`needed` 列表）；`elf-inspect.py` 额外解析 `DT_SONAME=14` |
| Section headers | `sh_name@0` · `sh_offset@24` · `sh_size@32` · `sh_link@40` · `sh_entsize@56`；段名经 `e_shstrndx` 指向的 `.shstrtab` 解析 | 找 `.dynsym` / `.codesign` / `.note.ohos.ident`；判附加信息 |
| `.dynsym` | 每条 24 B：`st_name@0` · `st_shndx@6`；**`st_shndx != 0` 视为已定义**；名字经 `sh_link` 指向的字符串表解析 | 门禁⑤（`_ZN4node5StartEiPPc`） |
| 逐字节扫描 | `buf.includes("_ZN4node5StartEiPPc")` · `includes("<node 版本串>")` · `includes("expose-internals")` | 门禁⑦ 的版本串；附加信息（**粗判**，非符号解析） |

**不支持 / 不处理**（写在这里免得被当成 bug）：32 位 ELF（拒绝并退出 2）· 大端 · `e_shnum == 0` 的扩展段计数（`SHN_XINDEX`）· `PN_XNUM` 扩展 phnum · 多个 `.dynsym`（`provision.mjs:165` 取第一个后 `break`）· 符号可见性（`st_other` / visibility 不参与判定，只看 `st_shndx`）。`elf-inspect.py` 比 JS 版多一层防御：段表条目越界即跳过并计数（`skipped`，`:62-64,153`），JS 版没有这层（见 D-5）。

---

## 6. 实现策略

### 6.1 架构模式

**单一投放脚本 + 锁文件驱动**：`provision.mjs` 是唯一入口（幂等状态机：解析锁 → 选条目 → 探源 → 校验 → 投放 → 可选签名），`elf-inspect.py` 是它的**独立只读镜像**（排障/CI，不同语言、同口径），`ohos-selfsign.mjs` 是被 `spawnSync` 调用的**被动子工具**（也可独立使用）。没有配置文件、没有插件点、没有环境状态机；所有可变事实都在锁文件里。

### 6.2 关键算法

**(a) 候选目录布局探测顺序**（`provision.mjs:78-82`）

```
<store>/node-<entry.node>/<entry.file>     ← 约定布局（缓存 README/附录 G.2）
<store>/<entry.node>/<entry.file>          ← 省略 node- 前缀
<store>/<entry.file>                       ← 平铺
```
命中即用；三者都不在且没有 `--from` ⇒ 只有显式 `--download` 才联网，否则打印三条出路。

**(b) 七项门禁的检查顺序（先便宜后昂贵）**

```
读 e_ident（8 B）→ 读 ELF 头（64 B）→ 遍历 phdr（11 条）→ 解析 .dynamic/DT_NEEDED
→ 解析段表 + .dynsym（24 B × N 条）→ 逐字节 includes（120.9 MiB，最贵）
```
全部完成后**一次性**打印七行结论（不让使用者「修一个跑一次」）；失败判定优先级：`shaOk` 先于 `gatesOk`（`:278-281`），因此**篡改产物**报的是「与 lock 不符」，而不是模棱两可的「门禁不过」。

**(c) 自签：Merkle 根 + fs-verity descriptor 布局**（`ohos-selfsign.mjs:92-146`）

```
页大小 PAGE = 4096；段大小 CS_SIZE = 4096
叶层：npages = ceil(fileSize/4096)，每页哈希；落在 [floor(csOff/4096), ceil((csOff+CS_SIZE)/4096)) 的页 → 32 字节全零
上层：把子层 32 B 哈希按 4096 B 打包、补零、逐块哈希，直到打包长度 ≤ 4096 → 根 = sha256(最后一页)
descriptor(256 B)：[0]=1 version · [1]=1 SHA-256 · [2]=12 log2BlockSize · [3]=0 saltSize
                   u32@4 signSize · u64@8 dataSize · rootHash@16(32 B)
                   u32@112 flags=0x10(FLAG_SELF_SIGN) · u64@120 merkleTreeOffset=0 · [255]=3 csVersion
签名摘要 = sha256(descriptor 的 signSize 字段置 0 的副本)
负载 = head(8 B：type=1, length=288) + descriptor(256 B) + 摘要(32 B) = 296 B → 写入 .codesign 段起始
```
✅ 本机实测（锁定产物）：`rootHash = 354deb36f246ebcb5155168588c4bc17bb70d2e265374993ced65b34b79fb400`，两次独立运行**可复现**；`verify` 十项 `OK`；`selftest` = `IDENTICAL`。

**(d) `add-section` 的自实现（追加页对齐段 + 重建段表 + 扩 shstrtab，原字节不动）**（`ohos-selfsign.mjs:213-261`）

实测数值（锁定产物，126,809,264 B → 126,818,360 B，+9,096 B）：

| 步骤 | 计算 | 实测 |
|---|---|---|
| 原布局 | `.shstrtab` 在 126,807,232（235 B）；段表 126,807,472（28 × 64 B）恰好在 EOF 结束 | `e_shoff=126807472, e_shnum=28` |
| 新 `.codesign` 数据 | `ceil(126809264/4096)*4096 = 126,812,160`（**页对齐**，中间 2,896 B 由 `Buffer.alloc` 补零） | `.codesign @ 126812160` ✅ |
| 新 `.shstrtab` | `csOff + 4096 = 126,816,256`；内容 = 原 235 B + `".codesign\0"`（11 B）= **246 B**；名字索引 = `235` | — |
| 新段表 | `ceil((126816256+246)/8)*8 = 126,816,504`；条目 = 原 28 条（`.shstrtab` 条目改指新位置）+ 新 `.codesign` 条目（`PROGBITS`/`sh_flags=0`/`sh_addr=0`/`sh_addralign=4096`/`sh_entsize=0`/`link=info=0`） | `e_shoff=126816504, e_shnum=29`；`elf-inspect.py` → `parsed=29 skipped=0` ✅ |
| 结果 | 总长 `126816504 + 29*64 = 126,818,360` | 文件 126,818,360 B ✅ |

关键点：**原字节一字不动**（Merkle 树覆盖全文件，追加字节自然纳入）；`.codesign` 的 `sh_flags=0` ⇒ **不参与装载**（只被签名校验读）；`llvm-objcopy --add-section` 做不到页对齐，故必须自实现（§D.5）。

### 6.3 错误处理（失败面清单）

| # | 场景 | 文本（要点） | 退出码 | 状态 |
|---|---|---|---|---|
| ① | 找不到锁文件 | `✗ 找不到 <abs path>` | 2 | ✅ 代码路径 `:52` |
| ② | **版本项口径缺口** ⚠️ | **无任何比较**：门禁⑦ 只查「大小 + 版本串存在」；锁里 `versionGeq2219` 无人读 | （不失败） | ⚠️ D-3 |
| ③ | 锁里没有该 `node/abi` | `✗ lock 里没有 node=… abi=…；可用：…` | 2 | ✅ 实测（`--node v99.0.0`） |
| ④ | 不是可用 ELF | `✗ 不是可用的 ELF：not an ELF / not 64-bit little-endian` | 2 | ✅ 代码路径 `:272` |
| ⑤ | 任一门禁不过 | `✗ ELF 门禁未全过 —— 该产物不能用于进程内嵌入（详见工程规划 §5.8）` | 2 | ✅ 实测（合成 PIE、合成缺 `libc++`） |
| ⑥ | SHA-256 与锁不符 | `✗ 产物与 lock 不符（SHA-256 不一致）。要么换成正确的产物，要么**明确**更新 runtime.lock.json。` | 2 | ✅ 实测（篡改 1 字节） |
| ⑦ | 缺 `--out` | `✗ 缺少 --out <模块>/entry/libs/<abi>（或用 --check 只校验）` | 2 | ✅ 代码路径 `:286` |
| ⑧ | 找不到 `libc++_shared.so` | `✗ 找不到 … 用 --sdk … （缺它 dlopen 会**静默失败**，症状是 ArkTS 侧只拿到 undefined）` | 2 | ✅ 代码路径 `:301-304` |
| ⑨ | 下载来源全失败 | `✗ 全部下载来源均失败：- <url> → <msg>` **+ 代理提示**（未开 `NODE_USE_ENV_PROXY` 时打印可粘贴命令） | 2 | ⚠️ 文本未在本机触发（无代理变量，路径 `:247-256`）⬜ |
| ⑩ | 本地找不到产物 | 三条出路：a) 手工放入（给出**首选路径**）b) `--from <path\|url>` c) `--download`（附上游 URL） | 2 | ✅ 代码路径 `:258-266`（文本口径见 D-4：`--from` 实际不吃 URL） |
| ⑪ | `elf-inspect.py` 判 `VERDICT: FAIL` | 打印 `FAIL -> …`，但 **`exit 0`** ⚠️ | 0 | ⚠️ D-10（CI 假绿风险） |
| ⑫ | 产物长度 < 头部声明（截断/畸形） | **原始堆栈**：`RangeError [ERR_OUT_OF_RANGE] … at u64 (provision.mjs:90)` | 2 | ⚠️ D-5 实测 |
| ⑬ | `--from` 指向不存在的路径 / 目录 / URL | **原始堆栈**（`ENOENT … stat '…'` / `EISDIR`），没有友好提示 | 2 | ⚠️ D-4 实测 |
| ⑭ | `--sign` 子步骤失败 | `✗ add-section 失败` / `✗ 自签失败` / `✗ 自签后验签失败` | 2 | ✅ 代码路径 `:326,331,334` |
| ⑮ | 对**已签名**目标重复投放 | 打印「+ 投放」并把签名版**覆盖**回未签名版（幂等判据是 `目标 sha == 源 sha`） | 0 | ⚠️ D-6 实测 |

### 6.4 性能与资源（本机实测基线：Windows / NTFS / Node v24.7.0）

| 操作 | 实测 | 说明 |
|---|---|---|
| `--check`（读 120.9 MiB + SHA-256 + 七项门禁） | **0.69 s** | 读全量 `readFileSync` 后哈希；单次即可，无需流式 |
| 首次投放（校验 + 拷 2 文件） | **0.68 s** | 拷贝 120.9 MiB 占比很小（页缓存命中） |
| 幂等重投（目标 sha 读回 + 比较） | **0.86 s** | 比首投略慢：多算一次 120.9 MiB 的目标 SHA-256 |
| `--sign` 全链（投放 + add-section + sign + verify） | **3.2 s** | 每步各写一份 ~127 MB 文件 |
| 下载（`--download`） | ⬜ 未能复现「8 s」 | 本机**无代理变量**、直连 90 s 未完成（`timeout` 杀掉，`exit 124`）；§G.3 的 8 s 是**带代理**条件下的实测 |

**资源与注意**：
- 内存峰值 ≈ 源文件 + 目标文件读取 + 自签副本，**300–400 MB 级**（全部用 `readFileSync`/`Buffer`，没有流式）；下载同样整块 `arrayBuffer` 缓冲（**峰值 ≥120 MB**，且**部分下载不留盘**——先缓冲后一次 `writeFileSync`）。
- 临时文件清理挂在 `process.on('exit')`（`:36-38`）：**SIGINT/SIGTERM 不覆盖** ⚠️（D-11）。实测被 `timeout`（SIGTERM）杀掉时**无残留**，因为下载未完成即未落盘；自签路径若被强杀则可能留下 `%TEMP%\libnode-sign-<pid>\`。
- 幂等语义的边界：✅ 常规投放幂等；⚠️ `--sign` **不是**幂等的（签名改变字节 ⇒ 下一次投放会把它覆盖回未签名），见 D-6。

---

## 7. 测试考虑

| 层 | 内容 | 现状 |
|---|---|---|
| **CI 门禁（首选）** | `node tools/provision.mjs --check` ⇒ `0/2`；不改盘、不联网（缓存存在时） | ✅ 已实现，`tests/README.md:7` 登记为「可直接进 CI」 |
| **篡改测试** | 复制产物改 1 字节 ⇒ 门禁⑥ `FAIL` + `exit 2`；本轮已实测（`82303d42…`）；建议固化为脚本（⬜ `smoke-host.mjs` 未落地） | ✅ 可复现 |
| **幂等测试** | 连续投放两次：第二次必须打印两个「已是最新 → 跳过拷贝」，且两个文件的 mtime/sha 不变 | ✅ 本轮实测 |
| **`--force` 测试** | 在幂等状态下加 `--force` ⇒ 必须重新拷贝 | ✅ 本轮实测 |
| **来源回退测试** | `OHOS_NODE_RUNTIME_DIR=<空目录>` + `--from <本地件>` ⇒ 走显式来源；`--download` 的回退链要用**两个**可达 URL（待镜像建立后）才能真正覆盖 | ⬜ 部分（镜像未建） |
| **`elf-inspect.py` 三产物期望输出** | ① **选定产物 → PASS**：`PT_INTERP 0` / `DT_NEEDED libc++_shared.so, libc.so` / `node::Start raw=True exported_dynsym=True` / `.codesign False` / `.note.ohos.ident True` / `sections 28` / `VERDICT: PASS`（✅ 本轮实测）② **PIE 产物 → FAIL**：`VERDICT: FAIL -> PT_INTERP present (PIE!)`（✅ 本轮用「把 `PT_GNU_RELRO` 条目改写成 `PT_INTERP`」的合成样本复现；真实 PIE 产物 🔶 附录 D）③ **自签产物 → PASS**：`.codesign True` / `sections 29` / `parsed=29 skipped=0` / `VERDICT: PASS`（✅ 本轮实测） | ✅ 三例齐备 |
| **自签断言** | `selftest <signed>` 必须输出 `IDENTICAL`（清零后重签逐字节一致）；`verify` 十项全 `OK` | ✅ 本轮在锁定产物上实测 |
| **边界** | 无网络（默认路径不触发网络 ✅）；代理未开（文本 + 提示，⬜ 未在本机触发）；锁文件非法 JSON（⬜ 未构造样本，代码路径 `:54-55`）；锁里没有该版本（✅ 实测）；`libs/<abi>` 不存在（✅ 实测自动创建）；`--from` 异常路径（⚠️ 堆栈，见 D-4/D-5） | 🔶 部分 |
| **不覆盖（明确留给别处）** | 真机 `dlopen`/`node::Start` 行为、`/facts` 12+ 项、`--jitless` 与 ACL 的关系 ⇒ 探针工程与 `006-observability`；本模块只负责「形态与锁值」 | §D.8/§D.9 · C6 |

---

## 8. 文件清单（真实行数 / 体积）

| 文件 | 行数 | 体积 | 现状 | 作用 |
|---|---|---|---|---|
| `tools/provision.mjs` | **341** | 15,621 B | ✅ | 唯一投放实现：CLI + 七项门禁 + SHA/大小 + 幂等 + 三级来源 + 自签编排 |
| `tools/elf-inspect.py` | **169** | 6,883 B | ✅ | 零依赖只读检查器（排障/CI），与 JS 版同口径 |
| `tools/ohos-selfsign.mjs` | **291** | 12,711 B | ✅ | `add-section` / `sign` / `verify` / `selftest`（纯 SHA-256，无私钥） |
| `runtime.lock.json` | **64** | 2,876 B | ✅ | 唯一事实源（入库） |
| `tests/README.md` | **28** | 1,108 B | ✅ | 三层测试现状 + 快速自检命令 |
| `library/.ohpmignore` | 17 | — | ✅ | `:11` 排除 `**/libnode.so`（S10 兜底） |
| `specs/README.md` | 25 | — | ✅ | 模块编号表（`:21` 记 `005-provision-verify` ⚠️） |
| `../ohos-node-runtime/README.md` | — | 4,507 B | ✅（**不入 git**） | 缓存目录约定 + 重新填充步骤 |
| `../ohos-node-runtime/SHA256SUMS` | 1 | 96 B | ✅ | `sha256sum -c` 可自证 |
| `../ohos-node-runtime/node-v24.2.0/libnode-arm64.so` | — | 126,809,264 B | ✅ | 待投放的原始产物（**未签名**） |
| `../ohos-node-runtime/node-v24.2.0/PROVENANCE.md` | 111 | 5,540 B | ✅ | 该版本溯源 + 门禁 + 真机验证（⚠️ 见 D-13） |
| `tools/build-bridge.mjs` · `tools/smoke-host.mjs` · `tools/rt-build/` | — | — | ⬜ | 规划 §7.2/§7.4 列出的路径，**当前不存在**（见 D-2） |

---

## 9. 附录 G 三条演进路线：当前状态与触发条件

| 路线 | 内容 | 当前状态 | 触发条件 / 启动后要做的事 |
|---|---|---|---|
| **A. 现状（本地目录 + 锁文件）** | 本机/内网跑 `provision.mjs` 投放，**离线可用** | ✅ **生效中**（本机 `../ohos-node-runtime/` 已就位，`--check` 全过） | 无（默认路线） |
| **B. 公开镜像 Release** | 新建 `fellow99/ohos-node-runtime` 的 Release，资产**逐字节复制**上游 + 附 `SHA256SUMS` | ⬜ **未启动**：`mirror.kind = null`；`openItems[0]` 登记 | 触发：**第三方（ohpm 使用者）需要自己拿产物**。动作：① 建 Release（只做可访问镜像，**不重编译**）；② 回填 `lock.runtimes[].mirror`；③ 删 `openItems[0]`；④ 回归 `--download` 的回退链（当前只有一档，D-7） |
| **C. 自建配方** | 走附录 D 配方（`--openssl-no-asm --shared`、条件 `--v8-disable-temporal-support`、V8 `maglev-assembler.h` release 补丁 + `-DNDEBUG`、版本补丁 `0001/0002` + `-Wno-error=implicit-function-declaration`、`CC/CXX` 带 `-fno-emulated-tls`，随后 `llvm-strip` → 自签） | ⬜ **未启动**：`tools/rt-build/` 不存在；配方只在规划附录 D 归档；`openItems[1]` 登记 | 触发：**需要非 v24.2.0 版本 / 供应链必须自控**。动作：① vendor 配方进 `tools/rt-build/`；② 产物先过七项门禁 + 真机探针（`verifiedOn` 写回）；③ 进 `runtimes[]`（R20 由此关闭） |
| （附）**x86_64** | 模拟器用 ABI | ⬜ **决策不做**（只用真机调试）；`openItems[2]` | 触发：真的需要在模拟器上跑（需重走「候选产物评估 + 门禁 + 真机/模拟器验证」） |
| （附）**`tools/build-bridge.mjs` / `tools/smoke-host.mjs`** | 规划 §7.4 步骤②③（host 侧流水线脚本） | ⬜ Phase 1；**现状由 hvigor 的 `externalNativeOptions` 直接编 CMake**（见 D-2） | 触发：Phase 1 要「一条命令走完 host 侧」时；本模块的 `--check` 已经是 `smoke-host.mjs` 的第①层 |
| （附）**协议级缺口** | `--verify-lock`（锁文件自校验）· `elf-inspect.py` 进 CI 的退出码 · 版本下限比较 | ⬜ **不存在** | 见 §10（D-3/D-10）；触发：CI 接门禁或镜像建立时 |

---

## 10. 与规划/文档的不一致 + 真实缺陷清单（评审必读）

> 全部为**本轮实测/逐行读码**得到；每条给「现象 → 证据 → 建议」。严重度：🟥 影响正确性/CI 假绿 · 🟧 行为与文档不符 · 🟨 文档/口径 · 🟩 已登记未落地（非缺陷）。

| # | 严重度 | 现象 | 证据 | 建议 |
|---|---|---|---|---|
| **D-1** | 🟨 | **编号/目录名不一致**：规划 §7.3 与 `specs/README.md:21`、`STRUCTURE.md:214` 都写 `005-provision-verify`；实际目录是 `005-provision-verify-elf-gates` | 三处文档 vs 本目录名 | 统一（本规格只写任务指定的目录，未改其它文件）；同步 `specs/README.md` 编号表与 `STRUCTURE.md §7` |
| **D-2** | 🟨 | **「规划有脚本、实现走 hvigor」**：规划 §7.4 步骤② 写 `node tools/build-bridge.mjs --abi arm64-v8a`（⬜ Phase 1），步骤③ 写 `node tools/smoke-host.mjs`；**两个文件都不存在**，引导件实际由 hvigor 的 `library/build-profile.json5 → externalNativeOptions → cpp/CMakeLists.txt` 直接编出 | `ls tools/` 只有 3 个文件（本模块三件套）；规划 §7.4 自带 ⬜ 标记 | 在 `002-napi-bootstrap` 与 `007-distribution` 规格里写清「Phase 1 才补脚本」；另注意 §7.4 步骤① 的 `--out library/src/main/libs/arm64-v8a` 与实际 CMake 输出 `library/libs/arm64-v8a`（STRUCTURE §8.1）是**两个不同目录**，`--out` 取值需与 002 对齐 |
| **D-3** | 🟧 | **版本项口径不一**（三处）+ **`gates` 无人读**：规划 §5.8/锁文件要求 `process.version ≥ 22.19.0`；门禁⑦ 只查「大小一致 + 版本串存在」；`elf-inspect.py` 六项无版本项；`entry.gates` 在 `tools/` 里零引用 ⇒ 存档可静默漂移 | `provision.mjs:185` · `elf-inspect.py:142-164` · `grep -c gates tools/*` | 二选一：① 实现真比较（解析 `.rodata` 版本串做数值比较，或把 `gates.versionGeq2219` 从锁里删掉/改名成 `versionStringPresent`）；② 把规划 §5.8 的措辞降级为「版本串存在 + 由真机 `/facts` 验证引擎版本」 |
| **D-4** | 🟧 | **`--from <url>` 名义支持、实际按本地路径**：`--from` 的值直接进 `statSync/readFileSync`，`acquire()`（唯一会 `fetch` 的地方）只在 `--download` 分支被调用 ⇒ 传 URL 得到 `ENOENT … stat 'D:\…\https:\127.0.0.1:1\x.so'` 的**原始堆栈** | `provision.mjs:15`（注释写 `<path\|url>`）· `:234-237` vs `:215-226`；实测 | 要么实现（`--from` 命中 `http(s)://` 时走 `acquire`），要么把注释与 §G.3 表格里的 `--from <path｜url>`、错误提示 ⑩ 的 `<path\|url>` 全部改成 `<path>` |
| **D-5** | 🟥 | **畸形/截断 ELF 抛原始堆栈**：`elfGate` 不做长度边界校验，头部声明的偏移超出实际长度即 `RangeError [ERR_OUT_OF_RANGE]`（≈90 行堆栈）。同类：`--from` 指向目录（`EISDIR`） | 实测：`head -c 1,000,000` 的产物 ⇒ 堆栈，`exit 2`（退出码语义仍成立，但信息不是友好文本） | 在 `elfGate` 开头加 `phoff+phnum*phentsize <= buf.length` 与 `shoff+shnum*shentsize <= buf.length` 校验，失败归入「不是可用的 ELF」；`statSync` 后判 `isFile()` |
| **D-6** | 🟥 | **`--sign` 与重复投放不兼容（签名会被静默覆盖）**：幂等判据是「目标 sha == 源 sha」，而签名必然改变 sha ⇒ 下一次不带 `--sign` 的投放会把**已签名版覆盖回未签名版**（打印的是「+ 投放」，不是错误） | 实测：把签名版放进 `libs/`，再跑一次 `--out` ⇒ sha 回到 `3019bf5f…`（签名版为 `f3c3e070…`） | ① 在 `--sign` 的产物旁留标记（如 `libnode.so.signed.json` 记录签名 sha）并让幂等判定认识「已签名状态」；或 ② 至少在该场景打印**警告**；③ PROVENANCE §5（`:78-79`）已警示「`--check` 只认未签名原件」，应把这条提到 `--sign` 的 README/帮助文本里 |
| **D-7** | 🟩 | **回退链只有一档**：`--download` 的「镜像失败 → 上游」代码在（`:241-245`），但 `mirror.kind=null` ⇒ `entry.mirror?.url` 为 `undefined`，实际只试 `source.url` | `provision.mjs:239` · 锁文件 `:30-33` | 建镜像后回归（§9 路线 B）；在那之前，spec 的 AS-6 只能算**设计判据** |
| **D-8** | 🟧 | **本地目录存在但内容不对时不回退联网**：`--download` 只在「本地候选**不存在**」时才联网；若本地文件被篡改/换错，行为是**硬失败**（SHA 不符）而不是去下载 | `:236-238` | 属**有意的安全取向**（不要拿网络去掩盖本地既有文件），但要在 §G.3 写清「`--download` ≠ 自动修复」 |
| **D-9** | 🟧 | **`--check` 不验 `libc++_shared.so` 可得性**：`findLibcxx()` 只在投放路径调用 ⇒ CI 的 `--check` 全绿仍可能在投放时因缺 SDK 而 `exit 2` | `:282`（提前 return）vs `:300-304` | 给 `--check` 加一个「`libc++_shared.so` 可定位性」探测（不算哈希），或在文档里明确 `--check` 的范围是「产物 + 锁」 |
| **D-10** | 🟥 | **`elf-inspect.py` 的 FAIL 仍返回 0**，且其「六项」名不副实：verdict 只判 4 项（`e_type`/`e_machine`/`PT_INTERP`/`node::Start`）；`DT_NEEDED` 缺 `libc++`、`.codesign` 缺失、SHA-256 都**只打印不判** | `elf-inspect.py:4-10`（docstring 六项）vs `:155-165`（verdict 四项 + `return 0`） | 如果要把它当 CI 门禁：FAIL ⇒ `return 1`，并把 docstring 改成「4 项判定 + 3 项打印」；否则在 `tests/README.md` 里注明「仅供人工排障，退出码无判据」 |
| **D-11** | 🟨 | **清理只挂 `process.on('exit')`**：SIGINT/SIGTERM 不触发 ⇒ 强杀可能留下 `%TEMP%\libnode-sign-<pid>\`（~254 MB）。实测被 SIGTERM 杀掉时**无残留**，因为下载是「先缓冲后一次落盘」 | `provision.mjs:34-38` | 加 `process.on('SIGINT'|'SIGTERM')` 走同一清理函数；或把工作目录改成「进程退出即删」的 `fs.mkdtemp` 语义 |
| **D-12** | 🟨 | **一批锁字段无任何工具读取**（只写文档，易漂移）：`schema` · `soname` · `nodeModuleVersion` · `embeds` · `flags` · `signed` · `verifiedOn/Device/Notes` · `openItems` · `libcxx.from/abi` · `localStore.layout` · **`gates.*`（七项全部）** | `grep -c` 结果：这些键在 `tools/*` 里 0 命中（`soname` 仅在 `elf-inspect.py` 被打印） | 明确它们是「审计/人读字段」并在本规格登记（已做）；若要防漂移，加一个 `--verify-lock` 子命令（用 `soname`/`nodeModuleVersion`/`gates` 交叉核对产物）——**当前不存在** |
| **D-13** | 🟨 | **缓存目录 `PROVENANCE.md §3` 的数字是「加段后」的状态**：它写 `SHT 数量 29（e_shoff=126812160）`，而原始资产是 `e_shoff=126807472`、`e_shnum=28`（`126812160` 恰好是 `.codesign` 的页对齐落点）；`DT_NEEDED` 写成 `lib.so`（实际是 `libc.so`） | `PROVENANCE.md:45-47` vs 本轮 `elf-inspect.py` 原始产物输出 | 修 PROVENANCE（把「加段后」与「原件」两组数字分开写）——注意它不在本仓库内（父工程缓存目录） |
| **D-14** | 🟩 | **`needsLibc`（`libc.so`）计算后未使用**（`provision.mjs:133`）：只有一个布尔被算出来却从不参与门禁/输出 | 逐行读码 | 删掉，或纳入附加信息打印（`reportGates` 的 `附加：` 行） |
| **D-15** | 🟨 | **上游产物只有 v24.2.0 一个版本**（R20）且来源是**无法复现的黑盒二进制**（R8）：这是**被接受的**风险，不是缺陷；但它意味着「换版本」目前无路可走 | 锁文件 `runtimes[]` 长度 1 · §9.3 第 2 项 | 保持登记；需要新版本时启动 §9 路线 C |
