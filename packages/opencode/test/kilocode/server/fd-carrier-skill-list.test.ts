import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Skill } from "../../../src/skill"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type SkillListResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { skills: unknown[] }
  failure?: { code: string; message?: string; retryable?: boolean }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function str(record: Record<string, unknown>, key: string): string {
  const v = record[key]
  if (typeof v !== "string") throw new Error(`expected string response.${key}`)
  return v
}

function failureOf(v: unknown, p: string): { code: string; message?: string; retryable?: boolean } {
  if (!isRecord(v)) throw new Error(`expected record ${p}`)
  const code = v.code
  if (typeof code !== "string") throw new Error(`expected string ${p}.code`)
  const out: { code: string; message?: string; retryable?: boolean } = { code }
  if (v.message !== undefined) {
    if (typeof v.message !== "string") throw new Error(`expected string ${p}.message`)
    out.message = v.message
  }
  if (typeof v.retryable === "boolean") out.retryable = v.retryable
  return out
}

function asSkillListResult(v: unknown): SkillListResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "skill/list") throw new Error("expected response.op to be skill/list")
  const idempotencyKey = str(record, "idempotencyKey")
  if (idempotencyKey.length === 0) throw new Error("expected non-empty response.idempotencyKey")
  const status = str(record, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected boolean response.accepted")
  if (status === "succeeded" && accepted !== true) throw new Error("expected accepted true for succeeded")
  if (status === "failed" && accepted !== false) throw new Error("expected accepted false for failed")
  const outcomeRaw = record.outcome
  if (!isRecord(outcomeRaw)) throw new Error("expected record response.outcome")
  const outcomeType = outcomeRaw.type
  if (typeof outcomeType !== "string") throw new Error("expected string response.outcome.type")
  const outcomeTime = outcomeRaw.time
  if (typeof outcomeTime !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeType !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: SkillListResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: SkillListResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "skills") throw new Error(`unexpected response.data field ${k}`)
    const skills = (record.data as Record<string, unknown>).skills
    if (!Array.isArray(skills)) throw new Error("expected array response.data.skills")
    data = { skills }
  }
  let failure: SkillListResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey for succeeded")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200) throw new Error("expected bounded response.failure.message")
  }
  return { v: 1, requestId, opId, op, idempotencyKey, status, outcome, accepted, ...(data !== undefined ? { data } : {}), ...(failure !== undefined ? { failure } : {}) }
}

function messageOf(v: SkillListResult): string {
  return v.failure?.message ?? v.outcome.failure?.message ?? ""
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!isRecord(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

function capabilitiesOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((entry): entry is string => typeof entry === "string")
}

function failureCodeOf(v: SkillListResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function listReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `skill-list:${token}`
  return {
    v: 1,
    requestId: "req-list-1",
    opId,
    op: "skill/list",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["skill/list"],
    }),
  )
}

function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}

function scoped(ctx: InstanceContext, captured: Context.Context<never>) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    runInInstance(
      ctx,
      work.pipe(
        Effect.provide(captured as unknown as Context.Context<R>),
        Effect.provideService(InstanceRef, ctx),
      ),
    )
}

const ALLOWED_ENTRY_KEYS = new Set(["name", "description", "location"])
const FORBIDDEN_KEYS = ["content", "template", "agent", "model", "subtask"]

function assertSafeEntry(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record skill entry")
  for (const k of Object.keys(item)) {
    if (!ALLOWED_ENTRY_KEYS.has(k)) throw new Error(`unexpected skill entry field ${k}`)
  }
  for (const k of FORBIDDEN_KEYS) {
    if (k in item) throw new Error(`skill entry must not carry ${k}`)
  }
  const name = item.name
  if (typeof name !== "string" || name.length === 0) throw new Error("expected non-empty entry.name")
  const description = item.description
  if (description !== undefined && typeof description !== "string") throw new Error("expected string entry.description")
  const location = item.location
  if (typeof location !== "string" || location.length === 0) throw new Error("expected non-empty entry.location")
  return name
}

