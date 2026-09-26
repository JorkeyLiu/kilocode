---
"@kilocode/cli": patch
"@opencode-ai/core": patch
---

Retry less when the provider is flaky: retries for one response now share a single per-response budget (2 by default, or `KILO_SESSION_RETRY_LIMIT` when set) and stop with the last error instead of retrying without bound. Accepted chats atomically persist only the shared retry count plus the last retry layer and the last scheduled retry time in one durable charge; a failed charge persists nothing and starts no new network request. Terminal close/crash clears the pending retry time while keeping the count, and the panel retry time stays empty. Chats without an accepted prompt keep the existing bounded in-memory behavior, and a generation whose saved state is missing or closed starts no new network request.
