import { describe, expect, test } from "bun:test"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { buildCommandIdentity, ensureCommandMessageId, commandSessionPrivateFirst, sendCommandOnce } from "./session-command"
import { canonicalCommandOpId, validateCommandContractRequest, validateCommandResult } from "../services/cli-backend/serve-private-command-contract"

const SID = "ses_cmd00000000000000001"
const DIR = "/tmp/ws"
const MID = "msg_cmd00000000000000001"

function succeededFor(req: Record<string, unknown>) {
  const ctx = req.context as Record<string, unknown>
  const payload = req.payload as Record<string, unknown>
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { accepted: true, messageId: payload.messageId, sessionId: ctx.sessionId },
  }
}

function terminalFor(req: Record<string, unknown>, code = "session.not_found") {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: code, retryable: false } },
    accepted: false,
    failure: { code, message: code, retryable: false },
  }
}

function retryableFor(req: Record<string, unknown>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(req: Record<string, unknown>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function baseOpts(client: unknown, connection: unknown, extra?: Record<string, unknown>) {
  return {
    client: client as never,
    connection: connection as unknown as KiloConnectionService,
    sessionId: SID,
    directory: DIR,
    messageID: MID,
    command: "probe",
    args: "hello",
    ...(extra ?? {}),
  } as Parameters<typeof commandSessionPrivateFirst>[0]
}

describe("command private-first", () => {
  test("identity is prompt:<messageId> with single durable tuple", () => {
    const { opId, idempotencyKey, requestId } = buildCommandIdentity(MID)
    expect(opId).toBe(`prompt:${MID}`)
    expect(idempotencyKey).toBe(opId)
    expect(canonicalCommandOpId(MID)).toBe(opId)
    expect(typeof requestId).toBe("string")
    expect(ensureCommandMessageId(MID)).toBe(MID)
    expect(ensureCommandMessageId(undefined).startsWith("msg_")).toBeTrue()
  })

  test("contract validates canonical op binding and model string", () => {
    const { opId, idempotencyKey, requestId } = buildCommandIdentity(MID)
    const req = {
      v: 1,
      requestId,
      opId,
      op: "session/command",
      idempotencyKey,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: MID, command: "probe", arguments: "hi", model: "p/m" },
    }
    expect(() => validateCommandContractRequest(req)).not.toThrow()
    const bad = { ...req, opId: "prompt:other" }
    expect(() => validateCommandContractRequest(bad)).toThrow()
    const badModel = { ...req, payload: { ...(req.payload as Record<string, unknown>), model: "nonslash" } }
    expect(() => validateCommandContractRequest(badModel)).toThrow()
    const res = succeededFor(req)
    expect(() => validateCommandResult(res, req as never)).not.toThrow()
  })

  test("contract validates file parts filename and source shapes", () => {
    const { opId, idempotencyKey, requestId } = buildCommandIdentity(MID)
    const baseReq = {
      v: 1,
      requestId,
      opId,
      op: "session/command",
      idempotencyKey,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: MID, command: "probe", arguments: "hi" },
    }
    const goodFile = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" }
    const goodSymbol = {
      type: "file",
      mime: "text/plain",
      url: "file:///tmp/a.txt",
      source: {
        type: "symbol",
        path: "/tmp/a.txt",
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        name: "fn",
        kind: 1,
        text: { value: "x", start: 0, end: 1 },
      },
    }
    const goodResource = {
      type: "file",
      mime: "text/plain",
      url: "file:///tmp/a.txt",
      source: { type: "resource", clientName: "c", uri: "res://x", text: { value: "x", start: 0, end: 1 } },
    }
    expect(() =>
      validateCommandContractRequest({ ...baseReq, payload: { ...(baseReq.payload as Record<string, unknown>), parts: [goodFile, goodSymbol, goodResource] } }),
    ).not.toThrow()
    const badFilename = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: 42 }
    expect(() =>
      validateCommandContractRequest({ ...baseReq, payload: { ...(baseReq.payload as Record<string, unknown>), parts: [badFilename] } }),
    ).toThrow()
    const badSource = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", source: { type: "bogus" } }
    expect(() =>
      validateCommandContractRequest({ ...baseReq, payload: { ...(baseReq.payload as Record<string, unknown>), parts: [badSource] } }),
    ).toThrow()
  })

  test("authoritative success uses zero SDK", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const client = { session: { command: async () => { sdk += 1; return { data: null } } } }
    const connection = {
      isPrivateAvailable: () => true,
      privateCommandWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(succeededFor(req)), cancel: () => true }
      },
    }
    const out = await commandSessionPrivateFirst(baseOpts(client, connection))
    expect((out as { error?: unknown }).error).toBeUndefined()
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.op).toBe("session/command")
    expect(req.idempotencyKey).toBe(req.opId)
    expect(req.opId).toBe(`prompt:${MID}`)
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).sessionId).toBe(SID)
    expect((req.payload as Record<string, unknown>).messageId).toBe(MID)
    expect((req.payload as Record<string, unknown>).command).toBe("probe")
    expect((req.payload as Record<string, unknown>).arguments).toBe("hello")
  })

  test("validated terminal failure uses zero SDK including command.not_found", async () => {
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed", "command.not_found"]) {
      let sdk = 0
      const client = { session: { command: async () => { sdk += 1; return { data: null } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privateCommandWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(terminalFor(req, code)),
          cancel: () => true,
        }),
      }
      let thrown: unknown = null
      try {
        await commandSessionPrivateFirst(baseOpts(client, connection))
      } catch (e) {
        thrown = e
      }
      expect(thrown).not.toBeNull()
      expect((thrown as Error & { code?: string }).code).toBe(code)
      expect(sdk).toBe(0)
    }
  })

  test("retryable failed falls back exactly once with same tuple", async () => {
    const seenPrivate: unknown[] = []
    const seenSdk: unknown[] = []
    const client = {
      session: {
        command: async (input: Record<string, unknown>) => {
          seenSdk.push(input)
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privateCommandWithHandle: (req: Record<string, unknown>) => {
        seenPrivate.push(req)
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    const filePart = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" }
    await commandSessionPrivateFirst(
      baseOpts(client, connection, {
        model: "p/m",
        agent: "build",
        variant: "v",
        parts: [filePart],
        snapshotInitialization: "wait",
      }),
    )
    expect(seenPrivate).toHaveLength(1)
    expect(seenSdk).toHaveLength(1)
    const priv = seenPrivate[0] as Record<string, unknown>
    const sdk = seenSdk[0] as Record<string, unknown>
    const payload = priv.payload as Record<string, unknown>
    expect(priv.op).toBe("session/command")
    expect(priv.opId).toBe(`prompt:${MID}`)
    expect(priv.idempotencyKey).toBe(`prompt:${MID}`)
    expect(payload.messageId).toBe(MID)
    expect(payload.command).toBe("probe")
    expect(payload.arguments).toBe("hello")
    expect(payload.model).toBe("p/m")
    expect(payload.agent).toBe("build")
    expect(payload.variant).toBe("v")
    expect(payload.snapshotInitialization).toBe("wait")
    expect(sdk.sessionID).toBe(SID)
    expect(sdk.directory).toBe(DIR)
    expect(sdk.messageID).toBe(MID)
    expect(sdk.command).toBe(payload.command)
    expect(sdk.arguments).toBe(payload.arguments)
    expect(sdk.model).toBe(payload.model)
    expect(sdk.agent).toBe(payload.agent)
    expect(sdk.variant).toBe(payload.variant)
    expect(sdk.snapshotInitialization).toBe(payload.snapshotInitialization)
    expect(sdk.messageID).toBe(payload.messageId)
    expect(priv.opId).toBe(`prompt:${sdk.messageID as string}`)
    expect(JSON.stringify(sdk.parts)).toBe(JSON.stringify(payload.parts))
  })

  test("unavailable/invalid/ambiguous/closed/timeout each fallback exactly once same message", async () => {
    const cases: Array<{ name: string }> = []
    const mkSdk = () => {
      let n = 0
      const seen: unknown[] = []
      const client = {
        session: {
          command: async (input: Record<string, unknown>) => {
            n += 1
            seen.push(input)
            return { data: null }
          },
        },
      }
      return { client, count: () => n, seen }
    }
    {
      const s = mkSdk()
      const conn = { isPrivateAvailable: () => false }
      await commandSessionPrivateFirst(baseOpts(s.client, conn))
      expect(s.count()).toBe(1)
      expect((s.seen[0] as Record<string, unknown>).messageID).toBe(MID)
      cases.push({ name: "unavailable" })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privateCommandWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve({ bogus: true, requestId: req.requestId, opId: req.opId, op: "session/command", idempotencyKey: req.idempotencyKey }),
          cancel: () => true,
        }),
      }
      await commandSessionPrivateFirst(baseOpts(s.client, conn))
      expect(s.count()).toBe(1)
      cases.push({ name: "invalid" })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privateCommandWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(ambiguousFor(req)),
          cancel: () => true,
        }),
      }
      await commandSessionPrivateFirst(baseOpts(s.client, conn))
      expect(s.count()).toBe(1)
      cases.push({ name: "ambiguous" })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privateCommandWithHandle: () => {
          throw new Error("Peer closed")
        },
      }
      await commandSessionPrivateFirst(baseOpts(s.client, conn))
      expect(s.count()).toBe(1)
      cases.push({ name: "closed" })
    }
    {
      const s = mkSdk()
      let cancelled = false
      const conn = {
        isPrivateAvailable: () => true,
        privateCommandWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => { cancelled = true; return true } }),
      }
      await commandSessionPrivateFirst(baseOpts(s.client, conn))
      expect(s.count()).toBe(1)
      expect(cancelled).toBeTrue()
      expect((s.seen[0] as Record<string, unknown>).messageID).toBe(MID)
      cases.push({ name: "timeout" })
    }
    expect(cases.map((c) => c.name)).toEqual(["unavailable", "invalid", "ambiguous", "closed", "timeout"])
  })

  test("missing messageID stays stable across private and SDK fallback", async () => {
    const privSeen: unknown[] = []
    const sdkSeen: unknown[] = []
    const client = {
      session: {
        command: async (input: Record<string, unknown>) => {
          sdkSeen.push(input)
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privateCommandWithHandle: (req: Record<string, unknown>) => {
        privSeen.push(req)
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    await sendCommandOnce({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: undefined,
      command: "probe",
      args: "",
    })
    expect(privSeen).toHaveLength(1)
    expect(sdkSeen).toHaveLength(1)
    const priv = privSeen[0] as Record<string, unknown>
    const sdk = sdkSeen[0] as Record<string, unknown>
    const privMid = (priv.payload as Record<string, unknown>).messageId as string
    expect(typeof privMid).toBe("string")
    expect(privMid.startsWith("msg_")).toBeTrue()
    expect(sdk.messageID).toBe(privMid)
    expect(priv.opId).toBe(`prompt:${privMid}`)
    expect(priv.idempotencyKey).toBe(`prompt:${privMid}`)
  })

  test("single-attempt seam never re-enters wrapper on retryable SDK status", async () => {
    let priv = 0
    let sdk = 0
    let idle = 0
    const retryableErr = new Error("rate limited")
    const retryableRes = { status: 429, headers: new Headers() } as unknown as Response
    const client = {
      session: {
        command: async () => {
          sdk += 1
          return { error: retryableErr, response: retryableRes }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privateCommandWithHandle: (req: Record<string, unknown>) => {
        priv += 1
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    let thrown: unknown = null
    try {
      await sendCommandOnce(
        {
          client: client as never,
          connection: connection as unknown as KiloConnectionService,
          sessionId: SID,
          directory: DIR,
          messageID: MID,
          command: "probe",
          args: "",
        },
        () => {
          idle += 1
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(retryableErr)
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
    expect(idle).toBe(1)
  })
})
