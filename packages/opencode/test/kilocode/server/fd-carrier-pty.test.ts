import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { Server } from "../../../src/server/server"
import { PtyPaths } from "../../../src/server/routes/instance/httpapi/groups/pty"
import { withTimeout } from "../../../src/util/timeout"
import {
  canonicalPtyRemoveOpId,
  canonicalPtyUpdateOpId,
  validatePtyRemoveRequest,
  validatePtyUpdateRequest,
  validatePtyRemoveResult,
  validatePtyUpdateResult,
} from "../../../src/kilocode/pty-private"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

type PtyResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: Record<string, unknown>
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

function asPtyResult(v: unknown, op: string): PtyResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== op) throw new Error(`expected response.op to be ${op}`)
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: PtyResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : {
          type: outcomeRaw.type,
          time: outcomeRaw.time,
          failure: failureOf(outcomeRaw.failure, "response.outcome.failure"),
        }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : asRecord(dataRaw)
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
  } else {
    if (row.accepted !== false) throw new Error("expected accepted false for failed")
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected failure code echo")
  }
  return {
    v: 1,
    requestId,
    opId,
    op,
    idempotencyKey,
    status,
    outcome,
    accepted: row.accepted,
    ...(data ? { data } : {}),
    ...(failure ? { failure } : {}),
  }
}

function codeOf(v: PtyResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

const FAKE_PTY = "pty_00000000000000000000000000"

function updateReq(
  dir: string,
  ptyID: string,
  token = "tok1",
  requestId = "req-upd-1",
  rows = 24,
  cols = 80,
): Record<string, unknown> {
  const opId = canonicalPtyUpdateOpId(ptyID, token)
  return {
    v: 1,
    requestId,
    opId,
    op: "pty/update",
    idempotencyKey: opId,
    context: { directory: dir, ptyID },
    payload: { size: { rows, cols } },
  }
}

function removeReq(dir: string, ptyID: string, token = "tok1", requestId = "req-rem-1"): Record<string, unknown> {
  const opId = canonicalPtyRemoveOpId(ptyID, token)
  return {
    v: 1,
    requestId,
    opId,
    op: "pty/remove",
    idempotencyKey: opId,
    context: { directory: dir, ptyID },
    payload: {},
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["pty/update", "pty/remove"],
    }),
  )
}

async function loadInstance(dir: string): Promise<void> {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
    }),
  )
}

