# overall-test-cases.md —— `@fellow99/node-bridge` 全模块测试用例索引

> **性质**：**索引文档**（不是逐条用例全集）。逐条用例的完整步骤写在 `specs/NNN-*/tests.md`；本文负责①分层口径 ②用例族索引与判据 ③真机取证通道 ④禁止的判据 ⑤已知基线数值。
> **依据**：`specs/constitution.md`（C1–C7 / S1–S10）· `docs/000-工程规划.md`（唯一权威，下称「规划 §」）。
> **标记**：✅已实现可跑 / ⬜规划未实现（Phase N）/ ⚠️风险项。
>
> ⚠️ **引用基准**：`状态` 列按 **2026-10-16 成稿快照** 判定；此后 `cpp/`（`node_bridge.c` 已 >760 行）与 `ets/` 均有**并行实现**推进 ⇒ 跑用例前先按符号名（而非行号）核对现状。
> **版本**：v1.0 · 2026-10-16。**判据纪律：每条判据必须可证伪；无「通过/不通过」二元出口的条目不得进表。**

---

## 1. 测试分层

| 层 | 代号 | 是否需要真机 | 跑在哪 | 目的 | 现状 |
|---|---|---|---|---|---|
| **host 侧门禁** | **L1** | ❌ | 开发机 / CI（`node` + 可选 `python`） | 产物合法性（七项 ELF 门禁 + SHA-256 + 大小）、投放幂等、篡改即失败 | ✅ 已实现（`tools/provision.mjs`、`tools/elf-inspect.py`） |
| **host 侧单元** | **L2** | ❌ | 开发机 | 载荷自解包（**Node 自己解包 → 读回**）、幂等 marker、入口解析（CJS/ESM）、桥的 JSON 契约（失败形态/上限/超时） | ⬜ Phase 1（`tools/smoke-host.mjs`） |
| **真机自检** | **L3** | ✅ | 真机（探针工程或消费方应用） | 自检载荷 `/facts` + `/log` 与基线比对；崩溃取证；状态机可见 | ✅ 载荷可用（`payload/selfcheck.js`）；库侧待 Phase 1 复跑 |
| **真机端到端** | **L4** | ✅ | 真机 + 真实消费方载荷 | 起本地服务 → 宿主 Web 容器加载 → 探活 → 首屏；`spawn`/`fetch`/`worker_threads` 能力面 | ✅ 已由消费方达成一次（规划 §D.10）；库侧回归 ⬜ |
| **回归基线** | **L5** | ✅ | 真机 + 构建产物 | 签名 HAP SHA-256、首启耗时、包体、`/facts` 快照、体积压缩方式 | ⬜ Phase 3 |

**顺序纪律**：L3 的观测通道必须先于 L4 的任何功能验收（C6「先建观测，再动代码」）。L1/L2 可在任何时刻跑，但**不能替代** L3/L4 —— 平台行为（W^X、`dlopen` 裸名、端口冲突 abort）在 host 侧无法复现。

---

## 2. 用例族索引

> 列定义：`层` = §1 的代号；`覆盖的模块` = 规划 §7.3 编号；`证据/命令` 直接可粘贴执行。
> `状态`：✅已实现可跑 / ⬜规划未实现 / ⚠️已知缺口需先修再测。

