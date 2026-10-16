#!/usr/bin/env node
/**
 * provision.mjs — 把锁定在 runtime.lock.json 里的 Node 运行时**投放**进 HAP 模块。
 *
 * 设计原则（与工程规划附录 G 一致）：
 *   1. **版本固化在 git 里**（runtime.lock.json：node 版本 / SHA-256 / 门禁结果），二进制不入库；
 *   2. **投放幂等**：目标目录已是同一个 SHA-256 就跳过（`--force` 可强制）；
 *   3. **每步都验**：SHA-256 与大小、七项 ELF 门禁，任一不过即**硬失败**（绝不静默降级）；
 *   4. **来源可切换**：本地目录 →（可选）镜像 →（可选）上游 URL；离线可用。
 *
 * 用法：
 *   node tools/provision.mjs --out <模块>/entry/libs/arm64-v8a     # 常规投放（本地目录优先）
 *   node tools/provision.mjs --check                               # 只校验，不投放
 *   node tools/provision.mjs --list                                # 打印锁定清单
 *   node tools/provision.mjs --from <path|url> --out <dir>         # 指定来源（覆盖本地目录）
 *   node tools/provision.mjs --download --out <dir>                # 允许联网（镜像 → 上游）
 *   # 国内网络：Node 内置 fetch 默认不读代理环境变量，联网下载时须显式开启
 *   HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 node tools/provision.mjs --download --out <dir>
 *   node tools/provision.mjs --sign --out <dir>                    # 顺便补 .codesign 并自签
 *
 * 常用参数：--node v24.2.0  --abi arm64-v8a  --sdk <ohos-sdk 路径>  --force  --quiet
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOCK_PATH = join(REPO, 'runtime.lock.json');

// 一次性中间产物（下载 / 自签）登记，退出时清理 —— 单份可能上百 MiB
const tmpFiles = [];
process.on('exit', () => {
  for (const p of tmpFiles) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ } }
});

// ---------------------------------------------------------------- CLI ----
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const QUIET = flag('quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(2); };

/** 联网失败时的代理提示：Node 内置 fetch 默认**不读**代理环境变量（NODE_USE_ENV_PROXY=1 才读） */
function proxyHint() {
  const px = process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY;
  if (!px) return '';
  return process.env.NODE_USE_ENV_PROXY
    ? `\n（NODE_USE_ENV_PROXY 已开启，走代理 ${px}）`
    : `\n提示：检测到代理 ${px}，但 Node 内置 fetch 默认**不读**代理环境变量。\n` +
      `     请加 NODE_USE_ENV_PROXY=1 重试（Node ≥ 24）：\n` +
      `       HTTPS_PROXY=${px} NODE_USE_ENV_PROXY=1 node tools/provision.mjs --download --out <dir>`;
}

// ------------------------------------------------------------- 读 lock ----
if (!existsSync(LOCK_PATH)) fail(`找不到 ${LOCK_PATH}`);
let lock;
try { lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); }
catch (e) { fail(`runtime.lock.json 不是合法 JSON：${e.message}`); }

const wantNode = opt('node', lock.active?.node);
const wantAbi = opt('abi', lock.active?.abi ?? 'arm64-v8a');
const entry = (lock.runtimes ?? []).find((r) => r.node === wantNode && r.abi === wantAbi);
if (!entry) {
  fail(`lock 里没有 node=${wantNode} abi=${wantAbi}；可用：` +
    (lock.runtimes ?? []).map((r) => `${r.node}/${r.abi}`).join(', '));
}

if (flag('list')) {
  for (const r of lock.runtimes) {
    const act = r.node === lock.active?.node && r.abi === lock.active?.abi ? ' ← active' : '';
    console.log(`${r.node}  ${r.abi}  ${r.size} B  ${r.sha256.slice(0, 16)}…  ${r.source?.repo}${act}`);
  }
  process.exit(0);
}

// --------------------------------------------------- 定位本地运行时目录 ----
const ENV_DIR = process.env[lock.localStore?.envOverride ?? 'OHOS_NODE_RUNTIME_DIR'];
const localStoreAbs = ENV_DIR
  ? resolve(ENV_DIR)
  : resolve(REPO, lock.localStore?.path ?? '../ohos-node-runtime');
const localCandidates = [
  join(localStoreAbs, `node-${entry.node}`, entry.file),   // 目录布局：node-v24.2.0/libnode-arm64.so
  join(localStoreAbs, entry.node, entry.file),
  join(localStoreAbs, entry.file),
];

