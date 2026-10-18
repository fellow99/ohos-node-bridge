/*
 * probe.js —— 样例/探针载荷：一次问清「这台设备的这个进程里 Node 能用什么」。
 *
 * 出身：承接 Phase 0 探针的检查口径（同一套 checks 键，便于与历史结论逐项对照），
 * 并按本库的契约做了三处改动：
 *   ① 写盘位置：原版写到 `__dirname`（resfile/安装目录，只读）⇒ 改成 `<HOME>/payload`（可写，C3 谁写谁读）；
 *   ② 补两项库自带 `payload/selfcheck.js` 不收、但 Phase 0 探针收的检查：
 *      `expose_internals`（`--expose-internals` 判据）与 `worker_threads`；
 *   ③ 端口可配：`PROBE_PORT`（默认 15577，与 selfcheck 的文档化端口一致），仍**只绑 127.0.0.1**。
 *
 * 与库自带 selfcheck.js 的分工（不要混用）：
 *   · `payload/selfcheck.js` = **契约冻结**的四端点（`/facts` `/log` `/rport` `/diag`）+ 16 个 checks 键，
 *     由 `tools/smoke-host.mjs` ④ 做漂移检查 ⇒ 不在这里扩键；
 *   · 本文件 = **样例 + 扩展探针**，因此可以带额外检查项，也可以随时改。
 *
 * 端点：`GET /facts`（JSON）、`GET /log`（日志尾）；其余路径一律返回 facts（探针不装产品）。
 * 判据：见 `samples/minimal-app/README.md` §4「怎么读结果」。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/** 文档化端口：与 `payload/selfcheck.js` 同值，真机命令都用 `hdc fport tcp:15577` */
const DEFAULT_PORT = 15577;
const rawPort = Number(process.env.PROBE_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT;
/** 可写落点：与库的 `Env.payloadDir(context)` 同一口径（`<filesDir>/payload`） */
const PAYLOAD_DIR = path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), 'payload');

const R = { at: new Date().toISOString(), pid: process.pid, checks: {}, notes: [] };

/** 单项检查的同步包装：任何异常都编码成字符串，**绝不让异常漏出去**（进程内 Node 的未捕获异常 = 整个 App abort） */
function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    return 'ERR:' + (e && e.message ? e.message : String(e));
  }
}
function ok(key, value) {
  R.checks[key] = value;
}

// 让库看到「Node 已经有输出」⇒ 原生侧 stage 从 start 翻到 running（node_bridge.c 的判据）
console.log('[probe] boot node=' + process.version + ' platform=' + process.platform + ' arch=' + process.arch);

// ── 1. 身份与环境 ────────────────────────────────────────────────────────────
ok('node', process.version);
ok('platform', process.platform);
ok('arch', process.arch);
ok('execArgv', process.execArgv.slice());
ok('execPath', process.execPath); // 注意：本平台是 /system/bin/appspawn，只作日志，不参与重启（宪法 C5）
ok('cwd', attempt(() => process.cwd()));
ok('versions', { v8: process.versions.v8, uv: process.versions.uv, modules: process.versions.modules });
ok('homedir', attempt(() => os.homedir()));
ok('tmpdir', attempt(() => os.tmpdir()));
ok('netifaces', attempt(() => Object.keys(os.networkInterfaces() || {})));
ok('cpus', attempt(() => os.cpus().length)); // 本平台实测 0：版本/并发探测不得依赖它
ok('totalmem', attempt(() => os.totalmem()));

// ── 2. WASM / JIT（路线 J 与 I 的分水岭）────────────────────────────────────
ok('wasm.validate', attempt(() => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))));
ok('wasm.instantiate', attempt(() => {
  const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return typeof new WebAssembly.Instance(m, {}).exports === 'object';
}));

// ── 3. 热循环（JIT 生效 ≈ 10 ms 级；纯解释器 ≈ 100 ms 级，见规划 §D.8/§D.10）──
ok('hotloop_ms_5rounds', attempt(() => {
  function hot(n) {
    let a = 0;
    for (let i = 0; i < n; i += 1) {
      a = (a + i * i) ^ (i * 3);
    }
    return a;
  }
  hot(200000); // 预热
  const t0 = Date.now();
  for (let r = 0; r < 5; r += 1) {
    hot(2000000);
  }
  return Date.now() - t0;
}));

