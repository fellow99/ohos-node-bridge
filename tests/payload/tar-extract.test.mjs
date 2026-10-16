// tests/payload/tar-extract.test.mjs —— 契约 §3.7（ustar 解包器）的 host 侧单测。
//
// 判据纪律（C3「谁写谁读」）：每个用例都**读回**解出来的文件内容做断言，不看 statSync。
// 夹具由 tests/lib/tar-fixtures.mjs 直接拼 512 字节头生成（宿主 tar 不可信、设备侧也没有 tar）。
//
// 契约路径是 payload/lib/tar-extract.js；payload/tar-extract.js 是 specs/004 plan.md §3.7 记的
// 另一处候选（并行实现者可能落在那儿），故按候选顺序加载，但报错文本以契约路径为准。

import { test, assert, assertEq } from '../lib/mini-assert.mjs';
import { loadPayload, makeTmp, rmrf, describe, expectRejects } from '../lib/util.mjs';
import * as F from '../lib/tar-fixtures.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const CONTRACT_PATH = 'payload/lib/tar-extract.js';
const CANDIDATES = [CONTRACT_PATH, 'payload/tar-extract.js'];
const HINT = '签名 extractTarGz(archive, dest, deps?) → { files, bytes, dirs }（契约 §3.7）';

function extractTarGz() {
  return loadPayload(CANDIDATES, 'extractTarGz', HINT);
}

/** 兼容同步/返回 Promise 的两种实现（契约要求流式，故两种都当作合法形态）。 */
async function runExtract(fn, archive, dest) {
  const r = fn(archive, dest);
  return r && typeof r.then === 'function' ? await r : r;
}

function assertStats(stats, label) {
  if (!stats || typeof stats !== 'object') {
    throw new Error(`${label}：期望返回 { files, bytes, dirs } 统计对象（契约 §3.7），实际：${describe(stats)}`);
  }
  if (typeof stats.files !== 'number') {
    throw new Error(`${label}：统计对象缺数字字段 files（契约 §3.7），实际：${describe(stats)}`);
  }
}

function readBack(dest, rel) {
  const abs = path.join(dest, ...rel.split('/'));
  if (!existsSync(abs)) {
    const seen = walk(dest).map((x) => path.relative(dest, x).replace(/\\/g, '/'));
    throw new Error(`读回失败：${rel} 不存在（C3：写入成功必须能被读者读到）；实际解出：${describe(seen)}`);
  }
  return readFileSync(abs);
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else out.push(abs);
    }
  }
  return out;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 建 tmp/archive/dest 三件套；返回 { tmp, archive, dest, done }。 */
function fixture(label) {
  const tmp = makeTmp(label);
  const dest = path.join(tmp, 'out');
  mkdirSync(dest, { recursive: true });
  return { tmp, dest, archive: path.join(tmp, 'payload.tar.gz'), done: () => rmrf(tmp) };
}

test('普通文件：解出且内容逐字节读回一致', async () => {
  const fx = fixture('tar-plain');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('hello.txt', 'hello\n'), F.zeroBlocks()]);
    const stats = await runExtract(fn, fx.archive, fx.dest);
    assertStats(stats, '普通文件');
    assertEq(readBack(fx.dest, 'hello.txt').toString('utf8'), 'hello\n', '普通文件内容');
    assert(stats.files >= 1, `普通文件：files 统计应 >= 1，实际 ${stats.files}`);
  } finally {
    fx.done();
  }
});

test('嵌套目录：目录条目 + 深层文件都能落地', async () => {
  const fx = fixture('tar-nested');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [
      F.dir('dir'),
      F.file('dir/sub/file.txt', 'nested-ok'),
      F.zeroBlocks(),
    ]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'dir/sub/file.txt').toString('utf8'), 'nested-ok', '嵌套文件内容');
  } finally {
    fx.done();
  }
});

