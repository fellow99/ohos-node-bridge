#!/usr/bin/env node
/**
 * release.mjs —— 双包发布流水线（方案 B）的**版本一致性检查**与**构建/门禁编排**。
 *
 * 依据：docs/提交到OpenHarmony三方库中心仓.md §5（双包）/ §8（流水线）。
 *
 * 用法：
 *   node tools/release.mjs --check-version     # 只做版本一致性断言（可进 CI，无需凭据）
 *   node tools/release.mjs --build             # 投放运行时 → 出两个 HAR → verify-har → prepublish
 *   node tools/release.mjs --all               # = --check-version + --build
 *   node tools/release.mjs --print-publish     # 打印人工发布命令（不外发任何请求）
 *
 * 环境变量（都有默认值，Windows CLT 布局已覆盖）：
 *   HVIGORW_BIN   默认 D:\oh-workspace\command-line-tools\bin\hvigorw.bat
 *   OHPM_BIN      默认 D:\oh-workspace\command-line-tools\bin\ohpm.bat
 *   DEVECO_SDK_HOME  构建必需（hvigor 用它找 SDK）
 *
 * 纪律：任何一步失败 ⇒ 立刻 exit 2，不继续下一步（避免「打了包但没验」）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const HVIGORW = process.env.HVIGORW_BIN ?? 'D:\\oh-workspace\\command-line-tools\\bin\\hvigorw.bat';
const OHPM = process.env.OHPM_BIN ?? 'D:\\oh-workspace\\command-line-tools\\bin\\ohpm.bat';
const isWin = process.platform === 'win32';

const RUNTIME_MODULE = 'runtimehar';
const BRIDGE_MODULE = 'library';
const RUNTIME_PKG = '@fellow99/node-runtime';

let failures = 0;
function assert(ok, name, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}
function section(t) { console.log(`\n${t}`); }

function readJson5(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  try { return JSON.parse(raw); } catch { /* 剥注释兜底 */ }
  try { return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')); } catch { return null; }
}
function firstChangelogVersion(file) {
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(/^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m);
  return m ? m[1] : null;
}
function run(cmd, args, label) {
  console.log(`\n$ ${label ?? `${cmd} ${args.join(' ')}`}`);
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  } catch (e) {
    console.error(`\n✗ 失败：${label ?? cmd}（exit ${e.status ?? '?'}）`);
    process.exit(2);
  }
}
const hvigor = (mod, task) => run(isWin ? 'cmd' : HVIGORW, isWin
  ? ['/c', HVIGORW, '--mode', 'module', '-p', `module=${mod}@default`, '-p', 'buildMode=release', task, '--no-daemon']
  : ['--mode', 'module', '-p', `module=${mod}@default`, '-p', 'buildMode=release', task, '--no-daemon'],
  `hvigorw ${mod} ${task}`);
const ohpm = (args, label) => run(isWin ? 'cmd' : OHPM, isWin ? ['/c', OHPM, ...args] : args, label);

const runtimePkgPath = join(ROOT, 'runtime-har/oh-package.json5');
const runtimeChangelog = join(ROOT, 'runtime-har/CHANGELOG.md');
const runtimeIndex = join(ROOT, 'runtime-har/Index.ets');
const bridgePkgPath = join(ROOT, 'library/oh-package.json5');
const bridgeChangelog = join(ROOT, 'library/CHANGELOG.md');
const harOf = (mod, name) => join(ROOT, mod, 'build/default/outputs/default', name);
const RUNTIME_HAR = harOf(RUNTIME_MODULE, 'runtimehar.har');
const BRIDGE_HAR = harOf(BRIDGE_MODULE, 'library.har');

