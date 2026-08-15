# Contamination Provenance Note

**Directory:** `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-15T06-25-37Z/`
**Status:** ⚠️ CONTAMINATED — retained for provenance only, **excluded from LOCK-006 (zero preset/gateway generation attempts) and target-performance acceptance.**

## What happened

This evidence directory was produced by a `KILO_P0_PERF=1` real-completed run whose
workspace config seed omitted `small_model`/`subagent_model`. During that run the
backend completed an **external gateway title generation**: the native title agent
path (`SessionPrompt.ensureTitle` → `Provider.getSmallModel`) found no
`cfg.small_model`, fell through to the kilo gateway fallback (`kilo/kilo-auto/small`),
and generated the session title as a real gateway paraphrase instead of the
scripted provider's `SCRIPTED.title`.

The external call is directly visible in `real-completed-capture.log`:

```
INFO  ... service=llm providerID=kilo modelID=kilo-auto/small session.id=title-ses_ffbe65b6affeWMAe9X7ERomdq3 small=true agent=title mode=primary stream
```

(17 `service=llm` lines total: 1 external `kilo/kilo-auto/small` title request,
the rest run-owned `e2e-local/e2e-model` agent/subagent requests.)

## Why this directory is excluded

- LOCK-006 requires **zero** preset/gateway generation attempts, including implicit
  title calls. The external `kilo/kilo-auto/small` request violates that at the
  request level — UI-message pin predicates cannot see implicit title calls.
- The directory must therefore **not** be cited as zero-external-call evidence or
  as target-performance evidence.

## What was retained

All existing files in this directory are retained **unmodified** (`plan.json`,
`rc-snap-1..40.json`, `real-completed-capture.log`). This note is additive
provenance only — nothing was deleted or renamed.

## Resolution

The four real-* scenario seeds now pin `small_model` (and real-session /
real-restart also pin `subagent_model`) to `e2e-local/e2e-model`, and every real-*
scenario asserts fail-closed, at the request level, that every backend
`service=llm` generation request used the run-owned provider. Any `kilo/kilo-auto/*`
line is an immediate scenario failure.
