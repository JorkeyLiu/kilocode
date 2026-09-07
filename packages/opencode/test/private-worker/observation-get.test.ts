import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import {
  OBSERVATION_METHODS,
  OBSERVATION_VERSION,
  ObservationController,
  type ObservationDeps,
  type ObservationGetResult,
} from "../../src/private-worker/observation"

function makeController(
  fakeGet?: (input: { directory: string; sessionId: string }) => Promise<ObservationGetResult>,
): { ctrl: ObservationController; deps: ObservationDeps } {
  const deps: ObservationDeps = {
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas" as const, cursor: 0, entries: [] }),
    ack: async () => {},
    ...(fakeGet ? { get: fakeGet } : {}),
  }
  const ctrl = new ObservationController(deps)
  return { ctrl, deps }
}

function makePair(ctrl: ObservationController) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server, aToB, bToA }
}

const dir = "/tmp/ws"
const sid = "ses_a001"
const proj = "proj_get"

function foundSession(overrides?: Partial<ObservationGetResult & { status: "found" }>): ObservationGetResult {
  const base: ObservationGetResult = {
    v: "1.0",
    status: "found",
    session: {
      id: sid,
      title: "hello",
      parentID: null,
      directory: dir,
      projectID: proj,
      createdAt: 100,
      updatedAt: 200,
    },
  }
  if (!overrides) return base
  const merged = { ...base, ...overrides } as unknown as ObservationGetResult
  if (overrides.session) (merged as unknown as { session: unknown }).session = { ...((base as unknown) as { session: Record<string, unknown> }).session, ...((overrides.session as unknown) as Record<string, unknown>) }
  return merged
}