### 2.1 跨模块（`TC-OVR-*`）

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-OVR-001 | 版本矩阵一致性 | L1 | 005/007 | 锁文件 `active` 能在 `runtimes[]` 命中；`nodeModuleVersion` == `SONAME` 尾号；产物内嵌版本串 == `active.node` | `node tools/provision.mjs --list`；`python tools/elf-inspect.py <so>` | ✅ |
| TC-OVR-002 | 七项门禁全过 | L1 | 005 | 七项全部 `OK`；任一 `FAIL` 即不合格（尤其 ② `PT_INTERP == 0`） | `node tools/provision.mjs --check` | ✅ |
| TC-OVR-003 | 篡改即硬失败 | L1 | 005 | 改动产物 1 字节后 ⇒ 非 0 退出 + 明确「SHA-256 不一致」；**不得**就地找替代品 | 复制产物 → 改 1 字节 → `provision.mjs --check` | ✅（规划附录 G.4 已实测） |
| TC-OVR-004 | 投放幂等 | L1 | 005 | 二次投放输出「已是最新 → 跳过拷贝」且目标文件 mtime 不变 | 连续两次 `provision.mjs --out <dir>` | ✅ |
| TC-OVR-005 | 二进制不入库 | L1 | 007 | `git ls-files` 无 `libnode.so` / `libc++_shared.so` / `*.har`；HAR 内无 `libnode.so` | `git ls-files \| grep -E '\.so$\|\.har$'` | ✅ |
| TC-OVR-006 | 交付物许可清单 | L1 | 007 | 交付物内存在第三方许可清单（G4） | 包内文件清单核对 | ⬜（当前缺口） |
| TC-OVR-007 | 发布物无绕行实现 | L1 | 007 | 发布物/发布分支内不存在路线 J′ 相关实现（G11） | 全仓 grep + 分支隔离检查 | ✅（当前无实现） |
| TC-OVR-008 | 体积与压缩方式 | L4 | 006/007 | HAP 内每个 `.so` 的 `compress_type == 8`；库侧增量 ≈44 MB | `python -c "import zipfile;z=zipfile.ZipFile('x.hap');print([(i.filename,i.compress_type) for i in z.infolist() if i.filename.endswith('.so')])"` | ⚠️ 压缩开关未落（Phase 1 先修） |
| TC-OVR-009 | 库/壳分离静态检查 | L1 | 全 | `library/` 与 `payload/` 内不出现应用特有标识（含变量名）；无窗口/页面/浏览器语义 | 全仓 grep 关键词 + 人工评审（C1） | ⚠️ `payload/bootstrap.js:49` 越界（Phase 1 先修） |
| TC-OVR-010 | 启动参数不可事后修改 | L1 | 001 | 公共 API 清单内无追加/修改启动参数的入口 | 审 `Index.ets` 导出面 | ✅ |
| TC-OVR-011 | 单例与不可重启 | L3 | 001 | 二次 `start()` 返回 `ok=false` + 可读原因且无断言崩溃 | 真机上连续调用两次 | ✅（幂等保护已实现） |
| TC-OVR-012 | 仓库无密钥/签名材料 | L1 | 007 | `git status` 干净；受版本控制的构建配置内无内联签名材料 | `git status`；`git show HEAD:build-profile.json5` | ⚠️ 工作区当前有未提交的越界（Phase 1 先修） |
| TC-OVR-013 | 宪法条款静态复审 | L1 | 全 | C1–C7 / S1–S10 逐条有结论（见 `overall-plan.md` §2） | 按宪法 §五 清单逐条问 | ⚠️ S5 违背未修（Phase 1 先修） |

