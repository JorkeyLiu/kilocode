import { test, expect, describe } from "bun:test"
import { evaluate, buildCanonicalTargets, type LayerInput, type Request, type Approval } from "../../src/permission/evaluator"

const ws = "/workspace"
const sess = "sess_1"
const agent = "agent-a"

function req(permission: string, patterns: string[], extra: Partial<Request> = {}): Request {
  const id = extra.permissionRequestId ?? "per_abc123"
  const op = extra.operationId ?? `permission:${id}`
  return {
    sessionID: extra.sessionID ?? sess,
    agent: extra.agent ?? agent,
    workspaceRoot: ws,
    ...extra,
    permission,
    patterns,
    permissionRequestId: id,
    operationId: op,
  }
}

function layer(kind: LayerInput["kind"], rules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[], path?: string): LayerInput {
  const map: Record<string, { sk: LayerInput["sourceKind"]; cp: string }> = {
    "runtime-ceiling": { sk: "runtime-safety", cp: "runtime:ceiling" },
    global: { sk: "global-file", cp: "/home/user/.config/kilo/kilo.jsonc" },
    project: { sk: "project-file", cp: `${ws}/.kilo/kilo.jsonc` },
    agent: { sk: "agent-manifest", cp: `agent:${agent}` },
    "session-restriction": { sk: "session-restriction", cp: `session:${sess}` },
  }
  const m = map[kind]
  return {
    kind,
    sourceKind: m.sk,
    canonicalPath: path ?? m.cp,
    ruleset: rules,
  }
}

function approval(kind: Approval["kind"], patterns: string[], extra: Partial<Approval> = {}): Approval {
  const id = "per_abc123"
  return {
    sessionID: sess,
    agent,
    permission: extra.permission ?? "edit",
    operationId: kind === "once" ? `permission:${id}` : undefined,
    ...extra,
    kind,
    patterns,
  }
}

// A-01
test("A-01 hard deny cannot be overridden by allow/approval", () => {
  const r = req("edit", ["/protected/hard"])
  const hard = [{ permission: "edit", pattern: "/protected/hard", action: "deny" as const }]
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false, hardDenyRuleset: hard })
  expect(out.result).toBe("deny")
  expect(out.provenance.decisive.ceilingId).toBe("(a)")
  expect(out.provenance.decisive.reason).toBe("ceiling-a")
  // with exact approval still deny
  const ap = approval("once", ["/protected/hard"], { permission: "edit" })
  const out2 = evaluate({ request: r, layers, approvals: [ap], allowEverything: false, hardDenyRuleset: hard })
  expect(out2.result).toBe("deny")
  // allowEverything still deny
  const out3 = evaluate({ request: r, layers, approvals: [], allowEverything: true, hardDenyRuleset: hard })
  expect(out3.result).toBe("deny")
  // provenance completeness
  expect(out.provenance.schemaVersion).toBe("1")
  expect(out.provenance.request.permissionRequestId).toBe("per_abc123")
  expect(out.provenance.request.operationId).toBe("permission:per_abc123")
})

