import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const runner = readFileSync(join(import.meta.dirname, "../e2e/runner.ts"), "utf8")
const bench = readFileSync(join(import.meta.dirname, "../e2e/p0-bench-runner.ts"), "utf8")
const probe = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
const dom = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-dom.ts"), "utf8")

function slice(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a < 0) throw new Error(`anchor missing: ${start}`)
  const b = src.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`end anchor missing: ${end}`)
  return src.slice(a, b)
}

describe("fixture session-id contract (ses*)", () => {
  it("prefixes every synthetic fixture session id with ses-", () => {
    for (const id of [
      "sourceId: `ses-${fixtureId}-A`",
      "siblingId: `ses-${fixtureId}-B`",
      "childId: `ses-${fixtureId}-C`",
      "variantId: `ses-${fixtureId}-D`",
      "tabAId: `ses-${fixtureId}-TA`",
      "tabBId: `ses-${fixtureId}-TB`",
      "tabCId: `ses-${fixtureId}-TC`",
      "topicRootId: `ses-${fixtureId}-T1`",
      "topicChildId: `ses-${fixtureId}-T1C`",
      "topicSiblingId: `ses-${fixtureId}-T2`",
    ]) {
      expect(runner).toContain(id)
    }
  })

  it("keeps no bare fixture-prefixed session id template", () => {
    for (const id of [
      "sourceId: `${fixtureId}-A`",
      "siblingId: `${fixtureId}-B`",
      "childId: `${fixtureId}-C`",
      "variantId: `${fixtureId}-D`",
      "tabAId: `${fixtureId}-TA`",
      "topicRootId: `${fixtureId}-T1`",
    ]) {
      expect(runner).not.toContain(id)
    }
  })

  it("keeps the run marker id distinct from session ids", () => {
    expect(runner).toContain("KILO_E2E_FIXTURE_ID")
    expect(runner).toContain("e2e-probe-")
    expect(bench).toContain("ses-${fixtureId}-SW")
    expect(bench).not.toContain("id: `${fixtureId}-SW")
  })
})

