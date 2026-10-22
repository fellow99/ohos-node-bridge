# Changelog

本包是 **ArkTS 组件库 + NAPI 引导件**，版本号遵循自身语义化版本（semver）；
运行时（`libnode.so`）由配套包 **`@fellow99/node-runtime`** 提供，其版本号 = Node 版本号。

## 0.1.0（2026-10-22 发布）

### 新增

- `NodeRuntime`：进程内 Node 运行时的单例与状态机（`idle`/`launching`/`running`/`failed`），
  启动参数（`scriptPath` / `flags` / `libDir` / `homeDir` / `logPath` / `envPairs`）与投递语义。
- NAPI 引导件 `libnode_bridge.so`：`dlopen('libnode.so')` + `dlsym(node::Start)`，**不链接** `libnode.so`
  ⇒ 换 Node 版本不需要重编本库（结构上成立，见工程规划 `AC-007-11`）。
- `HostBridge` + `libnode_host_client.so`：Node → ArkTS 的宿主能力调用（轮询信箱，15 s 超时 / 并发 4 / 参数 8 KB 上限）。
- `Logger` / `Env`：日志环 + 路径与环境变量装配（沙箱路径一律绝对，`cwd=/`）。
- 权限面最小化：仅声明 `ohos.permission.INTERNET`、`ohos.permission.GET_NETWORK_INFO`；
  受限 ACL（`ALLOW_WRITABLE_CODE_MEMORY`，JIT 必需）由**宿主应用按自己包名**申报。

### 配套

- 运行时包：`@fellow99/node-runtime@24.2.0`（Node **v24.2.0** / arm64-v8a / `modules=137`，
  SHA-256 `3019bf5f…51a1`）。

### 已知限制（实测结论）

- `node::Start` **每进程只能一次**：崩溃即终态，只能重启应用。
- 无 ACL 时 JIT 不可用，必须 `--jitless`（代价：WebAssembly 全废）。
- `process.cwd()` = `/`、`execPath` = `/system/bin/appspawn`、`os.cpus()` 长度 0。
- 只支持 `2in1` / `tablet`、ABI 只有 `arm64-v8a`。

### 验证

- `assembleHar`（release）：486,170 B / 27 条目（不含 `libnode.so`）。
- 真机（`3QC0226526001227`）：样例工程经运行时包提供 `libnode.so` 后 `assembleHap` → `/facts` 200，
  `node v24.2.0` / `modules=137` / `fs_write_readback=OK` / `worker_threads=true`。