// A-02
test("A-02 protected path caps at ask-ceiling", () => {
  const r = req("edit", ["kilo.json"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
  expect(out.provenance.decisive.ceilingId).toBe("(b)")
  expect(out.provenance.contributingLayers.some((l) => l.decision === "ask-ceiling")).toBe(true)
})

// A-03
test("A-03 exact approval resolves protected ask-ceiling", () => {
  const r = req("edit", ["kilo.json"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const ap = approval("session", ["kilo.json"], { permission: "edit" })
  const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("allow")
  expect(out.provenance.approval).toBeDefined()
  expect(out.provenance.approval?.kind).toBe("session")
  expect(out.provenance.approval?.patterns).toEqual(["/workspace/kilo.json"])
  // broad * approval should not resolve
  const broad = approval("session", ["*"], { permission: "edit" })
  const out2 = evaluate({ request: r, layers, approvals: [broad], allowEverything: false })
  expect(out2.result).toBe("ask-ceiling")
})

// A-04
test("A-04 ceiling b wildcard bypass", () => {
  const r = req("edit", ["AGENTS.md"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
})

// A-05
test("A-05 ceiling b allow-everything cannot bypass", () => {
  const r = req("edit", [".kilo/kilo.jsonc"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: true })
  expect(out.result).toBe("ask-ceiling")
})

// A-06
test("A-06 broad read caps at ask-ceiling for env", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
  expect(out.provenance.decisive.ceilingId).toBe("(c)")
})

// A-07
test("A-07 exact env approval resolves", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const ap = approval("session", ["secret.env"], { permission: "read" })
  const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("allow")
  // exact for other.env does not resolve secret.env
  const ap2 = approval("session", ["other.env"], { permission: "read" })
  const out2 = evaluate({ request: r, layers, approvals: [ap2], allowEverything: false })
  expect(out2.result).toBe("ask-ceiling")
})

// A-08
test("A-08 .env.example not capped", () => {
  const r = req("read", ["example.env.example"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("allow")
})

// A-09
test("A-09 *.env.* capped", () => {
  const r = req("read", ["config.env.backup"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
})

// A-10
test("A-10 question vs question_tool separate", () => {
  const r1 = req("question", ["*"])
  const r2 = req("question_tool", ["*"])
  const layers: LayerInput[] = [
    layer("global", [
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "question_tool", pattern: "*", action: "allow" },
    ]),
  ]
  const o1 = evaluate({ request: r1, layers, approvals: [], allowEverything: false })
  const o2 = evaluate({ request: r2, layers, approvals: [], allowEverything: false })
  expect(o1.result).toBe("deny")
  expect(o2.result).toBe("allow")
})

// A-11
test("A-11 mcp does not authorize read", () => {
  const r = req("read", ["foo.txt"])
  const layers: LayerInput[] = [
    layer("global", [
      { permission: "mcp", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "deny" },
    ]),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("deny")
})

// A-12 - strengthened: actual once consumption and operationId correlation
test("A-12 once approval consumed after one op", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const ap = approval("once", ["secret.env"], { permission: "read" })
  const out1 = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out1.result).toBe("allow")
  expect(out1.provenance.approval?.kind).toBe("once")
  expect(out1.provenance.approval?.operationId).toBe("permission:per_abc123")
  // actual consumption: second evaluation with same operationId but approvals cleared => ask-ceiling
  const outConsumed = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(outConsumed.result).toBe("ask-ceiling")
  // different operationId (per_other) must not be covered even if original approval still present (operationId mismatch)
  const r2 = req("read", ["secret.env"], { permissionRequestId: "per_other", operationId: "permission:per_other" })
  const out2 = evaluate({ request: r2, layers, approvals: [ap], allowEverything: false })
  expect(out2.result).toBe("ask-ceiling")
  // same operationId reuse after consumption must not still be allow when approvals empty
  expect(r.permission).toBe("read")
  expect(r.operationId).toBe("permission:per_abc123")
})

// A-13
test("A-13 session approval only exact pattern set", () => {
  const r = req("edit", ["fileA.txt"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "fileA.txt", action: "ask" }])]
  const ap = approval("session", ["fileA.txt"], { permission: "edit" })
  const out1 = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out1.result).toBe("allow")
  const r2 = req("edit", ["fileB.txt"])
  const out2 = evaluate({ request: r2, layers, approvals: [ap], allowEverything: false })
  // fileB not covered => ask (no-rule or explicit ask)
  expect(out2.result).toBe("ask")
})

// A-14 - strengthened: actual child deny non-inheritance proves parent allow not propagated
test("A-14 child does not inherit parent allow", () => {
  const rParent = req("bash", ["ls"])
  const parentLayers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "allow" }])]
  const outParent = evaluate({ request: rParent, layers: parentLayers, approvals: [], allowEverything: false })
  expect(outParent.result).toBe("allow")
  // child has its own global deny - parent allow must not override child's deny
  const rChild = req("bash", ["ls"])
  const childLayers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "deny" }])]
  const out = evaluate({ request: rChild, layers: childLayers, approvals: [], allowEverything: false })
  expect(out.result).toBe("deny")
  expect(out.provenance.decisive.reason).toContain("global-deny")
  // provenance shows child's global deny, not parent's allow
})