### 2.2 `001-runtime-core`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-001-001 | 首次投递成功语义 | L3 | 001/002 | `start()` 返回 `ok=true`/`code=0`/`state=starting`；`message` 为「已投递启动」 | 真机调用 + `/log` 读回 | ✅ |
| TC-001-002 | 幂等拒绝 | L3 | 001 | 非 `idle` 再调 `start()` ⇒ `ok=false`/`code=-1`/`message` 含当前状态 | 连续两次调用 | ✅ |
| TC-001-003 | 启动不阻塞 UI | L4 | 001/002 | 启动期间**无** `APP_INPUT_BLOCK`/ANR；界面仍可交互（前后 `dumpLayout` 有差异） | `hdc shell hilog` + `uitest dumpLayout` 前后对比 | ✅（探针口径；库侧待复跑） |
| TC-001-004 | 状态机可见 | L3 | 001/006 | `getState()` 在投递后为 `starting`；探活成功后 `running`；失败后 `failed` 且为终态 | 真机按序打印状态 | ✅ |
| TC-001-005 | 失败态不可恢复 | L3 | 001 | `failed` 后再调 `start()` 仍为 `failed`；无任何自动重启路径 | 真机连续调用 + 观察日志 | ✅ |
| TC-001-006 | 失败原因结构化 | L3 | 001 | 失败态含 `stage` + 原始错误/信号（非只有一句话） | 检查失败态对象字段 | ✅ 已接线：`getStage()` / `getLastError()` / `lastCrash()`（`NodeRuntime.ets`）；真机判据属 006 面复跑 |
| TC-001-007 | 就绪等待接口 | L3 | 001 | 存在带超时的 `waitUntilRunning`；超时后状态为失败而非静默 | 真机设置短超时 | ✅ `waitUntilRunning(timeoutMs)` 已实现（超时/`exited` 进 `failed` 并留证据） |
| TC-001-008 | 版本下限可见告警 | L3 | 001 | 运行时版本低于下限时出现**可见**告警，不静默继续 | 用低于下限的运行时投放后启动 | ⬜ 规划未实现（Phase 1） |
| TC-001-009 | 关停钩子 | L4 | 001/003 | `shutdown()` 触发脚本侧注册的收尾钩子并等待窗口期；期间状态为 `stopping` → `stopped` | 真机调用 + 日志 | ⚠️ **状态口径已消解**：6 态已实现（`Types.ets:17-24`），`shutdown()` 进入 `stopping`；**脚本侧收尾钩子与等待窗口仍属 Phase 2** |
| TC-001-010 | `flags` 载体可表达 | L2 | 001/002 | 默认 `flags` 为 `--no-verify-heap`（真机验证值）；`--expose-internals` 仅在载荷走 internal-module stub 路线时由消费方经 `flags`/`execArgv` 显式传入；含空格的参数可被正确传递 | 单元：`split_next()` 切词边界用例 | ✅ 文档化偏差（B5/R2）：默认值不含 `--expose-internals`，理由与替代路线已写明（001 plan §3.5） |

### 2.3 `002-napi-bootstrap`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-002-001 | `dlopen` 加载运行时 | L3 | 002/005 | 日志出现 `dlopen('…') -> OK`；`node::Start` 符号解析成功（`-> 0x…` 非空） | `curl /log` 读回日志 | ✅ |
| TC-002-002 | 裸名候选顺序 | L3 | 002 | 四个候选中**裸名**命中；绝对路径候选失败**不影响**最终成功 | 日志中 4 行 `dlopen(...)` | ✅ |
| TC-002-003 | `argc` 不含 NULL 哨兵 | L3 | 002 | `node::Start` 调用后 **5 ms 内无段错误**；日志打印的 `argv[]` 行数 == `argc`，且无空行 | `curl /log` | ✅ |
| TC-002-004 | 32 MB detached 线程 | L3 | 002 | 启动线程非 UI 线程（`tid` 与 UI 不同）；进程不因线程栈不足崩溃 | 日志 `thread start; tid=` + `curl /facts` | ✅ |
| TC-002-005 | SIGSYS shim 防御有效 | L3 | 002 | 记录 `io_uring_setup(425)` 的实际返回值；若被 trap 则 shim 生效且**返回正好 -1**（不得是 `-ENOSYS`） | 日志 + 代码审查（`0xd4000001` 判据 + `regs[0] = (uint64_t)-1`） | ✅（本机返回 8 ⇒ shim 未触发，属设备差异） |
| TC-002-006 | 崩溃留结构化证据 | L3 | 002/006 | 故意触发崩溃后：日志出现 `CRASH sig=… si_addr=… pc=… lr=… sp=… r0=…` 六项齐全 **且** `last-crash.json` 出现 `{at,stage,signal,hint}` | 真机注入崩溃 + `curl /log` + 读崩溃记录文件 | ✅（C 侧写文件已实现；`--jitless` 缺失场景天然可复现 SIGTRAP） |
| TC-002-007 | 信号上下文禁用 stdio | L2 | 002 | 崩溃 handler 内**不使用** `printf`/`snprintf`/`vsnprintf`/`OH_LOG_Print`/`malloc`/`getenv`；格式化只允许无锁、无分配的纯计算 | 代码审查（handler 区间 0 命中）+ `u64_to_dec()` 单测 | ✅ 已满足（2026-10-17）：handler 用 `u64_to_dec`/`u64_to_hex` + `lb_append*` 拼栈缓冲 + **单次 `write()`**（R2 复核） |
| TC-002-008 | 原生启动失败可上报 | L3 | 001/002 | 删除/改名运行时后启动 ⇒ **能读到** `stage() == "dlopen"` 且 `lastError()` 非空；ArkTS 侧据此进入 `failed` | 真机（临时移除 `libnode.so`）+ `lastError()`/`stage()` | ✅ 已接线：`getStage()`/`getLastError()` 可读，`NodeRuntime` 在原生错误非空时置 `failed`（真机复跑属验收） |
| TC-002-009 | 载荷异常不拖垮进程 | L3 | 002/004 | 载荷内抛未捕获异常（或端口冲突）时，宿主进程**不 abort**；日志指出异常来源 | 真机注入 `EADDRINUSE` | ⚠️ C 侧不可控（这是载荷侧责任，硬约束 ⑱）：`payload/bootstrap.js` 仍只有顶层 `try/catch`，**捕获不到异步异常** ⇒ Phase 1 先修 |
| TC-002-010 | stdio 排空（无 ArkWeb 白屏） | L4 | 002/006 | 大量 stdout 输出时宿主 Web 组件**仍绘制**（前后 `dumpLayout` 有差异）；日志不混入宿主导出 | 真机压测 + 截图 | ✅ 机制已落（fd0→`/dev/null`、fd1/2→pipe + 独立 reader 线程）；⬜ 真机压测取证未做 |

