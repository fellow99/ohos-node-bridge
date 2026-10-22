# 提交到 OpenHarmony 三方库中心仓（ohpm）—— 差距分析与改动方案

> **本文是什么**：把 `@fellow99/node-bridge` 从「可构建的 HAR」推进到「**能通过中心仓审核并上架**」的差距分析
> 与改动清单。它**只讲发布面**（包形态、元数据、必要文件、审核口径、发布流水线），不重写
> `docs/000-工程规划.md` 的架构结论，也不改 `specs/007-distribution-har-package/spec.md` 的需求编号。
>
> | 项 | 值 |
> |---|---|
> | 文档日期 | 2026-10-22 |
> | 分析对象 | `ohos-node-bridge` 子工程（包名 `@fellow99/node-bridge` / `0.1.0`） |
> | 规则依据 | OpenHarmony 三方库中心仓帮助中心 6 篇官方文档（下文 §2 逐条引原文）+ 本机 `ohpm 6.1.2.285` CLI 实测 |
> | 证据标记 | ✅ **本机实测**（有命令/输出） · 🔶 **沿用官方文档原文** · ⬜ **未落地/待验证** · ⚠️ **风险或冲突** |
>
> **口径纪律**（沿用宪法 §三）：本文所有「现状」列都来自 2026-10-22 本机实跑；凡未实跑的判断一律标 ⬜ 或 ⚠️，
> 不把推断写成事实。

---

## 0. 一句话结论

**两个包都已就绪，只差账号与发布动作。**（2026-10-22 更新）

| 包 | 版本 | 体积 | 本地门禁 | `ohpm prepublish` | 还缺什么 |
|---|---|---|---|---|---|
| `@fellow99/node-bridge` | `0.1.0` | 488 KB | ✅ 31/31（`tools/verify-har.mjs`） | ✅ succeed | 发布凭据 |
| **`@fellow99/node-runtime`** | **`24.2.0`**（= Node 版本） | 41 MB | ✅ 34/34 | ✅ succeed | 发布凭据 |

过程中关掉的关键问题（都已实测闭环）：

1. **机械门槛**全部补齐：四件套（`oh-package.json5` / `README.md` / `CHANGELOG.md` / `LICENSE`）、README 安装命令、
   `author` 对象 + `email`/`url`、`repository`、`sourceType`、release 构建（`metadata.debug=false`）。
2. **「第三方怎么拿到 `libnode.so`」这条链补上了**：运行时独立成包 `@fellow99/node-runtime`（内含 121 MB 的引擎），
   `ohpm install` 即得；主包 HAR 里再带 `runtime.lock.json` + 许可清单（rawfile）作为事实源。
3. **方案 B 的链路真机验证过**：HAR 里的 `.so` → HAP（SHA 不变）→ `dlopen` 命中 `<bundleCodeDir>/libs/arm64/libnode.so` → `/facts` 200。
4. **还剩的只有「人判」与「账号」**：`@fellow99` 组织/发布码/私钥、首发节奏（`-rc` 试水）、审核说明材料（§6）。

> 本文保留完整的规则基线（§2）、实测证据（§3）、差距与处置（§4）、决策记录（§5）、审核材料（§6）、
> 文件清单（§7）与流水线（§8）；凡状态已变化的条目，正文里都以 ✅/⬜ 直接标注，不做历史抹除。

---

## 1. 结论速览

### 1.1 三句话

1. **机械门槛**（中心仓自动判的）—— 已全部补齐（§4 P0-1～P0-4、P0-6）：四件套、README 安装命令、元数据、release 构建口径。
2. **功能性门槛**（第三方能不能真跑起来）—— 已解决（§4 P0-5 / §5）：运行时由独立包 `@fellow99/node-runtime` 提供，
   装两个包 → `assembleHap` 即有引擎 → 真机 `/facts` 200。
3. **审核门槛**（人判的）—— 仍是唯一不可控项：包内含「JS 引擎 + `dlopen` 动态加载 + 需要受限 ACL 开 JIT」，
   大概率被问询，材料已列在 §6。

### 1.2 分档清单（详见 §4）

| 档 | 含义 | 条目 | 现状 |
|---|---|---|---|
| **P0 阻断**（不补齐必被拒/装上不可用） | 6 项：`CHANGELOG.md` · `LICENSE` · README（含 `ohpm install`） · `oh-package.json5` 元数据 · 运行时线索随包 · release 构建 + 发布前门禁 | — | ✅ **6/6 已落地** |
| **P1 影响体验/审核**（能上架但会被问、或被吐槽） | 5 项：`libc++_shared.so` 随包冲突 · `module.json` 内嵌本仓库样例 app 段 · 版本矩阵未落地 · 第三方文档不足 · 无 API 参考 | — | ⬜ 仅 `libc++_shared.so` 待择一（§10 第 5 项），其余随 1.0 处理 |
| **P2 优化**（长期） | 4 项：发布脚本与 CI · `samples/` 独立可构建 · 兼容矩阵机读文件 · issue/贡献指南 | — | 🔶 发布脚本已做（§7 第 10–11 项），其余待办 |

---

## 2. 中心仓规则基线（官方原文 → 本工程映射）

> 来源：`https://ohpm.openharmony.cn/#/cn/help/{introduction,quickstart,publishrequirefile,guidename,createandpublish,publishrules}`。
> 本站帮助页正文由前端异步加载，本文取的是页面实际引用的 Markdown 原文（菜单接口 `ohpmweb/dist/api/help/ohpmMenu`
> → markdown URL），逐条摘录见附录 B。
> ⚠️ 用户列表里第 7 个链接（华为开发者文档《ohpm 命令行工具》）**页面为纯前端渲染，本机未取到正文**；
> 该页内容与中心仓帮助文档重叠，本文凡涉及 CLI 行为的结论一律以**本机 `ohpm --help` / `ohpm publish --help` 实测**为准（附录 A）。

### 2.1 包名与组织

| 规则（🔶 原文） | 本工程 | 结论 |
|---|---|---|
| 格式 `@group/packagename`，1–128 字符，全局唯一（去掉 `-` `_` `.` 后相同也算重名） | `@fellow99/node-bridge` | ✅ 合法 |
| `group`：小写字母开头，仅 `[a-z0-9-_]`，不以下划线/中划线结尾，最长 36 | `fellow99`（8 字符） | ✅ 合法 |
| `packagename`：小写字母开头，仅 `[a-z0-9._-]`，不以上述符号结尾 | `node-bridge` | ✅ 合法 |
| **带组织包：发包人必须属于该组织**，否则无权发布到该命名空间 | `@fellow99` 组织是否已注册、维护者账号是否入组 | ⬜ **待人工确认**（工程规划 §9.3 第 1 项，一直未关闭） |
| 建议名称「独特、有描述性、不用他人商标」 | `node-bridge` 描述性够，但**通用词**；`@fellow99/ohos-node-bridge` 更独特（可读性略降） | 🔶 可选调整，改名成本 = 首次发布前定死（之后不能改） |

> **决策点**：包名一旦发布不可改。`@fellow99/node-bridge` 与 `@fellow99/ohos-node-bridge` 二选一要在**首发前**定。

### 2.2 版本号

| 规则（🔶） | 本工程 | 结论 |
|---|---|---|
| SemVer，`主.次.修订`，不允许 `v` 前缀，5–128 字符 | `0.1.0` | ✅ |
| 每段 ≤ 2147483647；不能用日期戳当修订号 | — | ✅ |
| 版本不可与已发布版本重复；一次只发一个版本 | — | ⚠️ **试发会消耗版本号**：首发若被审核拒，修完要用**新版本号**重发（不能覆盖） |

### 2.3 必要文件（四件套）—— 当前实测状态

原文（🔶 `publishrequirefile`）：「如需发布一个 har 包，**必须包含 oh-package.json5、README.md，CHANGELOG.md 和 LICENSE 四个文件**，
若文件缺失，会导致上架至中心仓失败。注：闭源 har 包可以不包含 LICENSE 文件。」
结构规则（🔶 `publishrules` §六）另加：**README 必须包含 `ohpm install <包名>` 或 `ohpm i <包名>`**、
**CHANGELOG 必须包含当前版本号**、`oh-package.json5` 必须在 `package/` 下、**LICENSE 支持 `license`/`license.md`/`license.txt`**。

