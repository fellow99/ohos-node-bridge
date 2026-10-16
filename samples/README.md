# 样例（Phase 1，当前仅占位）

本工程的**产品**是 `library/` 里的 HAR，样例只用来验证「库能被消费、能被装进 HAP」。
按工程规划 §7.2，规划中的样例是：

| 样例 | 作用 | 状态 |
| --- | --- | --- |
| `minimal-app/` | 一个 Ability + 一个按钮 + 一个日志面板，验证 HAR 接线与 NAPI 引导 | ⬜ Phase 1 |
| `arkweb-http/` | ArkWeb 加载本地服务的最小页（Phase 0 P0-3 的复用形态） | ⬜ Phase 1 |

## 当前如何验证「库可用」

不以样例为主，而是**真实消费方** `pi-desktop-ark`（见 `../../pi-desktop-ark`）：
它通过 `file:../ohos-node-bridge/library` 依赖本库，构建时的产物校验 + HAP 打包即是端到端验证。

需要在本仓库内自测时：在 `build-profile.json5` 的 `modules[]` 里加一条
`{"name": "minimal-app", "srcPath": "./samples/minimal-app", ...}`，并在
`samples/minimal-app/oh-package.json5` 里写 `"@fellow99/node-bridge": "file:../../library"`。
