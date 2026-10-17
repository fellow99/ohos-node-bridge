/*
 * libnode_host_client.so —— **Node 侧的宿主桥入口**（行动项 E18，方案 A）。
 *
 * ## 为什么需要**另一个** .so
 *
 * 同一个 `libnode_bridge.so` 无法同时服务两个 NAPI env（真机实测，两次迭代都失败）：
 *   · 不导出 Node 入口 ⇒ Node 的 `process.dlopen` 报 `Module did not self-register`
 *     （.so 已被 ArkTS `import`，构造函数不会为 Node 的 env 再跑一次）；
 *   · 导出 `napi_register_module_v1` ⇒ Node 能调进来，但**整个应用进程静默消失** ——
 *     那个 .so 链接的是 OHOS 的 `libace_napi`，Node 用**自己的 env** 调进来后，我们再去调
 *     `napi_define_properties` 等，等于把 OHOS 的实现作用在 Node 的对象上（未定义行为）。
 *
 * ## 本文件的定位（关键设计）
 *
 * 1. **一个 napi 符号都不链接**：本 .so 在编译期**不**链接 `libace_napi`，
 *    `napi_*` 一律留作未定义符号，靠运行时已 dlopen 的 `libnode.so`（RTLD_GLOBAL）解析
 *    ⇒ 用的一定是 **Node 那一套实现**，不会串。
 * 2. **不碰槽位表**：真正的阻塞逻辑在 `libnode_bridge.so` 的 `pi_host_call`
 *    （`visibility("default")`），这里只 `dlsym(RTLD_DEFAULT, "pi_host_call")` 把活转过去。
 *    ⇒ 两个 .so 共享同一份请求/回填语义，ArkTS 侧继续用 `pollHostRequest`/`completeHostRequest`。
 * 3. 只暴露一个函数 `callHost(name, argsJson)`；引导件符号（`start` 等）一律不暴露。
 *
 * ## 失败纪律
 *
 * 找不到 `pi_host_call`（说明 `libnode_bridge.so` 没被 RTLD_GLOBAL 加载）⇒ **抛错**，
 * 不返回空串；错误里带上尝试次数，便于区分「没加载」与「加载了但符号被隐藏」。
 */
#include "node_api.h"

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** 结果上限（与 `node_bridge.c` 的 `HOST_RESULT_LEN` 对齐） */
#define CLIENT_RESULT_CAP 65536
/** name / args 上限（与原生槽位表对齐；超长由原生侧再校验一次） */
#define CLIENT_NAME_CAP 128
#define CLIENT_ARGS_CAP 8192

typedef int (*pi_host_call_fn)(const char *name, const char *args, char *out, size_t cap);

static pi_host_call_fn g_pi_host_call = NULL;
static int g_resolve_attempts = 0;

static pi_host_call_fn resolve_pi_host_call(void) {
  if (g_pi_host_call != NULL) {
    return g_pi_host_call;
  }
  g_resolve_attempts += 1;
  void *sym = dlsym(RTLD_DEFAULT, "pi_host_call");
  if (sym == NULL) {
    return NULL;
  }
  g_pi_host_call = (pi_host_call_fn)sym;
  return g_pi_host_call;
}

/** 取一个字符串参数到固定缓冲；返回 0 成功、-1 失败（已抛错） */
static int read_arg(napi_env env, napi_value *argv, size_t argc, size_t idx,
                    char *dest, size_t cap, const char *label) {
  dest[0] = 0;
  if (idx >= argc) {
    return 0;
  }
  size_t needed = 0;
  if (napi_get_value_string_utf8(env, argv[idx], NULL, 0, &needed) != napi_ok) {
    char msg[128];
    snprintf(msg, sizeof(msg), "callHost: %s 不是字符串", label);
    napi_throw_error(env, NULL, msg);
    return -1;
  }
  if (needed + 1 > cap) {
    char msg[160];
    snprintf(msg, sizeof(msg), "callHost: %s 超长（%zu 字节 > 上限 %zu）", label, needed, cap - 1);
    napi_throw_error(env, NULL, msg);
    return -1;
  }
  size_t written = 0;
  if (napi_get_value_string_utf8(env, argv[idx], dest, cap, &written) != napi_ok) {
    char msg[128];
    snprintf(msg, sizeof(msg), "callHost: %s 读取失败", label);
    napi_throw_error(env, NULL, msg);
    return -1;
  }
  return 0;
}

/** callHost(name, argsJson) -> string（阻塞；失败抛错） */
static napi_value js_call_host(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  char name[CLIENT_NAME_CAP];
  char args[CLIENT_ARGS_CAP];
  if (read_arg(env, argv, argc, 0, name, sizeof(name), "name") != 0) {
    return NULL;
  }
  if (read_arg(env, argv, argc, 1, args, sizeof(args), "argsJson") != 0) {
    return NULL;
  }

  pi_host_call_fn call = resolve_pi_host_call();
  if (call == NULL) {
    char msg[224];
    snprintf(msg, sizeof(msg),
             "callHost: host-transport-missing（dlsym(RTLD_DEFAULT,\"pi_host_call\") 第 %d 次失败；"
             "libnode_bridge.so 是否以 RTLD_GLOBAL 加载？）", g_resolve_attempts);
    napi_throw_error(env, NULL, msg);
    return NULL;
  }

  char *out = (char *)malloc(CLIENT_RESULT_CAP);
  if (out == NULL) {
    napi_throw_error(env, NULL, "callHost: 内存不足");
    return NULL;
  }
  int rc = call(name, args, out, CLIENT_RESULT_CAP);
  if (rc != 0) {
    free(out);
    char msg[192];
    const char *kind = rc == -3 ? "host-timeout"
                     : rc == -5 ? "host-busy"
                     : rc == -2 ? "host-args-too-large"
                     : "host-error";
    snprintf(msg, sizeof(msg), "callHost: %s（%s，rc=%d）", kind, name, rc);
    napi_throw_error(env, NULL, msg);
    return NULL;
  }
  napi_value ret;
  napi_create_string_utf8(env, out, NAPI_AUTO_LENGTH, &ret);
  free(out);
  return ret;
}

/*
 * Node 的 addon 入口（`process.dlopen` 会 dlsym 这个名字并**用 Node 的 env** 调用）。
 * 用 `napi_set_named_property` 而不是 `napi_define_properties`：前者默认
 * writable + enumerable + configurable，JS 侧 `Object.keys()` 能直接看到（踩过不可枚举的坑）。
 */
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn = NULL;
  if (napi_create_function(env, "callHost", NAPI_AUTO_LENGTH, js_call_host, NULL, &fn) != napi_ok) {
    return exports;
  }
  napi_set_named_property(env, exports, "callHost", fn);
  return exports;
}
