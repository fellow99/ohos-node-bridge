# 002 — DSHM 对照分析与可借鉴点（库侧：运行时 · 原生闭包 · 传输）

> **对象**：`D:\GitHub\ohos\dshm`（DeepSeek Harness 的 HarmonyOS 移植），工作树 HEAD `1cb0db6`（2026-10-08）。
> **本文件的边界**：**只讲本库（`ohos-node-bridge`）相关的部分** —— libnode 的加载与符号可见性、NAPI 注册、原生 addon 的链接闭包、`node::Start` 的生命周期、Node↔ArkTS 的**传输层**。
> **应用侧**（载荷路线、就绪判据、工作区、门禁、观测性、jitless 代价）见
> [`../../pi-desktop-ark/docs/002-DSHM对照分析与可借鉴点.md`](../../pi-desktop-ark/docs/002-DSHM对照分析与可借鉴点.md)。
> **性质**：只读分析 + 本库落地结论。未修改 dshm 任何文件。
> **日期**：2026-10-17。

---

## 0. 结论摘要（库侧八条）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **`libnode.so` 导出 145 个 `napi_*`**（含 `napi_create_function` / `napi_fatal_error`）——"Node 在共享库形态下不导出 NAPI"这个假设**是错的** | ✅ 实测：`llvm-nm -D --defined-only entry/libs/arm64-v8a/libnode.so` |
| 2 | 因此专用 addon 的 `napi_create_function: symbol not found` **不是库缺符号**，而是 **addon 自己的 `DT_NEEDED` 闭包里没有 libnode**（本库那份 addon 的 `NEEDED` 只有 `libc.so`、6 个 `napi_*` 留未定义） | ✅ 实测：`llvm-readelf -d` + `llvm-nm -D --undefined-only` |
| 3 | 这与 dshm 记录的 **E43** 同型（它的 `libkoffi.so` 需要 84 个 `napi_*`、同样只 `NEEDED` libc，加载器只报**序号最小**的那个失败者） | 🔶 沿用（dshm `CMakeLists.txt` / `dshhost.cc` 注释） |
| 4 | **主桥 `.so` 不能当 Node addon 用**：它已被 ArkTS `import` 进 **libace_napi**，Node 再 `require` 得到 `Module did not self-register`；强行导出 `napi_register_module_v1` 后**整个应用进程静默消失**（两套 NAPI 实现的 ABI 不兼容） | ✅ 实测（本库 1fbf26a 之前的真机轮次，已回退） |
| 5 | **`libnode` 不能进引导层的 `DT_NEEDED`，必须构造器里 `dlopen(RTLD_NOW\|RTLD_GLOBAL)`** —— 否则加载器会以局部作用域先载入，事后提升在 musl 上无效 | 🔶 沿用（dshm `dshhost.cc:82-86`）；本库 `node_bridge.c:998-1018` 同款 |
| 6 | **原生库文件名必须等于 SONAME**：本库文件的 SONAME 是 `libnode.so.137`、文件名却是 `libnode.so`，一旦写进 `DT_NEEDED` 加载器会按 `libnode.so.137` 找 | ✅ 实测 `llvm-readelf -d`；🔶 dshm 的 `check-native-closure.mjs` 把这条做成门禁 |
| 7 | **Node↔ArkTS 传输改用文件信箱**（照 dshm 的 `HmsSpeechBridge`），真机往返 **2 ms**、失败路径 **1 ms**、零残留 | ✅ 实测（`app.log` / `heartbeat.log`，见 §5） |
| 8 | **不要照抄** dshm 的自建 Node 交叉编译链（20+ 脚本 / 4 份上游源码补丁 / 30~90 分钟 / WSL2）——本库直接用既有 `libnode.so` | §6 |

---

## 1. 证据口径

