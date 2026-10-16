// tests/lib/util.mjs —— 测试公共设施（不是被测对象）。
//
// 三条纪律（来自宪法 C2/C3 与契约 §4）：
//  1) 被测载荷文件**可能还没写出来**（多人并行实现）：一律走 loadPayload()，缺文件就报
//     「MISSING: <契约路径> — 期望导出 <名字>」，绝不因为 import 失败甩裸栈。
//  2) 「写入成功」的判据一律是**读回**（C3）：所有解包/落盘断言都要 fs 读回来比对，不看 statSync。
//  3) 一律绝对路径（S4）：被测载荷在真机上 cwd=/，测试也用绝对路径传参。

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

/** tests/lib/ 的绝对路径 */
export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（ohos-node-bridge/）的绝对路径 */
export const ROOT = path.resolve(HERE, '..', '..');

/** 仓库根下的绝对路径。 */
export function p(...seg) {
  return path.join(ROOT, ...seg);
}

/** 载荷侧是 CommonJS（payload/*.js），host 测试用 createRequire 加载，不经过 ESM interop。 */
export function requirePayload(rel) {
  return require(p(rel));
}

/**
 * 按候选路径顺序加载载荷模块并取一个导出。
 * candidates 的第一个必须是**契约冻结路径**（报错文本以它为准），其余是已知的并行实现变体。
 */
export function loadPayload(candidates, exportName, hint) {
  for (const rel of candidates) {
    if (!existsSync(p(rel))) continue;
    let mod;
    try {
      mod = requirePayload(rel);
    } catch (e) {
      throw new Error(`LOAD-FAILED: ${rel} 无法被 require：${e && e.message ? e.message : String(e)}`);
    }
    const fn = mod && typeof mod === 'object' ? mod[exportName] ?? mod.default?.[exportName] : undefined;
    if (typeof fn !== 'function') {
      const keys = mod && typeof mod === 'object' ? Object.keys(mod).join(', ') || '(无导出)' : typeof mod;
      throw new Error(`DRIFT: ${rel} — 期望导出 ${exportName}，实际导出：${keys}${hint ? '；' + hint : ''}`);
    }
    return fn;
  }
  const tail = candidates.length > 1 ? `（备选路径 ${candidates.slice(1).join('、')} 亦不存在）` : '';
  throw new Error(`MISSING: ${candidates[0]} — 期望导出 ${exportName}${hint ? '；' + hint : ''}${tail}`);
}

/** 载荷文件是否存在（用于「不存在 ⇒ 报 MISSING」这类分支，不用于判成功）。 */
export function payloadExists(rel) {
  return existsSync(p(rel));
}

/** 建一个测试临时目录（默认放系统 temp，避免污染仓库）。 */
export function makeTmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `nb-${prefix}-`));
}

/** 尽力清理临时目录；失败不抛（Windows 上偶发 EBUSY）。 */
export function rmrf(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略：临时目录 */
  }
}

/** 用当前 node 跑一个子进程（host 侧测试用的统一入口；env 是**覆盖**而非替换）。 */
export function runNode(scriptAbs, { env = {}, cwd = ROOT, args = [], timeoutMs = 60000 } = {}) {
  const r = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: r.status,
    signal: r.signal,
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : '',
    all: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

/** 便于把「实际拿到了什么」写进失败文本（Error 的 message 不是可枚举属性，要专门处理）。 */
export function describe(v) {
  if (v instanceof Error) {
    const own = {};
    for (const k of Object.keys(v)) own[k] = v[k];
    return `${v.name}: ${v.message} | props=${safeJson(own)}`;
  }
  return safeJson(v);
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 断言 promise **reject** 且载荷符合契约；仓库里所有通道都可能在「未实现」时挂住，
 * 因此带看门狗，避免测试进程被一个永不结算的 Promise 拖死。
 */
export async function expectRejects(factory, check, label, timeoutMs = 4000) {
  let timer = null;
  const hang = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'hang' }), timeoutMs);
  });
  const settled = Promise.resolve()
    .then(factory)
    .then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', error })
    );
  let outcome;
  try {
    outcome = await Promise.race([settled, hang]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome.kind === 'hang') {
    throw new Error(`HANG: ${label} —— ${timeoutMs} ms 内既未 resolve 也未 reject（该失败路径未实现？）`);
  }
  if (outcome.kind === 'resolved') {
    throw new Error(`NOT-REJECTED: ${label} —— 期望 reject，实际 resolve 了：${describe(outcome.value)}`);
  }
  const err = outcome.error;
  if (check && !check(err)) {
    throw new Error(`BAD-ERROR: ${label} —— reject 载荷不符合契约：${describe(err)}`);
  }
  return err;
}

/** 当前 node 进程能用的 python 命令（elf-inspect.py 是 ✅ 已有工具，不是本次实现对象）。 */
export function pythonCmd() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (!r.error && (r.stdout || r.stderr)) return cmd;
  }
  return null;
}
