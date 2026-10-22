#!/usr/bin/env node
/**
 * verify-har.mjs —— ohpm 发布前的**本地硬门禁**（复刻中心仓服务端规则）。
 *
 * 为什么必须有它：`ohpm prepublish` 只做本地能判的那一小部分——缺 CHANGELOG / LICENSE、
 * README 里没有 `ohpm install` 这些**都会被服务端打回**，而 `prepublish` 仍然打印 succeed。
 * 依据：docs/提交到OpenHarmony三方库中心仓.md §2.8 / §8。
 *
 * 用法：
 *   node tools/verify-har.mjs <har>                 # 人读报告；退出码 0=全过 / 2=有失败
 *   node tools/verify-har.mjs <har> --json <path>   # 额外落机器可读报告
 *
 * 设计约束（与本仓库其它 tools 一致）：
 *   · 零第三方依赖（Node 内置 zlib 即可解 gzip）；HAR 是 **gzip tar**，不是 zip；
 *   · 失败一律 **硬失败 + exit 2**，绝不降级为告警（C2「不隐藏平台真相」）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, basename, dirname, join } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argv = process.argv.slice(2);
const harPath = argv.find((a) => !a.startsWith('--'));
const jsonIdx = argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

const LIMITS = {
  harBytes: 500 * 1024 * 1024,
  unpackedBytes: 1500 * 1024 * 1024,
  entries: 102400,
  readmeBytes: 10 * 1024 * 1024,
};
const rows = []; // { ok, level: 'FAIL'|'WARN', name, detail }
function check(ok, name, detail = '') {
  rows.push({ ok: !!ok, level: 'FAIL', name, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  return !!ok;
}
/** 只警告、不阻断：中心仓对这些项只打印 WARN（已用本地 ohpm 复核） */
function warn(ok, name, detail = '') {
  rows.push({ ok: true, level: 'WARN', name, detail, soft: !ok });
  console.log(`  ${ok ? 'OK  ' : 'WARN'} ${name}${detail ? `  (${detail})` : ''}`);
  return !!ok;
}

