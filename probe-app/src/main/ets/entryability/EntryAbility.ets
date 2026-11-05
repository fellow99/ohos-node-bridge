import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0xD1010;
const TAG = 'PROBE_APP';

/**
 * PRB 探针应用 Ability。
 *
 * 与 samples/minimal-app 的 EntryAbility 同构（参考实现），只做两件事：
 * ① 让页面显示；② 支持命令行传参，便于自动化跑探针：
 *
 * ```bash
 * hdc shell "aa start -a EntryAbility -b org.fellow99.nodebridge.probe \
 *   --ps probePreset 0 --ps probeAuto true"
 * ```
 *
 * - `probePreset`：档位下标（0 = `--jitless`（默认，无 ACL 也能跑）/ 1 = 真 JIT（需 ACL）/ 2 = `--jitless + --expose-internals`）；
 * - `probeFlags`：逐字覆盖 flags（不属于任何档位时**原样使用**，不静默退到默认档）；
 * - `probeAuto`：`true` ⇒ 页面出现后自动投递并跑完全部 PRB 探针（无头）。
 *
 * ⚠️ Node 在同一进程内只能启动一次（宪法 C5）：换 flags 必须 `aa force-stop` 后重新 `aa start`。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);

    // 缺省必须是空串（= 不覆盖档位）：写死 flags 会经 AppStorage 压过页面上的档位选择（真机踩过）。
    let flags: string = '';
    let auto: string = '';
    let preset: string = '';
    const params: Record<string, Object> | undefined = want.parameters;
    if (params !== undefined) {
      const rawFlags: Object | undefined = params['probeFlags'];
      if (rawFlags !== undefined) {
        const s: string = rawFlags as string;
        if (s.length > 0) {
          flags = s;
        }
      }
      const rawAuto: Object | undefined = params['probeAuto'];
      if (rawAuto !== undefined) {
        auto = (rawAuto as string);
      }
      const rawPreset: Object | undefined = params['probePreset'];
      if (rawPreset !== undefined) {
        preset = (rawPreset as string);
      }
    }
    AppStorage.setOrCreate<string>('probeFlags', flags);
    AppStorage.setOrCreate<string>('probeAuto', auto);
    AppStorage.setOrCreate<string>('probePreset', preset);

    hilog.info(DOMAIN, TAG, 'onCreate flags=%{public}s auto=%{public}s preset=%{public}s', flags, auto, preset);
    hilog.info(DOMAIN, TAG, 'bundleCodeDir=%{public}s filesDir=%{public}s resourceDir=%{public}s',
      this.context.bundleCodeDir, this.context.filesDir, this.context.resourceDir);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
    });
  }
}
