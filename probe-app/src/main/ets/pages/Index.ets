import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Env, Logger, NodeRuntime, NodeRuntimeOptions, NodeStartResult } from '@fellow99/node-bridge';

const DOMAIN = 0xD1010;
const TAG = 'PROBE_APP';
/**
 * 索引级版本常量（PRB-05 对拍基准；只读引用 runtime.lock.json 的 active 字段，不复制全表）：
 * @fellow99/node-bridge 库版本 = library/oh-package.json5 version
 * TARGET_NODE / TARGET_ARCH = library/src/main/resources/rawfile/node_bridge/runtime.lock.json active 段
 */
const LIBRARY_VERSION: string = '0.2.0';
const TARGET_NODE: string = 'v26.13.0';
const TARGET_ARCH: string = 'arm64-v8a';
const MODULE_VERSION: string = '0.1.0';
const BUNDLE: string = 'org.fellow99.nodebridge.probe';
const DEFAULT_PORT: number = 15577;

/** 页面/载荷都只认这 16 个冻结键（契约 §3.6；载荷 buildChecks 实现，页面在此做键名在场检查） */
const FROZEN_KEYS: string[] = [
  'node', 'platform', 'arch', 'execArgv', 'versions', 'homedir', 'tmpdir',
  'homedir_redirected', 'tmpdir_redirected', 'netifaces', 'cpus', 'spawn',
  'wasm.validate', 'wasm.error', 'fs_write_readback', 'hotloop_ms_5rounds'
];

/** 每项探针的收口三态：pass / fail / skip（spec FR-101-PROBE-018/019） */
interface ProbeResult {
  status: string;
  detail: string;
}

/** /facts 解析视图（防御式手动抽取，避免对 JSON 深层做不安全的强制转换） */
class FactsView {
  at: string = '';
  node: string = '';
  arch: string = '';
  homedirRedirected: boolean = false;
  tmpdirRedirected: boolean = false;
  fsWriteReadback: string = '';
  keys: string[] = [];
  roundtripOk: boolean = false;
}

/** flag 档位（顺序即界面顺序；与 tools/probe.mjs --preset <n> 的下标同口径） */
interface FlagPreset {
  key: string;
  label: string;
  flags: string;
  hint: string;
}

const PRESETS: FlagPreset[] = [
  {
    key: 'jitless',
    label: '① --jitless（无 ACL 也能跑）',
    flags: '--jitless --no-verify-heap',
    hint: '无 ACL 默认档：WASM 全废'
  },
  {
    key: 'jit',
    label: '② 真 JIT（需要 ACL）',
    flags: '--no-verify-heap',
    hint: 'Profile 无 JIT ACL ⇒ 起动即 SIGTRAP（真机实测）'
  },
  {
    key: 'internals',
    label: '③ --jitless + --expose-internals',
    flags: '--jitless --expose-internals --no-verify-heap',
    hint: '内部模块判据档'
  }
];

@Entry
@Component
struct Index {
  @State stage: string = '(未启动)';
  @State logText: string = '(log empty)';
  @State started: boolean = false;
  @State resultLines: string[] = [];
  @State current: string = '(idle)';
  @State flagsHint: string = PRESETS[0].hint;

  private runtime: NodeRuntime = NodeRuntime.getInstance();
  private payloadPath: string = '';
  private flags: string = PRESETS[0].flags;
  private startPassed: boolean = false;
  private facts: FactsView | undefined = undefined;
  private lastError: string = '';

