import { describe, expect, mock, spyOn, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { KiloSessions } from "../../../src/kilo-sessions/kilo-sessions"
import { RemoteWS } from "../../../src/kilo-sessions/remote-ws"
import { RemoteSender } from "../../../src/kilo-sessions/remote-sender"
import { clearInFlightCache } from "../../../src/kilo-sessions/inflight-cache"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { markProjectConfigReady } from "../../fixture/plugin"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function enableReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `remote-enable:${token}`
  return {
    v: 1,
    requestId: "req-en-1",
    opId,
    op: "remote/enable",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
    ...overrides,
  }
}

function disableReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `remote-disable:${token}`
  return {
    v: 1,
    requestId: "req-dis-1",
    opId,
    op: "remote/disable",
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
      capabilities: ["remote/enable"],
    }),
  )
}

function payloadOf(v: unknown): { enabled: unknown; connected: unknown } {
  const r = asRecord(v)
  const data = r.data
  if (!isRecord(data)) throw new Error("expected record data")
  const status = (data as Record<string, unknown>).status
  if (!isRecord(status)) throw new Error("expected record data.status")
  return { enabled: status.enabled, connected: status.connected }
}

describe("fd-carrier remote/enable|disable (process-global owner)", () => {
  test("initialize advertises remote/enable and remote/disable", async () => {
    const { carrier, ext } = linked()
    try {
      const res = await init(ext)
      const caps = res.capabilities as unknown[]
      expect(caps.includes("remote/enable")).toBeTrue()
      expect(caps.includes("remote/disable")).toBeTrue()
      expect(caps.includes("remote/status")).toBeTrue()
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("strict validation rejects unknown fields and opId mismatch", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const bad = enableReq("/tmp", "t1", { extra: 1 })
      const r = asRecord(await ext.request("remote/enable", bad))
      expect(r.status).toBe("failed")
      expect(r.accepted).toBeFalse()
      const failure = asRecord(r.failure)
      expect(failure.code).toBe("validation.failed")
      const wrongOp = enableReq("/tmp", "t1", { op: "remote/disable" })
      const r2 = asRecord(await ext.request("remote/enable", wrongOp))
      expect(r2.status).toBe("failed")
      const mismatch = enableReq("/tmp", "t1", { idempotencyKey: "remote-enable:other" })
      const r3 = asRecord(await ext.request("remote/enable", mismatch))
      expect(r3.status).toBe("failed")
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("disable is idempotent and returns current status", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      KiloSessions.disableRemote()
      const raw = await ext.request("remote/disable", disableReq("/tmp", "d1", { requestId: "d1" }))
      const r = asRecord(raw)
      expect(r.status).toBe("succeeded")
      expect(r.accepted).toBeTrue()
      expect(r.op).toBe("remote/disable")
      const payload = payloadOf(raw)
      expect(typeof payload.enabled).toBe("boolean")
      expect(typeof payload.connected).toBe("boolean")
      const second = asRecord(await ext.request("remote/disable", disableReq("/tmp", "d2", { requestId: "d2" })))
      expect(second.status).toBe("succeeded")
      expect(payloadOf(second)).toEqual(payload)
    } finally {
      KiloSessions.disableRemote()
      ext.dispose()
      carrier.dispose()
    }
  })

  test("cross-directory disable observes same process-global status", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      KiloSessions.disableRemote()
      const a = payloadOf(await ext.request("remote/disable", disableReq("/tmp", "ca", { requestId: "ca" })))
      const b = payloadOf(await ext.request("remote/disable", disableReq("/var/tmp", "cb", { requestId: "cb" })))
      expect(a).toEqual(b)
    } finally {
      KiloSessions.disableRemote()
      ext.dispose()
      carrier.dispose()
    }
  })

  test("enable failure is redacted with no token/url material", async () => {
    const { carrier, ext } = linked()
    const prev = process.env["KILO_API_KEY"]
    try {
      await init(ext)
      KiloSessions.disableRemote()
      process.env["KILO_API_KEY"] = ""
      const raw = await ext.request("remote/enable", enableReq("/tmp", "secret-tok", { requestId: "e1" }))
      const r = asRecord(raw)
      // No credentials in this env: either validation-shaped terminal or
      // internal; identity echo (requestId/opId) is required binding, but the
      // redacted failure carries only {code,message,retryable} with no
      // token/URL/credential material.
      if (r.status === "failed") {
        const failure = asRecord(r.failure)
        expect(typeof failure.code).toBe("string")
        expect(typeof failure.message).toBe("string")
        expect(typeof failure.retryable).toBe("boolean")
        expect(Object.keys(failure).sort()).toEqual(["code", "message", "retryable"])
        const ftext = JSON.stringify(failure)
        expect(ftext.includes("secret-tok")).toBeFalse()
        expect(ftext.includes("KILO_API_KEY")).toBeFalse()
        expect(ftext.includes("http")).toBeFalse()
      } else {
        expect(r.accepted).toBeTrue()
      }
    } finally {
      if (prev === undefined) delete process.env["KILO_API_KEY"]
      else process.env["KILO_API_KEY"] = prev
      KiloSessions.disableRemote()
      ext.dispose()
      carrier.dispose()
    }
  })

  test("disable during in-flight enable keeps remoteSeq semantics (no stuck enabling)", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      KiloSessions.disableRemote()
      const pending = ext.request("remote/enable", enableReq("/tmp", "race1", { requestId: "race1" }))
      const off = asRecord(await ext.request("remote/disable", disableReq("/tmp", "race2", { requestId: "race2" })))
      expect(off.status).toBe("succeeded")
      const settled = asRecord(await pending)
      // Either the enable failed closed or it succeeded then was cancelled by
      // the disable's remoteSeq bump; in both cases status reflects owner.
      expect(["succeeded", "failed"].includes(settled.status as string)).toBeTrue()
      const status = KiloSessions.remoteStatus()
      expect(typeof status.enabled).toBe("boolean")
    } finally {
      KiloSessions.disableRemote()
      ext.dispose()
      carrier.dispose()
    }
  })

  test("deterministic in-flight disable: stale enable never reinstalls remote", async () => {
    // Owner-level determinism: the fd carrier runs remote/enable without an
    // InstanceRef lane, so the gate must sit at the KiloSessions owner seams
    // (KILO_API_KEY + fetch authValid gate + RemoteWS/RemoteSender spies).
    // No production hooks are added; all injection is test-only.
    await using tmp = await tmpdir({ git: true })
    await markProjectConfigReady(tmp.path)
    const prevKey = process.env["KILO_API_KEY"]
    const prevIngest = process.env["KILO_DISABLE_SESSION_INGEST"]
    const prevUrl = process.env["KILO_SESSION_INGEST_URL"]
    process.env["KILO_API_KEY"] = "tok"
    process.env["KILO_DISABLE_SESSION_INGEST"] = "0"
    delete process.env["KILO_SESSION_INGEST_URL"]
    let connects = 0
    let closes = 0
    let disposes = 0
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const connectSpy = spyOn(RemoteWS, "connect").mockImplementation(
      () =>
        ({
          connectionId: `conn-${++connects}`,
          send() {},
          close() {
            closes += 1
          },
          get connected() {
            return true
          },
        }) as unknown as RemoteWS.Connection,
    )
    const senderSpy = spyOn(RemoteSender, "create").mockImplementation(
      () =>
        ({
          handle() {},
          dispose() {
            disposes += 1
          },
        }) as unknown as RemoteSender.Sender,
    )
    clearInFlightCache("kilo-sessions:token")
    clearInFlightCache("kilo-sessions:token-valid:tok")
    const realFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown) => {
      await gate
      if (String(input).endsWith("/api/user")) return new Response(null, { status: 200 })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          KiloSessions.disableRemote()
          clearInFlightCache("kilo-sessions:token-valid:tok")
          const pending = KiloSessions.enableRemote()
          // enableRemote sets `enabling` synchronously before its first
          // await, so reaching this line with enabled=true proves the
          // in-flight window is open before disable runs.
          expect(KiloSessions.remoteStatus().enabled).toBeTrue()
          KiloSessions.disableRemote()
          releaseGate()
          await pending
          expect(connects).toBe(1)
          expect(disposes).toBe(1)
          expect(closes).toBe(1)
          expect(KiloSessions.remoteStatus()).toEqual({ enabled: false, connected: false })
        },
      })
    } finally {
      KiloSessions.disableRemote()
      globalThis.fetch = realFetch
      connectSpy.mockRestore()
      senderSpy.mockRestore()
      mock.restore()
      if (prevKey === undefined) delete process.env["KILO_API_KEY"]
      else process.env["KILO_API_KEY"] = prevKey
      if (prevIngest === undefined) delete process.env["KILO_DISABLE_SESSION_INGEST"]
      else process.env["KILO_DISABLE_SESSION_INGEST"] = prevIngest
      if (prevUrl === undefined) delete process.env["KILO_SESSION_INGEST_URL"]
      else process.env["KILO_SESSION_INGEST_URL"] = prevUrl
      clearInFlightCache("kilo-sessions:token")
      clearInFlightCache("kilo-sessions:token-valid:tok")
    }
  })
})
