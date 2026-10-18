#!/usr/bin/env node
/**
 * probe.mjs —— 内置探针的**一键真机取证**（样例 `samples/minimal-app` = HAP + `rawfile/probe.js`）。
 *
 * 为什么需要它：探针的四条取证通道（`/facts`、日志尾、界面截图、dumpLayout）之前散在文档里，
 * 每轮都要手抄 5 条命令、还要记得 `force-stop`（进程内 Node 只能起一次）与端口转发。
 * 本脚本把它们固化成一条命令，并把结果落成可归档的证据。
 *
 * 用法：
 *   node tools/probe.mjs                      # 全流程：build → install → start(preset 0) → facts
 *   node tools/probe.mjs --preset 2           # 指定档位（0 = --jitless / 1 = 真 JIT / 2 = --jitless + --expose-internals）
 *   node tools/probe.mjs --no-build --preset 0
 *   node tools/probe.mjs --facts-only         # 只取 /facts（已装已启动时用）
 *   node tools/probe.mjs --install-only
 *   node tools/probe.mjs --port 15577 --timeout 25 --evidence logs/20261018-probe
 *
 * 退出码：0 = 取到 `/facts` 且 HTTP 200；2 = 任一步失败（**不猜成功**：拿不到就报拿不到）。
 *
 * 依赖：hdc（DevEco SDK）、hvigorw + ohpm（构建时）、Node 24（本脚本）。
 * 三个默认值都能用环境变量覆盖：`HDC` / `HVIGORW` / `OHPM`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUNDLE = 'org.fellow99.nodebridge.sample';
const MODULE = 'minimalapp';
const ABILITY = 'EntryAbility';
const DEFAULT_PORT = 15577;

// ---------------------------------------------------------------- CLI ----
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OPT = {
  preset: Number(flag('--preset', '0')),
  port: Number(flag('--port', String(DEFAULT_PORT))),
  timeoutMs: Number(flag('--timeout', '25')) * 1000,
  evidence: String(flag('--evidence', path.join(REPO, 'logs', `${stamp()}-probe`))),
  build: flag('--no-build', false) !== true,
  install: flag('--install-only', false) === true ? true : flag('--no-install', false) !== true,
  start: flag('--facts-only', false) !== true,
  onlyFacts: flag('--facts-only', false) === true,
  hap: String(flag('--hap', path.join(REPO, 'samples', 'minimal-app', 'build', 'default', 'outputs', 'default', `${MODULE}-default-signed.hap`))),
};
if (flag('--help', false)) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

/** `YYYYMMDD-HHmm`（**用设备/主机本地时间，不编造日期**） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function die(msg) {
  console.error('PROBE: FAIL ' + msg);
  process.exit(2);
}
function step(msg) {
  console.log('PROBE: ' + msg);
}

// ------------------------------------------------------------- 工具定位 ----
/** hdc：环境变量 → DEVECO_SDK_HOME → DevEco 默认安装 → PATH */
function resolveHdc() {
  if (process.env.HDC && existsSync(process.env.HDC)) return process.env.HDC;
  const sdk = process.env.DEVECO_SDK_HOME;
  const win = process.platform === 'win32' ? '.exe' : '';
  const candidates = [];
  if (sdk) candidates.push(path.join(sdk, 'default', 'openharmony', 'toolchains', `hdc${win}`));
  candidates.push('D:\\oh-workspace\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe');
  for (const c of candidates) if (existsSync(c)) return c;
  return 'hdc'; // 交给 PATH；找不到时 run() 会带命令原文报错
}
/** hvigorw / ohpm：环境变量 → command-line-tools → PATH */
function resolveTool(envKey, winName, bareName) {
  if (process.env[envKey]) return process.env[envKey];
  const guess = `D:\\oh-workspace\\command-line-tools\\bin\\${winName}`;
  if (process.platform === 'win32' && existsSync(guess)) return guess;
  return bareName;
}

