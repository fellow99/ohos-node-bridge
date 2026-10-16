/*
 * node_bridge.c —— ohos-node-bridge 的 NAPI 引导件（002-napi-bootstrap-native-loader）。
 *
 * 它在一条 **detached pthread（32 MB 栈）** 上完成 Node 的进程内启动：
 *   ① 建立 stdio 通道：fd0 ← /dev/null、fd1/fd2 ← 各自的 pipe，由独立 reader 线程持续排空并落盘
 *   ② 装 SIGSYS shim（io_uring_setup → 正好 -1；判定必须读指令编码，不能比 PC 与 si_addr）
 *   ③ dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL) → dlsym("_ZN4node5StartEiPPc")
 *   ④ 按 ArkTS 传入的 flags 组 argv（argc **不含**尾部 NULL 哨兵）→ 调 node::Start
 *   ⑤ 每一步失败都写 lastError()/stage()（ArkTS 可见，不允许静默失败）
 *
 * 依据（都是真机实测结论，不是推断）：
 *   - harmonyos-node-notes 六条硬约束；
 *   - 工程规划 §5.2 / §5.9 / §5.10（十六条第 ①③④⑤⑬ 项）+ §D.8（实现偏差表）+ §D.10 ⑰⑱；
 *   - specs/constitution.md C2（不隐藏平台真相）、C5（单例与不可重启）、C6（诊断优先）、S5（信号上下文禁用 stdio）。
 *
 * ⚠️ 设计红线（改动前先读）：
 *   - 信号上下文里**只允许**裸 open/write/close 与栈上 snprintf；**禁止** printf/stdout/OH_LOG_Print；
 *   - 崩溃是终态（`node::Start` 每进程只能一次）⇒ 这里**不实现任何自动重启**；
 *   - 本文件不引入任何应用语义（C1）。
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
#define ENV_PAIRS_LEN 4096
#define LINE_BUF_LEN 4096
#define ERROR_LEN 512
#define STAGE_LEN 24

/* 日志行格式（与 logs/20261016-1/IMPLEMENTATION_CONTRACT.md §1.3 一致）：
 *   <stream> <epochMs> <text>\n   stream ∈ { out, err, sys }
 * ArkTS 侧按此前缀解析成 NodeLogEntry{stream, at, text} —— 改格式必须同时改契约与 ArkTS 解析。 */
#define STREAM_OUT "out"
#define STREAM_ERR "err"
#define STREAM_SYS "sys"

typedef int (*node_start_fn)(int argc, char *argv[]);

/* ------------------------------------------------------------------ 全局 ---- */

static char g_log_path[LOG_PATH_LEN] = {0};
static char g_crash_path[LOG_PATH_LEN] = {0};
static int g_log_fd = -1;                 /* 常开：多个线程只用 write() 单次写整行（O_APPEND 原子） */
static volatile int g_node_running = 0;
static volatile int g_dispatched = 0;     /* 单例保护：C 侧也要挡（ArkTS 是第一道） */
static char g_stage[STAGE_LEN] = "init";
static char g_last_error[ERROR_LEN] = {0};

static void set_stage(const char *s) {
  snprintf(g_stage, sizeof(g_stage), "%s", s);
}

/* 非信号上下文使用；信号上下文**不得**调用（会分配/加锁） */
static void set_error(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(g_last_error, sizeof(g_last_error), fmt, ap);
  va_end(ap);
}

static long long now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
  return (long long)ts.tv_sec * 1000LL + (long long)(ts.tv_nsec / 1000000L);
}

/* 异步信号安全的十进制输出：把 v 写进 buf（NUL 结尾），返回写入长度 */
static int u64_to_dec(unsigned long long v, char *buf, size_t cap) {
  char tmp[24];
  int n = 0;
  if (cap == 0) return 0;
  if (v == 0) {
    tmp[n++] = '0';
  } else {
    while (v > 0 && n < (int)sizeof(tmp)) {
      tmp[n++] = (char)('0' + (int)(v % 10ULL));
      v /= 10ULL;
    }
  }
  int out = 0;
  while (n > 0 && (size_t)out + 1 < cap) buf[out++] = tmp[--n];
  buf[out] = 0;
  return out;
}

/* 异步信号安全的十六进制输出（带 0x 前缀），用于崩溃现场的指针/PC/寄存器 */
static int u64_to_hex(unsigned long long v, char *buf, size_t cap) {
  static const char digits[] = "0123456789abcdef";
  char tmp[16];
  int n = 0;
  if (cap < 4) {
    if (cap > 0) buf[0] = 0;
    return 0;
  }
  if (v == 0) {
    tmp[n++] = '0';
  } else {
    while (v > 0 && n < (int)sizeof(tmp)) {
      tmp[n++] = digits[v & 0xFULL];
      v >>= 4;
    }
  }
  int out = 0;
  buf[out++] = '0';
  buf[out++] = 'x';
  while (n > 0 && (size_t)out + 1 < cap) buf[out++] = tmp[--n];
  buf[out] = 0;
  return out;
}

/*
 * 栈上行缓冲（**异步信号安全**）——A5：把一整行先拼进栈缓冲，最后只做**一次** write()。
 *
 * 为什么不能逐段 write：O_APPEND 的原子性只保证「单次 write 不被交错」，
 * 多段 write 之间别的线程（stdio reader 的 write_line）能把它的整行插进来，
 * 把 CRASH 行劈成两半 ⇒ 崩溃现场不可解析（原注释里「单次写整行」对那段代码是假的）。
 * 只用 strlen + 手写数值转换 + 逐字节复制：全部是异步信号安全操作（S5；
 * 不能用 snprintf/memcpy 之外还可能持锁的 stdio 家族）。
 */