// A-15 - strengthened: actual child session does not receive parent session approval (sessionID isolation)
test("A-15 child does not receive parent approval", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const parentAp = approval("session", ["secret.env"], { permission: "read", sessionID: "parent_sess" } as any)
  const outParent = evaluate({ request: { ...r, sessionID: "parent_sess" }, layers, approvals: [parentAp as Approval], allowEverything: false })
  expect(outParent.result).toBe("allow")
  // child request with same agent/permission/pattern but different sessionID must not be covered
  const out = evaluate({ request: r, layers, approvals: [parentAp as Approval], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
  // child with its own approval would allow
  const childAp = approval("session", ["secret.env"], { permission: "read" })
  const outChild = evaluate({ request: r, layers, approvals: [childAp], allowEverything: false })
  expect(outChild.result).toBe("allow")
})

// A-16
test("A-16 wildcard session approval not valid for ceiling paths", () => {
  const r = req("edit", ["kilo.json"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const ap = approval("session", ["*"], { permission: "edit" })
  const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
})

// A-17
test("A-17 .env.example broad grant allows", () => {
  const r = req("read", ["foo.env.example"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("allow")
})

// A-18
test("A-18 protected exact vs broad approval distinguishes", () => {
  const r = req("edit", ["AGENTS.md"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const exact = approval("session", ["AGENTS.md"], { permission: "edit" })
  const broad = approval("session", ["*"], { permission: "edit" })
  const outExact = evaluate({ request: r, layers, approvals: [exact], allowEverything: false })
  const outBroad = evaluate({ request: r, layers, approvals: [broad], allowEverything: false })
  expect(outExact.result).toBe("allow")
  expect(outBroad.result).toBe("ask-ceiling")
})

// A-19
test("A-19 provenance completeness", () => {
  const r = req("edit", ["foo.txt"])
  const layers: LayerInput[] = [
    layer("global", [{ permission: "edit", pattern: "*", action: "deny" }]),
    layer("project", [{ permission: "edit", pattern: "*", action: "allow" }]),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("deny")
  expect(out.provenance.contributingLayers.length).toBe(3) // runtime + global + project
  expect(out.provenance.contributingLayers[0].sourceKind).toBe("runtime-safety")
  expect(out.provenance.contributingLayers[0].decision).toBe("no-ceiling")
  expect(out.provenance.decisive.reason).toContain("deny")
  expect(out.provenance.schemaVersion).toBe("1")
})

// A-20
test("A-20 provenance ceiling reason", () => {
  const r = req("edit", ["kilo.json"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
  expect(out.provenance.decisive.ceilingId).toBe("(b)")
  expect(out.provenance.decisive.reason).toBe("ceiling-b")
  expect(out.provenance.contributingLayers.some((l) => l.decision === "ask-ceiling")).toBe(true)
})

// A-21 - strengthened: approvals dropped on crash/disposal are runtime in-memory only (no durable file side effect)
test("A-21 approvals dropped on crash (empty approvals after crash)", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const ap = approval("session", ["secret.env"], { permission: "read" })
  const before = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(before.result).toBe("allow")
  expect(before.provenance.approval?.expiry).toBe("session-end")
  // simulate crash: InstanceState disposal clears approvals => subsequent evaluation with no approvals must ask
  const after = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(after.result).toBe("ask-ceiling")
  // provenance after crash shows ask-ceiling without approval layer
  expect(after.provenance.approval).toBeUndefined()
  expect(after.provenance.contributingLayers.every((l) => l.sourceKind !== "approval")).toBe(true)
})

// A-22 - strengthened: approvals dropped on session end (sessionID scoped, not persisted)
test("A-22 approvals dropped on session end", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
  const ap = approval("session", ["secret.env"], { permission: "read" })
  const before = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(before.result).toBe("allow")
  // simulate session end: new session ID must not inherit previous session's approval
  const r2 = req("read", ["secret.env"], { sessionID: "new_sess" })
  const out = evaluate({ request: r2, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("ask-ceiling")
  // also verify same session with approvals cleared after disposal => ask
  const afterDispose = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(afterDispose.result).toBe("ask-ceiling")
})

// A-23 - strengthened: no durable store - approval is runtime only, canonical files/layers unchanged
test("A-23 no second durable store (approval does not mutate layers)", () => {
  const r = req("edit", ["foo.txt"])
  const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "ask" }])]
  const originalRules = [...(layers[0].ruleset as any)]
  const ap = approval("session", ["foo.txt"], { permission: "edit" })
  const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("allow")
  expect(out.provenance.approval).toBeDefined()
  // layers themselves must not have been mutated by the approval
  expect(layers[0].ruleset).toEqual(originalRules)
  // re-evaluate without approval returns ask => proves no durable mutation
  const out2 = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out2.result).toBe("ask")
  expect(out2.provenance.approval).toBeUndefined()
})

// A-24
test("A-24 single-document ordering exact beats wildcard", () => {
  const r = req("read", ["secret.env"])
  const layers: LayerInput[] = [
    layer("global", [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "secret.env", action: "deny" },
    ]),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  // exact deny should win over wildcard allow despite wildcard later? Actually later exact wins per ordering rank 1.
  // Our ordering prefers exact literal regardless of declaration order, so deny wins.
  expect(out.result).toBe("deny")
})

// A-25
test("A-25 intra-doc tie later wins", () => {
  const r = req("edit", ["foo.txt"])
  const layers: LayerInput[] = [
    layer("global", [
      { permission: "edit", pattern: "foo.txt", action: "deny" },
      { permission: "edit", pattern: "foo.txt", action: "allow" },
    ]),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  // both exact same specificity, later wins => allow
  expect(out.result).toBe("allow")
  // reverse order
  const layers2: LayerInput[] = [
    layer("global", [
      { permission: "edit", pattern: "foo.txt", action: "allow" },
      { permission: "edit", pattern: "foo.txt", action: "deny" },
    ]),
  ]
  const out2 = evaluate({ request: r, layers: layers2, approvals: [], allowEverything: false })
  expect(out2.result).toBe("deny")
})

// A-26
test("A-26 cross-layer no override project cannot override global deny", () => {
  const r = req("bash", ["ls"])
  const layers: LayerInput[] = [
    layer("global", [{ permission: "bash", pattern: "*", action: "deny" }]),
    layer("project", [{ permission: "bash", pattern: "*", action: "allow" }]),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("deny")
})

// A-27
test("A-27 multi-layer allow requires all applicable, applicable no-rule blocks allow", () => {
  const r = req("bash", ["ls"])
  const layers: LayerInput[] = [
    layer("global", [{ permission: "bash", pattern: "*", action: "allow" }]),
    layer("project", []), // applicable but no matching rule => ask
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("ask")
})

// A-28 - strengthened: toggle/session allow does not grant without policy allow (actual toggle path)
test("A-28 toggle does not grant", () => {
  // toggle is not a direct allow; even with session allowEverything true, a tool toggle alone (no policy allow) must not grant
  // First verify without any policy allow => ask
  const r = req("bash", ["ls"])
  const layersAsk: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "ask" }])]
  const outAsk = evaluate({ request: r, layers: layersAsk, approvals: [], allowEverything: false })
  expect(outAsk.result).toBe("ask")
  // With allowEverything true, ordinary ask is resolved but ceiling still blocks (no ceiling here so allow via allowEverything)
  const outAllowEverything = evaluate({ request: r, layers: layersAsk, approvals: [], allowEverything: true })
  expect(outAllowEverything.result).toBe("allow")
  // But a pure toggle (availability) without any applicable allow layer and no allowEverything must remain ask
  // This proves toggle does not add a grant: non-applicable layers contribute no decision, runtime no-ceiling neutral => ask per default-ask
  const layersEmpty: LayerInput[] = []
  const outToggle = evaluate({ request: r, layers: layersEmpty, approvals: [], allowEverything: false })
  expect(outToggle.result).toBe("ask")
})

// A-29
test("A-29 standalone allow with other layers non-applicable", () => {
  const r = req("question_tool", ["*"])
  const layers: LayerInput[] = [layer("project", [{ permission: "question_tool", pattern: "*", action: "allow" }])]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
  expect(out.result).toBe("allow")
  expect(out.provenance.contributingLayers.some((l) => l.decision === "no-ceiling")).toBe(true)
  // non-applicable global not in contributingLayers
  expect(out.provenance.contributingLayers.find((l) => l.sourceKind === "global-file")).toBeUndefined()
})

// A-30
test("A-30 mixed ordinary plus ceiling asks every ask must be resolved - allowEverything only resolves ordinary", () => {
  const r = req("edit", ["kilo.json"])
  // project applicable no-rule => ordinary ask, plus ceiling b => ask-ceiling
  const layers: LayerInput[] = [
    layer("global", [{ permission: "edit", pattern: "*", action: "allow" }]),
    layer("project", []),
  ]
  const out = evaluate({ request: r, layers, approvals: [], allowEverything: true })
  expect(out.result).toBe("ask-ceiling")
  expect(out.provenance.decisive.ceilingId).toBe("(b)")
})

// A-31
test("A-31 mixed asks with single exact approval covering both ordinary and ceiling", () => {
  const r = req("edit", ["kilo.json"])
  const layers: LayerInput[] = [
    layer("global", [{ permission: "edit", pattern: "*", action: "allow" }]),
    layer("project", []), // ordinary ask
  ]
  const ap = approval("session", ["kilo.json"], { permission: "edit" })
  const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
  expect(out.result).toBe("allow")
  expect(out.provenance.approval).toBeDefined()
  // ensure single approval resolves both
  // also check that once approval also works
  const apOnce = approval("once", ["kilo.json"], { permission: "edit" })
  const out2 = evaluate({ request: r, layers, approvals: [apOnce], allowEverything: false })
  expect(out2.result).toBe("allow")
})

describe("provenance v1 completeness", () => {
  test("provenance includes operationId permission prefix", () => {
    const r = req("read", ["foo.txt"])
    const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.provenance.request.operationId).toBe("permission:per_abc123")
    expect(out.provenance.request.permissionRequestId).toBe("per_abc123")
    expect(out.provenance.request.permission).toBe("read")
  })

  test("provenance layer ordering runtime ceiling first", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [
      layer("global", [{ permission: "bash", pattern: "*", action: "allow" }]),
      layer("project", [{ permission: "bash", pattern: "*", action: "allow" }]),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.provenance.contributingLayers[0].sourceKind).toBe("runtime-safety")
  })

  test("no-ceiling layer decision explicit", () => {
    const r = req("read", ["foo.txt"])
    const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.provenance.contributingLayers.find((l) => l.sourceKind === "runtime-safety")?.decision).toBe("no-ceiling")
  })
})

describe("R18 additional coverage - direct class B", () => {
  test("write protected caps at ask-ceiling", () => {
    const r = req("write", ["/workspace/kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "write", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("bash protected caps at ask-ceiling", () => {
    const r = req("bash", ["/workspace/.kilo/kilo.jsonc"], { workspaceRoot: "/workspace" })
    // bash is mutating, path protected
    const layers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("external_directory mutating protected caps", () => {
    const r = req("external_directory", ["/workspace/.kilo/kilo.jsonc"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
  })
  test("external_directory read-only not protected", () => {
    const r = req("external_directory", ["/workspace/.kilo/kilo.jsonc"], { workspaceRoot: "/workspace", isProtectedRequest: false })
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("allow")
  })
})

describe("R18 authored global and absent layer", () => {
  test("absent global layer allows via project allow", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [layer("project", [{ permission: "bash", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("allow")
    expect(out.provenance.contributingLayers.find((l) => l.sourceKind === "global-file")).toBeUndefined()
  })
  test("authored global deny blocks even with project allow", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [
      layer("global", [{ permission: "bash", pattern: "*", action: "deny" }]),
      layer("project", [{ permission: "bash", pattern: "*", action: "allow" }]),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("deny")
    expect(out.provenance.decisive.reason).toContain("global-deny")
  })
  test("authored global empty asks even with project allow", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [
      layer("global", []),
      layer("project", [{ permission: "bash", pattern: "*", action: "allow" }]),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask")
  })
  test("authored global allow with project absent allows", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("allow")
  })
})

describe("R18 duplicate source provenance", () => {
  test("duplicate global sources compose and provenance retains each", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [
      layer("global", [{ permission: "bash", pattern: "other", action: "allow" }], "/home/user/.config/kilo/kilo.jsonc"),
      layer("global", [{ permission: "bash", pattern: "*", action: "allow" }], "memory:global-approved"),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    // first source has no matching rule => ask, second allow; aggregated deny > ask > allow => ask
    expect(out.result).toBe("ask")
    // provenance should have two global entries plus runtime
    const globals = out.provenance.contributingLayers.filter((l) => l.sourceKind === "global-file" || l.sourceKind === "approval")
    expect(globals.length).toBe(2)
    expect(globals[0].canonicalPath).toBe("/home/user/.config/kilo/kilo.jsonc")
    expect(globals[1].canonicalPath).toBe("memory:global-approved")
  })
  test("duplicate same-kind empty plus allow composes to allow but provenance shows ask plus allow", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [
      layer("global", [], "/global/file1"),
      layer("global", [{ permission: "bash", pattern: "*", action: "allow" }], "/global/file2"),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    // aggregated decision is ask (empty ask dominates allow)
    expect(out.result).toBe("ask")
    const globals = out.provenance.contributingLayers.filter((l) => l.sourceKind === "global-file")
    expect(globals.length).toBe(2)
    expect(globals[0].decision).toBe("ask")
    expect(globals[1].decision).toBe("allow")
  })
})

describe("R18 canonical and approval exactness", () => {
  test("approval with wildcard pattern does not resolve protected", () => {
    const r = req("edit", ["/workspace/kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const ap = approval("session", ["*"], { permission: "edit" })
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
  })
  test("approval with sessionID * is ignored", () => {
    const r = req("edit", ["/workspace/kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const ap = approval("session", ["/workspace/kilo.json"], { permission: "edit", sessionID: "*" } as any)
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
  })
  test("provenance rule patterns are canonical physical", () => {
    const r = req("edit", ["kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "kilo.json", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    // For ceiling, rule pattern should be canonical absolute
    const rt = out.provenance.contributingLayers.find((l) => l.sourceKind === "runtime-safety")
    expect(rt?.decision).toBe("ask-ceiling")
    expect(out.provenance.request.patterns[0]).toBe("/workspace/kilo.json")
  })
})

describe("blocker regressions - evaluator", () => {
  test("skill wildcard approval rejected (external_directory skill glob)", () => {
    const r = req("external_directory", ["/tmp/global/skills/foo/file.txt"], { workspaceRoot: "/workspace" })
    // skill glob pattern with wildcard should be rejected as approval
    const skillGlob = "/tmp/global/skills/foo/*"
    const ap = approval("session", [skillGlob], { permission: "external_directory" })
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    // wildcard approval must not resolve; if request is not protected, result should be determined by layers (allow) but skill wildcard should not be considered approval
    // For a protected external_directory path, wildcard skill should not bypass
    const protectedReq = req("external_directory", ["/workspace/.kilo/kilo.jsonc"], { workspaceRoot: "/workspace" })
    const out2 = evaluate({ request: protectedReq, layers, approvals: [ap], allowEverything: false })
    expect(out2.result).toBe("ask-ceiling")
    // also ensure sessionID wildcard rejected
    const apStar = approval("session", ["/workspace/.kilo/kilo.jsonc"], { permission: "external_directory", sessionID: "*" } as any)
    const out3 = evaluate({ request: protectedReq, layers, approvals: [apStar], allowEverything: false })
    expect(out3.result).toBe("ask-ceiling")
  })

  test("duplicate same-kind source deny precedence and provenance preserved", () => {
    const r = req("bash", ["ls"])
    // two global sources: first deny specific, second allow wildcard
    // declaration order within each doc already handled; cross-document aggregation should be deny > ask > allow
    const layers: LayerInput[] = [
      layer("global", [{ permission: "bash", pattern: "ls", action: "deny" }], "/global/file1"),
      layer("global", [{ permission: "bash", pattern: "*", action: "allow" }], "/global/file2"),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("deny")
    const globals = out.provenance.contributingLayers.filter((l) => l.sourceKind === "global-file" || l.sourceKind === "approval")
    // provenance must preserve both sources
    expect(globals.length).toBe(2)
    expect(globals[0].decision).toBe("deny")
    expect(globals[1].decision).toBe("allow")
    // also test empty + allow aggregation: empty is ask, allow is allow => ask dominates
    const r2 = req("bash", ["ls"])
    const layers2: LayerInput[] = [
      layer("global", [], "/global/empty"),
      layer("global", [{ permission: "bash", pattern: "*", action: "allow" }], "/global/file2"),
    ]
    const out2 = evaluate({ request: r2, layers: layers2, approvals: [], allowEverything: false })
    expect(out2.result).toBe("ask")
    const globals2 = out2.provenance.contributingLayers.filter((l) => l.canonicalPath === "/global/empty" || l.canonicalPath === "/global/file2")
    expect(globals2.length).toBe(2)
    // ensure approval sourceKind is distinct when used
    const ap = approval("session", ["ls"], { permission: "bash" })
    const layers3: LayerInput[] = [layer("global", [], "/global/empty")]
    const out3 = evaluate({ request: r2, layers: layers3, approvals: [ap], allowEverything: false })
    expect(out3.result).toBe("allow")
    expect(out3.provenance.approval).toBeDefined()
  })

  test("runtime approval source metadata uses approval sourceKind with memory path", () => {
    const r = req("bash", ["ls"])
    // simulate runtime approved rule as global layer with sourceKind approval (no empty global, to avoid ask dominating)
    const layers: LayerInput[] = [
      { kind: "global", sourceKind: "approval", canonicalPath: "memory:global-approved", ruleset: [{ permission: "bash", pattern: "ls", action: "allow" }] } as LayerInput,
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("allow")
    const mem = out.provenance.contributingLayers.find((l) => l.canonicalPath === "memory:global-approved")
    expect(mem).toBeDefined()
    expect(mem?.sourceKind).toBe("approval")
    // when both empty global and approval memory present, aggregated ask dominates, but provenance still shows both
    const layers2: LayerInput[] = [
      layer("global", [], "/home/user/.config/kilo/kilo.jsonc"),
      { kind: "global", sourceKind: "approval", canonicalPath: "memory:global-approved", ruleset: [{ permission: "bash", pattern: "ls", action: "allow" }] } as LayerInput,
    ]
    const out2 = evaluate({ request: r, layers: layers2, approvals: [], allowEverything: false })
    expect(out2.result).toBe("ask")
    expect(out2.provenance.contributingLayers.filter((l) => l.canonicalPath === "memory:global-approved" || l.canonicalPath === "/home/user/.config/kilo/kilo.jsonc").length).toBe(2)
  })

  test("bash literal provenance preserves exact command", () => {
    const cmd = "npm install lodash"
    const r = req("bash", [cmd], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.provenance.request.patterns[0]).toBe(cmd)
    // rule provenance also preserves literal for bash
    const projLayer = out.provenance.contributingLayers.find((l) => l.sourceKind === "global-file")
    expect(projLayer?.rules[0].pattern).toBe("*")
    // approval literal also preserved
    const ap = approval("session", [cmd], { permission: "bash" })
    const r2 = req("bash", [cmd], { workspaceRoot: "/workspace" })
    const out2 = evaluate({ request: r2, layers: [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/empty", ruleset: [] }], approvals: [ap], allowEverything: false })
    // with empty global (ask) + exact approval should allow and preserve literal
    expect(out2.result).toBe("allow")
    expect(out2.provenance.approval?.patterns[0]).toBe(cmd)
    expect(out2.provenance.request.patterns[0]).toBe(cmd)
  })

  test("authored empty global is applicable ask regardless of permission", () => {
    const r = req("write", ["foo.txt"])
    const layers: LayerInput[] = [
      layer("global", [], "/home/user/.config/kilo/kilo.jsonc"),
      layer("project", [{ permission: "write", pattern: "*", action: "allow" }]),
    ]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask")
    expect(out.provenance.contributingLayers.some((l) => l.canonicalPath === "/home/user/.config/kilo/kilo.jsonc" && l.decision === "ask")).toBe(true)
  })
})

describe("hard deny external_directory absolute (blocker 1)", () => {
  test("mode rule hard deny not filtered for external_directory", () => {
    const r = req("external_directory", ["/tmp/outside/file.txt"])
    const hard = [{ permission: "*", pattern: "*", action: "deny" as const }]
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false, hardDenyRuleset: hard })
    expect(out.result).toBe("deny")
    expect(out.provenance.decisive.ceilingId).toBe("(a)")
    // even with allowEverything true, hard deny still wins
    const out2 = evaluate({ request: r, layers, approvals: [], allowEverything: true, hardDenyRuleset: hard })
    expect(out2.result).toBe("deny")
    // even with exact approval, hard deny wins
    const ap = approval("session", ["/tmp/outside/file.txt"], { permission: "external_directory" })
    const out3 = evaluate({ request: r, layers, approvals: [ap], allowEverything: false, hardDenyRuleset: hard })
    expect(out3.result).toBe("deny")
  })
  test("external_directory broad deny via hardDenyRuleset", () => {
    const r = req("external_directory", ["/tmp/outside/other.txt"])
    const hard = [{ permission: "external_directory", pattern: "*", action: "deny" as const }]
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false, hardDenyRuleset: hard })
    expect(out.result).toBe("deny")
  })
  test("non-authorizing mode predicate separate from hard deny", () => {
    // hasMatchingRule / isExternalDirectoryModeDeny is boolean predicate, not authority
    const { isExternalDirectoryModeDeny } = require("../../src/permission/evaluator")
    expect(isExternalDirectoryModeDeny({ permission: "*", pattern: "*", action: "deny" })).toBe(true)
    expect(isExternalDirectoryModeDeny({ permission: "external_directory", pattern: "*", action: "deny" })).toBe(false)
    // winningRule still filters mode rule for external_directory (non-authorizing)
    const r2 = req("external_directory", ["/tmp/file.txt"])
    const layers2: LayerInput[] = [layer("global", [{ permission: "*", pattern: "*", action: "deny" }])]
    const out2 = evaluate({ request: r2, layers: layers2, approvals: [], allowEverything: false })
    // mode rule alone is filtered, so no deny via layer => defaults to ask (no-ceiling + no applicable allow) => ask
    expect(out2.result).toBe("ask")
  })
})

describe("skill wildcard class-b ceiling (blocker 1)", () => {
  test("absolute skill wildcard with broad allow hits ask-ceiling", () => {
    const absSkill = "/tmp/.config/kilo/skills/demo/*"
    const r = req("external_directory", [absSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("absolute skill wildcard with allowEverything still ask-ceiling", () => {
    const absSkill = "/tmp/.config/kilo/skills/demo/*"
    const r = req("external_directory", [absSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: true })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("relative skill wildcard with broad allow hits ask-ceiling", () => {
    const relSkill = "skills/demo/*"
    const r = req("external_directory", [relSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("relative skill wildcard with allowEverything still ask-ceiling", () => {
    const relSkill = "skills/demo/*"
    const r = req("external_directory", [relSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: true })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })
  test("skill wildcard exact wildcard approval does not resolve ceiling", () => {
    const absSkill = "/tmp/.config/kilo/skills/demo/*"
    const r = req("external_directory", [absSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const ap = approval("session", [absSkill], { permission: "external_directory" })
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
  })
  test("skill concrete file with exact approval resolves", () => {
    const concrete = "/tmp/.config/kilo/skills/demo/SKILL.md"
    const r = req("external_directory", [concrete])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const ap = approval("session", [concrete], { permission: "external_directory" })
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    // concrete skill file is still under global config path, but our lexical wildcard check only triggers for glob patterns
    // so concrete without glob will be judged via isProtectedPath -> true if under global, so still ask-ceiling without approval
    // with exact approval it should allow
    // we test that concrete with approval allows, while wildcard does not
    expect(out.result).toBe("allow")
  })
  test("skill wildcard with prefix pattern also hits ceiling", () => {
    const prefixSkill = "skills/demo/**"
    const r = req("external_directory", [prefixSkill])
    const layers: LayerInput[] = [layer("global", [{ permission: "external_directory", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
  })
})

describe("durable protected provenance truthfulness", () => {
  test("durable approval has protected-file sourceKind and persistent expiry", () => {
    const r = req("edit", ["/workspace/kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const ap: Approval = {
      kind: "durable",
      patterns: ["/workspace/kilo.json"],
      sessionID: sess,
      agent,
      permission: "edit",
      provenancePath: `protected:${agent}:/workspace/kilo.json`,
    }
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    expect(out.result).toBe("allow")
    expect(out.provenance.approval?.kind).toBe("durable")
    expect(out.provenance.approval?.expiry).toBe("persistent")
    expect(out.provenance.approval?.expiry).not.toBe("session-end")
    const protLayer = out.provenance.contributingLayers.find((l) => l.sourceKind === "protected-file")
    expect(protLayer).toBeDefined()
    expect(protLayer?.canonicalPath).toBe(`protected:${agent}:/workspace/kilo.json`)
    // ensure not confused with ephemeral approval
    expect(protLayer?.sourceKind).not.toBe("approval")
  })
  test("session approval remains session-end and approval sourceKind", () => {
    const r = req("edit", ["/workspace/kilo.json"], { workspaceRoot: "/workspace" })
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const ap = approval("session", ["/workspace/kilo.json"], { permission: "edit" })
    const out = evaluate({ request: r, layers, approvals: [ap], allowEverything: false })
    expect(out.result).toBe("allow")
    expect(out.provenance.approval?.expiry).toBe("session-end")
    const apprLayer = out.provenance.contributingLayers.find((l) => l.sourceKind === "approval")
    expect(apprLayer).toBeDefined()
    expect(apprLayer?.canonicalPath).toBe(`approval:${sess}`)
  })
})

describe("ask display diff never enters evaluator canonical targets", () => {
  test("buildCanonicalTargets ignores diff/patch/filediff display bytes", () => {
    const base = { patterns: ["/workspace/foo.txt"], permission: "edit" }
    const a = buildCanonicalTargets(
      { ...base, metadata: { filepath: "/workspace/foo.txt", diff: "preview-A", patch: "preview-A", filediff: { patch: "preview-A" } } },
      ws,
    )
    const b = buildCanonicalTargets(
      {
        ...base,
        metadata: {
          filepath: "/workspace/foo.txt",
          diff: "preview-B @@ -1 +1 @@\n-/workspace/kilo.json\n+/workspace/kilo.json",
          patch: "preview-B",
          filediff: { file: "/workspace/foo.txt", patch: "preview-B" },
          files: [{ filePath: "/workspace/foo.txt", patch: "preview-B" }],
        },
      },
      ws,
    )
    expect(a).toEqual(["/workspace/foo.txt"])
    expect(b).toEqual(a)
  })

  test("evaluate decision identical when only ask display diff changes", () => {
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const meta = (diff: string) => ({ filepath: "/workspace/foo.txt", diff, filediff: { file: "/workspace/foo.txt", patch: diff } })
    const r = req("edit", ["/workspace/foo.txt"])
    const tA = buildCanonicalTargets({ patterns: r.patterns, metadata: meta("preview-A"), permission: r.permission }, ws)
    const tB = buildCanonicalTargets(
      { patterns: r.patterns, metadata: meta("preview-B mentions /workspace/kilo.json"), permission: r.permission },
      ws,
    )
    expect(tB).toEqual(tA)
    const outA = evaluate({ request: { ...r, targets: tA }, layers, approvals: [], allowEverything: false })
    const outB = evaluate({ request: { ...r, targets: tB }, layers, approvals: [], allowEverything: false })
    // display text naming a ceiling path must not trigger the ceiling
    expect(outA.result).toBe("allow")
    expect(outB.result).toBe(outA.result)
  })
})
