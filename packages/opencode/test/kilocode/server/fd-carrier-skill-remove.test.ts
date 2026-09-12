import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { InstanceStore } from "../../../src/project/instance-store"
import { codeOf, messageOf } from "../../../src/kilocode/skill-remove-execute"
import {
  canonicalSkillRemoveOpId,
  validateSkillRemoveRequest,
} from "../../../src/kilocode/skill-remove-private"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type SkillRemoveResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: { removed: boolean }
  failure?: { code: string; message: string; retryable: boolean }
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!record(v)) throw new Error("expected record response")
  return v
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (typeof v !== "string") throw new Error(`expected string response.${key}`)
  return v
}

function failureOf(v: unknown, p: string): { code: string; message: string; retryable: boolean } {
  if (!record(v)) throw new Error(`expected record ${p}`)
  if (typeof v.code !== "string") throw new Error(`expected string ${p}.code`)
  if (typeof v.message !== "string") throw new Error(`expected string ${p}.message`)
  if (typeof v.retryable !== "boolean") throw new Error(`expected boolean ${p}.retryable`)
  return { code: v.code, message: v.message, retryable: v.retryable }
}

function asSkillRemoveResult(v: unknown): SkillRemoveResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== "skill/remove") throw new Error("expected response.op to be skill/remove")
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: SkillRemoveResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : { type: outcomeRaw.type, time: outcomeRaw.time, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : { removed: (asRecord(dataRaw).removed as boolean) }
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data?.removed !== true) throw new Error("expected response.data.removed true for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
  } else {
    if (row.accepted !== false) throw new Error("expected accepted false for failed")
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected failure code echo")
    if (failure.message !== outcome.failure.message) throw new Error("expected failure message echo")
    if (failure.retryable !== outcome.failure.retryable) throw new Error("expected failure retryable echo")
  }
  return { v: 1, requestId, opId, op: "skill/remove", idempotencyKey, status, outcome, accepted: row.accepted, ...(data ? { data } : {}), ...(failure ? { failure } : {}) }
}

function codeOfResult(v: SkillRemoveResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function req(dir: string, location: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalSkillRemoveOpId(token)
  return {
    v: 1,
    requestId: "req-skill-1",
    opId,
    op: "skill/remove",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { location },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["skill/remove"],
    }),
  )
}