static size_t lb_append(char *dst, size_t cap, size_t len, const char *s) {
  size_t i = 0;
  if (s == NULL || cap == 0) return len;
  while (s[i] != 0 && len + 1 < cap) dst[len++] = s[i++];
  dst[len] = 0;
  return len;
}

static size_t lb_append_dec(char *dst, size_t cap, size_t len, unsigned long long v) {
  char tmp[24];
  int n = u64_to_dec(v, tmp, sizeof(tmp));
  for (int i = 0; i < n && len + 1 < cap; i++) dst[len++] = tmp[i];
  dst[len] = 0;
  return len;
}

static size_t lb_append_hex(char *dst, size_t cap, size_t len, unsigned long long v) {
  char tmp[20];
  int n = u64_to_hex(v, tmp, sizeof(tmp));
  for (int i = 0; i < n && len + 1 < cap; i++) dst[len++] = tmp[i];
  dst[len] = 0;
  return len;
}

/* --------------------------------------------------------------- 日志写入 ---- */

/* 裸写：**信号上下文安全**（只用 open/write/close，不碰 stdio/分配） */
static void raw_write_fd(int fd, const char *s, size_t len) {
  if (fd >= 0 && s && len > 0) {
    ssize_t n = write(fd, s, len);
    (void)n;
  }
}
/* 注：原 raw_write_str()（逐段裸写 NUL 结尾串）在 A4/A5 改成「整行单次 write」后已无调用点，
 * 于 2026-10-17 删除，避免留下误导性的写路径。 */

static int open_log_fd(void) {
  if (g_log_path[0] == 0) return -1;
  return open(g_log_path, O_WRONLY | O_CREAT | O_APPEND, 0644);
}

/* 单行落盘（非信号上下文）：<stream> <epochMs> <text>\n */
static void write_line(const char *stream, const char *text) {
  if (g_log_path[0] == 0) return;
  char buf[LINE_BUF_LEN + 64];
  char ms[24];
  u64_to_dec((unsigned long long)now_ms(), ms, sizeof(ms));
  int n = snprintf(buf, sizeof(buf), "%s %s %s\n", stream, ms, text);
  if (n <= 0) return;
  size_t len = (size_t)n;
  if (len >= sizeof(buf)) len = sizeof(buf) - 1;
  if (g_log_fd >= 0) {
    raw_write_fd(g_log_fd, buf, len);
  } else {
    int fd = open_log_fd();
    if (fd >= 0) {
      raw_write_fd(fd, buf, len);
      close(fd);
    }
  }
}

/* 引导件自身的日志（stream=sys）：hilog + 落盘双通道 */
static void log_line(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, LOG_TAG, "%{public}s", buf);
  write_line(STREAM_SYS, buf);
}

/* ----------------------------------------------------------- SIGSYS shim ---- */

