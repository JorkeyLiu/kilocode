import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, rm } from "node:fs/promises"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import {
  createFdCarrier,
  isSensitiveFindFilesPath,
  validateFindFilesRelPath,
} from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type FindFilesResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { files: unknown[] }
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

const ALLOWED_ENTRY_KEYS = new Set(["path", "type"])

function entryOf(v: unknown): { path: string; type: string } {
  if (!isRecord(v)) throw new Error("expected record entry")
  for (const k of Object.keys(v)) if (!ALLOWED_ENTRY_KEYS.has(k)) throw new Error(`unexpected entry field ${k}`)
  const p = v.path
  const t = v.type
  if (typeof p !== "string" || p.length === 0) throw new Error("expected non-empty entry.path")
  if (t !== "file" && t !== "directory") throw new Error("expected entry.type file or directory")
  if (p.startsWith("/")) throw new Error("expected relative entry.path")
  if (p.includes("\\")) throw new Error("expected POSIX entry.path")
  if (p.includes("\0")) throw new Error("expected NUL-free entry.path")
  if (p.includes(":")) throw new Error("expected URI-free entry.path")
  return { path: p, type: t }
}

function asFindFilesResult(v: unknown): FindFilesResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "find/files") throw new Error("expected response.op to be find/files")
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
  const outcome: FindFilesResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: FindFilesResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "files") throw new Error(`unexpected response.data field ${k}`)
    const files = (record.data as Record<string, unknown>).files
    if (!Array.isArray(files)) throw new Error("expected array response.data.files")
    if (files.length > 50) throw new Error("expected response.data.files bounded to 50")
    for (const item of files) entryOf(item)
    data = { files }
  }
  let failure: FindFilesResult["failure"]
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

