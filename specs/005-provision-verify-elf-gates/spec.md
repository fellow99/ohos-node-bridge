# 005-provision-verify-elf-gates — 模块规格（spec.md）

> **模块**：运行时获取与校验 · ELF 门禁与投放（host 侧工具链）
> **性质**：技术无关的「要什么」规格（验收判据 + 非目标）；「怎么做」见同目录 `plan.md`。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10 / G3–G5 / G11）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」：
> §5.8 · 附录 G 全文 · 附录 D（D.4–D.6 / D.9）· §7.4 · §9.3 · §4.1 第 10/14 项 · 风险 R2/R8/R20/R21/R22）· 本仓库实测。
> **标记**：✅实测（本仓库可复核，附 `path:line` 或本机命令输出）/ 🔶沿用（外部一手记录，本工程未复现）/ ⬜待验证 / ⚠️冲突或风险。
> **版本**：v1.0 · 2026-10-16 · 状态：**实现已落地**（`tools/provision.mjs` / `tools/elf-inspect.py` / `tools/ohos-selfsign.mjs` / `runtime.lock.json`）；
> 未落地项（镜像 Release / 自建配方 / `build-bridge.mjs` / `smoke-host.mjs` / x86_64）逐条标 ⬜ 并写明触发条件（plan §9）。
> **编号口径** ⚠️：规划 §7.3 与 `specs/README.md` 记作 `005-provision-verify`；本目录名 `005-provision-verify-elf-gates` 为展开写法，两者指同一模块（plan §10 列待同步项）。

---

## 1. 模块概述

### 1.1 目的与要解决的问题

| # | 问题（现状痛点） | 本模块的回答 |
|---|---|---|
| P1 | 网上现成的 `libnode.so` 大多是 **PIE 可执行文件**（`PT_INTERP != 0`），`dlopen` 成功但 V8 首次堆分配即崩，症状极易误判 | 把「ELF 形态」做成**机器可判的门禁**，不过即拒绝，不做「先跑跑看」（规划 §4.1 第 10 项 · R2） |
| P2 | 运行时是**无法复现的黑盒二进制**，来源、许可、校验值、验过没有散落在聊天与笔记里 | 把「该用哪个产物 / 校验值是多少 / 验过没有」固化成**可 diff 的事实源**（`runtime.lock.json`，S10 · R8） |
| P3 | 120.9 MiB 的二进制不能进 git（GitHub 单文件 **100 MiB 硬限**），但又**没有制品库** | 「锁进 git、二进制不入库」两层解耦 + 单一投放工具；本机缓存可随时按锁文件重建（附录 G.1/G.2 · G.5） |
| P4 | 取产物、校验、投放、补签名各写一套脚本 ⇒ 各消费方行为漂移 | 只有一份实现（`tools/provision.mjs`），**幂等**、**每步都验**、失败即硬失败（§G.4） |

### 1.2 范围

- **含**：运行时的**获取**（本地缓存 / 显式来源 / 联网回退）、**校验**（七项 ELF 门禁 + SHA-256 + 大小）、**投放**（写入 `<out>/libnode.so` + 一并从 ohos-sdk 取 `libc++_shared.so`）、**可选的离线自签**（`--sign`，仅服务脱离 HAP 的独立分发）、以及承载上述行为的**锁文件字段契约与写作规则**。
- **不含**：
  - **产物本身的构建**（自建 `libnode.so`：配方归档在规划附录 D，`tools/rt-build/` ⬜ 未落地，属 §G.6 路线 C）；
  - **制品库 / 镜像运营**（`mirror.kind = null`，§G.6 路线 B ⬜）；
  - **真机行为判据**（由消费方探针与 `006-observability` 的 `/facts` 负责；本模块只给 host 侧门禁，见 C6）；
  - **HAP / HAR 的打包**（hvigor 负责；本模块的产物落点只到 `libs/<abi>/`）。

### 1.3 一句话验收口径

`node tools/provision.mjs --check` 在**不改动任何文件**的前提下对锁定的产物给出七项全过；
`--out <模块>/libs/arm64-v8a` 幂等投出**恰好两个文件**；任一判据不满足 ⇒ **`exit 2` + 明确文本**，绝不静默降级（§G.4 · C2）。

---

## 2. 用户故事