| 文件 | 官方要求 | **修复前基线**（2026-10-22 首轮实测 release HAR） | 当时结论 → **现状** |
|---|---|---|---|
| `package/README.md` | 必须、非空、**含 `ohpm install`**、支持中英变体 | ⚠️ 存在（3,152 B）但 **`grep "ohpm i"` 0 命中** | P0 → ✅ 已补（4,875 B，含安装命令） |
| `package/CHANGELOG.md` | 必须、非空、**含当前版本号** | ❌ 仓库与 HAR 内**都没有** | P0 → ✅ 已补（1,942 B，含 `0.1.0`） |
| `package/LICENSE` | 开源包**必须** | ❌ 仓库根有 MIT，但 `library/` 内没有 ⇒ **HAR 内无** | P0 → ✅ 已补（1,086 B） |

> 上表是**修复前**的基线，保留用于回溯；当前两个包的四件套均已齐全（§0 / §3.2 / §3.2′）。

> ✅ **已验证打包边界**（本次实验，见附录 A.4）：把 `LICENSE`、`CHANGELOG.md` 放进 `library/` 根目录 → **会**进 HAR；
> 而 `library/THIRD-PARTY-NOTICES.md`、`library/docs/runtime.lock.json` 这类**任意文件名/子目录不会**被打包。
> 即 hvigor 对 HAR 根只认 `README.md` / `CHANGELOG.md` / `LICENSE` 这类约定文件。

### 2.4 README / CHANGELOG 的展示与更新规则

| 规则（🔶） | 对本工程的含义 |
|---|---|
| 中文环境优先显示中文版 → 无则默认版；英文同理。变体：`readme.md` / `readme-cn.md` / `readme-zh.md` / `readme-en.md`（大小写不敏感） | ⚠️ 当前只有 `README.md`（中文正文），英文用户看到中文。建议 `readme.md`（英文或中英混排）+ `readme-zh.md`（中文） |
| README 单文件 ≤ 10 MB；详情页只展示 md，**不影响 HAR 内的 readme** | 现状 3 KB ✅ |
| README/CHANGELOG 有**单独更新入口**（可只传 md 或 md+图片的 zip），需审核；同一包同一版本同时只允许一个审核中申请 | ✅ 首发后改文档不必重发 HAR，这条能显著降低运营成本 |
| CHANGELOG 展示在「更新日志」页 | 必须按版本追加条目，且**含版本号字符串**（服务端会校验） |

### 2.5 `oh-package.json5` 字段逐项比对（打包后实测原文）

打包后 hvigor **改写**了 `oh-package.json5`（源文件里的 `main: "Index.ets"` 消失，自动补 `types`/`artifactType`/`metadata`/`nativeComponents`）。
以下是 **HAR 内实际内容**（release 构建，✅ 实测）：

```json
{"name":"@fellow99/node-bridge","version":"0.1.0",
 "description":"在应用进程内嵌入真正的 Node.js 运行时（NAPI 引导 + dlopen + node::Start），供 ArkTS/ArkWeb 应用调用",
 "author":"fellow99","license":"MIT","keywords":["nodejs","harmonyos","ohos","napi","runtime"],
 "dependencies":{},"types":"Index.d.ets","artifactType":"obfuscation",
 "metadata":{"byteCodeHar":true,"sourceRoots":["./src/main"],"debug":false,"dependencyPkgVersion":{},
             "declarationEntry":[],"nativeDebugSymbol":true,"useNormalizedOHMUrl":true},
 "compatibleSdkVersion":17,"compatibleSdkType":"HarmonyOS","obfuscated":false,
 "nativeComponents":[{"name":"libnode_bridge.so",...},{"name":"libnode_host_client.so",...}]}
```

| 字段 | 规则（🔶 `publishrules` §四） | 打包后实测 | 判定 |
|---|---|---|---|
| `name` / `version` | 必填、格式见 §2.1/§2.2 | `@fellow99/node-bridge` / `0.1.0` | ✅ |
| `description` | **必填**，6–512 字符 | 75 字符 | ✅ |
| `author` | **必填对象**：`name` + `email`/`url` **至少一个** | `"fellow99"`（**字符串**，且无 email/url） | ⚠️ **P0**：本机 ohpm 的 `fixAuthorField` 会把字符串自动转成 `{name:"fellow99"}`（源码实测），但**补不出 email/url**；服务端是否拦未验证 ⇒ 直接改成对象最省事 |
| `main` | **必填**，「入口文件路径，文件必须存在于包内」 | **缺失**（只有 `types:"Index.d.ets"`） | ⚠️ **不确定项**：`prepublish` 用 `types` 就放过了（✅ 实测报错文案是「`main` or `types` field declare file … does not exist」，说明本地两者其一即可）；但规则文字写「`main` 必填」。**首发必须实测**，失败则回填 `main: "Index.d.ets"` 或接受 hvigor 产物 |
| `types` | 条件必填（混淆/字节码包），须 `.d.ts`/`.d.ets` | `Index.d.ets` | ✅ |
| `license` | 开源包必填 | `MIT` | ✅（但**必须有 LICENSE 文件**） |
| `repository` | **开源包必填**，URL，≤1024 | **缺失** | **P0** |
| `sourceType` | 可选，默认 `open` | 未写（默认 open） | 🔶 建议显式写 `"open"`，避免审核口径歧义 |
| `nativeComponents` | 可选；包内 `libs/*.so` 未声明会**告警**；声明了不存在的 .so 会告警 | 声明 2 项（`libnode_bridge.so`、`libnode_host_client.so`），但包内还有 **`libc++_shared.so` 未声明** | ⚠️ 见 §4 P1-1 / P1-2 |
| `artifactType` / `obfuscated` | `original`/`obfuscation`/`bytecode`；`obfuscated` 影响发布告警 | `obfuscation` + `obfuscated:false` | ⚠️ 触发 prepublish 的「含源码」告警（成因见 §3.4，**与包内真实文件无关**） |
| `metadata.debug` | 仅闭源包检查；开源包不拦 | release ⇒ `false`；**debug 构建 ⇒ `true`** | ⚠️ **发布必须用 release 构建**（P0-6） |
| `compatibleSdkVersion/Type` | 建议填写，长度 1–64 | `17` / `HarmonyOS`（hvigor 写成**数字**） | 🔶 本地校验对数字不报错（源码实测），保持现状 |
| `dependencies` | 不能依赖自身 | `{}` | ✅ 离线可构建（NFR-6） |

### 2.6 包结构与体积

| 规则（🔶） | 本工程实测 | 结论 |
|---|---|---|
| 包内必须有 `package/` 目录 | ✅ HAR 为 gzip tar，顶层即 `package/` | ✅ |
| `.so` **必须**放在 `package/libs/` 下 | ✅ `package/libs/arm64-v8a/*.so`（3 个） | ✅ |
| 禁止 `.exe` | 无 | ✅ |
| 压缩包 ≤ 500 MB、解压 ≤ 1500 MB、文件数 ≤ 102,400 | 主包 **495,595 B / 18 个文件**；运行时包 **42,964,889 B / 9 个文件** | ✅ 余量极大（运行时包 ≈41 MB 压缩 / ≈121 MB 解压） |
| `oh-package.json5` 必须能被 JSON5 解析 | hvigor 产出**压缩成单行 JSON** | ✅ |
| md 资源 zip 仅允许 md/jpg/png/jpeg/gif/svg/webp/bmp | 不涉及 | — |

### 2.7 发布流程与权限（🔶 `createandpublish` + 本机 CLI 实测）

```bash
# ① 前置（人工、一次性）
#   - 中心仓注册帐号 + 实名/企业认证（certifymanage）
#   - 创建/加入组织 @fellow99（orgmanage）
#   - 个人中心复制「发布码」⇒ ohpm config set publish_id <id>
#   - 配私钥（发布码对应）：ohpm config set key_path <私钥路径>
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm

# ② 本地自检（✅ 本机可用）
ohpm prepublish <har>          # 预校验包内容
ohpm publish <har> -t latest   # 发布；成功后生成「上架审核单」

# ③ 审核：中心仓【个人中心】-【消息】/【Package】跟踪；通过后自动上架
```

| 要点 | 说明 |
|---|---|
| `ohpm publish` 只接受 **har / tgz 文件**（`Usage: ohpm publish [options] <har_or_tgz_file>`，✅ 本机 CLI 实测） | 必须 `assembleHar` 出包后发布，**不能**对源码目录发 |
| 常用参数（✅ 实测 `--help`） | `--publish_registry <r>`、`--publish_id <id>`、`--key_path <p>`、`-t/--tag <tag>`、`--source_type <string>`、`--strict_ssl <boolean>`、`--compatibility_log_level <level>`、`--disallow_nested_package`、`--ensure_dependency_include` |
| 全量下架后有 **24 小时冷却** | 首发失败/回滚都要算时间窗口 |
| 闭源包（`sourceType: closed`）需 `metadata.debug` 为 `false`，且可不带 LICENSE | 本库开源，**不适用** |

