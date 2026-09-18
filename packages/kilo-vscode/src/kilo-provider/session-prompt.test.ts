import { describe, expect, test } from "bun:test"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { buildPromptIdentity, ensurePromptMessageId, promptSessionPrivateFirst, sendPromptOnce } from "./session-prompt"
import { canonicalPromptOpId, validatePromptContractRequest, validatePromptResult } from "../services/cli-backend/serve-private-prompt-contract"

const SID = "ses_prompt000000000000001"
const DIR = "/tmp/ws"
const MID = "msg_prompt00000000000001"
const PARTS = [{ type: "text", text: "hello" }]

function succeededFor(req: Record<string, unknown>) {
  const ctx = req.context as Record<string, unknown>
  const payload = req.payload as Record<string, unknown>
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/prompt",
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
    op: "session/prompt",
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
    op: "session/prompt",
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
    op: "session/prompt",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("prompt private-first", () => {
  test("identity is prompt:<messageId> with single durable tuple", () => {
    const { opId, idempotencyKey, requestId } = buildPromptIdentity(MID)
    expect(opId).toBe(`prompt:${MID}`)
    expect(idempotencyKey).toBe(opId)
    expect(canonicalPromptOpId(MID)).toBe(opId)
    expect(typeof requestId).toBe("string")
    expect(ensurePromptMessageId(MID)).toBe(MID)
    expect(ensurePromptMessageId(undefined).startsWith("msg_")).toBeTrue()
  })

  test("contract validates canonical op binding", () => {
    const { opId, idempotencyKey, requestId } = buildPromptIdentity(MID)
    const req = {
      v: 1,
      requestId,
      opId,
      op: "session/prompt",
      idempotencyKey,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: MID, parts: PARTS },
    }
    expect(() => validatePromptContractRequest(req)).not.toThrow()
    const bad = { ...req, opId: "prompt:other" }
    expect(() => validatePromptContractRequest(bad)).toThrow()
    const res = succeededFor(req)
    expect(() => validatePromptResult(res, req as never)).not.toThrow()
  })

  test("authoritative success uses zero SDK", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const client = { session: { promptAsync: async () => { sdk += 1; return { data: null } } } }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(succeededFor(req)), cancel: () => true }
      },
    }
    const out = await promptSessionPrivateFirst({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: MID,
      parts: PARTS as unknown as Array<Record<string, unknown>>,
    })
    expect(out.error).toBeUndefined()
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.op).toBe("session/prompt")
    expect(req.idempotencyKey).toBe(req.opId)
    expect(req.opId).toBe(`prompt:${MID}`)
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).sessionId).toBe(SID)
    expect((req.payload as Record<string, unknown>).messageId).toBe(MID)
  })

  test("validated terminal failure uses zero SDK", async () => {
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed"]) {
      let sdk = 0
      const client = { session: { promptAsync: async () => { sdk += 1; return { data: null } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privatePromptWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(terminalFor(req, code)),
          cancel: () => true,
        }),
      }
      let thrown: unknown = null
      try {
        await promptSessionPrivateFirst({
          client: client as never,
          connection: connection as unknown as KiloConnectionService,
          sessionId: SID,
          directory: DIR,
          messageID: MID,
          parts: PARTS as unknown as Array<Record<string, unknown>>,
        })
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
        promptAsync: async (input: Record<string, unknown>) => {
          seenSdk.push(input)
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        seenPrivate.push(req)
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    await promptSessionPrivateFirst({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: MID,
      parts: PARTS as unknown as Array<Record<string, unknown>>,
      model: { providerID: "p", modelID: "m" },
      agent: "build",
      variant: "v",
    })
    expect(seenPrivate).toHaveLength(1)
    expect(seenSdk).toHaveLength(1)
    const priv = seenPrivate[0] as Record<string, unknown>
    const sdk = seenSdk[0] as Record<string, unknown>
    expect(priv.opId).toBe(`prompt:${MID}`)
    expect(sdk.sessionID).toBe(SID)
    expect(sdk.directory).toBe(DIR)
    expect(sdk.messageID).toBe(MID)
    expect(sdk.agent).toBe("build")
  })

  test("unavailable/invalid/ambiguous/closed/timeout each fallback exactly once same message", async () => {
    const cases: Array<{ name: string; conn: unknown; privateCalls?: () => number }> = []
    const mkSdk = () => {
      let n = 0
      const seen: unknown[] = []
      const client = {
        session: {
          promptAsync: async (input: Record<string, unknown>) => {
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
      await promptSessionPrivateFirst({
        client: s.client as never,
        connection: conn as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
      expect(s.count()).toBe(1)
      expect((s.seen[0] as Record<string, unknown>).messageID).toBe(MID)
      cases.push({ name: "unavailable", conn })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privatePromptWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve({ bogus: true, requestId: req.requestId, opId: req.opId, op: "session/prompt", idempotencyKey: req.idempotencyKey }),
          cancel: () => true,
        }),
      }
      await promptSessionPrivateFirst({
        client: s.client as never,
        connection: conn as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
      expect(s.count()).toBe(1)
      cases.push({ name: "invalid", conn })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privatePromptWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(ambiguousFor(req)),
          cancel: () => true,
        }),
      }
      await promptSessionPrivateFirst({
        client: s.client as never,
        connection: conn as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
      expect(s.count()).toBe(1)
      cases.push({ name: "ambiguous", conn })
    }
    {
      const s = mkSdk()
      const conn = {
        isPrivateAvailable: () => true,
        privatePromptWithHandle: () => {
          throw new Error("Peer closed")
        },
      }
      await promptSessionPrivateFirst({
        client: s.client as never,
        connection: conn as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
      expect(s.count()).toBe(1)
      cases.push({ name: "closed", conn })
    }
    {
      const s = mkSdk()
      let cancelled = false
      const conn = {
        isPrivateAvailable: () => true,
        privatePromptWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => { cancelled = true; return true } }),
      }
      await promptSessionPrivateFirst({
        client: s.client as never,
        connection: conn as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
      expect(s.count()).toBe(1)
      expect(cancelled).toBeTrue()
      expect((s.seen[0] as Record<string, unknown>).messageID).toBe(MID)
      cases.push({ name: "timeout", conn })
    }
    expect(cases.map((c) => c.name)).toEqual(["unavailable", "invalid", "ambiguous", "closed", "timeout"])
  })

  test("concurrent same messageID reuses prompt:<messageId> tuple", async () => {
    const privSeen: unknown[] = []
    const sdkSeen: unknown[] = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          sdkSeen.push(input)
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        privSeen.push(req)
        return { id: 1, promise: Promise.resolve(succeededFor(req)), cancel: () => true }
      },
    }
    const args = {
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: MID,
      parts: PARTS as unknown as Array<Record<string, unknown>>,
    }
    await Promise.all([promptSessionPrivateFirst(args), promptSessionPrivateFirst(args)])
    expect(privSeen).toHaveLength(2)
    expect(sdkSeen).toHaveLength(0)
    for (const r of privSeen) {
      expect((r as Record<string, unknown>).opId).toBe(`prompt:${MID}`)
      expect((r as Record<string, unknown>).idempotencyKey).toBe(`prompt:${MID}`)
      expect(((r as Record<string, unknown>).payload as Record<string, unknown>).messageId).toBe(MID)
    }
  })

  test("single-attempt seam never re-enters wrapper on retryable SDK status and posts no local status", async () => {
    let priv = 0
    let sdk = 0
    const retryableErr = new Error("rate limited")
    const retryableRes = {
      status: 429,
      headers: new Headers(),
    } as unknown as Response
    const client = {
      session: {
        promptAsync: async () => {
          sdk += 1
          return { error: retryableErr, response: retryableRes }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        priv += 1
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    let thrown: unknown = null
    try {
      await sendPromptOnce({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(retryableErr)
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
  })

  test("missing messageID stays stable across private and SDK fallback", async () => {
    const privSeen: unknown[] = []
    const sdkSeen: unknown[] = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          sdkSeen.push(input)
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        privSeen.push(req)
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    await sendPromptOnce({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: undefined,
      parts: PARTS as unknown as Array<Record<string, unknown>>,
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

  test("fallback stays on the same promptAsync tuple with full payload and no other endpoint", async () => {
    const privSeen: unknown[] = []
    const sdkSeen: unknown[] = []
    const calls: string[] = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          calls.push("promptAsync")
          sdkSeen.push(input)
          return { data: null }
        },
        prompt: async () => {
          calls.push("prompt")
          return { data: null }
        },
        commandAsync: async () => {
          calls.push("commandAsync")
          return { data: null }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privatePromptWithHandle: (req: Record<string, unknown>) => {
        privSeen.push(req)
        return { id: 1, promise: Promise.resolve(retryableFor(req)), cancel: () => true }
      },
    }
    await promptSessionPrivateFirst({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionId: SID,
      directory: DIR,
      messageID: MID,
      parts: PARTS as unknown as Array<Record<string, unknown>>,
      model: { providerID: "p", modelID: "m" },
      agent: "build",
      variant: "v",
      noReply: true,
      tools: { webfetch: true },
      format: { type: "json" },
      system: "sys",
      snapshotInitialization: "wait",
      editorContext: { active: true },
    })
    expect(privSeen).toHaveLength(1)
    expect(sdkSeen).toHaveLength(1)
    expect(calls).toEqual(["promptAsync"])
    const priv = privSeen[0] as Record<string, unknown>
    const sdk = sdkSeen[0] as Record<string, unknown>
    const payload = priv.payload as Record<string, unknown>
    expect(sdk.sessionID).toBe(SID)
    expect(sdk.directory).toBe(DIR)
    expect(sdk.messageID).toBe(MID)
    expect(sdk.parts).toEqual(PARTS)
    expect(sdk.model).toEqual({ providerID: "p", modelID: "m" })
    expect(sdk.agent).toBe("build")
    expect(sdk.variant).toBe("v")
    expect(sdk.noReply).toBe(true)
    expect(sdk.tools).toEqual({ webfetch: true })
    expect(sdk.system).toBe("sys")
    expect(payload.messageId).toBe(MID)
    expect(priv.opId).toBe(`prompt:${MID}`)
  })

  test("private unavailable still uses the same promptAsync tuple and SDK error throws with no local status post", async () => {
    let sdk = 0
    const seen: unknown[] = []
    const failure = new Error("offline")
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          sdk += 1
          seen.push(input)
          return { error: failure, response: { status: 500 } as unknown as Response }
        },
      },
    }
    const connection = { isPrivateAvailable: () => false }
    let thrown: unknown = null
    try {
      await sendPromptOnce({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionId: SID,
        directory: DIR,
        messageID: MID,
        parts: PARTS as unknown as Array<Record<string, unknown>>,
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(failure)
    expect(sdk).toBe(1)
    expect((seen[0] as Record<string, unknown>).messageID).toBe(MID)
    expect((seen[0] as Record<string, unknown>).sessionID).toBe(SID)
  })
})
