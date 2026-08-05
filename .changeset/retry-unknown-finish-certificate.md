---
"@kilocode/cli": patch
---

Retry provider requests that stall during startup within a bounded 60-second window instead of hanging indefinitely: the default request timeout is now one minute, and responses that send headers but never deliver a first stream chunk fail into the existing retry path after 60 seconds (configurable per provider via `firstChunkTimeout`). Also retry empty turns that end with an unknown finish reason even when the provider reports token usage, and treat provider TLS certificate verification failures carrying the exact "unknown certificate verification error" message as a retryable network disconnect. Previously these surfaced as final errors or stalled instead of retrying.

Unify disconnected-network recovery with the normal provider retry backoff: after the offline wait is answered and the request retries, the retry now runs through the same exponential backoff (2s → 4s → 8s → 16s → 30s cap), attempt counter, UI status, provider retry count, and configured retry limit as any other retryable error, instead of retrying instantly with attempt 0 and zero delay.

Narrow the offline ask/watch lifecycle to confirmed general connectivity loss: before creating an offline status and wait, Kilo now runs the existing bounded generic connectivity probe (three public endpoints, 5-second timeout, no provider credentials). Provider-scoped disconnects — unreachable provider hosts, certificate errors, and header or first-chunk timeouts — leave the general internet reachable, so they now skip the offline ask/wait and retry through the normal exponential provider backoff. True general offline states keep the full offline prompt/attention flow, MCP reconnect, and reload/activity semantics unchanged.
