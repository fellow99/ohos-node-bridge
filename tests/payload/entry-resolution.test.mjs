// tests/payload/entry-resolution.test.mjs —— 契约 §3.3（入口解析）的 host 侧单测。
//
// 契约原文（§3.3）：
//   1) 绝对路径 ⇒ 直接用；
//   2) 相对路径 ⇒ path.resolve(runRoot, entry)；
//   3) 缺席 ⇒ path.join(runRoot, 'index.js')（并检查 package.json 的 main，存在则用它）；
//   4) 加载：require(entry)，失败（ERR_REQUIRE_ESM / ERR_REQUIRE_ASYNC_MODULE）⇒ import()；
//   5) 打印 `[bootstrap] entry=<abs> mode=<cjs|esm> root=<runRoot> cwd=<cwd>`。
//
// 被测对象是 `payload/bootstrap.js` 的**子进程行为**：给它受控 env（HOME / NODE_BRIDGE_*），
// 断言它 stdout/stderr 上的标记行 —— 这也是真机上唯一的读回通道形态（真机 cwd=/，见 §D.8）。

import { test, assert } from '../lib/mini-assert.mjs';
import { p, makeTmp, rmrf, payloadExists, runNode } from '../lib/util.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BOOTSTRAP = p('payload', 'bootstrap.js');

/** 生成一个"只打印标记行"的入口脚本（不写文件、不监听端口，进程自然退出）。 */
function markerScript(mark) {
  return `process.stdout.write('${mark}\\n');\n`;
}

function fixture(label) {
  const tmp = makeTmp(label);
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'cwd');
  const payloadRoot = path.join(tmp, 'payload');
  mkdirSync(path.join(home, 'payload'), { recursive: true });
  mkdirSync(payloadRoot, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    tmp,
    home,
    cwd,
    payloadRoot,
    absEntry: path.join(tmp, 'entry-abs.js'),
    done: () => rmrf(tmp),
  };
}

function runBootstrap(fx, extraEnv) {
  return runNode(BOOTSTRAP, {
    env: {
      NODE_OPTIONS: '',
      HOME: fx.home,
      NODE_BRIDGE_PAYLOAD_ROOT: fx.payloadRoot,
      NODE_BRIDGE_CWD: fx.cwd,
      ...extraEnv,
    },
    timeoutMs: 30000,
  });
}

function outputOf(label, r) {
  return (
    `${label}\n        exit=${r.status} signal=${r.signal || '-'} timedOut=${!!r.timedOut}\n` +
    `        stdout: ${JSON.stringify(r.stdout)}\n` +
    `        stderr: ${JSON.stringify(r.stderr)}`
  );
}

function assertMark(label, r, mark) {
  if (!r.all.includes(mark)) throw new Error(outputOf(`${label}：入口没有被执行（没看到标记 ${mark}）`, r));
}

/** 路径比较：统一分隔符 + 大小写（Windows 盘符/路径大小写不敏感）。 */
function norm(pth) {
  return path.resolve(String(pth)).replace(/\\/g, '/').toLowerCase();
}

/** 从输出里取 `[bootstrap] entry=… mode=… root=… cwd=…` 行。 */
function entryLine(r) {
  const m = /^\[bootstrap\] entry=(.+?) mode=(cjs|esm) root=(.+?) cwd=(.+?)$/m.exec(r.all);
  return m ? { raw: m[0], entry: m[1], mode: m[2], root: m[3], cwd: m[4] } : null;
}

test('入口=绝对路径：直接用，不拼运行根', () => {
  if (!payloadExists('payload/bootstrap.js')) {
    throw new Error('MISSING: payload/bootstrap.js — 契约 §3.3 的入口解析实现（本文件测它）');
  }
  const fx = fixture('entry-abs');
  try {
    const mark = 'FIXTURE_ABS_OK';
    writeFileSync(fx.absEntry, markerScript(mark));
    const r = runBootstrap(fx, { NODE_BRIDGE_ENTRY: fx.absEntry });
    assertMark('绝对路径入口', r, mark);
    const line = entryLine(r);
    if (line) {
      assert(norm(line.entry) === norm(fx.absEntry), outputOf(`entry= 应是绝对路径 ${fx.absEntry}`, r));
    }
  } finally {
    fx.done();
  }
});