function capsOf(v: unknown): string[] {
  if (!record(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((entry): entry is string => typeof entry === "string")
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!record(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

const seedSkill = async (dir: string, name: string) => {
  const root = path.join(dir, ".kilo", "skills", name)
  await Bun.write(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture.\n---\n# ${name}\n`)
  await Bun.write(path.join(root, "KEEP.txt"), "synthetic sentinel\n")
  return path.join(root, "SKILL.md")
}

describe("fd-carrier skill/remove (authoritative mutation)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises skill/remove capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = yield* Effect.promise(() => init(ext))
        expect(capsOf(res).includes("skill/remove")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("pre-init remove rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const err = yield* Effect.promise(() =>
          ext.request("skill/remove", req("/tmp", "/tmp/x/SKILL.md")).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )
        expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("unknown root field fails closed with echo-validated identities", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const location = path.join(dir, ".kilo", "skills", "ghost", "SKILL.md")
        const raw = yield* Effect.promise(() =>
          ext.request("skill/remove", req(dir, location, "unknown-field", { requestId: "req-unknown", extra: true })),
        )
        const res = asSkillRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
        expect(res.requestId).toBe("req-unknown")
        expect(res.opId).toBe(res.idempotencyKey)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("opId identity mismatch fails closed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const location = path.join(dir, ".kilo", "skills", "ghost", "SKILL.md")
        const opId = canonicalSkillRemoveOpId("tok-a")
        const raw = yield* Effect.promise(() =>
          ext.request("skill/remove", {
            v: 1,
            requestId: "req-mismatch",
            opId,
            op: "skill/remove",
            idempotencyKey: canonicalSkillRemoveOpId("tok-b"),
            context: { directory: dir },
            payload: { location },
          }),
        )
        const res = asSkillRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("project removal unlinks only the manifest and preserves siblings", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const location = yield* Effect.promise(() => seedSkill(dir, "private-remove-me"))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("skill/remove", req(dir, location, "remove-tok", { requestId: "req-remove" })))
        const res = asSkillRemoveResult(raw)
        expect(res.status).toBe("succeeded")
        expect(res.accepted).toBeTrue()
        expect(res.requestId).toBe("req-remove")
        expect(res.opId).toBe("skill-remove:remove-tok")
        expect(res.data?.removed).toBeTrue()
        // No file bytes cross the boundary: the location never appears in the response.
        expect(JSON.stringify(raw).includes(location)).toBeFalse()
        expect(yield* Effect.promise(() => Bun.file(location).exists())).toBeFalse()
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, ".kilo", "skills", "private-remove-me", "KEEP.txt")).exists())).toBeTrue()
        // Convergence owns the fence: await rebuild quiescence so the second
        // removal observes the post-removal registry instead of the fence.
        yield* awaitRebuilds()
        // A second removal of the same manifest is a terminal not-found.
        const again = yield* Effect.promise(() =>
          ext.request("skill/remove", req(dir, location, "remove-tok-2", { requestId: "req-remove-2" })),
        )
        const res2 = asSkillRemoveResult(again)
        expect(res2.status).toBe("failed")
        expect(codeOfResult(res2)).toBe("skill.not_found")
        expect(res2.requestId).toBe("req-remove-2")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("builtin location is a terminal failure", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("skill/remove", req(dir, "builtin", "builtin-tok", { requestId: "req-builtin" })))
        const res = asSkillRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("skill.builtin")
        expect(res.requestId).toBe("req-builtin")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("active fence fails closed retryable without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const gate = yield* GenerationGate.Service
      const ticket = yield* gate.beginFence(dir)
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const location = path.join(dir, ".kilo", "skills", "fenced", "SKILL.md")
        const raw = yield* Effect.promise(() => ext.request("skill/remove", req(dir, location, "fence-tok", { requestId: "req-fence" })))
        const res = asSkillRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("InstanceUnavailableDuringConfigRebuild")
        expect(res.failure?.retryable).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
        yield* ticket.release
      }
    }),
  )
})

describe("skill-remove private contract", () => {
  it.live("fresh skill-remove token identity validates and echoes", () =>
    Effect.gen(function* () {
      const opId = canonicalSkillRemoveOpId("tok-private")
      expect(opId).toBe("skill-remove:tok-private")
      const parsed = req("/tmp", "/tmp/x/SKILL.md", "tok-private", { requestId: "req-echo" })
      const out = validateSkillRemoveRequest(parsed)
      expect(out.opId).toBe(opId)
      expect(out.idempotencyKey).toBe(opId)
      expect(out.payload.location).toBe("/tmp/x/SKILL.md")
    }),
  )

  it.live("terminal error mapping preserves builtin/url/not-found codes", () =>
    Effect.gen(function* () {
      expect(codeOf(new Error("cannot remove built-in skill"))).toBe("skill.builtin")
      expect(codeOf(new Error("remove URL-backed skills from configuration"))).toBe("skill.url")
      expect(codeOf(new Error("skill not found in registry"))).toBe("skill.not_found")
      expect(codeOf(new Error("skill location must be absolute"))).toBe("validation.failed")
      expect(messageOf(new Error("cannot remove built-in skill"))).toBe("cannot remove built-in skill")
      expect(messageOf(new Error("remove URL-backed skills from configuration"))).toBe(
        "remove URL-backed skills from configuration",
      )
      expect(messageOf(new Error("skill not found in registry"))).toBe("skill not found in registry")
    }),
  )
})
