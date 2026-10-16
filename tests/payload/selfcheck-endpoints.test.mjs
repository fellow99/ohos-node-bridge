// tests/payload/selfcheck-endpoints.test.mjs —— 契约 §3.6（`payload/selfcheck.js` 端点）的 host 侧单测。
//
// 做法：随机空闲端口 + 临时 HOME 起 `payload/selfcheck.js` 子进程，然后**按消费方的方式**取证：
//   GET  /facts  → 200 application/json，{ at, checks:{…} }，checks 键名是冻结的（缺一个都算 DRIFT）
//   GET  /log    → 200 text/plain，正文 = <HOME>/payload/node.log 的尾部（读回通道，C3）
//   POST /rport  → 200 text/plain，把原文转发到 127.0.0.1:${RPORT_PORT}（第三条取证通道）
//   GET  /diag   → 契约 §3.6 的端点表里没有它（只列 /facts /log /rport + 「其它 ⇒ 404」）；
//                  故允许 404（默认）或 200（扩展诊断面），**5xx 一律 FAIL**（端点自己崩了）
//   其它路径      → 404
//
// 端口随机是**硬约束**（§D.10 ⑰：端口冲突 ⇒ 载荷未捕获异常 ⇒ 整个 App 进程 abort），所以这里也不占用 15577。

import { test, assert } from '../lib/mini-assert.mjs';
import { p, makeTmp, rmrf, payloadExists } from '../lib/util.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const SELFCHECK = p('payload', 'selfcheck.js');
const SENTINEL = 'SENTINEL-LOG-LINE-42';
const RPORT_BODY = 'RPORT-FORWARDED-BODY';
const SELFCHECK_HINT = 'MISSING: payload/selfcheck.js — 契约 §3.6 的 /facts /log /rport 端点（本文件全部用例依赖它）';

