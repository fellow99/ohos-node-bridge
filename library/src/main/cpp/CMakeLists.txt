cmake_minimum_required(VERSION 3.5.0)
project(node_bridge)

set(CMAKE_C_STANDARD 11)

# ⚠️ 必须保留：本引导件用到 POSIX/GNU 声明（`sigaction`/`ucontext_t`/`ptrace` 等 ucontext、`dlopen`、
# `clock_gettime`、`syscall`）。在严格 `-std=c11` 下 musl 不暴露这些声明 ⇒ 编译期报
# 「use of undeclared identifier」，而这类报错与真正缺头文件难以区分。两条都设，不依赖 CMake 默认值：
#   ① `CMAKE_C_EXTENSIONS ON` ⇒ 使用 `-std=gnu11`；
#   ② `_GNU_SOURCE` ⇒ 即便有人显式改成 `-std=c11`，声明仍然可见。
set(CMAKE_C_EXTENSIONS ON)

add_library(node_bridge SHARED node_bridge.c)

# 关键：native 产物必须落在 <module>/libs/<abi>/，否则 HAP 里**没有** libs/ 目录
#（构建不报错，但运行期 dlopen 找不到 → 表现为「装上了但功能不通」，工程规划 §5.9）
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${OHOS_ARCH})

# 只依赖 NAPI 与 hilog：**刻意不链接 libnode.so** ——
# 运行时用 dlopen('libnode.so') 加载（RTLD_NOW | RTLD_GLOBAL），
# 这样引导件与运行时版本解耦：换 Node 版本不需要重新编译本库。
target_link_libraries(node_bridge PUBLIC libace_napi.z.so libhilog_ndk.z.so)

target_compile_definitions(node_bridge PRIVATE _GNU_SOURCE)

# ── Node 侧宿主桥入口（行动项 E18 方案 A）────────────────────────────────────────
# **刻意不链接 `libace_napi`**：napi_* 必须留作未定义符号，靠运行时已 dlopen 的
# `libnode.so`（RTLD_GLOBAL）解析 —— 否则两套 NAPI 实现混用会崩掉整个进程（真机实测）。
# 只导出 `napi_register_module_v1` + `callHost`；真正的阻塞逻辑在
# `libnode_bridge.so` 的 `pi_host_call`（本文件用 dlsym 取）。
add_library(node_host_client SHARED node_host_client.c)
target_compile_definitions(node_host_client PRIVATE _GNU_SOURCE)
# 允许未定义符号（napi_*）：OHOS 工具链默认 --no-undefined，而方案 A 的核心正是
# 「napi_* 保持未定义、运行时由 libnode.so 解析」。`-z undefs` 是 LLD 的开关。
target_link_options(node_host_client PRIVATE -Wl,-z,undefs)