test('prefix 字段长名（name+prefix > 100）：必须按 prefix 拼接，不得静默截断', async () => {
  const fx = fixture('tar-prefix');
  try {
    const fn = extractTarGz();
    const prefix = 'deep/quite/long/directory/chain/that/exceeds/one/hundred/characters/in/total/for/sure';
    const name = 'prefix-field-file.txt';
    assert(prefix.length + name.length > 100, `夹具自检：prefix+name 必须 > 100，实际 ${prefix.length + name.length}`);
    F.writeTarGz(fx.archive, [
      F.header({ name, prefix, typeflag: '0', size: 'PREFIX-OK'.length }),
      F.pad512('PREFIX-OK'),
      F.zeroBlocks(),
    ]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, `${prefix}/${name}`).toString('utf8'), 'PREFIX-OK', 'prefix 拼接路径');
    assert(!existsSync(path.join(fx.dest, name)), `prefix 被忽略：目标根下不该出现 ${name}（那是截断后的错误路径）`);
  } finally {
    fx.done();
  }
});

test('GNU L 长名（>100 B）：按 L 头重建完整路径', async () => {
  const fx = fixture('tar-gnu-l');
  try {
    const fn = extractTarGz();
    const longName = `gnu/${'x'.repeat(180)}/${'y'.repeat(40)}.txt`;
    assert(longName.length > 200, '夹具自检：GNU 长名应 > 200 字符');
    F.writeTarGz(fx.archive, [F.gnuLongName(longName, 'LONG-OK'), F.zeroBlocks()]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, longName).toString('utf8'), 'LONG-OK', 'GNU 长名路径');
  } finally {
    fx.done();
  }
});

test('pax x 头：数据必须被跳过（后续条目不得错位）', async () => {
  const fx = fixture('tar-pax');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [
      F.paxHeader({ mtime: '1700000000' }),
      F.file('pax-real.txt', 'PAX-OK'),
      F.zeroBlocks(),
    ]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'pax-real.txt').toString('utf8'), 'PAX-OK', 'pax 之后的正条目');
    for (const abs of walk(fx.dest)) {
      const text = readFileSync(abs).toString('utf8');
      assert(
        !text.includes('mtime=1700000000') && !text.includes('PaxHeaders'),
        `pax 头数据被当成文件写出来了：${path.basename(abs)} 内容含 pax 记录（契约 §3.7 要求跳过 x 头数据）`
      );
    }
  } finally {
    fx.done();
  }
});

test('typeflag g（全局 pax 头）：数据同样被跳过', async () => {
  const fx = fixture('tar-pax-g');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [
      F.paxGlobalHeader({ comment: 'global' }),
      F.file('after-g.txt', 'G-OK'),
      F.zeroBlocks(),
    ]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'after-g.txt').toString('utf8'), 'G-OK', 'g 头之后的正条目');
  } finally {
    fx.done();
  }
});

test('空文件（size=0）：落成 0 字节文件', async () => {
  const fx = fixture('tar-empty');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('empty.txt', ''), F.zeroBlocks()]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'empty.txt').length, 0, '空文件长度');
  } finally {
    fx.done();
  }
});

test('300 KB 多块 + 补齐文件：SHA-256 与源一致', async () => {
  const fx = fixture('tar-big');
  try {
    const fn = extractTarGz();
    const size = 307211; // 600 个整块 + 11 字节 ⇒ 末块有 501 B 补齐
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i++) content[i] = (i * 31 + 7) & 0xff;
    F.writeTarGz(fx.archive, [F.file('big.bin', content), F.zeroBlocks()]);
    const stats = await runExtract(fn, fx.archive, fx.dest);
    assertStats(stats, '大文件');
    const back = readBack(fx.dest, 'big.bin');
    assertEq(back.length, size, '大文件长度');
    assertEq(sha256(back), sha256(content), '大文件 SHA-256（含末块补齐是否被误写入）');
    assert(stats.bytes >= size, `大文件：bytes 统计应 >= ${size}，实际 ${stats.bytes}`);
  } finally {
    fx.done();
  }
});

test('路径穿越 ../：必须抛错，且目标根之外零写入', async () => {
  const fx = fixture('tar-escape');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('../escaped.txt', 'PWNED'), F.zeroBlocks()]);
    // extractTarGz 是**流式异步**实现（契约 §3.7）⇒ 越界是 reject 而不是同步 throw，两种都认
    await expectRejects(
      () => fn(fx.archive, fx.dest),
      null,
      '契约 §3.7：解析后的绝对路径必须落在目标目录内，越界必须拒绝'
    );
    assert(!existsSync(path.join(fx.tmp, 'escaped.txt')), '越界文件被写到了目标根之外：' + path.join(fx.tmp, 'escaped.txt'));
  } finally {
    fx.done();
  }
});