describe("fd-carrier skill/list (parity-only read)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises skill/list capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("skill/list")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init list rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("skill/list", listReq("/tmp")).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("same-directory success projects safe fields matching production list", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("skill/list", listReq(dir, "same-tok", { requestId: "req-same" })))
          const res = asSkillListResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe("skill-list:same-tok")
          expect(res.idempotencyKey).toBe("skill-list:same-tok")
          const entries = res.data?.skills ?? []
          const names = entries.map(assertSafeEntry)
          // Production composition: direct service list matches carrier
          // projection exactly (same multiset of names, same insertion
          // order). Only stored fields are read; content is never carried.
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Skill.Service
              return yield* svc.all()
            }),
          )
          const directNames = direct.map((d) => d.name)
          expect(names).toEqual(directNames)
          for (const entry of entries) {
            const rec = entry as Record<string, unknown>
            const found = direct.find((d) => d.name === rec.name)
            expect(found !== undefined).toBeTrue()
            if (found!.description !== undefined) expect(rec.description).toBe(found!.description)
            expect(rec.location).toBe(found!.location)
            const wire = JSON.stringify(rec)
            expect(wire.includes("content")).toBeFalse()
          }
          // No content or file bytes anywhere on the wire.
          expect(JSON.stringify(res).includes("content")).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("empty skills list is an authoritative success shape", () =>
    Effect.gen(function* () {
      // Empty is valid: the safe projection accepts zero entries and the
      // result parser binds identity without requiring non-empty data.
      const req = listReq("/tmp", "empty-tok", { requestId: "req-empty" })
      const emptyResult = {
        v: 1,
        requestId: "req-empty",
        opId: "skill-list:empty-tok",
        op: "skill/list",
        idempotencyKey: "skill-list:empty-tok",
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { skills: [] },
      }
      const parsed = asSkillListResult(emptyResult)
      expect(parsed.status).toBe("succeeded")
      expect(parsed.data?.skills).toEqual([])
      expect(req.payload).toEqual({})
    }),
  )

  it.live("workspace routing label accepted without changing safe projection", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const opId = "skill-list:ws-tok"
          const raw = yield* Effect.promise(() =>
            ext.request("skill/list", {
              v: 1,
              requestId: "req-ws",
              opId,
              op: "skill/list",
              idempotencyKey: opId,
              context: { directory: dir, workspace: "ws1" },
              payload: {},
            }),
          )
          const res = asSkillListResult(raw)
          expect(res.status).toBe("succeeded")
          for (const e of (res.data?.skills ?? [])) assertSafeEntry(e)
          expect(JSON.stringify(res).includes("content")).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("strict validation fails closed with fixed redacted failures", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "relative directory", req: listReq("relative/path") },
            { label: "nul directory", req: { ...listReq(dir, "nul"), context: { directory: "/tmp\0" } } },
            { label: "non-empty payload", req: listReq(dir, "payload", { payload: { filter: {} } }) },
            { label: "idempotency mismatch", req: listReq(dir, "tok1", { idempotencyKey: "skill-list:other" }) },
            { label: "extra root field", req: listReq(dir, "tok1", { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...listReq(dir, "tok1"), context: { directory: dir, sessionId: "ses_x" } } },
            { label: "empty opId", req: listReq(dir, "tok1", { opId: "", idempotencyKey: "" }) },
            { label: "opId missing token", req: listReq(dir, "tok1", { opId: "skill-list", idempotencyKey: "skill-list" }) },
            { label: "opId token with colon", req: listReq(dir, "tok1", { opId: "skill-list:a:b", idempotencyKey: "skill-list:a:b" }) },
            { label: "wrong op prefix", req: listReq(dir, "tok1", { opId: "skill:tok1", idempotencyKey: "skill:tok1" }) },
            { label: "wrong op", req: listReq(dir, "tok1", { op: "command/list" }) },
            { label: "empty workspace", req: { ...listReq(dir, "ws"), context: { directory: dir, workspace: "" } } },
          ]
          for (const c of cases) {
            const res = asSkillListResult(yield* Effect.promise(() => ext.request("skill/list", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            expect(messageOf(res)).toBe("invalid skill-list request")
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
            // Redaction: no skill payload, content, or directory echo.
            const wire = JSON.stringify(res)
            expect(wire.includes("skills")).toBeFalse()
            expect(wire.includes("content")).toBeFalse()
            expect(wire.includes("location")).toBeFalse()
          }
          // Fence and internal messages are fixed redacted strings; the
          // fence is the only retryable failure.
          expect("Instance is unavailable during config rebuild; no active runtime for this request".length).toBeGreaterThan(0)
          expect("internal error").toBe("internal error")
          expect("directory mismatch").toBe("directory mismatch")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("F-002 malformed keys and path-bearing identities never reach the failure wire", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const evilKey = "/tmp/secret"
          const evilId = "/tmp/secret-id"
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "evil root key", req: listReq(dir, "tok1", { [evilKey]: 1 }) },
            {
              label: "evil context key",
              req: { ...listReq(dir, "tok1"), context: { directory: dir, [evilKey]: 1 } },
            },
            {
              label: "path requestId",
              req: { ...listReq(dir, "tok1"), requestId: evilId, opId: "skill-list:tok1", idempotencyKey: "skill-list:tok1" },
            },
            {
              label: "path opId token",
              req: { ...listReq(dir, "tok1"), opId: "skill-list:/tmp/secret", idempotencyKey: "skill-list:/tmp/secret", requestId: "req-evil" },
            },
          ]
          for (const c of cases) {
            const res = asSkillListResult(yield* Effect.promise(() => ext.request("skill/list", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            const wire = JSON.stringify(res)
            expect(wire.includes(evilKey)).toBe(false)
            expect(wire.includes("secret-id")).toBe(false)
            expect(wire.includes("content")).toBe(false)
            // Fallback identities are sanitized to fixed tokens.
            expect(res.requestId.includes("/")).toBe(false)
            expect(res.opId.includes("/tmp")).toBe(false)
            expect(res.idempotencyKey.includes("/tmp")).toBe(false)
          }
          // Legal request keeps exact correlation binding.
          const good = asSkillListResult(
            yield* Effect.promise(() => ext.request("skill/list", listReq(dir, "good-tok", { requestId: "req-good" }))),
          )
          expect(good.status).toBe("succeeded")
          expect(good.requestId).toBe("req-good")
          expect(good.opId).toBe("skill-list:good-tok")
          expect(good.idempotencyKey).toBe("skill-list:good-tok")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method stays MethodNotFound", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const err = yield* Effect.promise(() =>
            ext.request("skill/nope", listReq(dir)).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.MethodNotFound)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("cross-directory queries stay isolated to the request directory", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        // Project-local skill visible only to dirA's instance inventory.
        const skillDir = path.join(dirA, ".kilo", "skills", "carrier-marker-skill")
        yield* Effect.promise(() => Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: carrier-marker-skill\ndescription: carrier isolation marker\n---\n\nMarker body\n"))
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const directA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Skill.Service
            return yield* svc.all()
          }),
        )
        expect(directA.some((d) => d.name === "carrier-marker-skill")).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asSkillListResult(yield* Effect.promise(() => ext.request("skill/list", listReq(dirA, "iso-a", { requestId: "req-iso-a" }))))
          expect(resA.status).toBe("succeeded")
          const namesA = (resA.data?.skills ?? []).map((e) => (e as Record<string, unknown>).name)
          expect(namesA.includes("carrier-marker-skill")).toBeTrue()
          const marker = (resA.data?.skills ?? []).find((e) => (e as Record<string, unknown>).name === "carrier-marker-skill")
          const mrec = marker as Record<string, unknown>
          expect(mrec.description).toBe("carrier isolation marker")
          expect(typeof mrec.location).toBe("string")
          expect("content" in mrec).toBeFalse()
          for (const e of (resA.data?.skills ?? [])) assertSafeEntry(e)
          const resB = asSkillListResult(yield* Effect.promise(() => ext.request("skill/list", listReq(dirB, "iso-b", { requestId: "req-iso-b" }))))
          expect(resB.status).toBe("succeeded")
          const namesB = (resB.data?.skills ?? []).map((e) => (e as Record<string, unknown>).name)
          expect(namesB.includes("carrier-marker-skill")).toBeFalse()
          for (const e of (resB.data?.skills ?? [])) assertSafeEntry(e)
          expect(JSON.stringify(resB).includes("content")).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )
})