### 2.8 重要：`prepublish` 只覆盖「本地能判的那部分」

✅ **实测结论**：**那份缺 `CHANGELOG.md`、缺 `LICENSE`、README 里没有 `ohpm install` 的 HAR，`ohpm prepublish` 依然 `succeed`。**
对照本机 ohpm 源码（`lib/core/publish/`）可确认本地校验只做：包路径、包大小（>500 MB）、`author` 修正与长度/格式、
`sourceType` 枚举、`compatibleSdkVersion/obfuscated` 存在性、`nativeComponents` 与包内 `.so` 的对应关系、
以及一条资产泄漏**告警**。**README/CHANGELOG/LICENSE/安装命令这些是服务端校验**（本地代码里没有实现）。

> ⇒ **不能把 `prepublish` 绿灯当上架判据。** 必须自己写一层「发布前门禁」（§8），把服务端规则在本地复刻一遍。

---

## 3. 现状实测证据

### 3.1 两套产物对照（✅ 本机 `hvigorw assembleHar`）

| 项 | debug 构建 | **release 构建（应用这个发布）** |
|---|---|---|
| HAR 大小 | 502,449 B | **495,595 B**（含随包事实源 rawfile；补 `LICENSE`+`CHANGELOG.md` 与 rawfile 前是 486,170 B） |
| 条目数 | 27 | **18 个文件**（+ 若干空目录） |
| `package/ets/sourceMaps.map` | 有（57,999 B） | **无** |
| `metadata.debug` | `true` | **`false`** |
| native 符号 | 保留 | 保留（`nativeDebugSymbol:true`，崩溃取证需要） |
| 构建耗时 | ~31 s | ~22–32 s |

> 结论：**发布必须走 `-p buildMode=release`**；debug 包虽能 `prepublish` 过，但带 `debug:true` 与服务端「闭源包禁 debug」口径擦边，
> 且多带一份 source map（源码泄漏面更大）。

### 3.2 主包 HAR 条目清单（release，✅ 当前产物）

```
package/oh-package.json5                           996 B   ← 打包后由 hvigor 改写（见 §2.5）
package/Index.d.ets                              1,262 B   ← types 入口
package/README.md                                4,875 B   ← 来自 library/README.md（安装 + 三步 + 包内容 + 许可）
package/CHANGELOG.md                             1,942 B   ← ✅ 含 0.1.0
package/LICENSE                                  1,086 B   ← ✅ 本库 MIT 原文
package/ResourceTable.txt                            0 B
package/ets/modules.abc                         44,284 B   ← 字节码（byteCodeHar）
package/libs/arm64-v8a/libnode_bridge.so        42,680 B   ← 引导件（002）
package/libs/arm64-v8a/libnode_host_client.so    7,624 B   ← Node 侧宿主桥入口（003）
package/libs/arm64-v8a/libc++_shared.so      1,262,504 B   ← ⚠️ 来自 ohos-sdk，非本库产物（§10 第 5 项）
package/src/main/module.json                      823 B   ← ⚠️ 内含本仓库样例的 app 段（P1-2）
package/src/main/ets/{bridge,log,runtime,util}/*.d.ets    ← 5 个类型声明文件
package/src/main/resources/rawfile/node_bridge/runtime.lock.json        3,374 B  ← ✅ 随包事实源
package/src/main/resources/rawfile/node_bridge/THIRD-PARTY-NOTICES.md  10,824 B  ← ✅ 许可清单（G4）
```

**主包里刻意没有 `libnode.so`**（门禁会硬性断言这一点），它由运行时包提供：

### 3.2′ 运行时包 HAR 条目清单（release，✅ 当前产物，42.96 MB）

```
package/libs/arm64-v8a/libnode.so           126,809,264 B   ← 核心：Node v24.2.0 引擎（SHA = 3019bf5f…51a1）
package/libs/arm64-v8a/libc++_shared.so        1,262,504 B   ← 运行期依赖（来自 ohos-sdk）
package/LICENSE                                  142,089 B   ← ✅ Node.js 官方 LICENSE 原文
package/README.md                                  3,318 B   ← 用法 + 校验命令 + 限制
package/CHANGELOG.md                               1,429 B   ← ✅ 含 24.2.0
package/oh-package.json5                             819 B
package/Index.d.ets                                1,051 B   ← 版本常量入口（NODE_VERSION / LIB_SHA256…）
package/ets/modules.abc                            1,564 B
package/src/main/module.json                         694 B   ← type: har，零权限
```

> 两个包的 `.so` 都落在 `package/libs/arm64-v8a/`（中心仓硬要求），且**两包都不含 `.exe`、签名材料、源码**。

### 3.3 门禁输出（✅ 两个包都过）

```
# tools/verify-har.mjs（本地门禁，复刻服务端规则）
✓ 34 项全过：@fellow99/node-runtime@24.2.0
✓ 31 项全过：@fellow99/node-bridge@0.1.0

# ohpm prepublish（第二道；注意它不覆盖四件套）
ohpm WARN: The "nativeComponents" field is empty or not exist in oh-package.json5   ← 运行时包（仅 WARN）
prepublish @fellow99/node-runtime 24.2.0 succeed.
ohpm WARN: ... the har file "library.har" contains source code, ...                 ← obfuscated=false 导致（§3.4）
prepublish @fellow99/node-bridge 0.1.0 succeed.

# tools/release.mjs --check-version（版本一致性：包版本 = lock.active = CHANGELOG = Index.ets 常量）
✓ 版本一致性全过（exit 0）
```

### 3.4 那条告警到底是什么意思（✅ 定位到 ohpm 源码）

`tools/ohpm/lib/core/publish/util/checkAndAlarmAssetLeakage.js` 的逻辑极简：

```js
t.obfuscated || (s += `* the har file "${t.harFileName}" contains source code, ...`);
```

即：**告警只由 `obfuscated === false` 触发，与包内究竟有没有源码无关**（文案误导）。
本库 `obfuscated:false` ⇒ 永远告警。消除方式只有两条：① 打开代码混淆（`obfuscated:true`）；② 接受为 WARN（不影响发布）。
> 建议：**接受告警**，但要在《审核说明》里写明「本包为 byteCodeHar（`metadata.byteCodeHar:true`，仅含 `modules.abc` + `.d.ets`），
> 不含 `.ts/.ets` 源码」，避免审核员按文案误解。✅ 实测依据：release 包内 `.d.ets` 之外**没有任何源码文件**。

### 3.5 打不进 HAR 的东西（✅ 本次三组对照实验）

| 放进 `library/` 的路径 | 是否进 HAR | 说明 |
|---|---|---|
| `README.md` / `CHANGELOG.md` / `LICENSE` | ✅ **进** | hvigor 认这三个约定文件 |
| `THIRD-PARTY-NOTICES.md`（任意 .md） | ❌ **不进** | 文件名不在白名单 |
| `docs/runtime.lock.json`（任意子目录） | ❌ 不进 | 子目录整体不收 |
| `src/main/resources/rawfile/node_bridge/{runtime.lock.json,THIRD-PARTY-NOTICES.md}` | ✅ **进**（`package/src/main/resources/rawfile/...`） | **这就是线索随包的可行通道** |

> 这条实验直接决定 §4 P0-5 的落法：**「第三方怎么拿运行时」的线索走 rawfile，文档类走 HAR 根。**

---

## 4. 差距清单

### P0（阻断：不补齐上不了架，或装上不可用）

> ✅ **2026-10-22 更新**：P0-1 / P0-2 / P0-4 已补齐，P0-3 已补「安装 + 三步接入」段（完整第三方重写仍可继续），P0-5 / P0-6 已落地。
> 结果：**两个包都通过 `tools/verify-har.mjs` + `ohpm prepublish`**（运行时包 34/34、主包 31/31）。下方表格保留「当时」的差距记录，供回溯。

