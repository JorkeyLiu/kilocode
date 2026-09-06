import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import * as InstanceState from "../../../src/effect/instance-state"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type ProjectCurrentResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { vcs?: unknown }
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

function asProjectCurrentResult(v: unknown): ProjectCurrentResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "project/current") throw new Error("expected response.op to be project/current")
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
  const outcome: ProjectCurrentResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: ProjectCurrentResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "vcs") throw new Error(`unexpected response.data field ${k}`)
    const vcs = (record.data as Record<string, unknown>).vcs
    if (vcs !== undefined && vcs !== "git") throw new Error("expected response.data.vcs git or absent")
    data = vcs === "git" ? { vcs: "git" } : {}
  }
  let failure: ProjectCurrentResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (opId !== idempotencyKey)
      throw new Error("expected response.opId to equal response.idempotencyKey for succeeded")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code)
      throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200)
      throw new Error("expected bounded response.failure.message")
  }
  return {
    v: 1,
    requestId,
    opId,
    op,
    idempotencyKey,
    status,
    outcome,
    accepted,
    ...(data !== undefined ? { data } : {}),
    ...(failure !== undefined ? { failure } : {}),
  }
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

function failureCodeOf(v: ProjectCurrentResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: ProjectCurrentResult): boolean | undefined {
  if (typeof v.failure?.retryable === "boolean") return v.failure.retryable
  if (typeof v.outcome?.failure?.retryable === "boolean") return v.outcome.failure.retryable
  return undefined
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function projectReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `project-current:${token}`
  return {
    v: 1,
    requestId: "req-project-1",
    opId,
    op: "project/current",
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
      capabilities: ["project/current"],
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
      work.pipe(Effect.provide(captured as unknown as Context.Context<R>), Effect.provideService(InstanceRef, ctx)),
    )
}