function capsOf(v: unknown): string[] {
  if (!record(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((e): e is string => typeof e === "string")
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!record(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

const auth = { username: "opencode", password: "pty-fd-proof" }

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

async function startListener() {
  Flag.KILO_SERVER_PASSWORD = auth.password
  Flag.KILO_SERVER_USERNAME = auth.username
  process.env.KILO_SERVER_PASSWORD = auth.password
  process.env.KILO_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function stop(listener: Awaited<ReturnType<typeof startListener>>, label: string) {
  return withTimeout(listener.stop(true), 10_000, label)
}

async function createHttpPty(listener: Awaited<ReturnType<typeof startListener>>, dir: string) {
  const response = await fetch(new URL(PtyPaths.create, listener.url), {
    method: "POST",
    headers: {
      authorization: authorization(),
      "x-kilo-directory": dir,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command: "/bin/cat", title: "pty-fd-shared-owner" }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: string }
}

async function httpGetStatus(listener: Awaited<ReturnType<typeof startListener>>, dir: string, id: string) {
  const response = await fetch(new URL(PtyPaths.get.replace(":ptyID", id), listener.url), {
    headers: { authorization: authorization(), "x-kilo-directory": dir },
  })
  return response.status
}

const originalAuth = {
  password: Flag.KILO_SERVER_PASSWORD,
  username: Flag.KILO_SERVER_USERNAME,
  envPassword: process.env.KILO_SERVER_PASSWORD,
  envUsername: process.env.KILO_SERVER_USERNAME,
}

describe("fd-carrier pty/update + pty/remove (Agent Manager PTY)", () => {
  afterEach(async () => {
    Flag.KILO_SERVER_PASSWORD = originalAuth.password
    Flag.KILO_SERVER_USERNAME = originalAuth.username
    if (originalAuth.envPassword === undefined) delete process.env.KILO_SERVER_PASSWORD
    else process.env.KILO_SERVER_PASSWORD = originalAuth.envPassword
    if (originalAuth.envUsername === undefined) delete process.env.KILO_SERVER_USERNAME
    else process.env.KILO_SERVER_USERNAME = originalAuth.envUsername
    await disposeAllInstances()
    await resetDatabase()
  })

  test("initialize advertises pty/update and pty/remove capabilities", async () => {
    const { carrier, ext } = linked()
    try {
      const res = await init(ext)
      const caps = capsOf(res)
      expect(caps.includes("pty/update")).toBeTrue()
      expect(caps.includes("pty/remove")).toBeTrue()
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("pre-init pty/update rejected InvalidRequest", async () => {
    const { carrier, ext } = linked()
    try {
      const err = await ext.request("pty/update", updateReq("/tmp", FAKE_PTY)).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("strict identity: opId must equal idempotencyKey and bind ptyID", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const base = updateReq(dir, FAKE_PTY, "tok-strict", "req-strict")
      const bad = { ...base, idempotencyKey: "pty-update:other:tok-strict" }
      const raw = await ext.request("pty/update", bad)
      const res = asPtyResult(raw, "pty/update")
      expect(res.status).toBe("failed")
      expect(codeOf(res)).toBe("validation.failed")
      expect(res.failure?.retryable).toBe(false)
      expect(res.requestId).toBe("req-strict")
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("update unknown pty maps to terminal pty.not_found (retryable false)", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request("pty/update", updateReq(dir, FAKE_PTY, "tok-nf", "req-nf"))
      const res = asPtyResult(raw, "pty/update")
      expect(res.status).toBe("failed")
      expect(codeOf(res)).toBe("pty.not_found")
      expect(res.failure?.retryable).toBe(false)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("remove unknown pty maps to terminal pty.not_found (already gone)", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request("pty/remove", removeReq(dir, FAKE_PTY, "tok-nf", "req-nf"))
      const res = asPtyResult(raw, "pty/remove")
      expect(res.status).toBe("failed")
      expect(codeOf(res)).toBe("pty.not_found")
      expect(res.failure?.retryable).toBe(false)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("malformed size and extra payload fields fail closed", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const badSize = updateReq(dir, FAKE_PTY, "tok-bad", "req-bad", 0, 80)
      const res1 = asPtyResult(await ext.request("pty/update", badSize), "pty/update")
      expect(res1.status).toBe("failed")
      expect(codeOf(res1)).toBe("validation.failed")
      const extra = {
        ...updateReq(dir, FAKE_PTY, "tok-extra", "req-extra"),
        payload: { size: { rows: 24, cols: 80 }, extra: true },
      }
      const res2 = asPtyResult(await ext.request("pty/update", extra), "pty/update")
      expect(res2.status).toBe("failed")
      expect(codeOf(res2)).toBe("validation.failed")
      const nonEmpty = { ...removeReq(dir, FAKE_PTY, "tok-ne", "req-ne"), payload: { extra: true } }
      const res3 = asPtyResult(await ext.request("pty/remove", nonEmpty), "pty/remove")
      expect(res3.status).toBe("failed")
      expect(codeOf(res3)).toBe("validation.failed")
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("opId ptyID binding mismatch maps to scope_mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const other = "pty_11111111111111111111111111"
      const opId = canonicalPtyUpdateOpId(other, "tok-scope")
      const raw = await ext.request("pty/update", {
        v: 1,
        requestId: "req-scope",
        opId,
        op: "pty/update",
        idempotencyKey: opId,
        context: { directory: dir, ptyID: FAKE_PTY },
        payload: { size: { rows: 24, cols: 80 } },
      })
      const res = asPtyResult(raw, "pty/update")
      expect(res.status).toBe("failed")
      expect(codeOf(res)).toBe("scope_mismatch")
      expect(res.failure?.retryable).toBe(false)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("pty private contract validates and echoes", () => {
    const dir = "/tmp"
    const ptyID = FAKE_PTY
    const upd = validatePtyUpdateRequest(updateReq(dir, ptyID, "tok-c", "req-c"))
    expect(upd.opId).toBe(canonicalPtyUpdateOpId(ptyID, "tok-c"))
    const okUpd = {
      v: 1,
      requestId: upd.requestId,
      opId: upd.opId,
      op: "pty/update",
      idempotencyKey: upd.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { updated: true },
    }
    expect(validatePtyUpdateResult(okUpd, upd).status).toBe("succeeded")
    const rem = validatePtyRemoveRequest(removeReq(dir, ptyID, "tok-c", "req-c"))
    expect(rem.opId).toBe(canonicalPtyRemoveOpId(ptyID, "tok-c"))
    const okRem = {
      v: 1,
      requestId: rem.requestId,
      opId: rem.opId,
      op: "pty/remove",
      idempotencyKey: rem.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { removed: true },
    }
    expect(validatePtyRemoveResult(okRem, rem).status).toBe("succeeded")
  })

  test.skipIf(process.platform === "win32")(
    "Server.listen HTTP create shares canonical PtyServiceMap owner with fd update/remove",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const listener = await startListener()
      try {
        const info = await createHttpPty(listener, dir)
        expect(info.id.length > 0).toBeTrue()
        expect(await httpGetStatus(listener, dir, info.id)).toBe(200)
        await loadInstance(dir)
        const { carrier, ext } = linked()
        try {
          await init(ext)
          const upd = asPtyResult(
            await ext.request("pty/update", updateReq(dir, info.id, "tok-live", "req-live")),
            "pty/update",
          )
          expect(upd.status).toBe("succeeded")
          expect(upd.accepted).toBeTrue()
          expect((upd.data as Record<string, unknown>).updated).toBeTrue()
          expect(upd.requestId).toBe("req-live")
          const rem = asPtyResult(
            await ext.request("pty/remove", removeReq(dir, info.id, "tok-live", "req-live-rm")),
            "pty/remove",
          )
          expect(rem.status).toBe("succeeded")
          expect((rem.data as Record<string, unknown>).removed).toBeTrue()
          const again = asPtyResult(
            await ext.request("pty/remove", removeReq(dir, info.id, "tok-live2", "req-live-rm2")),
            "pty/remove",
          )
          expect(again.status).toBe("failed")
          expect(codeOf(again)).toBe("pty.not_found")
          expect(again.failure?.retryable).toBe(false)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
        expect(await httpGetStatus(listener, dir, info.id)).toBe(404)
      } finally {
        await stop(listener, "timed out stopping pty fd-proof listener").catch(() => undefined)
      }
    },
    { timeout: 60000 },
  )

  test.skipIf(process.platform === "win32")(
    "InstanceStore dispose reaps the dedicated PTY owner entry",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const listener = await startListener()
      try {
        const info = await createHttpPty(listener, dir)
        expect(await httpGetStatus(listener, dir, info.id)).toBe(200)
        await loadInstance(dir)
        const { carrier, ext } = linked()
        try {
          await init(ext)
          const upd = asPtyResult(
            await ext.request("pty/update", updateReq(dir, info.id, "tok-inv", "req-inv")),
            "pty/update",
          )
          expect(upd.status).toBe("succeeded")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
        await disposeAllInstances()
        expect(await httpGetStatus(listener, dir, info.id)).toBe(404)
        await loadInstance(dir)
        const second = linked()
        try {
          await init(second.ext)
          const gone = asPtyResult(
            await second.ext.request("pty/remove", removeReq(dir, info.id, "tok-inv2", "req-inv2")),
            "pty/remove",
          )
          expect(gone.status).toBe("failed")
          expect(codeOf(gone)).toBe("pty.not_found")
        } finally {
          second.carrier.dispose()
          second.ext.dispose()
        }
      } finally {
        await stop(listener, "timed out stopping pty invalidation listener").catch(() => undefined)
      }
    },
    { timeout: 60000 },
  )
})