| 编号 | 项 | 现状 | 要做的事 | 验收判据 |
|---|---|---|---|---|
| **P0-1** | `library/CHANGELOG.md` | ❌ 不存在 | 新建，首条为 `## 0.1.0 (发布日期)` + 变更列表；此后每次发版追加 | 文件在 `package/CHANGELOG.md`；含当前版本号字符串 |
| **P0-2** | `library/LICENSE` | ❌ 不存在（仓库根有 MIT） | 从仓库根 `LICENSE` 复制进 `library/`（并在 README 声明本库 MIT、运行时用上游许可） | 文件在 `package/LICENSE`，内容 = 根 LICENSE 逐字一致 |
| **P0-3** | `library/README.md` 重写 | ⚠️ 存在但**第三方视角缺失**：无 `ohpm install`、无最小可跑示例、无版本矩阵、无「你会踩到什么」 | 按 `publishrequirefile` 重写：① 首屏给两条命令（`ohpm install @fellow99/node-bridge` + `ohpm install @fellow99/node-runtime@24.2.0`）；② 三步接入（依赖 → 声明 ACL → 自备载荷）带**可复制命令**；③ 已知限制表（每进程一次 / JIT 需 ACL / `cwd=/` / 运行时来自 runtime 包）；④ 版本兼容矩阵；⑤ 许可与第三方清单入口。建议同时出 `readme.md`(英/默认) + `readme-zh.md`(中) | `grep -q "ohpm install @fellow99/node-bridge"` 命中；`README.md` 里的每条命令在干净机器上可复制执行 |
| **P0-4** | `library/oh-package.json5` 元数据 | ⚠️ `author` 为字符串、无 `repository`、无 `sourceType` | `author` 改对象（`name` + `email` 或 `url`）；补 `repository`（GitHub/Gitee 仓库 URL）；显式 `sourceType: "open"`；如服务端要求 `main`，确认是否需在 `library/oh-package.json5` 保留 `main`（hvigor 打包会改写，需实测） | `prepublish` 无新增 ERROR；服务端审核不因元数据驳回 |
| **P0-5** | **运行时获取闭环**（FR-007-005 / AC-007-09） | ❌ 包内既无 `runtime.lock.json` 也无 `payload/`；线索只活在 GitHub 文本里 | **已定（§5 方案 B）**：运行时由独立包 `@fellow99/node-runtime@24.2.0` 提供（内含 `libs/arm64-v8a/libnode.so`）。主包仍需：**①** 把 `runtime.lock.json`、`THIRD-PARTY-NOTICES.md` 放进 `library/src/main/resources/rawfile/node_bridge/`（✅ 已验证能打包；消费方用 `resourceManager.getRawFileContent()` 读）；**②** README 首屏给两条 `ohpm install`；**③** `dlopen` 失败文案同时提「装运行时包」与「手工投放」 | 只有 ohpm 的第三方**不读本仓库源码**也能：装上两个包 → `assembleHap` 后 `libs/arm64/libnode.so` 存在且 SHA = 锁值 → `/facts` 200；或从 rawfile 读到版本 + SHA-256 + 门禁结论后自行投放 |
| **P0-6** | 发布构建口径 + 发布前门禁 | ⚠️ 目前只有「先 assembleHar 再 publish」的口头约定；debug/release 产物混在同一 `build/default` 目录 | ① 明确「**发布用 release**」（`-p buildMode=release`）；② 新增 `tools/verify-har.mjs`：解包 HAR 逐条断言（四件套齐、README 安装命令、CHANGELOG 含版本、`metadata.debug===false`、无 `.exe`、无 `*.p12`/`signing.*`、`libs/*.so` 全被 `nativeComponents` 覆盖、包大小 < 500 MB、`.so` 与 `runtime.lock.json` 预期一致）；③ `ohpm prepublish` 作为第二道；④ **两个包都要过**（运行时包额外断言：`libnode.so` 的 SHA/大小 = lock、version = lock.active） | `node tools/verify-har.mjs <har>` 退出码 0；故意删掉 CHANGELOG 时退出码非 0（自测） |

### P1（能上架，但会被问或被吐槽）

| 编号 | 项 | 现状 / 风险 | 建议 |
|---|---|---|---|
| **P1-1** | `libc++_shared.so` 随 HAR 分发 | ⚠️ 1.2 MB，✅ 实测来自 **ohos-sdk**（`native/llvm/lib/aarch64-linux-ohos/libc++_shared.so`），不是本库产物。宿主 HAP 里通常也有一份（SDK 侧），**同名 .so 双份**会引入版本/符号冲突风险；且让「同一源码在不同 SDK 版本机器上打出的 HAR 内容不同」（不可重现） | 二选一：① **不随包**（`.ohpmignore` 排掉，README 要求消费方 SDK 自带；需实测宿主能否满足 `libc++_shared.so` 依赖）；② 随包但**在 `nativeComponents` 声明 + 文档写明「由库提供，宿主请勿重复投放」**，并在 `runtime.lock.json` 记录 SDK 版本 |
| **P1-2** | `package/src/main/module.json` 的 `app` 段 | ⚠️ 含 `bundleName: org.fellow99.nodebridge.sample`、`versionCode: 100`、`minAPIVersion: 50005017`——**本仓库样例工程的 app 元数据被打进了库包**（hvigor 从 `build-profile.json5` 注入） | ① 发布前确认审核是否介意（大概率只当作噪声）；② 若要干净，把 `library` 拆成「纯库工程」（无 `AppScope`/`app` product）或改 `samples/` 与库的工程边界。⬜ 需实测「独立库工程」产物的 `module.json` 形态 |
| **P1-3** | 版本矩阵未落地（FR-007-008/009） | ⚠️ `runtime.lock.json` 只有 libnode 侧；**没有 bridge 侧版本字段**，包内也没有兼容矩阵文件 | 在 `runtime.lock.json` 增 `bridge: { version, harSha256 }`；新增 `compatibility.json`（bridge × libnode × API × deviceTypes）随 rawfile；README 呈现摘要 |
| **P1-4** | 面向第三方的能力/限制文档不足 | 仓库根 `README.md` 是**工程视角**（本仓库怎么构建）；`library/README.md` 才面向使用者但很短 | 详情页展示的就是 `library/README.md`。建议：库 README 只讲「怎么用 + 你会踩到什么」，工程视角留在根 README；把 `docs/001-能力矩阵.md` 的对外部分摘要进库 README |
| **P1-5** | 缺少 API 参考 | 类型契约已在 `.d.ets`，但无生成式 API 文档 | 用 `Index.ets` barrel + `.d.ets` 生成 API 表进 README（8 个导出符号，成本低） |

### P2（长期）

| 编号 | 项 | 说明 |
|---|---|---|
| P2-1 | 发布脚本与 CI | `tools/release.mjs`：版本一致性检查 → `assembleHar`(release) → `verify-har` → `prepublish` → 打印人工 `publish` 命令；CI 只跑到 `verify-har`（无凭据不发布） |
| P2-2 | `samples/` 独立可构建 | 现在 `samples/minimal-app` 是**本仓库的一个 module**（`build-profile.json5` 里注册），第三方 clone 下来要连库一起构建；理想形态是「像第三方一样只依赖 `.har`」 |
| P2-3 | 兼容矩阵机读化 | `compatibleSdkVersion` 只有 `17`；`deviceTypes` 只有 `2in1/tablet`。矩阵要能被消费方脚本断言，而不是只活在文档表格里 |
| P2-4 | 贡献与 issue 通道 | 幂等性、复现模板、`docs/真机验证记录.md` 公开版（现在没有该文件） |

---

## 5. 决策（已定）：方案 B —— 双包，运行时独立成包

> **决策（2026-10-22，已拍板）**：采用 **B 双包**。运行时包名 **`@fellow99/node-runtime`**，
> **版本号与 Node 版本严格一致**，首发 **`@fellow99/node-runtime@24.2.0`**。
>
> 理由：① 主包保持 0.5 MB 量级，审核面最小；② 「`ohpm install` 一把梭」的体验由**依赖机制**提供，
> 不必把 121 MB 塞进主包；③ 运行时能独立升版本（24.7 / 26.x），**换 Node 不动桥接件**（结构上已成立，见 §1）。
>
> **包名定稿（2026-10-22）**：`@fellow99/node-runtime-ohos` → **`@fellow99/node-runtime`**（去掉冗余的 `-ohos`）。
> 核查：中心仓 detail 接口对 `node-runtime`、`@fellow99/node-runtime` 均返回「未占用」（用 `@ohos/crypto-js`、`@ohos/hypium` 做过对照）。
> ⚠️ 中心仓判重会忽略 `-` `_` `.`，而 `node-runtime` 是通用词 ⇒ **首发前必须定稿**（发布后 `packageName` 会写进包内 `module.json`，不可改）。
>
> **依赖关系定稿（2026-10-22）**：主包 `dependencies` **保持为空**（= 两个包都需显式安装，见 §5.4 ②）。
> 实测过「主包用 `file:` 依赖运行时包」：`ohpm install` **不会**把该传递依赖装进 `oh_modules`（只装了 `node-bridge`）
> ⇒ 相对路径的嵌套依赖不可靠；要切 ① 必须等运行时包上架、改成 registry 版本号，并真机复验「传递依赖的 `.so` 是否进 HAP」。

### 5.1 两个包的定位（先分清，别混）

