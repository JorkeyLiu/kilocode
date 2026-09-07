import { describe, expect, test } from "bun:test"
import {
  AGENT_REQUIREMENTS_FAILED_CODE,
  AGENT_REQUIREMENTS_FAILED_MESSAGE,
  AGENT_REQUIREMENTS_INVALID_DETAIL,
  AgentRequirementsValidationError,
  canonicalAgentRequirementsOpId,
  checkAgentRequirementsScope,
  compareAgentRequirementsParity,
  isAgentRequirementsValidationError,
  makeAgentRequirementsAmbiguous,
  normalizePrivateAgentRequirementsWire,
  parseAgentRequirementsOpId,
  validateAgentRequirementsContractRequest,
  validateAgentRequirementsFailure,
  validateAgentRequirementsPayload,
  validateAgentRequirementsResult,
} from "./serve-private-agent-requirements-contract"

const AGENT = "code"
const DIR = "/tmp"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalAgentRequirementsOpId(AGENT, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "agent/requirements" as const,
    idempotencyKey: opId,
    context: { directory: DIR, agent: AGENT },
    payload: {},
    ...over,
  }
}

function makeResult(over: Record<string, unknown> = {}) {
  return {
    agent: AGENT,
    directory: DIR,
    enabled: true,
    state: "ready",
    skills: [{ name: "skill-a", status: "ready" }],
    mcps: [{ name: "mcp-a", status: "ready" }],
    vscode_extensions: [{ name: "Ext A", id: "publisher.ext-a" }],
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateAgentRequirementsContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "agent/requirements" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { requirements: makeResult(over) },
  }
}