### 2.4 `003-host-bridge`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-003-001 | 未注册能力报错 | L2 | 003 | `dispatch('nope', '{}')` ⇒ 精确等于 `{"ok":false,"error":"unregistered","name":"nope"}` 的**可解析 JSON** | `tools/smoke-host.mjs` | ✅ |
| TC-003-002 | 处理器抛错结构化 | L2 | 003 | 处理器 `throw` ⇒ `{"ok":false,"error":"handler-threw","name":…,"detail":…}`，**不穿透异常** | 单元 | ✅ |
| TC-003-003 | 成功形态归一 | L2 | 003 | 成功返回含 `ok:true`（当前**未约定** ⇒ 需先定契约再测） | 单元 | ⚠️ 契约缺口（Phase 2） |
| TC-003-004 | 载荷上限 | L2/L3 | 003 | 超过 `capBytes`（默认 8 MiB）⇒ 结构化 `too-large` 错误 | 构造大于上限的 JSON | ⬜ 规划未实现（Phase 2） |
| TC-003-005 | 调用超时 | L3 | 003 | 处理器不返回 ⇒ 10 s 后 Node 侧收到 `timeout`，**不永久阻塞** | 真机注册一个不返回的 handler | ⬜ 规划未实现（Phase 2） |
| TC-003-006 | 跨线程安全与队列有界 | L3 | 003 | 并发调用下无丢消息；溢出时报 `queue-full`（不静默丢弃） | 真机并发压测 | ⬜ 规划未实现（Phase 2） |
| TC-003-007 | 无 ArkTS→Node 通用入口 | L1 | 003 | 公共 API 内只有启动参数与关停两条方向 2 通道 | 审 `Index.ets` | ✅ |
| TC-003-008 | 选择器只回传路径 | L3 | 003 | 选择器类能力的返回值**不含文件内容**，只含沙箱内路径 | 真机调用 + 检查载荷大小 | ⬜ 规划未实现（Phase 2） |
| TC-003-009 | Node 侧 builtin 可 require | L3 | 003/004 | `require('@fellow99/node-bridge/host')` 成功且 `invoke` 可用 | 自检脚本扩展 | ⬜ 规划未实现（Phase 2） |

