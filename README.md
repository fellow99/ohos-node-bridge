# ohos-node-bridge

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Embed a **real Node.js runtime** inside your **HarmonyOS app's own process** —
> not a WebView, not a cloud function, not a child process.

This repository contains only the **bridge package** (ArkTS API + NAPI bootstrap
native libs). The **engine binary** (`libnode.so`) lives in the separate
[ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) repository and
is published as `@fellow99/node-runtime`.

**Language: English** · [简体中文](README_zh.md)

---

## How it works

```
┌──────────────────────────── HarmonyOS app process ───────────────────────────┐
│                                                                              │
│  ArkTS page ──► NodeRuntime.start()                                         │
│                     │                                                        │
│                     ▼                                                        │
│   libnode_bridge.so  ── dlopen("libnode.so") ──►  libnode.so  (V8 + Node)  │
│   (this package)       dlsym(node::Start)              (runtime package)    │
│                                                                              │
│        Node JS  ◄──── NAPI host bridge ────►  ArkTS handlers (HostBridge)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

The two packages are coupled by a **runtime symbol contract**
(`dlopen` + `dlsym(node::Start)` + `napi_*`), **not** by link-time dependencies.
You can swap the Node.js version (e.g. 24.2.0 → 24.x) **without recompiling the
bridge**.

## Installation

You need **both** packages:

```bash
# Bridge — ArkTS API + native bootstrap (~0.5 MB)
ohpm install @fellow99/node-bridge

# Runtime — the Node.js engine binary (~41 MB compressed)
ohpm install @fellow99/node-runtime@24.2.0
```

The bridge deliberately does **not** declare a dependency on the runtime, so you
must install both explicitly and choose the Node.js version yourself.

## Quick start

```ts
import { NodeRuntime } from '@fellow99/node-bridge';
import { common } from '@kit.AbilityKit';

const runtime = NodeRuntime.getInstance();
const result = runtime.start(getContext(this) as common.UIAbilityContext, {
  scriptPath: '<sandbox-absolute-path>/payload/bootstrap.js',
  // flags: '--jitless',  // fallback when the JIT ACL is unavailable (disables WASM)
});
```

## Three things the consumer must do

| # | What | Why |
|---|------|-----|
| 1 | Install `@fellow99/node-runtime@24.2.0` | The bridge ships **no** `libnode.so` (~121 MB); the runtime package provides it |
| 2 | Request the ACL `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` under **your own bundle name** | Required for JIT. Without it, V8 SIGTRAPs on JIT; `--jitless` is a fallback but disables WebAssembly |
| 3 | Place your payload under `resources/resfile/<app>/` (read-through) | Node cannot read packaged read-only entries; use an app-sandbox absolute path |

## API surface

| Export | Purpose |
|--------|---------|
| `NodeRuntime` | Singleton lifecycle manager: `start()`, state machine, crash capture |
| `NodeState` | Runtime state enum |
| `HostBridge` | Register ArkTS handlers callable from Node JS |
| `HostBridgeHandler` | Handler signature for Node → ArkTS calls |
| `Logger` | In-process log ring buffer + hilog bridge |
| `Env` | Path / environment-variable assembly |
| Types | `NodeRuntimeOptions`, `NodeStartResult`, `NodeLogEntry`, `CrashRecord` |

## The two repositories

| | **ohos-node-bridge** (this repo) | [ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) |
|---|---|---|
| **ohpm package** | `@fellow99/node-bridge` | `@fellow99/node-runtime` |
| **Version** | Independent semver (current `0.2.0`) | **Equals the Node.js version** (current `24.2.0`) |
| **Contains** | ArkTS bytecode + `libnode_bridge.so` bootstrap + `libnode_host_client.so` NAPI addon | `libnode.so` (~121 MB) + `libc++_shared.so` + version constants |
| **Role** | `NodeRuntime` state machine, `HostBridge` (Node ↔ ArkTS), `dlopen` the engine and call `node::Start` | The engine itself: V8/JIT and all built-in modules; **no ArkTS API** |
| **Release cadence** | Driven by feature work | Driven by Node.js major versions |

| Item | Value |
|------|-------|
| Target devices | `2in1` / `tablet` (no phone); ABI `arm64-v8a` only |
| Runtime | Node.js **v24.2.0**; `process.versions.modules = 137` |
| Design doc | [`docs/`](docs/) (engineering plan, specs, publish notes) |

## Repository layout

```
ohos-node-bridge/
├── library/        # @fellow99/node-bridge source (ArkTS + NAPI bootstrap C)
├── payload/        # Node-side JS: reference bootstrap + selfcheck
├── samples/        # Sample app (minimal-app = reference impl + device probe)
├── tools/          # build-bridge · elf-inspect · probe (device forensics)
├── specs/          # Specifications (NNN-<name>)
├── docs/           # Engineering plan + publish analysis
└── AppScope/ hvigorfile.ts build-profile.json5 oh-package.json5
```

## Building

```bash
export DEVECO_SDK_HOME='D:\oh-workspace\command-line-tools\sdk'
export PATH="/d/oh-workspace/DevEco Studio/tools/node:$PATH"

# Build the release HAR
cmd //c "D:\oh-workspace\command-line-tools\bin\hvigorw.bat --mode module -p module=library@default -p buildMode=release assembleHar --no-daemon"
```

No signing material is committed. The build produces an unsigned package by
default; configure signing in DevEco and fill in `signing.debug.local.json`
(gitignored) if needed.

## Publishing to ohpm

```bash
ohpm config set publish_registry https://ohpm.openharmony.cn/ohpm
ohpm config set publish_id <publisher-id>
ohpm config set key_path <private-key>
ohpm publish library/build/default/outputs/default/library.har
```

> Run this in an **interactive terminal** (ohpm prompts for the key passphrase).
> A non-TTY environment hangs and OOMs.

## Known limitations (measured on real devices, not inferred)

| Limitation | Impact |
|------------|--------|
| `node::Start` can be called **once per process** | A crash is terminal; you cannot restart Node inside the app (only restart the app) |
| JIT requires the ACL; `--jitless` disables WASM | Without the ACL, Next's SWC / undici's llhttp WASM must be reworked |
| `process.cwd()=/`, `execPath=/system/bin/appspawn`, `os.cpus()` length 0 | Always use absolute paths; don't rely on these for version/concurrency probes |
| The working `dlopen` path is `libs/arm64/` (not `libs/arm64-v8a/`) | Handled inside the bootstrap; consumers don't notice |

## License

This repository is **MIT** licensed ([`LICENSE`](LICENSE)). It does not contain
the Node.js binary. The Node.js runtime shipped by
[ohos-node-runtime](https://github.com/fellow99/ohos-node-runtime) is covered by
its own upstream license (the original Node.js `LICENSE` is included in that
package).
