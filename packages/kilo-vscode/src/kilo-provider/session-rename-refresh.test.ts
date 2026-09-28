import { describe, expect, test } from "bun:test"
import { KiloProvider } from "../KiloProvider"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

const SID = "ses_abc12300000000000001"
const DIR = "/tmp/ws"
const TITLE = "New Title"

function canonSession(title = TITLE) {
  return {
    id: SID,
    slug: "slug-1",
    projectID: "proj-1",
    directory: DIR,
    title,
    version: "1",
    time: { created: 1, updated: 2 },
  }
}

function foundDetail(title = TITLE) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    session: {
      id: SID,
      title,
      parentID: null,
      directory: DIR,
      projectID: "p",
      createdAt: 1,
      updatedAt: 2,
    },
  }
}

function foundOp(opId: string) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    operation: { opId, outcome: "succeeded", code: "sessionUpdate.succeeded", message: "ok", time: 1 },
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
      data: { session: canonSession() },
      transportUnknown: true,
    }),
  }
}

function harness(opts: { getImpl: (input: { directory: string; sessionId: string }) => Promise<unknown> }) {
  const gets: unknown[] = []
  const ops: unknown[] = []
  let sdkUpdate = 0
  const client = {
    session: {
      update: async () => {
        sdkUpdate += 1
        return { data: canonSession(), error: undefined }
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
    privateSessionUpdateWithHandle: transportUnknown,
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
    currentSession: { id: string; title?: string } | null
    contextSessionID: string | undefined
    sessionDirectories: Map<string, string>
    trackedSessionIds: Set<string>
    refreshes: Map<string, number>
    handleRenameSession: (sid: string, title: string) => Promise<void>
  }
  internal.connectionState = "connected"
  const sent: unknown[] = []
  internal.webview = { postMessage: async (m: unknown) => void sent.push(m) }
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => DIR, configurable: true })
  internal.sessionDirectories.set(SID, DIR)
  internal.trackedSessionIds.add(SID)
  return { internal, sent, gets, ops, sdk: () => sdkUpdate }
}

function updates(sent: unknown[]) {
  return sent.filter((m) => (m as { type?: string }).type === "sessionUpdated")
}

describe("rename refreshNeeded convergence", () => {
  test("rename transient reader failure then recovery updates selected title with zero SDK mutation beyond zero", async () => {
    let calls = 0
    const h = harness({
      getImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error("Peer closed")
        return foundDetail(TITLE)
      },
    })
    h.internal.currentSession = { id: SID, title: "Old" } as never
    h.internal.contextSessionID = SID
    const before = updates(h.sent).length

    await h.internal.handleRenameSession(SID, TITLE)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk()).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.title).toBe(TITLE)
    const after = updates(h.sent)
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)).toMatchObject({ type: "sessionUpdated", session: { id: SID, title: TITLE } })
  })

  test("rename worker failure leaves pending with no fabricated update and zero SDK", async () => {
    const h = harness({
      getImpl: async () => {
        throw new Error("Peer closed")
      },
    })
    h.internal.currentSession = { id: SID, title: "Old" } as never
    h.internal.contextSessionID = SID
    const before = updates(h.sent).length

    await h.internal.handleRenameSession(SID, TITLE)
    await Bun.sleep(20)
    await Bun.sleep(20)

    expect(h.sdk()).toBe(0)
    expect(h.gets).toHaveLength(2)
    expect(h.internal.currentSession?.title).toBe("Old")
    expect(updates(h.sent)).toHaveLength(before)
  })
})
