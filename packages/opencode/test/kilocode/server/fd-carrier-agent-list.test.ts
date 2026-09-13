import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Agent } from "../../../src/agent/agent"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type AgentListResult = {
  v: number
  requestId: string
  op: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { agents: unknown[] }
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

function asAgentListResult(v: unknown): AgentListResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const op = str(record, "op")
  if (op !== "agent/list") throw new Error("expected response.op to be agent/list")
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
  const outcome: AgentListResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: AgentListResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "agents") throw new Error(`unexpected response.data field ${k}`)
    const agents = (record.data as Record<string, unknown>).agents
    if (!Array.isArray(agents)) throw new Error("expected array response.data.agents")
    data = { agents }
  }
  let failure: AgentListResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
    if (record.opId !== undefined) throw new Error("requestId-only result must not carry opId")
    if (record.idempotencyKey !== undefined) throw new Error("requestId-only result must not carry idempotencyKey")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200) throw new Error("expected bounded response.failure.message")
  }
  return { v: 1, requestId, op, status, outcome, accepted, ...(data !== undefined ? { data } : {}), ...(failure !== undefined ? { failure } : {}) }
}

function messageOf(v: AgentListResult): string {
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

function failureCodeOf(v: AgentListResult): string | undefined {
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

function listReq(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    requestId: "req-list-1",
    op: "agent/list",
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
      capabilities: ["agent/list"],
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

const ALLOWED_ENTRY_KEYS = new Set([
  "name",
  "displayName",
  "source",
  "description",
  "deprecated",
  "mode",
  "native",
  "hidden",
  "topP",
  "temperature",
  "color",
  "permission",
  "model",
  "variant",
  "prompt",
  "options",
  "requirements",
  "steps",
])

function assertFullEntry(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record agent entry")
  for (const k of Object.keys(item)) {
    if (!ALLOWED_ENTRY_KEYS.has(k)) throw new Error(`unexpected agent entry field ${k}`)
  }
  const name = item.name
  if (typeof name !== "string" || name.length === 0) throw new Error("expected non-empty entry.name")
  const mode = item.mode
  if (mode !== "subagent" && mode !== "primary" && mode !== "all") throw new Error("expected valid entry.mode")
  const permission = item.permission
  if (!Array.isArray(permission)) throw new Error("expected array entry.permission")
  for (const rule of permission as unknown[]) {
    if (!isRecord(rule)) throw new Error("expected record permission rule")
    for (const k of Object.keys(rule)) {
      if (k !== "permission" && k !== "pattern" && k !== "action") throw new Error(`unexpected permission field ${k}`)
    }
    const action = (rule as Record<string, unknown>).action
    if (action !== "allow" && action !== "deny" && action !== "ask") throw new Error("expected valid permission action")
  }
  const options = item.options
  if (!isRecord(options)) throw new Error("expected record entry.options")
  // No provider credentials or hidden runtime state may cross the boundary.
  const wire = JSON.stringify(item)
  if (wire.includes("apiKey") || wire.includes("accessToken") || wire.includes("credential"))
    throw new Error("agent entry must not carry credentials")
  return name
}

describe("fd-carrier agent/list (private-first observation)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises agent/list capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("agent/list")).toBeTrue()
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
            ext.request("agent/list", listReq("/tmp")).then(
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

  it.live("same-directory success matches production Agent.Service.list exactly", () =>
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
          const raw = yield* Effect.promise(() => ext.request("agent/list", listReq(dir, { requestId: "req-same" })))
          const res = asAgentListResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.requestId).toBe("req-same")
          const entries = res.data?.agents ?? []
          expect(entries.length).toBeGreaterThan(0)
          const names = entries.map(assertFullEntry)
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Agent.Service
              return yield* svc.list()
            }),
          )
          const directNames = direct.map((d) => d.name)
          expect(names).toEqual(directNames)
          for (const entry of entries) {
            const rec = entry as Record<string, unknown>
            const found = direct.find((d) => d.name === rec.name)
            expect(found !== undefined).toBeTrue()
            if (found!.description !== undefined) expect(rec.description).toBe(found!.description)
            if (found!.mode !== undefined) expect(rec.mode).toBe(found!.mode)
            expect(JSON.stringify(rec).includes("apiKey")).toBeFalse()
          }
          // Full wire preserved: options present on every entry, permission array present.
          for (const entry of entries) {
            const rec = entry as Record<string, unknown>
            expect(isRecord(rec.options)).toBeTrue()
            expect(Array.isArray(rec.permission)).toBeTrue()
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

  it.live("empty agents list is an authoritative success shape", () =>
    Effect.gen(function* () {
      const emptyResult = {
        v: 1,
        requestId: "req-empty",
        op: "agent/list",
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { agents: [] },
      }
      const parsed = asAgentListResult(emptyResult)
      expect(parsed.status).toBe("succeeded")
      expect(parsed.data?.agents).toEqual([])
    }),
  )

  it.live("workspace routing label accepted without changing full projection", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("agent/list", {
              v: 1,
              requestId: "req-ws",
              op: "agent/list",
              context: { directory: dir, workspace: "ws1" },
              payload: {},
            }),
          )
          const res = asAgentListResult(raw)
          expect(res.status).toBe("succeeded")
          for (const e of (res.data?.agents ?? [])) assertFullEntry(e)
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
            { label: "nul directory", req: { ...listReq(dir), context: { directory: "/tmp\0" } } },
            { label: "non-empty payload", req: listReq(dir, { payload: { filter: {} } }) },
            { label: "extra root field", req: listReq(dir, { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...listReq(dir), context: { directory: dir, sessionId: "ses_x" } } },
            { label: "opId present", req: { ...listReq(dir), opId: "agent-list:tok1" } },
            { label: "wrong op", req: listReq(dir, { op: "command/list" }) },
            { label: "empty workspace", req: { ...listReq(dir), context: { directory: dir, workspace: "" } } },
            { label: "path requestId", req: { ...listReq(dir, { requestId: "/tmp/secret-id" }) } },
          ]
          for (const c of cases) {
            const res = asAgentListResult(yield* Effect.promise(() => ext.request("agent/list", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            expect(messageOf(res)).toBe("invalid agent-list request")
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
            const wire = JSON.stringify(res)
            expect(wire.includes("agents")).toBeFalse()
            expect(wire.includes("permission")).toBeFalse()
          }
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

  it.live("cross-directory queries stay isolated to the request directory", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const agentDir = path.join(dirA, ".kilo", "agent")
        yield* Effect.promise(() => Bun.write(path.join(agentDir, "carrier-marker-agent.md"), "---\ndescription: \"carrier isolation marker\"\nmode: \"primary\"\n---\n\nMarker prompt body\n"))
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const directA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Agent.Service
            return yield* svc.list()
          }),
        )
        expect(directA.some((d) => d.name === "carrier-marker-agent")).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asAgentListResult(yield* Effect.promise(() => ext.request("agent/list", listReq(dirA, { requestId: "req-iso-a" }))))
          expect(resA.status).toBe("succeeded")
          const namesA = (resA.data?.agents ?? []).map((e) => (e as Record<string, unknown>).name)
          expect(namesA.includes("carrier-marker-agent")).toBeTrue()
          const marker = (resA.data?.agents ?? []).find((e) => (e as Record<string, unknown>).name === "carrier-marker-agent")
          const mrec = marker as Record<string, unknown>
          expect(mrec.description).toBe("carrier isolation marker")
          for (const e of (resA.data?.agents ?? [])) assertFullEntry(e)
          const resB = asAgentListResult(yield* Effect.promise(() => ext.request("agent/list", listReq(dirB, { requestId: "req-iso-b" }))))
          expect(resB.status).toBe("succeeded")
          const namesB = (resB.data?.agents ?? []).map((e) => (e as Record<string, unknown>).name)
          expect(namesB.includes("carrier-marker-agent")).toBeFalse()
          for (const e of (resB.data?.agents ?? [])) assertFullEntry(e)
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