/** 冻结的 checks 键名（契约 §3.6，逐个不可少、不可改名）。 */
const FROZEN_CHECKS = [
  'node',
  'platform',
  'arch',
  'execArgv',
  'versions',
  'homedir',
  'tmpdir',
  'homedir_redirected',
  'tmpdir_redirected',
  'netifaces',
  'cpus',
  'spawn',
  'wasm.validate',
  'wasm.error',
  'fs_write_readback',
  'hotloop_ms_5rounds',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 第三条取证通道的对端（RPORT_PORT）：收原文 + 回一句 RPORT-ACK。
 *
 * 契约 §3.6 只说「把请求体原文转发到 127.0.0.1:${RPORT_PORT}」，没说用哪种协议；实测消费方那条通道
 * 说的是 HTTP（`pi-web` 的端口），所以这里做**混合对端**：既接受裸 TCP 转发，也接受 HTTP forward
 * （回一个合法的 HTTP/1.1 响应，否则 Node 的 http.request 会报 `Parse Error: Expected HTTP/`）。
 */
function startRportStub() {
  return new Promise((resolve, reject) => {
    const received = [];
    const srv = net.createServer((sock) => {
      let buf = '';
      let done = false;
      let idle = null;
      const reply = () => {
        if (done) return;
        done = true;
        if (idle) clearTimeout(idle);
        received.push(buf);
        const payloadText = 'RPORT-ACK';
        const res =
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${Buffer.byteLength(payloadText)}\r\n` +
          'Connection: close\r\n\r\n' +
          payloadText;
        try {
          sock.end(res);
        } catch {
          /* 对端可能已经关了 */
        }
      };
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(reply, 150); // 静默 150 ms 视为请求已发完（HTTP forward 会等响应）
      };
      arm();
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        arm();
      });
      sock.on('end', reply);
      sock.on('error', reply);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.unref(); // 不把测试进程的 event loop 钉住
      resolve({
        port: srv.address().port,
        received,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

let ctxPromise = null;

/** 懒启动（只起一次）：临时 HOME + 随机端口 + rport 对端。 */
function server() {
  if (!ctxPromise) ctxPromise = start();
  return ctxPromise;
}

async function start() {
  if (!payloadExists('payload/selfcheck.js')) throw new Error(SELFCHECK_HINT);
  const tmp = makeTmp('selfcheck');
  const home = path.join(tmp, 'home');
  mkdirSync(path.join(home, 'payload'), { recursive: true });
  // 预置一行哨兵：/log 必须能把它读回来（C3：写日志的人要提供读回通道）
  writeFileSync(path.join(home, 'payload', 'node.log'), `${SENTINEL}\n`);

  const port = await freePort();
  const rport = await startRportStub();
  const child = spawn(process.execPath, [SELFCHECK], {
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HOME: home,
      SELFCHECK_PORT: String(port),
      RPORT_PORT: String(rport.port),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    out += d.toString('utf8');
  });

  const ctx = { tmp, home, port, rport, child, out: () => out, base: `http://127.0.0.1:${port}`, baseErr: '' };

  const deadline = Date.now() + 8000;
  let ready = false;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${ctx.base}/facts`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        ready = true;
        break;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!ready) {
    const text =
      `自检服务没能在 8 s 内在 127.0.0.1:${port} 就绪（契约 §3.6 / FR-004-037 要求绑定 127.0.0.1）\n` +
      `        child exitCode=${child.exitCode} 最后一次探测错误=${lastErr}\n` +
      `        子进程输出：${JSON.stringify(out)}`;
    await teardown(ctx);
    throw new Error(text);
  }
  return ctx;
}

async function teardown(ctx) {
  try {
    ctx.child.kill('SIGKILL');
  } catch {
    /* 已经退出了 */
  }
  try {
    await ctx.rport.close();
  } catch {
    /* 忽略 */
  }
  rmrf(ctx.tmp);
}

async function req(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', body };
}

test('/facts：200 + application/json + { at, checks } + 冻结的 16 个 checks 键', async () => {
  const ctx = await server();
  const r = await req(ctx.base, '/facts');
  assert(r.status === 200, `GET /facts 期望 200，实际 ${r.status}；正文=${JSON.stringify(r.body.slice(0, 200))}`);
  assert(/application\/json/i.test(r.type), `GET /facts 的 Content-Type 期望 application/json，实际 ${JSON.stringify(r.type)}`);
  let json;
  try {
    json = JSON.parse(r.body);
  } catch (e) {
    throw new Error(`GET /facts 不是合法 JSON：${e && e.message}；正文=${JSON.stringify(r.body.slice(0, 300))}`);
  }
  assert(typeof json.at === 'string' && json.at.length > 0, `GET /facts 的 at 应为非空字符串（契约 §3.6），实际 ${JSON.stringify(json.at)}`);
  assert(json.checks && typeof json.checks === 'object', `GET /facts 缺 checks 对象，实际字段=${JSON.stringify(Object.keys(json))}`);
  const present = Object.keys(json.checks);
  const missingKeys = FROZEN_CHECKS.filter((k) => !present.includes(k));
  assert(
    missingKeys.length === 0,
    `DRIFT: /facts 的 checks 缺冻结键 ${JSON.stringify(missingKeys)}（契约 §3.6；现有键=${JSON.stringify(present)}）`
  );
});

test('/log：200 text/plain，且能读回预置的日志哨兵行', async () => {
  const ctx = await server();
  const r = await req(ctx.base, '/log');
  assert(r.status === 200, `GET /log 期望 200，实际 ${r.status}；正文=${JSON.stringify(r.body.slice(0, 200))}`);
  assert(/text\/plain/i.test(r.type), `GET /log 的 Content-Type 期望 text/plain，实际 ${JSON.stringify(r.type)}`);
  assert(
    r.body.includes(SENTINEL),
    `GET /log 没有读回 <HOME>/payload/node.log 的内容（契约 §3.6 尾部 8192 B；C3 读回通道）。期望含 ${JSON.stringify(SENTINEL)}，实际正文=${JSON.stringify(r.body.slice(-300))}`
  );
});

test('/diag：不得 5xx（契约端点表外 ⇒ 允许 404 或扩展 200）', async () => {
  const ctx = await server();
  const r = await req(ctx.base, '/diag');
  assert(r.status < 500, `GET /diag 返回 ${r.status}（端点内部出错）；正文=${JSON.stringify(r.body.slice(0, 200))}`);
  assert(
    r.status === 404 || r.status === 200,
    `GET /diag 期望 404（契约 §3.6 的「其它 ⇒ 404」）或 200（扩展诊断面），实际 ${r.status}`
  );
  console.log(
    `        （信息）/diag 观测：status=${r.status} content-type=${JSON.stringify(r.type)} body=${JSON.stringify(r.body.slice(0, 120))}`
  );
});

test('/rport：200 text/plain，且请求体原文送达 127.0.0.1:${RPORT_PORT}', async () => {
  const ctx = await server();
  const r = await req(ctx.base, '/rport', { method: 'POST', body: RPORT_BODY, headers: { 'content-type': 'text/plain' } });
  assert(r.status === 200, `POST /rport 期望 200，实际 ${r.status}；正文=${JSON.stringify(r.body.slice(0, 200))}`);
  assert(/text\/plain/i.test(r.type), `POST /rport 的 Content-Type 期望 text/plain，实际 ${JSON.stringify(r.type)}`);
  assert(
    ctx.rport.received.some((raw) => raw.includes(RPORT_BODY)),
    `转发对端收到的原文 = ${JSON.stringify(ctx.rport.received)}，期望含 ${JSON.stringify(RPORT_BODY)}（契约 §3.6：把请求体原文转发；对端可能收到裸 body，也可能收到带请求行的 HTTP forward）`
  );
});

test('未知路径：404', async () => {
  const ctx = await server();
  const r = await req(ctx.base, '/definitely-not-an-endpoint');
  assert(r.status === 404, `GET /definitely-not-an-endpoint 期望 404（契约 §3.6），实际 ${r.status}；正文=${JSON.stringify(r.body.slice(0, 200))}`);
});

test('输出可见性：子进程打印绑定地址（127.0.0.1 + 端口）', async () => {
  const ctx = await server();
  const out = ctx.out();
  assert(
    out.includes('127.0.0.1') && out.includes(String(ctx.port)),
    `自检脚本的 stdout 应打印它绑定的 127.0.0.1:${ctx.port}（便于真机取证）；实际=${JSON.stringify(out.slice(0, 300))}`
  );
});

test('收尾：杀掉自检子进程并清理临时目录（保证测试进程能自然退出）', async () => {
  if (!ctxPromise) return; // 前面的用例连服务都没起起来（例如文件缺失），无收尾对象
  const ctx = await ctxPromise;
  await teardown(ctx);
  ctxPromise = null;
  console.log('        （信息）selfcheck 子进程已终止，临时 HOME 已清理');
});
