import { describe, expect, test } from "bun:test"
import { KiloProvider } from "../KiloProvider"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function foundDetail(extra?: Record<string, unknown>) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    session: {
      id: SID,
      title: "t",
      parentID: null,
      directory: DIR,
      projectID: "p",
      createdAt: 1,
      updatedAt: 2,
      ...(extra ?? {}),
    },
  }
}

function foundOp(opId: string) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    operation: { opId, outcome: "succeeded", code: "revert.succeeded", message: "ok", time: 1 },
  }
}

function transportUnknown(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 1,
    promise: Promise.resolve({
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: Date.now() },
      accepted: true,
      data: { session: { id: SID, directory: DIR, title: "t" } },
      transportUnknown: true,
    }),
  }
}

function harness(opts: { getImpl: (input: { directory: string; sessionId: string }) => Promise<unknown> }) {
  const gets: unknown[] = []
  const ops: unknown[] = []
  let sdkRevert = 0
  let sdkUnrevert = 0
  const client = {
    session: {
      revert: async () => {
        sdkRevert += 1
        return { data: { id: SID }, error: undefined }
      },
      unrevert: async () => {
        sdkUnrevert += 1
        return { data: { id: SID }, error: undefined }
      },
      status: async () => ({ data: {}, error: undefined }),
      get: async () => {
        throw new Error("SDK session.get must not be used (private-authority)")
      },
    },
    backgroundProcess: { stopSession: async () => ({}) },
  } as unknown as import("@kilocode/sdk/v2/client").KiloClient

  const reader = {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [] }),
    get: async (input: { directory: string; sessionId: string }) => {
      gets.push(input)
      return opts.getImpl(input)
    },
    messages: async () => ({ v: "1.0", status: "found", messages: [] }),
    operation: async (input: { directory: string; sessionId: string; opId: string }) => {
      ops.push(input)
      return foundOp(input.opId)
    },
  } as never

  const connection = {
    isPrivateAvailable: () => true,
    privateRevertWithHandle: transportUnknown,
    privateUnrevertWithHandle: transportUnknown,
    getClient: () => client,
    getClientAsync: async () => client,
    getConnectionError: () => null,
    sandboxPreference: { onChange: () => () => undefined },
    onEventFiltered: () => () => undefined,
    onStateChange: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    registerVisible: () => undefined,
    registerAttached: () => undefined,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    recordMessageSessionId: () => undefined,
    pruneSession: () => undefined,
  } as unknown as KiloConnectionService

  const provider = new KiloProvider(
    { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    connection,
    undefined,
    { projectDirectory: DIR, privateSessionReader: reader } as unknown as Parameters<typeof KiloProvider>[3],
  )
  const internal = provider as unknown as {
    connectionState: string
    webview: { postMessage: (m: unknown) => Promise<unknown> } | null
    currentSession: { id: string; revert?: { messageID: string } } | null
    contextSessionID: string | undefined
    sessionDirectories: Map<string, string>
    trackedSessionIds: Set<string>
    refreshes: Map<string, number>
    handleRevertSession: (sid: string, mid: string) => Promise<void>
    handleUnrevertSession: (sid: string) => Promise<void>
  }
  internal.connectionState = "connected"
  const sent: unknown[] = []
  internal.webview = { postMessage: async (m: unknown) => void sent.push(m) }
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => DIR, configurable: true })
  internal.sessionDirectories.set(SID, DIR)
  internal.trackedSessionIds.add(SID)
  return { internal, sent, gets, ops, sdk: () => ({ revert: sdkRevert, unrevert: sdkUnrevert }) }
}

function updates(sent: unknown[]) {
  return sent.filter((m) => (m as { type?: string }).type === "sessionUpdated")
}

describe("revert/unrevert refreshNeeded convergence", () => {
  test("revert transient reader failure then recovery updates selected checkpoint with zero SDK", async () => {
    let calls = 0
    const h = harness({
      getImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error("Peer closed")
        return foundDetail({ revert: { messageID: MID } })
      },
    })
    h.internal.currentSession = { id: SID } as never
    h.internal.contextSessionID = SID
    const before = updates(h.sent).length

    await h.internal.handleRevertSession(SID, MID)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk().revert).toBe(0)
    expect(h.sdk().unrevert).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.revert).toEqual({ messageID: MID })
    const after = updates(h.sent)
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)).toMatchObject({ type: "sessionUpdated", session: { id: SID, revert: { messageID: MID } } })
  })

  test("unrevert transient reader failure then recovery clears selected checkpoint with zero SDK", async () => {
    let calls = 0
    const h = harness({
      getImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error("Peer closed")
        return foundDetail()
      },
    })
    h.internal.currentSession = { id: SID, revert: { messageID: MID } } as never
    h.internal.contextSessionID = SID

    await h.internal.handleUnrevertSession(SID)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk().revert).toBe(0)
    expect(h.sdk().unrevert).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.revert).toBeUndefined()
    const after = updates(h.sent)
    expect(after.length).toBeGreaterThan(0)
    expect(after.at(-1)).toMatchObject({ type: "sessionUpdated", session: { id: SID, revert: null } })
  })

  test("revert worker failure leaves pending with no fabricated update and zero SDK", async () => {
    const h = harness({
      getImpl: async () => {
        throw new Error("Peer closed")
      },
    })
    h.internal.currentSession = { id: SID } as never
    h.internal.contextSessionID = SID
    const before = updates(h.sent).length

    await h.internal.handleRevertSession(SID, MID)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk().revert).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.revert).toBeUndefined()
    expect(updates(h.sent)).toHaveLength(before)
  })

  test("unrevert worker failure leaves pending with no fabricated update and zero SDK", async () => {
    const h = harness({
      getImpl: async () => {
        throw new Error("Peer closed")
      },
    })
    h.internal.currentSession = { id: SID, revert: { messageID: MID } } as never
    h.internal.contextSessionID = SID
    const before = updates(h.sent).length

    await h.internal.handleUnrevertSession(SID)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk().unrevert).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.revert).toEqual({ messageID: MID })
    expect(updates(h.sent)).toHaveLength(before)
  })
})