### 2.5 `004-payload-bootstrap`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-004-001 | 只读直读零解压 | L3 | 004 | 载荷放只读安装位置即可 `require` 成功；**无解压动作**（无 marker 生成） | 真机 + 只读路径 | ⬜ 规划未实现（Phase 1） |
| TC-004-002 | Node 自解包后读回 | L3 | 004 | 解包出的文件能被 **Node 读回**（不是只 `stat`）；用 ArkTS 侧解压器写出的文件 Node 读不到（反证） | 真机：解包 → `readFileSync` 比对摘要 | ⬜ 规划未实现（Phase 1） |
| TC-004-003 | 幂等 marker | L3 | 004 | 二次启动跳过解包；marker 命中可在日志中看到；耗时显著下降 | 真机二次启动 + 计时 | ⬜ 规划未实现（Phase 1） |
| TC-004-004 | CJS 入口解析 | L2 | 004 | CJS 入口可被 `require` 成功 | 单元 | ⬜ 规划未实现（Phase 1） |
| TC-004-005 | ESM 入口解析 | L2 | 004 | ESM 入口在 `require` 失败后回退到 `import(pathToFileURL(...))` 并成功 | 单元 | ⬜ 规划未实现（Phase 1） |
| TC-004-006 | 绝对路径不依赖 cwd | L3 | 004 | 在真机（`cwd == '/'`）下入口仍被正确定位；`process.chdir` 后行为可预期 | 真机 + `/facts` 内的 `homedir`/`tmpdir` | ⚠️ 当前无 `cwd` 选项（Phase 1） |
| TC-004-007 | 宿主环境不污染 | L3 | 004/001 | `NODE_OPTIONS` 为空；`HOME`/`TMPDIR` 在沙箱内；`LD_LIBRARY_PATH` 未被修改 | `/facts` + `process.env` 快照 | ✅（部分：`/facts` 未输出这些键 ⇒ 需扩展自检） |
| TC-004-008 | 应用语义变量透传 | L3 | 004/001 | 消费方经 `env` 传入的变量在 Node 内可见；库不认识其语义 | `/facts` 增加 env 白名单回显 | ⬜ 规划未实现（Phase 1） |

### 2.6 `005-provision-verify`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-005-001 | 门禁① `ET_DYN` | L1 | 005 | `e_type == 3` | `provision.mjs --check` / `elf-inspect.py` | ✅ |
| TC-005-002 | 门禁② `PT_INTERP == 0` | L1 | 005 | 计数为 `0`；构造一个带解释器段的产物必须 **FAIL** | 同上 + 负例（拿 PIE 产物跑） | ✅ |
| TC-005-003 | 门禁③ `AArch64` | L1 | 005 | `e_machine == 0xB7` | 同上 | ✅ |
| TC-005-004 | 门禁④ `DT_NEEDED` 含 libc++ | L1 | 005 | 依赖列表含 `libc++_shared.so` | 同上 | ✅ |
| TC-005-005 | 门禁⑤ `node::Start` 已导出 | L1 | 005 | `.dynsym` 中定义且导出 `_ZN4node5StartEiPPc`（`shndx != 0`） | 同上 | ✅ |
| TC-005-006 | 门禁⑥ SHA-256 一致 | L1 | 005 | 实测摘要 == 锁值 | `sha256sum` 对比 `runtime.lock.json` | ✅ |
| TC-005-007 | 门禁⑦ 大小 + 版本串 | L1 | 005 | 大小 == 锁值 **且** 产物内含 `v24.2.0` 字符串 | 同上 | ✅ |
| TC-005-008 | `libc++_shared.so` 一并投放 | L1 | 005 | 目标目录同时出现两个 `.so`；缺 SDK 时报错并给出处置（`--sdk` / 环境变量） | `provision.mjs --out <dir>`（清空 `DEVECO_SDK_HOME` 做负例） | ✅ |
| TC-005-009 | 来源优先级 | L1 | 005 | 本地目录 → `--from` → `--download`；任一失败自动尝试下一个；全失败时报错并打印代理开关提示 | 断网/无本地产物场景 | ✅（附录 G.3） |
| TC-005-010 | `--check` 不产生副作用 | L1 | 005 | `--check` 后目标目录不变（无文件被写） | 前后 `ls -l` 对比 | ✅ |
| TC-005-011 | 自签往返一致 | L1 | 005 | `add-section` + `sign` + `verify` 十项全过；`selftest` 输出 IDENTICAL | `node tools/ohos-selfsign.mjs …` | ✅（对上游 `wxjit.so` 已验证） |
| TC-005-012 | 自签中间产物不落 HAP | L1 | 005 | `--sign` 后 `libs/<abi>/` 内**只多出**目标 `.so`（中间产物在系统临时目录） | `--sign` 后 `ls libs/<abi>/` | ✅ |
| TC-005-013 | 签名不是加载前提 | L3 | 005 | 无 `.codesign` 的锁定产物真机 `dlopen` 成功；`hilog` 中 `xpm`/`unsigned file` 0 命中 | 真机 + `hdc shell hilog -x \| grep -icE "xpm\|unsigned file"` | ✅（规划 §D.6/§D.9） |
| TC-005-014 | 换版本复验流程 | L1/L3 | 005 | 改锁文件后 `--check` + 真机 `/facts` 双跑；`verifiedOn`/`verifiedDevice` 回写 | 变更流程演练 | ⬜（流程已定，演练待 Phase 3） |

