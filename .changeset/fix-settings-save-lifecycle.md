---
"@kilocode/cli": patch
"kilo-code": patch
---

Make settings saves acknowledge immediately after the backend transaction succeeds instead of waiting for the full config refresh, so the save indicator clears promptly even while active sessions are still generating. A save never waits for an earlier save's runtime refresh to drain either — later settings, provider, and auth saves acknowledge while the previous refresh is still converging, and the runtime converges once to the latest saved config. Each save is correlated by a unique id, so stale acknowledgements from older saves or other windows can never clear a newer draft, and edits made to the same field while a save is in flight are preserved. Background reconciliation converges every open window on the saved config without cancelling pending permission, question, suggestion, or network-wait prompts. The combined global+project config transaction serializes behind the canonical writer barrier and config file locks (deadlock-free with legacy saves), persists each scope atomically, and tags its scope events with a transaction id so clients collapse them into one revision.

Custom provider saves now use one atomic backend endpoint that persists config and auth credentials together, clearing the model cache and rebuilding instances once after active generations drain — a failed save restores the exact prior config and credentials instead of leaving partial state. A save that changes nothing still reports success, and removed models or variants are deleted durably without interrupting running sessions.
