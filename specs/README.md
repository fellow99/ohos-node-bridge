# 规格目录（NNN-<name>）

编号与内容按工程规划 **§7.3 模块编号** 建立；一个规格 = 一个目录：

```
specs/
└── NNN-<name>/
    ├── spec.md         # 要什么（验收判据 / 非目标）
    ├── plan.md         # 怎么做（设计、取舍、影响面）
    └── tests.md        # 怎么验（真机 / host 侧）
```

## 已有编号（当前均**待补**）

| 编号 | 模块 | 现状 |
| --- | --- | --- |
| `001-runtime-core` | 运行时核心 | 骨架已落 `library/src/main/ets/runtime/` |
| `002-napi-bootstrap` | NAPI 引导 | 骨架已落 `library/src/main/cpp/` |
| `003-host-bridge` | 宿主能力桥 | 骨架（纯 JS 分发，缺 threadsafe_function） |
| `004-payload-bootstrap` | 载荷引导 | 只有参考实现 `payload/bootstrap.js` |
| `005-provision-verify` | 运行时获取与校验 | 已实现（`tools/provision.mjs` + `runtime.lock.json`） |
| `006-observability` | 观测 | 骨架（Logger/Env） |
| `007-distribution` | 分发 | 骨架（HAR 元数据 + `.ohpmignore`） |

> 写规格前先读 `docs/000-工程规划.md` 对应章节；**结论以那份文档为准**，本目录只做细化与验收。
