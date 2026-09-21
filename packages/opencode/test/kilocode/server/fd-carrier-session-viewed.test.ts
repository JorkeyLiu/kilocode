import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { KiloViewers } from "../../../src/kilocode/presence/service"
import * as KiloSessionsModule from "../../../src/kilo-sessions/kilo-sessions"
import { INTERNAL_MESSAGE, VALIDATION_MESSAGE } from "../../../src/kilocode/presence/session-viewed-private"
import { disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k]
  if (typeof v !== "string") throw new Error(`expected string ${k}`)
  return v
}
function bool(r: Record<string, unknown>, k: string): boolean {
  const v = r[k]
  if (typeof v !== "boolean") throw new Error(`expected boolean ${k}`)
  return v
}

type ViewedResult = {
  v: number
  requestId: string
  op: string
  status: string
  accepted: boolean
  data?: { applied: boolean }
  failure?: { code: string; message: string; retryable: boolean }
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
}

function asViewedResult(v: unknown): ViewedResult {
  const r = asRecord(v)
  if (r.v !== 1) throw new Error("expected v 1")
  const requestId = str(r, "requestId")
  const op = str(r, "op")
  if (op !== "session/viewed") throw new Error("expected op session/viewed")
  const status = str(r, "status")
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("bad status")
  const accepted = bool(r, "accepted")
  const outcome = asRecord(r.outcome)
  if (typeof outcome.type !== "string") throw new Error("bad outcome.type")
  if (typeof outcome.time !== "number") throw new Error("bad outcome.time")
  let failure: ViewedResult["failure"]
  if (r.failure !== undefined) {
    const f = asRecord(r.failure)
    failure = { code: str(f, "code"), message: str(f, "message"), retryable: bool(f, "retryable") }
  }
  let data: ViewedResult["data"]
  if (r.data !== undefined) {
    const d = asRecord(r.data)
    data = { applied: bool(d, "applied") }
  }
  return { v: 1, requestId, op, status, accepted, outcome: outcome as ViewedResult["outcome"], ...(data ? { data } : {}), ...(failure ? { failure } : {}) }
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/viewed"],
    }),
  )
}

function viewedReq(dir: string, viewerId: string, sequence: number, attached: string[], visible: string[], requestId: string, workspace?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ctx: Record<string, unknown> = { directory: dir }
  if (workspace !== undefined) ctx.workspace = workspace
  return {
    v: 1,
    requestId,
    op: "session/viewed",
    context: ctx,
    payload: { viewer: { id: viewerId, active: true, sequence }, attached, visible },
    ...extra,
  }
}

function capsOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((e): e is string => typeof e === "string")
}

async function getViewersService(): Promise<KiloViewers.Interface> {
  return AppRuntime.runPromise(Effect.gen(function* () { return yield* KiloViewers.Service }))
}