function checkVersion() {
  section('① 版本一致性（runtime 包 version = lock.active = CHANGELOG = Index.ets）');
  const lock = readJson5(join(ROOT, 'runtime.lock.json'));
  const pkg = readJson5(runtimePkgPath);
  assert(!!lock, 'runtime.lock.json 可解析');
  assert(!!pkg, 'runtime-har/oh-package.json5 可解析');
  if (!lock || !pkg) return;

  const node = String(lock.active?.node ?? '');
  const act = (lock.runtimes ?? []).find((r) => r.node === node) ?? null;
  assert(!!act, 'lock.active 指向存在的 runtimes 项', node);
  const nodeVer = node.replace(/^v/, '');

  assert(pkg.name === RUNTIME_PKG, `运行时包名 = ${RUNTIME_PKG}`, pkg.name ?? '缺');
  assert(pkg.version === nodeVer, '运行时包 version = lock.active.node', `${pkg.version} vs ${nodeVer}`);
  assert(firstChangelogVersion(runtimeChangelog) === nodeVer, 'runtime CHANGELOG 首条 = 版本', `${firstChangelogVersion(runtimeChangelog)}`);
  const idx = existsSync(runtimeIndex) ? readFileSync(runtimeIndex, 'utf8') : '';
  assert(idx.includes(`'${nodeVer}'`), 'Index.ets NODE_VERSION = 版本', nodeVer);
  if (act) {
    assert(idx.includes(String(act.nodeModuleVersion)), 'Index.ets NODE_MODULE_VERSION = 锁值', String(act.nodeModuleVersion));
    assert(idx.includes(act.sha256), 'Index.ets LIB_SHA256 = 锁值', act.sha256.slice(0, 16) + '…');
    assert(idx.includes(String(act.size)), 'Index.ets LIB_SIZE = 锁值', String(act.size));
  }

  // 本地产物（若已投放）与锁值一致
  const localSo = join(ROOT, 'runtime-har/libs', String(lock.active?.abi ?? 'arm64-v8a'), 'libnode.so');
  if (existsSync(localSo) && act) {
    const buf = readFileSync(localSo);
    const sha = createHash('sha256').update(buf).digest('hex');
    assert(buf.length === act.size, '已投放 libnode.so 大小 = 锁值', `${buf.length.toLocaleString()} B`);
    assert(sha === act.sha256, '已投放 libnode.so SHA-256 = 锁值', sha.slice(0, 16) + '…');
  } else {
    console.log(`  SKIP 已投放 libnode.so 校验（未投放：${localSo}）`);
  }

  section('② 主包版本（自身 semver，不跟 Node 版本）');
  const bpkg = readJson5(bridgePkgPath);
  assert(!!bpkg, 'library/oh-package.json5 可解析');
  if (bpkg) {
    assert(bpkg.version !== nodeVer, '主包版本未误用 Node 版本号', `${bpkg.version}（建议保持自身 semver）`);
    const bc = firstChangelogVersion(bridgeChangelog);
    if (bc) assert(bc === bpkg.version, 'bridge CHANGELOG 首条 = 版本', bc);
    else console.log('  SKIP bridge CHANGELOG 缺失（P0-1 待补）');
  }

  section('③ 随包事实源（rawfile 副本与仓库根一致）');
  const rawDir = join(ROOT, 'library/src/main/resources/rawfile/node_bridge');
  for (const f of ['runtime.lock.json', 'THIRD-PARTY-NOTICES.md']) {
    const a = join(ROOT, f);
    const b = join(rawDir, f);
    if (!existsSync(b)) { assert(false, `rawfile 副本缺失：${f}`, b); continue; }
    const same = readFileSync(a).equals(readFileSync(b));
    assert(same, `${f} 随包副本与仓库根逐字一致`, same ? 'ok' : '已漂移（重跑 release，或手工 cp 覆盖）');
    if (!same) console.log(`      修复：cp "${a}" "${b}"`);
  }

  if (failures) {
    console.log(`\n✗ ${failures} 项不一致 —— 修完再构建/发布`);
    process.exit(2);
  }
  console.log('\n✓ 版本一致性全过');
}

function build() {
  if (failures) { console.log('\n✗ 版本一致性未过，拒绝构建'); process.exit(2); }
  section('③ 投放运行时（七项门禁 + SHA-256）');
  run(process.execPath, ['tools/provision.mjs', '--out', 'runtime-har/libs/arm64-v8a']);

  section('④ 出两个 release HAR');
  hvigor(RUNTIME_MODULE, 'assembleHar');
  hvigor(BRIDGE_MODULE, 'assembleHar');

  section('⑤ 本地发布门禁（两个包都过）');
  run(process.execPath, ['tools/verify-har.mjs', RUNTIME_HAR]);
  run(process.execPath, ['tools/verify-har.mjs', BRIDGE_HAR]);

  section('⑥ ohpm prepublish（第二道；注意它不覆盖四件套）');
  ohpm(['prepublish', RUNTIME_HAR], 'ohpm prepublish <runtime har>');
  ohpm(['prepublish', BRIDGE_HAR], 'ohpm prepublish <bridge har>');

  console.log('\n✓ 两个包都已通过本地门禁 + prepublish');
  printPublish();
}

function printPublish() {
  section('⑦ 人工发布（顺序不能反：先运行时包，后主包）');
  const q = (p) => (isWin ? p.replace(/\\/g, '\\\\') : p);
  console.log(`
# 凭据（一次性；发布码/私钥在中心仓个人中心取）
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
ohpm config set publish_id <你的发布码>
ohpm config set key_path <私钥路径>

# ① 运行时包（必须先上架，主包的依赖才解得开）
ohpm publish "${q(RUNTIME_HAR)}" -t latest
# ② 主包
ohpm publish "${q(BRIDGE_HAR)}" -t latest

# 之后在中心仓【个人中心】-【消息】/【Package】跟踪两个审核单。
`);
}

// ── 入口 ────────────────────────────────────────────────────────────────
if (!argv.length || has('--all')) { checkVersion(); build(); }
else {
  if (has('--check-version')) checkVersion();
  if (has('--build')) build();
  if (has('--print-publish')) printPublish();
}