// ------------------------------------------------------------ ELF 门禁 ----
/** 纯 JS ELF 检查（与 tools/elf-inspect.py 同口径；不依赖 python/llvm）。 */
function elfGate(buf, e) {
  const r = {};
  if (buf.length < 64 || buf.readUInt32LE(0) !== 0x464c457f) { r.error = 'not an ELF'; return r; }
  if (buf[4] !== 2 || buf[5] !== 1) { r.error = 'not 64-bit little-endian'; return r; }
  const u16 = (o) => buf.readUInt16LE(o), u32 = (o) => buf.readUInt32LE(o), u64 = (o) => Number(buf.readBigUInt64LE(o));
  r.type = u16(16);            // 3 = ET_DYN
  r.machine = u16(18);         // 0xB7 = AArch64
  const phoff = u64(32), phentsize = u16(54), phnum = u16(56);
  let interp = 0, dyn = null;
  for (let i = 0; i < phnum; i++) {
    const b = phoff + i * phentsize;
    const t = u32(b);
    if (t === 3) interp++;                              // PT_INTERP
    if (t === 2) dyn = { off: u64(b + 8), size: u64(b + 32) };
  }
  r.ptInterp = interp;

  // DT_NEEDED / DT_STRTAB
  r.needed = [];
  if (dyn) {
    const seg = buf.subarray(dyn.off, dyn.off + dyn.size);
    let strtabVa = null; const ents = [];
    for (let k = 0; k + 16 <= seg.length; k += 16) {
      const tag = Number(seg.readBigUInt64LE(k)), val = Number(seg.readBigUInt64LE(k + 8));
      ents.push([tag, val]);
      if (tag === 5) strtabVa = val;
      if (tag === 0) break;
    }
    if (strtabVa !== null) {
      let strtabOff = null;
      for (let i = 0; i < phnum; i++) {
        const b = phoff + i * phentsize;
        if (u32(b) !== 1) continue;                     // PT_LOAD
        const pOff = u64(b + 8), pVa = u64(b + 16), pFsz = u64(b + 32);
        if (pVa <= strtabVa && strtabVa < pVa + pFsz) { strtabOff = pOff + (strtabVa - pVa); break; }
      }
      if (strtabOff !== null) {
        for (const [tag, val] of ents) {
          if (tag !== 1) continue;
          const s = strtabOff + val;
          const end = buf.indexOf(0, s);
          r.needed.push(buf.toString('utf8', s, end));
        }
      }
    }
  }
  r.needsLibcxx = r.needed.includes('libc++_shared.so');
  r.needsLibc = r.needed.includes('libc.so');

  // .dynsym 里是否有已定义的 node::Start
  const shoff = u64(40), shentsize = u16(58), shnum = u16(60), shstrndx = u16(62);
  const shstrOff = u64(shoff + shstrndx * shentsize + 24);
  const secName = (i) => {
    const o = u32(shoff + i * shentsize);
    return buf.toString('utf8', shstrOff + o, buf.indexOf(0, shstrOff + o));
  };
  r.sections = [];
  r.hasCodesign = false; r.hasOhosIdent = false;
  for (let i = 0; i < shnum; i++) {
    const n = secName(i);
    r.sections.push(n);
    if (n === '.codesign') r.hasCodesign = true;
    if (n === '.note.ohos.ident') r.hasOhosIdent = true;
  }
  const WANT = '_ZN4node5StartEiPPc';
  r.exportsNodeStart = false;
  for (let i = 0; i < shnum; i++) {
    if (secName(i) !== '.dynsym') continue;
    const base = shoff + i * shentsize;
    const symOff = u64(base + 24), symSize = u64(base + 32);
    const link = u32(base + 40), entsize = u64(base + 56) || 24;
    const strSec = shoff + link * shentsize;
    const symStrOff = u64(strSec + 24);
    for (let o = symOff; o + 24 <= symOff + symSize; o += entsize) {
      const nameOff = u32(o), shndx = u16(o + 6);
      if (shndx === 0) continue;
      const nm = buf.toString('utf8', symStrOff + nameOff, buf.indexOf(0, symStrOff + nameOff));
      if (nm === WANT) { r.exportsNodeStart = true; break; }
    }
    break;
  }
  r.hasNodeStartString = buf.includes(Buffer.from(WANT));
  r.hasVersionString = buf.includes(Buffer.from(e.node));
  r.hasExposeInternals = buf.includes(Buffer.from('expose-internals'));
  return r;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function reportGates(gate, shaOk, sizeOk, e) {
  const rows = [
    ['① e_type == ET_DYN(3)', gate.type === 3, gate.type],
    ['② PT_INTERP 计数 == 0', gate.ptInterp === 0, gate.ptInterp],
    ['③ e_machine == AArch64(0xB7)', gate.machine === 0xb7, gate.machine?.toString(16)],
    ['④ DT_NEEDED 含 libc++_shared.so', gate.needsLibcxx === true, (gate.needed ?? []).join(',')],
    [`⑤ ${'_ZN4node5StartEiPPc'} 已导出`, gate.exportsNodeStart === true, gate.exportsNodeStart],
    ['⑥ SHA-256 与 lock 一致', shaOk === true, ''],
    ['⑦ 大小与 lock 一致 / 版本串存在', sizeOk === true && gate.hasVersionString === true, `${e.node}`],
  ];
  log('  门禁：');
  for (const [name, ok, got] of rows) {
    log(`    ${ok ? 'OK  ' : 'FAIL'} ${name}${got === '' ? '' : `  (实测 ${got})`}`);
  }
  const extra = `  附加：.codesign=${gate.hasCodesign} .note.ohos.ident=${gate.hasOhosIdent} ` +
    `expose-internals=${gate.hasExposeInternals}`;
  log(extra);
  return rows.every(([, ok]) => ok);
}

// ------------------------------------------------------- 解析 SDK 的 libcxx ----
function findLibcxx() {
  const rel = lock.libcxx?.sdkRelPath ?? 'native/llvm/lib/aarch64-linux-ohos/libc++_shared.so';
  const roots = [
    opt('sdk'),
    process.env.OHOS_SDK_NATIVE ? join(process.env.OHOS_SDK_NATIVE, '..', '..', '..') : null,
    process.env.DEVECO_SDK_HOME ? join(process.env.DEVECO_SDK_HOME, 'default', 'openharmony') : null,
    'D:/oh-workspace/command-line-tools/sdk/default/openharmony',
    'D:/oh-workspace/DevEco Studio/sdk/default/openharmony',
  ].filter(Boolean);
  for (const r of roots) {
    const p = join(r, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- 取产物 ----
async function acquire(src) {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const out = join(tmpdir(), `libnode-dl-${Date.now()}.so`);
    log(`  下载：${src}`);
    const res = await fetch(src, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    tmpFiles.push(out);
    return { path: out, temp: true };
  }
  return { path: resolve(src), temp: false };
}

async function main() {
  log(`runtime.lock.json  active = ${entry.node} / ${entry.abi}`);
  log(`  期望 SHA-256 = ${entry.sha256}`);
  log(`  本地运行时目录 = ${localStoreAbs}${ENV_DIR ? '  (来自环境变量)' : ''}`);

  // 1) 找源：本地目录 → 显式 --from → （--download 时）镜像 → 上游
  // A3：`--from` 接受 URL（头部用法声明 `<path|url>`）—— URL 必须走与 --download
  // 同一条 acquire()/fetch 路径；否则会被当本地路径 statSync ⇒ `ENOENT … stat '…https:…'` 栈。
  let srcPath = opt('from');
  if (srcPath && /^https?:\/\//.test(srcPath)) {
    const url = srcPath;
    try {
      srcPath = (await acquire(url)).path;
    } catch (e) {
      fail(`--from 的 URL 下载失败：${url} → ${e.message}${proxyHint()}`);
    }
  }
  if (!srcPath) {
    srcPath = localCandidates.find((p) => existsSync(p));
  }
  if (!srcPath && flag('download')) {
    const urls = [entry.mirror?.url, entry.source?.url].filter(Boolean);
    if (!urls.length) fail('lock 里没有可下载 URL');
    const errs = [];
    for (const u of urls) {
      try { srcPath = (await acquire(u)).path; break; }
      catch (e) { errs.push(`${u} → ${e.message}`); log(`  ! ${e.message}，尝试下一个来源`); }
    }
    if (!srcPath) {
      fail(`全部下载来源均失败：\n  - ${errs.join('\n  - ')}${proxyHint()}`);
    }
  }
  if (!srcPath) {
    fail(
      `本地找不到运行时产物。请任选其一：\n` +
      `  a) 手工放入本地运行时目录（推荐，离线可用）：\n` +
      `       ${localCandidates[0]}\n` +
      `  b) 指定来源：  node tools/provision.mjs --from <path|url> --out <dir>\n` +
      `  c) 允许联网：  node tools/provision.mjs --download --out <dir>\n` +
      `     （上游：${entry.source?.url}）`);
  }

  // 2) 校验
  // A4：读/解析失败必须是**一行 ✗ + 退出码 2**，不能把栈糊给用户：
  // 目录 ⇒ EISDIR；截断/畸形 ELF ⇒ 自解析器 readBigUInt64LE 抛 RangeError[ERR_OUT_OF_RANGE]。
  // fail() 内部 process.exit(2)，故 catch 后不会继续（gate 一定已赋值）。
  let st, sha, gate;
  try {
    st = statSync(srcPath);
    if (!st.isFile()) throw new Error('不是普通文件（目录？）');
    sha = sha256File(srcPath);
    gate = elfGate(readFileSync(srcPath), entry);
  } catch (e) {
    fail(`无法读取/解析 ELF：${srcPath} —— ${e.message}`);
  }
  if (gate.error) fail(`不是可用的 ELF：${gate.error}`);
  const shaOk = sha === entry.sha256;
  const sizeOk = st.size === entry.size;
  log(`  来源 = ${srcPath}`);
  log(`  实测 SHA-256 = ${sha}`);
  const gatesOk = reportGates(gate, shaOk, sizeOk, entry);
  if (!shaOk) {
    fail(`产物与 lock 不符（SHA-256 不一致）。要么换成正确的产物，要么**明确**更新 runtime.lock.json。`);
  }
  if (!gatesOk) fail('ELF 门禁未全过 —— 该产物不能用于进程内嵌入（详见工程规划 §5.8）。');
  if (flag('check')) { log('\n✓ --check：门禁全过（未投放）'); return; }

  // 3) 投放
  const outDir = opt('out');
  if (!outDir) fail('缺少 --out <模块>/entry/libs/<abi>（或用 --check 只校验）');
  const outAbs = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
  mkdirSync(outAbs, { recursive: true });

  const deployName = entry.deployAs ?? 'libnode.so';
  const outSo = join(outAbs, deployName);
  // A6：目标存在但 SHA 与 lock 不符 ⇒ 这是**覆盖**。契约要求目标必须等于 lock 值（不是拒绝），
  // 但必须把「换掉了什么」说出来，否则本地改动/签名的痕迹会被静默抹掉（C2 可追溯）。
  const prevSha = existsSync(outSo) ? sha256File(outSo) : null;
  if (prevSha === sha && !flag('force')) {
    log(`\n= 已是最新（${deployName} 的 SHA-256 命中）→ 跳过拷贝`);
  } else {
    if (prevSha !== null && prevSha !== sha) {
      log(`  ⟳ 覆盖 ${deployName}：旧 SHA-256 ${prevSha.slice(0, 16)}… → 新 ${sha.slice(0, 16)}…`);
    }
    copyFileSync(srcPath, outSo);
    log(`\n+ 投放 ${deployName} → ${outSo}  (${(st.size / 1048576).toFixed(1)} MiB)`);
  }

  // libc++_shared.so
  const libcxxSrc = findLibcxx();
  if (!libcxxSrc) {
    fail('找不到 libc++_shared.so。用 --sdk <ohos-sdk> 或设 DEVECO_SDK_HOME / OHOS_SDK_NATIVE。\n' +
      '  （缺它 dlopen 会**静默失败**，症状是 ArkTS 侧只拿到 undefined）');
  }
  const outCxx = join(outAbs, lock.libcxx.file);
  const cxxSha = sha256File(libcxxSrc);
  // A6：同 libnode.so —— 覆盖既有 libc++_shared.so 时也要说明旧/新 SHA-256（可追溯）
  const prevCxxSha = existsSync(outCxx) ? sha256File(outCxx) : null;
  if (prevCxxSha === cxxSha && !flag('force')) {
    log('= libc++_shared.so 已是最新（SHA-256 命中）→ 跳过拷贝');
  } else {
    if (prevCxxSha !== null && prevCxxSha !== cxxSha) {
      log(`  ⟳ 覆盖 libc++_shared.so：旧 SHA-256 ${prevCxxSha.slice(0, 16)}… → 新 ${cxxSha.slice(0, 16)}…`);
    }
    copyFileSync(libcxxSrc, outCxx);
    log(`+ 投放 libc++_shared.so（自 SDK）→ ${outCxx}  (${(statSync(libcxxSrc).size / 1048576).toFixed(1)} MiB)`);
  }

  // 可选自签
  if (flag('sign')) {
    const selfsign = join(HERE, 'ohos-selfsign.mjs');
    // 中间产物必须放系统临时目录：libs/<abi>/ 里任何多余文件都会被**打进 HAP**。
    const work = join(tmpdir(), `libnode-sign-${process.pid}`);
    mkdirSync(work, { recursive: true });
    tmpFiles.push(work);
    let cur = outSo;
    if (!gate.hasCodesign) {
      log('  [sign] 无 .codesign 段 → 先 add-section');
      const step1 = join(work, 'step1.so');
      const r1 = spawnSync(process.execPath, [selfsign, 'add-section', cur, step1], { stdio: 'inherit' });
      if (r1.status !== 0) fail('add-section 失败');
      cur = step1;
    }
    const step2 = join(work, 'step2.so');
    const r2 = spawnSync(process.execPath, [selfsign, 'sign', cur, step2], { stdio: 'inherit' });
    if (r2.status !== 0) fail('自签失败');
    copyFileSync(step2, outSo);
    const r3 = spawnSync(process.execPath, [selfsign, 'verify', outSo], { stdio: 'inherit' });
    if (r3.status !== 0) fail('自签后验签失败');
  }

  log(`\n✓ 投放完成：${outAbs}`);
  log(`  下一步：hvigorw assembleHap --mode module -p product=default -p buildMode=debug`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
