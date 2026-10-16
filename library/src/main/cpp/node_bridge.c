/*
 * node_bridge.c —— ohos-node-bridge 的 NAPI 引导件（002-napi-bootstrap）。
 *
 * 它在一条 **detached pthread** 上完成 Node 的进程内启动：
 *   ① 装 SIGSYS shim（io_uring_setup → 正好 -1；判定必须读指令编码，不能比 PC 与 si_addr）
 *   ② dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL) → dlsym("_ZN4node5StartEiPPc")
 *   ③ 重定向 stdout/stderr 到日志文件，按 ArkTS 传入的 flags 组 argv（argc **不含**尾部 NULL 哨兵）
 *   ④ 调 node::Start 并记录返回值；崩溃由 signal handler 落盘
 *
 * 依据（都是真机实测结论，不是推断）：
 *   - harmonyos-node-notes 六条硬约束；
 *   - 工程规划 §5.10（同形态先例的实现要点）与 §D.8（本机探针结论）。
 *
 * ⚠️ 已知待升级项（Phase 2，§5.10 ⑤）：stdio 目前直接重定向到文件；若消费方的
 * 输出量很大，应改成「1 MB pipe + 独立 reader 线程持续排空」，否则可能阻塞 ArkWeb 的 IO 线程。
 */
#include "node_api.h"
#include "hilog/log.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0xD003300
#define LOG_TAG "NODE_BRIDGE"

#define MAX_ARGS 12
#define LOG_PATH_LEN 512
#define CTX_PATH_LEN 512

typedef int (*node_start_fn)(int argc, char *argv[]);

static char g_log_path[LOG_PATH_LEN] = {0};
static volatile int g_node_running = 0;

/* ---------------------------------------------------------------- 日志 ---- */

/* 裸写日志文件：信号上下文里**禁止**用 printf/vsnprintf/OH_LOG_Print（会二次崩溃） */
static void raw_write(const char *s) {
  if (g_log_path[0] == 0) return;
  int fd = open(g_log_path, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) return;
  ssize_t n = write(fd, s, strlen(s));
  (void)n;
  close(fd);
}

static void log_line(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (n > 0) {
    OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, LOG_TAG, "%{public}s", buf);
    raw_write(buf);
    raw_write("\n");
  }
}

/* ---------------------------------------------------------- SIGSYS shim ---- */

static void sigsys_handler(int sig, siginfo_t *si, void *uc_) {
  (void)sig;
  (void)si;
  ucontext_t *uc = (ucontext_t *)uc_;
  /* 判据：读指令编码 0xd4000001（svc #0）。用 PC 与 si_addr 比较在部分设备上恒不相等 ⇒ shim 静默失效 */
  uint32_t insn = *(uint32_t *)uc->uc_mcontext.pc;
  if (insn == 0xd4000001u) {
    uc->uc_mcontext.regs[0] = (uint64_t)-1;  /* 必须正好 -1：返回 -ENOSYS 会让 libuv assert(fd > STDERR_FILENO) */
    uc->uc_mcontext.pc += 4;
  }
}

static void install_sigsys_shim(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = sigsys_handler;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGSYS, &sa, NULL);
}

/* -------------------------------------------------------- 崩溃取证 ---- */

static void crash_handler(int sig, siginfo_t *si, void *uc_) {
  ucontext_t *uc = (ucontext_t *)uc_;
  char buf[512];
  snprintf(buf, sizeof(buf),
           "CRASH sig=%d si_addr=%p pc=%p lr=%p sp=%p r0=%p\n",
           sig, si ? si->si_addr : NULL, (void *)uc->uc_mcontext.pc,
           (void *)uc->uc_mcontext.regs[30], (void *)uc->uc_mcontext.sp,
           (void *)uc->uc_mcontext.regs[0]);
  int fd = g_log_path[0] ? open(g_log_path, O_WRONLY | O_CREAT | O_APPEND, 0644) : -1;
  if (fd >= 0) { ssize_t n = write(fd, buf, strlen(buf)); (void)n; close(fd); }
  signal(sig, SIG_DFL);
  raise(sig);
}

static void install_crash_handlers(void) {
  int sigs[] = {SIGSEGV, SIGILL, SIGBUS, SIGABRT, SIGFPE, SIGTRAP};
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = crash_handler;
  sa.sa_flags = SA_SIGINFO | SA_RESETHAND;
  sigemptyset(&sa.sa_mask);
  for (unsigned i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) sigaction(sigs[i], &sa, NULL);
}

/* ------------------------------------------------------------- 引导 ---- */

typedef struct {
  char lib_dir[CTX_PATH_LEN];  /* ArkTS: context.bundleCodeDir */
  char script[CTX_PATH_LEN];   /* 入口脚本绝对路径 */
  char flags[256];             /* 空格分隔的 node 参数 */
  char home[CTX_PATH_LEN];     /* ArkTS: context.filesDir */
  char tmp[CTX_PATH_LEN];
  char log[LOG_PATH_LEN];
} bridge_ctx;

static bridge_ctx g_ctx;