| 标记 | 含义 | 本文用法 |
|---|---|---|
| ✅实测 | 本机或真机跑命令读出来的字节/符号表/日志读数 | `llvm-nm`、`llvm-readelf`、`app.log`、`heartbeat.log` |
| 🔶沿用 | 读 dshm 源码/文档并采信，**未在设备上复验** | 大多数平台结论 |
| ⬜待验证 | 本文提出但未跑过 | §4.3 的原生闭包修复 |
| ⚠️受限 | 想验但验不了 | 无法与 dshm 的 `libnode.so.137` 逐字节比对（它不入库） |

---

## 2. 两个引导层的形状对照

| 维度 | `ohos-node-bridge` | dshm `libdshhost` |
|---|---|---|
| 谁加载引导层 | ArkTS `import nodeBridge from 'libnode_bridge.so'` | ArkTS `import dshhost from 'libdshhost.so'` |
| 谁加载 libnode | 原生 `dlopen`（候选链，末位裸名）+ `dlsym` | 构造器里 `dladdr` 求自身目录 → `dlopen(<dir>/libnode.so.137, RTLD_GLOBAL)` |
| `node::Start` 取法 | `dlsym("_ZN4node5StartEiPPc")` | **同款**（mangled 名） |
| libnode 在 `DT_NEEDED` 里 | ❌ | ❌（注释明写为什么不能） |
| 环境变量通道 | 第 6 个 `envPairs` 参数（`KEY=VALUE`） | `startHost(argv, envPairs)`，同款 |
| 线程模型 | detached 线程（32 MB 栈） | `std::thread` + `detach`（`node::Start` 永不返回） |
| 生产传输 | **文件信箱**（§5） | 不做 RPC：单向文件信号 + 一个能力桥 |
| 停止 | 不假装（`stopHost` 语义） | `stopHost()` 恒 `ok:false`，真停走协作式 |

> 一句话：**两者在"libnode 怎么进进程"上撞到了同一套结论**，差别只在"上层怎么说话"。

---

## 3. libnode：完整链条与九个可借鉴点

### 3.1 加载链

```
ArkTS  import nodeBridge from 'libnode_bridge.so'
  └─ 构造器：dlopen(libnode.so, RTLD_NOW|RTLD_GLOBAL) → dlsym("_ZN4node5StartEiPPc")
             napi_module_register(...)                 ← 见 §3.5
  └─ ArkTS 调 bridge.start(argv, envPairs)
       → setenv(每条 KEY=VALUE)                        ← ArkTS 无法设原生环境变量
       → detached 线程执行 node::Start(argc, argv)      ← 阻塞、不返回
```

### 3.2 为什么 libnode **不能**进 `DT_NEEDED`（`dshhost.cc:82-86`）

> 一旦带了，动态加载器会以**局部作用域**先载入 libnode；之后再 `dlopen(RTLD_GLOBAL)` 提升在 musl 上**无效**（实测：返回 ok 但符号依然解析不到）。

代价写得很清楚：**链接期不再校验 libnode**（有意的取舍）。本库 `node_bridge.c:1011` 的注释同款，候选链见 `:998-1018`。

### 3.3 头文件最小化：只 `#include <node_version.h>`

`dshhost.cc:26-32` 实测：

> `node.h` 会拉进 v8 全套头文件；Node 26.x 的 `v8.h` 依赖 C++20 的 `<source_location>`，而 OHOS SDK 的 libc++ 不提供它 ⇒ `fatal error: 'source_location' file not found`。

⇒ 只用 dlsym 取 mangled 名，不引用任何 `node::`/`v8::` 类型。
**可借鉴**：只需要 `node::Start` 一个入口时，不必拉全套 Node 头文件，也就不会被 SDK 的 libc++ 版本卡住。

### 3.4 编译口径必须与 libnode 一致

`-fno-emulated-tls -D__MUSL__`（dshm `CMakeLists.txt`）：**TLS 模型不一致时与 libnode 的交互会出现难以定位的问题**。
**待办（本库）**：addon 的编译选项应与 libnode 同口径，目前未显式设置。

### 3.5 NAPI 注册要"四种名字全注册"

`dshhost.cc:386-448`：`dshhost` / `libdshhost.so` / `libdshhost` / `dshhost.so` 各注册一次。
理由是真机症状 —— **`.so` 加载成功、`import` 不报错、导出全是 `undefined`**，而"查错名字不会报错，只会返回一个别的模块"（它实测拿到的是 ArkUI 的节点模块）。