test('绝对路径条目：必须抛错', async () => {
  const fx = fixture('tar-abs');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('/abs.txt', 'PWNED'), F.zeroBlocks()]);
    await expectRejects(() => fn(fx.archive, fx.dest), null, '契约 §3.7：绝对路径条目必须拒绝');
    assert(!existsSync(path.join(fx.dest, 'abs.txt')), '目标根内不该出现 abs.txt（绝对路径条目已被拒）');
  } finally {
    fx.done();
  }
});

test('数据被截断（声明 4096 B、实际 3 块）：必须抛错', async () => {
  const fx = fixture('tar-trunc');
  try {
    const fn = extractTarGz();
    const partial = Buffer.concat([
      F.header({ name: 'trunc.bin', typeflag: '0', size: 4096 }),
      Buffer.alloc(3 * F.BLOCK, 0x41), // 只有 1536 B，且没有结束零块
    ]);
    F.writeRawTarGz(fx.archive, partial);
    await expectRejects(() => fn(fx.archive, fx.dest), null, '契约 §3.7：截断数据必须拒绝（不得返回部分成功）');
  } finally {
    fx.done();
  }
});

test('两个零块 = 干净结束（正常返回）', async () => {
  const fx = fixture('tar-end2');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('a.txt', 'a'), F.zeroBlocks(), F.zeroBlocks()]);
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'a.txt').toString('utf8'), 'a', '零块结束后的文件');
  } finally {
    fx.done();
  }
});

test('EOF 前没有零块：容忍（不抛错、文件已落地）', async () => {
  const fx = fixture('tar-noend');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [F.file('b.txt', 'b-no-end-blocks')]); // 刻意不写结束零块
    await runExtract(fn, fx.archive, fx.dest);
    assertEq(readBack(fx.dest, 'b.txt').toString('utf8'), 'b-no-end-blocks', '无结束块的文件');
  } finally {
    fx.done();
  }
});

test('C4：首字节为 0 但整块非 0 的头块 ⇒ 必须抛错（不得当成归档结束而静默截断）', async () => {
  const fx = fixture('tar-badend');
  try {
    const fn = extractTarGz();
    const bogus = Buffer.alloc(F.BLOCK, 0);
    bogus[300] = 0x11; // 首字节仍是 0，但整块**不是**全 0 ⇒ 是畸形/截断头，不是结束块
    F.writeTarGz(fx.archive, [F.file('a.txt', 'A'), bogus, F.file('after.txt', 'AFTER')]);
    // 旧实现只看首字节 ⇒ 把 bogus 当结束块，after.txt 被**静默丢弃**且 finish() 通过
    // ⇒ bootstrap 会为不完整的树写就绪 marker。现在必须硬失败。
    await expectRejects(
      () => fn(fx.archive, fx.dest),
      null,
      '契约 §3.7 / C4：结束块必须是整块 512 B 全 0，畸形块必须拒绝（不得静默截断归档）'
    );
    assert(
      !existsSync(path.join(fx.dest, 'after.txt')),
      '畸形结束块之后的条目不得被写出（那正是「静默截断」的物证）'
    );
  } finally {
    fx.done();
  }
});

test('C4：结果对象必须含 skipped 计数（解包树不完整可审计）', async () => {
  const fx = fixture('tar-skipped');
  try {
    const fn = extractTarGz();
    F.writeTarGz(fx.archive, [
      F.header({ name: 'link.txt', typeflag: '2', linkname: 'real.txt', size: 0 }),
      F.file('real.txt', 'REAL'),
      F.zeroBlocks(),
    ]);
    const stats = await runExtract(fn, fx.archive, fx.dest);
    assertStats(stats, 'skipped 计数');
    assertEq(readBack(fx.dest, 'real.txt').toString('utf8'), 'REAL', '被跳过条目之后的正条目');
    assert(
      typeof stats.skipped === 'number' && stats.skipped >= 1,
      `结果对象应回传 skipped >= 1（跳过一条 symlink），实际 ${JSON.stringify(stats)}`
    );
  } finally {
    fx.done();
  }
});