describe("fd-carrier project/current vcs-only (parity-only read)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("initialize advertises project/current capability", async () => {
    const restoreParentPid = ownParentPid()
    try {
      const { carrier, ext } = linked()
      try {
        const res = await init(ext)
        expect(capabilitiesOf(res).includes("project/current")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    } finally {
      restoreParentPid()
    }
  })

  test("pre-init project/current rejected InvalidRequest", async () => {
    const restoreParentPid = ownParentPid()
    try {
      const { carrier, ext } = linked()
      try {
        const err = await ext.request("project/current", projectReq("/tmp")).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    } finally {
      restoreParentPid()
    }
  })

  it.live("git directory returns vcs git matching production InstanceState project", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("project/current", projectReq(dir, "git-tok", { requestId: "req-git" })),
          )
          const res = asProjectCurrentResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe("project-current:git-tok")
          expect(res.idempotencyKey).toBe("project-current:git-tok")
          expect(res.data?.vcs).toBe("git")
          // Narrow projection: no path-bearing or out-of-scope fields.
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes("worktree")).toBeFalse()
          expect(wire.includes("sandboxes")).toBeFalse()
          // Production composition: direct InstanceState project vcs matches.
          const direct = yield* run(
            Effect.gen(function* () {
              return (yield* InstanceState.context).project
            }),
          )
          expect(direct.vcs).toBe("git")
          expect((res.data?.vcs === "git") === (direct.vcs === "git")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("non-git directory returns absent vcs", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("project/current", projectReq(dir, "nogit-tok", { requestId: "req-nogit" })),
          )
          const res = asProjectCurrentResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.data?.vcs).toBeUndefined()
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes("worktree")).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("workspace routing label accepted without changing vcs projection", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const opId = "project-current:ws-tok"
          const raw = yield* Effect.promise(() =>
            ext.request("project/current", {
              v: 1,
              requestId: "req-ws",
              opId,
              op: "project/current",
              idempotencyKey: opId,
              context: { directory: dir, workspace: "ws1" },
              payload: {},
            }),
          )
          const res = asProjectCurrentResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.data?.vcs).toBe("git")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("strict validation fails closed with redacted bounded failures", () =>
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
            { label: "relative directory", req: projectReq("relative/path") },
            { label: "nul directory", req: { ...projectReq(dir, "nul"), context: { directory: "/tmp\0" } } },
            { label: "non-empty payload", req: projectReq(dir, "payload", { payload: { filter: {} } }) },
            {
              label: "idempotency mismatch",
              req: projectReq(dir, "tok1", { idempotencyKey: "project-current:other" }),
            },
            { label: "extra root field", req: projectReq(dir, "tok1", { sessionRevision: 1 }) },
            {
              label: "extra context field",
              req: { ...projectReq(dir, "tok1"), context: { directory: dir, sessionId: "ses_x" } },
            },
            { label: "empty opId", req: projectReq(dir, "tok1", { opId: "", idempotencyKey: "" }) },
            {
              label: "opId missing token",
              req: projectReq(dir, "tok1", { opId: "project-current", idempotencyKey: "project-current" }),
            },
            {
              label: "opId token with colon",
              req: projectReq(dir, "tok1", { opId: "project-current:a:b", idempotencyKey: "project-current:a:b" }),
            },
            {
              label: "wrong op prefix",
              req: projectReq(dir, "tok1", { opId: "project:tok1", idempotencyKey: "project:tok1" }),
            },
            { label: "wrong op", req: projectReq(dir, "tok1", { op: "project/list" }) },
            {
              label: "empty workspace",
              req: { ...projectReq(dir, "ws"), context: { directory: dir, workspace: "" } },
            },
          ]
          for (const c of cases) {
            const res = asProjectCurrentResult(yield* Effect.promise(() => ext.request("project/current", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            const msg = res.failure?.message ?? res.outcome.failure?.message ?? ""
            expect(msg).toBe("invalid project-current request")
            expect(msg.length).toBeLessThanOrEqual(200)
            const wire = JSON.stringify(res)
            expect(wire.includes('"data"')).toBeFalse()
            expect(wire.includes(dir)).toBeFalse()
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("malformed keys and path-bearing identities never reach the failure wire", () =>
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
            { label: "evil root key", req: projectReq(dir, "tok1", { [evilKey]: 1 }) },
            {
              label: "evil context key",
              req: { ...projectReq(dir, "tok1"), context: { directory: dir, [evilKey]: 1 } },
            },
            {
              label: "path requestId",
              req: {
                ...projectReq(dir, "tok1"),
                requestId: evilId,
                opId: "project-current:tok1",
                idempotencyKey: "project-current:tok1",
              },
            },
            {
              label: "path opId token",
              req: {
                ...projectReq(dir, "tok1"),
                opId: "project-current:/tmp/secret",
                idempotencyKey: "project-current:/tmp/secret",
                requestId: "req-evil",
              },
            },
          ]
          for (const c of cases) {
            const res = asProjectCurrentResult(yield* Effect.promise(() => ext.request("project/current", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            const wire = JSON.stringify(res)
            expect(wire.includes(evilKey)).toBe(false)
            expect(wire.includes("secret-id")).toBe(false)
            // Fallback identities are sanitized to fixed tokens.
            expect(res.requestId.includes("/")).toBe(false)
            expect(res.opId.includes("/tmp")).toBe(false)
            expect(res.idempotencyKey.includes("/tmp")).toBe(false)
          }
          // Legal request keeps exact correlation binding.
          const good = asProjectCurrentResult(
            yield* Effect.promise(() =>
              ext.request("project/current", projectReq(dir, "good-tok", { requestId: "req-good" })),
            ),
          )
          expect(good.status).toBe("succeeded")
          expect(good.requestId).toBe("req-good")
          expect(good.opId).toBe("project-current:good-tok")
          expect(good.idempotencyKey).toBe("project-current:good-tok")
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
            ext.request("project/git-status", projectReq(dir)).then(
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
        const tmpB = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asProjectCurrentResult(
            yield* Effect.promise(() =>
              ext.request("project/current", projectReq(dirA, "iso-a", { requestId: "req-iso-a" })),
            ),
          )
          expect(resA.status).toBe("succeeded")
          expect(resA.data?.vcs).toBe("git")
          const wireA = JSON.stringify(resA)
          expect(wireA.includes(dirA)).toBeFalse()
          const resB = asProjectCurrentResult(
            yield* Effect.promise(() =>
              ext.request("project/current", projectReq(dirB, "iso-b", { requestId: "req-iso-b" })),
            ),
          )
          expect(resB.status).toBe("succeeded")
          expect(resB.data?.vcs).toBeUndefined()
          const dir = canonicalDirectory(dirB)
          expect(dir.length).toBeGreaterThan(0)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("active fence maps to retryable InstanceUnavailableDuringConfigRebuild then recovers after release", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const fenceTmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const fenceDir = fenceTmp.path
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const res = asProjectCurrentResult(
              yield* Effect.promise(() =>
                ext.request("project/current", projectReq(fenceDir, "fence-tok", { requestId: "req-fence" })),
              ),
            )
            expect(res.status).toBe("failed")
            expect(res.accepted).toBeFalse()
            expect(failureCodeOf(res)).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(retryableOf(res)).toBeTrue()
            expect(res.data).toBeUndefined()
            const msg = res.failure?.message ?? ""
            expect(msg.length).toBeLessThanOrEqual(200)
            const wire = JSON.stringify(res)
            expect(wire.includes(fenceDir)).toBeFalse()
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* ticket.release.pipe(Effect.ignore)
        }
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const second = asProjectCurrentResult(
            yield* Effect.promise(() =>
              ext.request("project/current", projectReq(fenceDir, "fence-after", { requestId: "req-fence-after" })),
            ),
          )
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBeTrue()
          expect(second.opId).toBe("project-current:fence-after")
          expect(second.idempotencyKey).toBe("project-current:fence-after")
          expect(second.data?.vcs).toBe("git")
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