describe("fd-carrier session/viewed (private-first presence)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("initialize advertises session/viewed capability", async () => {
    const { carrier, ext } = linked()
    try {
      const res = await init(ext)
      expect(capsOf(res).includes("session/viewed")).toBeTrue()
      expect(res.protocolVersion).toBe("1.0")
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("valid request via fd-carrier succeeds and updates KiloViewers presence", async () => {
    const svc = await getViewersService()
    const orig = svc.update
    const seen: unknown[] = []
    // wrap to capture snapshots that reach owner
    ;(svc as unknown as { update: KiloViewers.Interface["update"] }).update = ((snap: unknown) =>
      Effect.gen(function* () {
        const out = yield* (orig as unknown as (s: unknown) => Effect.Effect<void>)(snap as never)
        seen.push(snap)
        return out
      })) as unknown as KiloViewers.Interface["update"]
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const uid = crypto.randomUUID()
        const dir = "/tmp"
        const req = viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-valid-1")
        const raw = await ext.request("session/viewed", req)
        const res = asViewedResult(raw)
        expect(res.status).toBe("succeeded")
        expect(res.accepted).toBeTrue()
        expect(res.requestId).toBe("req-valid-1")
        expect(res.op).toBe("session/viewed")
        expect(res.v).toBe(1)
        expect(res.data).toEqual({ applied: true })
        expect(res.outcome.type).toBe("succeeded")
        expect(typeof res.outcome.time).toBe("number")
        // presence actually updated
        expect(seen.length).toBe(1)
        const snap = seen[0] as { viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }
        expect(snap.viewer.id).toBe(uid)
        expect(snap.viewer.active).toBeTrue()
        expect(snap.viewer.sequence).toBe(1)
        expect(snap.attached).toEqual(["ses_a"])
        expect(snap.visible).toEqual(["ses_a"])
        // workspace routing label is accepted and stays out of owner payload
        const reqWs = viewedReq(dir, crypto.randomUUID(), 2, ["ses_b"], ["ses_b"], "req-ws", "ws1")
        const rawWs = await ext.request("session/viewed", reqWs)
        const resWs = asViewedResult(rawWs)
        expect(resWs.status).toBe("succeeded")
        expect(resWs.accepted).toBeTrue()
        expect(seen.length).toBe(2)
        const snapWs = seen[1] as { viewer: { id: string } }
        expect(snapWs.viewer.id).toBe((reqWs.payload as unknown as { viewer: { id: string } }).viewer.id)
        // active false and sequence 0 also accepted
        const uid2 = crypto.randomUUID()
        const req2 = viewedReq(dir, uid2, 0, ["ses_c"], ["ses_c"], "req-valid-2", undefined, {})
        // patch active false via payload override
        ;((req2.payload as unknown as { viewer: { active: boolean } }).viewer as { active: boolean }).active = false
        const raw2 = await ext.request("session/viewed", req2)
        const res2 = asViewedResult(raw2)
        expect(res2.status).toBe("succeeded")
        expect(seen.length).toBe(3)
        const snap2 = seen[2] as { viewer: { active: boolean; sequence: number } }
        expect(snap2.viewer.active).toBeFalse()
        expect(snap2.viewer.sequence).toBe(0)
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(svc as unknown as { update: unknown }).update = orig
    }
  })

  test("sequence monotonic: newer updates, older does not regress, requestId is not durable", async () => {
    // Observe actual owner mutation via the canonical side-effect `KiloSessions.setAttachedSessions`
    // which is only invoked when the viewer snapshot is accepted (monotonic check passes).
    // Distinct attached ids guarantee a visible push per accepted mutation; rejected lower/equal
    // sequences produce no push, without duplicating the sequence comparison in the assertion.
    const origSet = (KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: (ids: readonly string[]) => void }).setAttachedSessions
    const sets: string[][] = []
    ;(KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: (ids: readonly string[]) => void }).setAttachedSessions = (ids) => {
      sets.push([...ids])
      return origSet(ids)
    }
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const uid = crypto.randomUUID()
        const dir = "/tmp"
        const tag = Math.random().toString(36).slice(2, 8)
        const sesA = `ses_${tag}a`
        const sesB = `ses_${tag}b`
        const sesC = `ses_${tag}c`
        const sesD = `ses_${tag}d`
        const sesE = `ses_${tag}e`
        // seq 5
        const r1 = viewedReq(dir, uid, 5, [sesA], [sesA], "req-seq-5")
        const res1 = asViewedResult(await ext.request("session/viewed", r1))
        expect(res1.status).toBe("succeeded")
        // first push contains the fresh sesA (global union now includes it)
        expect(sets.length).toBe(1)
        expect(sets[0]!.includes(sesA)).toBeTrue()
        // newer seq 6 with different attached
        const r2 = viewedReq(dir, uid, 6, [sesB], [sesB], "req-seq-6")
        const res2 = asViewedResult(await ext.request("session/viewed", r2))
        expect(res2.status).toBe("succeeded")
        expect(sets.length).toBe(2)
        expect(sets[1]!.includes(sesB)).toBeTrue()
        expect(sets[1]!.includes(sesA)).toBeFalse()
        // older seq 5 again should not regress - transport still succeeds but owner drops, no new side-effect
        const rOld = viewedReq(dir, uid, 5, [sesC], [sesC], "req-seq-old")
        const resOld = asViewedResult(await ext.request("session/viewed", rOld))
        expect(resOld.status).toBe("succeeded")
        expect(sets.length).toBe(2)
        // equal sequence also dropped
        const rEq = viewedReq(dir, uid, 6, [sesD], [sesD], "req-seq-eq")
        const resEq = asViewedResult(await ext.request("session/viewed", rEq))
        expect(resEq.status).toBe("succeeded")
        expect(sets.length).toBe(2)
        // requestId reuse with higher sequence still updates (requestId not durable)
        const rReuse = viewedReq(dir, uid, 7, [sesE], [sesE], "req-seq-5") // same requestId as first but higher seq
        const resReuse = asViewedResult(await ext.request("session/viewed", rReuse))
        expect(resReuse.status).toBe("succeeded")
        expect(resReuse.requestId).toBe("req-seq-5")
        expect(sets.length).toBe(3)
        expect(sets[2]!.includes(sesE)).toBeTrue()
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: unknown }).setAttachedSessions = origSet
    }
  })

  test("invalid envelopes are rejected as validation.failed without owner write", async () => {
    const svc = await getViewersService()
    const orig = svc.update
    let calls = 0
    ;(svc as unknown as { update: KiloViewers.Interface["update"] }).update = ((snap: unknown) =>
      Effect.gen(function* () {
        calls += 1
        return yield* (orig as unknown as (x: unknown) => Effect.Effect<void>)(snap as never)
      })) as unknown as KiloViewers.Interface["update"]
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const uid = crypto.randomUUID()
        const dir = "/tmp"
        const base = viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-base")
        const cases: Array<{ label: string; req: Record<string, unknown> }> = [
          { label: "missing requestId", req: { ...base, requestId: undefined } as unknown as Record<string, unknown> },
          { label: "empty requestId", req: viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "") },
          { label: "requestId with path", req: viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "a/b") },
          { label: "wrong op", req: { ...base, op: "session/other" } },
          { label: "wrong version", req: { ...base, v: 2 } },
          { label: "sequence negative", req: viewedReq(dir, uid, -1, ["ses_a"], ["ses_a"], "req-neg") },
          { label: "sequence float", req: viewedReq(dir, uid, 1.5, ["ses_a"], ["ses_a"], "req-float") },
          { label: "sequence unsafe", req: viewedReq(dir, uid, Number.MAX_SAFE_INTEGER + 1, ["ses_a"], ["ses_a"], "req-unsafe") },
          { label: "attached not array", req: { ...base, payload: { viewer: { id: uid, active: true, sequence: 1 }, attached: "ses_a", visible: ["ses_a"] } } },
          { label: "visible not array", req: { ...base, payload: { viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: "ses_a" } } },
          { label: "attached over cap", req: viewedReq(dir, uid, 1, Array.from({ length: 1001 }, () => "ses_a"), ["ses_a"], "req-over-attached") },
          { label: "visible over cap", req: viewedReq(dir, uid, 1, ["ses_a"], Array.from({ length: 200 }, () => "ses_a"), "req-over-visible") },
          { label: "illegal session id", req: viewedReq(dir, uid, 1, ["nope"], ["ses_a"], "req-bad-sid") },
          { label: "over-long session id", req: viewedReq(dir, uid, 1, [`ses_${"x".repeat(231)}`], ["ses_a"], "req-long") },
          { label: "null byte session id", req: viewedReq(dir, uid, 1, ["ses_a\0"], ["ses_a"], "req-nul") },
          { label: "viewer id not uuid", req: viewedReq(dir, "not-a-uuid", 1, ["ses_a"], ["ses_a"], "req-bad-uuid") },
          { label: "active not boolean", req: { ...base, payload: { viewer: { id: uid, active: "yes", sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] } } },
          { label: "missing viewer id", req: { ...base, payload: { viewer: { active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] } } },
          { label: "unexpected root field", req: { ...base, extra: 1 } },
          { label: "unexpected context field", req: viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-extra-ctx") as unknown as Record<string, unknown> },
          { label: "unexpected payload field", req: { ...base, payload: { viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"], extra: 1 } } },
          { label: "unexpected viewer field", req: { ...base, payload: { viewer: { id: uid, active: true, sequence: 1, extra: 1 }, attached: ["ses_a"], visible: ["ses_a"] } } },
          { label: "relative directory", req: viewedReq("relative/path", uid, 1, ["ses_a"], ["ses_a"], "req-rel") },
          { label: "workspace empty", req: viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-ws-empty", "") },
          { label: "workspace nul", req: viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-ws-nul", "ws\0") },
          { label: "opId carried", req: { ...base, opId: "x" } },
        ]
        // fix extra context case
        const extraCtxIdx = cases.findIndex((c) => c.label === "unexpected context field")
        if (extraCtxIdx !== -1) {
          const r = cases[extraCtxIdx]!.req
          ;(r.context as Record<string, unknown>).extra = 1
        }
        for (const c of cases) {
          const raw = await ext.request("session/viewed", c.req)
          const res = asViewedResult(raw)
          expect(res.status).toBe("failed")
          expect(res.accepted).toBeFalse()
          expect(res.failure?.code).toBe("validation.failed")
          expect(res.failure?.message).toBe(VALIDATION_MESSAGE)
          expect(res.failure?.retryable).toBeFalse()
          expect(res.outcome.type).toBe("failed")
          expect(res.data).toBeUndefined()
        }
        expect(calls).toBe(0)
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(svc as unknown as { update: unknown }).update = orig
    }
  })

  test("owner failure is normalized to retryable internal without leaking sensitive payload", async () => {
    const svc = await getViewersService()
    const orig = svc.update
    const dir = "/tmp/secret-dir-xyz"
    const uid = crypto.randomUUID()
    const sensitive = `viewer-${uid}`
    // fail with Error
    ;(svc as unknown as { update: KiloViewers.Interface["update"] }).update = (() =>
      Effect.fail(new Error(`boom ${dir} ${sensitive}`))) as unknown as KiloViewers.Interface["update"]
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const req = viewedReq(dir, uid, 1, ["ses_a"], ["ses_a"], "req-fail-1")
        const raw = await ext.request("session/viewed", req)
        const res = asViewedResult(raw)
        expect(res.status).toBe("failed")
        expect(res.accepted).toBeFalse()
        expect(res.failure?.code).toBe("internal")
        expect(res.failure?.message).toBe(INTERNAL_MESSAGE)
        expect(res.failure?.retryable).toBeTrue()
        expect(res.outcome.type).toBe("failed")
        expect(res.data).toBeUndefined()
        const json = JSON.stringify(raw)
        expect(json.includes(dir)).toBeFalse()
        expect(json.includes(uid)).toBeFalse()
        expect(json.includes(sensitive)).toBeFalse()
        expect(json.includes("boom")).toBeFalse()
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(svc as unknown as { update: unknown }).update = orig
    }
    // defect (die) also normalized
    ;(svc as unknown as { update: KiloViewers.Interface["update"] }).update = (() =>
      Effect.die(new Error(`defect ${dir} ${uid}`))) as unknown as KiloViewers.Interface["update"]
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const req = viewedReq(dir, uid, 2, ["ses_b"], ["ses_b"], "req-fail-2")
        const raw = await ext.request("session/viewed", req)
        const res = asViewedResult(raw)
        expect(res.status).toBe("failed")
        expect(res.accepted).toBeFalse()
        expect(res.failure?.code).toBe("internal")
        expect(res.failure?.message).toBe(INTERNAL_MESSAGE)
        expect(res.failure?.retryable).toBeTrue()
        const json = JSON.stringify(raw)
        expect(json.includes(dir)).toBeFalse()
        expect(json.includes(uid)).toBeFalse()
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(svc as unknown as { update: unknown }).update = orig
    }
  })

  test("pre-init session/viewed is rejected InvalidRequest", async () => {
    const { carrier, ext } = linked()
    try {
      const uid = crypto.randomUUID()
      const req = viewedReq("/tmp", uid, 1, ["ses_a"], ["ses_a"], "req-pre")
      let code: number | undefined
      try {
        await ext.request("session/viewed", req)
      } catch (e) {
        code = (e as { code?: number }).code
      }
      //.fd-carrier guards initialize before dispatch; private peer maps to InvalidRequest (32600-like)
      expect(code).toBeDefined()
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("KiloSessions attached side-effect is not triggered on validation failure", async () => {
    const origSet = (KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: (ids: readonly string[]) => void }).setAttachedSessions
    let sets = 0
    ;(KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: (ids: readonly string[]) => void }).setAttachedSessions = (ids) => {
      sets += 1
      return origSet(ids)
    }
    try {
      const { carrier, ext } = linked()
      try {
        await init(ext)
        const uid = crypto.randomUUID()
        const before = sets
        const bad = viewedReq("/tmp", uid, 1, ["bad_id"], ["ses_a"], "req-bad-attach")
        const res = asViewedResult(await ext.request("session/viewed", bad))
        expect(res.status).toBe("failed")
        expect(sets).toBe(before)
      } finally {
        ext.dispose()
        carrier.dispose()
      }
    } finally {
      ;(KiloSessionsModule.KiloSessions as unknown as { setAttachedSessions: unknown }).setAttachedSessions = origSet
    }
  })
})