### 2.7 `006-observability`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-006-001 | `/facts` 端到端证书 | L3 | 006/005 | HTTP 200 且 JSON 内 `checks.node`/`platform`/`arch` 与锁定值一致 | `hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts` | ✅ |
| TC-006-002 | `/log` 读回 | L3 | 006 | 返回文本含启动行与 `thread start`；长度 ≤ 8192 字符 | `curl -s http://127.0.0.1:15577/log` | ✅ |
| TC-006-003 | ArkTS 日志读回 | L3 | 006 | `Logger.tail(path, n)` 读到文件尾 n 字节；路径不存在时返回 `(read log failed: …)` **不抛异常** | 真机 + 单元 | ✅ |
| TC-006-004 | 双通道一致 | L3 | 006 | 同一条启动信息在 hilog 与文件日志都能查到 | `hilog -x` + `curl /log` | ✅（C 侧）；⚠️ ArkTS 侧 `Logger.info` 不落盘（部分符合 S9） |
| TC-006-005 | 日志环容量 | L2 | 006 | `logs()` 返回条数 ≤ `logRingSize`（默认 500）；超出后最旧被丢弃 | 单元 | ⬜ 规划未实现（Phase 1） |
| TC-006-006 | 崩溃记录可读 | L3 | 006 | 崩溃后**下一次启动** `lastCrash()` 返回结构化对象（含 `at`/`stage`/`signal`/`logTail`） | 真机注入崩溃 → 重启 → 读取 | ⚠️ **一半**：C 侧已写 `<HOME>/node-bridge/last-crash.json`（`{at,stage,signal,hint}`）✅；ArkTS `lastCrash()` ⬜（Phase 1） |
| TC-006-007 | 状态回调 | L3 | 006/001 | 状态变化触发 `onStateChange(state, detail?)`，失败时带详情 | 真机观察回调 | ⬜ 规划未实现（Phase 1） |
| TC-006-008 | 调试通道门禁 | L3 | 006/007 | debug 构建可连 `hdc fport tcp:9229` + DevTools；release 构建**无**该开关 | 两种构建各跑一次 | ⬜ 规划未实现（Phase 1） |
| TC-006-009 | 首启代价可观测 | L3 | 006/004 | 日志/`/facts` 内可读出「解包耗时 / 幂等命中」 | `/facts` 扩展 + 日志 | ⬜ 规划未实现（Phase 1） |
| TC-006-010 | 无禁止判据被使用 | L1 | 全 | 评审检查：无「hilog 没有该行 ⇒ 未执行」「`VmSize` 大 ⇒ V8 起来」「点击看起来生效 ⇒ 生效」三类判据 | 用例与证据走查（§4） | ⚠️ 需在每次评审执行 |

### 2.8 `007-distribution`

