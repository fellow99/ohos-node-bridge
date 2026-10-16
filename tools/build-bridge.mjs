#!/usr/bin/env node
/*
 * build-bridge.mjs —— 交叉编译 NAPI 引导件（规划 §7.4 ② 的那一条命令）。
 *
 * ⚠️ **先说实话（⬜ vs ✅ 口径，宪法 C2 不隐藏平台真相）**：
 *   规划 §7.4 / 附录 A 把它写作「交叉编译 NAPI 引导件」的一条独立命令（原文标 **⬜ Phase 1**），
 *   但本机**没有**独立的 clang 交叉编译脚本 —— 真正在跑、且产物真的落进 HAR 的路径是
 *   **hvigor 的 `externalNativeOptions`**：
 *     · abiFilters 固化在 `library/build-profile.json5`（`["arm64-v8a"]`）；
 *     · CMake 入口 `library/src/main/cpp/CMakeLists.txt`（产物落 `<module>/libs/${OHOS_ARCH}`，§5.9 / S6）；
 *     · 由 `hvigorw assembleHar` 触发 CMake+ninja 交叉编译。
 *   ⇒ 本脚本**不重新实现**交叉编译，而是把这条已验证路径包成一条幂等命令（本机实测：`library.har` 441,353 B，
 *      含 `libs/arm64-v8a/libnode_bridge.so` + `libc++_shared.so`，**不含 `libnode.so`**，见 §7.5 / 附录 G.8）。
 *   ⇒ `--abi` 因此**只用于打印提示**（真正的 ABI 由 abiFilters 决定，改它要改 build-profile.json5）。
 *
 * 本机可用路径（2026-10-16 实测口径，文档与脚本必须一致）：
 *   export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
 *   #   PATH 里需要有 DevEco 的 node（hvigor 用它跑构建脚本）
 *   cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default assembleHar --no-daemon"
 *
 * 用法：
 *   node tools/build-bridge.mjs [--abi arm64-v8a] [--quiet]
 *     --abi <abi>   仅打印提示（默认 arm64-v8a；真正的 ABI 由 library/build-profile.json5 的 abiFilters 决定）
 *     --quiet       只打印最终产物行与错误（构建输出仍然照常透传，只是少掉本脚本的旁白）
 *
 * 退出码：0 = 构建成功且产物存在；2 = 缺 hvigorw / 缺 DEVECO_SDK_HOME / 构建失败 / 产物缺失。
 */

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);

/** 本机（也可以说是这一版工具链）的默认落点；都可以用环境变量覆盖。 */
const DEFAULTS = {
  hvigorw: 'D:\\oh-workspace\\command-line-tools\\bin\\hvigorw.bat',
  sdkHome: 'D:\\oh-workspace\\command-line-tools\\sdk',
  devecoNode: 'D:\\oh-workspace\\DevEco Studio\\tools\\node',
  cltNode: 'D:\\oh-workspace\\command-line-tools\\tool\\node',
};

/** 产物（附录 C：HAR ≈441 KB，且**不含 libnode.so**）。 */
const HAR_REL = path.join('library', 'build', 'default', 'outputs', 'default', 'library.har');
const EXPECTED_HAR_BYTES = 441 * 1024; // 441 KB 口径；仅用于「漂移 > 2× 就提醒」，不作为失败判据

const HVIGOR_ARGS = ['--mode', 'module', '-p', 'module=library@default', 'assembleHar', '--no-daemon'];

function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const quiet = flag('quiet');
const abi = opt('abi', 'arm64-v8a');

function say(msg) {
  if (!quiet) console.log(msg);
}
function fail(msg, extra = []) {
  console.error(`\n✗ build-bridge: ${msg}`);
  for (const line of extra) console.error(`  ${line}`);
  process.exit(2);
}

if (flag('help') || argv.includes('-h')) {
  console.log('用法：node tools/build-bridge.mjs [--abi arm64-v8a] [--quiet]');
  process.exit(0);
}

// ── 前置 1：hvigorw ───────────────────────────────────────────────────────────
const hvigorw = process.env.HVIGORW || DEFAULTS.hvigorw;
if (!existsSync(hvigorw)) {
  fail(`找不到 hvigorw：${hvigorw}`, [
    '它由 command-line-tools 提供（默认落点见上）。两条出路：',
    `  a) 装 command-line-tools 到 ${path.dirname(path.dirname(DEFAULTS.hvigorw))}；`,
    `  b) 用环境变量指过去：HVIGORW="/d/oh-workspace/.../hvigorw.bat" node tools/build-bridge.mjs`,
    '（DevEco Studio 自带的 hvigor 也能用，但命令行入口文件名必须是 hvigorw.bat）',
  ]);
}

