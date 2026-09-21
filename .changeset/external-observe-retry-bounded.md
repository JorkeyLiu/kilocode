---
"kilo-code": patch
---

External `config/convergence/observe` hint: at most one retry after a transport/timeout failure; no delivery guarantee — only the first private FD request without a valid response due to throw/timeout is retried once with a fresh internally four-key-bound observe token over the identical descriptor batch; any successfully parsed response (cold or any pending: failed/malformed/noop/hot/unknown/scope/id mismatch) never retries.