// ── 最小 tar 读取（ustar；hvigor 产物是 ustar，路径直接用 prefix+name） ─────
function cstr(buf) {
  const z = buf.indexOf(0);
  return buf.toString('utf8', 0, z === -1 ? buf.length : z);
}
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break; // 结束块
    const name = cstr(h.subarray(0, 100));
    const prefix = cstr(h.subarray(345, 500));
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48); // '0'=文件 '5'=目录
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    const start = off + 512;
    out.push({ name: full.replace(/\/+$/, ''), size, dir: type === '5', data: buf.subarray(start, start + size) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

function loadLock() {
  const p = join(ROOT, 'runtime.lock.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
function activeRuntime(lock) {
  if (!lock) return null;
  const node = lock.active?.node;
  return (lock.runtimes ?? []).find((r) => r.node === node) ?? null;
}
function parseJson5Loose(text) {
  // hvigor 产出的是**单行标准 JSON**；对源文件里的注释做一次兜底剥离（只用于报错友好）。
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(stripped); } catch { return null; }
}
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function main() {
  if (!harPath) {
    console.error('用法：node tools/verify-har.mjs <har> [--json <path>]');
    process.exit(2);
  }
  const abs = resolve(process.cwd(), harPath);
  if (!existsSync(abs)) {
    console.error(`✗ 找不到 HAR：${abs}`);
    process.exit(2);
  }
  console.log(`\nverify-har：${basename(abs)}`);
  const raw = readFileSync(abs);
  console.log(`  文件大小 = ${raw.length.toLocaleString()} B`);

  // 1) 解包（HAR = gzip tar）
  let entries;
  try {
    entries = readTar(gunzipSync(raw));
  } catch (e) {
    console.error(`✗ 不是可解析的 HAR（gzip tar）：${e.message}`);
    process.exit(2);
  }
  const files = new Map(entries.filter((e) => !e.dir).map((e) => [e.name, e]));
  const unpacked = entries.reduce((s, e) => s + e.size, 0);
  const has = (p) => files.has(p);
  const text = (p) => (has(p) ? files.get(p).data.toString('utf8') : '');

  console.log('  包结构与体积');
  check(entries.length > 0 && [...files.keys()].every((n) => n.startsWith('package/')), '顶层为 package/', `${entries.length} 条目 / 解压 ${unpacked.toLocaleString()} B`);
  check(raw.length <= LIMITS.harBytes, '压缩包 ≤ 500 MB', `${(raw.length / 1048576).toFixed(1)} MB`);
  check(unpacked <= LIMITS.unpackedBytes, '解压后 ≤ 1500 MB', `${(unpacked / 1048576).toFixed(1)} MB`);
  check(entries.length <= LIMITS.entries, '条目数 ≤ 102,400', String(entries.length));

  // 2) 清单
  const pkgRaw = text('package/oh-package.json5');
  const pkg = pkgRaw ? parseJson5Loose(pkgRaw) : null;
  console.log('\n  oh-package.json5');
  check(!!pkg, '存在且可解析', pkg ? 'ok' : '解析失败');
  const name = pkg?.name ?? '';
  const version = pkg?.version ?? '';
  check(typeof name === 'string' && /^(@[a-z0-9][a-z0-9._-]{0,35}\/)?[a-z0-9][a-z0-9._-]*$/.test(name), 'name 合法（小写 / 无禁用后缀）', name);
  check(VERSION_RE.test(version) && !version.startsWith('v'), 'version 为 SemVer 且无 v 前缀', version);
  const desc = String(pkg?.description ?? '');
  check(desc.length >= 6 && desc.length <= 512, 'description 6–512 字符', `${desc.length} 字符`);
  // author：对象 + name + (email|url)
  const au = pkg?.author;
  check(au && typeof au === 'object' && !Array.isArray(au), 'author 为对象（不是字符串）', typeof au);
  check(!!au?.name, 'author.name 非空', au?.name ?? '');
  check(!!(au?.email || au?.url), 'author.email 或 author.url 至少一个', au?.email ?? au?.url ?? '缺');
  check(typeof pkg?.license === 'string' && pkg.license.length > 0, 'license 非空', pkg?.license ?? '');
  const sourceType = pkg?.sourceType ?? 'open';
  check(['open', 'closed'].includes(sourceType), 'sourceType 合法', sourceType);
  if (sourceType === 'open') {
    const repo = String(pkg?.repository ?? '');
    check(/^(https?|ftp|rtsp|mms):\/\//.test(repo) && repo.length <= 1024, 'repository 为 URL（开源包必填）', repo || '缺');
    const lic = String(pkg?.license ?? '');
    check(!!lic, 'license 已声明（开源包必填，1–256 字符）', lic);
  }
  // main / types 指向包内真实文件
  const mainF = pkg?.main ? `package/${pkg.main}` : null;
  const typesF = pkg?.types ? `package/${pkg.types}` : null;
  check(!!(mainF || typesF), 'main 或 types 已声明', pkg?.main ?? pkg?.types ?? '缺');
  if (mainF) check(has(mainF), 'main 指向包内真实文件', mainF);
  if (typesF) check(has(typesF), 'types 指向包内真实文件', typesF);

  // 3) 四件套
  console.log('\n  四件套（中心仓硬要求）');
  check(has('package/oh-package.json5') && pkgRaw.length > 0, 'oh-package.json5 存在且非空');
  const readme = text('package/README.md');
  check(readme.length > 0, 'README.md 存在且非空', `${files.get('package/README.md')?.size ?? 0} B`);
  check(files.get('package/README.md')?.size <= LIMITS.readmeBytes, 'README ≤ 10 MB');
  const instRe = /ohpm\s+(i|install)\s+(@[a-z0-9][\w.-]*\/)?[\w.-]+/i;
  check(instRe.test(readme), 'README 含 ohpm install/i 命令', (readme.match(instRe) ?? [''])[0]);
  const changelog = text('package/CHANGELOG.md');
  check(changelog.length > 0, 'CHANGELOG.md 存在且非空', `${changelog.length} B`);
  if (changelog.length > 0) check(changelog.includes(version), 'CHANGELOG 含当前版本号', version);
  check(has('package/LICENSE') && text('package/LICENSE').trim().length > 0, 'LICENSE 存在且非空（开源包必填）');
  for (const alt of ['package/license', 'package/license.md', 'package/license.txt']) {
    if (has(alt)) check(false, 'LICENSE 大小写/扩展名不规范', alt);
  }
  if (readme.length > 0) check(readme.toLowerCase().includes('ohpm install') || readme.toLowerCase().includes('ohpm i '), 'README 安装命令使用原文（`ohpm i` 或 `ohpm install`）');

  // 4) 构建产物口径
  console.log('\n  产物口径');
  const meta = pkg?.metadata ?? {};
  check(meta.debug === false, 'metadata.debug === false（必须用 release 构建）', String(meta.debug));
  const badExt = [...files.keys()].filter((n) => /\.exe$/i.test(n));
  check(badExt.length === 0, '无 .exe', badExt.join(',') || '0 个');
  const secrets = [...files.keys()].filter((n) => /(^|\/)(signing\.[^/]*\.json|\*\.p12|\*\.p7b|\*\.cer)$/i.test(n) || /\.(p12|p7b|cer)$/i.test(n));
  check(secrets.length === 0, '无签名材料（*.p12 / *.p7b / *.cer / signing.*）', secrets.join(',') || '0 个');

  // 5) 原生库：必须都在 package/libs/ 下，且被 nativeComponents 覆盖
  const sos = [...files.keys()].filter((n) => n.endsWith('.so'));
  const straySo = sos.filter((n) => !n.startsWith('package/libs/'));
  check(straySo.length === 0, '.so 全部位于 package/libs/', straySo.join(',') || `${sos.length} 个`);
  const declared = new Set((pkg?.nativeComponents ?? []).map((c) => c.name));
  const undeclared = sos.map((n) => n.split('/').pop()).filter((n) => !declared.has(n));
  warn(undeclared.length === 0, 'libs/*.so 均被 nativeComponents 声明（中心仓仅 WARN）', undeclared.join(',') || [...declared].join(',') || '无 .so');

  // 6) 包专属断言
  const lock = loadLock();
  const act = activeRuntime(lock);
  const isRuntimePkg = name === '@fellow99/node-runtime';
  console.log(`\n  包专属断言（${isRuntimePkg ? '运行时包' : '主包'}）`);
  if (isRuntimePkg) {
    const abi = lock?.active?.abi ?? 'arm64-v8a';
    const soName = `package/libs/${abi}/libnode.so`;
    check(has(soName), `<abi>/libnode.so 随包`, soName);
    if (act) {
      check(version === act.node.replace(/^v/, ''), '包版本 === lock.active.node', `${version} vs ${act.node}`);
      const so = files.get(soName);
      if (so) {
        const sha = createHash('sha256').update(so.data).digest('hex');
        check(so.size === act.size, 'libnode.so 大小 = 锁值', `${so.size.toLocaleString()} B`);
        check(sha === act.sha256, 'libnode.so SHA-256 = 锁值', `${sha.slice(0, 16)}…`);
      }
      // 说明：byteCodeHar 的 Index.d.ets 只有 `export declare const`，**不含字面量** ——
      // 版本常量的真实值在 modules.abc 里，因此这里不做字面量断言；
      // 源侧一致性（Index.ets ↔ lock ↔ CHANGELOG）由 tools/release.mjs --check-version 负责。
    }
  } else {
    check(!sos.some((n) => n.endsWith('/libnode.so')), '主包**不得**含 libnode.so（运行时由 runtime 包提供）', sos.map((s) => s.split('/').pop()).join(',') || '无 .so');
  }

  // 7) 汇总
  const failed = rows.filter((r) => !r.ok);
  const report = {
    har: abs, bytes: raw.length, entries: entries.length, unpackedBytes: unpacked,
    name, version, packageKind: isRuntimePkg ? 'runtime' : 'bridge',
    ok: failed.length === 0, failures: failed.map((r) => ({ check: r.name, detail: r.detail })),
  };
  if (jsonOut) {
    writeFileSync(resolve(process.cwd(), jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n  报告 → ${jsonOut}`);
  }
  if (failed.length) {
    console.log(`\n✗ ${failed.length} 项未通过（共 ${rows.length} 项）—— 修完再 publish：`);
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? `  (${f.detail})` : ''}`);
    process.exit(2);
  }
  console.log(`\n✓ ${rows.length} 项全过：${name}@${version}`);
}

main();
