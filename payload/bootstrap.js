/*
 * bootstrap.js —— 消费方入口的参考实现（**骨架**，Phase 1/2 补齐）。
 *
 * 它演示的是「进程内 Node 起来之后」必须做的几件事，而不是一个功能完整的引导器。
 * 用法（消费方）：
 *   NodeRuntime.start(ctx, { scriptPath: '<abs>/payload/bootstrap.js', flags: '--no-verify-heap' })
 * 环境（由原生引导件注入，见 library/src/main/cpp/node_bridge.c）：
 *   HOME / USERPROFILE / TMPDIR / TMP / TEMP → 应用沙箱；NODE_ENV=production；NODE_OPTIONS 已清空
 */
'use strict';

const path = require('path');
const fs = require('fs');

function log(msg) {
  // 真机上 stdout/stderr 已被原生层重定向到 <home>/payload/node.log
  process.stdout.write('[bootstrap] ' + msg + '\n');
}

function env() {
  const home = process.env.HOME || '';
  if (!home) {
    throw new Error('HOME 未注入：原生引导件应设置 HOME/USERPROFILE/TMPDIR');
  }
  return {
    home: home,
    cwd: process.cwd(), // 真机上是 '/'：只用于日志，不要用它拼路径
    execPath: process.execPath, // 真机上是 /system/bin/appspawn：不要依赖它重启 Node
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    modules: process.versions.modules
  };
}

function main() {
  const e = env();
  log('node=' + e.node + ' platform=' + e.platform + ' arch=' + e.arch + ' modules=' + e.modules);
  log('home=' + e.home + ' cwd=' + e.cwd);

  // ── 以下是 Phase 1/2 要补齐的部分 ────────────────────────────────────────
  // ① 入口解析：消费方真正的入口（如 pi-web 的启动脚本）由 options 传入或按约定探测；
  //    推荐约定：<home>/payload/app/package.json 的 "main"，或环境变量 PI_WEB_ENTRY。
  // ② 宿主能力桥：require('@fellow99/node-bridge/bridge') 拿到桥对象（Phase 2 提供；当前仅说明形态）。
  // ③ 端口与探活：起服务后把「已就绪」写进日志（消费方靠轮询端口判断，见工程规划 §6.1）。
  // ④ 崩溃是终态：进程内 Node 不会自动重启，这里**不做**看门狗（会误导）。
  // ────────────────────────────────────────────────────────────────────────

  const entry = process.env.PI_WEB_ENTRY || path.join(e.home, 'payload', 'app', 'index.js');
  if (!fs.existsSync(entry)) {
    log('入口不存在（预期，骨架期）：' + entry);
    log('把消费方载荷放到该路径，或用 PI_WEB_ENTRY 指定绝对路径');
    return;
  }
  log('加载入口：' + entry);
  require(entry);
}

try {
  main();
} catch (err) {
  process.stderr.write('[bootstrap] FATAL ' + (err && err.stack ? err.stack : String(err)) + '\n');
  // 刻意不 process.exit：让原生层记录 node::Start 的返回值，保持现场
}