配套两条：
- `nm_filename` **必须非空**（传 `__FILE__`；传 `nullptr` 时构造器跑了、`napi_module_register` 返回了，但 `Init` **从未被调用**）；
- 构造器里打一条 hiLog，用一个二分把"没加载"与"没映射"分开。
- ⚠️ 本库已知陷阱：`napi_default` 不可枚举 ⇒ JS 侧 `Object.keys()` 看不到；要么用 `napi_set_named_property`，要么给 `writable|enumerable|configurable`。

### 3.6 ⭐ addon 的符号闭包：必须 `DT_NEEDED libnode`（E43）

dshm `CMakeLists.txt` 原文：

> `koffi` 的 `napi_*`/`uv_*` 必须靠 `DT_NEEDED` 放进它自己的依赖闭包（**E43：libnode 即便 RTLD_GLOBAL 首载也不进它的可见集**）。

现象形如：

```
Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
```

> `libkoffi.so` 需要 84 个 `napi_*`，**只有这一个**解析不到 ⇒ 加载器只报**序号最小**的那个失败者。

本库**同型实测**（2026-10-17）：

```
$ llvm-readelf -d …/libnode_host_client.so | grep NEEDED
  (NEEDED)  Shared library: [libc.so]              ← 只有 libc
$ llvm-nm -D --undefined-only …/libnode_host_client.so | grep -c " napi_"
6                                                   ← 6 个 napi_* 全靠运行期解析
⇒ Error relocating …/libnode_host_client.so: napi_create_function: symbol not found
```

### 3.7 ⭐ SONAME == 文件名

`check-native-closure.mjs` 的两条不变式：

1. **SONAME 必须等于文件名。** 加载器用 `DT_NEEDED` 条目去匹配候选的 **SONAME**，不是文件名。改名而不改 SONAME ⇒ 设备上 `cannot open shared object`。
2. **每个 `DT_NEEDED` 都必须解析**到「同目录我们发的」或「系统提供」的库；漏一个，表现是一条无信息的 dlopen 失败。

两条都不能被"构建成功"发现 ⇒ dshm 做成构建期静态门禁（带显式 `SYSTEM_LIBS` 白名单；"unknown ⇒ ok" 会让检查失去意义）。
它另有 `tools/patch-native-needed.mjs` 专门改写 `DT_NEEDED` 字符串。

**本库待办**：我们没有这条门禁。⚠️ 本库的 `libnode.so` **SONAME = `libnode.so.137`**，文件名却是 `libnode.so`（✅ `llvm-readelf -d` 实测）⇒ 一旦把它写进 `DT_NEEDED`，加载器会去找 `libnode.so.137`。两条出路见 §4.3。

### 3.8 手工拷预编译 `.so` 进 `libs/` **不会**建立 ArkTS↔原生绑定

dshm 的并列对照（E30）：

```
DSHM-PROBE  cmake 构建的原生模块可绑定，返回值=dshm-probe-ok   ← 走 hvigor CMake
DSHM-RUNTIME runtimeVersion is undefined                       ← 手工拷进 entry/libs/
```

> 运行时会 dlopen 它、构造器会执行，但 `napi_module_register` 注册的模块**永远不会被实例化**（`Init` 不被调用）。

⇒ 引导层必须由 hvigor 自己编译链接。本库符合（`library/src/main/cpp/CMakeLists.txt`）。

### 3.9 诊断三件套（便宜，都该抄）