| 包 | 版本号来源 | 首发版本 | 压缩体积 | 内容 | 依赖关系 |
|---|---|---|---|---|---|
| `@fellow99/node-bridge` | **自身 semver**（破坏性变更自己涨） | `0.1.0` | ≈0.5 MB（✅ 486,170 B） | ArkTS 字节码 + 引导件 `.so` + `.d.ets` + 许可清单 + `runtime.lock.json`（rawfile） | 依赖运行时包（见 §5.4） |
| `@fellow99/node-runtime` | **= Node 版本**（`major.minor.patch`） | **`24.2.0`** | ≈**41 MB**（✅ gzip 实测 41,003,250 B；解压 121 MB） | `libs/arm64-v8a/libnode.so` + 极小 `Index.ets`（版本常量）+ `LICENSE`（Node 原文）+ `CHANGELOG` + `README` + `THIRD-PARTY-NOTICES` | 被主包 / 消费方依赖 |

> ⚠️ **不建议把主包也钉成 `24.2.0`**（若你确实要求两者一致，代价是下面三条，需在 §10 明确接受）：
> ① bridge 的 API 破坏性变更会与 Node 升级**捆绑**；② 「bridge 修 bug 但 Node 没变」**无法表达**（`24.2.0` 已占用且不可重用）；
> ③ 使用者无法分辨 `node-bridge@24.2.0` 是「桥接件版本」还是「Node 版本」。
> **只有运行时包**与 Node 版本一一对应；主包保持自己的 semver。

### 5.2 「版本号 = Node 版本」带来的三条硬约束

| 约束 | 说明 |
|---|---|
| **ohpm 版本不可重用** | 同一 Node 版本若要重发包（修元数据 / 补许可文件），只能 `24.2.0+2`（build metadata，不参与排序）或 `24.2.1`（会被误读成 Node 24.2.1）⇒ **包内容必须在首发前定稿** |
| **与 Node 版本同步** | Node 升到 24.7.0 ⇒ 发包 `24.7.0`，且 `runtime.lock.json` 的 `active` 必须指向同一版本；发布脚本必须**断言三处一致**（runtime 包 version / lock.active / CHANGELOG 首条） |
| **主包依赖范围要写死** | 建议 `"@fellow99/node-runtime": "24.2.0"`（严格）或 `"^24.2.0"`（同 major 自动升 patch）；**不要**写 `*` —— 那会让「版本矩阵可审计」（NFR-4）失效 |

### 5.3 运行时包的工程结构（新增 module）

```
ohos-node-bridge/
├── runtime-har/                        # ← 新增 DevEco static library module（byteCodeHar）
│   ├── oh-package.json5                # name: @fellow99/node-runtime / version: 24.2.0
│   ├── Index.ets                       # ★ 最小入口：导出 NODE_VERSION / NODE_MODULE_VERSION / ABI / LIB_SHA256 / LIB_SIZE
│   ├── README.md                       # 必须含 `ohpm install @fellow99/node-runtime`
│   ├── CHANGELOG.md                    # 必须含 `24.2.0`
│   ├── LICENSE                         # Node.js v24.2.0 的 LICENSE 原文（⬜ 待取回，见 §5.5）
│   ├── THIRD-PARTY-NOTICES.md          # 来源 URL + SHA-256 + 内嵌组件清单
│   ├── libs/arm64-v8a/libnode.so       # ← 构建前由投放脚本放入（121 MB，不入库；.gitignore 已覆盖）
│   └── src/main/module.json5           # 纯资源库：**不声明任何权限**
└── build-profile.json5                 # 注册 runtime-har module
```

**为什么必须有 `Index.ets`**（不是可选项）：
① `main`/`types` 必须指向**包内真实存在的文件**（✅ 实测 `prepublish` 会校验，缺文件直接 ERROR）；
② 顺手补上现在缺的能力——**运行期自证运行时版本**（当前库只有 `bridgeVersion()`，没有 Node 版本探测）。

内容草案（值与 `runtime.lock.json` 同源，由发布脚本生成/校验，不手抄）：

```ts
export const NODE_VERSION: string = '24.2.0';
export const NODE_MODULE_VERSION: number = 137;   // ABI 137 ⇒ libnode.so.137
export const ABI: string = 'arm64-v8a';
export const LIB_SHA256: string = '3019bf5f…51a1';
export const LIB_SIZE: number = 126809264;
```

### 5.4 主包与运行时包怎么「绑」（三种，推荐 ②）

| # | 做法 | 体验 | 取舍 |
|---|---|---|---|
| ① | 主包 `dependencies` 写死运行时包 | `ohpm install @fellow99/node-bridge` **自动拉 41 MB**，最顺 | 人人被迫拉运行时装；想自己投放的人也躲不掉。⬜ 需实测：hvigor 是否把**传递依赖** HAR 里的 `.so` 合并进 HAP |
| ② | 主包**不写**依赖，README 首屏给两条命令 | 明确、可控、可换版本 | 漏装的失败必须**运行期可见**（错误文案要提「装运行时包」） | 
| ③ | 主包写 `devDependencies` | 不自动装 | 无意义，不采用 |

**推荐 ②**（先把链路实测通，再考虑升级到 ①）：主包 README 首屏即

```bash
ohpm install @fellow99/node-bridge
ohpm install @fellow99/node-runtime@24.2.0
```

同时把 `dlopen` 失败文案（现为「请确认已用 tools/provision.mjs 投放运行时」，`node_bridge.c:623`）改成**两种来源都提**：
「装 `@fellow99/node-runtime@24.2.0`，或用 `provision.mjs` 手工投放」。

### 5.5 ⬜ 发布前必须补齐（硬阻塞，缺一不可）

| # | 事项 | 为什么必须 | 怎么补 |
|---|---|---|---|
| 1 | ~~**Node.js v24.2.0 的 `LICENSE` 原文**~~ ✅ **已解决（2026-10-22）** | ohpm 开源包必须有非空 LICENSE；G4 要求许可随包 | 已取回并**逐字**入包：`runtime-har/LICENSE`，142,089 B / 2,641 行，**SHA-256 `b58bb782ec115892f61475a6199db165545926d93624ae172f25b7a6e1dafffe`**。两个独立源交叉核对**字节一致**（`raw.githubusercontent.com/nodejs/node/v24.2.0/LICENSE` 与 `cdn.jsdelivr.net/gh/nodejs/node@v24.2.0/LICENSE`）；正文含 V8 / OpenSSL / ICU / llhttp / zlib / libuv / nghttp2 / c-ares / brotli / undici 全部第三方许可 |
| 2 | `electerm/ohos-node-shared` 的 MIT 原文 / 版权行 | 构建脚本许可，署名要求 | 取上游 `LICENSE`，至少在 NOTICES 写全版权行 |
| 3 | `libc++_shared.so` 只在一处提供 | 现在它随**主包** HAR 走（1.2 MB，来自 ohos-sdk）；运行时包若也带 ⇒ 宿主 HAP 里出现**同名多份** | 建议：运行时包提供（它才是真需要方），主包 `.ohpmignore` 排掉；或反之，但**必须唯一** |

### 5.6 ✅ 链路实测（2026-10-22，已完成 1–3 项）

> 设备 `3QC0226526001227`（真机）× 构建机本机；样例目录里**手工投放的那份 `libnode.so` 已先移除**，
> 确保 HAP 里的 `libnode.so` **只能来自 runtime 包**——这是本组实验的关键前提。

| # | 项 | 结果 |
|---|---|---|
| 1 | `runtime-har/libs/arm64-v8a/libnode.so` 是否被打进 HAR | ✅ **是**：`package/libs/arm64-v8a/libnode.so` 126,809,264 B；HAR 总 **42,936,534 B（≈41 MB）**；11 条目 |
| 2 | 预编译 `.so` 是否被 `DoNativeStrip` 改动 | ✅ **未改动**：HAR 内抽出的 SHA = `3019bf5f…51a1`（= 锁值） |
| 3 | `assembleHar` 耗时 | ✅ **27 s**（含 `PackageHar` 2.99 s、`DoNativeStrip` 0.46 s） |
| 4 | HAR 的 `.so` 是否随宿主 `assembleHap` 合并进 HAP | ✅ **是**：HAP 内 `libs/arm64-v8a/libnode.so` 126,809,264 B，SHA = `3019bf5f…51a1`；HAP **129,490,046 B（≈129 MB）**，`compress_type = 0`（未压缩，与 `AC-007-12` 记录一致） |
| 5 | 裸名 `dlopen` 能否加载「来自 HAR 的那一份」 | ✅ **能跑起来，但不是靠裸名**：见下方日志——真正命中的是 **`<bundleCodeDir>/libs/arm64/libnode.so`**（候选 ③） |
| 6 | 端到端结果 | ✅ `curl /facts` **200**：`node v24.2.0`、`versions.modules=137`、`hotloop 301 ms/5 轮`、`fs_write_readback=OK`、`worker_threads=true`、`spawn` 三事件齐（`--jitless` 轮次） |

