#!/usr/bin/env node
/*
 * smoke-host.mjs —— host 侧门禁（契约 §4 / 规划 §7.4 ③）：**不接真机**，一次跑完四道检查。
 *
 * 为什么需要它：真机取证（`hdc fport` + `curl /facts`）是最终判据，但要等装机；本脚本把
 * 「产物对不对 / 解包器对不对 / 桥的失败语义对不对 / 契约有没有漂」在**本机**一次问清，
 * 让真机那一轮只用来回答「设备上能不能跑」。
 *
 * 四道检查（与契约 §4 一一对应）：
 *   ① lock + runtime gate  —— `node tools/provision.mjs --check`（七项 ELF 门禁 + SHA-256 硬校验）；
 *                             本地没有 `libnode-arm64.so` 时**明确 SKIP**（--check 无二进制无从校验，C2 不假装通过）
 *   ② ELF inspect          —— 找到 libnode.so 就跑 `python tools/elf-inspect.py`（✅ 已实现的独立交叉校验）
 *   ③ payload unit tests   —— 逐个跑 `tests/payload/*.mjs`（各自子进程，退出码必须为 0）
 *   ④ contract drift       —— 解析 `index.d.ts` / `payload/selfcheck.js` / `payload/bootstrap.js`，与
 *                             IMPLEMENTATION_CONTRACT.md §1.1（5 符号 + start 6 参）/ §3.1（NODE_BRIDGE_*）/
 *                             §3.6（16 个 checks 键 + 端点路径）逐条对齐；缺一项就打印 `DRIFT: …` 并 FAIL
 *
 * 用法：
 *   node tools/smoke-host.mjs                       # 全跑
 *   node tools/smoke-host.mjs --skip-tests          # 跳过 ③（并行开发时先看契约漂移）
 *   node tools/smoke-host.mjs --json report.json    # 额外落一份机器可读报告（CI / 归档）
 *
 * 退出码：0 = 全 PASS（SKIP 不算失败）；2 = 任一 FAIL。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const optValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const C = { red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', dim: '\u001b[2m', reset: '\u001b[0m' };
const color = process.env.NO_COLOR ? (s) => s : (s, c) => `${C[c] || ''}${s}${C.reset}`;
const CIRCLED = ['①', '②', '③', '④'];

const phases = [];
function record(no, name, status, detail, evidence) {
  phases.push({ no, name, status, detail: detail || '', evidence: evidence || [] });
  const tag = status === 'PASS' ? color('PASS', 'green') : status === 'SKIP' ? color('SKIP', 'yellow') : color('FAIL', 'red');
  console.log(`\n[${no}/4] ${name} ` + '.'.repeat(Math.max(3, 34 - name.length)) + ` ${tag}`);
  if (detail) console.log(`      ${detail}`);
  for (const line of evidence || []) console.log(`      ${line}`);
}

/** 统一跑子进程（工具链里所有脚本都用当前 node；python 用 pythonCmd 探测）。 */
function run(cmd, args, opts = {}) {
  const { timeoutMs = 600000, ...rest } = opts;
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, ...rest });
}

function pythonCmd() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (!r.error && (r.stdout || r.stderr)) return cmd;
  }
  return null;
}

function lastLines(text, n) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

// ─────────────────────────────────────────────────────────────────────────────
// ① lock + runtime gate
// ─────────────────────────────────────────────────────────────────────────────
function readLock() {
  return JSON.parse(readFileSync(path.join(ROOT, 'runtime.lock.json'), 'utf8'));
}

function runtimeBinaryPath(lock) {
  const active = lock.active || {};
  const entry = (lock.runtimes || []).find((r) => r.node === active.node && r.abi === active.abi) || {};
  const storeDir = process.env[lock.localStore.envOverride] || path.resolve(ROOT, lock.localStore.path);
  return { entry, binary: path.join(storeDir, `node-${active.node}`, entry.file || 'libnode-arm64.so') };
}

