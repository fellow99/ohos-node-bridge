cmake_minimum_required(VERSION 3.5.0)
project(node_bridge)

set(CMAKE_C_STANDARD 11)

add_library(node_bridge SHARED node_bridge.c)

# 关键：native 产物必须落在 <module>/libs/<abi>/，否则 HAP 里**没有** libs/ 目录
#（构建不报错，但运行期 dlopen 找不到 → 表现为「装上了但功能不通」，工程规划 §5.9）
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${OHOS_ARCH})

# 只依赖 NAPI 与 hilog：**刻意不链接 libnode.so** ——
# 运行时用 dlopen('libnode.so') 加载（RTLD_NOW | RTLD_GLOBAL），
# 这样引导件与运行时版本解耦：换 Node 版本不需要重新编译本库。
target_link_libraries(node_bridge PUBLIC libace_napi.z.so libhilog_ndk.z.so)
