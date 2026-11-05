import { hapTasks } from '@ohos/hvigor-ohos-plugin';

/**
 * probe-app 的 hvigor 入口（HAP feature 模块）。
 *
 * 与 samples/minimal-app 的区别只有 `module.json5` 的 `type: feature`（minimal-app 已占 entry；
 * Stage 模型下一产品最多一个 entry，见 specs/101-probe-app/plan.md §3.3）。
 * 签名材料不在本文件：由仓库根 hvigorfile.ts 统一注入（signing.<mode>.local.json 或环境变量），
 * 都没有时产出未签名包 —— 本仓库的编译验证不依赖密钥。
 */
export default {
  system: hapTasks, /* Built-in plugin of hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of hvigor. */
};