function phase1LockRuntime(lock) {
  const { entry, binary } = runtimeBinaryPath(lock);
  if (!existsSync(binary)) {
    record(1, 'lock + runtime gate', 'SKIP', `本地运行时二进制缺失，provision --check 无从校验：${binary}`, [
      `锁定项：${entry.node} / ${entry.abi} / ${entry.file} / sha256=${(entry.sha256 || '').slice(0, 16)}…`,
      '补二进制（任选）：① 手工放进上述路径；② node tools/provision.mjs --download --out <模块>/libs/arm64-v8a',
      '（--check 的判据是「七项 ELF 门禁 + SHA-256 与 lock 一致」，没有二进制时它给不出结论 ⇒ 如实 SKIP，不假装通过）',
    ]);
    return;
  }
  const r = run(process.execPath, [path.join('tools', 'provision.mjs'), '--check']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  record(
    1,
    'lock + runtime gate',
    r.status === 0 ? 'PASS' : 'FAIL',
    r.status === 0 ? `node tools/provision.mjs --check → 七项门禁全过（${entry.node} / ${entry.abi}）` : `node tools/provision.mjs --check 退出码=${r.status}`,
    lastLines(out, 12)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ② ELF inspect
// ─────────────────────────────────────────────────────────────────────────────
/** 目录树里找 libs/arm64-v8a/<so>（只在目录名为 libs 处停下，不遍历整棵 build 树）。 */
function findLibsSo(rootDir, soName) {
  const found = [];
  if (!existsSync(rootDir)) return found;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(dir, e.name);
      if (e.name === 'libs') {
        const candidate = path.join(abs, 'arm64-v8a', soName);
        if (existsSync(candidate)) found.push(candidate);
      } else {
        stack.push(abs);
      }
    }
  }
  return found;
}

function phase2ElfInspect(lock) {
  const { entry } = runtimeBinaryPath(lock);
  const soName = entry.deployAs || 'libnode.so';
  const searched = [
    `${rel(path.join(ROOT, 'library', 'src', 'main', 'libs', 'arm64-v8a', soName))}`,
    `library/build/**/libs/arm64-v8a/${soName}`,
    `${rel(path.resolve(ROOT, '..', 'pi-desktop-ark', 'entry', 'libs', 'arm64-v8a', soName))}`,
  ];
  const candidates = [];
  const direct = path.join(ROOT, 'library', 'src', 'main', 'libs', 'arm64-v8a', soName);
  if (existsSync(direct)) candidates.push(direct);
  candidates.push(...findLibsSo(path.join(ROOT, 'library', 'build'), soName));
  const ark = path.resolve(ROOT, '..', 'pi-desktop-ark', 'entry', 'libs', 'arm64-v8a', soName);
  if (existsSync(ark)) candidates.push(ark);

  if (candidates.length === 0) {
    record(2, 'ELF inspect', 'SKIP', `三处落点都没有 ${soName}，无可校验对象`, searched.map((s) => `查找：${s}`));
    return;
  }
  const py = pythonCmd();
  if (!py) {
    record(2, 'ELF inspect', 'FAIL', '找不到 python：tools/elf-inspect.py 是 ✅ 已实现的独立校验器，属工具链前置', [
      '装 Python 3 或把 python 放进 PATH（见 tests/README.md）',
    ]);
    return;
  }
  const target = candidates[0];
  const r = run(py, [path.join('tools', 'elf-inspect.py'), target], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const verdict = /VERDICT\s*:\s*(.+)/.exec(out);
  const pass = r.status === 0 && verdict && /PASS/.test(verdict[1]);
  record(
    2,
    'ELF inspect',
    pass ? 'PASS' : 'FAIL',
    `${py} tools/elf-inspect.py ${rel(target)} → ${verdict ? verdict[1].trim() : `退出码=${r.status}`}`,
    lastLines(out, 12)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ payload 单测
// ─────────────────────────────────────────────────────────────────────────────
function payloadTestFiles() {
  const dir = path.join(ROOT, 'tests', 'payload');
  if (!existsSync(dir)) return { files: [], skipped: [] };
  const all = readdirSync(dir)
    .filter((n) => n.endsWith('.mjs'))
    .sort();
  return {
    files: all.filter((n) => !n.startsWith('_')),
    skipped: all.filter((n) => n.startsWith('_')),
  };
}

function phase3PayloadTests(skip) {
  const { files, skipped } = payloadTestFiles();
  if (skip) {
    record(3, 'payload unit tests', 'SKIP', '--skip-tests：按显式要求跳过', [`本应执行 ${files.length} 个文件：${files.join('、')}`]);
    return;
  }
  if (files.length === 0) {
    record(3, 'payload unit tests', 'FAIL', 'tests/payload/ 下没有 *.mjs 用例（契约 §4 要求纯 Node 单测）');
    return;
  }
  const failed = [];
  for (const name of files) {
    const abs = path.join(ROOT, 'tests', 'payload', name);
    const r = run(process.execPath, [abs], { timeoutMs: 300000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    console.log(`\n  → tests/payload/${name} (exit=${r.status})`);
    for (const line of String(out).split(/\r?\n/)) {
      if (line.length) console.log(`      ${line}`);
    }
    const zeroTests = /\(\s*0 passed/.test(out);
    if (r.status !== 0 || zeroTests) {
      failed.push(`tests/payload/${name}${zeroTests ? '（没有注册任何用例）' : ''} 退出码=${r.status}`);
    }
  }
  const evidence = [];
  if (skipped.length) evidence.push(`跳过 _ 前缀的辅助文件：${skipped.join('、')}`);
  record(
    3,
    'payload unit tests',
    failed.length === 0 ? 'PASS' : 'FAIL',
    failed.length === 0 ? `${files.length} 个用例文件全部 exit 0` : `${failed.length}/${files.length} 个文件失败：${failed.join('；')}`,
    evidence
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 契约漂移
// ─────────────────────────────────────────────────────────────────────────────
const FROZEN = {
  /** 契约 §1.1：5 个 NAPI 导出符号 + start 的 6 个形参 */
  napiSymbols: ['start', 'isRunning', 'version', 'lastError', 'stage'],
  napiStartParams: 6,
  /** 契约 §3.6：/facts 的 checks 冻结键名（16 个）+ 端点路径 */
  factsKeys: [
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
  ],
  endpoints: ['/facts', '/log', '/rport', '/diag'],
  /** 契约 §3.1：bootstrap 的输入契约（环境变量名） */
  bootstrapEnv: [
    'NODE_BRIDGE_PAYLOAD_ROOT',
    'NODE_BRIDGE_ENTRY',
    'NODE_BRIDGE_ARCHIVE',
    'NODE_BRIDGE_ARCHIVE_SHA256',
    'NODE_BRIDGE_READONLY_ROOT',
    'NODE_BRIDGE_CWD',
  ],
};

/** 冻结键名在源码里的三种现实写法：`'k'` / `"k"` / 对象字面量 `k:`（点号键只能用引号写法）。 */
function hasFrozenKey(src, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`['"\`]${esc}['"\`]`).test(src)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return new RegExp(`(^|[^A-Za-z0-9_$])${esc}\\s*:`).test(src);
  return false;
}

function countParams(src, name) {
  const m = new RegExp(`export\\s+const\\s+${name}\\s*:\\s*\\(([^)]*)\\)`).exec(src);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return 0;
  return inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0).length;
}

function phase4ContractDrift() {
  const missing = [];
  const notes = [];

  // ④-a index.d.ts（契约 §1.1）
  const dtsRel = 'library/src/main/cpp/types/libnode_bridge/index.d.ts';
  const dtsAbs = path.join(ROOT, dtsRel);
  if (!existsSync(dtsAbs)) {
    missing.push(`${dtsRel}（契约 §1.1 的 NAPI 声明面）`);
  } else {
    const src = readFileSync(dtsAbs, 'utf8');
    for (const sym of FROZEN.napiSymbols) {
      if (!new RegExp(`export\\s+const\\s+${sym}\\b`).test(src)) missing.push(`${dtsRel}: 缺导出 ${sym}`);
    }
    const params = countParams(src, 'start');
    if (params === null) {
      missing.push(`${dtsRel}: 找不到 start 的 () 形参列表`);
    } else if (params !== FROZEN.napiStartParams) {
      missing.push(`${dtsRel}: start 的形参个数 = ${params}，契约 §1.1 冻结为 ${FROZEN.napiStartParams}`);
    } else {
      notes.push(`${dtsRel}: ${FROZEN.napiSymbols.length} 个符号齐全，start 形参 = ${params} ✅`);
    }
  }

  // ④-b payload/selfcheck.js（契约 §3.6）
  const scRel = 'payload/selfcheck.js';
  if (!existsSync(path.join(ROOT, scRel))) {
    missing.push(`${scRel}（契约 §3.6 的 /facts /log /rport 端点）`);
  } else {
    const src = readFileSync(path.join(ROOT, scRel), 'utf8');
    for (const key of FROZEN.factsKeys) {
      if (!hasFrozenKey(src, key)) missing.push(`${scRel}: /facts 缺冻结键 ${key}`);
    }
    for (const ep of FROZEN.endpoints) {
      if (!src.includes(`'${ep}'`) && !src.includes(`"${ep}"`)) missing.push(`${scRel}: 缺端点路径 ${ep}`);
    }
    if (!missing.some((m) => m.startsWith(scRel))) {
      notes.push(`${scRel}: ${FROZEN.factsKeys.length} 个 checks 键 + ${FROZEN.endpoints.length} 条路径齐全 ✅`);
    }
  }

  // ④-c payload/bootstrap.js（契约 §3.1）
  const bsRel = 'payload/bootstrap.js';
  if (!existsSync(path.join(ROOT, bsRel))) {
    missing.push(`${bsRel}（契约 §3.1 的 NODE_BRIDGE_* 输入契约）`);
  } else {
    const src = readFileSync(path.join(ROOT, bsRel), 'utf8');
    for (const env of FROZEN.bootstrapEnv) {
      if (!src.includes(env)) missing.push(`${bsRel}: 未见输入 env ${env}`);
    }
    if (!FROZEN.bootstrapEnv.some((env) => missing.some((m) => m.includes(env)))) {
      notes.push(`${bsRel}: ${FROZEN.bootstrapEnv.length} 个 NODE_BRIDGE_* 输入名齐全 ✅`);
    }
    // 已裁决（2026-10-17）：契约 §3.1 的 `PI_WEB_ENTRY` 兼容别名**已删除**，以 specs/004 FR-004-020
    // （库侧不得解释 PI_*，宪法 C1 一票否决）为准；消费方这类值走 `options.env` 透传。
    if (!src.includes('PI_WEB_ENTRY')) {
      notes.push('（提示）bootstrap.js 未见 PI_WEB_ENTRY：符合已修订的契约 §3.1 与 specs/004 FR-004-020（C1）');
    } else {
      missing.push(`${bsRel}: 出现 PI_WEB_ENTRY（契约 §3.1 已删除该别名；库侧不得解释 PI_*，C1 / FR-004-020）`);
    }
  }

  if (missing.length) {
    console.log('\n      DRIFT 明细：');
    for (const m of missing) console.log(`      DRIFT: ${m}`);
  }
  record(
    4,
    'contract drift',
    missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? 'index.d.ts / payload/selfcheck.js / payload/bootstrap.js 与冻结契约一致' : `${missing.length} 处漂移`,
    notes
  );
  phases[phases.length - 1].drift = missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
if (hasFlag('help') || argv.includes('-h')) {
  console.log('用法：node tools/smoke-host.mjs [--skip-tests] [--json <path>]');
  process.exit(0);
}

console.log('=========================================================');
console.log(' smoke-host —— 不接真机的门禁（契约 §4 / 规划 §7.4 ③）');
console.log(` 仓库根：${ROOT}`);
console.log(` Node：${process.version}  ·  用例：tests/payload/*.mjs`);
console.log('=========================================================');

const lock = readLock();
phase1LockRuntime(lock);
phase2ElfInspect(lock);
phase3PayloadTests(hasFlag('skip-tests'));
phase4ContractDrift();

const failed = phases.filter((p) => p.status === 'FAIL');
const skipped = phases.filter((p) => p.status === 'SKIP');

console.log('\n==================== HOST SMOKE 汇总 ====================');
for (const p of phases) {
  console.log(`  ${CIRCLED[p.no - 1]} ${p.name.padEnd(22, '.')} ${p.status}  ${p.detail}`);
}
if (skipped.length) {
  console.log(`  （SKIP ${skipped.length} 项：不是通过，是**没有判据** —— 原因见上面各段）`);
}
console.log(`SMOKE: ${failed.length === 0 ? 'PASS' : 'FAIL'}`);

const jsonPath = optValue('json');
if (jsonPath) {
  const abs = path.isAbsolute(jsonPath) ? jsonPath : path.resolve(ROOT, jsonPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        node: process.version,
        root: ROOT,
        ok: failed.length === 0,
        skipped: skipped.map((p) => ({ phase: p.name, detail: p.detail })),
        phases: phases.map((p) => ({ no: p.no, name: p.name, status: p.status, detail: p.detail, evidence: p.evidence, drift: p.drift })),
      },
      null,
      2
    )
  );
  console.log(`报告已写入：${abs}`);
}

process.exit(failed.length === 0 ? 0 : 2);