/** Windows 上 `hvigorw.bat` / `ohpm.bat` **不能**直接 spawn（Node 18+ 禁止无 shell 执行 .bat）⇒ 走 cmd.exe 包一层 */
function quoteWin(s) {
  return /[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
}

function run(cmd, args, opts = {}) {
  const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
  const file = isBatch ? (process.env.ComSpec || 'cmd.exe') : cmd;
  const argv = isBatch ? ['/d', '/s', '/c', [cmd, ...args].map(quoteWin).join(' ')] : args;
  const r = spawnSync(file, argv, { encoding: 'utf8', cwd: opts.cwd || REPO, timeout: opts.timeoutMs || 600000 });
  if (r.error) die(`执行失败：${cmd} ${args.join(' ')} → ${r.error.message}`);
  if (r.status !== 0 && opts.allowFail !== true) {
    die(`${cmd} ${args.join(' ')} 退出码 ${r.status}\n${(r.stdout || '') + (r.stderr || '')}`);
  }
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const HDC = resolveHdc();
const HVIGORW = resolveTool('HVIGORW', 'hvigorw.bat', 'hvigorw');
const OHPM = resolveTool('OHPM', 'ohpm.bat', 'ohpm');

// ------------------------------------------------------------------ 构建 ----
function build() {
  step(`ohpm install --all（${OHPM}）`);
  run(OHPM, ['install', '--all'], { timeoutMs: 600000 });
  step(`hvigorw assembleHap（模块 ${MODULE}）`);
  run(HVIGORW, ['assembleHap', '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=debug', '--no-daemon'],
    { timeoutMs: 1500000 });
  if (!existsSync(OPT.hap)) die(`构建成功但找不到产物：${OPT.hap}`);
  step(`HAP = ${OPT.hap}`);
}

// ------------------------------------------------------------- 装机/启动 ----
function install() {
  if (!existsSync(OPT.hap)) {
    die(`没有 HAP：${OPT.hap}\n先跑 \`node tools/probe.mjs\`（含构建），或 \`--hap <path>\` 指定。\n` +
      `注意 libnode.so 必须先投放：node tools/provision.mjs --out samples/minimal-app/libs/arm64-v8a`);
  }
  step(`安装 ${path.basename(OPT.hap)}`);
  const r = run(HDC, ['install', '-r', OPT.hap], { allowFail: true });
  if (!/successfully/i.test(r.out)) die(`安装失败：${r.out.trim()}`);
}

function start() {
  // 进程内 Node 只能启动一次（宪法 C5）⇒ 每轮必须 force-stop
  run(HDC, ['shell', `aa force-stop ${BUNDLE}`], { allowFail: true });
  const ps = [
    '--ps', 'probePreset', String(OPT.preset),
    '--ps', 'probeAuto', 'true',
  ];
  step(`启动（preset=${OPT.preset}）`);
  const r = run(HDC, ['shell', `aa start -a ${ABILITY} -b ${BUNDLE} ${ps.join(' ')}`], { allowFail: true });
  if (!/successfully/i.test(r.out)) die(`启动失败：${r.out.trim()}`);
}

// ---------------------------------------------------------------- 端口 ----
function ensureForward() {
  const list = run(HDC, ['fport', 'ls'], { allowFail: true }).out;
  const needle = `tcp:${OPT.port} tcp:${OPT.port}`;
  if (list.includes(needle)) {
    step(`端口转发已在位：${needle}`);
    return;
  }
  const r = run(HDC, ['fport', `tcp:${OPT.port}`, `tcp:${OPT.port}`], { allowFail: true });
  if (!/success/i.test(r.out) && !/already/i.test(r.out)) step(`WARN 端口转发疑似失败：${r.out.trim()}`);
}

// ---------------------------------------------------------------- facts ----
/** 轮询 `/facts`（Node 起服务需要时间；取不到就是取不到，不猜） */
function fetchFacts() {
  return new Promise((resolve) => {
    const deadline = Date.now() + OPT.timeoutMs;
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port: OPT.port, path: '/facts', timeout: 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode === 200) return resolve({ ok: true, body });
          resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
        });
      });
      req.on('error', (e) => {
        if (Date.now() > deadline) return resolve({ ok: false, reason: e.message });
        setTimeout(attempt, 800);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
    };
    attempt();
  });
}

// --------------------------------------------------------------- 主流程 ----
(async () => {
  mkdirSync(OPT.evidence, { recursive: true });
  console.log(JSON.stringify({ hdc: HDC, hvigorw: HVIGORW, ohpm: OHPM, hap: OPT.hap, preset: OPT.preset, port: OPT.port },
    null, 2));

  if (OPT.build && !OPT.onlyFacts) build();
  if (OPT.install && !OPT.onlyFacts) install();
  if (OPT.start && !OPT.onlyFacts) start();
  ensureForward();

  step(`轮询 http://127.0.0.1:${OPT.port}/facts（最多 ${OPT.timeoutMs / 1000}s）`);
  const facts = await fetchFacts();
  const factsPath = path.join(OPT.evidence, `facts-preset${OPT.preset}.json`);
  if (!facts.ok) {
    // 失败也要留证：把设备侧日志尾拉下来（这是排障时唯一有用的东西）
    const logPath = '/data/app/el2/100/base/org.fellow99.nodebridge.sample/haps/minimalapp/files/payload/node.log';
    const tail = run(HDC, ['shell', `tail -40 ${logPath}`], { allowFail: true }).out;
    writeFileSync(path.join(OPT.evidence, `facts-preset${OPT.preset}.FAILED.txt`),
      `reason: ${facts.reason}\n\n--- node.log tail ---\n${tail}\n`);
    die(`取不到 /facts（${facts.reason}）——证据已落 ${OPT.evidence}`);
  }

  writeFileSync(factsPath, facts.body);
  let checks = {};
  try {
    checks = JSON.parse(facts.body).checks || {};
  } catch (e) {
    die(`/facts 不是合法 JSON：${e.message}`);
  }

  // 人读摘要（**只陈述实测值，不做「看起来通过」的推断**）
  const pick = ['node', 'platform', 'arch', 'execArgv', 'wasm.validate', 'hotloop_ms_5rounds',
    'expose_internals', 'worker_threads', 'fs_write_readback', 'http_server', 'fetch_self', 'spawn'];
  const lines = ['# probe 摘要（preset=' + OPT.preset + '）', ''];
  for (const k of pick) {
    const v = checks[k];
    lines.push(`- \`${k}\` = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  const summary = lines.join('\n') + '\n';
  writeFileSync(path.join(OPT.evidence, 'summary.md'), summary);

  console.log('\n' + summary);
  step(`OK 证据已落 ${OPT.evidence}（facts-preset${OPT.preset}.json + summary.md）`);
})();
