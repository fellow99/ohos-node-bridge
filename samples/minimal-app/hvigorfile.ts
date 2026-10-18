import { hapTasks } from '@ohos/hvigor-ohos-plugin';

/**
 * 样例模块的 hvigor 入口。
 *
 * 与库模块（`library/hvigorfile.ts` 用 `harTasks`）的区别只有一行：这里是 **HAP**。
 * 签名材料**不在本文件里**，也不在本模块的 `build-profile.json5` 里：
 * 由仓库根的 `hvigorfile.ts` 统一注入（`signing.<mode>.local.json` 或环境变量），
 * 都没有时产出**未签名包**——`node tools/probe.mjs --build` 会在需要装机时明确提示。
 */
export default {
  system: hapTasks, /* Built-in plugin of hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of hvigor. */
};
