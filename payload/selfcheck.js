/*
 * selfcheck.js —— 端到端自检（契约 §3.6；继承 Phase 0 探针 `probe.js` 的口径）
 *
 * 目的：一条命令回答「这台设备的这个进程里，Node 到底能用什么」。
 * 用法：把本文件作为 scriptPath 启动（或作为 bootstrap 的 NODE_BRIDGE_ENTRY），然后
 *   hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts
 *
 * 判定基线（真机实测，规划 §D.8 / §D.10）：
 *   - 无 ACL 且不带 --jitless ⇒ 启动即 SIGTRAP（不是脚本问题）；`--jitless` 下 `WebAssembly is not defined`；
 *   - 有 ACL ⇒ `wasm.validate === true`，热循环 6–9 ms / 2e6（解释器基线约 59 ms/2e6）；
 *   - `spawn('/system/bin/sh')` 完整可用（data/exit/close 全送达、无僵尸）；
 *   - `os.cpus()` 长度 0（版本/并发探测不得依赖它）。
 *
 * 纪律：
 *   - 端点只有 4 个：`/facts` `/log` `/rport` `/diag`，其余 404；
 *   - 只绑 `127.0.0.1`（不得 0.0.0.0）；端口 `SELFCHECK_PORT`，默认 15577（文档化取证契约）；
 *     15577 被占用 ⇒ 回退到内核临时端口，并打印 `[selfcheck] WARN 15577 被占用 → 改用 <port>`；
 *   - **任何检查项都不允许把异常漏出去**：进程内 Node 的未捕获异常 = 整个 App abort（D.10 ⑰）。
 *   - 诊断面不是产品面：同设备其他应用也能访问 loopback 端口，发布构建应关闭自检端点（FR-004-040）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
/** 文档化的诊断端口：所有真机命令都写 `hdc fport tcp:15577` + `curl`（契约 §3.6） */
const DEFAULT_PORT = 15577;
const rawPort = Number(process.env.SELFCHECK_PORT || DEFAULT_PORT);
/** 用户显式给 `SELFCHECK_PORT` 时以它为准（非法值回落默认端口） */
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT;
/** `/facts` 单次请求内 spawn 探针的超时（子进程不回来也不能让端点挂死） */
const SPAWN_TIMEOUT_MS = 5000;
/** `/rport` 转发上游的超时 */
const RPORT_TIMEOUT_MS = 10000;
const LOG_TAIL_CHARS = 8192;
const APP_LOG_TAIL_CHARS = 4096;

function messageOf(err) {
  try {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/** 载荷根（`/log` `/diag` 的读回目标）：固定 `<HOME>/payload`，与原生层 `logPath` 默认值一致（契约 §3.6） */
function payloadDir() {
  return path.join(homeDir(), 'payload');
}

/** 尾部读回：失败返回 null（调用方给占位串），**永不抛** */
function tailText(file, chars) {
  try {
    return fs.readFileSync(file, 'utf8').slice(-chars);
  } catch (_) {
    return null;
  }
}

/** 自我保护：兜底只记录、**不** process.exit（D.10 ⑱；与 bootstrap 同一纪律） */
function installSelfGuard() {
  const onError = (kind) => (value) => {
    try {
      const line = '[' + new Date().toISOString() + '] ' + kind + ' ' + messageOf(value) +
        (value && value.stack ? '\n' + value.stack : '') + '\n';
      const appLog = path.join(payloadDir(), 'app.log');
      try {
        fs.mkdirSync(path.dirname(appLog), { recursive: true });
        fs.appendFileSync(appLog, line);
      } catch (_) { /* 独立通道不可写：只剩 stderr */ }
      process.stderr.write('[selfcheck] ' + kind + ' ' + messageOf(value) + '\n' + (value && value.stack ? value.stack + '\n' : ''));
    } catch (_) { /* 兜底自身绝不抛 */ }
  };
  try {
    process.on('uncaughtException', onError('uncaughtException'));
    process.on('unhandledRejection', onError('unhandledRejection'));
  } catch (_) { /* 忽略 */ }
}

/** 单项检查的同步包装：单值失败编码为 'ERR:<message>'（规格 FR-004-035） */
function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    return 'ERR:' + messageOf(err);
  }
}

/**
 * spawn 探针（规划 §D.8）：报文含 `{pid, stdout, events:{data,exit,close}, zombie}`。
 * 全程包在 Promise 里 + 5 s 超时 + 三个事件各自兜底，**任何路径都不许冒泡成未捕获异常**。
 * `zombie` 判据 = 「既没拿到 exit 也没拿到 close」（真机实测的「无僵尸」口径）；
 * `procState` 是 /proc 可读时的佐证，读不到如实返回 null（不谎报 false）。
 */