test('入口=相对路径：按运行根 resolve', () => {
  const fx = fixture('entry-rel');
  try {
    const mark = 'FIXTURE_REL_OK';
    mkdirSync(path.join(fx.payloadRoot, 'sub'), { recursive: true });
    writeFileSync(path.join(fx.payloadRoot, 'sub', 'rel.js'), markerScript(mark));
    const r = runBootstrap(fx, { NODE_BRIDGE_ENTRY: 'sub/rel.js' });
    assertMark('相对路径入口', r, mark);
    const line = entryLine(r);
    if (line) {
      const expect = path.join(fx.payloadRoot, 'sub', 'rel.js');
      assert(norm(line.entry) === norm(expect), outputOf(`entry= 应解析为 ${expect}`, r));
    }
  } finally {
    fx.done();
  }
});

test('入口缺席：回落到 <运行根>/index.js', () => {
  const fx = fixture('entry-default');
  try {
    const mark = 'FIXTURE_DEFAULT_OK';
    writeFileSync(path.join(fx.payloadRoot, 'index.js'), markerScript(mark));
    const r = runBootstrap(fx, {});
    assertMark('入口缺席 ⇒ runRoot/index.js', r, mark);
  } finally {
    fx.done();
  }
});

test('入口缺席：package.json 的 main 生效（且优先于约定 index.js 的缺失）', () => {
  const fx = fixture('entry-main');
  try {
    const mark = 'FIXTURE_MAIN_OK';
    mkdirSync(path.join(fx.payloadRoot, 'lib'), { recursive: true });
    writeFileSync(path.join(fx.payloadRoot, 'lib', 'main.js'), markerScript(mark));
    writeFileSync(path.join(fx.payloadRoot, 'package.json'), JSON.stringify({ name: 'fixture', main: 'lib/main.js' }, null, 2));
    const r = runBootstrap(fx, {});
    assertMark('入口缺席 ⇒ package.json main', r, mark);
  } finally {
    fx.done();
  }
});

test('ESM 入口（.mjs）：必须被执行（require(esm) 或 import() 都算通过）', () => {
  const fx = fixture('entry-esm');
  try {
    const mark = 'FIXTURE_ESM_OK';
    writeFileSync(path.join(fx.payloadRoot, 'esm-entry.mjs'), `export default 1;\n${markerScript(mark)}`);
    const r = runBootstrap(fx, { NODE_BRIDGE_ENTRY: 'esm-entry.mjs' });
    assertMark('ESM 入口', r, mark);
    const line = entryLine(r);
    console.log(`        （信息）ESM 轮次日志行：${line ? line.raw : '(未打印 §3.3 第 5 条的 entry 行)'}`);
  } finally {
    fx.done();
  }
});

test('日志行：[bootstrap] entry=<abs> mode=<cjs|esm> root=<runRoot> cwd=<cwd>', () => {
  const fx = fixture('entry-logline');
  try {
    const mark = 'FIXTURE_LOG_OK';
    writeFileSync(fx.absEntry, markerScript(mark));
    const r = runBootstrap(fx, { NODE_BRIDGE_ENTRY: fx.absEntry });
    const line = entryLine(r);
    if (!line) {
      throw new Error(outputOf('契约 §3.3 第 5 条：必须打印 [bootstrap] entry=<abs> mode=<cjs|esm> root=<runRoot> cwd=<cwd>', r));
    }
    assert(
      path.isAbsolute(line.entry),
      outputOf(`entry= 必须是绝对路径（S4：真机 cwd=/），实际 ${JSON.stringify(line.entry)}`, r)
    );
    assert(norm(line.entry) === norm(fx.absEntry), outputOf('entry= 与实际入口不符', r));
    assert(
      line.mode === 'cjs',
      outputOf(`mode= 应为 cjs（.js 的 CJS 入口先 require，契约 §3.3 第 4 条），实际 ${line.mode}`, r)
    );
    assert(norm(line.root) === norm(fx.payloadRoot), outputOf(`root= 应为运行根 ${fx.payloadRoot}（未给归档 ⇒ 回落 payloadRoot）`, r));
    assert(norm(line.cwd) === norm(fx.cwd), outputOf(`cwd= 应等于 NODE_BRIDGE_CWD=${fx.cwd}（契约 §3.1）`, r));
  } finally {
    fx.done();
  }
});