| # | 角色 | 想要 | 以便 |
|---|---|---|---|
| US-1 | **库维护者** | 换运行时版本时「只改锁文件里的一行 + 重跑校验」，而不是翻聊天记录找哈希 | 升级可审计、可回滚（C7「换一行即可替换运行时」· §G.7） |
| US-2 | **消费方构建流水线作者** | 在 CI 里一条命令拿到「校验过、形态正确」的运行时（含 `libc++_shared.so`），重复跑不产生副作用 | 构建可重复、不被人肉步骤卡住（§G.8 / 规划 §7.4 步骤 ①） |
| US-3 | **审计者 / 合规** | 只看 git 就能回答：这个二进制从哪来、许可是什么、SHA-256 多少、在哪台设备上跑通过 | 上架材料与 G4 第三方清单可生成（§9.3 第 2 项 · G4 · R8） |
| US-4 | **排障者** | 出问题时能用**零依赖**的只读检查器核对任意 `.so` 的 ELF 事实（不装 llvm、不装 pip 包） | 快速区分「产物问题」与「平台/库问题」（规划 §7.4 步骤 ③） |
| US-5 | **独立分发场景的维护者** | 脱离 HAP 分发时能给 `.so` 补签名并**自己验签**，不依赖 SDK 里的 Java 工具与私钥 | 离线自足（§D.4 / §D.5 · G5） |

---

## 3. 功能需求

> 编号 `FR-005-XXX` 连续。**现状**列：✅ 已实现（附实测依据）/ ⚠️ 已实现但口径或行为与文档有出入 / ⬜ 未落地。

### 3.1 事实源与门禁

| 编号 | 需求 | 判据 / 落点 | 现状 |
|---|---|---|---|
| **FR-005-001** | **唯一事实源**：运行时版本、大小、SHA-256、SONAME、来源、许可、门禁结果、真机验证记录**只有一个**权威出处，且**进 git** | `runtime.lock.json`（64 行，S10）；`provision.mjs` 只从它读期望值（`provision.mjs:32,54-63,273-274`） | ✅ `--list` 单行可读 |
| **FR-005-002** | **门禁总则**：七项 ELF 门禁中**任一项不满足即硬失败**（`exit 2`），没有「警告后继续」档位 | `provision.mjs:177-195,281`；失败文本引规划 §5.8 | ✅ 实测（篡改/合成样本见 §5） |
| **FR-005-003** | 门禁①：产物必须是**共享库形态**（`e_type == ET_DYN`） | `provision.mjs:179` | ✅ 实测 3 |
| **FR-005-004** | 门禁②：**`PT_INTERP` 计数必须为 0**（PIE 直接拒） | `provision.mjs:180`；理由见 plan §3.2 | ✅ 实测 0（合成 PIE ⇒ FAIL） |
| **FR-005-005** | 门禁③：`e_machine == AArch64` | `provision.mjs:181` | ✅ 实测 0xB7 |
| **FR-005-006** | 门禁④：`DT_NEEDED` 必须**含 `libc++_shared.so`**（缺它 `dlopen` 静默失败） | `provision.mjs:182` | ✅ 实测（合成改名 ⇒ FAIL） |
| **FR-005-007** | 门禁⑤：`_ZN4node5StartEiPPc`（`node::Start`）必须在 `.dynsym` 中**已定义且导出**（`st_shndx != 0`） | `provision.mjs:150-166,183` | ✅ 实测 true |
| **FR-005-008** | 门禁⑥：**SHA-256 必须与锁文件逐字节一致** | `provision.mjs:184,273,278-280` | ✅ 实测（改 1 字节 ⇒ FAIL + `exit 2`） |
| **FR-005-009** | 门禁⑦：**大小与锁文件一致**，**且**产物内含锁定的版本串 | `provision.mjs:185,168` | ✅ 实测（`v24.2.0`） |
| **FR-005-010** | 门禁顺序**先便宜后昂贵**、报告**一次给全表**（不让使用者「修一个跑一次」） | `provision.mjs:86-171`（读头 → phdr → dyn → 段表）· `reportGates` 七行一次打印 | ✅ 实测输出格式见 plan §5.1 |
| **FR-005-011** | **版本矩阵**：运行时须满足消费方引擎下限 `process.version >= 22.19.0` | 规划 §5.8「版本要求」；锁文件 `gates.versionGeq2219` | ⚠️ **口径不一**：门禁⑦ 只查「大小 + 版本串存在」，**没有任何 `>=22.19.0` 的比较**；`elf-inspect.py` 六项里**没有版本项**；锁文件 `gates` 对象**没有任何工具读取**（写入即文档）。见 plan §3.5 / §6.3-② 与 §10 待办 |