| 用例族 ID | 名称 | 层 | 覆盖的模块 | 判据（可证伪） | 证据/命令 | 状态 |
|---|---|---|---|---|---|---|
| TC-007-001 | HAR 可构建 | L1 | 007 | `assembleHar` 成功且产物存在（当前 441,353 B） | `hvigorw --mode module -p module=library@default assembleHar --no-daemon` | ✅ |
| TC-007-002 | HAR 内容合规 | L1 | 007 | HAR 内含引导件 `.so`、**不含** `libnode.so`；内容与 §6.1 决策一致 | HAR 条目清单核对 | ⚠️ 实测 HAR 含 `libc++_shared.so` 且缺 `payload/`+锁文件（决策待定） |
| TC-007-003 | 消费方三步接入 | L4 | 007/005 | 依赖解析成功 → 投放后 SHA-256 == 锁值 → ACL 生效后 `/facts` 报 `wasm.validate=true` | 消费方构建 + 真机 | ✅（第 3 步已由消费方达成，规划 §D.10） |
| TC-007-004 | 权限面最小 | L1 | 007 | 库 `module.json5` 只声明自己需要的开放权限；受限 ACL 由消费方按自己包名申报 | 审 `module.json5` + 消费方清单 | ✅ |
| TC-007-005 | 版本矩阵文档 | L1 | 007 | 存在 `node-bridge 版本 × libnode 版本 × API × deviceTypes` 矩阵 | README + `runtime.lock.json` | ✅ |
| TC-007-006 | 无浏览器内核 | L1 | 007 | 包内文件清单不含 Chromium/浏览器内核（G3） | 包内清单核对 | ✅ |
| TC-007-007 | 合规红线复核 | L1 | 007 | G3/G4/G5/G11 逐条有结论与证据 | 按 `overall-plan.md` §3.5 走查 | ⚠️ G4 缺口 |

---

## 3. 真机取证：四条通道与判定命令

> 口径依据：规划 §2.3（四条通道 + 三个假信号）、§5.7、附录 A。**缺一不可**。

| # | 通道 | 判定命令（可直接粘贴） | 判定标准 | 现状 |
|---|---|---|---|---|
| ① | **端到端证书**（`hdc fport` + `curl`） | `hdc fport tcp:15577 tcp:15577` → `curl -s http://127.0.0.1:15577/facts \| python -m json.tool` | HTTP 200；`checks.node/platform/arch` 与锁定值一致；`wasm.validate` 符合预期 | ✅ 已实现 |
| ② | **日志回传**（`hdc rport` + 端上 POST） | `hdc rport tcp:<hostPort> tcp:<devPort>` + 载荷侧把日志 POST 到该端口；或直接 `curl -s http://127.0.0.1:15577/log` | 取回日志尾部，且**观测点在应用域**（不试图用 `hdc` 读沙箱文件——`permission denied`） | ⚠️ 库侧用 `/log` 代替；`rport` 通道 ⬜ |
| ③ | **UI 截图**（`snapshot_display`） | `hdc shell snapshot_display -f /data/local/tmp/s.png` → `hdc file recv /data/local/tmp/s.png .` | 截图内可见**可截图文字**（状态/阶段文案），不是白屏 | ⬜ 库侧不产 UI；由消费方/探针执行 |
| ④ | **点按 + 布局差异**（`uitest uiInput`） | `hdc shell uitest uiInput click <x> <y>`；点按**前后各** `hdc shell uitest dumpLayout` 并 diff | 两次 `dumpLayout` **有差异**才算生效（⚠️ 本机实测 `dumpLayout` 可能拿不到结果 ⇒ 退回 `/log` 或 `/facts` 判据） | ⚠️ 设备差异已登记 |
| 附 | **hilog** | `hdc shell hilog -x \| grep -E "node-bridge\|Cpp Crash"` | **只用于定位原因，不作为「是否执行」的判据**（见 §4） | ✅ |
| 附 | **端口占用预防** | 测谁就 `force-stop` 另一个应用（探针与消费方会争同一端口） | 端口冲突会导致**整个 App 进程 abort**（硬约束 ⑰） | ✅ 已登记 |

---

## 4. **禁止的判据**（写进每条用例的验收纪律）

