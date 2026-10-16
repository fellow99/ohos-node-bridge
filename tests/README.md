# 测试

本工程的测试分三层，**默认都不需要真机**（真机在 Phase 0 探针工程里，见 `../_test/test_node_probe`）：

| 层 | 位置 | 现状 |
| --- | --- | --- |
| 运行时产物门禁（七项 ELF + SHA-256） | `../tools/provision.mjs --check` | ✅ 已实现，可直接进 CI |
| ELF 手工核对（不依赖 llvm） | `../tools/elf-inspect.py <so>` | ✅ 已实现 |
| host 侧门禁（引导解包 / 桥 JSON 契约 / 载荷自检） | `smoke-host.mjs` | ⬜ Phase 1 |

## 快速自检

```bash
node ../tools/provision.mjs --check        # 产物是否仍与 runtime.lock.json 一致
python ../tools/elf-inspect.py <libs>/arm64-v8a/libnode.so
```

## 真机自检（消费方或探针工程）

把 `payload/selfcheck.js` 作为入口启动，然后：

```bash
hdc fport tcp:15577 tcp:15577
curl -s http://127.0.0.1:15577/facts | python -m json.tool
```

判定基线：无 ACL + 不带 `--jitless` ⇒ SIGTRAP；`--jitless` 下 `wasm.validate` 必为 `false`
且 `hotloop_ms_5rounds ≈ 300`；有 ACL 则应看到 `wasm.validate === true`。详见工程规划 §D.8。