function probeSpawn() {
  return new Promise((resolve) => {
    const events = { data: false, exit: false, close: false };
    let pid = null;
    let exitInfo = null;
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child = null;
    const chunks = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const out = {
        pid,
        stdout,
        events,
        zombie: !(events.exit && events.close),
        procState: procStateOf(pid),
      };
      if (exitInfo) {
        out.exitCode = exitInfo.code;
        out.signal = exitInfo.signal;
      }
      if (spawnError) out.error = 'ERR:' + messageOf(spawnError);
      if (timedOut) out.timeoutMs = SPAWN_TIMEOUT_MS;
      resolve(out);
    };

    try {
      const { spawn } = require('child_process');
      child = spawn('/system/bin/sh', ['-c', 'echo SPAWN_OK; id']);
      pid = child.pid === undefined ? null : child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_) { /* 子进程可能已退出 */ }
        finish();
      }, SPAWN_TIMEOUT_MS);

      if (child.stdout) {
        child.stdout.on('data', (buf) => { events.data = true; chunks.push(Buffer.from(buf)); });
        child.stdout.on('error', () => { /* 管道异常不应逃逸 */ });
      }
      child.on('error', (err) => { spawnError = err; finish(); });
      child.on('exit', (code, signal) => { events.exit = true; exitInfo = { code, signal }; });
      child.on('close', () => { events.close = true; finish(); });
    } catch (err) {
      spawnError = err;
      finish();
    }
  });
}

/** 读 /proc/<pid>/stat 的进程状态字符；不可读（已回收/无权限）返回 null */
function procStateOf(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2);
    return rest.charAt(0) || null;
  } catch (_) {
    return null;
  }
}

/** `os.homedir()/os.tmpdir()` 是否落在原生层重定向的 HOME/TMPDIR 内（§5.6 重定向断言） */
function redirected(actual, want) {
  if (typeof want !== 'string' || want.length === 0) return false;
  return typeof actual === 'string' && actual.startsWith(want);
}

/** 16 项冻结检查（键名不得增删，契约 §3.6） */
async function buildChecks() {
  return {
    node: attempt(() => process.version),
    platform: attempt(() => process.platform),
    arch: attempt(() => process.arch),
    execArgv: attempt(() => process.execArgv),
    versions: attempt(() => process.versions),
    homedir: attempt(() => os.homedir()),
    tmpdir: attempt(() => os.tmpdir()),
    homedir_redirected: attempt(() => redirected(os.homedir(), process.env.HOME)),
    tmpdir_redirected: attempt(() => redirected(os.tmpdir(), process.env.TMPDIR)),
    netifaces: attempt(() => Object.keys(os.networkInterfaces() || {})),
    cpus: attempt(() => os.cpus().length),
    spawn: await probeSpawn(),
    'wasm.validate': attempt(() => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
    'wasm.error': attempt(() => (typeof WebAssembly === 'undefined' ? 'WebAssembly is not defined' : '')),
    fs_write_readback: attempt(() => {
      // C3「谁写谁读」：写出去必须自己读回来，不许只有「写成功」的断言
      const p = path.join(os.tmpdir(), 'selfcheck.txt');
      fs.writeFileSync(p, 'ok');
      const back = fs.readFileSync(p, 'utf8');
      fs.unlinkSync(p);
      return back === 'ok' ? 'OK' : 'MISMATCH';
    }),
    hotloop_ms_5rounds: attempt(() => {
      const t0 = Date.now();
      let acc = 0;
      for (let i = 0; i < 2e6; i += 1) {
        acc += (i * 31) % 7;
      }
      return Date.now() - t0;
    }),
  };
}

// ── 端点 ─────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (_) { /* 客户端已断开 */ }
}

function sendText(res, status, text) {
  try {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  } catch (_) { /* 客户端已断开 */ }
}

async function handleFacts(res) {
  try {
    const checks = await buildChecks();
    sendJson(res, 200, { at: new Date().toISOString(), checks });
  } catch (err) {
    // 理论不可达（每项都包了）；真到了也必须可见，不许静默空响应
    sendText(res, 500, 'facts failed: ' + messageOf(err));
  }
}

function handleLog(res) {
  const logPath = path.join(payloadDir(), 'node.log');
  const text = tailText(logPath, LOG_TAIL_CHARS);
  sendText(res, 200, text === null ? '(read failed: ' + logPath + ' 不可读)' : text);
}

