import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Deferred, Effect } from "effect"
import { Server } from "../../../src/server/server"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import {
  configWarningsMessageCategory,
  configWarningsPathCategory,
  createFdCarrier,
} from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Config } from "../../../src/config/config"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { awaitWithTimeout, testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady } from "../../fixture/plugin"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type ConfigWarningsResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { warnings: unknown[] }
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

function asConfigWarningsResult(v: unknown): ConfigWarningsResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "config/warnings") throw new Error("expected response.op to be config/warnings")
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
  const outcome: ConfigWarningsResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: ConfigWarningsResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "warnings") throw new Error(`unexpected response.data field ${k}`)
    const warnings = (record.data as Record<string, unknown>).warnings
    if (!Array.isArray(warnings)) throw new Error("expected array response.data.warnings")
    data = { warnings }
  }
  let failure: ConfigWarningsResult["failure"]
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

function messageOf(v: ConfigWarningsResult): string {
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

function failureCodeOf(v: ConfigWarningsResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: ConfigWarningsResult): boolean | undefined {
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

function warningsReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `config-warnings:${token}`
  return {
    v: 1,
    requestId: "req-warnings-1",
    opId,
    op: "config/warnings",
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
      capabilities: ["config/warnings"],
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

const web = () => Server.Default().app

function http(dir: string | undefined, input: string, opts?: RequestInit): Promise<Response> {
  return Promise.resolve(
    web().request(input, {
      ...opts,
      headers: {
        ...(dir ? { "x-kilo-directory": dir } : {}),
        ...opts?.headers,
      },
    }),
  )
}

function scoped(ctx: InstanceContext, captured: Context.Context<never>) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    runInInstance(
      ctx,
      work.pipe(Effect.provide(captured as unknown as Context.Context<R>), Effect.provideService(InstanceRef, ctx)),
    )
}

const ALLOWED_SAFE_KEYS = new Set(["pathCategory", "messageCategory"])
const ALLOWED_PATH = new Set(["config-file", "agent-file", "command-file", "other"])
const ALLOWED_MSG = new Set([
  "invalid-json",
  "invalid-config",
  "invalid-file",
  "parse-agent",
  "parse-command",
  "substitute-agent",
  "unknown",
])

function safeKeyOf(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record warning entry")
  for (const k of Object.keys(item)) {
    if (!ALLOWED_SAFE_KEYS.has(k)) throw new Error(`unexpected warning entry field ${k}`)
  }
  // Raw warning material must never cross the boundary.
  for (const k of ["path", "message", "detail"]) {
    if (k in item) throw new Error(`warning entry must not carry ${k}`)
  }
  const pc = item.pathCategory
  const mc = item.messageCategory
  if (typeof pc !== "string" || !ALLOWED_PATH.has(pc)) throw new Error("expected finite warning.pathCategory")
  if (typeof mc !== "string" || !ALLOWED_MSG.has(mc)) throw new Error("expected finite warning.messageCategory")
  return JSON.stringify([pc, mc])
}

function projectRaw(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record raw warning")
  const p = item.path
  const m = item.message
  if (typeof p !== "string" || p.length === 0) throw new Error("expected non-empty raw warning.path")
  if (typeof m !== "string" || m.length === 0) throw new Error("expected non-empty raw warning.message")
  return JSON.stringify([configWarningsPathCategory(p), configWarningsMessageCategory(m)])
}

describe("fd-carrier config/warnings (safe-projection private-first read)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("carrier category helpers map producer templates without raw echo", () => {
    expect(configWarningsPathCategory("/g/agent/a.md")).toBe("agent-file")
    expect(configWarningsPathCategory("/g/command/c.md")).toBe("command-file")
    expect(configWarningsPathCategory("/g/kilo.jsonc")).toBe("config-file")
    expect(configWarningsPathCategory("/g/notes.txt")).toBe("other")
    expect(configWarningsMessageCategory("Config file at p is not valid JSON(C)")).toBe("invalid-json")
    expect(configWarningsMessageCategory("Configuration is invalid at p")).toBe("invalid-config")
    expect(configWarningsMessageCategory("Config file at p is invalid")).toBe("invalid-file")
    expect(configWarningsMessageCategory("Failed to parse agent p")).toBe("parse-agent")
    expect(configWarningsMessageCategory("Failed to parse command p")).toBe("parse-command")
    expect(configWarningsMessageCategory("Failed to substitute variables in agent p")).toBe("substitute-agent")
    expect(configWarningsMessageCategory("verbatim text")).toBe("unknown")
  })

  it.live("initialize advertises config/warnings capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("config/warnings")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init warnings rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("config/warnings", warningsReq("/tmp")).then(
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

  it.live("same-directory success projects safe categories matching production warnings", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        // Broken agent markdown produces a directory-scoped warning.
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, ".kilo", "agent", "broken.md"), `---\nmode: "banana"\n---\nBroken agent`),
        )
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("config/warnings", warningsReq(dir, "same-tok", { requestId: "req-same" })),
          )
          const res = asConfigWarningsResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe("config-warnings:same-tok")
          expect(res.idempotencyKey).toBe("config-warnings:same-tok")
          const entries = res.data?.warnings ?? []
          expect(entries.length).toBeGreaterThan(0)
          const keys = entries.map(safeKeyOf)
          expect(keys.includes(JSON.stringify(["agent-file", "invalid-file"]))).toBeTrue()
          // No raw path, diagnostic text, or detail anywhere on the wire.
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes("broken.md")).toBeFalse()
          expect(wire.includes("detail")).toBeFalse()
          expect(wire.includes("banana")).toBeFalse()
          // Production composition: direct service warnings project to the
          // same safe multiset through the same directory lane.
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Config.Service
              return yield* svc.warnings()
            }),
          )
          const directKeys = direct.map(projectRaw)
          expect([...keys].sort()).toEqual([...directKeys].sort())
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
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
          const opId = "config-warnings:ws-tok"
          const raw = yield* Effect.promise(() =>
            ext.request("config/warnings", {
              v: 1,
              requestId: "req-ws",
              opId,
              op: "config/warnings",
              idempotencyKey: opId,
              context: { directory: dir, workspace: "ws1" },
              payload: {},
            }),
          )
          const res = asConfigWarningsResult(raw)
          expect(res.status).toBe("succeeded")
          for (const e of res.data?.warnings ?? []) safeKeyOf(e)
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
            { label: "relative directory", req: warningsReq("relative/path") },
            { label: "nul directory", req: { ...warningsReq(dir, "nul"), context: { directory: "/tmp\0" } } },
            { label: "non-empty payload", req: warningsReq(dir, "payload", { payload: { filter: {} } }) },
            {
              label: "idempotency mismatch",
              req: warningsReq(dir, "tok1", { idempotencyKey: "config-warnings:other" }),
            },
            { label: "extra root field", req: warningsReq(dir, "tok1", { sessionRevision: 1 }) },
            {
              label: "extra context field",
              req: { ...warningsReq(dir, "tok1"), context: { directory: dir, sessionId: "ses_x" } },
            },
            { label: "empty opId", req: warningsReq(dir, "tok1", { opId: "", idempotencyKey: "" }) },
            {
              label: "opId missing token",
              req: warningsReq(dir, "tok1", { opId: "config-warnings", idempotencyKey: "config-warnings" }),
            },
            {
              label: "opId token with colon",
              req: warningsReq(dir, "tok1", { opId: "config-warnings:a:b", idempotencyKey: "config-warnings:a:b" }),
            },
            {
              label: "wrong op prefix",
              req: warningsReq(dir, "tok1", { opId: "config:tok1", idempotencyKey: "config:tok1" }),
            },
            { label: "wrong op", req: warningsReq(dir, "tok1", { op: "config/get" }) },
            {
              label: "empty workspace",
              req: { ...warningsReq(dir, "ws"), context: { directory: dir, workspace: "" } },
            },
          ]
          for (const c of cases) {
            const res = asConfigWarningsResult(yield* Effect.promise(() => ext.request("config/warnings", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            expect(messageOf(res)).toBe("invalid config-warnings request")
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
            // Redaction: no warning data payload, detail, or directory echo.
            // (The `op` label `config/warnings` legitimately contains the
            // fixed word "warnings"; assert the data/detail keys instead.)
            const wire = JSON.stringify(res)
            expect(wire.includes('"data"')).toBeFalse()
            expect(wire.includes("detail")).toBeFalse()
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
            { label: "evil root key", req: warningsReq(dir, "tok1", { [evilKey]: 1 }) },
            {
              label: "evil context key",
              req: { ...warningsReq(dir, "tok1"), context: { directory: dir, [evilKey]: 1 } },
            },
            {
              label: "path requestId",
              req: {
                ...warningsReq(dir, "tok1"),
                requestId: evilId,
                opId: "config-warnings:tok1",
                idempotencyKey: "config-warnings:tok1",
              },
            },
            {
              label: "path opId token",
              req: {
                ...warningsReq(dir, "tok1"),
                opId: "config-warnings:/tmp/secret",
                idempotencyKey: "config-warnings:/tmp/secret",
                requestId: "req-evil",
              },
            },
          ]
          for (const c of cases) {
            const res = asConfigWarningsResult(yield* Effect.promise(() => ext.request("config/warnings", c.req)))
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
          const good = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dir, "good-tok", { requestId: "req-good" })),
            ),
          )
          expect(good.status).toBe("succeeded")
          expect(good.requestId).toBe("req-good")
          expect(good.opId).toBe("config-warnings:good-tok")
          expect(good.idempotencyKey).toBe("config-warnings:good-tok")
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
            ext.request("config/get", warningsReq(dir)).then(
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
        // Broken agent markdown visible only to dirA's instance warnings.
        yield* Effect.promise(() =>
          Bun.write(path.join(dirA, ".kilo", "agent", "broken.md"), `---\nmode: "banana"\n---\nBroken agent`),
        )
        // dirB stays valid: no warning fixtures.
        const marker = JSON.stringify(["agent-file", "invalid-file"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dirA, "iso-a", { requestId: "req-iso-a" })),
            ),
          )
          expect(resA.status).toBe("succeeded")
          const keysA = (resA.data?.warnings ?? []).map(safeKeyOf)
          expect(keysA.includes(marker)).toBeTrue()
          const wireA = JSON.stringify(resA)
          expect(wireA.includes(dirA)).toBeFalse()
          expect(wireA.includes("broken.md")).toBeFalse()
          const resB = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dirB, "iso-b", { requestId: "req-iso-b" })),
            ),
          )
          expect(resB.status).toBe("succeeded")
          const keysB = (resB.data?.warnings ?? []).map(safeKeyOf)
          expect(keysB.includes(marker)).toBeFalse()
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

  it.live("reload freshness surfaces added warning through the same carrier lane", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, ".kilo", "agent", "broken.md"), `---\nmode: "banana"\n---\nBroken agent`),
        )
        const store = yield* InstanceStore.Service
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const first = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dir, "fresh-a", { requestId: "req-fresh-a" })),
            ),
          )
          expect(first.status).toBe("succeeded")
          const firstKeys = (first.data?.warnings ?? []).map(safeKeyOf)
          const marker = JSON.stringify(["agent-file", "invalid-file"])
          expect(firstKeys.includes(marker)).toBeTrue()
          const firstCount = firstKeys.filter((k) => k === marker).length
          yield* Effect.promise(() =>
            Bun.write(path.join(dir, ".kilo", "agent", "broken2.md"), `---\nmode: "banana"\n---\nBroken agent 2`),
          )
          yield* store.reload({ directory: dir })
          const second = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dir, "fresh-b", { requestId: "req-fresh-b" })),
            ),
          )
          expect(second.status).toBe("succeeded")
          const secondKeys = (second.data?.warnings ?? []).map(safeKeyOf)
          const secondCount = secondKeys.filter((k) => k === marker).length
          expect(secondCount).toBe(firstCount + 1)
          expect(secondKeys.length).toBe(firstKeys.length + 1)
          expect([...secondKeys].sort()).not.toEqual([...firstKeys].sort())
          const wire = JSON.stringify(second)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes("broken2.md")).toBeFalse()
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
            const res = asConfigWarningsResult(
              yield* Effect.promise(() =>
                ext.request("config/warnings", warningsReq(fenceDir, "fence-tok", { requestId: "req-fence" })),
              ),
            )
            expect(res.status).toBe("failed")
            expect(res.accepted).toBeFalse()
            expect(failureCodeOf(res)).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(retryableOf(res)).toBeTrue()
            expect(res.data).toBeUndefined()
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
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
          const second = asConfigWarningsResult(
            yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(fenceDir, "fence-after", { requestId: "req-fence-after" })),
            ),
          )
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBeTrue()
          expect(second.opId).toBe("config-warnings:fence-after")
          expect(second.idempotencyKey).toBe("config-warnings:fence-after")
          for (const e of second.data?.warnings ?? []) safeKeyOf(e)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live(
    "existing warning preserved across real project cold save rebuild via same carrier",
    () =>
      Effect.gen(function* () {
        const restoreParentPid = ownParentPid()
        try {
          const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
          const dir = tmp.path
          yield* Effect.promise(() => markProjectConfigReady(dir))
          yield* Effect.promise(() =>
            Bun.write(path.join(dir, ".kilo", "agent", "broken.md"), `---\nmode: "banana"\n---\nBroken agent`),
          )
          const boot = yield* Effect.promise(() => http(dir, "/config/overlay?scope=project"))
          expect(boot.status).toBe(200)
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const baseRaw = yield* Effect.promise(() =>
              ext.request("config/warnings", warningsReq(dir, "cold-base", { requestId: "req-cold-base" })),
            )
            const base = asConfigWarningsResult(baseRaw)
            expect(base.status).toBe("succeeded")
            expect(base.accepted).toBeTrue()
            expect(base.opId).toBe("config-warnings:cold-base")
            const baseKeys = (base.data?.warnings ?? []).map(safeKeyOf).sort()
            expect(baseKeys.length).toBeGreaterThan(0)
            expect(baseKeys.includes(JSON.stringify(["agent-file", "invalid-file"]))).toBeTrue()
            expect(JSON.stringify(base).includes(dir)).toBeFalse()
            const gate = yield* Deferred.make<void>()
            const onEvent = (evt: { directory?: string; payload: { type: string } }) => {
              if (evt.payload.type !== "server.instance.disposed") return
              if (evt.directory !== dir) return
              void Effect.runFork(Deferred.succeed(gate, void 0))
            }
            GlobalBus.on("event", onEvent)
            try {
              const patched = yield* Effect.promise(() =>
                http(dir, "/config/overlay", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ scope: "project", set: { username: "cold-user" } }),
                }),
              )
              expect(patched.status).toBe(200)
              const overlay = (yield* Effect.promise(async () => {
                const res = await http(dir, "/config/overlay?scope=project")
                expect(res.status).toBe(200)
                return (await res.json()) as { effective: Record<string, unknown> }
              })) as { effective: Record<string, unknown> }
              expect(overlay.effective["username"]).toBe("cold-user")
              yield* awaitWithTimeout(Deferred.await(gate), "project disposal did not arrive after cold save")
              yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle after cold save", "20 seconds")
              const nextRaw = yield* Effect.promise(() =>
                ext.request("config/warnings", warningsReq(dir, "cold-next", { requestId: "req-cold-next" })),
              )
              const next = asConfigWarningsResult(nextRaw)
              expect(next.status).toBe("succeeded")
              expect(next.accepted).toBeTrue()
              expect(next.opId).toBe("config-warnings:cold-next")
              expect(next.idempotencyKey).toBe("config-warnings:cold-next")
              const nextKeys = (next.data?.warnings ?? []).map(safeKeyOf).sort()
              expect([...nextKeys].sort()).toEqual([...baseKeys].sort())
              const wire = JSON.stringify(next)
              expect(wire.includes(dir)).toBeFalse()
              expect(wire.includes("broken.md")).toBeFalse()
              expect(wire.includes("banana")).toBeFalse()
              expect(wire.includes("detail")).toBeFalse()
            } finally {
              GlobalBus.removeListener("event", onEvent)
              yield* awaitWithTimeout(awaitRebuilds(), "cold-save teardown did not settle", "5 seconds").pipe(
                Effect.ignore,
              )
            }
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          restoreParentPid()
        }
      }),
    30_000,
  )
})