1. **探针 + 符号提供者定位**：dshm 自己提供 `napi_fatal_error` 的定义，并用 `dlsym(RTLD_DEFAULT, …)` + `dladdr` 打三条读数（谁提供了 `napi_fatal_error` / 谁提供了 `napi_get_undefined` / 自己 `dlopen(libkoffi.so)` 的结果）。**一条日志把"符号从哪来"钉死**。
2. **stdout 抓文件 + tail 线程转 hiLog**：`freopen(log,"w",stdout)` + `dup2` 到 2，再开一个 300 ms 的 tail 线程把增量转 hiLog。理由：应用进程 stdout 在设备上**看不见**，而 `node::Start` 返回时的失败原因全在 stdout/stderr 上。
3. **`g_started` 必须在 Node 线程退出时复位**（E119）：否则"换核心/重启"会被"运行时已经启动过"**永久**拒掉 —— 守卫置真后从未复位。

### 3.10 停止：如实返回"做不到"，再走协作式

`stopHost()` 恒 `ok:false` + 一句人话（"需在 Node 线程内用 uv_async + node::Stop"）。**不假装成功**（"那比报错更糟"）。
真停路径：ArkTS 写 `host-stop-request` → Node 每 1.5 s 巡检 → 自己 shutdown 退出 → `node::Start` 返回 → `isHostRunning()` 变假。实测 +1536 ms、退出码 0。

> 本库的处理同源（C5：没有进程内重启；`shutdown()` 只标记状态）。

---

## 4. ⭐ addon 路线：归因更正与修法

### 4.1 实测读数

见 §3.6 / §3.7 的两组读数。**结论**：专用 addon 路线**没有被证伪** —— 缺的是链接闭包，不是符号。

### 4.2 归因更正（把旧结论改掉）

| 旧结论 | 更正后 | 依据 |
|---|---|---|
| 「`napi_*` 在 `libnode.so` 里但**不在动态符号表**」 | **错**。145 个 `napi_*` 全在（`T`，全局已定义） | ✅ `-D --defined-only` |
| 「专用 addon 失败：符号不可见」 | 现象成立，**归因是闭包缺失**（`NEEDED` 只有 libc） | ✅ `-d` / `-u` 读数 |
| 「两套 NAPI 实现 ABI 不兼容」 | **仍然成立，但只对主桥**：主桥 `DT_NEEDED` 含 `libace_napi.z.so`，Node 调进来时 `napi_*` 绑到 libace_napi 的实现、收到的却是 Node 的 env ⇒ 崩 | ✅ 链接行 + 推理 |

⇒ **主桥该失败（混链），专用 addon 不该失败（纯链 libnode，只是我们没链）。**

### 4.3 修法清单（⬜ 待验证，成本 ≈ 一次构建 + 一次装机）

1. addon **只链 libnode、绝不链 `libace_napi`**（当前已满足）。
2. **把 libnode 写进链接行**，去掉 `-Wl,-z,undefs`：
   ```cmake
   target_link_libraries(node_host_client PRIVATE ${LIBNODE})
   target_compile_options(node_host_client PRIVATE -fno-emulated-tls -D__MUSL__)
   ```
   链接后：`readelf -d` 必须出现 `NEEDED [libnode.so.137]`；`nm -D --undefined-only` 的 `napi_*` 计数必须变成 **0**。
3. **处理 SONAME 与文件名的错位**（二选一，都要先在设备上确认 HAP 里那份叫什么）：
   - **A** 随包文件命名成 **`libnode.so.137`**（= SONAME）。dshm 就是这样；但 hvigor 是否打非 `*.so` 结尾的文件**必须实测**（它的门禁注释说只打 `*.so`，两者有张力）。
   - **B** 把 addon 的 `DT_NEEDED` 字符串改成 `libnode.so`（dshm 有现成工具 `patch-native-needed.mjs` 干这类改写）。
4. **加载方式**：Node 侧 `process.dlopen(module, path)`（与 dshm 的 `libpython_runner.so` 完全一致），**不要**指望 `require('libnode_bridge.so')`。
5. **桥接**：addon 内 `callHost()` 用 `dlopen("libnode_bridge.so")`（已被 ArkTS 加载，返回既有句柄）+ `dlsym("pi_host_call")`（本库已给它 `visibility("default")`）。dshm 的 `python_runner` 正是「NAPI addon + dlopen 第三方 .so + dlsym 它的 API」这个形态。
6. **补一条门禁**：`SONAME==文件名` + `DT_NEEDED` 全可解析 + 本库特有的一条（**addon 必须 NEEDED libnode、不得 NEEDED libace_napi**）。