**设备上真实的 `dlopen` 候选链**（`node.log` 原文，`NODE_BRIDGE_LIBDIR=/data/storage/el1/bundle`）：

```
dlopen('/data/storage/el1/bundle/libs/arm64-v8a/libnode.so') -> Operation not permitted
dlopen('/data/storage/el1/bundle/libnode.so')                -> Operation not permitted
dlopen('/data/storage/el1/bundle/libs/arm64/libnode.so')     -> OK       ← 命中
dlsym(node::Start) -> 0x…
calling node::Start(argc=4) ...
```

> ⚠️ **这条实测纠正了仓库里的一处旧口径**：`README.md:79` 与 `docs/000` §D.8 记的是「`dlopen` 只认**裸名**，绝对路径全部失败」。
> 本次实测是「**前两个绝对候选失败、第三个绝对路径（`libs/arm64/`，即设备上的真实 ABI 目录名）成功**，裸名那条根本没走到」。
> 影响：① 发布文档别再对第三方说「只认裸名」；② `specs/002` 的候选链（`R-06`）应以 **`libs/arm64/` 优先**，`libs/arm64-v8a/` 与裸名降级为兼容分支
> （设备上 `/data/storage/el1/bundle/libs/` 用 shell 列不出来：`Permission denied`，但应用自身对该 ABI 目录 `dlopen` 可用）。

| # | 仍未实测 | 说明 |
|---|---|---|
| 7 | 传递依赖（主包 → 运行时包）的 `.so` 是否同样合并 | 本次是**样例直接依赖**运行时包（`oh-package.json5` 两条依赖），未测「主包 `dependencies` 里带运行时包」的传递形态；若将来切到 §5.4 ①，必须先验此项 |
| 8 | 真 JIT 轮次（`probePreset 1`，需 ACL） | 本次走 `--jitless`（`wasm.validate=ERR` 符合预期）；JIT 轮次已在 `docs/000` §D.9 有历史记录，发布前需按新 HAP 复跑 |

### 5.7 三方案对照（决策依据，保留备查）

| 维度 | A. 不带运行时 | **B. 双包（✅ 已选）** | C. 单包大包 |
|---|---|---|---|
| 包形态 | 主包 ≈0.5 MB | 主包 ≈0.5 MB + 运行时包 ≈41 MB | 单包 ≈41.5 MB |
| 第三方开箱可跑 | ❌ 需自己取 121 MB 二进制 | ✅ 两条 `ohpm install` | ✅ 一条 |
| 升级运行时 | 不影响库版本 | **独立升运行时包**（换 Node 不动桥接件） | 必须发新库版本（每次 41 MB） |
| 供应链/许可责任 | 全在消费方 | 集中在运行时包（责任边界清晰） | 全在主包 |
| 审核敏感性 | 低 | 中（引擎在独立包内，主包干净） | 高 |
| 版本可换 | ✅ | ✅（矩阵内自选版本） | ❌ 版本被钉死在包内 |

---

## 6. 审核与合规：非机械规则的风险与材料

中心仓除自动校验外还有人工审核。本库形态在「被问询」面上的风险点与应对：

| 风险点 | 为什么会被问 | 建议给审核的材料（写进 README + 附审核说明） |
|---|---|---|
| **包内含 JS 引擎 + 动态执行脚本** | 「库会执行第三方 JS 代码」是审核敏感项 | 说明：本库**不下载、不下发**任何代码；只把**宿主应用自己打包的**脚本交给进程内运行时执行（脚本来自应用 `rawfile`/沙箱，与库无关） |
| **`dlopen("libnode.so")` 动态加载** | 看起来像「加载外部可执行体」 | 说明：`libnode.so` 是**库/宿主随包分发**的 ELF，不是运行期下载；候选路径全部落在应用自己的 `bundleCodeDir/libs/<abi>/`（✅ 真机实测命中 `<bundleCodeDir>/libs/arm64/libnode.so`，见 §5.6）；附加载链 |
| **需要受限 ACL `ALLOW_WRITABLE_CODE_MEMORY`** | 该权限关系到可执行内存 | 说明：JIT 前置，**由宿主应用按自己包名申报**，库**不替宿主声明**；不申请时库可 `--jitless` 运行（代价：WebAssembly 关闭）。README 已有，需更醒目 |
| **「绕行平台」误判**（G11） | 历史上有 `wxjit` 一类实现 | 主动给审计判据：`grep -rniE "wxjit\|LD_PRELOAD\|mremap\|fake_codesign"` 在 `library/` 与 HAR 内 **0 命中**（✅ 现仓库已满足，`tools/ohos-selfsign.mjs` 不随包） |
| **第三方许可**（G4） | 未声明许可 = 直接拒 | `THIRD-PARTY-NOTICES.md` 随包（rawfile）+ README 摘要 + 「来源 URL + SHA-256」锚到 `runtime.lock.json` |
| **权限最小化** | 声明一堆权限会被要求解释 | ✅ 现状只 2 项（`INTERNET`、`GET_NETWORK_INFO`），**这是优点**，README 要写明「库只声明这 2 项」 |
| **闭源/开源口径** | `sourceType` 默认 open | 显式 `"open"` + `repository` + `license` 三件一致 |
| **第三方许可**（G4） | 未声明许可 = 直接拒 | 主包：`THIRD-PARTY-NOTICES.md` 随 rawfile + README 摘要；**运行时包：Node.js LICENSE 原文必须随包**（它再分发 Node 二进制）+ 来源 URL + SHA-256 锚到 `runtime.lock.json` |
| **两包独立审核** | 中心仓按**包**审核，两个包会各出一次审核单、各被问询 | 运行时包的 README/审核说明要能**单独站住**（说明「这是 Node.js v24.2.0 的 arm64-v8a 共享库封装，来源 + SHA-256 + 许可」），不假设审核员会去看主包 |

> ⚠️ **时间风险**：审核问询一来一回通常按「工作日」计；建议 ① 首发就一次性把材料给足；② 先发 `0.1.0-rc.x`（运行时包发 `24.2.0-rc.1`）探路，
> 通过后再发正式版。注意**两个包各有一个审核窗口**，不要指望同时通过。

---

## 7. 文件级改动清单（可直接照着改）

