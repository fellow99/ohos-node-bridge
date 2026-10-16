// tests/lib/mini-assert.mjs —— 零依赖 ESM 微测试框架（契约 §4「tests/payload/*.mjs 纯 Node 单测」）。
//
// 为什么不用 node:test / vitest：本库工具链纪律是「零 npm 依赖」（规划 §7.4 / NFR-004-005），
// 且 host 侧门禁 tools/smoke-host.mjs 会在**子进程**里跑这些文件、只看退出码 + 输出。
// 用法：
//   import { test, assert, assertEq, assertThrows } from '../lib/mini-assert.mjs';
//   test('名字', () => { assertEq(1 + 1, 2); });
// 失败文本必须给出「谁该改什么、期望什么」——这是宪法 C2「不隐藏平台真相」在测试侧的口径：
// 报告「MISSING/DRIFT + 契约路径 + 期望标识符」，而不是裸栈。

const tests = [];
let passed = 0;
let failed = 0;

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败（条件为假）');
}

export function assertEq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg ? msg + '：' : ''}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// 断言 fn() 抛错；match 为可选正则，用来确认「抛的是这一类错」而不是「抛了个别的错」。
export function assertThrows(fn, match, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  const prefix = msg ? msg + '：' : '';
  if (!err) throw new Error(`${prefix}期望抛错，但没有抛（安全校验缺失？）`);
  const text = err && err.message ? err.message : String(err);
  if (match && !match.test(text)) throw new Error(`${prefix}抛错信息不匹配 ${match}，实际：${text}`);
  return err;
}

// 载荷侧文件尚未写出来时的统一失败文本。
export function missing(what, detail) {
  throw new Error(`MISSING: ${what}${detail ? ' — ' + detail : ''}`);
}

// 顺序执行（注册先于运行：setTimeout 让整个模块图先求值完，见 ESM 的求值顺序）。
setTimeout(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${t.name}\n        ${e && e.message ? e.message : String(e)}`);
    }
  }
  console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}  (${passed} passed / ${failed} failed / ${tests.length} total)`);
  process.exitCode = failed ? 1 : 0;
}, 0);
