# constitution.md —— `ohos-node-bridge` 项目宪法（治理原则）

> 本文件是 `@fellow99/node-bridge` 的**最高约束**。任何 `spec.md` / `plan.md` / 实现 / 评审都必须先过这一关。
> 原则不是发明的，而是从**已落地的代码**与**真机实测结论**中抽取的（依据列在每条末尾）。
>
> - 权威规划文档：[`../docs/000-工程规划.md`](../docs/000-工程规划.md)（v0.9，**结论以它为准**）
> - 版本：v1.0 · 2026-10-16 · 状态：**生效**
> - 适用：`library/`（HAR 发布物）· `payload/`（Node 侧 JS）· `tools/`（host 侧工具链）· `specs/`

---

## 一、七条不可协商的原则

### C1. 库 / 壳分离（Library–Shell Separation）

**库只负责「在应用进程内跑 Node」；一切应用语义留在消费方。**

- 库**不得**出现：窗口、页面、路由、ArkWeb 组件、应用图标、包名、签名主体、鉴权、`pi`/`pi-web`/Next.js 语义、`PI_*` 环境变量的**解释**。
- 判定口径：**「这一条是不是宿主语义？」—— 是，则一票否决**。
- 违反实例（必须挡住）：在 `library/` 里写「加载 pi-web 的启动脚本」、把 `PI_WEB_PASSWORD` 硬编码进库、在 `Logger` 里打印应用业务状态。

依据：规划 §0.3 非目标 · §1.3 责任分界 · §3.2「库/壳分离」· 风险 R15。

---

### C2. 不隐藏平台真相（No Silent Degradation）

**平台能力缺口必须如实上报为能力标志 / 结构化错误，绝不静默降级。**

- 任何「失败」都要能被调用方看见：返回结构化错误、写日志、进状态机；**不允许** catch 后返回空值、空数组、假成功。
- 未注册的宿主能力 → **明确报错**，不得返回空字符串（反面教材：旧壳 `ExternalWeb.Open` 未注册却直接解引用，把整个应用打崩）。
- 版本不满足（`process.version < 22.19.0`）⇒ **warn 并可见**，不静默继续。

依据：规划 §3.2 · §5.4「失败语义」· §4.4 归属 · `library/src/main/ets/bridge/HostBridge.ets`（`unregistered` 结构化返回）。

---

### C3. 让最终使用者去读（Whoever Writes Must Read Back）

**凡「写入成功」的判据，一律改为「最终使用者读一遍」。**

- 硬约束：ArkTS / 鸿蒙侧解压器写出的文件，**Node 读不到**（`MODULE_NOT_FOUND`，`requireStack: []`）。
- 因此：载荷解包必须由 **Node 自己**做（`zlib` + `fs`）；不许用 OHOS 侧解压器写业务文件。
- 同理：写日志后要有**读回通道**（`Logger.tail` / `/log` 端点），不许只有「写成功」的断言。

依据：`harmonyos-node-notes` 硬约束 ④ · 规划 §3.2 · §5.5「谁解包」· `library/src/main/ets/util/Env.ets` 注释。

---

### C4. 启动参数不可事后修改（ExecArgv Is Immutable After Start）

**`execArgv` 只能在 `node::Start` 之前定死。**

- `NodeRuntimeOptions.flags` 是**一次性**输入；库**不得**提供运行期 `push` / 追加参数的 API。
- `--jitless` 只允许作为**诊断开关**出现（它是关闭 WebAssembly 的开关，不是性能选项）。

依据：`process.execArgv` 启动即固定 · 规划 §3.2 · §4.7 · §6.2 共享事实 5。

---

### C5. 单例与不可重启（Singleton, No In-Process Restart）

**进程内 `node::Start` 只能调用一次；崩溃是终态。**

- `NodeRuntime` 必须提供**幂等保护**：非 `IDLE` 状态再次 `start()` ⇒ 返回失败并保留首次原因。
- **不得**实现「崩了自动重启」—— 平台语义封死，假装恢复会误导用户。
- 失败态 UX 契约：只允许「读日志 / 读崩溃记录 / 提示重启应用」。

依据：`node.cc` `limit_called.exchange(true)` 断言 · 规划 §3.2 · §5.2 · 硬约束 ⑥。

---

### C6. 诊断优先于修码（Observability Before Code）

**先建观测通道，再动代码。**

- 任何新增能力，落地前必须回答：**怎么在真机上看见它**（截图 / HTTP 端点 / hilog / 日志环）。
- 禁止的假判据：用 hilog「有没有那一行」判执行；用 `VmSize` 判 V8 是否起来；用「点击看起来生效」判 UI。
- 崩溃必须留**结构化证据**（`CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…`），不是只有「崩了」。

依据：规划 §3.2 · §5.7「禁止的判据」· 附录 B 症状 17/18 · `library/src/main/cpp/node_bridge.c` `crash_handler`。

---

### C7. 零上游补丁优先 / 二进制可替换（Zero-Patch & Replaceable Runtime）

- 能用现成机制（env、flags、同名顶替、ELF 属性）解决的，**不允许**打补丁；补丁必须幂等、可反向。
- 库**只依赖** `libnode.so` 的 ELF 属性与 `node::Start` 符号，**不依赖**任何特定构建来源 ⇒ 运行时产物可随时替换（`runtime.lock.json` 换一行即可）。
- 供应链纪律：引入的二进制必须**锁定来源 + SHA-256 + 许可**，且能说出「验过没有」（`verifiedOn` / `verifiedDevice`）。

依据：规划 §3.2 · §5.8 · 风险 R8 / R20 · 附录 G。

---

