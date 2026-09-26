---
"@kilocode/sdk": major
---

BREAKING: remove the retired `kilo` process-launcher surface (`createKiloServer`, `createKiloTui`, `createKilo`, the `./server` and `./v2/server` subpaths, and the `cross-spawn` dependency). The launchers spawned the retired `kilo` binary name and never ran workspace code; connect with `createKiloClient` against a running server instead.
