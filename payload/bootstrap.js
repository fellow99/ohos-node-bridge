/*
 * bootstrap.js —— 库自带的载荷引导器（契约 §3.1–§3.4）
 *
 * 它回答四个问题，且**不**替消费方决定业务：
 *   ① 载荷从哪来：`NODE_BRIDGE_ARCHIVE`（Node 自己流式解包，C3）→ `NODE_BRIDGE_READONLY_ROOT`
 *      （resfile 只读直读，零解压）→ `NODE_BRIDGE_PAYLOAD_ROOT`（可写根）；
 *   ② 解包是否幂等：`<payloadRoot>/.ready-<sha256 前 12 位>` 命中**且**目标目录存在 ⇒ 跳过；
 *   ③ 入口是谁：`NODE_BRIDGE_ENTRY`（绝对/相对运行根）→ `package.json` 的 `main` → `index.js`；
 *   ④ 崩了怎么办：`uncaughtException` / `unhandledRejection` 兜底写**独立通道**
 *      `<HOME>/payload/app.log` + stderr，**绝不** `process.exit`（D.10 ⑰⑱：进程内 Node 没有优雅退出路径）。
 *
 * 用法（消费方）：把本文件当 `scriptPath` 启动（NodeRuntime.start），其余全靠 `NODE_BRIDGE_*` 环境变量。
 * 观测：本文件只写 stdout/stderr 的**文本**；`<stream> <epochMs> <text>` 前缀由原生层的 reader 线程加
 *      （契约 §1.3），所以这里**不得**自己拼前缀格式。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

/** `ENTRY_MISSING` 时列出的运行根条目数上限（够看清「载荷放错层」这类问题） */
const ENTRY_LIST_LIMIT = 20;
/** CJS require 失败后允许退 ESM 的错误码白名单（契约 §3.3 / FR-004-022） */
const ESM_REQUIRE_CODES = ['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'];

let guardInstalled = false;

// ── 日志：只写文本，前缀由原生层加（契约 §1.3） ────────────────────────────────

function log(msg) {
  try {
    process.stdout.write('[bootstrap] ' + msg + '\n');
  } catch (_) {
    // stdout 已关（宿主排空线程先退出）：静默不得让引导器挂掉，但要留 stderr 痕迹
    try { process.stderr.write('[bootstrap] WARN stdout 不可写\n'); } catch (__) { /* 两条都断：只能放弃 */ }
  }
}

function writeRawLine(text) {
  // tar 解包器等子模块自己带 `[tar] ` 前缀，这里原样透传
  try { process.stdout.write(text + '\n'); } catch (_) { /* 同上 */ }
}

/** 供日志使用的紧凑错误串（永不抛） */
function errorText(err) {
  try {
    if (err instanceof Error) return err.stack || (err.name + ': ' + err.message);
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function messageOf(err) {
  try {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

/** 独立日志通道路径：`<HOME>/payload/app.log`（HOME 缺失时返回 ''） */
function appLogPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, 'payload', 'app.log');
}

// ── §3.4 异常兜底 ─────────────────────────────────────────────────────────────

/**
 * 注册进程级兜底。必须**最先**调用（契约 §3.4 / D.10 ⑱）：
 * - 未捕获异常与未处理 rejection 在进程内 Node 里是**应用级事故**（无优雅退出路径），必须自己接住；
 * - 记录写 `<HOME>/payload/app.log`（独立通道，不与被 ArkWeb 原生输出污染的 node.log 混流）+ stderr；
 * - 全程 try/catch：兜底自身抛错会递归成二次崩溃；
 * - **不** `process.exit`：保留现场让原生层记录 `node::Start` 的返回值。
 */
function installExceptionGuard() {
  if (guardInstalled) return;
  try {
    process.on('uncaughtException', (err) => recordError('uncaughtException', err));
    process.on('unhandledRejection', (reason) => recordError('unhandledRejection', reason));
    guardInstalled = true;
  } catch (_) {
    // 注册失败也不得抛（此时连 stderr 都不保证可用）
  }
}

/** 兜底记录器：app.log + stderr + `globalThis.__nodeBridgeLastError`，自身永不抛 */
function recordError(kind, value) {
  try {
    const at = Date.now();
    const message = messageOf(value);
    const stack = value && typeof value.stack === 'string' ? value.stack : '';
    const body = message + (stack ? '\n' + stack : '');
    const line = new Date(at).toISOString() + ' ' + kind + ' ' + body;

    let appended = false;
    try {
      const p = appLogPath();
      if (p) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line + '\n');
        appended = true;
      }
    } catch (_) {
      appended = false;
    }
    if (!appended) {
      try { process.stderr.write('[bootstrap] WARN 独立日志通道不可写（' + (appLogPath() || 'HOME 未注入') + '）：只剩 stderr\n'); } catch (_) { /* 放弃 */ }
    }
    try { process.stderr.write('[bootstrap] ' + kind + ' ' + body + '\n'); } catch (_) { /* 放弃 */ }

    globalThis.__nodeBridgeLastError = { at, kind, message, stack };
  } catch (_) {
    // 兜底路径绝不能抛：抛出去会把 uncaughtException handler 变成新的崩溃源
  }
}