### 3.2 获取、回退与幂等

| 编号 | 需求 | 判据 / 落点 | 现状 |
|---|---|---|---|
| **FR-005-012** | **来源优先级**：本地运行时目录（默认 `<父工程>/ohos-node-runtime`，`OHOS_NODE_RUNTIME_DIR` 可覆盖）→ `--from` → （显式 `--download` 时）镜像 → 上游 | `provision.mjs:73-82,234-257`；§G.3 | ✅ 实测（默认走本地目录）；⚠️ `--from` **实际优先于本地目录**（显式来源覆盖默认），与 §G.3 表格「1 本地 → 2 `--from`」的读法不同，见 plan §5.1 注 |
| **FR-005-013** | **联网回退链**：`--download` 时依次尝试 `mirror.url` → `source.url`，**任一失败自动下一个**，全失败才报错 | `provision.mjs:238-256` | ⚠️ 代码在，但 `mirror.kind=null`（`openItems[0]`）⇒ 回退链**当前只有一档**（只试上游），无法被触发验证 ⬜ |
| **FR-005-014** | **离线优先**：本地目录有产物即不联网；找不到时给出**三条明确出路**（手工放置 / `--from` / `--download`），不猜、不降级 | `provision.mjs:258-266` | ✅ 实测（错误文本含三条出路与上游 URL） |
| **FR-005-015** | **代理真相**：检测到代理环境变量但未开 `NODE_USE_ENV_PROXY` 时，**打印可直接粘贴的正确命令**，而不是含糊的 `fetch failed` | `provision.mjs:247-256` | ✅ 实测（本机无代理变量，路径未触发；文本见 plan §6.3-⑨ ⬜ 待有代理环境复现） |
| **FR-005-016** | **幂等投放**：目标 `libnode.so` 的 SHA-256 已等于锁值 ⇒ **跳过拷贝**；`libc++_shared.so` 同理 | `provision.mjs:292-297,307-312`；§G.4 | ✅ 实测（二次投放打印「已是最新 → 跳过拷贝」，两文件均跳过） |
| **FR-005-017** | **强制重投**：`--force` 忽略幂等跳过，重拷两个文件 | `provision.mjs:292,307` | ✅ 实测 |
| **FR-005-018** | **`libc++_shared.so` 一并投放**：从本机 ohos-sdk 取（`native/llvm/lib/aarch64-linux-ohos/libc++_shared.so`），**不固化哈希**（随 SDK 版本变化） | `provision.mjs:198-212,299-312`；锁文件 `libcxx` | ✅ 实测（1,262,504 B 落地）；缺 SDK 时硬失败并说明「缺它 dlopen 会静默失败」 |
| **FR-005-019** | **只校验不投放**：`--check` 在任何写入之前返回 0/2，可直接进 CI | `provision.mjs:282` | ✅ 实测（0.69 s，无文件写入） |
| **FR-005-020** | **可列举**：`--list` 打印锁定的全部运行时可选项与当前 `active` 标记 | `provision.mjs:65-71` | ✅ 实测（单行格式见 plan §5.1） |
| **FR-005-021** | **版本/ABI 选择**：`--node` / `--abi` 默认取锁文件 `active`；锁里没有的组合 ⇒ **硬失败并列出可用组合** | `provision.mjs:57-63` | ✅ 实测（`--node v99.0.0` ⇒ `exit 2` + 可用清单） |
| **FR-005-022** | **SDK 定位**：`--sdk <path>` 优先，其次 `OHOS_SDK_NATIVE` / `DEVECO_SDK_HOME`，再退到两个本机约定路径；命中即为 `libc++_shared.so` 来源 | `provision.mjs:198-212` | ✅ 实测（`DEVECO_SDK_HOME` 命中） |

### 3.3 副作用面、自签与供应链