> **优先级说明**：这条是**可选优化**，不是阻塞项 —— §5 的文件信箱已满足当前全部需求（用户显式动作、延迟不可感知）。只有当出现**高频**宿主调用（每秒多次）时才值得做。

---

## 5. Node ↔ ArkTS 传输：文件信箱（本库已落地）

### 5.1 为什么换路

原生两条路都实测不通（§4.2）。而 dshm 有**同型活样本**：`HmsSpeechBridge`（771 行，真机上线）把「只有 ArkTS 能做」的能力（HMS 语音识别）交给宿主，并明写：

> 原生层（`dshhost.cc`）只暴露 `startHost/isHostRunning/stopHost`，**没有消息通道**。所以用**文件队列**当桥 —— 项目既成手法：**可观察、失败留痕、无需改原生层**。两侧同 UID、同文件系统视图。

### 5.2 协议（两侧逐字对应）

```
Node 写 <dir>/<id>.tmp → rename → <id>.req        // 先写临时名再改名 ⇒ 读方要么看不到、要么看到完整的
ArkTS 每 100 ms：listFileSync
  ├─ 挑 .req 里字典序最小者（13 位时间戳 + 4 位序号 ⇒ 名字序 == 时间序）
  ├─ 完整性判据：length===0 或 !endsWith('}') ⇒ 等下一轮
  ├─ renameSync(.req → .wip)                      // 「取走即改名」：防重复处理 + 处理中可观察
  ├─ dispatch()（串行，一次一单）
  └─ 写 <id>.tmp → renameSync → <id>.done | <id>.fail
Node 每 100 ms 看 .done/.fail → 读完即清掉五件套
```

实现位置：`library/src/main/ets/bridge/HostBridge.ets`（`startMailbox` / `stopMailbox` / `mailboxStats`）、`payload/host.js`（`useFileMailbox` / `invokeViaMailbox`）。

### 5.3 五条"付过学费"的细节（dshm 的 + 本库补的）

1. **`.req` 也必须进陈旧回收**（dshm 标为"审核时发现的一个真缺陷"）。只清 `.wip/.done/.fail` 时，一个半截 `.req` 会让队首永远返回它 ⇒ **整条队列永久堵死**，用户表现是"按钮再也不动"。本库阈值 10 分钟。
2. **在飞 `.wip` 必须豁免回收**（本库补）。`fs.pickFolder` 的耗时由用户决定（可能几分钟），只按 mtime 判会误删正在处理的请求；把在飞那一个排除，就不必为"不误删"而把阈值调得很大（阈值越大，真卡死自愈越慢）。
3. **心跳要与"有没有请求"分开，且成功也要写一行**。否则事后无法区分「处理成功」与「请求根本没被处理」—— 两者都停在最后一条 `got`/`alive` 上。本库 64 KB 轮转。
4. **超时必须随业务时长伸缩**。dshm 原实现固定 25 s，而 ArkTS 侧按实时节奏送音频 ⇒ 录 25 s 以上**必然**先超时（"这是必然发生的，不是概率问题"）。本库：默认 15 s，**逐次可放宽**（`invoke(name, args, { timeoutMs })`）。
5. **失败要如实回 `.fail` 并让调用方按码分派**。本库额外把 `dispatch()` 的结构化失败**拆包**成 `.fail` 顶层 `error`（否则调用方拿到永远是 `host-dispatch-failed`，真正的 `unregistered` / `payload-too-large` 只能从 detail 里正则抠），原始串留在 `dispatch` 字段。

### 5.4 本库真机读数（2026-10-17）

```
got  id=req-…-0001 name=runtime.facts            → done ok=true  resultBytes=995   （2 ms）
got  id=req-…-0002 name=__probe.definitely-…     → done ok=false resultBytes=80    （1 ms）
信箱目录：只剩 heartbeat.log（零残留）；force-stop 后二次冷启两条探针全部复现
```

---

