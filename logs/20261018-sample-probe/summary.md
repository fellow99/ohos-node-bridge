# probe 摘要（preset=0）

- `node` = v24.2.0
- `platform` = openharmony
- `arch` = arm64
- `execArgv` = ["--jitless","--no-verify-heap"]
- `wasm.validate` = ERR:WebAssembly is not defined
- `hotloop_ms_5rounds` = 305
- `expose_internals` = ERR:Cannot find module 'internal/modules/cjs/loader'
Require stack:
- /data/storage/el2/base/haps/minimalapp/files/payload/probe.js
- `worker_threads` = true
- `fs_write_readback` = OK
- `http_server` = listening 127.0.0.1:15577
- `fetch_self` = ERR:fetch failed
- `spawn` = {"pid":65098,"events":{"data":true,"exit":true,"close":true,"error":null},"stdout":"SPAWN_OK\nuid=20020222(pci) gid=20020222(pci_a20222) groups=20020222(pci_a20222),1097(netsys_socket),3099(shader_cache) context=u:r:debug_hap:s0\n","zombie":false,"settledBy":"close"}
