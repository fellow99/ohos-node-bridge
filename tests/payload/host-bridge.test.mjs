// tests/payload/host-bridge.test.mjs —— 契约 §3.5（`payload/host.js`，Node 侧宿主桥客户端）的单测。
//
// 契约要点：
//   · `invoke()` 在**没有传输**时必须 reject 一个结构化错误 `{ok:false, error:'transport-unavailable', name, hint}`
//     ——**不得静默返回空值**（C2；反面教材是旧壳未注册能力直接解引用）；
//   · 入参超上限 ⇒ `payload-too-large`；超时 ⇒ `timeout`；
//   · `setTransport(fn)` 是 Phase 2 的接线点，host 侧可以注入假传输；
//   · `handle`/`list` 是本地注册表（可用）；`facts()` 返回本进程事实。
//
// ⚠️ 本文件是**单例模块**（payload/host.js 自己维护模块级状态）：用例顺序有语义，不要打乱。
// 传输层的完整语义（超时默认 10 s、structured `timeout`）见 specs/003 plan.md §4；此处只测 Node 侧口径。

import { test, assert, assertEq } from '../lib/mini-assert.mjs';
import { describe, expectRejects, payloadExists, requirePayload } from '../lib/util.mjs';

const CANDIDATES = ['payload/host.js', 'payload/lib/host.js'];
const HINT = '契约 §3.5：invoke/handle/list/setTransport/facts';

/** 取整个模块对象（payload/host.js 是 CJS，模块级单例）。 */
function host() {
  for (const rel of CANDIDATES) {
    if (payloadExists(rel)) return requirePayload(rel);
  }
  throw new Error(`MISSING: ${CANDIDATES[0]} — ${HINT}`);
}

function assertFn(name, mod) {
  if (typeof mod[name] !== 'function') {
    throw new Error(
      `DRIFT: ${CANDIDATES[0]} — 期望导出函数 ${name}（契约 §3.5），实际导出：${Object.keys(mod).join(', ') || '(无)'}`
    );
  }
}

/** 传入的参数得真的超过上限：能降上限就降（模块级 setCapBytes / 单次 opts.capBytes），否则用默认 8 MiB + 1。 */
function oversizeArgs(mod) {
  if (typeof mod.setCapBytes === 'function') {
    mod.setCapBytes(64);
    return { label: 'setCapBytes(64)', args: { big: 'x'.repeat(256) }, opts: undefined };
  }
  if (mod.invoke.length >= 3) {
    return { label: 'opts.capBytes=64', args: { big: 'x'.repeat(256) }, opts: { capBytes: 64 } };
  }
  return { label: '默认上限 8 MiB', args: { big: 'x'.repeat(8 * 1024 * 1024 + 1) }, opts: undefined };
}

test('默认无传输：invoke 必须 reject（transport-unavailable），不得 resolve 空值', async () => {
  const mod = host();
  assertFn('invoke', mod);
  const err = await expectRejects(
    () => mod.invoke('perm.check', { name: 'ohos.permission.X' }),
    null,
    '契约 §3.5：默认传输不可用 ⇒ reject 结构化错误（C2，不得静默返回空值）'
  );
  const text = describe(err);
  assert(
    /transport-unavailable/.test(text),
    `reject 载荷必须带 error:'transport-unavailable'（契约 §3.5），实际：${text}`
  );
});

test('入参超上限：reject payload-too-large，且不调用传输层', async () => {
  const mod = host();
  assertFn('setTransport', mod);
  let calls = 0;
  mod.setTransport(() => {
    calls++;
    return JSON.stringify({ ok: true, result: {} });
  });
  const { label, args, opts } = oversizeArgs(mod);
  const err = await expectRejects(
    () => mod.invoke('perm.check', args, opts),
    null,
    `入参超上限（${label}）⇒ reject payload-too-large（契约 §3.5 / §2.7 上限语义）`
  );
  const text = describe(err);
  assert(/payload-too-large/.test(text), `reject 载荷必须带 error:'payload-too-large'，实际：${text}`);
  assertEq(calls, 0, '超限入参不该被送进传输层（应在本地拦下）');
});

test('自定义传输返回 {"ok":false,…}：invoke 必须 reject', async () => {
  const mod = host();
  assertFn('setTransport', mod);
  mod.setTransport(() => JSON.stringify({ ok: false, error: 'denied', detail: 'spoofed' }));
  const err = await expectRejects(
    () => mod.invoke('perm.check', { name: 'ohos.permission.X' }),
    (e) => /denied/.test(describe(e)),
    '传输层返回 ok:false ⇒ 必须 reject 并把 error 带出来（契约 §3.5 / C2）'
  );
  assert(/denied/.test(describe(err)), 'describe 自检');
});

test('自定义传输返回 {"ok":true,…}：invoke 正常 resolve', async () => {
  const mod = host();
  mod.setTransport(() => JSON.stringify({ ok: true, result: { probe: 'ok:true' } }));
  const value = await mod.invoke('runtime.facts', {});
  assert(
    /ok:true/.test(describe(value)),
    `ok:true 时应 resolve 出结果（契约 §3.5），实际：${describe(value)}`
  );
});

test('超时路径：传输层永不结算 ⇒ reject timeout（不得挂住）', async () => {
  const mod = host();
  mod.setTransport(() => new Promise(() => {}));
  const invokeSlow = (ms) => {
    // 契约未冻结「超时入口」的形态（默认 10 s 见 specs/003 plan.md §4.3）：三种现实写法都试
    if (typeof mod.setTimeoutMs === 'function') {
      mod.setTimeoutMs(ms);
      return mod.invoke('slow.cap', {});
    }
    if (typeof mod.setTimeout === 'function') {
      mod.setTimeout(ms);
      return mod.invoke('slow.cap', {});
    }
    return mod.invoke('slow.cap', {}, { timeoutMs: ms });
  };
  const err = await expectRejects(
    () => invokeSlow(50),
    (e) => /timeout/.test(describe(e)),
    '传输层永不结算 ⇒ 必须有超时并 reject error:timeout（契约 §3.5 + specs/003 §FR-003-017）',
    3000
  );
  assert(/timeout/.test(describe(err)), 'describe 自检');
});

test('本地注册表 handle/list + facts() 字段面', () => {
  const mod = host();
  assertFn('handle', mod);
  assertFn('list', mod);
  mod.handle('shutdown', async () => ({ ok: true }));
  const names = mod.list();
  assert(Array.isArray(names), `list() 应返回 string[]（契约 §3.5），实际：${describe(names)}`);
  assert(names.includes('shutdown'), `handle('shutdown') 后 list() 应含 'shutdown'，实际：${describe(names)}`);

  assertFn('facts', mod);
  const facts = mod.facts();
  const required = ['node', 'platform', 'arch', 'execArgv', 'pid', 'versions', 'HOME', 'TMPDIR', 'cwd'];
  const missingKeys = required.filter((k) => !(facts && Object.prototype.hasOwnProperty.call(facts, k)));
  assert(
    missingKeys.length === 0,
    `facts() 缺字段 ${JSON.stringify(missingKeys)}（契约 §3.5：node/platform/arch/execArgv/pid/versions/HOME/TMPDIR/cwd），实际：${describe(facts)}`
  );
});
