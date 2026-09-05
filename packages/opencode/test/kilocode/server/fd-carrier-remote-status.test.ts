import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"

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
  return { carrier, ext, extToCarrier, carrierToExt }
}

function req(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `remote-status:${token}`
  return {
    v: 1,
    requestId: "req-rs-1",
    opId,
    op: "remote/status",
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
      capabilities: ["remote/status"],
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

describe("fd-carrier remote/status (process-global parity)", () => {
  test("initialize advertises remote/status capability", async () => {
    const { carrier, ext } = linked()
    try {
      const res = await init(ext)
      const caps = res.capabilities
      expect(Array.isArray(caps)).toBeTrue()
      expect((caps as unknown[]).includes("remote/status")).toBeTrue()
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("valid request returns process-global booleans with strict identity", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request("remote/status", req("/tmp"))
      const r = asRecord(raw)
      expect(r.v).toBe(1)
      expect(r.op).toBe("remote/status")
      expect(r.requestId).toBe("req-rs-1")
      expect(r.opId).toBe("remote-status:tok1")
      expect(r.idempotencyKey).toBe("remote-status:tok1")
      expect(r.status).toBe("succeeded")
      expect(r.accepted).toBeTrue()
      const payload = payloadOf(raw)
      expect(typeof payload.enabled).toBe("boolean")
      expect(typeof payload.connected).toBe("boolean")
      const out = asRecord(r.outcome)
      expect(out.type).toBe("succeeded")
      expect(typeof out.time).toBe("number")
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("cross-directory equality of process-global booleans (routing-only identity)", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const a = payloadOf(await ext.request("remote/status", req("/tmp", "tokA", { requestId: "ra" })))
      const b = payloadOf(
        await ext.request("remote/status", {
          v: 1,
          requestId: "rb",
          opId: "remote-status:tokB",
          op: "remote/status",
          idempotencyKey: "remote-status:tokB",
          context: { directory: "/var/tmp" },
          payload: {},
        }),
      )
      // Both directories observe the same process-global snapshot; equality
      // is expected and must not be treated as scope isolation.
      expect(a).toEqual(b)
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("strict validation fails closed with redacted validation.failed", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const cases: Record<string, unknown>[] = [
        req("/tmp", "tok1", { v: 2 }),
        req("/tmp", "tok1", { idempotencyKey: "remote-status:other" }),
        req("relative", "tok1"),
        req("/tmp", "tok1", { payload: { reason: "x" } }),
        req("/tmp", "tok1", { opId: "bad-token", idempotencyKey: "bad-token" }),
        req("/tmp", "tok1", { extra: 1 }),
        req("/tmp", "tok1", { context: { directory: "/tmp", sessionId: "ses_x" } }),
        req("/tmp", "tok1", { context: { directory: "/tmp", workspace: "" } }),
      ]
      for (const c of cases) {
        const raw = asRecord(await ext.request("remote/status", c))
        expect(raw.status).toBe("failed")
        expect(raw.accepted).toBeFalse()
        const failure = (raw.failure ?? {}) as Record<string, unknown>
        expect(failure.code).toBe("validation.failed")
        expect(typeof failure.message).toBe("string")
        expect((failure.message as string).length).toBeLessThanOrEqual(200)
        expect(failure.retryable).toBeFalse()
        expect(Object.keys(failure).sort()).toEqual(["code", "message", "retryable"])
        const outcome = asRecord(raw.outcome)
        expect(outcome.type).toBe("failed")
      }
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("workspace routing label is accepted and stays out of the payload", async () => {
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = asRecord(
        await ext.request(
          "remote/status",
          req("/tmp", "tokWs", { requestId: "rws", context: { directory: "/tmp", workspace: "ws1" } }),
        ),
      )
      expect(raw.status).toBe("succeeded")
      const payload = payloadOf(raw)
      expect(typeof payload.enabled).toBe("boolean")
      expect(typeof payload.connected).toBe("boolean")
      expect(Object.keys((asRecord(raw.data).status ?? {}) as Record<string, unknown>).sort()).toEqual([
        "connected",
        "enabled",
      ])
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })

  test("pre-init guard rejects remote/status before initialize", async () => {
    const { carrier, ext } = linked()
    try {
      let code: number | undefined
      try {
        await ext.request("remote/status", req("/tmp"))
      } catch (e) {
        code = (e as { code?: number }).code
      }
      expect(code).toBeDefined()
    } finally {
      ext.dispose()
      carrier.dispose()
    }
  })
})