describe("fixture seeding order (settle-first -> synthetic batch -> final preserve -> barrier)", () => {
  it("tab-close helper settles first, then synthetic batch, then final preserve before barrier", () => {
    const fn = slice(runner, "async function seedTabCloseFixtures", "async function seedChildFixtures")
    const settle = fn.indexOf("CMD_SETTLE")
    const firstLoaded = fn.indexOf('type: "sessionsLoaded"')
    const added = fn.indexOf('type: "agentManager.sessionAdded"')
    const created = fn.indexOf('type: "sessionCreated"')
    const barrier = fn.indexOf("awaitSeedBarrier")
    const finalPreserve = fn.lastIndexOf('type: "sessionsLoaded"')
    expect(settle).toBeGreaterThan(-1)
    expect(firstLoaded).toBeGreaterThan(settle)
    expect(added).toBeGreaterThan(settle)
    expect(created).toBeGreaterThan(settle)
    // First synthetic post follows the drain: the settle's explicit real
    // empty refresh cannot prune just-opened synthetic tabs.
    expect(firstLoaded).toBeLessThan(added)
    expect(added).toBeLessThan(finalPreserve)
    expect(created).toBeLessThan(finalPreserve)
    expect(finalPreserve).toBeGreaterThan(firstLoaded)
    expect(barrier).toBeGreaterThan(finalPreserve)
    expect(fn.slice(finalPreserve)).toContain("awaitSeedBarrier")
    // No settle after the first synthetic post and none after the final
    // preserve; no replayed sessionCreated after the final preserve.
    expect(fn.slice(firstLoaded)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain('type: "sessionCreated"')
    // Barrier is last: no fire-and-forget post follows it.
    expect(fn.slice(barrier)).not.toContain("await post(")
    expect(fn).toContain("preserveSessionIds: [plan.tabAId, plan.tabBId, plan.tabCId]")
    // Tab order [TA, TB, TC] with TA active is preserved.
    expect(fn.indexOf("plan.tabAId")).toBeLessThan(fn.indexOf("plan.tabBId"))
    expect(fn.indexOf("plan.tabBId")).toBeLessThan(fn.indexOf("plan.tabCId"))
  })

  it("child helper settles first, then synthetic batch, then final preserve before barrier", () => {
    const fn = slice(runner, "async function seedChildFixtures", "async function seedVariantFixtures")
    const settle = fn.indexOf("CMD_SETTLE")
    const firstLoaded = fn.indexOf('type: "sessionsLoaded"')
    const added = fn.indexOf('type: "agentManager.sessionAdded"')
    const created = fn.indexOf('type: "sessionCreated"')
    const transcript = fn.indexOf('type: "messagesLoaded"')
    const barrier = fn.indexOf("awaitSeedBarrier")
    const finalPreserve = fn.lastIndexOf('type: "sessionsLoaded"')
    expect(settle).toBeGreaterThan(-1)
    expect(firstLoaded).toBeGreaterThan(settle)
    expect(added).toBeGreaterThan(settle)
    expect(created).toBeGreaterThan(settle)
    expect(transcript).toBeGreaterThan(settle)
    expect(added).toBeLessThan(finalPreserve)
    expect(created).toBeLessThan(finalPreserve)
    expect(transcript).toBeLessThan(finalPreserve)
    expect(finalPreserve).toBeGreaterThan(firstLoaded)
    expect(barrier).toBeGreaterThan(finalPreserve)
    expect(fn.slice(finalPreserve)).toContain("awaitSeedBarrier")
    expect(fn.slice(firstLoaded)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain('type: "sessionCreated"')
    expect(fn.slice(barrier)).not.toContain("await post(")
    expect(fn).toContain("preserveSessionIds: [plan.sourceId, plan.siblingId, plan.childId]")
    // Catalog-only child semantics: C is in the catalog but never opened.
    expect(fn).not.toContain("sessionId: plan.childId")
  })

  it("run dispatches tab-close and child through the phase-boundary helpers", () => {
    expect(runner).toContain("await seedTabCloseFixtures(vscode, plan, iso, fixtureId)")
    expect(runner).toContain("await seedChildFixtures(vscode, plan, iso, fixtureId)")
    expect(runner).toContain("await seedVariantFixtures(vscode, plan, iso, runChild, scratch, fixtureId)")
  })

  it("topic helper settles first and ends with final preserve plus active tab select before barrier", () => {
    const fn = slice(runner, "async function seedTopicFixtures", "async function seedTabCloseFixtures")
    const settle = fn.indexOf("CMD_SETTLE")
    const firstLoaded = fn.indexOf('type: "sessionsLoaded"')
    const added = fn.indexOf('type: "agentManager.sessionAdded"')
    const created = fn.indexOf('type: "sessionCreated"')
    const barrier = fn.indexOf("awaitSeedBarrier")
    const finalPreserve = fn.lastIndexOf('type: "sessionsLoaded"')
    expect(settle).toBeGreaterThan(-1)
    expect(firstLoaded).toBeGreaterThan(settle)
    expect(added).toBeGreaterThan(settle)
    expect(created).toBeGreaterThan(settle)
    expect(added).toBeLessThan(finalPreserve)
    expect(finalPreserve).toBeGreaterThan(firstLoaded)
    expect(barrier).toBeGreaterThan(finalPreserve)
    expect(fn.slice(firstLoaded)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain('type: "sessionCreated"')
    expect(fn.slice(barrier)).not.toContain("await post(")
    expect(fn).toContain("sessionId: activeId")
    // Parent/child catalog facts are preserved.
    expect(fn).toContain("plan.topicRootId")
    expect(fn).toContain("plan.topicChildId")
  })

  it("worktree root-local helper settles first and ends with final preserve plus active tab select", () => {
    const fn = slice(runner, "async function seedRootLocalSessions", "async function assertWorktreeRemoval")
    const settle = fn.indexOf("CMD_SETTLE")
    const firstLoaded = fn.indexOf('type: "sessionsLoaded"')
    const added = fn.indexOf('type: "agentManager.sessionAdded"')
    const created = fn.indexOf('type: "sessionCreated"')
    const barrier = fn.indexOf("awaitSeedBarrier")
    const finalPreserve = fn.lastIndexOf('type: "sessionsLoaded"')
    expect(settle).toBeGreaterThan(-1)
    expect(firstLoaded).toBeGreaterThan(settle)
    expect(added).toBeGreaterThan(settle)
    expect(created).toBeGreaterThan(settle)
    expect(added).toBeLessThan(finalPreserve)
    expect(created).toBeLessThan(finalPreserve)
    expect(finalPreserve).toBeGreaterThan(firstLoaded)
    expect(barrier).toBeGreaterThan(finalPreserve)
    expect(fn.slice(firstLoaded)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain('type: "sessionCreated"')
    expect(fn.slice(barrier)).not.toContain("await post(")
  })

  it("variant provisions after settle and before synthetic seed, then final preserve before barrier", () => {
    const fn = slice(runner, "async function seedVariantFixtures", "interface ScenarioFlags")
    const settle = fn.indexOf("CMD_SETTLE")
    const created = fn.indexOf('type: "sessionCreated"')
    const provision = fn.indexOf("CMD_PROVISION")
    const firstLoaded = fn.indexOf('type: "sessionsLoaded"')
    const barrier = fn.indexOf("awaitSeedBarrier")
    const finalPreserve = fn.lastIndexOf('type: "sessionsLoaded"')
    expect(settle).toBeGreaterThan(-1)
    expect(provision).toBeGreaterThan(-1)
    expect(created).toBeGreaterThan(-1)
    // Settle FIRST, provisioning after settle and before any synthetic seed.
    expect(settle).toBeLessThan(provision)
    expect(provision).toBeLessThan(created)
    expect(provision).toBeLessThan(firstLoaded)
    expect(created).toBeLessThan(finalPreserve)
    expect(finalPreserve).toBeGreaterThan(provision)
    expect(barrier).toBeGreaterThan(finalPreserve)
    expect(fn.slice(finalPreserve)).toContain("awaitSeedBarrier")
    // No settle/provision after the first synthetic post and none after the
    // final preserve; no replayed sessionCreated after the final preserve.
    expect(fn.slice(created)).not.toContain("CMD_SETTLE")
    expect(fn.slice(created)).not.toContain("CMD_PROVISION")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_SETTLE")
    expect(fn.slice(finalPreserve)).not.toContain("CMD_PROVISION")
    expect(fn.slice(finalPreserve)).not.toContain('type: "sessionCreated"')
    expect(fn.slice(barrier)).not.toContain("await post(")
  })

  it("p0 session-switch settles first with ses ids and no trailing re-seed", () => {
    const block = slice(bench, 'scenario === "session-switch"', 'scenario === "warm-view"')
    const settle = block.indexOf("settleSessions")
    const catalog = block.indexOf('type: "sessionsLoaded"')
    const created = block.indexOf('type: "sessionCreated"')
    expect(settle).toBeGreaterThan(-1)
    expect(catalog).toBeGreaterThan(settle)
    expect(created).toBeGreaterThan(catalog)
    expect(block.slice(created)).not.toContain('type: "sessionsLoaded"')
  })
})

describe("child-ready inter-scenario phase gate (deterministic, no sleeps)", () => {
  it("defines child-ready distinct from child-phase1/2 and ready markers", () => {
    expect(runner).toContain('const CHILD_READY_MARKER = "child-ready"')
    expect(dom).toContain('export const CHILD_READY_MARKER = "child-ready"')
    expect(dom).toContain("export function needsChildReadyGate(scenarios: Set<string>): boolean")
    // The probe consumes the shared helper (no local redefinition).
    expect(probe).toContain("CHILD_READY_MARKER,")
    expect(probe).toContain("needsChildReadyGate,")
    // Distinctness: the gate literal never collides with coordination markers.
    for (const other of ["child-phase1-done", "child-phase2-ready", "child-phase2-done", "ready"]) {
      expect("child-ready").not.toBe(other)
    }
    expect(runner).not.toContain('CHILD_READY_MARKER = "child-phase')
    expect(runner).not.toContain('CHILD_READY_MARKER = "ready"')
    expect(dom).not.toContain('CHILD_READY_MARKER = "child-phase')
    expect(dom).not.toContain('CHILD_READY_MARKER = "ready"')
  })

  it("runner writes child-ready with fixture ID after the full child seed, before phase1 wait", () => {
    const block = slice(runner, "if (runChild) {", "if (runVariant) {")
    const seed = block.indexOf("await seedChildFixtures(vscode, plan, iso, fixtureId)")
    const gate = block.indexOf("writeFileSync(join(scratch, CHILD_READY_MARKER), fixtureId)")
    const phase1 = block.indexOf('join(scratch, "child-phase1-done")')
    expect(seed).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(seed)
    expect(phase1).toBeGreaterThan(gate)
    // Content-sensitive: the gate carries the fixture ID (not harness "ok").
    expect(block).toContain("writeFileSync(join(scratch, CHILD_READY_MARKER), fixtureId)")
    // The seed helper itself keeps its final preserve re-seed (gate is additive).
    const helper = slice(runner, "async function seedChildFixtures", "async function seedVariantFixtures")
    expect(helper).toContain("preserveSessionIds: [plan.sourceId, plan.siblingId, plan.childId]")
    expect(helper).not.toContain("CHILD_READY_MARKER")
  })

  it("harness gates the composed child finder on child-ready, not on ready", () => {
    expect(dom).toContain("export function needsChildReadyGate(scenarios: Set<string>): boolean")
    const dispatch = slice(probe, 'if (scenarios.has("child-task-order")) {', "child-task tab-order assertion passed")
    const gate = dispatch.indexOf("needsChildReadyGate(scenarios)")
    const wait = dispatch.indexOf("CHILD_READY_MARKER")
    const finder = dispatch.indexOf("await assertChildTaskOrder(")
    expect(gate).toBeGreaterThan(-1)
    expect(wait).toBeGreaterThan(gate)
    expect(finder).toBeGreaterThan(wait)
    // Content-sensitive: the wait names the child-ready marker with its label,
    // never a bare existence check on the overwritten `ready` gate.
    expect(dispatch).toContain('"child-ready marker"')
    expect(dispatch).not.toContain('join(scratch, "ready")')
  })
})

describe("fixture barrier per-seed delivery gate (barrier before markers)", () => {
  it("runner defines the gated barrier command and fresh deterministic tokens", () => {
    expect(runner).toContain('const CMD_BARRIER = "kilo-code.new.e2eFixture.agentManagerBarrier"')
    expect(runner).toContain("async function awaitSeedBarrier(")
    // Fresh deterministic token per seed batch: fixture ID + label + sequence.
    expect(runner).toContain("barrier-${fixtureId}-${label}-${barrierSeq}")
    expect(runner).toContain("await vscodeApi.commands.executeCommand(CMD_BARRIER, token, 15_000)")
    // Explicit fast failure surfaces the batch label.
    expect(runner).toContain("fixture barrier failed after ${label}")
  })

  it("tab-close helper barriers after the final seed and before the ready marker", () => {
    const fn = slice(runner, "async function seedTabCloseFixtures", "async function seedChildFixtures")
    const barrier = fn.indexOf("awaitSeedBarrier")
    expect(barrier).toBeGreaterThan(-1)
    // No barrier between messages within the batch: the barrier follows every
    // fire-and-forget post, including the final preserve re-seed.
    for (const needle of ['type: "sessionsLoaded"', 'type: "sessionCreated"', 'type: "agentManager.sessionAdded"']) {
      expect(fn.indexOf(needle)).toBeLessThan(barrier)
    }
    const tail = fn.slice(barrier)
    expect(tail).not.toContain("await post(")
    expect(tail).toContain('"tab-close"')
    // The caller writes `ready` only after the helper (which awaits the ack).
    const runBody = runner.slice(runner.indexOf("export async function run()"))
    const seed = runBody.indexOf("await seedTabCloseFixtures(vscode, plan, iso, fixtureId)")
    const ready = runBody.indexOf('writeFileSync(join(scratch, "ready"), fixtureId)')
    expect(seed).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(seed)
  })

  it("child helper barriers after the final seed and child-ready follows the ack", () => {
    const fn = slice(runner, "async function seedChildFixtures", "async function seedVariantFixtures")
    const barrier = fn.indexOf("awaitSeedBarrier")
    expect(barrier).toBeGreaterThan(-1)
    for (const needle of ['type: "sessionsLoaded"', 'type: "sessionCreated"', 'type: "agentManager.sessionAdded"']) {
      expect(fn.indexOf(needle)).toBeLessThan(barrier)
    }
    const tail = fn.slice(barrier)
    expect(tail).not.toContain("await post(")
    expect(tail).toContain('"child"')
    // child-ready is written only after the helper (barrier ack) resolves,
    // before the phase1 wait.
    const block = slice(runner, "if (runChild) {", "if (runVariant) {")
    const seed = block.indexOf("await seedChildFixtures(vscode, plan, iso, fixtureId)")
    const gate = block.indexOf("writeFileSync(join(scratch, CHILD_READY_MARKER), fixtureId)")
    const phase1 = block.indexOf('join(scratch, "child-phase1-done")')
    expect(seed).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(seed)
    expect(phase1).toBeGreaterThan(gate)
    // The single-post phase-2 batch barriers before its marker too.
    const phase2post = block.indexOf('type: "agentManager.sessionAdded"')
    const phase2barrier = block.indexOf('"child-phase2"')
    const phase2ready = block.indexOf('writeFileSync(join(scratch, "child-phase2-ready"), fixtureId)')
    expect(phase2post).toBeGreaterThan(-1)
    expect(phase2barrier).toBeGreaterThan(phase2post)
    expect(phase2ready).toBeGreaterThan(phase2barrier)
  })

  it("variant helper barriers before variant-ready and the conditional ready", () => {
    const fn = slice(runner, "async function seedVariantFixtures", "interface ScenarioFlags")
    const barrier = fn.indexOf("awaitSeedBarrier")
    const variant = fn.indexOf('writeFileSync(join(scratch, "variant-ready"), fid)')
    const ready = fn.indexOf('writeFileSync(join(scratch, "ready"), fid)')
    expect(barrier).toBeGreaterThan(-1)
    expect(variant).toBeGreaterThan(barrier)
    expect(ready).toBeGreaterThan(barrier)
    expect(fn.slice(barrier)).toContain('"variant"')
  })

  it("topic and root-local helpers barrier after their final seed", () => {
    const topic = slice(runner, "async function seedTopicFixtures", "async function seedTabCloseFixtures")
    const topicBarrier = topic.indexOf("awaitSeedBarrier")
    expect(topicBarrier).toBeGreaterThan(-1)
    expect(topic.slice(topicBarrier)).not.toContain("await post(")
    expect(topic.slice(topicBarrier)).toContain('"topic"')
    const root = slice(runner, "async function seedRootLocalSessions", "async function assertWorktreeRemoval")
    const rootBarrier = root.indexOf("awaitSeedBarrier")
    expect(rootBarrier).toBeGreaterThan(-1)
    expect(root.slice(rootBarrier)).not.toContain("await post(")
    expect(root.slice(rootBarrier)).toContain('"root-local"')
  })
})
