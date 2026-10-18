# PROVENANCE —— node-v24.2.0 / arm64-v8a

本文件自证：`libnode-arm64.so` **是什么、从哪来、能不能用、验过没有**。
与 `ohos-node-bridge/runtime.lock.json` 中 `node === "v24.2.0" && abi === "arm64-v8a"` 那条一一对应。

---

## 1. 身份

| 项 | 值 |
| --- | --- |
| 文件 | `libnode-arm64.so`（上游资产**原名**） |
| 大小 | 126,809,264 B（120.9 MiB） |
| SHA-256 | `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1` |
| Node 版本 | v24.2.0 |
| `process.versions.modules` | 137（ABI ⇒ `libnode.so.137`） |
| ABI / 架构 | arm64-v8a（AArch64, `e_machine = 0xb7`） |

## 2. 出处

| 项 | 值 |
| --- | --- |
| 来源仓库 | `electerm/ohos-node-shared`（GitHub） |
| Release tag | `ohos-node-shared-v24.2.0` |
| 资产 | `libnode-arm64.so` |
| URL | https://github.com/electerm/ohos-node-shared/releases/download/ohos-node-shared-v24.2.0/libnode-arm64.so |
| 取用日期 | 2026-10-16 |
| 上游构建方式 | OHOS SDK + LLVM-19；`./configure --shared --cross-compiling --openssl-no-asm --v8-disable-temporal-support`（见上游仓库构建脚本） |
| 许可 | Node.js 本体 MIT；`ohos-node-shared` 构建脚本 MIT |

**为什么选它**（对比另外三个候选仓库的结论，详见 `ohos-node-bridge/docs/000-工程规划.md` §5.8）：

- 只有它发布**共享库形态**的产物，且 `PT_INTERP = 0`（不依赖动态加载器，`dlopen` 可直接吃）；
- 导出 `node::Start`，进程内启动 Node 必需的入口；
- 另外三个候选：一个是 PIE 可执行文件（`PT_INTERP=1`，不能 `dlopen`）、一个无 release/无二进制、
  一个只提供自签名算法而不提供产物。

## 3. ELF 事实（自解析，非人云亦云）

```
e_type          DYN (3)            ← 共享库，可 dlopen
e_machine       AArch64 (0xb7)
PT_INTERP       0                  ← 关键：不依赖 /lib/ld-musl-*，dlopen 不会因缺 interp 失败
SONAME          libnode.so.137
DT_NEEDED       libc++_shared.so, lib.so
node::Start     raw=True  exported_dynsym=True
SHT 数量        29（e_shoff=126812160）
.note.ohos.ident  有              ← 上游交叉编译产物自带
.codesign         无              ← 见 §5
ICU                   内嵌（无需外置 icu 数据）
V8 snapshot           内嵌
```

## 4. 七项门禁（投放前必过，任一不过即硬失败）

复现命令（在仓库根执行）：`node tools/provision.mjs --check`

```
OK  ① e_type == ET_DYN(3)                      实测 3
OK  ② PT_INTERP 计数 == 0                      实测 0
OK  ③ e_machine == AArch64(0xB7)               实测 b7
OK  ④ DT_NEEDED 含 libc++_shared.so            实测 libc++_shared.so,lib.so
OK  ⑤ _ZN4node5StartEiPPc 已导出                实测 true
OK  ⑥ SHA-256 与 lock 一致
OK  ⑦ 大小与 lock 一致 / 版本串存在              实测 v24.2.0
```

## 5. 签名状态（重要，别重复踩）

- 本产物**没有** `.codesign` 段，只有 `.note.ohos.ident`。
- **HAP 内的原生库不需要 `.codesign`**：真机实测，同一个 HAP 里四个无 `.codesign` 的 so
  （含 `DT_NEEDED` 链上必须成功加载的 `libc++_shared.so`）都能正常加载，`hilog` 中
  `xpm` / `unsigned file` 零命中（见 `000-工程规划.md` §D.6）。
  ⇒ 这条已关闭，不再需要为 HAP 内嵌库补签名。
- **只有"脱离 HAP 独立分发"时才需要自签**，此时用：
  `node tools/provision.mjs --sign --out <dir>`（内部调用 `tools/ohos-selfsign.mjs`
  做 `add-section` + `sign` + `verify`，纯 SHA-256 Merkle + fs-verity descriptor，无私钥）。
- 注意：自签会**改变文件内容与 SHA-256**（本目录的 `libnode-arm64.so` 是**未签名**原件）。
  若签名版与锁文件并存，务必分清——`provision.mjs --check` 只认未签名原件。

## 6. 真机验证

| 项 | 值 |
| --- | --- |
| 设备 | HAD-W32（HUAWEI MateBook Pro）/ HarmonyOS 6.1.0 / API 26 / arm64-v8a |
| 形态 | 进程内 `dlopen('libnode.so')` + detached thread 调 `node::Start`（不 spawn、不子进程） |
| 结果 | ✅ `node v24.2.0` / `platform openharmony` / `arch arm64` / `modules 137`；HTTP 回环可达、`fs` 写回一致、`worker_threads` 可用 |
| 前置 | 需要 `ALLOW_WRITABLE_CODE_MEMORY` ACL 才能开 JIT；无 ACL 时必须 `--jitless`（会失去 WebAssembly） |
| 无 ACL 时 | 不带 `--jitless` ⇒ 平台 SIGTRAP（`CRASH sig=5 si_addr==pc`），属**平台前置**，与本产物无关 |
| 验证日期 | 2026-10-16 |
| 证据 | `ohos-node-bridge/docs/000-工程规划.md` §D.7–§D.10 的实测表；真机复现：在仓库根执行 `node tools/probe.mjs`（证据落 `logs/<date>-probe/`） |

## 7. 重新填充本目录

```bash
# 校验现有文件
cd runtime && sha256sum -c SHA256SUMS

# 联网重新获取（国内网络需代理；Node 内置 fetch 默认不读代理变量）
export HTTPS_PROXY=http://127.0.0.1:7890
NODE_USE_ENV_PROXY=1 node tools/provision.mjs \
    --download --out <临时目录>          # 下载后会跑门禁 + SHA 比对，通过才落地（在仓库根执行）

# 或直接手工下载后核对
curl -L -o libnode-arm64.so https://github.com/electerm/ohos-node-shared/releases/download/ohos-node-shared-v24.2.0/libnode-arm64.so
sha256sum libnode-arm64.so   # 必须等于 §1 的 SHA-256
```

> 若上游资产变了（哈希对不上）：**不要**就地改锁文件的哈希了事——
> 先搞清是上游重新发布了同 tag 资产还是被替换，再决定是重新验证（跑门禁 + 真机探针）
> 还是换版本。锁文件里的哈希是证据，不是手续。
