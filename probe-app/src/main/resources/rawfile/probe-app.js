/*
 * probe-app.js —— PRB 探针载荷（specs/101-probe-app）。
 *
 * 与库自带 `payload/selfcheck.js` 的分工（不要混用）：
 *   · `payload/selfcheck.js` = **契约冻结**的四端点 + 16 个 checks 键，由 tests 做漂移检查；
 *   · 本文件 = **PRB 探针载荷**：换/加键不碰契约。本文件把契约 §3.6 的 16 冻结键原样承载
 *     （键名一字不差，见 buildChecks()），并额外承载 PRB-04 的宿主桥往返。
 *
 * 职责：
 *   ① loopback HTTP 服务（GET /facts、/log、/diag；POST /rport 复验通道），只绑 127.0.0.1，
 *      默认端口 PROBE_PORT（页面传 15577）。EADDRINUSE 回退临时端口并打印 `[probe] WARN`（C2）。
 *   ② 宿主桥往返（PRB-04 的 Node 半边）：process.env.PROBE_MAILBOX_DIR 非空时
 *      host.useFileMailbox(dir) → host.handle('probe.echo') → host.invoke('probe.echo', {ping})，
 *      结果写进 /facts 的 checks.host_roundtrip；POST /rport 就地再做一次新的往返并回给客户端。
 *   ③ 任何检查项异常都不许漏成未捕获异常（D.10 ⑰）：单项包进 attempt()，服务层包 try/catch。
 *
 * 判据见 specs/101-probe-app/test-cases.md §1（PRB-03/04/05）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 15577;
const rawPort = Number(process.env.PROBE_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT;
const MAILBOX_DIR = process.env.PROBE_MAILBOX_DIR || '';
const LOG_TAIL_CHARS = 8192;

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

function payloadDir() {
  return path.join(homeDir(), 'payload');
}

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
      process.stderr.write('[probe-app] ' + kind + ' ' + messageOf(value) + '\n');
    } catch (_) { /* 兜底自身绝不抛 */ }
  };
  try {
    process.on('uncaughtException', onError('uncaughtException'));
    process.on('unhandledRejection', onError('unhandledRejection'));
  } catch (_) { /* 忽略 */ }
}

function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    return 'ERR:' + messageOf(err);
  }
}

function redirected(actual, want) {
  if (typeof want !== 'string' || want.length === 0) return false;
  return typeof actual === 'string' && actual.startsWith(want);
}

function probeSpawn() {
  return new Promise((resolve) => {
    const events = { data: false, exit: false, close: false };
    let pid = null;
    let exitInfo = null;
    let spawnError = null;
    let settled = false;
    let child = null;
    const chunks = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      const out = {
        pid,
        stdout: Buffer.concat(chunks).toString('utf8'),
        events,
        zombie: !(events.exit && events.close),
      };
      if (exitInfo) {
        out.exitCode = exitInfo.code;
        out.signal = exitInfo.signal;
      }
      if (spawnError) out.error = 'ERR:' + messageOf(spawnError);
      resolve(out);
    };
    try {
      const { spawn } = require('child_process');
      child = spawn('/system/bin/sh', ['-c', 'echo SPAWN_OK; id']);
      pid = child.pid === undefined ? null : child.pid;
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
        finish();
      }, 5000);
      if (child.stdout) {
        child.stdout.on('data', (buf) => { events.data = true; chunks.push(Buffer.from(buf)); });
        child.stdout.on('error', () => { /* 不逃逸 */ });
      }
      child.on('error', (err) => { spawnError = err; clearTimeout(timer); finish(); });
      child.on('exit', (code, signal) => { events.exit = true; exitInfo = { code, signal }; });
      child.on('close', () => { events.close = true; clearTimeout(timer); finish(); });
    } catch (err) {
      spawnError = err;
      finish();
    }
  });
}

/* ── 宿主桥往返（PRB-04 Node 半边）────────────────────────────────────── */
const host = MAILBOX_DIR.length > 0 ? require('./host.js') : null;
/** 往返状态：null = 未接线 | {ok, wired, reply, err} */
const roundtrip = { wired: false, ok: false, reply: null, err: null };

function wireBridge() {
  if (host === null || MAILBOX_DIR.length === 0) {
    roundtrip.err = 'PROBE_MAILBOX_DIR 未设置（未接线）';
    return;
  }
  const res = host.useFileMailbox(MAILBOX_DIR, { pollMs: 100 });
  if (!res.ok || res.ok !== true) {
    roundtrip.err = 'mailbox-unavailable:' + String(res.error) + ':' + String(res.detail);
    return;
  }
  roundtrip.wired = true;
  try {
    host.handle('probe.echo', async (payload) => {
      // Node 侧钩子：把收到的内容原样回（等价 ArkTS 侧 echo 的另一半）
      return JSON.stringify({ echo: 'node', ping: 'pong', received: payload });
    });
  } catch (e) {
    roundtrip.err = 'handle-failed:' + messageOf(e);
  }
}