| 编号 | 需求 | 判据 / 落点 | 现状 |
|---|---|---|---|
| **FR-005-023** | **副作用面限制**：常规投放**只写** `<out>/libnode.so` 与 `<out>/libc++_shared.so` 两个文件；`<out>` 不存在则创建 | `provision.mjs:288-312` | ✅ 实测（`libs/arm64-v8a/` 恰好 2 个文件） |
| **FR-005-024** | **中间产物不外泄**：下载 / 补段 / 自签的中转文件**一律落系统临时目录**（`libs/<abi>/` 里多一个文件就会被**打进 HAP**），并在进程退出时清理 | `provision.mjs:34-38,217-223,316-320`；§G.4 | ✅ 实测（含 `--sign` 的全链路结束后 `libs/` 仍只有 2 文件；临时目录无残留）；⚠️ 清理挂在 `process.on('exit')`，**未被 SIGINT/SIGTERM 覆盖**（见 plan §6.4 注） |
| **FR-005-025** | **硬失败语义**：SHA 不符、任一门禁不过、找不到 `libc++_shared.so`、锁里没有该版本、缺 `--out` ⇒ **`exit 2`**；**绝不「就地找另一个产物凑合」** | `provision.mjs:49,86-282` | ✅ 实测（4 类失败样本，plan §6.3） |
| **FR-005-026** | **自签仅服务独立分发**：`--sign` 补 `.codesign` + 自签 + **当场验签**；**HAP 内原生库不需要 `.codesign`**（真机已实测关闭 R22） | `provision.mjs:315-335`；`tools/ohos-selfsign.mjs`；§D.5/§D.6/§D.9 · G5 | ✅ 实测（端到端 3.2 s，`VERIFY: PASS` 十项） |
| **FR-005-027** | **自签离线自足**：纯 SHA-256 Merkle + fs-verity descriptor，**无私钥、无证书、不依赖 SDK 的 `binary-sign-tool`**；缺 `.codesign` 段时由本工具自实现 `add-section`（页对齐 4096 B、重建段表、**原字节一字不动**） | `ohos-selfsign.mjs:92-146,213-261`；§D.4/§D.5 | ✅ 实测（`.codesign @ 126812160` 页对齐；`selftest: IDENTICAL`） |
| **FR-005-028** | **Verifier 必须是内容校验**：`verify` 不只查「有没有 `.codesign`」，而要校验 Merkle 根与签名摘要 | `ohos-selfsign.mjs:161-188`（十项） | ✅ 实测（R21 的处置：口径不一 ⇒ 校验内容） |
| **FR-005-029** | **零依赖只读检查器**：`tools/elf-inspect.py` 用纯 Python 自解析 ELF，回答「形态能不能 `dlopen`」并打印 SHA-256 / SONAME / 段表解析完整度 | `elf-inspect.py`（仅 `hashlib`/`struct`/`sys`） | ✅ 实现为**四项判定 + 打印项**，docstring 已改为「4 项判定 + 3 项打印 + 退出码 0/2」；`VERDICT: FAIL` 现返回 **2**（A2/R2，2026-10-17） |
| **FR-005-030** | **供应链记录**：每个运行时条目必须带来源（仓库 / tag / 资产 / URL）、许可、构建方式、以及「验过没有」（`verifiedOn` / `verifiedDevice` / `verifiedNotes`） | 锁文件 `runtimes[].source` / `verified*`（C7 供应链纪律 · §5.8 表「供应链纪律」） | ✅ 已写入（2026-10-16 / HAD-W24 / 含 SIGTRAP 前置说明） |

---

## 4. 关键实体

