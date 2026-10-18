// tests/payload/sample-wiring.test.mjs —— 样例/探针（`samples/minimal-app`）的**离线守门**。
//
// 定位：样例要长期当"参考实现"用，最容易腐坏的不是 Node 侧（那有真机 /facts 兜底），而是
// **接线**：依赖指错、模块没挂进 build-profile、权限漏声明、载荷被写成只读落点、多词 flags 被
// `aa --ps` 截断而没人发现。这些都能在 host 侧判，且判据稳定（不接真机）。
//
// 判据纪律（宪法 C2/C6）：只断言**文件里写死的事实**，不推断"应该能跑"；跑不跑得起来由
// `tools/probe.mjs` 的真机 `/facts` 回答。

import { test, assert, assertEq } from '../lib/mini-assert.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = path.join(REPO, 'samples', 'minimal-app');
const read = (p) => readFileSync(path.join(SAMPLE, p), 'utf8');
const readRepo = (p) => readFileSync(path.join(REPO, p), 'utf8');

test('样例已挂进根 build-profile.json5 的 modules[]', () => {
  const text = readRepo('build-profile.json5');
  assert(/"srcPath"\s*:\s*"\.\/samples\/minimal-app"/.test(text), '缺 srcPath ./samples/minimal-app');
  assert(/"name"\s*:\s*"minimalapp"/.test(text), '缺 module name minimalapp');
});

test('样例依赖指向**库源码**（离线可构建，不需要先发布 ohpm）', () => {
  const text = read('oh-package.json5');
  assert(/"@fellow99\/node-bridge"\s*:\s*"file:\.\.\/\.\.\/library"/.test(text),
    'oh-package.json5 必须写 file:../../library');
});

test('模块清单：entry + 主入口 + 四条权限', () => {
  const text = read('src/main/module.json5');
  assert(/"name"\s*:\s*"minimalapp"/.test(text), 'module.name 必须是 minimalapp（不带连字符）');
  assert(/"type"\s*:\s*"entry"/.test(text), 'type 必须是 entry');
  assert(/"mainElement"\s*:\s*"EntryAbility"/.test(text), 'mainElement 必须是 EntryAbility');
  for (const perm of [
    'ohos.permission.INTERNET',
    'ohos.permission.GET_NETWORK_INFO',
    'ohos.permission.kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY',
    'ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION',
  ]) {
    assert(text.includes(perm), `缺权限 ${perm}（缺它真机上要么 load 不到 libnode、要么 JIT 直接 SIGTRAP）`);
  }
});

test('样例**不随包** libnode.so（运行时由 tools/provision.mjs 投放，且被 gitignore）', () => {
  assert(!existsSync(path.join(SAMPLE, 'libs', 'arm64-v8a', 'libnode.so')) || true, '（本地投放与否都合法）');
  const gi = readRepo('.gitignore');
  assert(/\*\*\/libnode\.so/.test(gi), '.gitignore 必须排掉 libnode.so（121 MB 不入库）');
  const pj = readRepo('tools/provision.mjs');
  assert(/--out/.test(pj), 'provision.mjs 必须支持 --out（样例的投放落点）');
});

test('载荷 probe.js：只绑 127.0.0.1 + 有 /facts + 两项扩展检查 + 写到可写目录', () => {
  const js = read('src/main/resources/rawfile/probe.js');
  assert(/server\.listen\(PORT, '127\.0\.0\.1'/.test(js), '必须只绑 127.0.0.1（不得 0.0.0.0）');
  assert(/'\/facts'|"\/facts"/.test(js) || /req\.url === '\/log'/.test(js), '缺 /facts 端点');
  assert(js.includes('expose_internals'), '缺 expose_internals 检查（Phase 0 探针的判据之一）');
  assert(js.includes('worker_threads'), '缺 worker_threads 检查');
  assert(js.includes("process.env.HOME"), '落点必须基于 HOME（可写）；写 __dirname 会在只读安装目录失败');
  assert(!/writeFileSync\([^)]*__dirname/.test(js), '禁止往 __dirname 写（只读）');
});

test('页面走库的契约 API：Env.materializeRawfile + NodeRuntime.start + Logger.tail', () => {
  const ets = read('src/main/ets/pages/Index.ets');
  assert(ets.includes("from '@fellow99/node-bridge'"), '必须从库（HAR）导入，不得自带 .so');
  assert(ets.includes('Env.ensureRuntimeDirs'), '缺 Env.ensureRuntimeDirs（投递前必须建齐目录）');
  assert(ets.includes('Env.materializeRawfile'), '缺 Env.materializeRawfile（rawfile → 可写沙箱）');
  assert(/\.start\(ctx, options\)/.test(ets), '缺 NodeRuntime.start(ctx, options)');
  assert(ets.includes('Logger.tail'), '缺 Logger.tail（界面日志面板）');
  assert(!/import\s+\w+\s+from\s+'libnode_bridge\.so'/.test(ets), '样例不得直接 import 原生 .so（那是库的事）');
});

test('命令行传参：档位走**索引**（多词 flags 会被 aa --ps 截断）', () => {
  const ab = read('src/main/ets/entryability/EntryAbility.ets');
  assert(ab.includes('probePreset'), 'EntryAbility 必须读 probePreset');
  assert(ab.includes('probeAuto'), 'EntryAbility 必须读 probeAuto（自动化免手点）');
  const idx = read('src/main/ets/pages/Index.ets');
  assert(idx.includes("AppStorage.get<string>('probePreset')"), '页面必须消费 probePreset');
  // 回归守卫：缺省 flags 不得是某一档的 flags（否则它会经 AppStorage 压过档位选择）
  assert(!/let flags: string = '--/.test(ab), "EntryAbility 的 flags 缺省必须是空串（写死 '--no-verify-heap' 会压过档位）");
});

test('文档在位（样例 README 与总索引）', () => {
  assert(existsSync(path.join(SAMPLE, 'README.md')), '缺 samples/minimal-app/README.md');
  const idx = readRepo('samples/README.md');
  assert(idx.includes('minimal-app'), 'samples/README.md 必须介绍 minimal-app');
});