// ── §3.1 输入契约 ─────────────────────────────────────────────────────────────

/** 读取并归一化环境契约；路径一律转绝对（真机 cwd=/，相对路径无意义） */
function readConfig() {
  const env = process.env;
  const home = env.HOME || env.USERPROFILE || '';
  if (!home) {
    log('WARN HOME/USERPROFILE 未注入：原生引导件必须重定向 HOME（§5.6），否则文件选择器与 os.homedir() 都会指向沙箱外');
  }
  const payloadRoot = env.NODE_BRIDGE_PAYLOAD_ROOT || (home ? path.join(home, 'payload') : '');
  if (!payloadRoot) {
    // 不静默降级（C2）：宁可 FATAL 也要让调用方看见
    throw new Error('bootstrap: 无法确定载荷根（HOME 与 NODE_BRIDGE_PAYLOAD_ROOT 都为空）');
  }
  const archive = env.NODE_BRIDGE_ARCHIVE || '';
  const readonlyRoot = env.NODE_BRIDGE_READONLY_ROOT || '';
  const cwd = env.NODE_BRIDGE_CWD || '';
  return {
    home,
    payloadRoot: path.resolve(payloadRoot),
    archive: archive ? path.resolve(archive) : '',
    archiveSha256: (env.NODE_BRIDGE_ARCHIVE_SHA256 || '').trim().toLowerCase(),
    readonlyRoot: readonlyRoot ? path.resolve(readonlyRoot) : '',
    // `NODE_BRIDGE_ENTRY` 是库侧**唯一**会解释的入口变量名；`PI_*` 属应用语义，库不解释（宪法 C1 /
    // specs/004 FR-004-020）。消费方若要传这类值，走 `options.env` —— envPairs 在 NODE_BRIDGE_* 之后
    // 应用，覆盖仍然有效；载荷自己按需读。
    entry: env.NODE_BRIDGE_ENTRY || '',
    cwd: cwd ? path.resolve(cwd) : '',
  };
}

// ── §3.2 幂等解包 ─────────────────────────────────────────────────────────────

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (err) {
    return '(read failed: ' + messageOf(err) + ')';
  }
}

/** 流式 SHA-256：归档可达数百 MB，**不得**整包读进内存（NFR-004-003） */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 原子写 marker（写 <marker>.tmp.<pid> → rename；真机 link(2) 不可用，FR-004-009） */
function writeMarkerAtomic(markerPath, marker) {
  const tmp = markerPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(marker) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, markerPath);
}

/**
 * 幂等解包（契约 §3.2）：只在给了 `NODE_BRIDGE_ARCHIVE` 时发生。
 * @returns {Promise<string|null>} 解出的目录；未走解包路线返回 null
 */