| # | 路径 | 动作 | 要点 | 判据 |
|---|---|---|---|---|
| 1 | `library/CHANGELOG.md` | ✅ **已建** | `## 0.1.0（首发）`：功能面 / 配套运行时包 / 已知限制 / 验证记录 | HAR 内含且含 `0.1.0`（✅ 门禁通过） |
| 2 | `library/LICENSE` | ✅ **已建** | 仓库根 MIT 逐字复制（`diff` 一致） | HAR 内含、非空（✅ 门禁通过） |
| 3 | `library/README.md` | ✅ **已改关键段** | 新增「安装」（两条 `ohpm install`）、三步接入改为「装运行时包 → 声明 ACL → 自备载荷」、新增「包内容（发布物）」与许可段、修正 `dlopen` 限制 | 含 `ohpm install @fellow99/node-bridge`（✅ 门禁通过）；更细重写（API 表/兼容矩阵）仍可继续 |
| 4 | `library/readme-zh.md`（可选） | ⬜ 未做 | 中文版（默认版建议英文/中英混排） | 详情页中文环境优先显示 |
| 5 | `library/oh-package.json5` | ✅ **已改** | `author` 对象（`fellow99` / `fellow99@163.com` / `https://fellow99.github.io/`）、`repository: https://github.com/fellow99/ohos-node-bridge`、`sourceType:"open"`；`dependencies` **保持为空** | 打包后字段合规（✅ 门禁通过） |
| 6 | `library/src/main/resources/rawfile/node_bridge/runtime.lock.json` | ✅ **已建** | 从仓库根复制（3,374 B）；消费方用 `resourceManager.getRawFileContent('node_bridge/runtime.lock.json')` 读 | HAR 内含（✅ 实测）；`release.mjs --check-version` 断言副本与仓库根**逐字一致** |
| 7 | `library/src/main/resources/rawfile/node_bridge/THIRD-PARTY-NOTICES.md` | ✅ **已建** | 同上（10,824 B），G4 许可清单随包 | 同上 |
| 8 | `library/src/main/resources/rawfile/node_bridge/provision.mjs`（可选） | ⬜ 未做 | 让第三方拿到工具本体；或至少给用法 + SHA 校验脚本 | 第三方可独立校验 |
| 9 | `library/.ohpmignore` | ⬜ 待定 | 是否排掉 `libc++_shared.so`（改由运行时包唯一提供，见 §5.5 第 3 项）；已排 `libnode.so` | 与 §10 第 5 项决策一致 |
| 10 | `tools/verify-har.mjs` | ✅ **已实现** | 发布门禁：零依赖解 gzip tar + 34 项断言（四件套 / README 安装命令 / CHANGELOG 版本 / author 对象+email\|url / repository / `metadata.debug===false` / 无 `.exe` 与签名材料 / `.so` 全在 `package/libs/` / 体积上限 / **主包不得含 libnode.so** / **运行时包 `libnode.so` 的 SHA+大小 = 锁值**）；`nativeComponents` 覆盖度按中心仓口径降为 **WARN** | `--check-version` 全过；**自测已做**：完好合成包 31/31 通过（exit 0），删掉 `CHANGELOG` 后 exit 2 |
| 11 | `tools/release.mjs` | ✅ **已实现** | `--check-version`（版本/锁/CHANGELOG/Index 常量/已投放 `.so`/rawfile 副本共 17 项）/ `--build`（投放 → 两个 `assembleHar` → 双 `verify-har` → 双 `prepublish`）/ `--print-publish` | `node tools/release.mjs --check-version` → exit 0（✅ 实测） |
| 12 | **`runtime-har/`（新 module）** | ✅ **已建** | `oh-package.json5`（`@fellow99/node-runtime@24.2.0`）、`Index.ets`、`README.md`、`CHANGELOG.md`、`LICENSE`、`src/main/module.json5`（零权限）、`.ohpmignore`、`build-profile.json5`、`hvigorfile.ts`；`libs/arm64-v8a/libnode.so` 由投放产出（不入库） | ✅ 出包 42.96 MB；34/34 门禁过；`prepublish` succeed |
| 13 | `build-profile.json5` | ✅ 已改 | 注册 module：目录 `./runtime-har`，**模块标识符 `runtimehar`**（schema 不允许中划线 `^[a-zA-Z][0-9a-zA-Z_.]*$`，✅ 实测报错后修正） | `assembleHar -p module=runtimehar@default` 出包（✅ 24 s） |
| 14 | `runtime-har/LICENSE` | ✅ **已建** | Node.js v24.2.0 官方 `LICENSE` **原文逐字**（142,089 B，SHA-256 `b58bb782…dafffe`，两源交叉核对） | HAR 内含、非空（✅ 门禁通过） |
| 15 | `runtime.lock.json` | ⬜ 未做 | 增 `bridge.version` / `bridge.harSha256`；每项增 `ohpmPackage: "@fellow99/node-runtime@<node>"`；`mirror` 若要公开镜像则回填 | 版本矩阵可机读（FR-007-008） |
| 16 | `specs/007-distribution-har-package/spec.md` | ⬜ 未做 | 把 §4 的 P0 项映射进 FR-007-005/008/010/015；**FR-007-003 改写**为「主包不含运行时；运行时由独立包提供」；新增 NFR「运行时包 ≈41 MB（压缩）」 | 现状列与实测一致 |
| 17 | `docs/000-工程规划.md` §7.5 / §8 Phase 3 | ⬜ 未做 | 「首发」口径落成「双包 + 发布顺序」的可执行步骤与判据 | 与本文一致 |
---

## 8. 建议的发布流水线（命令级）

> 已封装成脚本：`node tools/release.mjs --check-version` / `--build` / `--print-publish`（见 §7 第 10–11 项）。
> 下面是它内部等价的手工命令，便于排障。

```bash
# 0. 环境（与本仓库既有约定一致）
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"

# 1. 版本一致性（新脚本承担）：runtime 包 version = runtime.lock.json 的 active = 两个 CHANGELOG 首条
node tools/release.mjs --check-version

# 2. 投放运行时进运行时包（幂等；✅ 七项门禁 + SHA-256 硬校验）
node tools/provision.mjs --out runtime-har/libs/arm64-v8a

# 3. 两个 module 各出 release HAR（主包 ✅ 实测 ~22–32 s / 486 KB；运行时包 ≈41 MB）
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\hvigorw.bat --mode module -p module=library@default     -p buildMode=release assembleHar --no-daemon"
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\hvigorw.bat --mode module -p module=runtimehar@default -p buildMode=release assembleHar --no-daemon"

# 4. 本地发布门禁（新脚本，复刻服务端规则；两个包都跑）
node tools/verify-har.mjs library/build/default/outputs/default/library.har
node tools/verify-har.mjs runtime-har/build/default/outputs/default/runtimehar.har
#   共用断言：四件套齐 / README 含 ohpm install / CHANGELOG 含版本 / metadata.debug===false /
#            无 .exe、无 signing.*、无 *.p12 / libs/*.so 均被 nativeComponents 覆盖 / 大小 < 500 MB
#   运行时包专属：libs/arm64-v8a/libnode.so 的 SHA-256 与大小 = lock、version = lock.active

# 5. ohpm 预校验（✅ 本机可用；注意它不覆盖四件套，见 §2.8）
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\ohpm.bat prepublish runtime-har\\build\\default\\outputs\\default\\runtimehar.har"
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\ohpm.bat prepublish library\\build\\default\\outputs\\default\\library.har"

# 6. 发布（需要人工凭据，脚本只打印命令不代跑）
#    ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
#    ohpm config set publish_id <个人中心发布码>;  ohpm config set key_path <私钥>
#    ★ 顺序：**先运行时包，后主包**（主包引用 24.2.0；反过来会在 install 时找不到依赖）
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\ohpm.bat publish runtime-har\\build\\default\\outputs\\default\\runtimehar.har -t latest"
cmd //c "D:\\oh-workspace\\command-line-tools\\bin\\ohpm.bat publish library\\build\\default\\outputs\\default\\library.har -t latest"

# 7. 审核跟踪：中心仓【个人中心】-【消息】/【Package】；通过后上架
#    文档类更新（README/CHANGELOG）走单独更新入口，不必重发 HAR
```

**纪律**：`tools/verify-har.mjs` 必须是**硬失败**（退出码非 0）而不是告警——它替代的是「服务端才会告诉你」的那部分校验；
**发布顺序不能反**（运行时包先上架，主包的依赖才解得开）。

---

## 9. 版本与兼容矩阵策略（发布面最小可接受）

| 项 | 现状 | 目标（方案 B） |
|---|---|---|
| 主包版本 `@fellow99/node-bridge` | `0.1.0` 骨架 | 自身 semver；首发 `0.1.0`；`0.x` 允许 minor 破坏，但**必须在 CHANGELOG 写明迁移** |
| 运行时包版本 `@fellow99/node-runtime` | 不存在 | **严格 = Node 版本**；首发 `24.2.0`；Node 升级即新包（24.7.0 / 26.x） |
| 两包关系 | — | 主包 `dependencies` 指向 `24.2.0`（严格）或 `^24.2.0`；**发布顺序：先运行时包** |
| `runtime.lock.json` | 只有 libnode 侧（版本/SHA-256/SONAME/门禁/真机记录） | 增 `bridge: { version, harSha256 }` 与 `ohpmPackage: "@fellow99/node-runtime@<node>"`；`bridge ↔ libnode ↔ 包版本` 三者映射写进文件（离开文档表格） |
| 兼容矩阵 | 只在 `docs/000` §7.5 表格 | `compatibility.json` 随 rawfile：`{ bridge, libnode:[...], ohpm:{"@fellow99/node-runtime":"24.2.0"}, api:["17+","24","26"], deviceTypes:["2in1","tablet"], abi:["arm64-v8a"] }` |
| deviceTypes | `2in1` / `tablet`（✅ HAR 内实测） | 不做 phone 是既定决策（A5）；两个包的 README 都要写，避免手机用户装完报错 |
| ABI | 只有 `arm64-v8a` | 运行时包 README 写明；x86_64 不做（A5） |
| 体积预算 | 主包 ✅ 495,595 B（≈484 KiB） | 主包 NFR-1 保持「≈0.5 MB 量级」；**新增**运行时包 NFR「≈41 MB 压缩 / ≈121 MB 解压」 |

---

## 10. 未决事项（需人工确认，代码解决不了）