## 6. 不建议照抄（库视角）

| 项 | 为什么 | 我们的现状 |
|---|---|---|
| **自建 Node 交叉编译**（`tools/node-runtime/` 20+ 脚本、4 份上游源码补丁、30~90 分钟、WSL2 环境） | 我们直接用既有 `libnode.so`（126,809,264 B）且已验证可跑；自建只在"要换 Node 版本/加编译选项"时值得 | ✅ |
| **`libnode` 写进引导层 `DT_NEEDED`** | 见 §3.2（会让 addon 解析不到 `napi_*`） | ✅ 已避免 |
| **把主桥 `.so` 当 Node addon** | 见 §4.2（混链 ⇒ 进程静默消失） | ✅ 已回退并有长注释 |

---

## 7. 未验证 / 风险

1. ⚠️ **无法与 dshm 的 `libnode.so.137` 逐字节比对**：它的 `entry/libs/**` 被 `.gitignore`，本机不存在。只能确认尺寸量级一致（它记 120.93 MiB，本库 126,809,264 B）。
2. ⬜ **§4.3 的闭包修复未跑**（SONAME 对齐 / `DT_NEEDED` 注入 / `-z undefs` 移除）。
3. ⬜ **`libnode.so.137` vs `libnode.so` 的 hvigor 打包行为未实测**。
4. ⬜ **信箱在"高频调用"下的成本未测**（当前只有启动期两条探针 + 后续用户动作）。
5. 🔶 dshm 自己登记了四处"文档与实物不一致"（如注释写 Node 26.7.0、实为 24.2.0）⇒ 引用它的结论时 **代码 > 注释 > 文档**。

---

## 8. 行动项（库侧）

| # | 行动 | 成本 | 依赖 | 优先级 |
|---|---|---|---|---|
| **L1** | 补"原生库闭包"门禁：`SONAME==文件名` + `DT_NEEDED` 全可解析 + addon 必须 NEEDED libnode/不得 NEEDED libace_napi | 中 | — | 中 |
| **L2** | 原生 addon 闭包修复（§4.3 六步）；**先做 `readelf`/`nm` 两条读数**再装机 | 大 | L1 | 低（信箱已够用） |
| **L3** | addon 编译选项对齐 libnode（`-fno-emulated-tls -D__MUSL__`） | 小 | L2 | 低 |
| **L4** | `bad-response` / `bridgeError.message` 的诊断已增强（带 `JSON.parse` 位置与 ±60 字符现场、detail 进 message） | — | — | ✅ 已完成 |
| **L5** | 把 `MAILBOX_STALE_MS` / 轮询间隔 / 上限做成可配置（当前是常量） | 小 | — | 低 |

---

## 附录 A：本文引用的 dshm 文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `hostruntime/src/main/cpp/dshhost.cc` | 587 | libnode 引导（dlopen/dlsym/四名字/诊断块/停止语义） |
| `entry/src/main/cpp/CMakeLists.txt` | 15,809 B | 全部链接口径与"为什么"注释（含 E43/E30/E41） |
| `entry/src/main/ets/speech/HmsSpeechBridge.ets` | 771 | ⭐ 文件信箱参考实现（ArkTS 侧） |
| `hostcore/speech-provider/index.js` | 534 | ⭐ 文件信箱的 Node 侧（轮询 / 超时伸缩 / cleanup） |
| `tools/check-native-closure.mjs` | — | ⭐ 原生闭包静态门禁（两条不变式） |
| `tools/patch-native-needed.mjs` | — | 改写 `DT_NEEDED` 字符串 |
| `hostruntime/src/main/ets/runtime/RuntimePort.ets` | 265 | 运行时载体接口 + 契约纯函数 + 未接线实现 |

## 附录 B：修订记录

| REV | 日期 | 内容 |
|---|---|---|
| 1 | 2026-10-17 | 初版（**从 `pi-desktop-ark/docs/002` 迁入库侧内容**）：libnode 链条 §3、addon 归因更正 §4、文件信箱 §5；含本库 E18 落地后的真机读数 |
