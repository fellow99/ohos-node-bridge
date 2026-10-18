import { common } from '@kit.AbilityKit';
import { Env, Logger, NodeRuntime, NodeRuntimeOptions, NodeStartResult } from '@fellow99/node-bridge';

/**
 * `ohos-node-bridge` 最小样例 + 内置探针页面。
 *
 * 这个页面是**参考实现的正文**：消费方照抄这几十行就能把 Node 跑起来——
 *   ① `Env.ensureRuntimeDirs(ctx)`：建齐 `<filesDir>/{payload,tmp,node-bridge}`（投递前必须做完）；
 *   ② `Env.materializeRawfile(...)`：把 `rawfile/probe.js` 落到**可写**沙箱（C3 谁写谁读：
 *      ArkTS 写的文件 Node 读得到；用鸿蒙解压器写出来的 Node 读不到）；
 *   ③ `NodeRuntime.getInstance().start(ctx, { flags, scriptPath })`：**投递**语义，返回时 Node 还在起；
 *   ④ 轮询 `getState()/getStage()/getPid()` + `Logger.tail(logPath)` 做界面；
 *   ⑤ 探针本身是一个 HTTP 服务（`/facts` `/log`），真机用 `hdc fport` + `curl` 取证。
 *
 * 四条纪律（照抄时不要省）：
 *   · Node **每进程只能起一次**（宪法 C5）⇒ 启动按钮点过就禁用，换 flags 要 force-stop 后重开；
 *   · **JIT 需要 ACL**（`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`）。本样例的调试 Profile **没有**该 ACL
 *     ⇒ 真 JIT 档一启动就 `CRASH sig=5`（SIGTRAP）；默认档因此是 `--jitless`（代价：WebAssembly 全废，规划 §D.8）；
 *   · `aa start --ps <k> <v>` **只送得动一个 token** ⇒ 多词 flags 请用 `--ps probePreset <0|1|2>`（见 EntryAbility）；
 *   · 页面只呈现**库返回的事实**，不猜端口、不猜状态（C2 不隐藏平台真相）。
 */

/** flag 档位（顺序即界面顺序；`tools/probe.mjs --preset <n>` 用的就是这个下标） */
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
    hint: '本 bundle 的可用档：wasm 全废、热循环 ≈300 ms（5×2e6，真机实测）'
  },
  {
    key: 'jit',
    label: '② 真 JIT（需要 ACL）',
    flags: '--no-verify-heap',
    hint: 'Profile 无 JIT ACL ⇒ 启动即 SIGTRAP（本机实测，见 README §5）'
  },
  {
    key: 'internals',
    label: '③ --jitless + --expose-internals',
    flags: '--jitless --expose-internals --no-verify-heap',
    hint: '内部模块判据：require("internal/modules/cjs/loader")'
  }
];

@Entry
@Component
struct Index {
  @State status: string = 'idle';
  @State stage: string = '(未启动)';
  @State lastError: string = '';
  @State pid: number = -1;
  @State presetIndex: number = 0;
  @State logText: string = '(log empty)';
  @State probePath: string = '(未物化)';
  @State endpoint: string = 'http://127.0.0.1:15577/facts';
  @State started: boolean = false;
  /** 命令行给的、不属于任何档位的 flags（**逐字使用**，不静默退到默认档） */
  @State customFlags: string = '';
  /** 实际会传给 start() 的 flags（界面显示它，避免"以为换了档"） */
  @State effectiveFlags: string = PRESETS[0].flags;

  private runtime: NodeRuntime = NodeRuntime.getInstance();
  private timerId: number = -1;
  /** 首次看到 stage=running 后调一次 markRunning()：库把「Node 真的有输出」的判据交给消费方（契约 §2.6） */
  private markedRunning: boolean = false;