async function ensurePayload(cfg) {
  if (!cfg.archive) {
    log('archive=none（只读直读路线：不做任何解包，§5.5）');
    return null;
  }
  if (!fs.existsSync(cfg.archive)) {
    throw new Error('bootstrap: 载荷归档缺失 archive=' + cfg.archive);
  }
  const startedAt = Date.now();
  const actual = await sha256File(cfg.archive);
  log('archive=' + cfg.archive + ' sha256=' + actual);
  if (cfg.archiveSha256 && cfg.archiveSha256 !== actual) {
    // 硬失败：哈希不符说明归档被换过或被损坏，继续解包等于把未知内容当载荷（C2）
    throw new Error('bootstrap: archive sha256 mismatch（硬失败，不继续）expected=' + cfg.archiveSha256 + ' actual=' + actual);
  }
  if (!cfg.archiveSha256) {
    log('WARN NODE_BRIDGE_ARCHIVE_SHA256 未提供：本次以实算值作为期望值（归档变化时会重新解包）');
  }

  const short = actual.slice(0, 12);
  const targetDir = path.join(cfg.payloadRoot, short);
  const markerPath = path.join(cfg.payloadRoot, '.ready-' + short);

  if (fs.existsSync(markerPath) && isDirectory(targetDir)) {
    log('payload ready (skip)');
    log('  dir=' + targetDir);
    log('  marker=' + markerPath + ' contents=' + readText(markerPath));
    return targetDir;
  }
  if (fs.existsSync(targetDir)) {
    // 缺 marker ⇒ 目录可能是被中断的半成品：宁可重做（契约 §3.2）
    log('marker 未命中但目标目录存在，重做解包（不留半成品）dir=' + targetDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const { extractTarGz } = require('./lib/tar-extract.js');
  const result = await extractTarGz(cfg.archive, targetDir, { log: writeRawLine });

  // C4：把 `skipped`（跳过的条目：链接/设备/pax 头等）一并写进 marker 与日志 ——
  // 解包树不完整时必须可审计，否则后续启动会无条件信任这棵树。
  const marker = { sha256: actual, files: result.files, bytes: result.bytes, skipped: result.skipped, at: Date.now() };
  writeMarkerAtomic(markerPath, marker);
  log(
    'extracted dir=' + targetDir + ' files=' + result.files + ' dirs=' + result.dirs +
    ' bytes=' + result.bytes + ' skipped=' + result.skipped +
    ' ms=' + (Date.now() - startedAt) + ' marker=' + markerPath
  );
  return targetDir;
}

// ── §3.1 运行根决策 ───────────────────────────────────────────────────────────

/** 运行根（冻结顺序）：解包目录 → READONLY_ROOT（必须存在且是目录）→ PAYLOAD_ROOT → <HOME>/payload */
function resolveRunRoot(cfg, extractedDir) {
  if (extractedDir) {
    log('runRoot=' + extractedDir + ' route=archive');
    return extractedDir;
  }
  if (cfg.readonlyRoot) {
    if (isDirectory(cfg.readonlyRoot)) {
      log('runRoot=' + cfg.readonlyRoot + ' route=readonly');
      return cfg.readonlyRoot;
    }
    log('WARN NODE_BRIDGE_READONLY_ROOT 不可用（不存在或不是目录），回退可写根：' + cfg.readonlyRoot);
  }
  fs.mkdirSync(cfg.payloadRoot, { recursive: true });
  log('runRoot=' + cfg.payloadRoot + ' route=writable');
  return cfg.payloadRoot;
}

// ── §3.3 入口解析 ─────────────────────────────────────────────────────────────

/** 读 `<dir>/package.json` 的 `main`（畸形 JSON ⇒ 明确 warn，不静默当没有） */
function readPackageMain(pkgPath) {
  if (!fs.existsSync(pkgPath)) return '';
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    log('WARN package.json 解析失败，忽略其 main：' + pkgPath + ' err=' + messageOf(err));
    return '';
  }
  const main = pkg && typeof pkg.main === 'string' ? pkg.main.trim() : '';
  if (!main) return '';
  return main;
}

function listRunRoot(runRoot) {
  try {
    const names = fs.readdirSync(runRoot).slice(0, ENTRY_LIST_LIMIT);
    log('  runRoot 前 ' + names.length + ' 项：' + (names.length ? names.join(', ') : '(空目录)'));
  } catch (err) {
    log('  runRoot 不可读：' + messageOf(err));
  }
}

/**
 * 冻结优先级：绝对路径直接用 → 相对路径按运行根解析 → 缺席时 `package.json` 的 main → `index.js`。
 * 返回绝对路径；未命中返回 null（已打印可见的 ENTRY_MISSING，不抛，让原生层记录 node::Start 返回）。
 */
function resolveEntry(cfg, runRoot) {
  let abs = '';
  if (cfg.entry) {
    abs = path.isAbsolute(cfg.entry) ? path.resolve(cfg.entry) : path.resolve(runRoot, cfg.entry);
  } else {
    const main = readPackageMain(path.join(runRoot, 'package.json'));
    abs = path.resolve(runRoot, main || 'index.js');
  }
  if (!path.isAbsolute(abs)) {
    // S4/FR-004-021：入口必须是绝对路径，绝不依赖 cwd（真机 cwd=/）
    throw new Error('bootstrap: 入口解析结果不是绝对路径：' + abs);
  }
  if (!fs.existsSync(abs)) {
    log('ENTRY_MISSING ' + abs);
    listRunRoot(runRoot);
    log('  提示：把载荷放到运行根下，或用 NODE_BRIDGE_ENTRY 指定入口');
    return null;
  }
  return abs;
}

/** 判定入口的模块种类（require(esm) 在 Node ≥22 可用，所以「能不能 require」不能用来判 CJS/ESM） */
function detectMode(abs, runRoot) {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';
  if (ext !== '.js') return 'cjs';
  // 向上找到运行根为止，取最近的 package.json 的 type
  let dir = path.dirname(abs);
  const stop = path.resolve(runRoot);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.type === 'module') return 'esm';
      } catch (_) {
        return 'cjs'; // 与 Node 自身行为一致：package.json 不可解析时按 CJS 处理
      }
      return 'cjs';
    }
    if (path.resolve(dir) === stop) return 'cjs';
    const parent = path.dirname(dir);
    if (parent === dir) return 'cjs';
    dir = parent;
  }
}