function handleDiag(res) {
  const appLogTail = tailText(path.join(payloadDir(), 'app.log'), APP_LOG_TAIL_CHARS);
  sendJson(res, 200, {
    at: new Date().toISOString(),
    lastError: globalThis.__nodeBridgeLastError === undefined ? null : globalThis.__nodeBridgeLastError,
    appLogTail,
    hostBridge: hostBridgeDiag(),
  });
}

/** 宿主桥诊断：require 失败也要给出结构化说明（不静默） */
function hostBridgeDiag() {
  try {
    const host = require('./host.js');
    return {
      transport: host.getTransport() ? 'custom' : 'unavailable',
      handles: host.list(),
    };
  } catch (err) {
    return { transport: 'unavailable', handles: [], error: 'ERR:' + messageOf(err) };
  }
}

/** `/rport`：把请求体原文转发到 127.0.0.1:${RPORT_PORT||19999}（第三条取证通道） */
function handleRport(req, res) {
  const port = Number(process.env.RPORT_PORT || 19999);
  const chunks = [];
  let size = 0;
  let replied = false;
  const fail502 = (text) => {
    if (replied) return;
    replied = true;
    sendText(res, 502, text);
  };

  req.on('error', (err) => fail502('request error: ' + messageOf(err)));
  req.on('data', (buf) => {
    chunks.push(buf);
    size += buf.length;
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks, size);
    let upstream;
    try {
      upstream = http.request({
        host: '127.0.0.1',
        port,
        path: req.url || '/rport',
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] || 'text/plain',
          'Content-Length': body.length,
        },
      }, (upRes) => {
        const parts = [];
        let n = 0;
        upRes.on('data', (buf) => { parts.push(buf); n += buf.length; });
        upRes.on('error', (err) => fail502('upstream response error: ' + messageOf(err)));
        upRes.on('end', () => {
          if (replied) return;
          const text = Buffer.concat(parts, n).toString('utf8');
          const code = upRes.statusCode || 0;
          if (code >= 200 && code < 300) {
            replied = true;
            sendText(res, 200, text);
          } else {
            fail502('upstream ' + code + ': ' + text);
          }
        });
      });
    } catch (err) {
      fail502('upstream error 127.0.0.1:' + port + ': ' + messageOf(err));
      return;
    }
    upstream.setTimeout(RPORT_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream timeout ' + RPORT_TIMEOUT_MS + 'ms'));
    });
    upstream.on('error', (err) => fail502('upstream error 127.0.0.1:' + port + ': ' + messageOf(err)));
    upstream.end(body);
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/facts') {
      handleFacts(res);
      return;
    }
    if (req.method === 'GET' && url === '/log') {
      handleLog(res);
      return;
    }
    if (req.method === 'POST' && url === '/rport') {
      handleRport(req, res);
      return;
    }
    if (req.method === 'GET' && url === '/diag') {
      handleDiag(res);
      return;
    }
    sendText(res, 404, 'not found');
  } catch (err) {
    // 请求处理里的同步异常绝不能逃逸成未捕获异常（D.10 ⑰）
    sendText(res, 500, 'handler error: ' + messageOf(err));
  }
});

/** 实际监听端口（EADDRINUSE 回退后是内核分配的临时端口）；诊断输出必须报真值 */
let listeningPort = PORT;
/** 是否已因默认端口被占用而回退到临时端口 */
let fellBack = false;

function listen(port) {
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const chosen = addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : port;
    listeningPort = chosen;
    if (fellBack) {
      // C3：端口被占用是**必须让人看见**的诊断事件（否则「curl 连不上」会被误判成 Node 没起来）
      process.stdout.write('[selfcheck] WARN ' + PORT + ' 被占用 → 改用 ' + chosen + '\n');
    }
    process.stdout.write('[selfcheck] listening 127.0.0.1:' + chosen + '\n');
  });
}

server.on('error', (err) => {
  // 端口占用（§D.10 ⑰ 的实测事故形态）：写日志，绝不抛。
  // C3：留在 15577 上反复重试 = 每次都撞占用端口，静默换端口 = 取证命令失效 ⇒
  //     回退一次到内核临时端口，并大声报出新端口。
  if (err && err.code === 'EADDRINUSE' && !fellBack) {
    fellBack = true;
    process.stderr.write('[selfcheck] WARN ' + PORT + ' 被占用（EADDRINUSE）→ 改用临时端口\n');
    listen(0);
    return;
  }
  process.stderr.write('[selfcheck] ERROR 服务错误 port=' + listeningPort + ' err=' + messageOf(err) + '\n');
});

installSelfGuard();
listen(PORT);