function failureCodeOf(v: FindFilesResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: FindFilesResult): boolean | undefined {
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

function findReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `find-files:${token}`
  return {
    v: 1,
    requestId: "req-find-1",
    opId,
    op: "find/files",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { query: "hello", type: "file", limit: 10 },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["find/files"],
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

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await Bun.write(full, content)
}

describe("fd-carrier find/files bounded read", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("initialize advertises find/files capability", async () => {
    const restoreParentPid = ownParentPid()
    try {
      const { carrier, ext } = linked()
      try {
        const res = await init(ext)
        expect(capabilitiesOf(res).includes("find/files")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    } finally {
      restoreParentPid()
    }
  })

  test("pre-init find/files rejected InvalidRequest", async () => {
    const restoreParentPid = ownParentPid()
    try {
      const { carrier, ext } = linked()
      try {
        const err = await ext.request("find/files", findReq("/tmp")).then(
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

  test("carrier validator drops invalid and sensitive relative paths without logging names", () => {
    expect(() => validateFindFilesRelPath("src/app.ts")).not.toThrow()
    expect(() => validateFindFilesRelPath("a/b/c")).not.toThrow()
    expect(() => validateFindFilesRelPath(".env.example")).not.toThrow()
    expect(() => validateFindFilesRelPath(".github/workflows/ci.yml")).not.toThrow()
    expect(() => validateFindFilesRelPath(".eslintrc")).not.toThrow()
    for (const bad of [
      "",
      "/abs/path",
      "/tmp",
      "C:/win",
      "file://x",
      "a\\b",
      "a//b",
      "a/./b",
      "../esc",
      "a/../b",
      "..",
      ".",
      "a/",
      "a\0b",
      "vscode-remote://x",
      ".env",
      "a/.env.local",
      ".ssh/config",
      "secret/a.txt",
      "k.pem",
      ".pem",
      ".key",
      ".crt",
    ]) {
      expect(() => validateFindFilesRelPath(bad)).toThrow()
    }
    expect(isSensitiveFindFilesPath(".env")).toBeTrue()
    expect(isSensitiveFindFilesPath(".env.local")).toBeTrue()
    expect(isSensitiveFindFilesPath("config/.env.production")).toBeTrue()
    expect(isSensitiveFindFilesPath(".env.example")).toBeFalse()
    expect(isSensitiveFindFilesPath("cert.pem")).toBeTrue()
    expect(isSensitiveFindFilesPath(".pem")).toBeTrue()
    expect(isSensitiveFindFilesPath(".ssh/config")).toBeTrue()
    expect(isSensitiveFindFilesPath("secret/token.txt")).toBeTrue()
    expect(isSensitiveFindFilesPath(".github/workflows/ci.yml")).toBeFalse()
    expect(isSensitiveFindFilesPath("src/app.ts")).toBeFalse()
  })

  it.live("file search projects only relative path-type entries", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        yield* Effect.promise(() => writeFile(dir, "src/app-hello.ts", "export const a = 1\n"))
        yield* Effect.promise(() => writeFile(dir, "src/other.ts", "export const b = 2\n"))
        yield* Effect.promise(() => writeFile(dir, "README.md", "hello readme\n"))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request(
              "find/files",
              findReq(dir, "proj-tok", {
                requestId: "req-proj",
                payload: { query: "app-hello", type: "file", limit: 10 },
              }),
            ),
          )
          const res = asFindFilesResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe("find-files:proj-tok")
          expect(res.idempotencyKey).toBe("find-files:proj-tok")
          const files = res.data?.files ?? []
          expect(files.length).toBeGreaterThan(0)
          for (const item of files) {
            const entry = entryOf(item)
            expect(entry.type).toBe("file")
          }
          const paths = files.map((item) => entryOf(item).path)
          expect(paths.includes("src/app-hello.ts")).toBeTrue()
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes("uri")).toBeFalse()
          expect(wire.includes("mime")).toBeFalse()
          expect(wire.includes("absolute")).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("directory search returns only directories", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        yield* Effect.promise(() => writeFile(dir, "docs-hello/guide.md", "guide\n"))
        yield* Effect.promise(() => writeFile(dir, "src/app.ts", "export const a = 1\n"))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request(
              "find/files",
              findReq(dir, "dir-tok", {
                requestId: "req-dir",
                payload: { query: "docs-hello", type: "directory", limit: 10 },
              }),
            ),
          )
          const res = asFindFilesResult(raw)
          expect(res.status).toBe("succeeded")
          const files = res.data?.files ?? []
          expect(files.length).toBeGreaterThan(0)
          for (const item of files) {
            const entry = entryOf(item)
            expect(entry.type).toBe("directory")
          }
          const paths = files.map((item) => entryOf(item).path)
          expect(paths.includes("docs-hello")).toBeTrue()
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("sensitive names are silently dropped while ordinary dotfiles are preserved", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        yield* Effect.promise(() => writeFile(dir, ".env", "secret=1\n"))
        yield* Effect.promise(() => writeFile(dir, ".env.local", "secret=2\n"))
        yield* Effect.promise(() => writeFile(dir, ".env.example", "example=1\n"))
        yield* Effect.promise(() => writeFile(dir, "secret/token.txt", "t\n"))
        yield* Effect.promise(() => writeFile(dir, "cert-sens.pem", "p\n"))
        yield* Effect.promise(() => writeFile(dir, ".ssh/config", "h\n"))
        yield* Effect.promise(() => writeFile(dir, ".github/workflows/ci.yml", "on: push\n"))
        yield* Effect.promise(() => writeFile(dir, "src/app.ts", "export const a = 1\n"))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const ask = (token: string, requestId: string, query: string) =>
            ext.request("find/files", findReq(dir, token, { requestId, payload: { query, type: "file", limit: 50 } }))
          const envRes = asFindFilesResult(yield* Effect.promise(() => ask("env-tok", "req-env", "env")))
          expect(envRes.status).toBe("succeeded")
          const envPaths = (envRes.data?.files ?? []).map((item) => entryOf(item).path)
          expect(envPaths.includes(".env.example")).toBeTrue()
          expect(envPaths.includes(".env")).toBeFalse()
          expect(envPaths.includes(".env.local")).toBeFalse()
          const tokenRes = asFindFilesResult(yield* Effect.promise(() => ask("token-tok", "req-token", "token")))
          expect(tokenRes.status).toBe("succeeded")
          expect((tokenRes.data?.files ?? []).map((item) => entryOf(item).path)).toEqual([])
          const pemRes = asFindFilesResult(yield* Effect.promise(() => ask("pem-tok", "req-pem", "cert-sens")))
          expect(pemRes.status).toBe("succeeded")
          expect((pemRes.data?.files ?? []).map((item) => entryOf(item).path)).toEqual([])
          const ciRes = asFindFilesResult(yield* Effect.promise(() => ask("ci-tok", "req-ci", "ci")))
          expect(ciRes.status).toBe("succeeded")
          expect((ciRes.data?.files ?? []).map((item) => entryOf(item).path)).toEqual([".github/workflows/ci.yml"])
          for (const res of [envRes, tokenRes, pemRes, ciRes]) {
            const wire = JSON.stringify(res)
            expect(wire.includes(dir)).toBeFalse()
            expect(wire.includes("uri")).toBeFalse()
            expect(wire.includes("mime")).toBeFalse()
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

  it.live("explicit type limit query enforcement with bounded cap", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        yield* Effect.promise(async () => {
          for (let i = 0; i < 60; i++) {
            const name = `cap-f${String(i).padStart(2, "0")}.txt`
            await writeFile(dir, name, `content ${i}\n`)
          }
        })
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const badPayloads: Array<{ label: string; payload: Record<string, unknown> }> = [
            { label: "missing type", payload: { query: "hello", limit: 10 } },
            { label: "bad type", payload: { query: "hello", type: "other", limit: 10 } },
            { label: "legacy dirs", payload: { query: "hello", type: "file", limit: 10, dirs: "true" } },
            { label: "limit zero", payload: { query: "hello", type: "file", limit: 0 } },
            { label: "limit over", payload: { query: "hello", type: "file", limit: 51 } },
            { label: "limit large", payload: { query: "hello", type: "file", limit: 200 } },
            { label: "limit float", payload: { query: "hello", type: "file", limit: 1.5 } },
            { label: "limit string", payload: { query: "hello", type: "file", limit: "10" } },
            { label: "empty query", payload: { query: "", type: "file", limit: 10 } },
            { label: "nul query", payload: { query: "a\0b", type: "file", limit: 10 } },
            { label: "long query", payload: { query: "x".repeat(257), type: "file", limit: 10 } },
          ]
          for (const c of badPayloads) {
            const res = asFindFilesResult(
              yield* Effect.promise(() =>
                ext.request("find/files", findReq(dir, `bad-${c.label.length}`, { payload: c.payload })),
              ),
            )
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            const msg = res.failure?.message ?? ""
            expect(msg).toBe("invalid find-files request")
            const wire = JSON.stringify(res)
            expect(wire.includes(dir)).toBeFalse()
            expect(wire.includes('"data"')).toBeFalse()
          }
          const one = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dir, "limit-one", {
                  requestId: "req-limit-one",
                  payload: { query: "cap-f", type: "file", limit: 1 },
                }),
              ),
            ),
          )
          expect(one.status).toBe("succeeded")
          expect((one.data?.files ?? []).length).toBeLessThanOrEqual(1)
          const capped = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dir, "limit-cap", {
                  requestId: "req-limit-cap",
                  payload: { query: "cap-f", type: "file" },
                }),
              ),
            ),
          )
          expect(capped.status).toBe("succeeded")
          expect((capped.data?.files ?? []).length).toBeLessThanOrEqual(50)
          const maxQuery = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dir, "query-max", {
                  requestId: "req-query-max",
                  payload: { query: "x".repeat(256), type: "file", limit: 10 },
                }),
              ),
            ),
          )
          expect(maxQuery.status).toBe("succeeded")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("strict envelope and routing validation fails closed redacted", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "relative directory", req: findReq("relative/path") },
            { label: "nul directory", req: { ...findReq(dir, "nul"), context: { directory: "/tmp\0" } } },
            {
              label: "extra payload field",
              req: findReq(dir, "payload", { payload: { query: "hello", type: "file", limit: 10, dirs: "false" } }),
            },
            {
              label: "idempotency mismatch",
              req: findReq(dir, "tok1", { idempotencyKey: "find-files:other" }),
            },
            { label: "extra root field", req: findReq(dir, "tok1", { sessionRevision: 1 }) },
            {
              label: "extra context field",
              req: { ...findReq(dir, "tok1"), context: { directory: dir, sessionId: "ses_x" } },
            },
            { label: "empty opId", req: findReq(dir, "tok1", { opId: "", idempotencyKey: "" }) },
            {
              label: "opId missing token",
              req: findReq(dir, "tok1", { opId: "find-files", idempotencyKey: "find-files" }),
            },
            {
              label: "opId token with colon",
              req: findReq(dir, "tok1", { opId: "find-files:a:b", idempotencyKey: "find-files:a:b" }),
            },
            {
              label: "wrong op prefix",
              req: findReq(dir, "tok1", { opId: "find:tok1", idempotencyKey: "find:tok1" }),
            },
            { label: "wrong op", req: findReq(dir, "tok1", { op: "find.text" }) },
            {
              label: "empty workspace",
              req: { ...findReq(dir, "ws"), context: { directory: dir, workspace: "" } },
            },
          ]
          for (const c of cases) {
            const res = asFindFilesResult(yield* Effect.promise(() => ext.request("find/files", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            const msg = res.failure?.message ?? res.outcome.failure?.message ?? ""
            expect(msg).toBe("invalid find-files request")
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
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const evilKey = "/tmp/secret"
          const evilId = "/tmp/secret-id"
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "evil root key", req: findReq(dir, "tok1", { [evilKey]: 1 }) },
            {
              label: "evil context key",
              req: { ...findReq(dir, "tok1"), context: { directory: dir, [evilKey]: 1 } },
            },
            {
              label: "path requestId",
              req: {
                ...findReq(dir, "tok1"),
                requestId: evilId,
                opId: "find-files:tok1",
                idempotencyKey: "find-files:tok1",
              },
            },
            {
              label: "path opId token",
              req: {
                ...findReq(dir, "tok1"),
                opId: "find-files:/tmp/secret",
                idempotencyKey: "find-files:/tmp/secret",
                requestId: "req-evil",
              },
            },
          ]
          for (const c of cases) {
            const res = asFindFilesResult(yield* Effect.promise(() => ext.request("find/files", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            const wire = JSON.stringify(res)
            expect(wire.includes(evilKey)).toBe(false)
            expect(wire.includes("secret-id")).toBe(false)
            expect(res.requestId.includes("/")).toBe(false)
            expect(res.opId.includes("/tmp")).toBe(false)
            expect(res.idempotencyKey.includes("/tmp")).toBe(false)
          }
          const good = asFindFilesResult(
            yield* Effect.promise(() => ext.request("find/files", findReq(dir, "good-tok", { requestId: "req-good" }))),
          )
          expect(good.status).toBe("succeeded")
          expect(good.requestId).toBe("req-good")
          expect(good.opId).toBe("find-files:good-tok")
          expect(good.idempotencyKey).toBe("find-files:good-tok")
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
        const tmpA = yield* Effect.promise(() => tmpdir({ retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        yield* Effect.promise(() => writeFile(dirA, "alpha-marker.txt", "alpha\n"))
        yield* Effect.promise(() => writeFile(dirB, "beta-marker.txt", "beta\n"))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dirA, "iso-a", {
                  requestId: "req-iso-a",
                  payload: { query: "alpha-marker", type: "file", limit: 10 },
                }),
              ),
            ),
          )
          expect(resA.status).toBe("succeeded")
          expect((resA.data?.files ?? []).map((item) => entryOf(item).path)).toEqual(["alpha-marker.txt"])
          expect(JSON.stringify(resA).includes(dirA)).toBeFalse()
          const resB = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dirB, "iso-b", {
                  requestId: "req-iso-b",
                  payload: { query: "alpha-marker", type: "file", limit: 10 },
                }),
              ),
            ),
          )
          expect(resB.status).toBe("succeeded")
          expect((resB.data?.files ?? []).map((item) => entryOf(item).path)).toEqual([])
          expect(JSON.stringify(resB).includes(dirB)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("deleted directory maps to redacted internal without raw error", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const query = "gone-marker"
        yield* Effect.promise(() => writeFile(dir, "gone-marker.txt", "gone\n"))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const warm = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dir, "warm-tok", {
                  requestId: "req-warm",
                  payload: { query, type: "file", limit: 10 },
                }),
              ),
            ),
          )
          expect(warm.status).toBe("succeeded")
          yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
          const res = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request(
                "find/files",
                findReq(dir, "gone-tok", {
                  requestId: "req-gone",
                  payload: { query, type: "file", limit: 10 },
                }),
              ),
            ),
          )
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("internal")
          expect(retryableOf(res)).toBeFalse()
          expect(res.data).toBeUndefined()
          expect(res.failure?.message).toBe("internal error")
          const wire = JSON.stringify(res)
          expect(wire.includes(dir)).toBeFalse()
          expect(wire.includes(query)).toBeFalse()
          expect(wire.includes("realPath")).toBeFalse()
          expect(wire.includes("PlatformError")).toBeFalse()
          expect(wire.includes("NotFound")).toBeFalse()
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
        const fenceTmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const fenceDir = fenceTmp.path
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const res = asFindFilesResult(
              yield* Effect.promise(() =>
                ext.request("find/files", findReq(fenceDir, "fence-tok", { requestId: "req-fence" })),
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
          const second = asFindFilesResult(
            yield* Effect.promise(() =>
              ext.request("find/files", findReq(fenceDir, "fence-after", { requestId: "req-fence-after" })),
            ),
          )
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBeTrue()
          expect(second.opId).toBe("find-files:fence-after")
          expect(second.idempotencyKey).toBe("find-files:fence-after")
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