  aboutToAppear(): void {
    // ① 载荷物化（C3：ArkTS 写的 Node 才读得到）
    try {
      const c: common.UIAbilityContext = this.abilityContext();
      Env.ensureRuntimeDirs(c);
      this.payloadPath = Env.materializeRawfile(c.resourceManager, 'probe-app.js',
        c.filesDir + '/payload/probe-app.js');
      Env.materializeRawfile(c.resourceManager, 'host.js', c.filesDir + '/payload/host.js');
      this.appendLog('载荷已物化：' + this.payloadPath);
    } catch (e) {
      this.lastError = '载荷物化失败：' + Logger.describeThrown(e as Object);
      this.appendLog(this.lastError);
    }

    // ② 命令行覆盖：档位索引 / 逐字 flags
    const presetIndexRaw: string | undefined = AppStorage.get<string>('probePreset');
    let presetIndex: number = 0;
    if (presetIndexRaw !== undefined && presetIndexRaw.length > 0) {
      const idx: number = Number(presetIndexRaw);
      if (Number.isInteger(idx) && idx >= 0 && idx < PRESETS.length) {
        presetIndex = idx;
      }
    }
    const presetFlags: string | undefined = AppStorage.get<string>('probeFlags');
    if (presetFlags !== undefined && presetFlags.length > 0) {
      let matched: boolean = false;
      for (let i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].flags === presetFlags) {
          presetIndex = i;
          matched = true;
        }
      }
      if (!matched) {
        this.flags = presetFlags;
        this.flagsHint = '逐字覆盖: ' + presetFlags;
      }
    }
    if (this.flagsHint === PRESETS[0].hint) {
      this.flags = PRESETS[presetIndex].flags;
      this.flagsHint = PRESETS[presetIndex].hint;
    }

    // ③ 无头自动化（--ps probeAuto true）
    const auto: string | undefined = AppStorage.get<string>('probeAuto');
    if (auto === 'true' && this.lastError.length === 0) {
      this.runProbes();
    }
  }

  /** 取 UIAbilityContext */
  private abilityContext(): common.UIAbilityContext {
    const host: common.Context | undefined = this.getUIContext().getHostContext();
    if (host === undefined) {
      throw new Error('UIAbilityContext 不可用：页面尚未挂载到 Ability');
    }
    return host as common.UIAbilityContext;
  }

  private appendLog(line: string): void {
    const text: string = this.logText === '(log empty)' ? line : this.logText + '\n' + line;
    this.logText = text.length > 16000 ? text.slice(-16000) : text;
  }

  // ── 流水线编排：PRB-01 → 02 → 03 → 04 → 05，每项独立超时 ──────────────────
  private runProbes(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.resultLines = [];
    const run = async (): Promise<void> => {
      this.current = 'PRB-01 加载…';
      this.pushResult('PRB-01 加载', await this.withTimeout(this.probe01(), 5000));
      this.current = 'PRB-02 启动…';
      this.pushResult('PRB-02 启动', await this.withTimeout(this.probe02(), 25000));
      if (!this.startPassed) {
        this.pushResult('PRB-03 起服', { status: 'skip', detail: '前置 PRB-02 未通过' });
        this.pushResult('PRB-04 host桥', { status: 'skip', detail: '前置 PRB-02 未通过' });
        this.pushResult('PRB-05 版本契约', { status: 'skip', detail: '前置 PRB-02 未通过（无 /facts）' });
        this.finish();
        return;
      }
      this.current = 'PRB-03 起服…';
      this.pushResult('PRB-03 起服', await this.withTimeout(this.probe03(), 20000));
      this.current = 'PRB-04 host桥…';
      this.pushResult('PRB-04 host桥', await this.withTimeout(this.probe04(), 25000));
      this.current = 'PRB-05 版本契约…';
      this.pushResult('PRB-05 版本契约', await this.withTimeout(this.probe05(), 10000));
      this.finish();
    };
    run();
  }

  private finish(): void {
    this.current = '(done)';
    const report: string = this.buildReport();
    this.writeReportFile(report);
    hilog.info(DOMAIN, TAG, 'PROBE_REPORT %{public}s', report);
    this.appendLog('PROBE_REPORT ' + report);
  }

  private pushResult(title: string, r: ProbeResult): void {
    const line: string = title + '  =>  ' + r.status.toUpperCase() + '  ' + r.detail;
    this.resultLines = this.resultLines.concat([line]);
    this.appendLog(line);
  }

  /** 独立超时封装：超时/异常都收口成 fail（FR-101-PROBE-013） */
  private withTimeout(p: Promise<ProbeResult>, ms: number): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let settled: boolean = false;
      const timer: number = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ status: 'fail', detail: '独立超时 ' + ms + ' ms' });
      }, ms);
      p.then((r: ProbeResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }, (e: Object) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'fail', detail: Logger.describeThrown(e) });
      });
    });
  }

  // ── PRB-01 加载：getInstance + loadLibrary（bridgeVersion）不抛 ─────────────
  private probe01(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      try {
        const v: string = this.runtime.bridgeVersion();
        resolve({ status: v.length > 0 ? 'pass' : 'fail', detail: 'bridgeVersion=' + (v.length > 0 ? v : '(empty)') });
      } catch (e) {
        resolve({ status: 'fail', detail: 'bridgeVersion() 抛错：' + Logger.describeThrown(e as Object) });
      }
    });
  }

  // ── PRB-02 启动：物化 → 注册 echo + 信箱 → start() ok → stage 到 running ──
  private probe02(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let c: common.UIAbilityContext;
      try {
        c = this.abilityContext();
      } catch (e) {
        resolve({ status: 'fail', detail: Logger.describeThrown(e as Object) });
        return;
      }
      // 宿主桥前置（必须在 start() 之前）：注册 echo + 起文件信箱（PRB-04 的数据面）
      try {
        this.runtime.host.register('probe.echo', (argsJson: string): string => {
          return JSON.stringify({ ping: 'pong', received: argsJson });
        });
        const mb: string = this.runtime.host.startMailbox(Env.payloadDir(c), 100);
        this.appendLog('host-bridge 信箱泵：' + mb);
      } catch (e) {
        this.appendLog('host-bridge 信箱启动失败（PRB-04 将受影响）：' + Logger.describeThrown(e as Object));
      }
      const options: NodeRuntimeOptions = {
        flags: this.flags,
        scriptPath: this.payloadPath,
        env: { 'PROBE_PORT': String(DEFAULT_PORT), 'PROBE_MAILBOX_DIR': Env.payloadDir(c) }
      };
      let result: NodeStartResult;
      try {
        result = this.runtime.start(c, options);
      } catch (e) {
        resolve({ status: 'fail', detail: 'start() 抛错：' + Logger.describeThrown(e as Object) });
        return;
      }
      if (!result.ok) {
        resolve({ status: 'fail', detail: 'start ok=false code=' + result.code + ' ' + result.message });
        return;
      }
      this.appendLog('已投递 Node：flags=' + this.flags);
      this.pollStage().then((r: ProbeResult) => {
        if (r.status === 'pass') {
          this.startPassed = true;
        }
        resolve(r);
      }, (e: Object) => {
        resolve({ status: 'fail', detail: Logger.describeThrown(e) });
      });
    });
  }

  /** 轮询原生 stage 到 running（探活命中才算起动，20 s 内未到即 FAIL） */
  private pollStage(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let elapsed: number = 0;
      const iv: number = 300;
      const timer: number = setInterval(() => {
        elapsed += iv;
        const stage: string = this.runtime.getStage();
        this.stage = stage;
        if (stage.startsWith('running')) {
          clearInterval(timer);
          resolve({ status: 'pass', detail: 'stage=' + stage + ' state=' + this.runtime.getState() });
          return;
        }
        if (elapsed >= 20000) {
          clearInterval(timer);
          resolve({
            status: 'fail',
            detail: '20 s 内 stage 未到 running；stage=' + stage + ' lastError=' + this.runtime.getLastError()
              + ' log=' + this.runtime.getLogPath()
          });
        }
      }, iv);
    });
  }

  // ── PRB-03 起服：/facts 200 + 16 冻结键 + 健康键 ──────────────────────────
  private probe03(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      this.httpRequest('http://127.0.0.1:' + DEFAULT_PORT + '/facts', http.RequestMethod.GET, '')
        .then((text: string) => {
          const view: FactsView = this.parseFacts(text);
          this.facts = view;
          const missing: string[] = [];
          for (let i = 0; i < FROZEN_KEYS.length; i++) {
            if (view.keys.indexOf(FROZEN_KEYS[i]) < 0) {
              missing.push(FROZEN_KEYS[i]);
            }
          }
          if (missing.length > 0) {
            resolve({ status: 'fail', detail: '冻结键缺失 ' + missing.join(',') });
            return;
          }
          const healthOk: boolean = view.homedirRedirected && view.tmpdirRedirected
            && view.fsWriteReadback === 'OK' && view.node.startsWith(TARGET_NODE);
          if (!healthOk) {
            resolve({
              status: 'fail',
              detail: '健康键不成立 node=' + view.node + ' homedirR=' + view.homedirRedirected
                + ' tmpdirR=' + view.tmpdirRedirected + ' fs=' + view.fsWriteReadback
            });
            return;
          }
          resolve({
            status: 'pass',
            detail: 'node=' + view.node + ' arch=' + view.arch + ' 16键齐 健康键全真'
          });
        }, (e: Object) => {
          resolve({ status: 'fail', detail: '/facts 请求失败：' + Logger.describeThrown(e) });
        });
    });
  }

  // ── PRB-04 host桥：POST /rport 触发一次新的信箱往返 + /facts.host_roundtrip ─
  private probe04(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      this.httpRequest('http://127.0.0.1:' + DEFAULT_PORT + '/rport', http.RequestMethod.POST,
        JSON.stringify({ probe: 'echo' }))
        .then((text: string) => {
          // 期望 { path:"/rport", roundtrip:{ ok:true, reply:{ping:"pong"} } }
          const ok: boolean = text.indexOf('"ok":true') >= 0 && text.indexOf('"ping":"pong"') >= 0;
          const fromFacts: boolean = this.facts !== undefined && this.facts!.roundtripOk;
          if (ok && fromFacts) {
            resolve({ status: 'pass', detail: '/rport 往返 ok=true 且 /facts.host_roundtrip.ok=true' });
            return;
          }
          resolve({
            status: 'fail',
            detail: '/rport=' + (ok ? 'ok' : 'no')
              + ' facts.roundtrip.ok=' + (fromFacts ? 'true' : 'false')
              + ' 响应=' + text.slice(0, 160)
          });
        }, (e: Object) => {
          resolve({ status: 'fail', detail: '/rport 请求失败：' + Logger.describeThrown(e) });
        });
    });
  }

  // ── PRB-05 版本契约：Index 常量 vs /facts 元数据 ──────────────────────────
  private probe05(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const view: FactsView | undefined = this.facts;
      if (view === undefined) {
        resolve({ status: 'skip', detail: '无 /facts（PRB-03 未执行成功）' });
        return;
      }
      const nodeOk: boolean = view.node.startsWith(TARGET_NODE);
      const archOk: boolean = view.arch.startsWith(TARGET_ARCH);
      let bv: string = '';
      try {
        bv = this.runtime.bridgeVersion();
      } catch (e) {
        bv = '(不可读: ' + Logger.describeThrown(e as Object) + ')';
      }
      if (nodeOk && archOk && bv.length > 0) {
        resolve({
          status: 'pass',
          detail: TARGET_NODE + '/' + TARGET_ARCH + ' 命中；bridgeVersion=' + bv + ' 库 ' + LIBRARY_VERSION
        });
        return;
      }
      resolve({
        status: 'fail',
        detail: 'node(' + view.node + ') arch(' + view.arch + ') bridgeVersion(' + bv + ')'
          + ' vs 期望 ' + TARGET_NODE + '/' + TARGET_ARCH
      });
    });
  }

  // ── 工具：HTTP GET/POST（只对 loopback；OJ 判 200）─────────────────────────
  private httpRequest(url: string, method: http.RequestMethod, body: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req: http.HttpRequest = http.createHttp();
      const opts: http.HttpRequestOptions = {
        method: method,
        readTimeout: 6000,
        connectTimeout: 6000
      };
      if (body.length > 0) {
        opts.extraData = body;
        opts.header = { 'Content-Type': 'application/json' };
      }
      req.request(url, opts).then((res: http.HttpResponse) => {
        req.destroy();
        if (res.responseCode === 200) {
          resolve(typeof res.result === 'string' ? res.result as string : String(res.result));
          return;
        }
        reject(new Error('HTTP ' + res.responseCode));
      }).catch((e: Object) => {
        req.destroy();
        reject(e);
      });
    });
  }

  /** 解析 /facts → FactsView（防御式：字段缺失取安全默认，绝不抛） */
  private parseFacts(text: string): FactsView {
    const view: FactsView = new FactsView();
    try {
      const root: Record<string, Object | undefined> =
        JSON.parse(text) as Record<string, Object | undefined>;
      const checks: Record<string, Object | undefined> =
        (root['checks'] === undefined ? {} : root['checks']) as Record<string, Object | undefined>;
      view.at = typeof root['at'] === 'string' ? root['at'] as string : '';
      const asString = (k: string): string => (typeof checks[k] === 'string' ? checks[k] as string : '');
      const asBool = (k: string): boolean => checks[k] === true;
      view.node = asString('node');
      view.arch = asString('arch');
      view.fsWriteReadback = asString('fs_write_readback');
      view.homedirRedirected = asBool('homedir_redirected');
      view.tmpdirRedirected = asBool('tmpdir_redirected');
      view.keys = Object.keys(checks as Object);
      const hr: Object | undefined = checks['host_roundtrip'];
      if (hr !== undefined) {
        view.roundtripOk = JSON.stringify(hr).indexOf('"ok":true') >= 0;
      }
    } catch (e) {
      view.node = 'parse-error:' + Logger.describeThrown(e as Object);
    }
    return view;
  }

  /** 汇聚报告（沙箱文件 + hilog） */
  private buildReport(): string {
    const probes: string[] = [];
    for (let i = 0; i < this.resultLines.length; i++) {
      const id: string = 'PRB-' + ('0' + String(i + 1)).slice(-2);
      const line: string = this.resultLines[i];
      const sep: number = line.indexOf('  =>  ');
      if (sep >= 0) {
        const status: string = line.slice(sep + 6, line.indexOf('  ', sep + 6) > 0
          ? line.indexOf('  ', sep + 6) : line.length).trim();
        probes.push('{"id":"' + id + '","status":"' + status + '","detail":"'
          + this.escapeJson(line.slice(sep + 6)) + '"}');
      } else {
        probes.push('{"id":"' + id + '","status":"unknown","detail":"' + this.escapeJson(line) + '"}');
      }
    }
    return '{"at":"' + this.isoNow() + '","bundle":"' + BUNDLE + '","version":"' + MODULE_VERSION
      + '","library":"' + LIBRARY_VERSION + '","targetNode":"' + TARGET_NODE
      + '","flags":"' + this.escapeJson(this.flags) + '","probes":[' + probes.join(',') + ']}';
  }

  private writeReportFile(text: string): void {
    try {
      const c: common.UIAbilityContext = this.abilityContext();
      const p: string = c.filesDir + '/probe-report.json';
      const f: fs.File = fs.openSync(p, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(f.fd, text);
      } finally {
        fs.closeSync(f);
      }
      this.appendLog('报告已落盘：' + p);
    } catch (e) {
      this.appendLog('报告写盘失败：' + Logger.describeThrown(e as Object));
    }
  }

  private isoNow(): string {
    const d: Date = new Date();
    return d.toISOString();
  }

  private escapeJson(s: string): string {
    let out: string = '';
    for (let i = 0; i < s.length; i++) {
      const ch: string = s.charAt(i);
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      if (ch === '\\') {
        out += '\\\\';
        continue;
      }
      out += ch;
    }
    return out;
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  build() {
    Column({ space: 6 }) {
      Text('PRB 探针 · ' + BUNDLE)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .width('100%')

      Text('库 ' + LIBRARY_VERSION + ' · 目标 Node ' + TARGET_NODE + ' · ' + MODULE_VERSION)
        .fontSize(11)
        .fontColor('#888888')
        .width('100%')

      Text('当前：' + this.current + '　阶段：' + this.stage)
        .fontSize(13)
        .width('100%')

      Text('flags：' + this.flags + '（' + this.flagsHint + '）')
        .fontSize(11)
        .fontColor('#0A6EBD')
        .width('100%')

      Button(this.started ? '已投递（每进程只能一次）' : '跑 PRB 探针')
        .width('100%')
        .enabled(!this.started)
        .onClick(() => {
          this.runProbes();
        })

      ForEach(this.resultLines, (line: string) => {
        Text(line)
          .fontSize(11)
          .fontFamily('monospace')
          .width('100%')
      }, (line: string) => line)

      Text('报告：<filesDir>/probe-report.json · hilog PROBE_REPORT')
        .fontSize(10)
        .fontColor('#666666')
        .width('100%')

      Scroll() {
        Text(this.logText)
          .fontSize(9)
          .fontFamily('monospace')
          .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .backgroundColor('#F5F5F5')
      .borderRadius(6)
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
