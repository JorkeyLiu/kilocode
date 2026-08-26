---
"@kilocode/cli": patch
---

Remove obsolete preset-Kilo presence invalidation after auth changes. The preset `invalidatePresence` helper and its three `providerID === "kilo"` caller branches are deleted from the auth lifecycle and control/provider handlers. Generic provider-auth lifecycle (model-cache invalidation, rollback/fence, disabled-provider cleanup) and the `KiloViewers` presence service/layer remain unchanged with no endpoint, SDK, or transport change.