| 实体 | 说明 | 关键属性（字段级契约见 plan §4） | 现状 |
|---|---|---|---|
| **锁文件** `runtime.lock.json` | 「该用哪个二进制」的唯一事实源，进 git | `schema` / `active{node,abi}` / `runtimes[]` / `libcxx` / `localStore` / `openItems[]` | ✅ 64 行，活动条目 v24.2.0 |
| **运行时条目** `runtimes[i]` | 一个可投放的产物及其全部事实 | 身份：`node` / `nodeModuleVersion` / `abi` / `file` / `deployAs`；证据：`size` / `sha256` / `soname`；能力：`needsLibcxx` / `embeds` / `flags` / `signed`；出处：`source` / `mirror`；结论：`gates` / `verifiedOn` / `verifiedDevice` / `verifiedNotes` | ✅ 1 条 |
| **门禁结果** `gates` | 七项判定的**存档**（写给人和审计看；工具不比对，见 FR-005-011 ⚠️） | `typeDyn` / `ptInterp` / `machineAArch64` / `neededLibcxx` / `exportsNodeStart` / `sha256Match` / `versionGeq2219` | ✅ 七项全 true/0 |
| **供给来源** `source` / `mirror` | 从哪来（上游 release 资产 / 镜像），以及镜像是否已建立 | `kind` / `repo` / `tag` / `asset` / `url` / `license[]` / `builtWith`；`mirror.kind` 当前为 `null` | ⚠️ 无镜像（`openItems[0]`） |
| **本地缓存** `<父工程>/ohos-node-runtime/` | 不入库的二进制落地目录；`README.md` + `SHA256SUMS` + `node-<版本>/<上游原名>.so` + `PROVENANCE.md` | `localStore{path,envOverride,layout}`；可用 `sha256sum -c SHA256SUMS` 自证 | ✅ 已就位（126,809,264 B） |
| **签名段** `.codesign` | 独立分发所需的签名载体：页对齐 4096 B 段，内填 296 B（`ElfSignInfo(8B)+descriptor(256B)+SHA256(descriptor)(32B)`） | 页对齐 / `flags=0x10`（`FLAG_SELF_SIGN`）/ `csVersion=3` / 无私钥 | ✅ 可生成（**上游原件无此段**） |
| **投放目录** `<模块>/libs/<abi>/` | 投放终点，也是 HAP 的原生库落点 | 只应有 `libnode.so`（投放名由 `deployAs` 决定）+ `libc++_shared.so`；HAR 侧由 `library/.ohpmignore:11` 排除 `**/libnode.so` | ✅ 实测 2 文件 |

---

## 5. 验收场景

> 「证据」列 ✅实测 = 本机 2026-10-16/17 实跑（Windows / Git-Bash / Node v24.7.0 / NVMe）；⬜ = 本轮未复现。
> 合成样本说明：本机**没有**真实的 PIE / 缺 `libc++` 产物（附录 D 里的 PIE 产物未随仓库分发），故 ⑤⑥ 两条用**等长/同长字节改写**的真实锁定产物构造，只改被测字段。

