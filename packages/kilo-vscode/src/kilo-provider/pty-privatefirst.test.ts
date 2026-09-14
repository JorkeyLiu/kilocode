import { describe, expect, test } from "bun:test"
import { buildPtyRemoveReq, buildPtyUpdateReq, removePtyPrivateFirst, updatePtyPrivateFirst } from "./pty-privatefirst"
import { canonicalPtyRemoveOpId, canonicalPtyUpdateOpId } from "../services/cli-backend/serve-private-pty-contract"

const DIR = "/tmp/kilo-pty"
const PTY = "pty_aaaaaaaaaaaaaaaaaaaaaaaaaa"

function okUpdateFor(req: ReturnType<typeof buildPtyUpdateReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { updated: true },
  }
}

function okRemoveFor(req: ReturnType<typeof buildPtyRemoveReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { removed: true },
  }
}

function notFoundFor(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  const failure = { code: "pty.not_found", message: "pty not found", retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function terminalFor(
  req: { requestId: string; opId: string; op: string; idempotencyKey: string },
  code = "scope_mismatch",
) {
  const failure = { code, message: "m", retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function retryableFor(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  const failure = { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function ambiguousFor(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function transportFor(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  const failure = { code: "transport", message: "private pty-update transport failed", retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function connFor(build: (req: never) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privatePtyUpdateOutcomeWithHandle: (q: never) => {
      if (seen) seen.n += 1
      return {
        id: 7,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => {
          if (seen) seen.cancel += 1
          return true
        },
      }
    },
    privatePtyRemoveOutcomeWithHandle: (q: never) => {
      if (seen) seen.n += 1
      return {
        id: 7,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => {
          if (seen) seen.cancel += 1
          return true
        },
      }
    },
  }
}

function sdkUpdate(seen: { n: number; directory?: unknown; ptyID?: unknown; size?: unknown }, error?: unknown) {
  return {
    pty: {
      update: async (args: { directory: string; ptyID: string; size: { rows: number; cols: number } }) => {
        seen.n += 1
        seen.directory = args.directory
        seen.ptyID = args.ptyID
        seen.size = args.size
        if (error) return { data: undefined, error }
        return { data: {}, error: undefined }
      },
      remove: async () => ({ data: {}, error: undefined }),
    },
  }
}

function sdkRemove(seen: { n: number; directory?: unknown; ptyID?: unknown }, error?: unknown) {
  return {
    pty: {
      update: async () => ({ data: {}, error: undefined }),
      remove: async (args: { directory: string; ptyID: string }) => {
        seen.n += 1
        seen.directory = args.directory
        seen.ptyID = args.ptyID
        if (error) return { data: undefined, error }
        return { data: true, error: undefined }
      },
    },
  }
}

describe("pty private-first", () => {
  test("identity binds opaque pathless token with ptyID in context and opId", () => {
    const upd = buildPtyUpdateReq(DIR, PTY, 24, 80)
    expect(upd.opId).toBe(upd.idempotencyKey)
    expect(upd.opId.startsWith(`pty-update:${PTY}:`)).toBeTrue()
    expect(upd.context.ptyID).toBe(PTY)
    expect(upd.payload.size).toEqual({ rows: 24, cols: 80 })
    const token = upd.opId.split(":")[2]!
    expect(canonicalPtyUpdateOpId(PTY, token)).toBe(upd.opId)
    const rem = buildPtyRemoveReq(DIR, PTY)
    expect(rem.opId.startsWith(`pty-remove:${PTY}:`)).toBeTrue()
    const rtoken = rem.opId.split(":")[2]!
    expect(canonicalPtyRemoveOpId(PTY, rtoken)).toBe(rem.opId)
  })

  test("private update success returns with zero SDK", async () => {
    const seen = { n: 0 }
    const out = await updatePtyPrivateFirst({
      connection: connFor((q) => okUpdateFor(q as never)) as never,
      getClient: () => sdkUpdate(seen) as never,
      directory: DIR,
      ptyID: PTY,
      rows: 24,
      cols: 80,
    })
    expect(out).toEqual({ kind: "ok", via: "private" })
    expect(seen.n).toBe(0)
  })

  test("private pty.not_found is success-equivalent with zero SDK", async () => {
    const seen = { n: 0 }
    const out = await removePtyPrivateFirst({
      connection: connFor((q) => notFoundFor(q as never)) as never,
      getClient: () => sdkRemove(seen) as never,
      directory: DIR,
      ptyID: PTY,
    })
    expect(out).toEqual({ kind: "ok", via: "private", gone: true })
    expect(seen.n).toBe(0)
  })

  test("terminal scope_mismatch closes with zero SDK and no replay", async () => {
    const seen = { n: 0 }
    const out = await updatePtyPrivateFirst({
      connection: connFor((q) => terminalFor(q as never, "scope_mismatch")) as never,
      getClient: () => sdkUpdate(seen) as never,
      directory: DIR,
      ptyID: PTY,
      rows: 24,
      cols: 80,
    })
    expect(out).toEqual({ kind: "terminal", code: "scope_mismatch" })
    expect(seen.n).toBe(0)
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "retryable", "closed", "timeout"] as const) {
    test(`${reason} takes exactly one same-tuple SDK fallback`, async () => {
      const seen = { n: 0, directory: undefined as unknown, ptyID: undefined as unknown, size: undefined as unknown }
      let conn: unknown
      if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
      else if (reason === "invalid") conn = connFor(() => ({ garbled: true }))
      else if (reason === "ambiguous") conn = connFor((q) => ambiguousFor(q as never))
      else if (reason === "retryable") conn = connFor((q) => retryableFor(q as never))
      else if (reason === "closed")
        conn = {
          isPrivateAvailable: () => true,
          privatePtyUpdateOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
          privatePtyRemoveOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
        }
      else
        conn = {
          isPrivateAvailable: () => true,
          privatePtyUpdateOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => true }),
          privatePtyRemoveOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => true }),
        }
      const out = await updatePtyPrivateFirst({
        connection: conn as never,
        getClient: () => sdkUpdate(seen) as never,
        directory: DIR,
        ptyID: PTY,
        rows: 24,
        cols: 80,
        timeoutMs: reason === "timeout" ? 20 : 3000,
      })
      expect(seen.n).toBe(1)
      expect(seen.directory).toBe(DIR)
      expect(seen.ptyID).toBe(PTY)
      expect(seen.size).toEqual({ rows: 24, cols: 80 })
      expect(out).toEqual({ kind: "ok", via: "sdk" })
    })
  }

  test("validated private transport failure takes exactly one same-tuple SDK fallback", async () => {
    const seen = { n: 0, directory: undefined as unknown, ptyID: undefined as unknown, size: undefined as unknown }
    const out = await updatePtyPrivateFirst({
      connection: connFor((q) => transportFor(q as never)) as never,
      getClient: () => sdkUpdate(seen) as never,
      directory: DIR,
      ptyID: PTY,
      rows: 24,
      cols: 80,
    })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(seen.n).toBe(1)
    expect(seen.directory).toBe(DIR)
    expect(seen.ptyID).toBe(PTY)
    expect(seen.size).toEqual({ rows: 24, cols: 80 })
  })

  test("missing capability falls back once", async () => {
    const seen = { n: 0 }
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("missing pty/update capability")
      },
    }
    const out = await updatePtyPrivateFirst({
      connection: conn as never,
      getClient: () => sdkUpdate(seen) as never,
      directory: DIR,
      ptyID: PTY,
      rows: 24,
      cols: 80,
    })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(seen.n).toBe(1)
  })

  test("SDK 404 (PtyNotFoundError or status 404) is success-equivalent", async () => {
    for (const err of [
      { _tag: "PtyNotFoundError", ptyID: PTY },
      { status: 404 },
      { name: "NotFoundError", status: 404 },
    ]) {
      const seen = { n: 0 }
      const out = await removePtyPrivateFirst({
        connection: { isPrivateAvailable: () => false } as never,
        getClient: () => sdkRemove(seen, err) as never,
        directory: DIR,
        ptyID: PTY,
      })
      expect(out).toEqual({ kind: "ok", via: "sdk", gone: true })
      expect(seen.n).toBe(1)
    }
  })

  test("timeout exact-cancels the pending by id with opaque opId only", async () => {
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privatePtyUpdateOutcomeWithHandle: (q: { opId: string }) => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
      privatePtyRemoveOutcomeWithHandle: () => ({ id: 42, promise: new Promise(() => {}), cancel: () => true }),
    }
    const seen = { n: 0 }
    const out = await updatePtyPrivateFirst({
      connection: conn as never,
      getClient: () => sdkUpdate(seen) as never,
      directory: DIR,
      ptyID: PTY,
      rows: 24,
      cols: 80,
      timeoutMs: 20,
    })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(cancelled ?? "").toContain("private pty-update timeout")
    expect(cancelled ?? "").toContain("pty-update:")
    expect(cancelled ?? "").not.toContain(DIR)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildPtyUpdateReq(DIR, PTY, 24, 80)
    const raw = okUpdateFor(req)
    const { wrapPtyUpdateOutcomeForOwner } = await import("../services/cli-backend/serve-private-pty")
    const wrapped = wrapPtyUpdateOutcomeForOwner(
      { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
      () => true,
      () => {},
      { id: 1, promise: Promise.resolve({ kind: "valid" as const, result: raw }) },
      req,
    )
    const outcome = await wrapped.promise
    expect(outcome.kind).toBe("valid")
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const req = buildPtyUpdateReq(DIR, PTY, 24, 80)
    const raw = ambiguousFor(req)
    const { wrapPtyUpdateOutcomeForOwner } = await import("../services/cli-backend/serve-private-pty")
    const wrapped = wrapPtyUpdateOutcomeForOwner(
      { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
      () => true,
      () => {},
      { id: 1, promise: Promise.resolve({ kind: "valid" as const, result: raw }) },
      req,
    )
    const outcome = await wrapped.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect((outcome.result as { status: string }).status).toBe("ambiguous")
  })
})