## 二、代码规约（从现有代码抽取，实现必须一致）

| # | 规约 | 现状依据 |
|---|---|---|
| S1 | **ArkTS 严格模式**：不出现 `any` / `unknown`；原生模块**只经 `.d.ts` 环境声明**接入（`cpp/types/libnode_bridge/index.d.ts`），**不得**把 `.so` 当包内模块导入 | `library/Index.ets`、`library/src/main/ets/runtime/NodeRuntime.ets:3` |
| S2 | **barrel 唯一出口**：对外只暴露 `Index.ets` 导出的符号；新增公共 API 必须同时改 `Index.ets` 与 `runtime/Types.ets` | `library/Index.ets` |
| S3 | **类型改动即破坏性变更**：`Types.ets` 是对外契约，注释里必须写明 | `library/src/main/ets/runtime/Types.ets` 文件头 |
| S4 | **路径一律绝对**：不依赖 `process.cwd()`（真机 = `/`）、不依赖 `process.execPath`（真机 = `/system/bin/appspawn`） | `library/src/main/ets/util/Env.ets`、规划 §D.8 偏差表 |
| S5 | **信号上下文禁用 stdio**：`SIGSYS` / 崩溃 handler 内**只允许**裸 `open`/`write`/`close`，**禁止** `printf`/`vsnprintf`/`OH_LOG_Print` | `library/src/main/cpp/node_bridge.c` `raw_write` 注释 |
| S6 | **native 产物落点固定**：CMake 必须显式设 `CMAKE_LIBRARY_OUTPUT_DIRECTORY` → `<module>/libs/${OHOS_ARCH}`，否则 HAP 里没有 `libs/`（不报错但功能不通） | `library/src/main/cpp/CMakeLists.txt:11-12` |
| S7 | **引导件不链接 libnode**：`dlopen` 在运行期完成，引导件与运行时版本解耦 | `library/src/main/cpp/CMakeLists.txt:16-18` |
| S8 | **C 侧接口只有 3 个**：`start` / `isRunning` / `version`；扩展 NAPI 面必须同时更新 `.d.ts` | `library/src/main/cpp/node_bridge.c:285-293` |
| S9 | **日志双通道**：关键信息同时进 hilog 与日志文件；文件读取失败返回占位串而**不抛异常** | `library/src/main/ets/log/Logger.ets` |
| S10 | **二进制不入库**：`libnode.so`（120.9 MiB）由 `tools/provision.mjs` 投放；HAR 不含它（`.ohpmignore`） | `library/.ohpmignore` · `runtime.lock.json` · 附录 G.1 |

---

## 三、证据纪律（Evidence Discipline）

全文使用四种标记，**不要把推断当实测**：

| 标记 | 含义 |
|---|---|
| ✅ **实测** | 本工程内可复核的一手证据（源码 `path:line` / 本机产物 / 真机日志） |
| 🔶 **沿用** | 沿用外部/同型工程的一手真机记录（本工程**未复现**） |
| ⬜ **待验证** | 本工程必须自行实测或实测后才能定稿 |
| ⚠️ **冲突/风险** | 两份一手材料互斥，或存在已知硬阻塞 |

两条纪律：

1. `🔶 沿用` 的结论**不得**作为本工程对外承诺的依据 —— 鸿蒙生态里「声明存在」≠「设备可用」，**必须真机调一次**。
2. **凡涉及运行时可见性的结论，观测点必须是应用域**：沙箱内的日志文件连 debug 签名也不让 `hdc` 读（`permission denied`）。

---

## 四、合规红线（Release Gate）

| # | 红线 | 处置 |
|---|---|---|
| G3 | 包内**不得**含第三方浏览器内核 | 本库随包只有 `libnode.so` + 引导件 + JS 载荷 ✅ |
| G4 | **第三方许可清单**必须随包 | Node.js（MIT）+ V8/OpenSSL 等；来源与 SHA-256 固化在 `runtime.lock.json` |
| G5 | ELF 合规 | HAP 内原生库**不需要** `.codesign`（已实测）；`provision --sign` 只服务独立分发 |
| **G11** | **不得包含绕过平台代码签名 / 可执行内存控制的组件** | 路线 J′ 的实现**不得进入发布物**；只允许存在于设计文档与本机 PoC，与发布分支**物理隔离** |

依据：规划 §4.8 · §9.5 · 风险 R23。

---

## 五、评审清单（Reviewer Checklist）

评审任何 `spec.md` / `plan.md` / PR 时逐条问：

- [ ] 是否引入了宿主语义？（C1）
- [ ] 失败时调用方能否看见？（C2）
- [ ] 「写成功」的判据是否改成「读回」？（C3）
- [ ] 是否新增了运行期改 `execArgv` 的路径？（C4）
- [ ] 是否增加或暗示了「重启 Node」？（C5）
- [ ] 是否给出了**真机可观测**的判据？（C6）
- [ ] 是否需要对上游/产物打补丁？可否用现成机制替代？（C7）
- [ ] 每条结论是否带证据标记？（§三）
- [ ] 是否触碰 G11 红线？（§四）

---

## 六、变更流程

1. 改公共 API（`Index.ets` / `Types.ets`）⇒ 必须同时改 `specs/README.md` 的编号表与受影响模块的 `plan.md`；语义化版本必须提。
2. 改 `runtime.lock.json`（换运行时版本）⇒ 必须重跑 `tools/provision.mjs --check` + 真机 `/facts`，并把 `verifiedOn` / `verifiedDevice` 写回。
3. 新增平台结论 ⇒ **先写进 `docs/000-工程规划.md`**（它是唯一权威），规格文档只引用它的 § 号，**不复制粘贴**。