describe("observation/get wire validation", () => {
  it("found delegates with canonical directory and returns minimal projection", async () => {
    let captured: { directory: string; sessionId: string } | undefined
    const fake = foundSession()
    const { ctrl } = makeController(async (input) => {
      captured = input
      return fake
    })
    const pair = makePair(ctrl)
    const res = (await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })) as ObservationGetResult
    expect(res).toEqual(fake)
    expect(captured!.directory).toBe(dir)
    expect(captured!.sessionId).toBe(sid)
    const sess = (res as unknown as { status: "found"; session: Record<string, unknown> }).session
    expect(Object.keys(sess).sort()).toEqual(["createdAt", "directory", "id", "parentID", "projectID", "title", "updatedAt"])
    pair.client.dispose()
    pair.server.dispose()
  })

  it("found with empty string agent is preserved exactly including empty string", async () => {
    const sessWithEmpty = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, agent: "" } as unknown as Record<string, unknown>
    const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session: sessWithEmpty } as unknown as ObservationGetResult))
    const pair = makePair(ctrl)
    const res = (await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })) as { status: string; session: Record<string, unknown> }
    expect(res.status).toBe("found")
    expect(res.session.agent).toBe("")
    expect(Object.keys(res.session).includes("agent")).toBe(true)
    // also ensures non-empty agent still works
    const sessWithAgent = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, agent: "agentX" } as unknown as Record<string, unknown>
    const { ctrl: ctrl2 } = makeController(async () => ({ v: "1.0", status: "found", session: sessWithAgent } as unknown as ObservationGetResult))
    const pair2 = makePair(ctrl2)
    const res2 = (await pair2.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })) as { status: string; session: Record<string, unknown> }
    expect(res2.session.agent).toBe("agentX")
    pair.client.dispose()
    pair.server.dispose()
    pair2.client.dispose()
    pair2.server.dispose()
  })

  it("canonical directory is lexically normalized before delegation", async () => {
    let captured: string | undefined
    const { ctrl } = makeController(async (input) => {
      captured = input.directory
      return foundSession({ session: { directory: "/tmp/ws" } } as unknown as Partial<ObservationGetResult & { status: "found" }>) as ObservationGetResult
    })
    // found session must use canonical request directory, not raw spelling; adapter would return canonical, but here fake uses canonical already
    const pair = makePair(ctrl)
    await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/ws/../ws", sessionId: sid })
    expect(captured).toBe("/tmp/ws")
    pair.client.dispose()
    pair.server.dispose()
  })

  it("not_found and scope_mismatch resolve (not reject) with exact keys, no session", async () => {
    const { ctrl: ctrlNF } = makeController(async () => ({ v: "1.0", status: "not_found" }))
    const pairNF = makePair(ctrlNF)
    const nf = (await pairNF.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })) as ObservationGetResult
    expect(nf).toEqual({ v: "1.0", status: "not_found" })
    expect(Object.keys(nf as unknown as Record<string, unknown>).sort()).toEqual(["status", "v"])
    pairNF.client.dispose()
    pairNF.server.dispose()

    const { ctrl: ctrlSM } = makeController(async () => ({ v: "1.0", status: "scope_mismatch" }))
    const pairSM = makePair(ctrlSM)
    const sm = (await pairSM.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })) as ObservationGetResult
    expect(sm).toEqual({ v: "1.0", status: "scope_mismatch" })
    expect(Object.keys(sm as unknown as Record<string, unknown>).sort()).toEqual(["status", "v"])
    pairSM.client.dispose()
    pairSM.server.dispose()
  })

  it("peer-level not_found/scope_mismatch resolve rather than reject with MethodNotFound/InvalidParams", async () => {
    const { ctrl } = makeController(async (input) => {
      if (input.sessionId === "ses_missing") return { v: "1.0", status: "not_found" }
      if (input.sessionId === "ses_other_dir") return { v: "1.0", status: "scope_mismatch" }
      return foundSession()
    })
    const pair = makePair(ctrl)
    const a = await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_missing" })
    expect((a as { status: string }).status).toBe("not_found")
    const b = await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_other_dir" })
    expect((b as { status: string }).status).toBe("scope_mismatch")
    // ensure they did not reject
    let rejected = false
    try {
      await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_missing" })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(false)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("rejects invalid version, unknown fields, missing fields, invalid directory/sessionId", async () => {
    const { ctrl } = makeController(async () => foundSession())
    const pair = makePair(ctrl)
    const bad: unknown[] = [
      { v: "9.9", directory: dir, sessionId: sid },
      { v: "1.0", directory: dir, sessionId: sid, extra: 1 },
      { v: "1.0", directory: dir, sessionId: sid, unexpected: "x" },
      { v: "1.0", directory: dir },
      { v: "1.0", sessionId: sid },
      { directory: dir, sessionId: sid },
      { v: "1.0", directory: "", sessionId: sid },
      { v: "1.0", directory: "relative/path", sessionId: sid },
      { v: "1.0", directory: dir, sessionId: "" },
      { v: "1.0", directory: dir, sessionId: "bad" },
      { v: "1.0", directory: dir, sessionId: "ses\0bad" },
      { v: "1.0", directory: dir, sessionId: 123 },
      { v: "1.0", directory: null, sessionId: sid },
      null,
      "string",
      {},
    ]
    for (const params of bad) {
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("MethodNotFound when get deps absent", async () => {
    const { ctrl } = makeController()
    delete (ctrl as unknown as { deps: ObservationDeps }).deps.get
    const pair = makePair(ctrl)
    try {
      await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("malformed variant shape -> InternalError", async () => {
    const cases: Array<{ fake: unknown; desc: string }> = [
      { fake: { v: "9.9", status: "not_found" }, desc: "wrong version" },
      { fake: { v: "1.0", status: "not_found", session: { id: sid } }, desc: "not_found with session" },
      { fake: { v: "1.0", status: "not_found", extra: 1 }, desc: "not_found extra field" },
      { fake: { v: "1.0", status: "scope_mismatch", session: { id: sid } }, desc: "scope_mismatch with session" },
      { fake: { v: "1.0", status: "scope_mismatch", extra: 1 }, desc: "scope_mismatch extra field" },
      { fake: { v: "1.0", status: "unknown" }, desc: "unknown status" },
      { fake: { v: "1.0" }, desc: "missing status" },
      { fake: { v: "1.0", status: "found" }, desc: "found missing session" },
      { fake: { v: "1.0", status: "found", session: { id: sid } }, desc: "found session incomplete" },
      { fake: { v: "1.0", status: "found", session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, extra: 1 } }, desc: "found session extra field" },
      { fake: { v: "1.0", status: "found", session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 }, extra: 1 }, desc: "found extra top field" },
      { fake: null, desc: "null result" },
      { fake: "string", desc: "string result" },
    ]
    for (const { fake } of cases) {
      const { ctrl } = makeController(async () => fake as ObservationGetResult)
      const pair = makePair(ctrl)
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      pair.client.dispose()
      pair.server.dispose()
    }
  })

  it("found shape validation -> InternalError for session field mismatches", async () => {
    const baseFound = () => foundSession()
    const malformedSessions: Array<{ session: Record<string, unknown>; desc: string }> = [
      { session: { id: "bad", title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "invalid id" },
      { session: { id: "ses_other", title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "id mismatch" },
      { session: { id: sid, title: 123 as unknown as string, parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "title not string" },
      { session: { id: sid, title: "t", parentID: "bad", directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 } as unknown as Record<string, unknown>, desc: "parentID invalid" },
      { session: { id: sid, title: "t", directory: dir, projectID: proj, createdAt: 1, updatedAt: 2 } as unknown as Record<string, unknown>, desc: "parentID missing" },
      { session: { id: sid, title: "t", parentID: null, directory: "relative/path", projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "directory not absolute" },
      { session: { id: sid, title: "t", parentID: null, directory: "/other/ws", projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "directory mismatch" },
      { session: { id: sid, title: "t", parentID: null, directory: "/tmp/ws/", projectID: proj, createdAt: 1, updatedAt: 2 }, desc: "directory not canonical" },
      { session: { id: sid, title: "t", parentID: null, directory: dir, projectID: "", createdAt: 1, updatedAt: 2 }, desc: "projectID empty" },
      { session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: NaN, updatedAt: 2 }, desc: "createdAt NaN" },
      { session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: Infinity }, desc: "updatedAt Infinity" },
      { session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, agent: 123 as unknown as string }, desc: "agent not string" },
      { session: { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, agent: "a\0b" }, desc: "agent contains null byte" },
    ]
    for (const { session } of malformedSessions) {
      const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session } as unknown as ObservationGetResult))
      const pair = makePair(ctrl)
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      pair.client.dispose()
      pair.server.dispose()
    }
  })

  it("summary validation: finite numbers, diffs shape, patch forbidden, status restricted", async () => {
    const cases: Array<{ summary: Record<string, unknown>; desc: string }> = [
      { summary: { additions: NaN, deletions: 0, files: 0 }, desc: "additions NaN" },
      { summary: { additions: Infinity, deletions: 0, files: 0 }, desc: "additions Infinity" },
      { summary: { additions: 0, deletions: "0" as unknown as number, files: 0 }, desc: "deletions not number" },
      { summary: { additions: 0, deletions: 0, files: 0, extra: 1 }, desc: "summary extra key" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: "not-array" as unknown as unknown }, desc: "diffs not array" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [123 as unknown as object] }, desc: "diff entry not object" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 0, patch: "p" }] } as unknown as Record<string, unknown>, desc: "diff patch forbidden" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 0, status: "renamed" }] } as unknown as Record<string, unknown>, desc: "diff status invalid" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 0, status: 123 as unknown as string }] } as unknown as Record<string, unknown>, desc: "diff status not string" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: NaN, deletions: 0 }] } as unknown as Record<string, unknown>, desc: "diff additions NaN" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: Infinity }] } as unknown as Record<string, unknown>, desc: "diff deletions Infinity" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 0, file: 123 as unknown as string }] } as unknown as Record<string, unknown>, desc: "diff file not string" },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 0, unknown: 1 }] } as unknown as Record<string, unknown>, desc: "diff extra key" },
    ]
    for (const { summary } of cases) {
      const sess = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, summary } as unknown as Record<string, unknown>
      const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session: sess } as unknown as ObservationGetResult))
      const pair = makePair(ctrl)
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      pair.client.dispose()
      pair.server.dispose()
    }
    // valid summary cases should pass
    const validSummaries: Array<Record<string, unknown>> = [
      { additions: 0, deletions: 0, files: 0 },
      { additions: 1.5, deletions: 2.5, files: 1 },
      { additions: -5, deletions: 0, files: 0 }, // finite allows negative per canonical Schema.Finite
      { additions: 0, deletions: 0, files: 0, diffs: [] },
      { additions: 0, deletions: 0, files: 0, diffs: [{ file: "a.txt", additions: 1, deletions: 0, status: "added" }] },
      { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 1, deletions: 1 }] },
    ]
    for (const summary of validSummaries) {
      const sess = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, summary } as unknown as Record<string, unknown>
      const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session: sess } as unknown as ObservationGetResult))
      const pair = makePair(ctrl)
      const res = await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
      expect((res as { status: string }).status).toBe("found")
      pair.client.dispose()
      pair.server.dispose()
    }
  })

  it("revert validation: messageID, partID, allowed keys", async () => {
    const badReverts: Array<Record<string, unknown>> = [
      { messageID: "bad" },
      { messageID: "msg_1", partID: "bad" },
      { messageID: "msg_1", extra: 1 },
      { messageID: 123 as unknown as string },
      { messageID: "msg_1", partID: 123 as unknown as string },
      { messageID: "msg_1", snapshot: 123 as unknown as string },
      { messageID: "msg_1", diff: 123 as unknown as string },
    ]
    for (const revert of badReverts) {
      const sess = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, revert } as unknown as Record<string, unknown>
      const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session: sess } as unknown as ObservationGetResult))
      const pair = makePair(ctrl)
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      pair.client.dispose()
      pair.server.dispose()
    }
    const validReverts: Array<Record<string, unknown>> = [
      { messageID: "msg_1" },
      { messageID: "msg_1", partID: "prt_1" },
      { messageID: "msg_1", snapshot: "s", diff: "d" },
      { messageID: "msg_1", partID: "prt_1", snapshot: "s", diff: "d" },
    ]
    for (const revert of validReverts) {
      const sess = { id: sid, title: "t", parentID: null, directory: dir, projectID: proj, createdAt: 1, updatedAt: 2, revert } as unknown as Record<string, unknown>
      const { ctrl } = makeController(async () => ({ v: "1.0", status: "found", session: sess } as unknown as ObservationGetResult))
      const pair = makePair(ctrl)
      const res = await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
      expect((res as { status: string }).status).toBe("found")
      pair.client.dispose()
      pair.server.dispose()
    }
  })

  it("transport/internal failures still reject with JSON-RPC errors, not domain statuses", async () => {
    const { ctrl } = makeController(async () => {
      throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
    })
    const pair = makePair(ctrl)
    try {
      await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      expect(String((e as Error).message)).not.toBe("not_found")
      expect(String((e as Error).message)).not.toBe("scope_mismatch")
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("validation failures for deps.get returning non-object or missing v/status still InternalError", async () => {
    const badReturns: unknown[] = [null, {}, { v: "1.0", status: "found", session: null }, { status: "not_found" }, { v: "1.0", status: "found", session: { id: sid } }]
    for (const fake of badReturns) {
      const { ctrl } = makeController(async () => fake as ObservationGetResult)
      const pair = makePair(ctrl)
      try {
        await pair.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      pair.client.dispose()
      pair.server.dispose()
    }
  })
})