// ── 4. 内部模块（`--expose-internals` 判据；库自带 selfcheck 不收这一项）────
ok('expose_internals', attempt(() => {
  require('internal/modules/cjs/loader');
  return 'OK';
}));

// ── 5. worker_threads（库自带 selfcheck 不收这一项）─────────────────────────
ok('worker_threads', attempt(() => typeof require('worker_threads').Worker === 'function'));

// ── 6. 文件系统：写出去必须自己读回来（C3 谁写谁读）────────────────────────
ok('fs_write_readback', attempt(() => {
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  const p = path.join(PAYLOAD_DIR, 'probe-write.txt');
  const content = 'written-by-node ' + new Date().toISOString();
  fs.writeFileSync(p, content);
  const back = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  return back === content ? 'OK' : 'MISMATCH';
}));

// ── 7. 子进程：async spawn 的三事件（旧壳 R14 与库 §D.8 的争议点）───────────
ok('spawn', 'pending');
try {
  const child = require('child_process').spawn('/system/bin/sh', ['-c', 'echo SPAWN_OK; id']);
  let out = '';
  const events = { data: false, exit: false, close: false, error: null };
  let settled = false;
  const settle = (reason) => {
    if (settled) return;
    settled = true;
    R.checks.spawn = {
      pid: child.pid,
      events,
      stdout: out.slice(0, 200),
      zombie: !(events.exit && events.close),
      settledBy: reason,
    };
    writeFacts();
  };
  child.stdout.on('data', (d) => {
    events.data = true;
    out += d.toString();
  });
  child.on('error', (e) => {
    events.error = (e && e.code) || String(e);
    settle('error');
  });
  child.on('exit', () => {
    events.exit = true;
  });
  child.on('close', () => {
    events.close = true;
    settle('close');
  });
  setTimeout(() => settle('timeout-8s'), 8000);
} catch (e) {
  ok('spawn', 'THROW:' + (e && e.message ? e.message : String(e)));
}

// ── 8. 端点：/facts + /log（只绑 127.0.0.1；端口被占则回退临时端口并喊一声）──
const server = http.createServer((req, res) => {
  if (req.url === '/log') {
    try {
      const p = path.join(PAYLOAD_DIR, 'node.log');
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(fs.readFileSync(p, 'utf8').slice(-20000));
    } catch (e) {
      res.end('log read fail: ' + (e && e.message ? e.message : String(e)));
    }
    return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(R, null, 2));
});
server.on('error', (e) => {
  ok('http_server', 'ERR:' + ((e && e.code) || String(e)));
  if (e && e.code === 'EADDRINUSE') {
    // 与 selfcheck 同一纪律：**不静默换端口**，换了要喊出来
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      ok('http_server', 'WARN 端口 ' + PORT + ' 被占用 → 改用内核临时端口 ' + p);
      console.log('[probe] WARN ' + PORT + ' 被占用 → 改用 ' + p);
      probeSelf(p);
    });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  ok('http_server', 'listening 127.0.0.1:' + PORT);
  probeSelf(PORT);
});

/** 自测 fetch（undici；其 llhttp 走 WASM ⇒ 与 JIT 强耦合） */
function probeSelf(port) {
  const url = 'http://127.0.0.1:' + port + '/facts';
  Promise.resolve()
    .then(() => fetch(url))
    .then((r) => ok('fetch_self', r.status === 200 ? 'OK' : 'HTTP ' + r.status))
    .catch((e) => ok('fetch_self', 'ERR:' + (e && e.message ? e.message : String(e))))
    .then(() => writeFacts());
}

/** 落盘 + 打一行机器可读标记（库的日志环会把它写进 node.log） */
function writeFacts() {
  R.at2 = new Date().toISOString();
  try {
    fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(PAYLOAD_DIR, 'probe-facts.json'), JSON.stringify(R, null, 2));
  } catch (e) {
    /* 落盘失败不影响端点；下面 stdout 仍有全量 JSON */
  }
  console.log('PROBE_FACTS ' + JSON.stringify(R));
}

// 兜底：15 s 后无论如何落一次盘
setTimeout(writeFacts, 15000);
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT ' + ((e && e.stack) || e));
  writeFacts();
});
