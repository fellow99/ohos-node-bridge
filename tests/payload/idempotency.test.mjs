// tests/payload/idempotency.test.mjs —— 契约 §3.2（幂等判据）的 host 侧单测。
//
// 覆盖三件事：
//   ① 首次运行：解包 → 入口真的跑了（C3 读回）→ marker 落盘（`.ready-<sha256 前 12 位>`，内含完整 sha256）；
//   ② 二次运行：命中 marker ⇒ 打印 `[bootstrap] payload ready (skip)`，且**解包文件 mtime 一字不改**
//      （为了不退化成「同一秒重解也看不出」的假判据，二次运行前把 mtime 显式倒回到 2001 年）；
//   ③ `NODE_BRIDGE_ARCHIVE_SHA256` 与实际不符 ⇒ **硬失败**：不加载入口、不写 marker、有可读的失败文本。
//
// 契约冲突提示：specs/004 plan.md §4.4 记的是 `<payloadRoot>/<archive 基名>.sha256`；**以冻结契约 §3.2 为准**
// （`.ready-<前 12 位>` + 完整 sha256 内容），故本文件按契约断言，失败时会把实际目录列出来。

import { test, assert } from '../lib/mini-assert.mjs';
import { p, makeTmp, rmrf, payloadExists, runNode } from '../lib/util.mjs';
import * as F from '../lib/tar-fixtures.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';

const BOOTSTRAP = p('payload', 'bootstrap.js');
const ENTRY_MARK = 'FIXTURE_ENTRY_OK';
const SKIP_LINE = '[bootstrap] payload ready (skip)';
const BACKDATED = new Date('2001-01-02T03:04:05Z');

const FIXTURE_ENTRY = [
  "const fs = require('fs');",
  "try { fs.writeFileSync('entry-ran.txt', 'ok'); } catch (e) {}",
  `process.stdout.write('${ENTRY_MARK}\\n');`,
  '',
].join('\n');

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 建一个 payloadRoot + HOME + 归档；归档内含 index.js（入口）、data/nested.txt 与一个目录条目。 */
function fixture(label) {
  const tmp = makeTmp(label);
  const home = path.join(tmp, 'home');
  const payloadRoot = path.join(tmp, 'payload');
  mkdirSync(path.join(home, 'payload'), { recursive: true });
  mkdirSync(payloadRoot, { recursive: true });
  const archive = path.join(tmp, 'fixture.tar.gz');
  F.writeTarGz(archive, [
    F.dir('data'),
    F.file('data/nested.txt', 'NESTED-OK'),
    F.file('index.js', FIXTURE_ENTRY),
    F.zeroBlocks(),
  ]);
  const sha = sha256File(archive);
  return {
    tmp,
    home,
    payloadRoot,
    archive,
    sha,
    target: path.join(payloadRoot, sha.slice(0, 12)),
    marker: path.join(payloadRoot, `.ready-${sha.slice(0, 12)}`),
    done: () => rmrf(tmp),
  };
}

function runBootstrap(fx, envOverride = {}) {
  return runNode(BOOTSTRAP, {
    env: {
      NODE_OPTIONS: '',
      HOME: fx.home,
      NODE_BRIDGE_PAYLOAD_ROOT: fx.payloadRoot,
      NODE_BRIDGE_ARCHIVE: fx.archive,
      NODE_BRIDGE_ARCHIVE_SHA256: fx.sha,
      ...envOverride,
    },
    timeoutMs: 30000,
  });
}

/** 失败文本里带上子进程原话，避免「只看到一句断言失败」。 */
function withOutput(label, r) {
  return (
    `${label}\n        子进程 exit=${r.status} signal=${r.signal || '-'} timedOut=${!!r.timedOut}\n` +
    `        stdout: ${JSON.stringify(r.stdout)}\n` +
    `        stderr: ${JSON.stringify(r.stderr)}`
  );
}


function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (e) {
    return `(读目录失败：${e && e.code ? e.code : e})`;
  }
}