| 禁止的判据 | 为什么是假信号 | 必须改用的判据 |
|---|---|---|
| **hilog 里没有那一行 ⇒ 没执行** | 应用侧 INFO 常不进 hilog dump 缓冲（症状 #17） | 用应用内 `/facts`、`/log`、界面文案（功能性事实） |
| **`VmSize` 很大 ⇒ V8 起来了** | ArkTS/ArkWeb 自占约 40 GB 虚拟地址空间（症状 #18） | 用 `/facts` 的版本/平台输出，或端上端口探活 |
| **点击「看起来生效」⇒ 生效** | 目视不可证伪 | 点按前后两次 `dumpLayout` 的**差异**（无差异即未生效） |
| **`dlopen` 返回非空 ⇒ 加载成功** | 缺 `libc++_shared.so` 时 ArkTS 侧只拿到 `undefined`（硬约束 ②） | 日志里的 `dlopen(...) -> OK` **加上** `dlsym(node::Start) -> 0x…` 两行齐备 |
| **`statSync` 成功 ⇒ 文件可用** | 平台侧解压器写出的文件 Node 读不到（硬约束 ④） | **Node 自己读回**并比对内容/摘要（谁写谁读） |
| **`--check` 通过 ⇒ 真机可用** | 门禁只覆盖 ELF 属性，不覆盖 W^X/ACL/端口 | 真机 `/facts` 一次（A1 判据） |
| **没有崩溃日志 ⇒ 没崩** | detached 线程崩溃后进程可能仍活着；系统 `Cpp Crash` 与自身日志是两套 | `hilog` 的 `Cpp Crash` **与** `node.log` 的 `CRASH sig=…` 双向核对 |

---

## 5. 已知真机基线数值（用于回归比对）

> 设备：**HAD-W24 / 7.0.0.107(SP7C00E100R13P5) / API 26 / OpenHarmony-7.0.0.105 / arm64-v8a**；运行时：**Node v24.2.0**（锁定产物 `3019bf5f…51a1`）。出处：规划 §D.8 / §D.9 / §D.10（✅ 实测）。

| 指标 | 路线 I（`--jitless`） | 路线 J（有 ACL） | 备注 |
|---|---|---|---|
| `checks.node` | `v24.2.0` | `v24.2.0` | 必须等于 `runtime.lock.json` 的 `active.node` |
| `checks.platform` / `arch` | `openharmony` / `arm64` | 同 | 平台事实 |
| `checks.versions.modules` | `137` | `137` | = `NODE_MODULE_VERSION` = SONAME 尾号 |
| `wasm.validate` | **`false`**（`WebAssembly is not defined`） | **`true`** | 路线分叉的**唯一判据** |
| `hotloop_ms_5rounds` | **≈ 299 ms / 5 轮**（另一口径 ≈59 ms / 2e6） | **6–9 ms / 2e6** | 约 7–10× 差距；另口径 ≈9× |
| `fetch` | 失败（`TypeError: fetch failed`） | 可用 | 路线 I 必须改造载荷 |
| 无 ACL + 不带 `--jitless` | — | **启动即 SIGTRAP(sig=5) + `Cpp Crash`** | 刚性前置的证据 |
| `fs_write_readback` | `OK` | `OK` | 谁写谁读 |
| `worker_threads` | 可用（`Worker` 存在） | 同 | O3 深测 ⬜ |
| `os.networkInterfaces()` | `lo, wlan0, ancowlan0` | 同 | loopback 存在 |
| `spawn('/system/bin/sh')` | `data`/`exit`/`close` 三事件齐全、无僵尸 | 同 | 推翻旧壳 R14 |
| `-e internals`（`--expose-internals`） | `require('internal/modules/cjs/loader')` **OK** | 同 | 硬约束 ⑤ |
| `execArgv` | `['--jitless','--no-verify-heap']` 类 | `['--no-verify-heap']` | **不回显 `--expose-internals` 时需确认默认值**（见 TC-001-010） |
| `dlopen` 命中路径 | **裸名** `libnode.so` | 同 | 绝对路径全失败 |
| `io_uring_setup(425)` | 返回 **8**（无 seccomp trap） | 同 | 与 notes 设备不同 |
| `os.cpus().length` | `0` | 同 | 不得用做并发探测 |
| 已签名 HAP | — | SHA-256 `8d5a53fabd012302cdf341180e57f11635dea06535fc3cbf5ba890cb153d7c16`（129,311,411 B） | 探针工程；L5 基线锚点 |
| 日志污染 | `/log` 返回的 16 KB 几乎全是 `arkweb/chromium_ext/…` | 同 | ⑱ 的实测依据 |

**基线使用方式**：L3/L4 每次跑完把 `/facts` 的 JSON 存成快照，与本节逐项 diff；**任何一项变化都必须给出版本/配置层面的解释**，否则视为回归。
