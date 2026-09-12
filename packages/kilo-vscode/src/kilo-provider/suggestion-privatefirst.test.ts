import { describe, expect, test, spyOn } from "bun:test"
import {
  handleSuggestionAccept,
  handleSuggestionDismiss,
  type SuggestionContext,
} from "./handlers/suggestion"
import { buildSuggestionAcceptIdentity, buildSuggestionDismissIdentity } from "./suggestion-privatefirst"
import { canonicalSuggestionOpId } from "../services/cli-backend/serve-private-suggestion-contract"

const DIR = "/workspace/session-origin"
const RID = "sug_test00000000000000001"

function terminalAccept(req: Record<string, unknown>, index = 0) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses-root",
    requestID: (req.context as Record<string, unknown>).requestID,
    index,
    action: { label: "Run", prompt: "Run tests" },
  }
}

function terminalDismiss(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses-root",
    requestID: (req.context as Record<string, unknown>).requestID,
  }
}

function notFound(req: Record<string, unknown>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "suggestion.not_found", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function scopeMismatch(req: Record<string, unknown>) {
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

function vague(req: Record<string, unknown>) {
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

function base(opts: {
  conn?: SuggestionContext["connection"]
  acceptError?: unknown
  dismissError?: unknown
}) {
  const messages: unknown[] = []
  const accepts: unknown[] = []
  const dismisses: unknown[] = []
  const client = {
    suggestion: {
      list: async () => ({ data: [] }),
      accept: async (args: unknown) => {
        accepts.push(args)
        if (opts.acceptError) throw opts.acceptError
        return { data: true }
      },
      dismiss: async (args: unknown) => {
        dismisses.push(args)
        if (opts.dismissError) throw opts.dismissError
        return { data: true }
      },
    },
  } as unknown as SuggestionContext["client"]
  const fake: SuggestionContext = {
    client,
    currentSessionId: "ses-root",
    trackedSessionIds: new Set(["ses-root"]),
    sessionDirectories: new Map([["ses-root", DIR]]),
    connection: opts.conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => DIR,
  }
  return { fake, messages, accepts, dismisses }
}

describe("suggestion private-first", () => {
  test("identity binds suggestion tuple", () => {
    const acceptIds = buildSuggestionAcceptIdentity(RID)
    expect(acceptIds.opId).toBe(acceptIds.idempotencyKey)
    expect(acceptIds.opId.startsWith(`suggestion:${RID}:`)).toBeTrue()
    const token = acceptIds.opId.split(":")[2]!
    expect(canonicalSuggestionOpId(RID, token)).toBe(acceptIds.opId)
    const dismissIds = buildSuggestionDismissIdentity(RID)
    expect(dismissIds.opId).toBe(dismissIds.idempotencyKey)
    expect(dismissIds.opId.startsWith(`suggestion:${RID}:`)).toBeTrue()
  })

  test("private terminal accept returns with zero SDK", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionAcceptWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(terminalAccept(req, 1)), cancel: () => true }
      },
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn })
    const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
    const orig = client.suggestion.accept
    client.suggestion.accept = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    await handleSuggestionAccept(fake, RID, 1, "ses-root")
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.v).toBe(1)
    expect(req.op).toBe("suggestion/accept")
    expect(req.idempotencyKey).toBe(req.opId)
    expect(String(req.opId).startsWith(`suggestion:${RID}:`)).toBeTrue()
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).requestID).toBe(RID)
    expect((req.payload as Record<string, unknown>).index).toBe(1)
    expect(messages).not.toContainEqual({ type: "suggestionError", requestID: RID })
  })

  test("private terminal dismiss returns with zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionDismissWithHandle: (req: Record<string, unknown>) => ({
        id: 3,
        promise: Promise.resolve(terminalDismiss(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake } = base({ conn })
    const client = fake.client as unknown as { suggestion: { dismiss: (a: unknown) => Promise<unknown> } }
    const orig = client.suggestion.dismiss
    client.suggestion.dismiss = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    await handleSuggestionDismiss(fake, RID, "ses-root")
    expect(sdk).toBe(0)
  })

  test("not_found takes stale resolved path with zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionAcceptWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn })
    const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
    const orig = client.suggestion.accept
    client.suggestion.accept = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    await handleSuggestionAccept(fake, RID, 0, "ses-root")
    expect(sdk).toBe(0)
    expect(messages).toContainEqual({ type: "suggestionResolved", requestID: RID })
  })

  test("duplicate accept index mismatch still surfaces not_found stale", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionDismissWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn })
    await handleSuggestionDismiss(fake, RID, "ses-root")
    expect(messages).toContainEqual({ type: "suggestionResolved", requestID: RID })
  })

  test("scope_mismatch closes with zero SDK and error", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionAcceptWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(scopeMismatch(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn })
    const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
    const orig = client.suggestion.accept
    client.suggestion.accept = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await handleSuggestionAccept(fake, RID, 0, "ses-root")
    spy.mockRestore()
    expect(sdk).toBe(0)
    expect(messages).toContainEqual({ type: "suggestionError", requestID: RID })
  })

  test("invalid, ambiguous each take exactly one SDK with same tuple", async () => {
    const cases: Array<{ label: string; make: (req: Record<string, unknown>) => unknown }> = [
      { label: "invalid", make: (req) => ({ ...terminalAccept(req), index: 9 }) },
      { label: "ambiguous", make: (req) => vague(req) },
    ]
    for (const entry of cases) {
      const seen: unknown[] = []
      let sdk = 0
      const params: unknown[] = []
      const conn = {
        isPrivateAvailable: () => true,
        privateSuggestionAcceptWithHandle: (req: Record<string, unknown>) => {
          seen.push(req)
          return { id: 1, promise: Promise.resolve(entry.make(req)), cancel: () => true }
        },
      } as unknown as SuggestionContext["connection"]
      const { fake, accepts } = base({ conn })
      const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
      const orig = client.suggestion.accept
      client.suggestion.accept = async (a: unknown) => {
        sdk += 1
        params.push(a)
        return orig(a)
      }
      await handleSuggestionAccept(fake, RID, 0, "ses-root")
      expect([entry.label, sdk]).toEqual([entry.label, 1])
      expect([entry.label, seen.length]).toEqual([entry.label, 1])
      expect(params[0]).toEqual({ requestID: RID, index: 0, directory: DIR })
      expect(accepts).toHaveLength(1)
    }
  })

  test("unavailable and missing capability each take exactly one SDK", async () => {
    {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => false,
        privateSuggestionAcceptWithHandle: () => {
          throw new Error("must not be called")
        },
      } as unknown as SuggestionContext["connection"]
      const { fake } = base({ conn })
      const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
      const orig = client.suggestion.accept
      client.suggestion.accept = async (a: unknown) => {
        sdk += 1
        return orig(a)
      }
      await handleSuggestionAccept(fake, RID, 0, "ses-root")
      expect(sdk).toBe(1)
    }
    {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateSuggestionAcceptWithHandle: () => {
          throw new Error("Private peer missing suggestion/accept capability")
        },
      } as unknown as SuggestionContext["connection"]
      const { fake } = base({ conn })
      const client = fake.client as unknown as { suggestion: { accept: (a: unknown) => Promise<unknown> } }
      const orig = client.suggestion.accept
      client.suggestion.accept = async (a: unknown) => {
        sdk += 1
        return orig(a)
      }
      await handleSuggestionAccept(fake, RID, 0, "ses-root")
      expect(sdk).toBe(1)
    }
  })

  test("timeout cancels exact id and takes exactly one SDK", async () => {
    let cancelled: number | null = null
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionDismissWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled = 42
          return true
        },
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake } = base({ conn })
    const client = fake.client as unknown as { suggestion: { dismiss: (a: unknown) => Promise<unknown> } }
    const orig = client.suggestion.dismiss
    client.suggestion.dismiss = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    await handleSuggestionDismiss(fake, RID, "ses-root")
    expect(sdk).toBe(1)
    expect(cancelled).toBe(42)
  })

  test("fallback 404 preserves stale resolved semantics", async () => {
    const notFoundErr = new Error("missing", { cause: { status: 404, body: { name: "NotFoundError" } } })
    const vagueConn = {
      isPrivateAvailable: () => true,
      privateSuggestionAcceptWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn: vagueConn, acceptError: notFoundErr })
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await handleSuggestionAccept(fake, RID, 0, "ses-root")
    spy.mockRestore()
    expect(messages).toContainEqual({ type: "suggestionResolved", requestID: RID })
  })

  test("fallback non-404 posts error", async () => {
    const vagueConn = {
      isPrivateAvailable: () => true,
      privateSuggestionDismissWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as unknown as SuggestionContext["connection"]
    const { fake, messages } = base({ conn: vagueConn, dismissError: new Error("boom") })
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await handleSuggestionDismiss(fake, RID, "ses-root")
    spy.mockRestore()
    expect(messages).toContainEqual({ type: "suggestionError", requestID: RID })
  })
})
