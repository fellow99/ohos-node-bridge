# Changelog

本包的**版本号与 Node 版本严格一致**（`24.2.0` = Node v24.2.0）。
只记录「包形态」的变化；Node 本体变化一律以新版本号出现（如 Node 24.7.0 ⇒ 包 `24.7.0`）。

## 24.2.0（首发，日期待填）

### 新增

- 首次发布：`@fellow99/node-runtime@24.2.0`，承载 Node.js **v24.2.0** 的 `libnode.so`（arm64-v8a）。
- 二进制来源：`electerm/ohos-node-shared` @ tag `ohos-node-shared-v24.2.0`，资产 `libnode-arm64.so`
  （投放时改名 `libnode.so`），SHA-256 `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1`，
  大小 126,809,264 B，`process.versions.modules = 137`。
- 随包附带 `libc++_shared.so`（来自 ohos-sdk，`DT_NEEDED` 需要）。
- `Index.ets` 导出运行时自证常量：`NODE_VERSION` / `NODE_MODULE_VERSION` / `ABI` / `LIB_SHA256` / `LIB_SIZE` / `RUNTIME_ID`。

### 验证

- `tools/provision.mjs --check`：七项 ELF 门禁全过（ET_DYN / 无 `PT_INTERP` / AArch64 / `DT_NEEDED` 含 libc++ /
  导出 `node::Start` / SHA-256 一致 / 大小与版本串一致）。
- `assembleHar`（release）→ 包 `42,936,534 B`；包内 `libs/arm64-v8a/libnode.so` 的 SHA-256 与锁值一致（未被 strip 改动）。
- 真机（`3QC0226526001227`）：样例经本包提供运行时后 `assembleHap` → `/facts` 200，
  `node v24.2.0` / `modules=137` / `fs_write_readback=OK` / `worker_threads=true`。
