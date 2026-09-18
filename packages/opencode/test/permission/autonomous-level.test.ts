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

describe("autonomous permission_level", () => {
  test("review (absent level) keeps agent ordinary ask", () => {
    const out = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", []), layer("agent", [{ permission: "bash", pattern: "npm test", action: "ask" }])],
      approvals: [],
      allowEverything: false,
    })
    expect(out.result).toBe("ask")
  })

  test("autonomous allows ordinary ask from every layer without approval", () => {
    for (const kind of ["global", "project", "agent", "session-restriction"] as const) {
      const out = evaluate({
        request: req("bash", ["npm test"]),
        layers: [layer("runtime-ceiling", []), layer(kind, [{ permission: "bash", pattern: "npm test", action: "ask" }])],
        approvals: [],
        allowEverything: false,
        ...auto,
      })
      expect(out.result).toBe("allow")
      expect(out.provenance.decisive.reason).toBe("autonomous")
      expect(out.provenance.approval).toBeUndefined()
    }
  })

  test("autonomous allows doom_loop and question lifecycle asks", () => {
    for (const permission of ["doom_loop", "question", "question_tool"]) {
      const pattern = permission === "doom_loop" ? "bash" : "*"
      const out = evaluate({
        request: req(permission, [pattern]),
        layers: [layer("runtime-ceiling", []), layer("agent", [{ permission, pattern, action: "ask" }])],
        approvals: [],
        allowEverything: false,
        ...auto,
      })
      expect(out.result).toBe("allow")
      expect(out.provenance.decisive.reason).toBe("autonomous")
    }
  })

  test("autonomous allows ceiling-b protected mutation with ceiling provenance", () => {
    const out = evaluate({
      request: req("edit", [".kilo/kilo.jsonc"]),
      layers: [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("allow")
    expect(out.provenance.decisive.reason).toBe("autonomous-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe(null)
  })

  test("autonomous allows ceiling-c .env read with ceiling provenance", () => {
    const out = evaluate({
      request: req("read", ["secret.env"]),
      layers: [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("allow")
    expect(out.provenance.decisive.reason).toBe("autonomous-ceiling")
  })

  test("autonomous allows the empty default-ask", () => {
    const out = evaluate({
      request: req("bash", ["npm test"]),
      layers: [layer("runtime-ceiling", [])],
      approvals: [],
      allowEverything: false,
      ...auto,
    })
    expect(out.result).toBe("allow")
    expect(out.provenance.decisive.reason).toBe("autonomous")
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
    expect(out.result).toBe("allow")
    expect(out.provenance.approval).toBeUndefined()
    expect(out.provenance.decisive.reason).not.toBe("allow-everything")
    expect(out.provenance.decisive.reason).not.toBe("approval-exact")
  })
})