test('首次运行：解包 + 入口读回 + marker 落盘（内容含完整 sha256）', () => {
  if (!payloadExists('payload/bootstrap.js')) {
    throw new Error('MISSING: payload/bootstrap.js — 契约 §3.1/§3.2 的归档就绪路径（本文件测它）');
  }
  const fx = fixture('idem-first');
  try {
    const r = runBootstrap(fx);
    if (!r.all.includes(ENTRY_MARK)) {
      throw new Error(withOutput('入口没有被加载（契约 §3.3：runRoot/index.js 应被 require）', r));
    }
    // C3：写入成功 = 读回者的判据 —— 断言解出来的文件能被读回
    const nested = path.join(fx.target, 'data', 'nested.txt');
    if (!existsSync(nested)) {
      throw new Error(
        `解包目标目录不符合契约 §3.2（期望 <payloadRoot>/<sha256 前 12 位> = ${fx.target}）\n` +
          `        实际 payloadRoot 内容：${JSON.stringify(listDir(fx.payloadRoot))}`
      );
    }
    const back = readFileSync(nested, 'utf8');
    assert(back === 'NESTED-OK', `读回 data/nested.txt 期望 NESTED-OK，实际 ${JSON.stringify(back)}`);
    // marker：契约 §3.2 路径 + 内容含完整 sha256
    if (!existsSync(fx.marker)) {
      throw new Error(
        `缺就绪 marker ${fx.marker}（契约 §3.2：marker = <payloadRoot>/.ready-<sha256 前 12 位>，内含完整 sha256）\n` +
          `        实际 payloadRoot 内容：${JSON.stringify(listDir(fx.payloadRoot))}`
      );
    }
    const markerText = readFileSync(fx.marker, 'utf8');
    assert(
      markerText.includes(fx.sha),
      `marker 内容必须含完整 sha256（契约 §3.2），实际：${JSON.stringify(markerText.slice(0, 400))}`
    );
  } finally {
    fx.done();
  }
});

test('二次运行：走 skip 路径，且解包文件 mtime 不变', () => {
  const fx = fixture('idem-skip');
  try {
    const first = runBootstrap(fx);
    if (!first.all.includes(ENTRY_MARK)) {
      throw new Error(withOutput('第一次运行就没能加载入口，无法验证幂等（先修首次路径）', first));
    }
    const watched = [path.join(fx.target, 'index.js'), path.join(fx.target, 'data', 'nested.txt')];
    for (const f of watched) {
      if (!existsSync(f)) {
        throw new Error(`幂等判据前置失败：${f} 不存在（期望解包产物），实际 payloadRoot：${JSON.stringify(listDir(fx.payloadRoot))}`);
      }
      utimesSync(f, BACKDATED, BACKDATED); // 倒回 2001 年：若二次运行重解，mtime 会变成「现在」
    }
    const before = watched.map((f) => statSync(f).mtimeMs);

    const second = runBootstrap(fx);
    if (!second.all.includes(SKIP_LINE)) {
      throw new Error(
        withOutput(`二次运行没有打印契约 §3.2 的跳过行 ${JSON.stringify(SKIP_LINE)}（幂等没生效？）`, second)
      );
    }
    const after = watched.map((f) => statSync(f).mtimeMs);
    for (let i = 0; i < watched.length; i++) {
      assert(
        Math.abs(after[i] - before[i]) < 2000,
        `二次运行重写了 ${path.relative(fx.target, watched[i])}：mtime ${before[i]} → ${after[i]}（命中 marker 就不该再解包）`
      );
    }
    assert(Math.abs(before[0] - BACKDATED.getTime()) < 5000, '夹具自检：倒回 mtime 应生效（否则本用例的 mtime 判据无效）');
  } finally {
    fx.done();
  }
});

test('NODE_BRIDGE_ARCHIVE_SHA256 不符 ⇒ 硬失败（不加载入口、不写 marker）', () => {
  const fx = fixture('idem-badsha');
  try {
    const wrong = 'b'.repeat(64);
    const r = runBootstrap(fx, { NODE_BRIDGE_ARCHIVE_SHA256: wrong });
    if (r.all.includes(ENTRY_MARK)) {
      throw new Error(
        withOutput('哈希不符却仍然加载了入口 —— 静默继续（契约 §3.2 要求硬失败）', r)
      );
    }
    const markers = existsSync(fx.payloadRoot)
      ? readdirSync(fx.payloadRoot).filter((n) => n.startsWith('.ready-'))
      : [];
    assert(
      markers.length === 0,
      `哈希不符却写了 marker：${JSON.stringify(markers)}（契约 §3.2：不一致 ⇒ 硬失败，不写就绪标记）`
    );
    assert(
      /mismatch|不一致|不匹配|sha256|SHA-256|哈希|FATAL|fail|失败/i.test(r.all),
      withOutput('哈希不符没有任何可读的失败文本（C2：失败必须可见）', r)
    );
    // 信息性：目标目录是否被提前建出来（不作为失败判据，只写进报告）
    console.log(
      `        （信息）哈希不符时目标目录存在=${existsSync(fx.target)}，payloadRoot 内容=${JSON.stringify(listDir(fx.payloadRoot))}`
    );
  } finally {
    fx.done();
  }
});