| # | Given / When / Then | 证据 |
|---|---|---|
| AS-1 | **本地目录投放成功**：G=本地缓存有锁定产物；W=`provision.mjs --out <dir>`；T=`exit 0`，`libs/<abi>/` 恰好 `libnode.so` + `libc++_shared.so`，且 `libnode.so` 的 SHA-256 = 锁值 | ✅ 实测（全链 0.68 s；两文件 126,809,264 B / 1,262,504 B） |
| AS-2 | **篡改 1 字节硬失败**：G=把产物中间 1 字节改掉；W=`--check --from <篡改件>`；T=门禁表 ⑥ 显示 `FAIL`，`exit 2`，错误文本要求「换成正确产物或**明确**更新锁文件」 | ✅ 实测（实测 SHA `82303d42…`，`exit 2`） |
| AS-3 | **已是最新则跳过**：G=目标文件 SHA-256 已等于锁值；W=再次投放；T=打印「已是最新 → 跳过拷贝」，`exit 0`，不重写文件 | ✅ 实测（两文件均跳过） |
| AS-4 | **`--force` 强制重投**：G=目标已是最新；W=`--force`；T=重新拷贝并打印投放行，`exit 0` | ✅ 实测 |
| AS-5 | **本地缺失时用 `--from`**：G=`OHOS_NODE_RUNTIME_DIR` 指向空目录；W=`--from <本地文件路径>`；T=校验全过并投放 | ✅ 实测（本机全部篡改/合成样本均走此路径） |
| AS-6 | **`--download` 镜像失败自动回退上游**：G=`--download` 且 `mirror.url` 与 `source.url` 均存在；W=镜像失败；T=自动尝试上游，全失败才报错并给出代理提示 | ⬜ 未触发：`mirror.kind=null` ⇒ 当前回退链只有一档（FR-005-013 ⚠️）。本机实测：本地缓存为空 + 直连无代理时，90 s 内未完成（`timeout` 杀掉，`exit 124`）——§G.3 的「8 s（带代理）」**未能复现** ⬜ |
| AS-7 | **PIE 产物被拒**：G=产物含 `PT_INTERP`（PIE）；W=投放；T=门禁② `FAIL (实测 1)`，`exit 2`，不投放 | ✅ 实测（合成 PIE；`elf-inspect.py` 同步给 `VERDICT: FAIL -> PT_INTERP present (PIE!)`）· 🔶 真实 PIE 产物（`hqzing/ohos-node` v22.19.0）的 `PT_INTERP=1` 见附录 D |
| AS-8 | **缺 `libc++_shared.so` 的 `DT_NEEDED` 被拒**：G=把 `DT_NEEDED` 里的 `libc++_shared.so` 改名；W=投放；T=门禁④ `FAIL (实测 libc++xshared.so,libc.so)`，`exit 2` | ✅ 实测（合成样本） |
| AS-9 | **`--sign` 端到端验签**：G=投放目录就绪；W=`--sign`；T=`add-section` → `sign` → `verify` 全过（十项 `OK` + `VERIFY: PASS`），且 `libs/` 仍只有 2 个文件 | ✅ 实测（3.2 s；`.codesign @ 126812160` 页对齐；Merkle 根 `354deb36…`，两次运行可复现；`verify` 再次独立执行仍 PASS） |
| AS-10 | **自签可复现**：G=已签产物；W=`ohos-selfsign.mjs selftest <signed>`；T=`IDENTICAL`（清零重签 = 原文件逐字节一致），`exit 0` | ✅ 实测（在**锁定的 120.9 MiB 真实产物**上成立，强于附录 D 在 35 KB `wxjit.so` 上的结论） |
| AS-11 | **中间产物不出现在 `libs/<abi>/`**：G=走含 `--sign` 的完整流程；W=列目录；T=只有 `libnode.so` 与 `libc++_shared.so`；中转文件在系统临时目录且退出后消失 | ✅ 实测（自签中间件落 `%TEMP%\libnode-sign-<pid>\`，流程结束无残留） |
| AS-12 | **锁文件非法 / 缺版本**：G=锁文件 JSON 语法错误，或锁里没有 `--node/--abi` 组合；W=任意投放命令；T=`exit 2` + 明确文本（列出可用组合） | ✅ 缺版本实测（`--node v99.0.0` ⇒ `exit 2` + `可用：v24.2.0/arm64-v8a`）；⬜ 非法 JSON 未实测（只读路径 `provision.mjs:54-55`，不改锁文件即无法构样本） |
| AS-13 | **`libs/<abi>` 不存在**：G=目标深层目录不存在；W=投放；T=自动创建并投放成功 | ✅ 实测（`mkdirSync(recursive)`，scratch 下多层目录一次成功） |
| AS-14 | **只校验不写盘**：G=CI；W=`--check`；T=`exit 0`，仓库与目标目录**无任何文件变化** | ✅ 实测（`--check` 全程只读；耗时 0.69 s） |

---

## 6. 非功能要求

| # | 要求 | 判据 | 现状 |
|---|---|---|---|
| NFR-1 | **幂等** | 相同输入重复执行不改变最终状态、不重复写盘（FR-005-016）；`--sign` 例外：签名改变文件内容，见 plan §6.4 ⚠️ | ✅ |
| NFR-2 | **可进 CI** | `--check` 0/2 语义；不交互、不写盘、无网络（本地缓存存在时） | ✅ |
| NFR-3 | **零额外依赖** | host 侧只用 Node 内置模块（`crypto`/`fs`/`path`/`child_process`/`url`/`os`）+ 纯 Python 3 标准库；不装 llvm、不装 pip 包、不装 Java | ✅（plan §1.2） |
| NFR-4 | **体积与网络可控** | 默认离线；联网是显式 `--download`；中转文件退出即清；下载全量缓冲在内存（峰值 ≥120 MB，见 plan §6.4） | ⚠️ 网络实测受限 |
| NFR-5 | **退出码语义** | `0` = 校验/投放成功；`2` = 硬失败（含未捕获异常）；`elf-inspect.py`：`0` = VERDICT PASS、`2` = VERDICT FAIL/非 ELF/32 位（A2/R2）；自签工具另用 `1`（验签失败）/`2`（用法）/`3`（异常） | ✅ 实测 |
| NFR-6 | **文本契约稳定** | 门禁表七行固定格式、`--list` 单行格式（plan §5.1）；`--quiet` 只静默**进度**，**不静默失败**（失败仍走 stderr） | ✅ 实测（`--quiet` 下失败文本仍输出） |
| NFR-7 | **性能量级**（本机实测基线） | `--check` 0.69 s；首投 0.68 s；幂等重投 0.86 s；含 `--sign` 全链 3.2 s | ✅ |
| NFR-8 | **不隐藏平台真相**（C2） | 缺产物时给三条出路；缺 `libc++_shared.so` 时说明「`dlopen` 会静默失败」；代理未开时打印正确命令；`--from <url>` 与 `--download` 走同一 fetch 路径并给出代理提示；`elf-inspect.py` 的 FAIL 已返回 2（A2/R2） | ✅ |

---

## 7. 假设与约束

| # | 假设 / 约束 | 依据 |
|---|---|---|
| A1 | **GitHub 单文件 100 MiB 硬限** ⇒ 120.9 MiB 的 `libnode.so` **不可能入库**；LFS 会把 clone 变成必须联网的重操作；二进制进 git 还会留下永久历史 | 附录 G.1/G.5 · S10 |
| A2 | **本工程与消费方都没有可用制品库** ⇒ 镜像 Release 只能「按需新建」 | 附录 G 开篇 · §G.5 · `openItems[0]` |
| A3 | **`libc++_shared.so` 随 ohos-sdk 版本变化** ⇒ 锁文件只固化**来源规则**（`libcxx.sdkRelPath`），不固化哈希 | §G.7 · PROVENANCE §5 第 3 段 |
| A4 | **自建延后**：现阶段接受「无法复现的黑盒二进制」，用 SHA-256 + 许可 + 验证记录把风险**显式登记**；Phase 3 再替换 | §5.8「为什么先用现成产物」· R8 · §G.6-C |
| A5 | **x86_64（模拟器）不做**（只用真机调试） | `openItems[2]` |
| A6 | **HAP 内原生库不需要 `.codesign`** ⇒ 默认投放不签名；`--sign` 只服务独立分发 | §D.6/§D.9 · G5 · R22（已关闭） |
| A7 | **联网需 Node ≥ 24 才能用 `NODE_USE_ENV_PROXY`**（内置 `fetch` 默认不读代理变量）；工具在提示文本里已写明 | §G.3 · `provision.mjs:17-18,252-254` |
| A8 | 产物形态是**共享库**（不是可执行文件）；本模块**不**解决「把 ELF 当独立可执行去 `execve`」的场景 | §D.6 括号说明 |
| A9 | 门禁只证明「形态与锁值一致」，**不证明功能可用**；功能判据必须来自真机（host 侧门禁是必要条件，不是充分条件） | C6 · §D.9 |

---

## 8. 依赖

| 方向 | 对象 | 说明 |
|---|---|---|
| 上游（消费） | 上游 release 资产（`electerm/ohos-node-shared` tag `ohos-node-shared-v24.2.0` 的 `libnode-arm64.so`） | 唯一当前来源；SHA-256 锁定（附录 D.4 候选表 · 锁文件 `source`） |
| 上游（消费） | ohos-sdk（`libc++_shared.so` + 交叉工具链） | 通过 `--sdk` / `OHOS_SDK_NATIVE` / `DEVECO_SDK_HOME` 定位（`provision.mjs:198-212`） |
| 上游（消费） | 本地运行时缓存 `<父工程>/ohos-node-runtime/`（**不入 git**，可重建） | 目录约定与重新填充步骤见该目录 `README.md` 与 `node-v24.2.0/PROVENANCE.md` |
| 下游（提供） | **`007-distribution` 的接入文档** | 消费方「怎么拿运行时」的说明由它承载；本模块只提供工具与锁文件（§7.5 / §G.8） |
| 下游（提供） | 消费方 `pi-desktop-ark/scripts/provision-runtime.sh`（本仓库外，✅ 已存在） | 自述「投放**只有一份实现**」并委托 `provision.mjs`；脚本约定 `BRIDGE` / `NODE` / `ABI` 三个环境变量与 `--check` / `--download` 透传 |
| 下游（提供） | `library/.ohpmignore:11`（`**/libnode.so`） | 保证 120 MB 二进制不随 HAR 发布（S10 · §7.5） |
| 下游（提供） | `tests/README.md` 的快速自检入口（`--check` + `elf-inspect.py`） | 三层测试中的前两层（第三层 `smoke-host.mjs` ⬜ Phase 1） |