describe("Gate B agentRequirements candidate contract", () => {
  test("opId grammar binds agent with idempotency equality", () => {
    expect(canonicalAgentRequirementsOpId(AGENT, "t1")).toBe(`agent-requirements:${AGENT}:t1`)
    expect(() => canonicalAgentRequirementsOpId("", "t1")).toThrow()
    expect(() => canonicalAgentRequirementsOpId(AGENT, "")).toThrow()
    expect(() => canonicalAgentRequirementsOpId(AGENT, "a:b")).toThrow()
    expect(() => canonicalAgentRequirementsOpId("a:b", "t1")).toThrow()
    expect(parseAgentRequirementsOpId(canonicalAgentRequirementsOpId(AGENT, "t1"))).toEqual({
      agent: AGENT,
      token: "t1",
    })
    expect(() => parseAgentRequirementsOpId("agent-requirements:t1")).toThrow()
    expect(() => parseAgentRequirementsOpId("agent/requirements:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with routing-only directory/agent and empty payload", () => {
    const req = makeReq()
    expect(() => validateAgentRequirementsContractRequest(req)).not.toThrow()
    expect(() => validateAgentRequirementsContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateAgentRequirementsContractRequest({ ...req, op: "session/get" })).toThrow()
    expect(() =>
      validateAgentRequirementsContractRequest({
        ...req,
        idempotencyKey: canonicalAgentRequirementsOpId(AGENT, "other"),
      }),
    ).toThrow()
    expect(() =>
      validateAgentRequirementsContractRequest({ ...req, context: { directory: "relative", agent: AGENT } }),
    ).toThrow()
    expect(() => validateAgentRequirementsContractRequest({ ...req, context: { directory: DIR, agent: "" } })).toThrow()
    expect(() =>
      validateAgentRequirementsContractRequest({
        ...req,
        context: { directory: DIR, agent: AGENT, sessionId: "ses_x" },
      }),
    ).toThrow()
    expect(() => validateAgentRequirementsContractRequest({ ...req, payload: { agent: AGENT } })).toThrow()
    expect(() => validateAgentRequirementsContractRequest({ ...req, extra: 1 })).toThrow()
  })

  test("opId agent binding must match context agent", () => {
    const req = makeReq()
    expect(() =>
      validateAgentRequirementsContractRequest({
        ...req,
        opId: canonicalAgentRequirementsOpId("other", "tok1"),
        idempotencyKey: canonicalAgentRequirementsOpId("other", "tok1"),
      }),
    ).toThrow()
  })

  test("scope mismatch covers directory, agent, and request", () => {
    const req = validateAgentRequirementsContractRequest(makeReq())
    expect(checkAgentRequirementsScope(req, { directory: "/tmp/", agent: AGENT, token: "tok1" })).toEqual({
      ok: true,
    })
    expect(checkAgentRequirementsScope(req, { directory: "/other", agent: AGENT, token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkAgentRequirementsScope(req, { directory: DIR, agent: "other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "agent",
    })
    expect(checkAgentRequirementsScope(req, { directory: DIR, agent: AGENT, token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("payload projection requires exactly the server AgentRequirementResult fields", () => {
    expect(() => validateAgentRequirementsPayload(makeResult())).not.toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), enabled: undefined })).toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), state: "unknown" })).toThrow()
    for (const state of ["disabled", "ready", "blocked", "error"]) {
      expect(() => validateAgentRequirementsPayload({ ...makeResult(), state })).not.toThrow()
    }
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "s", status: "unknown" }] }),
    ).toThrow()
    // Authority `skills[].name`/`mcps[].name` are plain server `string`:
    // empty names are accepted by the response validator (F-02).
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: "", status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "E", id: "" }] }),
    ).toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), extra: 1 })).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "s", status: "ready", prompt: "x" }] }),
    ).toThrow()
  })

  test("authority RequirementName/RequirementID refinements apply ONLY to extensions; extension message is non-authority", () => {
    // Server `VSCodeExtension` is strictly `{name, id}`: any `message` key rejected.
    expect(() =>
      validateAgentRequirementsPayload({
        ...makeResult(),
        vscode_extensions: [{ name: "Ext A", id: "publisher.ext-a", message: "x" }],
      }),
    ).toThrow()
    // Blank names/ids rejected (empty or whitespace-only fails RequirementName).
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "", id: "publisher.ext-a" }] }),
    ).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "   ", id: "publisher.ext-a" }] }),
    ).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "Ext A", id: "" }] }),
    ).toThrow()
    // Illegal ids rejected per `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
    for (const id of ["-abc", ".abc", "_abc", "a b", "a/b", "a:b", "é"]) {
      expect(() =>
        validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "Ext A", id }] }),
      ).toThrow()
    }
    // Overlong name/id rejected (authority max 128).
    const ok128 = "a".repeat(128)
    const tooLong = "a".repeat(129)
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: tooLong, id: "publisher.ext-a" }] }),
    ).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "Ext A", id: tooLong }] }),
    ).toThrow()
    // Legal boundaries accepted.
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: "a", id: "a" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: ok128, id: ok128 }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), vscode_extensions: [{ name: " x ", id: "A0._-x" }] }),
    ).not.toThrow()
    // Skill/mcp names are plain server `string` (F-02): blank, whitespace-only,
    // and overlong values are accepted — no RequirementName refinement.
    const long = "a".repeat(500)
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "", status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "   ", status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: tooLong, status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: long, status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: "", status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: tooLong, status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: long, status: "ready" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: ok128, status: "ready" }] }),
    ).not.toThrow()
    // Non-string skill/mcp names are still rejected (authority requires string).
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: 1, status: "ready" }] }),
    ).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: undefined, status: "ready" }] }),
    ).toThrow()
    // Skill/mcp `message?` remains authority-allowed (unlike extensions).
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "s", status: "ready", message: "m" }] }),
    ).not.toThrow()
  })

  test("non-extension response strings are plain authority strings (F-02)", () => {
    // Payload `agent`/`directory` are plain server `string`: empty and long
    // values are accepted by the RESPONSE validator. (The routing-only
    // request validator keeps its own non-empty/absolute-path input rules.)
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), agent: "" })).not.toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), directory: "" })).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), agent: "a".repeat(500) }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), directory: "a".repeat(500) }),
    ).not.toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), agent: 1 })).toThrow()
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), directory: undefined })).toThrow()
    // `error.message` is a plain server `string`: empty accepted.
    expect(() =>
      validateAgentRequirementsPayload({
        ...makeResult(),
        state: "error",
        error: { code: "unknown_agent", message: "" },
      }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({
        ...makeResult(),
        state: "error",
        error: { code: "unknown_agent", message: "a".repeat(500) },
      }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({
        ...makeResult(),
        state: "error",
        error: { code: "unknown_agent", message: 1 },
      }),
    ).toThrow()
    // Skill/mcp `message?` is a plain server `string`: empty accepted.
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), skills: [{ name: "s", status: "error", message: "" }] }),
    ).not.toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), mcps: [{ name: "m", status: "error", message: "" }] }),
    ).not.toThrow()
  })

  test("host-side augmentation and guard fields are rejected from the server projection", () => {
    // Host-side `status` on vscode_extensions is augmentation, not authority.
    expect(() =>
      validateAgentRequirementsPayload({
        ...makeResult(),
        vscode_extensions: [{ name: "Ext A", id: "publisher.ext-a", status: "ready" }],
      }),
    ).toThrow()
    // Host-only error codes are never server authority.
    for (const code of ["scope_mismatch", "request_failed"]) {
      expect(() =>
        validateAgentRequirementsPayload({ ...makeResult(), error: { code, message: "m" } }),
      ).toThrow()
    }
    // Server error-code enum is restricted to the four server codes.
    for (const code of ["unknown_agent", "malformed_declaration", "discovery_failed", "mcp_status_failed"]) {
      expect(() =>
        validateAgentRequirementsPayload({ ...makeResult(), state: "error", error: { code, message: "m" } }),
      ).not.toThrow()
    }
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), error: { code: "blocked", message: "m" } }),
    ).toThrow()
    // Credential/guard echo keys are rejected.
    expect(() => validateAgentRequirementsPayload({ ...makeResult(), guard: {} })).toThrow()
    expect(() =>
      validateAgentRequirementsPayload({ ...makeResult(), error: { code: "unknown_agent", message: "m", guard: 1 } }),
    ).toThrow()
  })

  test("failures are redacted; requirement/credential/guard echo keys rejected", () => {
    expect(() => validateAgentRequirementsFailure({ code: "x", message: "m", retryable: false })).not.toThrow()
    for (const key of ["agent", "directory", "skills", "mcps", "vscode_extensions", "state", "guard", "credential"]) {
      expect(() =>
        validateAgentRequirementsFailure({ code: "x", message: "m", retryable: false, [key]: "raw" }),
      ).toThrow()
    }
    const req = validateAgentRequirementsContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "agent/requirements" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "upstream.boom", message: "raw detail", retryable: true },
      },
      accepted: false as const,
      failure: { code: "upstream.boom", message: "raw detail", retryable: true },
    }
    expect(() => validateAgentRequirementsResult(failed, req)).not.toThrow()
    const wire = normalizePrivateAgentRequirementsWire(failed, req)
    expect(wire.kind).toBe("valid")
    if (wire.kind === "valid" && wire.result.status === "failed") {
      expect(wire.result.failure.code).toBe(AGENT_REQUIREMENTS_FAILED_CODE)
      expect(wire.result.failure.message).toBe(AGENT_REQUIREMENTS_FAILED_MESSAGE)
      expect(wire.result.failure.retryable).toBeTrue()
      expect(wire.result.outcome.failure.code).toBe(AGENT_REQUIREMENTS_FAILED_CODE)
      expect(wire.result.outcome.failure.message).toBe(AGENT_REQUIREMENTS_FAILED_MESSAGE)
      expect(wire.result.outcome.failure.retryable).toBeTrue()
    } else {
      throw new Error("expected redacted failed wire")
    }
  })

  test("wire normalization separates invalid wire from normal failure; ambiguous validates", () => {
    const req = validateAgentRequirementsContractRequest(makeReq())
    const ok = validateAgentRequirementsResult(makeSucceeded(req), req)
    expect(normalizePrivateAgentRequirementsWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivateAgentRequirementsWire({ bogus: true }, req)
    expect(invalid).toEqual({ kind: "invalid", detail: AGENT_REQUIREMENTS_INVALID_DETAIL })
    if (invalid.kind === "invalid") {
      expect(new AgentRequirementsValidationError(invalid.detail)).toSatisfy((e) =>
        isAgentRequirementsValidationError(e),
      )
    }
    const amb = makeAgentRequirementsAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateAgentRequirementsResult(amb, req)).not.toThrow()
    expect(() =>
      validateAgentRequirementsResult(
        { ...makeSucceeded(req), data: { requirements: makeResult() }, failure: { code: "x", message: "m", retryable: false } },
        req,
      ),
    ).toThrow()
  })

  test("detached parity compares shared projection only; order ignored; membership gaps are unknown", () => {
    const req = validateAgentRequirementsContractRequest(makeReq())
    const ok = validateAgentRequirementsResult(makeSucceeded(req), req)
    const sdkData = makeResult()
    const parity = compareAgentRequirementsParity(ok, { data: sdkData })
    expect(parity.divergence).toBeNull()
    expect(parity.details.orderIgnored).toBeTrue()
    const statusMismatch = compareAgentRequirementsParity(ok, { error: { message: "boom" } })
    expect(statusMismatch.divergence).toContain("status-mismatch")
    const gap = compareAgentRequirementsParity(ok, { data: makeResult({ skills: [] }) })
    expect(gap.divergence).toBe("agent-requirements-membership-unknown")
    const extGap = compareAgentRequirementsParity(
      ok,
      { data: makeResult({ vscode_extensions: [{ name: "Other", id: "publisher.other" }] }) },
    )
    expect(extGap.divergence).toBe("agent-requirements-membership-unknown")
    const stateMismatch = compareAgentRequirementsParity(ok, { data: makeResult({ state: "blocked" }) })
    expect(stateMismatch.divergence).toBe("agent-requirements-state-mismatch")
    // skills order is never compared: reversed two-item payloads still hold.
    const two = makeResult({
      skills: [
        { name: "skill-a", status: "ready" },
        { name: "skill-b", status: "missing" },
      ],
    })
    const privTwo = validateAgentRequirementsResult({ ...makeSucceeded(req), data: { requirements: two } }, req)
    const sdkReordered = makeResult({
      skills: [
        { name: "skill-b", status: "missing" },
        { name: "skill-a", status: "ready" },
      ],
    })
    expect(compareAgentRequirementsParity(privTwo, { data: sdkReordered }).divergence).toBeNull()
    // vscode_extensions order is never compared either.
    const twoExt = makeResult({
      vscode_extensions: [
        { name: "Ext A", id: "publisher.a" },
        { name: "Ext B", id: "publisher.b" },
      ],
    })
    const privExt = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: twoExt } },
      req,
    )
    const sdkExtReordered = makeResult({
      vscode_extensions: [
        { name: "Ext B", id: "publisher.b" },
        { name: "Ext A", id: "publisher.a" },
      ],
    })
    expect(compareAgentRequirementsParity(privExt, { data: sdkExtReordered }).divergence).toBeNull()
    expect(compareAgentRequirementsParity(privExt, { data: sdkExtReordered }).details.orderIgnored).toBeTrue()
    const transport = compareAgentRequirementsParity(makeAgentRequirementsAmbiguous(req), { data: sdkData })
    expect(transport.divergence).toBe("transport-unknown")
  })

  test("FND-01 canonical multiset: duplicate identity permutation holds; content gaps diverge; key order ignored", () => {
    const req = validateAgentRequirementsContractRequest(makeReq())
    const dupSkills = [
      { name: "skill-a", status: "ready" },
      { name: "skill-a", status: "ready" },
      { name: "skill-b", status: "missing" },
    ]
    const privDup = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: makeResult({ skills: dupSkills }) } },
      req,
    )
    const sdkPermuted = makeResult({
      skills: [
        { name: "skill-b", status: "missing" },
        { name: "skill-a", status: "ready" },
        { name: "skill-a", status: "ready" },
      ],
    })
    expect(compareAgentRequirementsParity(privDup, { data: sdkPermuted }).divergence).toBeNull()
    const dupMcps = [
      { name: "mcp-a", status: "ready" },
      { name: "mcp-a", status: "ready" },
    ]
    const privMcpDup = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: makeResult({ mcps: dupMcps }) } },
      req,
    )
    const sdkMcpPermuted = makeResult({
      mcps: [
        { name: "mcp-a", status: "ready" },
        { name: "mcp-a", status: "ready" },
      ],
    })
    expect(compareAgentRequirementsParity(privMcpDup, { data: sdkMcpPermuted }).divergence).toBeNull()
    const dupExt = [
      { name: "Ext A", id: "publisher.a" },
      { name: "Ext A", id: "publisher.a" },
    ]
    const privExtDup = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: makeResult({ vscode_extensions: dupExt }) } },
      req,
    )
    const sdkExtDup = makeResult({
      vscode_extensions: [
        { name: "Ext A", id: "publisher.a" },
        { name: "Ext A", id: "publisher.a" },
      ],
    })
    expect(compareAgentRequirementsParity(privExtDup, { data: sdkExtDup }).divergence).toBeNull()
    const sdkDupCountGap = makeResult({
      skills: [
        { name: "skill-a", status: "ready" },
        { name: "skill-b", status: "missing" },
      ],
    })
    expect(compareAgentRequirementsParity(privDup, { data: sdkDupCountGap }).divergence).toBe(
      "agent-requirements-membership-unknown",
    )
    const sdkDupContentGap = makeResult({
      skills: [
        { name: "skill-a", status: "ready" },
        { name: "skill-a", status: "error" },
        { name: "skill-b", status: "missing" },
      ],
    })
    const dupContent = compareAgentRequirementsParity(privDup, { data: sdkDupContentGap })
    expect(dupContent.divergence).not.toBeNull()
    expect(["agent-requirements-skills-mismatch", "agent-requirements-membership-unknown"]).toContain(
      dupContent.divergence,
    )
    const sdkExtContentGap = makeResult({
      vscode_extensions: [
        { name: "Ext A", id: "publisher.a" },
        { name: "Ext A2", id: "publisher.a" },
      ],
    })
    const extContent = compareAgentRequirementsParity(privExtDup, { data: sdkExtContentGap })
    expect(extContent.divergence).not.toBeNull()
    expect(["agent-requirements-vscode-extensions-mismatch", "agent-requirements-membership-unknown"]).toContain(
      extContent.divergence,
    )
    const privKeyOrder = validateAgentRequirementsResult(
      {
        ...makeSucceeded(req),
        data: {
          requirements: makeResult({
            skills: [{ status: "ready", name: "skill-a" }],
            vscode_extensions: [{ id: "publisher.a", name: "Ext A" }],
          }),
        },
      },
      req,
    )
    const sdkKeyOrder = makeResult({
      skills: [{ name: "skill-a", status: "ready" }],
      vscode_extensions: [{ name: "Ext A", id: "publisher.a" }],
    })
    expect(compareAgentRequirementsParity(privKeyOrder, { data: sdkKeyOrder }).divergence).toBeNull()
  })

  test("FND-02 error parity compares code and message; missing/present semantics unchanged", () => {
    const req = validateAgentRequirementsContractRequest(makeReq())
    const errBase = { state: "error", error: { code: "discovery_failed", message: "disk boom" } }
    const privErr = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: makeResult(errBase) } },
      req,
    )
    expect(compareAgentRequirementsParity(privErr, { data: makeResult(errBase) }).divergence).toBeNull()
    const sameCodeDiffMsg = compareAgentRequirementsParity(
      privErr,
      { data: makeResult({ state: "error", error: { code: "discovery_failed", message: "other detail" } }) },
    )
    expect(sameCodeDiffMsg.divergence).toBe("agent-requirements-error-mismatch")
    const diffCodeSameMsg = compareAgentRequirementsParity(
      privErr,
      { data: makeResult({ state: "error", error: { code: "mcp_status_failed", message: "disk boom" } }) },
    )
    expect(diffCodeSameMsg.divergence).toBe("agent-requirements-error-mismatch")
    const missingVsPresent = compareAgentRequirementsParity(privErr, { data: makeResult({ state: "error" }) })
    expect(missingVsPresent.divergence).toBe("agent-requirements-error-mismatch")
    const privNoErr = validateAgentRequirementsResult(
      { ...makeSucceeded(req), data: { requirements: makeResult({ state: "error" }) } },
      req,
    )
    const presentVsMissing = compareAgentRequirementsParity(privNoErr, { data: makeResult(errBase) })
    expect(presentVsMissing.divergence).toBe("agent-requirements-error-mismatch")
  })
})