static void sigsys_handler(int sig, siginfo_t *si, void *uc_) {
  (void)sig;
  (void)si;
  ucontext_t *uc = (ucontext_t *)uc_;
  /* 判据：读指令编码 0xd4000001（svc #0）。用 PC 与 si_addr 比较在部分设备上恒不相等 ⇒ shim 静默失效 */
  uint32_t insn = *(uint32_t *)uc->uc_mcontext.pc;
  const int is_svc = (insn == 0xd4000001u);

  /* 必须返回**正好 -1**：返回 -ENOSYS(-38) 会让 libuv uv__close(-38) 触发 assert(fd > STDERR_FILENO) */
  uc->uc_mcontext.regs[0] = (uint64_t)-1;
  uc->uc_mcontext.pc += 4;

  /*
   * ⚠️ 「无论如何都推进 PC」不是可选项：若某条 SIGSYS 对应的指令不是 `svc #0`
   *（理论上不该发生，但野 PC 或别的 trap 源都可能），原地 return 会让**同一条指令被无限重投** ⇒ 活锁，
   * 表现为「启动卡死且没有任何输出」—— 最难查的一类故障。这里按「视为 ENOSYS」处理，
   * 并留下一条裸写诊断（只用 write/strlen，均为异步信号安全函数），把「发生了不该发生的事」变成可搜到的日志。
   */
  if (!is_svc) {
    int fd = g_log_fd >= 0 ? g_log_fd : open_log_fd();
    if (fd >= 0) {
      /*
       * A4：必须与 §1.3 的冻结行格式一致 —— `sys <epochMs> <text>`，且 text 以
       * `[node_bridge] ` 开头。旧写法 `sys SIGSYS non-svc …` 既没有 epochMs 也不带前缀，
       * ArkTS 解析器与 tests/lib/log-format.mjs 都会把它归为「无法解析」——
       * 偏偏这行是排查最难那类故障（shim 当场失效）的唯一现场，丢时间戳等于丢证据。
       */
      char line[256];
      size_t len = 0;
      line[0] = 0;
      len = lb_append(line, sizeof(line), len, STREAM_SYS " ");
      len = lb_append_dec(line, sizeof(line), len, (unsigned long long)now_ms());
      len = lb_append(line, sizeof(line), len, " [node_bridge] SIGSYS non-svc insn pc=");
      len = lb_append_hex(line, sizeof(line), len, (unsigned long long)uc->uc_mcontext.pc - 4ULL);
      len = lb_append(line, sizeof(line), len, " insn=");
      len = lb_append_hex(line, sizeof(line), len, (unsigned long long)insn);
      len = lb_append(line, sizeof(line), len, " treated-as-ENOSYS pc-advanced\n");
      raw_write_fd(fd, line, len);  /* A5：整行一次 write（O_APPEND 只保证单次 write 原子） */
      if (g_log_fd < 0) close(fd);
    }
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

/* ------------------------------------------------------------- 崩溃取证 ---- */

static const char *sig_name(int sig) {
  switch (sig) {
    case SIGSEGV: return "SIGSEGV";
    case SIGILL:  return "SIGILL";
    case SIGBUS:  return "SIGBUS";
    case SIGABRT: return "SIGABRT";
    case SIGFPE:  return "SIGFPE";
    case SIGTRAP: return "SIGTRAP";
    default:      return "SIG?";
  }
}

/* 按引导阶段给一句人读提示（崩溃时唯一的「下一步该查什么」） */
static const char *stage_hint(const char *stage) {
  if (strcmp(stage, "dlopen") == 0)
    return "libnode.so 未加载：确认已用 tools/provision.mjs 投放运行时；并核对 ELF 门禁（PT_INTERP 应为 0）";
  if (strcmp(stage, "dlsym") == 0)
    return "node::Start 符号缺失：产物可能不是 --shared 构建的真共享库";
  if (strcmp(stage, "stdio") == 0)
    return "stdio 通道建立失败：检查 <filesDir> 可写与磁盘空间";
  if (strcmp(stage, "start") == 0)
    return "V8/Node 初始化期 —— 两种可能都要查：① 无 ALLOW_WRITABLE_CODE_MEMORY(ACL) 时走 JIT 即 SIGTRAP（工程规划 §D.8）；"
           "② 载荷在初始化期抛出未捕获异常（进程内未捕获异常 = 应用级 abort，⑰⑱）⇒ 先看 <filesDir>/payload/app.log";
  if (strcmp(stage, "running") == 0)
    return "运行期崩溃（Node 已产出输出）：载荷未捕获异常会把整个应用进程带崩（⑱）⇒ 查 <filesDir>/payload/app.log 与 node.log 的 CRASH 行";
  return "引导早期崩溃：见 node.log 的 sys 行";
}

/*
 * 崩溃 handler（信号上下文）。
 * 只做三件事：① 写一行 `sys <ms> CRASH …` 到日志；② 覆盖写 last-crash.json；③ 恢复默认处置并 re-raise。
 * **禁止** printf/OH_LOG_Print —— 信号上下文里调 stdio 会二次崩溃（S5 / §5.10 ②）。
 */
static void crash_handler(int sig, siginfo_t *si, void *uc_) {
  ucontext_t *uc = (ucontext_t *)uc_;
  int fd = g_log_fd >= 0 ? g_log_fd : open_log_fd();

  /*
   * ① 日志行（含寄存器现场）。
   * ⚠️ 这里**不使用 snprintf**：它不是异步信号安全函数，信号可能打断 stdio 持锁临界区 ⇒ 死锁或二次崩溃，
   * 丢掉的正是本该留下的崩溃证据（S5 / §5.10 ②）。只用手写数值转换 + strlen + write。
   * ⚠️ A5：整行先拼进栈缓冲、最后**一次 write()**。O_APPEND 的原子性按单次 write 成立，
   * 逐段 write 会让 stdio reader 线程的整行插进本行中间（CRASH 行被劈开 ⇒ ArkTS 解析器读不到）。
   */
  if (fd >= 0) {
    char line[640];
    size_t len = 0;
    line[0] = 0;
    len = lb_append(line, sizeof(line), len, STREAM_SYS " ");
    len = lb_append_dec(line, sizeof(line), len, (unsigned long long)now_ms());
    len = lb_append(line, sizeof(line), len, " CRASH sig=");
    len = lb_append_dec(line, sizeof(line), len, (unsigned long long)(sig & 0x7f));
    len = lb_append(line, sizeof(line), len, " si_addr=");
    len = lb_append_hex(line, sizeof(line), len, (unsigned long long)(uintptr_t)(si ? si->si_addr : NULL));
    len = lb_append(line, sizeof(line), len, " pc=");
    len = lb_append_hex(line, sizeof(line), len, (unsigned long long)uc->uc_mcontext.pc);
    len = lb_append(line, sizeof(line), len, " lr=");
    len = lb_append_hex(line, sizeof(line), len, (unsigned long long)uc->uc_mcontext.regs[30]);
    len = lb_append(line, sizeof(line), len, " sp=");
    len = lb_append_hex(line, sizeof(line), len, (unsigned long long)uc->uc_mcontext.sp);
    len = lb_append(line, sizeof(line), len, " r0=");
    len = lb_append_hex(line, sizeof(line), len, (unsigned long long)uc->uc_mcontext.regs[0]);
    len = lb_append(line, sizeof(line), len, " stage=");
    len = lb_append(line, sizeof(line), len, g_stage);
    len = lb_append(line, sizeof(line), len, "\n");
    raw_write_fd(fd, line, len);
  }

  /* ② 崩溃记录：<home>/node-bridge/last-crash.json（覆盖写；logTail 由 ArkTS 侧补，契约 §1.4）
   * A5：同样**拼成一整块后单次 write** —— O_TRUNC 之后若被别的线程交错写入，
   * 文件就不再是合法 JSON（B2 的降级路径正是为这种截断准备的，但能一次写完就不该让它发生）。 */
  if (g_crash_path[0] != 0) {
    int cf = open(g_crash_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (cf >= 0) {
      char json[640];
      size_t jlen = 0;
      json[0] = 0;
      jlen = lb_append(json, sizeof(json), jlen, "{\"at\":");
      jlen = lb_append_dec(json, sizeof(json), jlen, (unsigned long long)now_ms());
      jlen = lb_append(json, sizeof(json), jlen, ",\"stage\":\"");
      jlen = lb_append(json, sizeof(json), jlen, g_stage);
      jlen = lb_append(json, sizeof(json), jlen, "\",\"signal\":\"");
      jlen = lb_append(json, sizeof(json), jlen, sig_name(sig));
      jlen = lb_append(json, sizeof(json), jlen, "\",\"hint\":\"");
      jlen = lb_append(json, sizeof(json), jlen, stage_hint(g_stage));
      jlen = lb_append(json, sizeof(json), jlen, "\"}\n");
      raw_write_fd(cf, json, jlen);
      close(cf);
    }
  }

  if (g_log_fd < 0 && fd >= 0) close(fd);

  /* ③ 恢复默认处置并 re-raise（不吞掉信号：让系统的 CppCrash 通道也留下记录） */
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

/* ------------------------------------------------------- stdio 排空线程 ---- */

/*
 * 为什么必须这么做（§5.10 ⑤ / §D.10 ⑱ / R19）：
 *   - 直接 `dup2(fd, 1/2)` 到日志文件会让宿主管线的原生输出（ArkWeb/Chromium）混进同一个文件；
 *   - 管道不被持续排空 ⇒ 写满 64 KB 后 Node 阻塞 ⇒ 阻塞 ArkWeb 的 IO 线程 ⇒ 「Web 组件不绘制」。
 * 因此：fd1/fd2 各接一条 pipe，由**两条独立 reader 线程**各自阻塞读、持续排空并逐行按 §1.3 落盘。
 *
 * C1：排空**不等于**去污染。`dup2` 之后的 fd1/fd2 是**进程共享**的，ArkWeb/Chromium 的原生输出
 * 同样会进来（实测 `/log` 16 KB 里几乎全是 `arkweb/chromium_ext/…`，§D.10 ⑱）。故这里按行过滤
 * 组件原生输出，且**不静默**：首见时写一条 sys 行，每个 reader 退出时再报一次累计丢弃条数。
 * 契约 §1.3 因此修订为：`out`/`err` = **进程** stdout/stderr；载荷自己的通道是 app.log。
 */
typedef struct {
  int fd_read;
  const char *stream;
  int dropped;  /* 本线程过滤掉的 ArkWeb/Chromium 行数（线程私有 ⇒ 无跨线程竞态） */
} drain_arg;

static int g_pipe_out[2] = {-1, -1};
static int g_pipe_err[2] = {-1, -1};
/* 「首见组件输出」的提示只写一次（两个 reader 共享） */
static volatile int g_drop_notice_done = 0;
/* 「首行 Node 输出」的 stage 提升也只做一次（两个 reader 共享） */
static volatile int g_first_node_line_seen = 0;

/*
 * 判据刻意收窄到两种**明确的组件路径/名字**：`arkweb/chromium_ext` 与 `chromium`。
 * 不做模糊匹配 —— 过滤错了会吞掉载荷自己的日志，比脏日志更糟（C2）。
 */
static int is_arkweb_native_line(const char *line) {
  if (strstr(line, "arkweb/chromium_ext") != NULL) return 1;
  if (strstr(line, "chromium") != NULL) return 1;
  return 0;
}

/*
 * 一行的统一出口（过滤 + A3 的 stage 提升 + 落盘）。
 * A3：**第一行 Node 输出**是「Node 真的在跑」的进程内代理证据 —— `node::Start` 返回之前
 * 没有别的信号可用（`g_node_running` 只在调用前后置位，崩溃时仍是 `start`）。
 * 注意只有**未被过滤**的行才算 Node 输出：组件原生行不代表 Node 执行。
 */
static void reader_emit_line(drain_arg *a, const char *line) {
  if (is_arkweb_native_line(line)) {
    a->dropped += 1;
    if (!g_drop_notice_done) {
      g_drop_notice_done = 1;
      log_line("[node_bridge] WARN: 检测到 ArkWeb/Chromium 原生输出（与 Node 共享 fd1/fd2）⇒ 开始过滤；"
               "各 reader 退出时会报告累计丢弃行数");
    }
    return;
  }
  if (!g_first_node_line_seen) {
    g_first_node_line_seen = 1;
    if (strcmp(g_stage, "start") == 0) {
      set_stage("running");  /* running 分支在崩溃 hint 里可达（A3） */
      log_line("[node_bridge] 首行 Node 输出 ⇒ stage: start → running（代理判据：node::Start 返回前进程内无其它信号）");
    }
  }
  write_line(a->stream, line);
}

static void *stdio_reader(void *arg) {
  drain_arg *a = (drain_arg *)arg;
  char chunk[8192];
  char line[LINE_BUF_LEN];
  size_t line_len = 0;

  for (;;) {
    ssize_t r = read(a->fd_read, chunk, sizeof(chunk));
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (r == 0) break;  /* 写端关闭：Node 已退出 */
    for (ssize_t i = 0; i < r; i++) {
      char c = chunk[i];
      if (c == '\n') {
        if (line_len > 0 && line[line_len - 1] == '\r') line_len--;
        line[line_len] = 0;
        reader_emit_line(a, line);
        line_len = 0;
      } else if (line_len < sizeof(line) - 1) {
        line[line_len++] = c;
      } else {
        /* 超长单行：先落一段，剩下的继续（不丢内容、不无限增长内存） */
        line[line_len] = 0;
        reader_emit_line(a, line);
        line_len = 0;
      }
    }
  }
  if (line_len > 0) {
    line[line_len] = 0;
    reader_emit_line(a, line);
  }
  if (a->dropped > 0) {
    /* 退出时必须报数：过滤掉的内容不再有任何其它痕迹（「不静默」的落点） */
    log_line("[node_bridge] ArkWeb/Chromium 原生输出过滤：本 reader 累计丢弃 %d 行（stream=%s）",
             a->dropped, a->stream);
  }
  return NULL;
}

static int start_drain_threads(void) {
  static drain_arg out_arg;
  static drain_arg err_arg;
  pthread_t th;

  if (pipe(g_pipe_out) != 0) return -1;
  if (pipe(g_pipe_err) != 0) return -1;

  if (dup2(g_pipe_out[1], STDOUT_FILENO) < 0) return -1;
  if (dup2(g_pipe_err[1], STDERR_FILENO) < 0) return -1;
  if (g_pipe_out[1] > STDERR_FILENO) close(g_pipe_out[1]);
  if (g_pipe_err[1] > STDERR_FILENO) close(g_pipe_err[1]);

  out_arg.fd_read = g_pipe_out[0];
  out_arg.stream = STREAM_OUT;
  err_arg.fd_read = g_pipe_err[0];
  err_arg.stream = STREAM_ERR;

  if (pthread_create(&th, NULL, stdio_reader, &out_arg) != 0) return -1;
  pthread_detach(th);
  if (pthread_create(&th, NULL, stdio_reader, &err_arg) != 0) return -1;
  pthread_detach(th);
  return 0;
}

/* stdin：接 /dev/null —— 否则 Node 读 stdin 会挂住（§5.10 ⑤） */
static void redirect_stdin_to_devnull(void) {
  int fd = open("/dev/null", O_RDONLY);
  if (fd < 0) return;
  if (dup2(fd, STDIN_FILENO) < 0) {
    close(fd);
    return;
  }
  if (fd > STDERR_FILENO) close(fd);
}

/* --------------------------------------------------------------- 引导 ---- */

typedef struct {
  char lib_dir[CTX_PATH_LEN];  /* ArkTS: context.bundleCodeDir */
  char script[CTX_PATH_LEN];   /* 入口脚本绝对路径 */
  char flags[256];             /* 空格分隔的 node 参数 */
  char home[CTX_PATH_LEN];     /* ArkTS: context.filesDir */
  char tmp[CTX_PATH_LEN];
  char log[LOG_PATH_LEN];
  char envpairs[ENV_PAIRS_LEN]; /* "K=V\nK2=V2"（契约 §1.2） */
} bridge_ctx;

static bridge_ctx g_ctx;

/*
 * 应用 ArkTS 传来的额外环境（契约 §1.2）。
 * 在原生默认值**之后**应用 ⇒ 调用方可以覆盖 HOME/TMPDIR/NODE_ENV。
 * 值内含换行/非法 key 的行被跳过并**明确记日志**（不静默）。
 */
/* 极简原地分词器：不依赖 strtok_r/strtok（避免 feature-test macro 差异带来的声明可见性问题） */
static char *split_next(char **p, char sep) {
  char *s = *p;
  if (s == NULL) return NULL;
  while (*s == sep) s++;
  if (*s == 0) {
    *p = NULL;
    return NULL;
  }
  char *start = s;
  while (*s != 0 && *s != sep) s++;
  if (*s == sep) {
    *s = 0;
    *p = s + 1;
  } else {
    *p = NULL;
  }
  return start;
}

/*
 * 应用 ArkTS 传来的额外环境（契约 §1.2）。
 * 在原生默认值**之后**应用 ⇒ 调用方可以覆盖 HOME/TMPDIR/NODE_ENV。
 * 值内含换行 / key 非法的行被跳过并**明确记日志**（不静默）。
 * 静态缓冲：避免 4 KB 栈占用，且 setenv 会拷贝字符串，不产生悬挂引用。
 */
static void apply_env_pairs(const char *pairs) {
  if (!pairs || pairs[0] == 0) return;
  static char buf[ENV_PAIRS_LEN];
  snprintf(buf, sizeof(buf), "%s", pairs);
  char *cursor = buf;
  char *line = split_next(&cursor, '\n');
  while (line) {
    char *eq = strchr(line, '=');
    if (eq && eq != line) {
      *eq = 0;
      const char *k = line;
      const char *v = eq + 1;
      if (setenv(k, v, 1) == 0) {
        log_line("[node_bridge] env %s=%s", k, v);
      } else {
        log_line("[node_bridge] env %s 设置失败 errno=%d", k, errno);
      }
    } else if (line[0] != 0) {
      log_line("[node_bridge] env 行格式非法（缺 '='），已跳过: %s", line);
    }
    line = split_next(&cursor, '\n');
  }
}

static void *bootstrap(void *arg) {
  bridge_ctx *ctx = (bridge_ctx *)arg;
  log_line("[node_bridge] thread start; tid=%ld", (long)syscall(SYS_gettid));

  /* ── ① stdio：日志 fd + fd0/1/2 重建 + 排空线程 ───────────────────────── */
  set_stage("stdio");
  g_log_fd = open_log_fd();
  if (g_log_fd < 0) {
    set_error("无法打开日志文件 %s（errno=%d）", ctx->log, errno);
    OH_LOG_Print(LOG_APP, LOG_ERROR, LOG_DOMAIN, LOG_TAG, "cannot open log: %{public}s", ctx->log);
    set_stage("exited");  /* A6：早退也必须落到终态 ⇒ waitUntilRunning 的 exited 快路径才可达 */
    return NULL;
  }
  redirect_stdin_to_devnull();
  if (start_drain_threads() != 0) {
    set_error("stdio pipe/reader 线程建立失败（errno=%d）", errno);
    log_line("[node_bridge] FATAL: stdio 通道建立失败 errno=%d", errno);
    set_stage("exited");
    return NULL;
  }

  /* ── ② 平台前置：SIGSYS shim + 环境契约（§5.6） ──────────────────────── */
  install_sigsys_shim();
  setenv("UV_USE_IO_URING", "0", 1);
  setenv("HOME", ctx->home, 1);
  setenv("USERPROFILE", ctx->home, 1);
  setenv("TMPDIR", ctx->tmp, 1);
  setenv("TMP", ctx->tmp, 1);
  setenv("TEMP", ctx->tmp, 1);
  setenv("NODE_ENV", "production", 1);
  unsetenv("NODE_OPTIONS");
  apply_env_pairs(ctx->envpairs);

  {
    /*
     * io_uring 探针（§4.2 ③）：只用于回答「本机是否被 seccomp trap」。
     * ⚠️ 内核在**成功**路径会 `copy_to_user` 回写整个 `struct io_uring_params`（120 B）；
     * 只传一个 8 字节指针会造成**栈越界写**（本机 `io_uring_setup` 返回正数，正走这条路径）。
     * 因此按真实大小留缓冲；并把返回的 fd 关掉（否则泄漏）。
     */
    static unsigned char params[128];
    memset(params, 0, sizeof(params));
    errno = 0;
    long rc = syscall(425 /*__NR_io_uring_setup*/, 8u, params);
    int probe_errno = errno;
    if (rc >= 0) close((int)rc);
    /* A9：shim 在探针**之前**已装好（install_sigsys_shim 在上方），所以 rc<0 并不能证明
     * 「shim 生效」—— 内核也可能直接返回 ENOSYS/EPERM。只如实标注「探针前已装甲」+ 原始 rc/errno。 */
    log_line("[node_bridge] io_uring_setup(425) -> %ld (errno=%d) shim=%s", rc, probe_errno,
             rc < 0 ? "shim-armed-before-probe(rc<0 可能是 seccomp trap / ENOSYS / EPERM，看原始 rc+errno)"
                    : "not-triggered-on-this-device");
  }

  /* ── ③ dlopen：真机上**只有裸名能成功**（HAP 内库实际落 /data/storage/el1/bundle/libs/arm64/） */
  set_stage("dlopen");
  char cand[4][640];
  int nc = 0;
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libs/arm64-v8a/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "%s/libs/arm64/libnode.so", ctx->lib_dir);
  snprintf(cand[nc++], sizeof(cand[0]), "libnode.so");

  void *h = NULL;
  char tried[4 * 700];
  tried[0] = 0;
  for (int i = 0; i < nc; i++) {
    h = dlopen(cand[i], RTLD_NOW | RTLD_GLOBAL);  /* GLOBAL：让后续原生 addon 能解析 napi_* */
    log_line("[node_bridge] dlopen('%s') -> %s", cand[i], h ? "OK" : dlerror());
    if (h) break;
    strncat(tried, cand[i], sizeof(tried) - strlen(tried) - 2);
    strncat(tried, " ", sizeof(tried) - strlen(tried) - 2);
  }
  if (!h) {
    set_error("libnode.so 加载失败（已试：%s）——请确认已用 tools/provision.mjs 投放运行时", tried);
    log_line("[node_bridge] FATAL: %s", g_last_error);
    set_stage("exited");  /* A6 */
    return NULL;
  }

  /* ── ④ dlsym ─────────────────────────────────────────────────────────── */
  set_stage("dlsym");
  node_start_fn start = (node_start_fn)dlsym(h, "_ZN4node5StartEiPPc");
  log_line("[node_bridge] dlsym(node::Start) -> %p", (void *)start);
  if (!start) {
    set_error("dlsym(node::Start) 失败：%s（产物可能不是 --shared 构建）", dlerror());
    log_line("[node_bridge] FATAL: %s", g_last_error);
    set_stage("exited");  /* A6 */
    return NULL;
  }

  /* ── ⑤ argv：argc **不含**尾部 NULL 哨兵（多算一个 ⇒ Node 拿到 NULL ⇒ 5 ms 内段错误） ── */
  static char argv0[] = "node";
  static char argbuf[MAX_ARGS][512];
  char *argv[MAX_ARGS + 1];
  int argc = 0;
  argv[argc++] = argv0;
  {
    static char f[sizeof(g_ctx.flags)];
    snprintf(f, sizeof(f), "%s", ctx->flags);
    char *cursor = f;
    char *tok = split_next(&cursor, ' ');
    while (tok && argc < MAX_ARGS - 1) {
      snprintf(argbuf[argc], sizeof(argbuf[0]), "%s", tok);
      argv[argc] = argbuf[argc];
      argc++;
      tok = split_next(&cursor, ' ');
    }
    if (tok) log_line("[node_bridge] WARN: argv 超过上限（%d），多余参数被丢弃", MAX_ARGS - 1);
  }
  snprintf(argbuf[argc], sizeof(argbuf[0]), "%s", ctx->script);
  argv[argc] = argbuf[argc];
  argc++;
  argv[argc] = NULL;

  for (int i = 0; i < argc; i++) log_line("[node_bridge] argv[%d]=%s", i, argv[i]);
  log_line("[node_bridge] calling node::Start(argc=%d) ...", argc);
  set_stage("start");
  g_node_running = 1;

  int rc = start(argc, argv);

  g_node_running = 0;
  set_stage("exited");
  log_line("[node_bridge] node::Start returned rc=%d errno=%d（正常应只在退出时返回）", rc, errno);
  return NULL;
}

/* --------------------------------------------------------- NAPI 接口 ---- */

/**
 * start(libDir, scriptPath, flags, home, logPath, envPairs) -> number
 *   0  = 已投递（Node 在后台线程启动中）
 *  >0  = pthread_create 的错误码
 *  -1  = 已投递过（`node::Start` 每进程一次；ArkTS 侧是第一道保护，这里是第二道）
 *  -2  = 入参校验失败（路径类参数被截断 / 必填项为空 / 类型不对；细节见 lastError()）
 */
/*
 * 取一个 NAPI 字符串参数到固定缓冲。
 *   0  = 成功（参数缺席也算成功，缺省值由调用方兜底）
 *  -1  = 类型不对 / 读取失败（已写 lastError）
 *   1  = 成功但被截断（已写 lastError 并落一条 sys 行：截断后继续会得到半截值，比直接失败更难查）
 */
static int get_str_arg(napi_env env, napi_value *argv, size_t argc, size_t idx,
                       char *dest, size_t cap, const char *name) {
  if (dest == NULL || cap == 0) return -1;
  dest[0] = 0;
  if (idx >= argc) return 0;
  /*
   * A7：先问「需要多少字节」再判断是否截断。旧写法只看**写入长度** `len >= cap-1`，
   * 把「恰好填满缓冲（零截断）」误报成截断，而真正的截断反而看不出来。
   * NAPI 允许 buf=NULL/bufsize=0 只取长度（不含 NUL）。
   */
  size_t needed = 0;
  napi_status st = napi_get_value_string_utf8(env, argv[idx], NULL, 0, &needed);
  if (st != napi_ok) {
    set_error("参数 %s 不是字符串（napi_status=%d）", name, (int)st);
    return -1;
  }
  size_t len = 0;
  st = napi_get_value_string_utf8(env, argv[idx], dest, cap, &len);
  if (st != napi_ok) {
    dest[0] = 0;
    set_error("参数 %s 读取失败（napi_status=%d）", name, (int)st);
    return -1;
  }
  if (needed > cap - 1) {
    /*
     * A1：截断必须可见。这里写 lastError + 一条 sys 行，**指名参数与实际字节上限**；
     * 调用方（js_start）再按参数类型决定是致命还是「记日志后继续」。
     * 注意这一行的 write_line 可能因为 g_log_path 还没建立而只进 hilog ——
     * js_start 在 g_log_path 建立后会再补一条汇总 sys 行（不依赖 lastError 的存活）。
     */
    set_error("参数 %s 过长（需 %d 字节，上限 %d），已截断", name, (int)needed, (int)(cap - 1));
    log_line("[node_bridge] WARN: 参数 %s 过长（需 %d 字节，上限 %d），已截断",
             name, (int)needed, (int)(cap - 1));
    return 1;
  }
  return 0;
}

static napi_value js_start(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value out;
  if (g_dispatched) {
    set_error("Node 只能启动一次（node::Start 每进程一次），本次调用被拒绝");
    log_line("[node_bridge] %s", g_last_error);
    napi_create_int32(env, -1, &out);
    return out;
  }

  /*
   * 入参校验：**不允许静默接受非法调用**（宪法 C2）。非法即返回 -2 并留下 lastError()。
   * 必填项：libDir（`dlopen` 候选链基点）、scriptPath（入口绝对路径）、home、logPath。
   * 为什么原生侧也要校验：ArkTS 侧是第一道保护，但「唯一一次启动机会」被非法参数白白消耗之后，
   * 上层拿不到任何结构化原因 —— 那正是旧壳最典型的事故形态（附录 B 第 5/13 条）。
   */
  memset(&g_ctx, 0, sizeof(g_ctx));
  /*
   * A1：`get_str_arg` 返回 1 = 已截断。旧代码只判 `< 0`，截断于是完全不可见：
   * 半截值被当成正常参数用下去（例如被切短的 NODE_BRIDGE_ARCHIVE 让载荷以
   * 一句与真因无关的错误硬失败）。这里按参数类型分流：
   *   · 路径类（libDir/scriptPath/home/logPath）⇒ **致命**，返回 -2，lastError 已指名参数与字节上限；
   *   · flags/envPairs ⇒ 允许截断后继续，但必须留下可见证据（get_str_arg 已写 sys 行 +
   *     lastError；下面在 g_log_path 建立后再补一条汇总行，防止被成功路径的 lastError 清理抹掉）。
   */
  int bad = 0;
  int trunc_path = 0;  /* 路径类参数被截断 */
  int trunc_soft = 0;  /* flags/envPairs 被截断 */
  int r;
  r = get_str_arg(env, argv, argc, 0, g_ctx.lib_dir, sizeof(g_ctx.lib_dir), "libDir");
  if (r < 0) bad = 1; else if (r == 1) { bad = 1; trunc_path = 1; }
  r = get_str_arg(env, argv, argc, 1, g_ctx.script, sizeof(g_ctx.script), "scriptPath");
  if (r < 0) bad = 1; else if (r == 1) { bad = 1; trunc_path = 1; }
  r = get_str_arg(env, argv, argc, 2, g_ctx.flags, sizeof(g_ctx.flags), "flags");
  if (r < 0) bad = 1; else if (r == 1) trunc_soft = 1;
  r = get_str_arg(env, argv, argc, 3, g_ctx.home, sizeof(g_ctx.home), "home");
  if (r < 0) bad = 1; else if (r == 1) { bad = 1; trunc_path = 1; }
  r = get_str_arg(env, argv, argc, 4, g_ctx.log, sizeof(g_ctx.log), "logPath");
  if (r < 0) bad = 1; else if (r == 1) { bad = 1; trunc_path = 1; }
  r = get_str_arg(env, argv, argc, 5, g_ctx.envpairs, sizeof(g_ctx.envpairs), "envPairs");
  if (r < 0) bad = 1; else if (r == 1) trunc_soft = 1;
  if (bad || g_ctx.script[0] == 0 || g_ctx.home[0] == 0 || g_ctx.log[0] == 0) {
    if (!bad) {
      set_error("scriptPath/home/logPath 不能为空（script='%s' home='%s' log='%s'）",
                g_ctx.script, g_ctx.home, g_ctx.log);
    } else if (trunc_path) {
      /* 让「哪一类参数、为什么拒」在日志里自解释（lastError 只保留最后一个被截断的参数名） */
      log_line("[node_bridge] FATAL: 路径类参数被截断（上限=%d/%d/%d/%d 字节）⇒ 拒绝启动，避免用半截路径",
               (int)sizeof(g_ctx.lib_dir) - 1, (int)sizeof(g_ctx.script) - 1,
               (int)sizeof(g_ctx.home) - 1, (int)sizeof(g_ctx.log) - 1);
    }
    log_line("[node_bridge] start() 参数校验失败：%s", g_last_error);
    napi_create_int32(env, -2, &out);
    return out;
  }

  if (g_ctx.flags[0] == 0) snprintf(g_ctx.flags, sizeof(g_ctx.flags), "%s", "--no-verify-heap");
  snprintf(g_ctx.tmp, sizeof(g_ctx.tmp), "%s/tmp", g_ctx.home);
  snprintf(g_log_path, sizeof(g_log_path), "%s", g_ctx.log);

  /*
   * A1：软截断（flags/envPairs）的**汇总证据**。必须在 g_log_path 建立之后写，
   * 这样即使成功路径随后清空 lastError，磁盘上的 sys 行仍然留着（截断不可被抹掉）。
   */
  if (trunc_soft) {
    log_line("[node_bridge] WARN: flags/envPairs 按截断值继续（上限 flags=%d 字节 / envPairs=%d 字节；"
             "路径类参数被截断会直接失败）",
             (int)sizeof(g_ctx.flags) - 1, (int)sizeof(g_ctx.envpairs) - 1);
  }

  /* 崩溃记录落点（契约 §1.4）：<home>/node-bridge/last-crash.json */
  snprintf(g_crash_path, sizeof(g_crash_path), "%s/node-bridge/last-crash.json", g_ctx.home);
  {
    char dir[LOG_PATH_LEN];
    snprintf(dir, sizeof(dir), "%s/node-bridge", g_ctx.home);
    if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
      /* 目录建不出来 ⇒ 崩溃证据会静默丢失。必须说出来（C6：诊断优先）。 */
      log_line("[node_bridge] WARN: mkdir(%s) 失败 errno=%d ⇒ 崩溃记录将无法落盘", dir, errno);
    }
  }
  if (mkdir(g_ctx.tmp, 0755) != 0 && errno != EEXIST) {
    log_line("[node_bridge] WARN: mkdir(%s) 失败 errno=%d ⇒ 载荷用 TMPDIR 可能 ENOENT", g_ctx.tmp, errno);
  }

  install_crash_handlers();

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 32 * 1024 * 1024);  /* UI 线程外、32 MB 栈：§5.10 ① */
  pthread_t th;
  /*
   * A2：`g_last_error` 必须在 **pthread_create 之前**清空，绝不在之后清。
   * 为什么：bootstrap 线程可能在 pthread_create 返回后立刻跑起来并 set_error
   * （最实际的是「无法打开日志文件 …」）——此时若在创建成功后清空，
   * 宿主看到的是 `ok:true` + 空 lastError，等到 15 s 超时也拿不到主因（C2 的静默失败）。
   */
  g_last_error[0] = 0;
  int rc = pthread_create(&th, &attr, bootstrap, &g_ctx);
  pthread_attr_destroy(&attr);

  if (rc != 0) {
    set_error("pthread_create 失败 rc=%d（内存不足？栈需 32 MB）", rc);
    log_line("[node_bridge] %s", g_last_error);
    g_log_path[0] = 0;
    napi_create_int32(env, rc, &out);
    return out;
  }
  pthread_detach(th);  /* detached：Node 自己管理生命周期，不阻塞 UI 线程退出 */
  g_dispatched = 1;
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
  napi_create_string_utf8(env, "node_bridge/0.2.0 (ohos-node-bridge Phase 1)", NAPI_AUTO_LENGTH, &out);
  return out;
}

/* 最近一次原生层失败原因；无失败返回 "" —— ArkTS 侧必须能看到（C2） */
static napi_value js_last_error(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_string_utf8(env, g_last_error, NAPI_AUTO_LENGTH, &out);
  return out;
}

/* 当前阶段：init|stdio|dlopen|dlsym|start|running|exited */
static napi_value js_stage(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_string_utf8(env, g_stage, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"start", NULL, js_start, NULL, NULL, NULL, napi_default, NULL},
    {"isRunning", NULL, js_is_running, NULL, NULL, NULL, napi_default, NULL},
    {"version", NULL, js_version, NULL, NULL, NULL, napi_default, NULL},
    {"lastError", NULL, js_last_error, NULL, NULL, NULL, napi_default, NULL},
    {"stage", NULL, js_stage, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(node_bridge, Init)
