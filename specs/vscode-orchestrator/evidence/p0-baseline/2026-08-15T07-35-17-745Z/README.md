# P0 Target-Surface Performance Campaign — real-completed run

**Directory:** `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-15T07-35-17-745Z/`
**Run:** `KILO_P0_PERF=1 bun run test:e2e:real-completed` (packages/kilo-vscode), one attempt.
**Result:** PASS — exit 0, `E2E_RUN_EXIT=0`, total elapsed 147s.
**Purpose:** P2 target-surface performance campaign re-run after implicit-model isolation was fixed.
**Status:** CLEAN — zero gateway/preset generation attempts (LOCK-006); all 17 `service=llm`
records are `e2e-local/e2e-model`, including the implicit title call (small=true, agent=title).

## Provenance

- Git SHA: `f91d22ae1fa7ae5acdcf48b92d07a9b3965f4b3d` (dirty working tree — 16 modified + 15 untracked at run start)
- Branch: `jorkey/refactor/vscode-agent-orchestrator`
- Platform: macOS 15.7.3 arm64; VS Code 1.133.0 (cached `.vscode-test/vscode-darwin-arm64-1.133.0`)
- Probe: `e2e-probe-b44fe52c`, CDP port 49588, scratch `/var/folders/.../T/kilo-e2e-8ANOTU` (deleted by harness after run — exact-PID cleanup, port released, scratch removed)
- Scripted model port 49589 (run-owned)
- Runner service budget: `REAL_COMPLETED_SERVICE_BUDGET` 5,400,000 ms; probe watchdog 6,000,000 ms
- Capture: full stdout/stderr of the launcher teed to `real-completed-capture.log` (613,603 bytes, 3004 lines)

## Evidence capture note (important)

The harness deletes its scratch dir inside `verifyCleanup` before the probe process exits. This
package's run-owned evidence was copied out of scratch **during** the run by a watcher process
with stable-size copy logic, plus a final burst on `[probe] VS Code exited`. Three artifacts
written in the final ~1s window (`real-completed-dom-evidence`, `llm-matrix-real-completed-final.json`,
`llm-requests-real-completed.json`) were not physically captured; two are reconstructed verbatim
from log/store content and one is reconstructed to maximum fidelity:

| Artifact | Status |
|---|---|
| `real-completed-capture.log` | Physical capture (full launcher + probe + backend stderr output) |
| `plan.json` | Physical capture |
| `rc-snap-1.json` .. `rc-snap-34.json` | Physical capture (34/34 backend snapshots, all parse, all carry sessions+messages) |
| `llm-requests.jsonl` | Physical capture (raw run-owned collector store, 17 records) |
| `llm-matrix-real-completed-post-h7.json` | Physical capture (14/14 run-owned at H-7 boundary) |
| `llm-matrix-real-completed-final.log-extract.json` | Derived verbatim from the log's `PASS real-completed-final` matrix print (identical JSON the harness wrote to the lost scratch file) |
| `llm-requests-real-completed.json` | Reconstructed verbatim from `llm-requests.jsonl` (same collector store the runner copies; identical records) |
| `pin-evidence.log-extract.json` | Derived from the log's `[probe] PIN EVIDENCE:` block (8/8 pins pass) |
| `real-completed-dom-evidence.reconstructed.json` | Reconstructed from log + preserved scratch copies; missing original-only fields marked `<not preserved>` |
| `seed-kilo.json` | Physical capture (run-owned workspace `.kilo/kilo.json` — pins small_model/subagent_model to e2e-local/e2e-model) |
| `workspace-ask.txt`, `workspace-e2e-custom-called.txt`, `workspace-rollback.txt`, `mcp-calls.log` | Physical captures (H-6/H-3/H-12/H-5 artifacts) |
| `metrics-summary.json` | Derived from the capture log's P0 perf records (descriptive only, R7) |
| `p0-perf-records.json` | Derived full record dump (1,516 extension/webview records) |

Not captured (harness-deleted in the final window; not reconstructible): the harness-side
`model.requests` list (scripted-model HTTP request bodies) and the final `finalTopics`/`finalTabs`
DOM arrays. These are supplementary to the request-level isolation and functional evidence.

## Request matrix (LOCK-006: zero gateway/preset attempts)