| # | 事项 | 归属 | 阻塞什么 |
|---|---|---|---|
| 1 | `@fellow99` 组织是否已在中心仓注册、谁入组；`publish_id`/私钥谁持有 | 人工（账号） | 一切发布动作 |
| 2 | ~~`repository` 填哪个 URL~~ ✅ 已定：`https://github.com/fellow99/ohos-node-bridge`（两个包都已填） | — | — |
| 3 | ~~`author.email` / `author.url`~~ ✅ 已定：`fellow99@163.com` / `https://fellow99.github.io/`（两个包都已填，`author` 改为对象） | — | — |
| 4 | ~~运行时随包与否（A/B/C）~~ → **已定 B**（2026-10-22）；残余待确认：主包是否写死依赖（§5.4 ①/②） | 需拍板 | P0-5、spec 007 修订 |
| 5 | `libc++_shared.so` 只在一处提供（§5.5 第 3 项）：现在主包与运行时包**各带一份**（HAP 内按路径去重，暂不出错） | 需拍板 | 包内容 / P1-1 |
| 6 | **残余许可**：`ohos-node-shared` 构建脚本的 MIT 原文/版权行 | 人工（取上游文件） | 不影响 ohpm 上架，影响许可完备性 |
| 7 | 主包是否也钉 `24.2.0`（本文建议不要） | 需拍板 | 两包版本策略 |
| 8 | 首发是否用 `-rc` 试水；被拒后的重发节奏（版本不可重用，尤其运行时包） | 人工 | 版本号消耗 |
| 9 | 审核说明材料由谁写、写多长 | 人工 | §6 |

---

## 11. 与既有 specs 的映射（提交后应同步修订的条目）

| spec 条目 | 现状（spec 原文） | 本文对应 | 建议 |
|---|---|---|---|
| FR-007-001 单一入口导出面 | ✅ | §2.5 `types` | 保持 |
| FR-007-003 HAR 不含 `libnode.so` | ✅ | §5（方案 B） | **改写**为「主包不含运行时；运行时由 `@fellow99/node-runtime@<node>` 提供」，判据改为「主包 HAR 无 `libnode.so` + 运行时包 HAR 有且 SHA = 锁值」 |
| FR-007-005 「怎么拿运行时」线索随包 | ⬜ 未落地 | P0-5 | 两条腿：运行时包（`ohpm install` 即得）+ 主包 rawfile 里的 `runtime.lock.json`/许可；落地后改 ✅（补判据：`getRawFileContent` 可读） |
| FR-007-008 语义化版本 + 版本矩阵 | ⚠️ 部分 | §9 | 补 `bridge` 段 + `ohpmPackage` 字段；**新增**「runtime 包版本 = Node 版本」的对应关系 |
| FR-007-010 许可齐备 | ⚠️ 缺口（当时无独立清单文件；现在仓库根已有 `THIRD-PARTY-NOTICES.md`，但**未随包**） | P0-2/P0-5、§5.5 | 主包随 rawfile；**运行时包必须带 Node.js LICENSE 原文**（⬜ 待取回）后改 ✅ |
| FR-007-015 包元数据自证 | ✅ 但 `author` 为字符串、无 `repository` | §2.5 / P0-4 | 改判 ⚠️ → 修完改 ✅；**两个包都要过同一套元数据口径** |
| NFR-1 包体积 ≈441 KB 量级 | ✅（实测 486,170 B） | §9 | 主包保持；**新增**「运行时包 ≈41 MB 压缩 / ≈121 MB 解压」并写进 spec NFR |
| AC-007-09 / AC-007-10 | ⬜ | §4 P0-5、§6 | 落地后重跑 |
| AC-007-13 样例可独立验证 | ⬜（`samples/minimal-app` 仍是本仓库 module，不是第三方视角样例） | P2-2 | 保持 ⬜ |

---

## 附录 A：本次实测命令与输出摘要

### A.1 产物与结构

```bash
# debug 产物（历史）：502,449 B
cp library/build/default/outputs/default/library.har $PI_SCRATCH_DIR/library-debug.har

# release 产物（本文基准）：486,170 B
cmd //c "...\\hvigorw.bat --mode module -p module=library@default -p buildMode=release assembleHar --no-daemon"
# > hvigor BUILD SUCCESSFUL in 22 s 110 ms

# HAR 实为 gzip tar（不是 zip）
file library.har   # gzip compressed data ...
gzip -dc library.har > library.tar && tar -tf library.tar | wc -l   # 27
```

### A.2 本地 ohpm 校验

```bash
cmd //c "...\\ohpm.bat -v"           # 6.1.2.285
cmd //c "...\\ohpm.bat publish --help"
# Usage: ohpm publish [options] <har_or_tgz_file>

cmd //c "...\\ohpm.bat prepublish library.har"
# ohpm WARN: ... the har file "library.har" contains source code ...
# prepublish @fellow99/node-bridge 0.1.0 succeed.      ← ⚠️ 缺 CHANGELOG/LICENSE 也 succeed
```

### A.3 告警成因（源码定位）

```text
tools/ohpm/lib/core/publish/util/checkAndAlarmAssetLeakage.js
  t.obfuscated || (s += `* the har file "..." contains source code, ...`)
# ⇒ 仅由 obfuscated===false 触发；与包内是否含源码无关
```

### A.4 打包边界三组对照实验（关键结论）

| 实验 | 往 `library/` 里放 | 结果 |
|---|---|---|
| ① | `CHANGELOG.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`docs/runtime.lock.json` | `package/CHANGELOG.md` ✅、`package/LICENSE` ✅、`THIRD-PARTY-NOTICES.md` ❌、`docs/` ❌ |
| ② | 另加 `src/main/resources/rawfile/node_bridge/{runtime.lock.json,THIRD-PARTY-NOTICES.md}` | `package/src/main/resources/rawfile/node_bridge/*` ✅ **随包** |
| ③ | 全部回退后重新 release 构建 | 27 条目、无残留 ✅（`git status` 干净） |

### A.5 体积事实

```bash
gzip -6 -c runtime/node-v24.2.0/libnode-arm64.so | wc -c   # 41,003,250 B ≈ 39 MiB
# ⇒ 运行时包（@fellow99/node-runtime@24.2.0）≈ 41.5 MB（压缩），解压 ≈ 128 MB，远低于 500 MB / 1500 MB 上限
node tools/provision.mjs --check   # 七项门禁全过，SHA-256 = 3019bf5f…51a1（退出码 0）
```

---

## 附录 B：官方规则原文摘录（关键条）

1. **必要文件**（`publishrequirefile`）：「如需发布一个 har 包，必须包含 oh-package.json5、README.md，CHANGELOG.md 和 LICENSE 四个文件，若文件缺失，会导致上架至中心仓失败。注：闭源 har 包可以不包含 LICENSE 文件。」
2. **README 安装命令**（`publishrules` §六）：「`readme` 中必须包含 `ohpm install <包名>` 或 `ohpm i <包名>` 命令」。
3. **CHANGELOG**（同）：「必须存在，必须包含当前版本号」。
4. **`.so` 位置**（同）：「`.so` 文件必须放在 `package/libs/` 目录下」。
5. **包名**（`guidename`）：「格式为：`@group/packagename` 或 `packagename`，长度 [1,128]，全局唯一」；group 仅小写字母/数字/`-`/`_`。
6. **组织权限**（`publishrules` §五）：「带组织包（如 `@ohos/xxx`）：发包人必须属于该组织，否则无权发包到该命名空间」。
7. **体积**（`publishrules` §三）：har ≤ 500 MB；解压 ≤ 1,500 MB；文件数 ≤ 102,400；README ≤ 10 MB。
8. **`author`**（同 §4.1）：必须为对象，`name` 必填，`email`/`url` **至少填一个**。
9. **`repository`**（同 §4.2）：开源包必填，URL，≤1024 字符。
10. **发布命令**（`createandpublish`）：「`ohpm publish <HAR路径>`」；发布成功后生成「创建上架审核单成功」通知，审核通过才上架。

---

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| HAR | HarmonyOS Archive，静态共享包（`har`），ohpm 发布单元 |
| byteCodeHar | 只含 `modules.abc` 字节码 + `.d.ets` 类型声明的 HAR（本库形态，`metadata.byteCodeHar:true`） |
| `prepublish` | ohpm 本地预校验，**只覆盖本地能判的规则**（§2.8） |
| ACL | 受限权限，需按应用包名申报（本库依赖 `ALLOW_WRITABLE_CODE_MEMORY` 开 JIT） |
| 四件套 | `oh-package.json5` + `README.md` + `CHANGELOG.md` + `LICENSE` |

---

**本文结论一句话**：先补齐四件套与元数据（半天到一天），按 **方案 B** 建出 `runtime-har/` 并补回 **Node.js LICENSE 原文**（§5.5，硬阻塞），
然后用 `verify-har` + `prepublish` 双门禁**按「先运行时包、后主包」**发布；两处人工前提（§10 第 1、2 项）与审核口径（§6）是唯一不受代码控制的风险点。