/** 做一次文件信箱往返；返回结构化结果（绝不抛） */
async function runRoundtrip() {
  if (host === null || !roundtrip.wired) {
    return { ok: false, wired: false, err: roundtrip.err || 'transport-unavailable' };
  }
  try {
    const reply = await host.invoke('probe.echo', { ping: 'pong', ts: Date.now() }, { timeoutMs: 8000 });
    // C3：写出去必须自己读回来 —— invoke 返回的 reply 必须是宿主回声的实证
    const ok = reply === null ? false :
      (typeof reply === 'object' && reply.ping === 'pong');
    return { ok, wired: true, reply, err: ok ? null : 'reply-mismatch' };
  } catch (err) {
    return { ok: false, wired: true, err: 'invoke:' + String(err && err.error) + ':' + messageOf(err) };
  }
}

/* ── 16 冻结键（契约 §3.6 键名一字不改）＋ host_roundtrip 扩展键 ─────────── */
async function buildChecks() {
  const checks = {
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
      const p = path.join(os.tmpdir(), 'probe-app-selfcheck.txt');
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
  checks.host_roundtrip = await runRoundtrip();
  return checks;
}

/* ── 端点 ─────────────────────────────────────────────────────────────── */
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
    sendText(res, 500, 'facts failed: ' + messageOf(err));
  }
}

function handleLog(res) {
  const text = (() => {
    try { return fs.readFileSync(path.join(payloadDir(), 'node.log'), 'utf8').slice(-LOG_TAIL_CHARS); }
    catch (e) { return '(read failed: ' + messageOf(e) + ')'; }
  })();
  sendText(res, 200, text);
}

function handleDiag(res) {
  const hostBridgeDiag = (() => {
    if (host === null) return { transport: 'unavailable', notes: 'host.js 未加载（PROBE_MAILBOX_DIR 未设置）' };
    return {
      transport: host.getTransport() ? 'custom' : 'mailbox',
      mailbox: host.mailboxInfo(),
      handles: host.list(),
      roundtrip: { wired: roundtrip.wired, ok: roundtrip.ok, err: roundtrip.err },
    };
  })();
  sendJson(res, 200, { at: new Date().toISOString(), hostBridge: hostBridgeDiag });
}

/** /rport：显式触发一次新的 roundtrip 并回给客户端（PRB-04 复验通道；等价转发语义） */
async function handleRport(req, res) {
  const chunks = [];
  req.on('data', (buf) => chunks.push(buf));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const reply = await runRoundtrip();
    const payload = { path: '/rport', sent: body.length, roundtrip: reply };
    if (reply && reply.ok === true) {
      sendJson(res, 200, payload);
    } else {
      sendJson(res, 502, payload);
    }
  });
  req.on('error', (err) => sendText(res, 502, 'request error: ' + messageOf(err)));
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
    if (req.method === 'GET' && url === '/diag') {
      handleDiag(res);
      return;
    }
    if (req.method === 'POST' && url === '/rport') {
      handleRport(req, res);
      return;
    }
    sendText(res, 404, 'not found');
  } catch (err) {
    sendText(res, 500, 'handler error: ' + messageOf(err));
  }
});

let listeningPort = PORT;
let fellBack = false;

function listen(port) {
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const chosen = addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : port;
    listeningPort = chosen;
    process.stdout.write('[probe-app] listening 127.0.0.1:' + chosen + '\n');
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && !fellBack) {
    fellBack = true;
    process.stderr.write('[probe-app] WARN ' + PORT + ' 被占用（EADDRINUSE）→ 改用临时端口\n');
    listen(0);
    return;
  }
  process.stderr.write('[probe-app] ERROR 服务错误 port=' + listeningPort + ' err=' + messageOf(err) + '\n');
});

wireBridge();
installSelfGuard();
listen(PORT);
// 让 /facts 的 host_roundtrip 在起动后尽快暖一次（同时校验信箱目录可写，尽早暴露 wiring 错误）
if (host !== null && MAILBOX_DIR.length > 0) {
  runRoundtrip().then((r) => {
    roundtrip.ok = r.ok === true;
    if (r.err) roundtrip.err = r.err;
    process.stdout.write('[probe-app] host roundtrip ok=' + r.ok + ' err=' + String(r.err) + '\n');
  });
}