  aboutToAppear(): void {
    try {
      const ctx: common.UIAbilityContext = this.abilityContext();
      Env.ensureRuntimeDirs(ctx);
      // ① 物化载荷：rawfile → 可写沙箱（demo 载荷很小；大载荷请改用 resfile 只读直读，规划 §5.5）
      const dest: string = ctx.filesDir + '/payload/probe.js';
      Env.materializeRawfile(ctx.resourceManager, 'probe.js', dest);
      this.probePath = dest;
      Logger.info('[sample] payload 已物化：' + dest);
    } catch (e) {
      this.status = 'failed';
      this.lastError = '载荷物化失败：' + Logger.describeThrown(e as Object);
    }

    // ② 命令行覆盖：`--ps probePreset <0|1|2>`（索引，一个 token 才稳）
    //    或 `--ps probeFlags <值>`（值不含空格才送得全，否则会被 aa 截断）
    const presetIndexRaw: string | undefined = AppStorage.get<string>('probePreset');
    if (presetIndexRaw !== undefined && presetIndexRaw.length > 0) {
      const idx: number = Number(presetIndexRaw);
      if (Number.isInteger(idx) && idx >= 0 && idx < PRESETS.length) {
        this.presetIndex = idx;
      }
    }
    const presetFlags: string | undefined = AppStorage.get<string>('probeFlags');
    if (presetFlags !== undefined && presetFlags.length > 0) {
      let matched: boolean = false;
      for (let i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].flags === presetFlags) {
          this.presetIndex = i;
          matched = true;
        }
      }
      if (!matched) {
        this.customFlags = presetFlags;
      }
    }
    this.effectiveFlags = this.customFlags.length > 0 ? this.customFlags : PRESETS[this.presetIndex].flags;

    // ③ 自动化：`--ps probeAuto true` ⇒ 免手点
    const auto: string | undefined = AppStorage.get<string>('probeAuto');
    if (auto === 'true' && this.lastError.length === 0) {
      this.launch();
    }

    // ④ 日志实时刷到界面（「把界面当调试台」：hdc 读沙箱日志有限，界面永远可截图）
    this.timerId = setInterval(() => {
      this.refresh();
    }, 1500);
  }

  aboutToDisappear(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
  }

  /** 取 UIAbilityContext（不用已弃用的全局 getContext） */
  private abilityContext(): common.UIAbilityContext {
    const host: common.Context | undefined = this.getUIContext().getHostContext();
    if (host === undefined) {
      throw new Error('UIAbilityContext 不可用：页面尚未挂载到 Ability');
    }
    return host as common.UIAbilityContext;
  }

  /** 当前生效的 flags（档位 / 逐字覆盖二选一） */
  private flagsNow(): string {
    return this.customFlags.length > 0 ? this.customFlags : PRESETS[this.presetIndex].flags;
  }

  /** 投递启动（幂等：库侧只允许 idle 时调用一次） */
  private launch(): void {
    if (this.started) {
      this.lastError = '本进程已投递过启动：Node 每进程只能起一次（换 flags 请 force-stop 后重开）';
      return;
    }
    this.started = true;
    const flags: string = this.flagsNow();
    this.effectiveFlags = flags;
    const ctx: common.UIAbilityContext = this.abilityContext();
    const options: NodeRuntimeOptions = {
      flags: flags,
      scriptPath: this.probePath,
      // 端口写进环境：载荷按 PROBE_PORT 选端口（默认 15577，与 selfcheck 同一文档化口径）
      env: { 'PROBE_PORT': '15577' }
    };
    const result: NodeStartResult = this.runtime.start(ctx, options);
    this.status = result.state;
    this.stage = result.message;
    if (!result.ok) {
      this.lastError = result.message;
      this.status = 'failed';
      return;
    }
    Logger.info('[sample] 已投递：flags=' + flags + ' code=' + result.code);
  }

  /** 刷新界面事实（全部来自库，不自己猜） */
  private refresh(): void {
    // 状态机收敛：库在 start() 后是 starting；「Node 真的有输出」由消费方观察到后调 markRunning()。
    // 不调会让 UI 永远停在 starting（真机上踩过：阶段= running 而状态= starting）。
    if (!this.markedRunning && this.runtime.getStage().indexOf('running') === 0) {
      this.markedRunning = true;
      this.runtime.markRunning();
    }
    this.status = this.runtime.getState();
    this.stage = this.runtime.getStage();
    this.lastError = this.runtime.getLastError();
    this.pid = this.runtime.getPid();
    const logPath: string = this.runtime.getLogPath();
    const tail: string = Logger.tail(logPath, 8192);
    this.logText = tail.length > 0 ? tail : '(log empty：' + logPath + ')';
  }

  @Builder
  presetRow(preset: FlagPreset, index: number) {
    Row() {
      Text((this.presetIndex === index ? '● ' : '○ ') + preset.label)
        .fontSize(13)
        .fontColor(this.presetIndex === index ? Color.White : '#333333')
    }
    .width('100%')
    .padding({ left: 10, top: 6, bottom: 6 })
    .margin({ bottom: 4 })
    .borderRadius(6)
    .backgroundColor(this.presetIndex === index ? '#3A6FF8' : '#F0F1F3')
    .onClick(() => {
      if (!this.started && this.customFlags.length === 0) {
        this.presetIndex = index;
        this.effectiveFlags = PRESETS[index].flags;
      }
    })
  }

  build() {
    Column({ space: 6 }) {
      Text('ohos-node-bridge · 最小样例 / 内置探针')
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .width('100%')

      Text('库版本 0.1.0 · bundle org.fellow99.nodebridge.sample')
        .fontSize(11)
        .fontColor('#888888')
        .width('100%')

      // 三档 flags（点过启动后锁定：进程内 Node 只能起一次）
      ForEach(PRESETS, (preset: FlagPreset, index: number) => {
        this.presetRow(preset, index)
      })

      Button(this.started ? '已投递（每进程只能一次）' : '启动 Node（投递）')
        .width('100%')
        .enabled(!this.started)
        .onClick(() => {
          this.launch();
          this.refresh();
        })

      Text('状态：' + this.status + '　pid=' + this.pid)
        .fontSize(13)
        .width('100%')
      Text('阶段：' + this.stage)
        .fontSize(11)
        .fontColor('#555555')
        .width('100%')
      if (this.lastError.length > 0) {
        Text('错误：' + this.lastError)
          .fontSize(11)
          .fontColor(Color.Red)
          .width('100%')
      }
      Text('当前 flags：' + this.effectiveFlags)
        .fontSize(11)
        .fontColor('#0A6EBD')
        .width('100%')
      Text('载荷：' + this.probePath)
        .fontSize(10)
        .fontColor('#666666')
        .width('100%')
      Text('取证：hdc fport tcp:15577 tcp:15577 && curl -s ' + this.endpoint)
        .fontSize(10)
        .fontColor('#0A6EBD')
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