- Total `service=llm` generation requests observed: **17**
- Run-owned (`e2e-local/e2e-model`): **17** (100%)
- Violations (any non-run-owned provider/model): **0**
- `kilo/kilo-auto/*`, gateway, or preset attempts: **0** (grep over full capture log)
- Classes: `title` small=1 (implicit title generation — the contaminated-run failure mode, now
  routed to e2e-local/e2e-model via `small_model` seed), `e2e-agent` primary=15, `general`
  subagent=1 (delegated child via `subagent_model` seed)
- Sessions: root `ses_ffba5a668ffe...` (15), subagent `ses_ffba56b8effe...` (1), title `title-ses_ffba5a668ffe...` (1)
- Checkpoints: post-h7 14/14 run-owned; final 17/17 run-owned (both fail-closed assertions passed)

## Descriptive metrics (R7: descriptive only, no thresholds; LOCK-PERF-6 runtime evidence)

Extension activation/connection (n=1 cold):
- activate.done: 26 ms from corr start; spawn.start→done: 7 ms; port.detected: 6,165 ms;
  sse.connected: 6,290 ms; dataReady.done: 12,744 ms (initial), 94,812 ms (H-7 reopen, second document)

Webview load/render/paint (n=2 — initial + H-7 reopened document; wd = ms from module load):
- load: min 215 / med 224 / max 224; mount: 255/260/260; render: 1,347/1,354/1,354; paint: 1,432/1,451/1,451

Prompt→first model event (prompt.submit → model.firstEvent, n=8 UI sends, ms):
- min 61 / med 140 / max 3,738 / mean 568.6 / p95 3,738 — the 3,738 ms outlier is the H-2
  delegation turn (includes title generation + delegated subagent round-trips before the parent
  first event); the other 7 sends are 61–159 ms against the run-owned scripted provider.

SSE handling (extension side, per event span:end):
- all events n=733: min 0 / med 0 / max 3 / p95 1 ms
- message.part.updated n=308: min 0 / med 0 / max 1 / p95 1 ms
- event counts by base type: message.updated 164, message.part.updated 308, session.updated 76,
  session.status 52, message.part.removed 38, session.diff 26, server.heartbeat 10,
  session.turn.open/close 9+9, session.created 4, etc.

Backend (service=p0-perf spans, ms): app_layer_define 2; listener 579; instance_bootstrap 908;
config_load n=3: 747/848/1099; provider_state_init n=2: 855/2,896; tool_execute n=7:
min 5 / med 616 / max 3,758 (max = task-delegation wait); permission_wait 690; question_wait 2,945.

## Missing instrumentation (explicit)

- Per-event webview render-flush duration (webview-side timestamp per part flush): not emitted by
  the current instrumentation — only extension-side SSE handling spans are recorded. Stated unavailable.
- Model HTTP duration (scripted-provider request→response on the wire): the scripted model records
  request url+body only (in-harness `model.requests`), no per-request duration; the log carries
  backend `service=llm` start records and `processor_entry`/`model.firstEvent` wall times only.
  Stated unavailable. LOCK-PERF-7: transport/event overhead (SSE handling ≤3 ms) is measured
  separately from model/tool/user-approval costs (tool_execute up to 3,758 ms; permission_wait
  690 ms; question_wait 2,945 ms) — localhost transport is NOT the dominant latency here.

## Functional / pin / cleanup results

- Exit code 0; `[probe] real-completed lifecycle passed`; `[probe] total elapsed: 147s`.
- H-2 delegation: PASS (backend child + completed task result in parent, panel text + child-open button).
- H-3 user tool: PASS (real ToolRegistry tool, artifact `e2e-custom-called.txt` = "echo:hello").
- H-4 skill: PASS (real Skill.Service + content marker).
- H-5 MCP: PASS (run-owned stdio server connect + e2e_echo call + server-side log + exact-PID cleanup: child pid 36404 exited after disconnect; snapshot shows server disabled).
- H-6 permission/question: PASS (pending permission observable, inline dock visible→gone, reply drains; same for question; permission_wait 690 ms, question_wait 2,945 ms).
- H-7 parentID/children persist after panel close/reopen: PASS (reopened panel renders parent "E2E Title" with child row).
- H-12 rollback: PASS (write tool → tracked file edited → Revert-to-here restores exact bytes → RevertBanner + file listing → Redo All restores edited bytes → banner gone → reverted turns re-shown).
- All 8 UI-send pins PASS: every submitted user message pinned to e2e-local/e2e-model/low + e2e-agent (pin-evidence.log-extract.json).
- Cleanup: no owned VS Code process remains; CDP port 49588 released; scratch dir removed; hang/scripted listeners closed.
