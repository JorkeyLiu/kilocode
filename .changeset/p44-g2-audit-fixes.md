---
"@kilocode/cli": patch
"kilo-code": patch
---

Remove built-in provider/model preset catalog and models.dev fallback (3 MB snapshot, disk cache/network refresh, build embedding, ModelsDev service); providers are now explicit-config-only via `provider.<id>` records with generic `BUNDLED_PROVIDERS` adapters and `KILO_MODEL_SCHEMA_EXTENSIONS` helpers retained; custom-provider discovery, auth and generic streaming remain; harden GitHub workflow generation against injection (max128 workflow-only, shared `isProviderID` syntax) and correct P4.4-G2 evidence/docs
