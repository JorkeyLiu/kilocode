import { describe, expect, test } from "bun:test"
import { KiloProvider } from "../KiloProvider"
import { KiloConnectionService } from "../services/cli-backend/connection-service"
import { abortSessionPrivateFirst, buildAbortIdentity } from "./abort"
import { canonicalAbortOpId } from "../services/cli-backend/serve-private-abort-contract"

const SID = "ses_abort00000000000000001"
const DIR = "/tmp"

function terminalFor(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    affected: [{ kind: "root", disposition: "cancelled", generationId: "gen_001", sessionId: SID }],
    diagnostic: { code: "cancelled", retryable: false, time: 1 },
  }
}

function notFoundFor(req: Record<string, unknown>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "session.not_found", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function scopeMismatchFor(req: Record<string, unknown>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "scope_mismatch", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function ambiguousFor(req: Record<string, unknown>) {
  return {
    kind: "ambiguous",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: false,
    transportUnknown: true,
  }
}

describe("abort private-first", () => {
  test("identity binds abort tuple with empty payload and generation separation", () => {
    const { opId, idempotencyKey, requestId } = buildAbortIdentity(SID)
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith(`abort:${SID}:`)).toBeTrue()
    expect(canonicalAbortOpId(SID, opId.split(":")[2]!)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("private terminal success returns with zero SDK and exact tuple", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
    const connection = {
      isPrivateAvailable: () => true,
      privateAbortWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(terminalFor(req)), cancel: () => true }
      },
    }
    const ok = await abortSessionPrivateFirst({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionID: SID,
      directory: DIR,
    })
    expect(ok).toBeTrue()
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.v).toBe(1)
    expect(req.op).toBe("session/abort")
    expect(req.idempotencyKey).toBe(req.opId)
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).sessionId).toBe(SID)
    expect(req.payload).toEqual({})
    const token = String(req.opId).split(":")[2]!
    expect(token.length).toBeGreaterThan(0)
    expect(token).not.toBe("gen_001")
  })

  test("terminal session.not_found and scope_mismatch close with zero SDK", async () => {
    for (const maker of [notFoundFor, scopeMismatchFor]) {
      let sdk = 0
      const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(maker(req)),
          cancel: () => true,
        }),
      }
      let code = ""
      try {
        await abortSessionPrivateFirst({
          client: client as never,
          connection: connection as unknown as KiloConnectionService,
          sessionID: SID,
          directory: DIR,
        })
      } catch (e) {
        code = (e as { code?: string }).code ?? ""
        expect((e as { terminal?: boolean }).terminal).toBeTrue()
      }
      expect(code.length).toBeGreaterThan(0)
      expect(sdk).toBe(0)
    }
  })

  test("terminal accepted:false is invalid and takes exactly one SDK fallback", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const params: unknown[] = []
    const client = {
      session: {
        abort: async (p: unknown) => {
          sdk += 1
          params.push(p)
          return { data: true }
        },
      },
    }
    const connection = {
      isPrivateAvailable: () => true,
      privateAbortWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return {
          id: 1,
          promise: Promise.resolve({ ...terminalFor(req), accepted: false }),
          cancel: () => true,
        }
      },
    }
    const ok = await abortSessionPrivateFirst({
      client: client as never,
      connection: connection as unknown as KiloConnectionService,
      sessionID: SID,
      directory: DIR,
    })
    // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
    expect(ok).toBeTrue()
    expect(sdk).toBe(1)
    expect(seen).toHaveLength(1)
    expect(params).toHaveLength(1)
    expect(params[0]).toEqual({ sessionID: SID, directory: DIR })
  })

  test("invalid, transport, closed, and retryable outcomes each take exactly one SDK with unchanged tuple", async () => {
    const cases: { label: string; outcome: (req: Record<string, unknown>) => Promise<unknown> | unknown }[] = [
      { label: "invalid", outcome: (req) => ({ ...terminalFor(req), affected: "broken" }) },
      { label: "transport", outcome: () => Promise.reject(new Error("transport error")) },
      { label: "closed", outcome: () => Promise.reject(new Error("Peer closed")) },
      {
        label: "retryable",
        outcome: (req) => ({
          ...notFoundFor(req),
          failure: { code: "internal", retryable: true, time: 1 },
        }),
      },
    ]
    for (const item of cases) {
      const seen: unknown[] = []
      let sdk = 0
      const params: unknown[] = []
      const client = {
        session: {
          abort: async (p: unknown) => {
            sdk += 1
            params.push(p)
            return { data: true }
          },
        },
      }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: (req: Record<string, unknown>) => {
          seen.push(req)
          return { id: 1, promise: Promise.resolve(item.outcome(req)), cancel: () => true }
        },
      }
      const ok = await abortSessionPrivateFirst({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionID: SID,
        directory: DIR,
      })
      // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
      expect([item.label, ok]).toEqual([item.label, true])
      expect([item.label, sdk]).toEqual([item.label, 1])
      expect([item.label, seen.length]).toEqual([item.label, 1])
      expect(params[0]).toEqual({ sessionID: SID, directory: DIR })
      const req = seen[0] as Record<string, unknown>
      expect(req.opId).toBe(req.idempotencyKey)
      expect(String(req.opId).startsWith(`abort:${SID}:`)).toBeTrue()
    }
  })

  test("ambiguous, timeout, and unavailable each take exactly one SDK fallback", async () => {
    // ambiguous
    {
      let sdk = 0
      const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(ambiguousFor(req)),
          cancel: () => true,
        }),
      }
      const ok = await abortSessionPrivateFirst({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionID: SID,
        directory: DIR,
      })
      // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
      expect(ok).toBeTrue()
      expect(sdk).toBe(1)
    }
    // timeout with exact handle cancel ownership
    {
      let sdk = 0
      let cancelled: number | null = null
      const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: () => ({
          id: 42,
          promise: new Promise(() => {}),
          cancel: () => { cancelled = 42; return true },
        }),
      }
      const ok = await abortSessionPrivateFirst({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionID: SID,
        directory: DIR,
      })
      // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
      expect(ok).toBeTrue()
      expect(sdk).toBe(1)
      expect(cancelled).toBe(42)
    }
    // unavailable peer
    {
      let sdk = 0
      const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
      const connection = {
        isPrivateAvailable: () => false,
        privateAbortWithHandle: () => { throw new Error("must not be called") },
      }
      const ok = await abortSessionPrivateFirst({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionID: SID,
        directory: DIR,
      })
      // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
      expect(ok).toBeTrue()
      expect(sdk).toBe(1)
    }
    // missing capability maps to single SDK fallback
    {
      let sdk = 0
      const client = { session: { abort: async () => { sdk += 1; return { data: true } } } }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: () => { throw new Error("Private peer missing session/abort capability") },
      }
      const ok = await abortSessionPrivateFirst({
        client: client as never,
        connection: connection as unknown as KiloConnectionService,
        sessionID: SID,
        directory: DIR,
      })
      // Request-path success: exactly-one SDK abort succeeded, not private terminal convergence.
      expect(ok).toBeTrue()
      expect(sdk).toBe(1)
    }
  })

  test("SDK fallback failure propagates with one private attempt and one SDK call", async () => {
    const cases: { label: string; outcome: (req: Record<string, unknown>) => Promise<unknown> | unknown }[] = [
      { label: "ambiguous", outcome: (req) => ambiguousFor(req) },
      { label: "transport", outcome: () => Promise.reject(new Error("transport error")) },
    ]
    for (const item of cases) {
      const seen: unknown[] = []
      let sdk = 0
      const params: unknown[] = []
      const client = {
        session: {
          abort: async (p: unknown) => {
            sdk += 1
            params.push(p)
            throw new Error(`sdk abort failed ${item.label}`)
          },
        },
      }
      const connection = {
        isPrivateAvailable: () => true,
        privateAbortWithHandle: (req: Record<string, unknown>) => {
          seen.push(req)
          return { id: 1, promise: Promise.resolve(item.outcome(req)), cancel: () => true }
        },
      }
      // No success boolean is returned: the single SDK fallback error propagates.
      await expect(
        abortSessionPrivateFirst({
          client: client as never,
          connection: connection as unknown as KiloConnectionService,
          sessionID: SID,
          directory: DIR,
        }),
      ).rejects.toThrow(`sdk abort failed ${item.label}`)
      expect([item.label, sdk]).toEqual([item.label, 1])
      expect([item.label, seen.length]).toEqual([item.label, 1])
      expect(params[0]).toEqual({ sessionID: SID, directory: DIR })
      const req = seen[0] as Record<string, unknown>
      expect(req.opId).toBe(req.idempotencyKey)
      expect(String(req.opId).startsWith(`abort:${SID}:`)).toBeTrue()
    }
  })

  test("KiloProvider handleAbort never fabricates idle or turnClosed", async () => {
    const posted: unknown[] = []
    const client = { session: { abort: async () => ({ data: true }) } }
    const connection = {
      isPrivateAvailable: () => true,
      privateAbortWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminalFor(req)),
        cancel: () => true,
      }),
      getClient: () => client,
      getConnectionError: () => null,
      sandboxPreference: { onChange: () => ({ dispose: () => {} }) },
      onEvent: () => () => {},
      onStateChange: () => () => {},
      getConfigRevision: () => 0,
      onConfigRevision: () => () => {},
    } as unknown as KiloConnectionService
    const provider = new KiloProvider(
      { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      connection,
      undefined,
      { projectDirectory: "/tmp" },
    )
    ;(provider as unknown as Record<string, unknown>).getWorkspaceDirectory = () => DIR
    Object.defineProperty(provider, "client", { value: client, configurable: true })
    ;(provider as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => { posted.push(m) }
    ;(provider as unknown as { currentSession: unknown }).currentSession = { id: SID }
    await (provider as unknown as { handleAbort: (s: string) => Promise<void> }).handleAbort(SID)
    const types = posted.map((m) => (m as { type?: string }).type)
    expect(types.includes("sessionTurnClosed")).toBeFalse()
    expect(types.includes("sessionStatus")).toBeFalse()
    expect(types.includes("error")).toBeFalse()
  })
})
