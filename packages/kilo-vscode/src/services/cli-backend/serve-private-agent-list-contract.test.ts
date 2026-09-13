import { describe, expect, test } from "bun:test"
import {
  AGENT_LIST_FAILURE_MESSAGES,
  isSettledAgentListResult,
  makeAgentListAmbiguous,
  normalizePrivateAgentListWire,
  validateAgentListContractRequest,
  validateAgentListData,
  validateAgentListEntries,
  validateAgentListEntry,
  validateAgentListFailure,
  validateAgentListResult,
} from "./serve-private-agent-list-contract"

function req() {
  return { v: 1 as const, requestId: "r1", op: "agent/list" as const, context: { directory: "/tmp" }, payload: {} }
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "code",
    mode: "primary",
    permission: [{ permission: "edit", pattern: "*", action: "allow" }],
    options: {},
    ...overrides,
  }
}

describe("agent-list contract", () => {
  test("request strict: absolute directory, optional workspace, empty payload, no opId", () => {
    expect(() => validateAgentListContractRequest(req())).not.toThrow()
    expect(() => validateAgentListContractRequest({ ...req(), context: { directory: "rel" } })).toThrow()
    expect(() => validateAgentListContractRequest({ ...req(), context: { directory: "/tmp", workspace: "" } })).toThrow()
    expect(() => validateAgentListContractRequest({ ...req(), payload: { x: 1 } })).toThrow()
    expect(() => validateAgentListContractRequest({ ...req(), opId: "x" } as never)).toThrow()
    expect(() => validateAgentListContractRequest({ ...req(), requestId: "/tmp/x" })).toThrow()
  })

  test("entry strict: full wire optional/union/unknown handling", () => {
    expect(() => validateAgentListEntry(entry())).not.toThrow()
    expect(() =>
      validateAgentListEntry(entry({ displayName: "D", source: "project", description: "", deprecated: true, native: true, hidden: false, topP: 0.5, temperature: 0.2, color: "#fff", model: { modelID: "m", providerID: "p" }, variant: "v", prompt: "p", requirements: { skills: ["s"] }, steps: 3 })),
    ).not.toThrow()
    expect(() => validateAgentListEntry({ ...entry(), mode: "x" })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), permission: [{ permission: "e", pattern: "*", action: "x" }] })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), options: null })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), requirements: {} })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), extra: 1 })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), name: "" })).toThrow()
    expect(() => validateAgentListEntry({ ...entry(), model: { modelID: "", providerID: "p" } })).toThrow()
    // Nullable rejected: optional fields must be absent or correctly typed, never null.
    expect(() => validateAgentListEntry({ ...entry(), description: null })).toThrow()
    expect(() => validateAgentListEntries("x" as never)).toThrow()
    expect(() => validateAgentListData({ agents: "x" } as never)).toThrow()
    expect(() => validateAgentListData({ agents: [], extra: 1 } as never)).toThrow()
  })

  test("failure strict: fixed code/message/retryable taxonomy", () => {
    for (const [code, message, retryable] of [
      ["validation.failed", AGENT_LIST_FAILURE_MESSAGES["validation.failed"], false],
      ["scope_mismatch", AGENT_LIST_FAILURE_MESSAGES["scope_mismatch"], false],
      ["InstanceUnavailableDuringConfigRebuild", AGENT_LIST_FAILURE_MESSAGES["InstanceUnavailableDuringConfigRebuild"], true],
      ["internal", AGENT_LIST_FAILURE_MESSAGES["internal"], false],
    ] as const) {
      expect(() => validateAgentListFailure({ code, message, retryable })).not.toThrow()
    }
    expect(() => validateAgentListFailure({ code: "other", message: "m", retryable: false })).toThrow()
    expect(() => validateAgentListFailure({ code: "internal", message: "wrong", retryable: false })).toThrow()
  })

  test("result strict: succeeded/failed/ambiguous binding", () => {
    const r = req()
    const ok = {
      v: 1,
      requestId: "r1",
      op: "agent/list",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { agents: [entry()] },
    }
    expect(() => validateAgentListResult(ok, r)).not.toThrow()
    expect(normalizePrivateAgentListWire(ok, r).kind).toBe("valid")
    const bad = { ...ok, data: { agents: [{ name: "", mode: "x" }] } }
    expect(normalizePrivateAgentListWire(bad, r).kind).toBe("invalid")
    const failed = {
      v: 1,
      requestId: "r1",
      op: "agent/list",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "internal error", retryable: false } },
      accepted: false,
      failure: { code: "internal", message: "internal error", retryable: false },
    }
    expect(() => validateAgentListResult(failed, r)).not.toThrow()
    expect(isSettledAgentListResult(ok, r)).toBeTrue()
    expect(isSettledAgentListResult(failed, r)).toBeTrue()
    const retryable = {
      v: 1,
      requestId: "r1",
      op: "agent/list",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "InstanceUnavailableDuringConfigRebuild", message: AGENT_LIST_FAILURE_MESSAGES["InstanceUnavailableDuringConfigRebuild"], retryable: true } },
      accepted: false,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: AGENT_LIST_FAILURE_MESSAGES["InstanceUnavailableDuringConfigRebuild"], retryable: true },
    }
    expect(isSettledAgentListResult(retryable, r)).toBeFalse()
    const amb = makeAgentListAmbiguous(r, true)
    expect(isSettledAgentListResult(amb, r)).toBeFalse()
  })
})