// ── 前置 2：DEVECO_SDK_HOME（必须有；hvigor 的 native 交叉编译靠它找 LLVM 与 sysroot）──
const sdkHome = process.env.DEVECO_SDK_HOME;
if (!sdkHome || sdkHome.trim() === '') {
  fail('缺少 DEVECO_SDK_HOME（native 交叉编译找不到 SDK 的 LLVM/sysroot）', [
    '在 Git-Bash 里先导出（本机实测值）：',
    `  export DEVECO_SDK_HOME='${DEFAULTS.sdkHome}'`,
    `对应的 CMD 写法：set "DEVECO_SDK_HOME=${DEFAULTS.sdkHome}"（注意结尾不要带反斜杠）`,
  ]);
}
if (!existsSync(sdkHome)) {
  fail(`DEVECO_SDK_HOME 指向的目录不存在：${sdkHome}`, [ `检查是否指向了 <command-line-tools>/sdk（默认值：${DEFAULTS.sdkHome}）` ]);
}

// ── 前置 3：PATH 里要有 DevEco/CLT 的 node（hvigor 用它执行构建脚本）──────────
const nodeDirs = [process.env.DEVECO_NODE_HOME, DEFAULTS.devecoNode, DEFAULTS.cltNode].filter(
  (d) => typeof d === 'string' && d.length > 0 && existsSync(d)
);
const env = { ...process.env, DEVECO_SDK_HOME: sdkHome };
if (nodeDirs.length) {
  env.PATH = [...nodeDirs, process.env.PATH || ''].join(path.delimiter);
}

say('=========================================================');
say(' build-bridge —— 交叉编译 NAPI 引导件（走 hvigor externalNativeOptions）');
say(` 工程根      ：${ROOT}`);
say(` hvigorw     ：${hvigorw}`);
say(` DEVECO_SDK_HOME：${sdkHome}`);
say(` PATH 追加   ：${nodeDirs.length ? nodeDirs.join(' ; ') : '(未找到 DevEco/CLT 的 node 目录：沿用现有 PATH)'}`);
say(` ABI 提示    ：${abi}   ← 仅提示：真正生效的是 library/build-profile.json5 的 abiFilters（arm64-v8a）`);
say(` 命令        ：cmd /c "${hvigorw}" ${HVIGOR_ARGS.join(' ')}`);
say('=========================================================\n');

// ── 构建（stdio: inherit：hvigor 的输出就是唯一可信进度；本脚本不截流）────────
const r = spawnSync('cmd', ['/c', hvigorw, ...HVIGOR_ARGS], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});
if (r.error) {
  fail(`无法启动 cmd：${r.error.message}`, ['本脚本是 Windows 工具链包装器；在 Linux/macOS 上请直接用 DevEco 构建。']);
}
if (r.status !== 0) {
  fail(`hvigor 构建失败（退出码 ${r.status}）`, [
    '先自查：DEVECO_SDK_HOME 是否指向 <command-line-tools>/sdk、PATH 是否含 DevEco 的 node、',
    'library/build-profile.json5 的 abiFilters 是否含 arm64-v8a。',
    '常见坑：路径经 junction 暴露成两个盘符时 hvigor 会报 Path not found（工程规划 §D.7）⇒ 一律用真实路径。',
  ]);
}

// ── 产物核对（必须查产物，不查磁盘目录）────────────────────────────────────
const har = path.join(ROOT, HAR_REL);
if (!existsSync(har)) {
  fail(`构建"成功"但产物不存在：${har}`, [
    '这通常意味着 -p module=library@default 指错了模块名（对照 build-profile.json5 的 modules[].name / targets[].name）',
  ]);
}
const size = statSync(har).size;
console.log(`\n✓ 产物：${HAR_REL.replace(/\\/g, '/')}`);
console.log(`  路径：${har}`);
console.log(`  大小：${size.toLocaleString('en-US')} B（${(size / 1024).toFixed(1)} KiB）`);
if (size > EXPECTED_HAR_BYTES * 2 || size < EXPECTED_HAR_BYTES / 2) {
  console.log(
    `  ⚠️ 与工程规划附录 C 的期望值（≈441 KB = ${EXPECTED_HAR_BYTES.toLocaleString('en-US')} B）相差超过 2×：` +
      '请核对 HAR 内容（应含 libs/arm64-v8a/libnode_bridge.so + libc++_shared.so，且**不含** libnode.so）。'
  );
} else {
  console.log('  ✓ 与附录 C 的 441 KB 口径一致（HAR 不含 libnode.so）。');
}

process.exit(0);
