/*
 * selfcheck.js —— 端到端自检（沿用 Phase 0 探针 `probe.js` 的口径，**骨架版**）。
 *
 * 目的：一条命令回答"这台设备的这个进程里，Node 到底能用什么"。
 * 用法：把本文件作为 scriptPath 启动，然后
 *   hdc fport tcp:15577 tcp:15577 && curl -s http://127.0.0.1:15577/facts
 *
 * 判定基线（真机实测，见工程规划 §D.8）：
 *   - 无 ACL 且不带 --jitless ⇒ 启动即 SIGTRAP（不是脚本问题）；
 *   - --jitless 下：`WebAssembly is not defined`、`fetch` 失败、热循环 ~299ms/5 轮（解释器基线）；
 *   - 有 ACL：`wasm.validate === true`，日志出现 `(target MAGLEV)`。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.SELFCHECK_PORT || 15577);
const checks = {};

function safe(key, fn) {
  try {
    checks[key] = fn();
  } catch (e) {
    checks[key] = 'ERR:' + (e && e.message ? e.message : String(e));
  }
}

safe('node', () => process.version);
safe('platform', () => process.platform);
safe('arch', () => process.arch);
safe('execArgv', () => process.execArgv);
safe('versions', () => process.versions);
safe('homedir', () => os.homedir());
safe('tmpdir', () => os.tmpdir());
safe('netifaces', () => Object.keys(os.networkInterfaces() || {}));
safe('cpus', () => os.cpus().length);

safe('wasm.validate', () => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
safe('wasm.error', () => (typeof WebAssembly === 'undefined' ? 'WebAssembly is not defined' : ''));

safe('fs_write_readback', () => {
  const p = os.tmpdir() + '/selfcheck.txt';
  fs.writeFileSync(p, 'ok');
  const back = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  return back === 'ok' ? 'OK' : 'MISMATCH';
});

safe('hotloop_ms_5rounds', () => {
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < 2e6; i++) {
    acc += (i * 31) % 7;
  }
  return Date.now() - t0;
});

const server = http.createServer((req, res) => {
  if (req.url === '/facts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ at: new Date().toISOString(), checks: checks }));
    return;
  }
  if (req.url === '/log') {
    const logPath = (process.env.HOME || '') + '/payload/node.log';
    let text = '';
    try {
      text = fs.readFileSync(logPath, 'utf8').slice(-8192);
    } catch (e) {
      text = '(read failed: ' + e.message + ')';
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(text);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('[selfcheck] listening 127.0.0.1:' + PORT + '\n');
});
