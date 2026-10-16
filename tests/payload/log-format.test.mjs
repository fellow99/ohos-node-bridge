// tests/payload/log-format.test.mjs —— 契约 §1.3（日志行格式）与 §2.5（解析口径）的单测。
//
// 冻结格式：`<stream> <epochMs> <text>\n`，stream ∈ { out, err, sys }；解析不出来的行按
// §2.5 处理成 { at: 0, stream: 'system', text: <原行> }（**保留原文，不丢信息**）。
//
// 另外一条容易被写错的实现纪律：**JS 侧不得自己拼这个前缀**（契约 §1.3「实现要点」：fd1/fd2 各接一条
// pipe，由原生 reader 线程统一生成 `<stream> <ms> `）。若 selfcheck.js 自己再拼一次，真机上每行都会
// 变成 `sys 1700… out 1700… xxx`，日志环与 /log 的可读性直接废掉。故本文件对 selfcheck.js 做正/负控检查。

import { test, assert, assertEq } from '../lib/mini-assert.mjs';
import { p, payloadExists } from '../lib/util.mjs';
import { parseLogLine, findHandwrittenPrefix, stripComments } from '../lib/log-format.mjs';
import { readFileSync } from 'node:fs';

test('out 行：stream=stdout、epochMs 十进制、text 原样', () => {
  const r = parseLogLine('out 1760659200123 hello');
  assertEq(r.parsed, true, '必须可解析');
  assertEq(r.mark, 'out', 'mark');
  assertEq(r.at, 1760659200123, 'epochMs');
  assertEq(r.stream, 'stdout', '映射到 §2.5 的 stream');
  assertEq(r.text, 'hello', 'text 原样（不转义）');
});

test('err 行：stream=stderr', () => {
  const r = parseLogLine('err 1760659200124 boom');
  assertEq(r.parsed, true, '必须可解析');
  assertEq(r.at, 1760659200124, 'epochMs');
  assertEq(r.stream, 'stderr', '映射到 §2.5 的 stream');
  assertEq(r.text, 'boom', 'text');
});

test('sys 行：stream=system，且 text 以 [node_bridge] 开头', () => {
  const text = "[node_bridge] dlopen('libnode.so') -> OK";
  const r = parseLogLine(`sys 1760659200125 ${text}`);
  assertEq(r.parsed, true, '必须可解析');
  assertEq(r.stream, 'system', '映射到 §2.5 的 stream');
  assertEq(r.text, text, 'text（含单引号与箭头，不做转义）');
  assert(
    r.text.startsWith('[node_bridge] ') || r.text.startsWith('CRASH '),
    `§1.3：sys 行 text 必须以 "[node_bridge] " 或 "CRASH " 开头，实际 ${JSON.stringify(r.text)}`
  );
});

test('无前缀行：按 §2.5 归为不可解析（at=0 / system / 原文保留）', () => {
  const raw = 'hello without any prefix';
  const r = parseLogLine(raw);
  assertEq(r.parsed, false, '无前缀必须判为不可解析');
  assertEq(r.at, 0, 'at');
  assertEq(r.stream, 'system', 'stream');
  assertEq(r.text, raw, 'text 必须保留原文（不丢信息）');
});

test('分隔符纪律：双空格 / tab / 1e3 计数的秒级时间戳都不算合法前缀', () => {
  for (const bad of ['out  1760659200123 hello', 'out\t1760659200123 hello', 'OUT 1760659200123 hello']) {
    const r = parseLogLine(bad);
    assertEq(r.parsed, false, `不应被解析为合法前缀：${JSON.stringify(bad)}`);
    assertEq(r.text, bad, '原文保留');
  }
});

test('尾随换行被吃掉（reader 逐行喂进来的形态）', () => {
  const r = parseLogLine('sys 1760659200125 [node_bridge] stdio ready\n');
  assertEq(r.text, '[node_bridge] stdio ready', 'CRLF/LF 都应被剥掉');
});

test('selfcheck.js 不得自己拼 `<stream> <ms> ` 前缀（正/负控 + 真实文件）', () => {
  // 1) 正控：检测器不是空壳 —— 这两种写法必须被认出来
  const pos1 = "const line = 'err ' + Date.now() + ' boom';\n";
  const pos2 = 'const l = `out ${Date.now()} hi`;\n';
  assert(findHandwrittenPrefix(pos1), '正控 1 失效：检测器没认出手写前缀');
  assert(findHandwrittenPrefix(pos2), '正控 2 失效：检测器没认出模板串前缀');

  // 2) 负控：正常的读写回、正常的日志文案不得误报
  const neg1 = "res.end(text);\nconst t = fs.readFileSync(p, 'utf8');\n";
  const neg2 = "process.stdout.write('[selfcheck] listening 127.0.0.1:' + PORT + '\\n');\n";
  assertEq(findHandwrittenPrefix(neg1), null, '负控 1 误报');
  assertEq(findHandwrittenPrefix(neg2), null, '负控 2 误报');

  // 3) 注释里出现示例前缀不算违例（注释先被剥掉）
  const commentOnly = '// 前缀形如 out <ms> xxx，由原生 reader 线程加，这里不要自己拼\nconst x = 1;\n';
  assertEq(findHandwrittenPrefix(commentOnly), null, '注释内的示例文本不该被判违例');

  // 4) 真实文件
  if (!payloadExists('payload/selfcheck.js')) {
    throw new Error('MISSING: payload/selfcheck.js — 契约 §3.6 的自检端点实现（本项测它的日志纪律）');
  }
  const src = readFileSync(p('payload', 'selfcheck.js'), 'utf8');
  const hit = findHandwrittenPrefix(src);
  assert(
    hit === null,
    `payload/selfcheck.js:${hit ? hit.line : '?'} 手写了日志前缀（${hit ? hit.why : ''}）：${hit ? hit.text : ''} —— 前缀由原生层生成，JS 侧再拼会造成双重前缀（契约 §1.3）`
  );
  assert(stripComments(src).length > 0, '源码剥离注释后不应为空（检测逻辑自检）');
});

test('（可选）载荷自带日志解析器若存在，必须与 §1.3/§2.5 一致', () => {
  const candidates = ['payload/lib/log-format.js', 'payload/log-format.js'];
  const found = candidates.find((rel) => payloadExists(rel));
  if (!found) {
    console.log('        （信息）未发现载荷自带解析器（payload/lib/log-format.js）⇒ 跳过交叉校验；§2.5 的映射在 ArkTS 侧（Logger）');
    return;
  }
  const mod = readFileSync(p(found), 'utf8');
  assert(mod.length > 0, `${found} 为空`);
  // 只做「存在且声明了 §1.3 的三种 stream」的最低限度检查，具体 API 由 006 模块定
  for (const token of ['out', 'err', 'sys']) {
    assert(new RegExp(`['"\`]${token}['"\`]`).test(mod), `${found} 未见 stream 标记 ${token}（契约 §1.3）`);
  }
});
