import { test, expect, describe } from "bun:test"
import { evaluate, type LayerInput, type Request } from "../../src/permission/evaluator"

const ws = "/workspace"
const sess = "sess_1"

function req(permission: string, patterns: string[], extra: Partial<Request> = {}): Request {
  const id = extra.permissionRequestId ?? "per_auto1"
  const op = extra.operationId ?? `permission:${id}`
  return {
    sessionID: extra.sessionID ?? sess,
    agent: extra.agent ?? "build",
    workspaceRoot: ws,
    ...extra,
    permission,
    patterns,
    permissionRequestId: id,
    operationId: op,
  }
}

function layer(
  kind: LayerInput["kind"],
  rules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[],
): LayerInput {
  const map: Record<string, { sk: LayerInput["sourceKind"]; cp: string }> = {
    "runtime-ceiling": { sk: "runtime-safety", cp: "runtime:ceiling" },
    global: { sk: "global-file", cp: "/home/user/.config/kilo/kilo.jsonc" },
    project: { sk: "project-file", cp: `${ws}/.kilo/kilo.jsonc` },
    agent: { sk: "agent-manifest", cp: "agent:build" },
    "session-restriction": { sk: "session-restriction", cp: `session:${sess}` },
  }
  const m = map[kind]
  return { kind, sourceKind: m.sk, canonicalPath: m.cp, ruleset: rules }
}

const auto = { permissionLevel: "autonomous" as const }

describe("autonomous permission_level binding semantics", () => {
  test("review (absent level) keeps agent ordinary ask", () => {
    const out = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }])],
      approvals: [],
      allowEverything: false,
    })
    expect(out.result).toBe("ask")
  })

  test("autonomous keeps explicit ask from every layer", () => {
    for (const kind of ["global", "project", "agent", "session-restriction"] as const) {
      const out = evaluate({
        request: req("bash", ["npm test"]),
        layers: [layer("runtime-ceiling", []), layer(kind, [{ permission: "bash", pattern: "npm test", action: "ask" }])],
        approvals: [],
        allowEverything: false,
        ...auto,
      })
      expect(out.result).toBe("ask")
      expect(out.provenance.decisive.reason).toContain("no-rule-ask")
      expect(out.provenance.approval).toBeUndefined()
      const contributing = out.provenance.contributingLayers.find((l) => l.canonicalPath === layer(kind, []).canonicalPath)
      expect(contributing?.decision).toBe("ask")
    }
  })

  test("autonomous global allow with project ask still asks", () => {
    const out = evaluate({
      request: req("bash", ["npm test"]),
      layers: [
        layer("runtime-ceiling", []),
        layer("global", [{ permission: "bash", pattern: "*", action: "allow" }]),
        layer("project", [{ permission: "bash", pattern: "npm test", action: "ask" }]),
      ],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("ask")
    expect(out.provenance.decisive.reason).toBe("project-no-rule-ask")
  })

  test("autonomous keeps doom_loop and question lifecycle asks", () => {
    for (const permission of ["doom_loop", "question", "question_tool"]) {
      const pattern = permission === "doom_loop" ? "bash" : "*"
      const out = evaluate({
        request: req(permission, [pattern]),
        layers: [layer("runtime-ceiling", []), layer("agent", [{ permission, pattern, action: "ask" }])],
        approvals: [],
        allowEverything: false,
        ...auto,
      })
      expect(out.result).toBe("ask")
      expect(out.provenance.approval).toBeUndefined()
    }
  })

  test("autonomous keeps ceiling-b protected mutation as ask-ceiling", () => {
    const out = evaluate({
      request: req("edit", [".kilo/kilo.jsonc"]),
      layers: [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.reason).toBe("ceiling-b")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
  })

  test("autonomous keeps ceiling-c .env read as ask-ceiling", () => {
    const out = evaluate({
      request: req("read", ["secret.env"]),
      layers: [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.reason).toBe("ceiling-c")
    expect(out.provenance.decisive.ceilingId).toBe("(c)")
  })

  test("autonomous keeps authored empty applicable layer and default no-rule as ask", () => {
    const emptyLayer = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("global", []), layer("project", [{ permission: "bash", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(emptyLayer.result).toBe("ask")

    const noRule = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", [])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(noRule.result).toBe("ask")
    expect(noRule.provenance.decisive.reason).toBe("default-ask")
  })

  test("autonomous exact approval still follows existing approval conditions", () => {
    const without = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(without.result).toBe("ask")

    const exact = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }])],
      approvals: [{ kind: "session", patterns: ["npm test"], sessionID: sess, agent: "build", permission: "bash" }],
      allowEverything: false,
      ...auto,
    })
    expect(exact.result).toBe("allow")
    expect(exact.provenance.decisive.reason).toBe("approval-exact")
  })

  test("autonomous keeps all-allow truthful", () => {
    const out = evaluate({
      request: req("read", ["notes.md"]),
      layers: [layer("runtime-ceiling", []), layer("global", [{ permission: "read", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("allow")
    expect(out.provenance.decisive.reason).toBe("all-allow")
  })

  test("autonomous plain {'*':'allow'} preset unconstrained stays all-allow", () => {
    const out = evaluate({
      request: req("bash", ["ls"]),
      layers: [layer("runtime-ceiling", []), layer("global", [{ permission: "*", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("allow")
    expect(out.provenance.decisive.reason).toBe("all-allow")
  })

  test("autonomous never bypasses explicit deny or ceiling-a hard deny", () => {
    const denied = evaluate({
      request: req("bash", ["npm test"]),
      layers: [
        layer("runtime-ceiling", []),
        layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }]),
        layer("global", [{ permission: "bash", pattern: "npm test", action: "deny" }]),
      ],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(denied.result).toBe("deny")

    const hard = evaluate({
      request: req("edit", ["/protected/hard"]),
      layers: [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      hardDenyRuleset: [{ permission: "edit", pattern: "/protected/hard", action: "deny" }],
      ...auto,
    })
    expect(hard.result).toBe("deny")
    expect(hard.provenance.decisive.ceilingId).toBe("(a)")
  })

  test("autonomous does not fake approval or allowEverything", () => {
    const out = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("ask")
    expect(out.provenance.approval).toBeUndefined()
    expect(out.provenance.decisive.reason).not.toBe("allow-everything")
    expect(out.provenance.decisive.reason).not.toBe("approval-exact")
  })
})