static void *bootstrap(void *arg) {
  bridge_ctx *ctx = (bridge_ctx *)arg;
  log_line("[node_bridge] thread start; tid=%ld", (long)syscall(SYS_gettid));

  install_sigsys_shim();
  setenv("UV_USE_IO_URING", "0", 1);
  setenv("HOME", ctx->home, 1);
  setenv("USERPROFILE", ctx->home, 1);
  setenv("TMPDIR", ctx->tmp, 1);
  setenv("TMP", ctx->tmp, 1);
  setenv("TEMP", ctx->tmp, 1);
  setenv("NODE_ENV", "production", 1);
  unsetenv("NODE_OPTIONS");

  {
    /* 探针：本机期望返回 -1（无 seccomp trap 的机型会返回正数，此时 shim 不会被触发，保留作防御） */
    void *p = NULL;
    errno = 0;
    long rc = syscall(425 /*__NR_io_uring_setup*/, 8, &p);
    log_line("[node_bridge] io_uring_setup(425) -> %ld (errno=%d)", rc, errno);
  }

  /* dlopen 候选：真机上**只有裸名能成功**（HAP 内库实际落 /data/storage/el1/bundle/libs/arm64/） */
  char cand[4][640];
  int nc = 0;
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libs/arm64-v8a/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libs/arm64/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "libnode.so");

  void *h = NULL;
  for (int i = 0; i < nc; i++) {
    h = dlopen(cand[i], RTLD_NOW | RTLD_GLOBAL);  /* GLOBAL：让后续原生 addon 能解析 napi_* */
    log_line("[node_bridge] dlopen('%s') -> %s", cand[i], h ? "OK" : dlerror());
    if (h) break;
  }
  if (!h) {
    log_line("[node_bridge] FATAL: 无法加载 libnode.so（请确认已用 tools/provision.mjs 投放运行时）");
    return NULL;
  }

  node_start_fn start = (node_start_fn)dlsym(h, "_ZN4node5StartEiPPc");
  log_line("[node_bridge] dlsym(node::Start) -> %p", (void *)start);
  if (!start) {
    log_line("[node_bridge] FATAL: dlsym 失败: %s", dlerror());
    return NULL;
  }

  int fd = open(ctx->log, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd >= 0) {
    dup2(fd, 1);
    dup2(fd, 2);
    if (fd > 2) close(fd);
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);

  /* argv：argc **不含**尾部 NULL 哨兵（多算一个 ⇒ Node 拿到 NULL ⇒ 5 ms 内段错误） */
  static char argv0[] = "node";
  static char argbuf[MAX_ARGS][512];
  char *argv[MAX_ARGS + 1];
  int argc = 0;
  argv[argc++] = argv0;
  {
    char f[sizeof(ctx->flags)];
    snprintf(f, sizeof(f), "%s", ctx->flags);
    char *tok = strtok(f, " ");
    while (tok && argc < MAX_ARGS - 1) {
      snprintf(argbuf[argc], sizeof(argbuf[0]), "%s", tok);
      argv[argc] = argbuf[argc];
      argc++;
      tok = strtok(NULL, " ");
    }
  }
  snprintf(argbuf[argc], sizeof(argbuf[0]), "%s", ctx->script);
  argv[argc] = argbuf[argc];
  argc++;
  argv[argc] = NULL;

  for (int i = 0; i < argc; i++) log_line("[node_bridge] argv[%d]=%s", i, argv[i]);
  log_line("[node_bridge] calling node::Start(argc=%d) ...", argc);
  g_node_running = 1;

  int rc = start(argc, argv);

  g_node_running = 0;
  log_line("[node_bridge] node::Start returned rc=%d errno=%d（正常应只在退出时返回）", rc, errno);
  return NULL;
}

/* --------------------------------------------------------- NAPI 接口 ---- */

/**
 * start(libDir, scriptPath, flags, home, logPath) -> number
 *   0 = 已投递；非 0 = pthread_create 的错误码。
 * 注意：Node 只能启动一次（本函数不做重复启动保护，保护在 ArkTS 侧 NodeRuntime）。
 */
static napi_value js_start(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  memset(&g_ctx, 0, sizeof(g_ctx));
  size_t len = 0;
  if (argc > 0) napi_get_value_string_utf8(env, argv[0], g_ctx.lib_dir, sizeof(g_ctx.lib_dir), &len);
  if (argc > 1) napi_get_value_string_utf8(env, argv[1], g_ctx.script, sizeof(g_ctx.script), &len);
  if (argc > 2) napi_get_value_string_utf8(env, argv[2], g_ctx.flags, sizeof(g_ctx.flags), &len);
  if (argc > 3) napi_get_value_string_utf8(env, argv[3], g_ctx.home, sizeof(g_ctx.home), &len);
  if (argc > 4) napi_get_value_string_utf8(env, argv[4], g_ctx.log, sizeof(g_ctx.log), &len);
  if (g_ctx.flags[0] == 0) snprintf(g_ctx.flags, sizeof(g_ctx.flags), "%s", "--no-verify-heap");
  snprintf(g_ctx.tmp, sizeof(g_ctx.tmp), "%s/tmp", g_ctx.home);
  snprintf(g_log_path, sizeof(g_log_path), "%s", g_ctx.log);
  mkdir(g_ctx.tmp, 0755);

  install_crash_handlers();

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 32 * 1024 * 1024);  /* UI 线程外、32 MB 栈：§5.10 ① */
  pthread_t th;
  int rc = pthread_create(&th, &attr, bootstrap, &g_ctx);
  pthread_attr_destroy(&attr);

  napi_value out;
  if (rc != 0) {
    log_line("[node_bridge] pthread_create failed rc=%d", rc);
    g_log_path[0] = 0;
    napi_create_int32(env, rc, &out);
    return out;
  }
  pthread_detach(th);  /* detached：Node 自己管理生命周期，不阻塞 UI 线程退出 */
  log_line("[node_bridge] bootstrap thread created (detached)");
  napi_create_int32(env, 0, &out);
  return out;
}

static napi_value js_is_running(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_int32(env, g_node_running, &out);
  return out;
}

static napi_value js_version(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_string_utf8(env, "node_bridge/0.1.0 (ohos-node-bridge)", NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"start", NULL, js_start, NULL, NULL, NULL, napi_default, NULL},
    {"isRunning", NULL, js_is_running, NULL, NULL, NULL, napi_default, NULL},
    {"version", NULL, js_version, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(node_bridge, Init)