function entryLine(abs, mode, runRoot) {
  log('entry=' + abs + ' mode=' + mode + ' root=' + runRoot + ' cwd=' + process.cwd());
}

/** CJS 优先、必要时退 ESM 动态 import（契约 §3.3；其它错误码不得吞掉重试，FR-004-022） */
async function loadEntry(abs, runRoot) {
  let mode = detectMode(abs, runRoot);
  let loaded;
  try {
    loaded = require(abs);
  } catch (err) {
    if (err && ESM_REQUIRE_CODES.indexOf(err.code) !== -1) {
      mode = 'esm';
      // import() 返回 Promise：这里必须 await，否则 ESM 入口抛错会变成 unhandledRejection（FR-004-023）
      loaded = await import(pathToFileURL(abs).href);
    } else {
      entryLine(abs, mode, runRoot);
      throw err;
    }
  }
  entryLine(abs, mode, runRoot);
  return { mode, loaded };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  installExceptionGuard(); // 必须先于任何业务（§3.4）
  const cfg = readConfig();

  // 环境快照先进日志（FR-004-028）：cwd/execPath **只用于日志**，绝不参与路径或重启逻辑
  log('node=' + process.version + ' platform=' + process.platform + ' arch=' + process.arch + ' modules=' + process.versions.modules);
  log('home=' + cfg.home + ' cwd=' + process.cwd() + ' execPath=' + process.execPath);

  const extractedDir = await ensurePayload(cfg);
  const runRoot = resolveRunRoot(cfg, extractedDir);

  const cwdTarget = cfg.cwd || runRoot;
  try {
    process.chdir(cwdTarget);
    log('chdir ok cwd=' + process.cwd());
  } catch (err) {
    // 真机默认 cwd=/；chdir 失败必须大声说明，随后仍用绝对路径继续（FR-004-025）
    log('WARN chdir failed target=' + cwdTarget + ' err=' + messageOf(err) + '（继续，但所有路径必须已绝对化）');
  }

  const abs = resolveEntry(cfg, runRoot);
  if (!abs) return; // 入口缺失：已打印 ENTRY_MISSING；**不** sys.exit/process.exit，保留现场
  await loadEntry(abs, runRoot);
}

module.exports = {
  installExceptionGuard,
  recordError,
  readConfig,
  ensurePayload,
  resolveRunRoot,
  resolveEntry,
  loadEntry,
  main,
};

if (require.main === module) {
  // 作为脚本运行（真机路径）：兜底注册要尽早，早于任何业务与环境读取
  installExceptionGuard();
  main().catch((err) => {
    // 顶层失败：stdout + stderr + 独立通道都留痕；**不** process.exit（契约 §5 第 9 条）
    recordError('FATAL', err);
    log('FATAL ' + errorText(err));
  });
}
