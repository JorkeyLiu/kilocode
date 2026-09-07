# VS Code Orchestrator — Direction

Authority: user-approved target semantics. Active ADRs record hard-to-reverse
decisions; canonical architecture docs record what is implemented today;
`current-state.md` records only the present capability, gap, unknown, and open
decision that changes the next judgment. Running code and observed behavior
outrank status prose.

## Target

The VS Code extension is an orchestrator for many concurrent coding sessions.
One window is a control room: sessions run side by side, work continues in the
background, and every session stays a full agent with its complete harness.

- Agent Manager is the sole chat and control surface. It may live in a sidebar
  or an editor group; the host does not change what it is.
- Grouping of sessions by conversation thread is deterministic derived
  navigation. Each root session defines one Topic: the root session ID is the
  stable Topic identity, the root title is the label, and descendants belong
  through parentID. Topic activity is the maximum member updatedAt, ordered
  descending with a deterministic ID tie-break. Orphan, missing-parent, and
  cycle components each degrade to independent Topics. There is no independent
  Topic persistence, API, config, schema, or operational fact; selection and
  expansion are presentation state only.
- Every session keeps complete agent capability: custom agents, delegated
  sub-tasks, extensible tools, skills, MCP, permissions and questions,
  parent-child relations, background and parallel execution, persistence,
  lifecycle correctness, checkpoint rollback, and an invisible internal
  safeguard that keeps long runs functional.
- At the target, one private headless runtime owned by the extension is the
  single owner of operational fact and session storage. It lives outside the
  extension host for crash, resource, and lifecycle isolation.
- The extension and its webview are a derived projection of that runtime. They
  render what the runtime reports and never invent competing facts.
- Configuration is file-authoritative and reads the same both ways: the UI
  edits the same canonical files a person would edit, and external file edits
  reconcile visibly into the UI. Each generation runs on the immutable
  versioned snapshot it started with; later updates never disturb active work.
- Permissions are runtime-decided: the private runtime is the sole authority
  for the effective decision; the extension and webview never grant, widen,
  or override it. Composition is restrictive across global, project, agent,
  and session layers: any applicable denial or hard-safety ceiling holds and
  cannot be overridden by a more permissive layer, a confirmation requirement
  beats a plain grant, and a grant holds only when every applicable layer
  permits. Within one document, match order settles only that document's
  reading and never becomes cross-layer last-writer-wins. A child session
  inherits enclosing denials and restrictions but never inherits a parent
  grant or approval. An approval binds exactly the current session, agent,
  permission, and pattern with a bounded lifetime and does not persist across
  sessions by default. Free-form inquiry and the question tool carry separate
  permission identities. Where no rule applies the decision defaults to
  asking. Every effective decision carries provenance sufficient to explain
  which layers and entries produced it. Current project scope is supplied
  by the first workspace root `<workspaceRoot>/.kilo/`; with no folder open
  there is no project layer.
- Observation converges from runtime truth across panel close/reopen,
  targeted reload, session switch, transport reconnect, and worker restart:
  after any of these boundaries the projection settles onto what the runtime
  reports, without loss, duplication, or stale authority. Runtime occurrence
  time and transport receipt time are distinct facts; projection never
  presents receipt time as fact time. Clients re-observe only: an
  already-accepted semantic operation is never replayed or re-dispatched to
  recover state. A bounded changefeed assists convergence only; it is not the
  history reconstruction authority. A projection never becomes the
  operational fact owner across lifecycles.
- Failure, outcome, and recovery are runtime-owned. Exactly one runtime
  normalization boundary converts provider, session, tool, permission, worker,
  and transport errors into failure records; classification never schedules
  recovery by itself. Every accepted generation-path operation has a
  runtime-owned identity and its outcome is a runtime fact never invented or
  revised by the extension or webview. Each field is tiered as durable,
  diagnostic, or panel-visible so persistence, diagnostics, and projection keep
  only what they need. The runtime redacts secrets and bounded detail before
  anything is persisted or projected, and the panel renders only through a
  versioned redacted projection. Recovery carries an explicit owner and scope,
  consumed budget and termination, next-at occurrence time distinct from the
  failure time, provenance, and replay-safety inputs. Nested low-level retries
  stay visible to and consume the owning operation's budget and provenance and
  never loop outside it. A worker crash converges every accepted in-flight
  operation to a recorded disposition with resource cleanup, no orphaned
  ownership, and no silent replay.
- Selection UI and runtime readiness are decoupled. Choosing a provider, model,
  or agent never waits on worker startup; only the action that truly needs the
  runtime waits, with its own explicit state and reason.
- Nothing outside the approved target above carries a default compatibility
  promise. Legacy behavior is handled when implementation reaches it.
- Performance is a target-level objective, not a numeric gate. Structural
  simplification must truly remove the removed surface from startup and runtime
  participation; no performance claim is accepted without runtime evidence. No
  transport is presumed to be the dominant generation latency, and no numeric
  latency threshold decides acceptance.

Exact protocols, table shapes, file layouts, numeric thresholds, and migration
steps stay open until reality forces them. This document fixes the meaning of
the target, not its implementation detail.
