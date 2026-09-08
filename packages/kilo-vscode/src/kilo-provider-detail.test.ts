import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"
import { ErrorCode } from "./private-worker/json-rpc"

function makeSdkSession(id = "ses_abc", dir = "/tmp/ws") {
  return {
    id,
    directory: dir,
    title: "hello",
    parentID: null,
    projectID: "proj_test",
    time: { created: 1000, updated: 2000 },
    summary: { additions: 1, deletions: 2, files: 1 },
    revert: { messageID: "msg_1" },
    agent: "agentX",
  } as unknown as import("@kilocode/sdk/v2/client").Session
}

function makePrivateFound(id = "ses_abc", dir = "/tmp/ws", extra: Record<string, unknown> = {}) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    session: {
      id,
      title: "hello",
      parentID: null,
      directory: dir,
      projectID: "proj_test",
      createdAt: 1000,
      updatedAt: 2000,
      agent: "agentX",
      summary: { additions: 1, deletions: 2, files: 1 },
      revert: { messageID: "msg_1" },
      ...extra,
    },
  }
}

function makeHarness(opts: {
  privateEnabled?: boolean
  privateStarted?: boolean
  privateGet?: (input: { directory: string; sessionId: string }) => Promise<unknown>
  sdkGet?: (p: unknown, o: unknown) => Promise<unknown>
  clientAvailable?: boolean
  dir?: string
} = {}) {
  const dir = opts.dir ?? "/tmp/ws"
  const sdkGets: unknown[] = []
  const parityGets: unknown[] = []
  const privateGets: unknown[] = []
  const sdkData = makeSdkSession("ses_abc", dir)
  const client = opts.clientAvailable === false ? null : {
    session: {
      get: async (p: unknown, _o: unknown) => {
        sdkGets.push(p)
        if (opts.sdkGet) return (opts.sdkGet as unknown as (a: unknown, b: unknown) => Promise<unknown>)(p, _o)
        return { data: sdkData, error: undefined, response: { status: 200, headers: { get: () => null } } }
      },
      messages: async () => ({ data: [], response: { headers: { get: () => null } } }),
      status: async () => ({ data: {}, response: { status: 200 } }),
      create: async () => ({ data: sdkData, error: undefined, response: { status: 200 } }),
      delete: async () => ({ error: undefined }),
      revert: async () => ({ data: sdkData, error: undefined }),
      unrevert: async () => ({ data: sdkData, error: undefined }),
    },
    backgroundProcess: { stopSession: async () => {} },
    instance: { reload: async () => {} },
  } as unknown as import("@kilocode/sdk/v2/client").KiloClient

  const privateReader = {
    isEnabled: () => opts.privateEnabled ?? true,
    isStarted: () => opts.privateStarted ?? true,
    list: async () => ({ v: "1.0", entries: [], nextCursor: undefined }),
    get: async (input: { directory: string; sessionId: string }) => {
      privateGets.push(input)
      if (opts.privateGet) return opts.privateGet(input)
      return makePrivateFound(input.sessionId, input.directory)
    },
  }

  const connectionService = {
    isPrivateAvailable: () => true,
    privateGetOutcomeWithHandle: (req: Record<string, unknown>) => {
      parityGets.push(req)
      return { id: parityGets.length, promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: req.requestId, opId: req.opId, op: "session/get", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { session: { id: (req.context as Record<string, unknown>).sessionId, directory: (req.context as Record<string, unknown>).directory, title: "hello" } } } }) }
    },
    privateGetWithHandle: (req: Record<string, unknown>) => {
      parityGets.push(req)
      return { id: parityGets.length, promise: Promise.resolve({ v: 1, requestId: req.requestId, opId: req.opId, op: "session/get", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { session: { id: (req.context as Record<string, unknown>).sessionId, directory: (req.context as Record<string, unknown>).directory, title: "hello" } } }) }
    },
    getPrivateEpoch: () => 1,
    getClient: () => {
      if (!client) throw new Error("Not connected")
      return client
    },
    getClientAsync: async () => {
      if (!client) throw new Error("Not connected")
      return client
    },
    getConnectionError: () => null,
    sandboxPreference: { onChange: () => ({ dispose: () => {} }) },
    onEvent: () => () => {},
    onEventFiltered: () => () => {},
    onStateChange: () => () => {},
    getConfigRevision: () => 0,
    onConfigRevision: () => () => {},
    registerDirectoryProvider: () => () => {},
    registerVisible: () => {},
    registerAttached: () => {},
    unregisterVisible: () => {},
    unregisterAttached: () => {},
    recordMessageSessionId: () => {},
    pruneSession: () => {},
  } as unknown as KiloConnectionService

  const provider = new KiloProvider(
    { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    connectionService,
    undefined,
    { projectDirectory: dir, privateSessionReader: privateReader } as unknown as Parameters<typeof KiloProvider>[3],
  ) as unknown as Record<string, unknown> & KiloProvider
  // inject client getter
  Object.defineProperty(provider, "client", { get: () => client })
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: (sid?: string) => dir, configurable: true })
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  // spy parity not needed
  return { provider, client, dir, sdkGets, parityGets, privateGets, privateReader, connectionService, sdkData }
}

describe("KiloProvider detail private-first matrix", () => {
  it("private found -> authoritative detail, no SDK and no parity", async () => {
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory, { title: "private-title" }),
    })
    const p = h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<import("./kilo-provider/session-detail").SessionDetail> }
    const detail = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<import("./kilo-provider/session-detail").SessionDetail | undefined> }).getSessionInfo("ses_abc")
    expect(detail?.title).toBe("private-title")
    expect(h.sdkGets).toHaveLength(0)
    expect(h.parityGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
  })

  it("private not_found -> authoritative terminal, no SDK, optional returns undefined", async () => {
    const h = makeHarness({
      privateGet: async () => ({ v: "1.0", status: "not_found" }),
    })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_missing")
    expect(out).toBeUndefined()
    expect(h.sdkGets).toHaveLength(0)
    expect(h.parityGets).toHaveLength(0)
  })

  it("private scope_mismatch -> authoritative terminal, strict throws bounded domain error", async () => {
    const h = makeHarness({
      privateGet: async () => ({ v: "1.0", status: "scope_mismatch" }),
    })
    const p = h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<unknown> }
    let threw = false
    try {
      await p.getSessionDetail("ses_abc", "/tmp/ws")
    } catch (e) {
      threw = true
      expect((e as Error).name).toMatch(/ScopeMismatch/)
      expect(String((e as Error).message)).not.toContain("/tmp")
    }
    expect(threw).toBeTrue()
    expect(h.sdkGets).toHaveLength(0)
  })

  it("private malformed -> bounded warning then SDK exactly once with parity", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    const h = makeHarness({
      privateGet: async () => ({ v: "1.0", status: "found", session: { id: "bad", title: 123 } }),
    })
    try {
      const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
      expect((out as Record<string, unknown>).id).toBe("ses_abc")
      expect(h.sdkGets).toHaveLength(1)
      expect(h.privateGets).toHaveLength(1)
      // wait for detached parity
      await new Promise((r) => setTimeout(r, 60))
      expect(h.parityGets.length).toBeGreaterThanOrEqual(1)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Detail]"))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  it("private InternalError -> fallback SDK once with parity", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    const err = Object.assign(new Error("private failed"), { code: ErrorCode.InternalError })
    const h = makeHarness({
      privateGet: async () => { throw err },
    })
    try {
      const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
      expect((out as Record<string, unknown>).id).toBe("ses_abc")
      expect(h.sdkGets).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 60))
      expect(h.parityGets.length).toBeGreaterThanOrEqual(1)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Detail]"))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  it("private MethodNotFound -> fallback SDK once", async () => {
    const err = Object.assign(new Error("not found"), { code: ErrorCode.MethodNotFound })
    const h = makeHarness({ privateGet: async () => { throw err } })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
    expect((out as Record<string, unknown>).id).toBe("ses_abc")
    expect(h.sdkGets).toHaveLength(1)
  })

  it("gate off (disabled) -> SDK once with parity", async () => {
    const h = makeHarness({ privateEnabled: false })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
    expect((out as Record<string, unknown>).id).toBe("ses_abc")
    expect(h.sdkGets).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(h.parityGets.length).toBeGreaterThanOrEqual(1)
    expect(h.privateGets).toHaveLength(0)
  })

  it("gate not started -> SDK once", async () => {
    const h = makeHarness({ privateStarted: false })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
    expect((out as Record<string, unknown>).id).toBe("ses_abc")
    expect(h.sdkGets).toHaveLength(1)
  })

  it("SDK unavailable with private error -> preserves semantics without SDK retry", async () => {
    const err = Object.assign(new Error("private failed"), { code: ErrorCode.InternalError })
    const h = makeHarness({ clientAvailable: false, privateGet: async () => { throw err } })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
    expect(out).toBeUndefined()
    expect(h.sdkGets).toHaveLength(0)
  })

  it("empty agent/summary/revert preserved", async () => {
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory, { agent: "", summary: { additions: 0, deletions: 0, files: 0 }, revert: { messageID: "msg_1", partID: "prt_1" } }),
    })
    const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc") as Record<string, unknown>
    expect(out.agent).toBe("")
    expect((out.summary as Record<string, unknown>).additions).toBe(0)
    expect((out.revert as Record<string, unknown>).messageID).toBe("msg_1")
    expect(h.sdkGets).toHaveLength(0)
  })

  it("currentSession writers preserve detail via SDK mapping", async () => {
    const h = makeHarness({})
    // simulate create -> uses sdkSessionToDetail
    const sdk = makeSdkSession("ses_new", "/tmp/ws")
    const anyProvider = h.provider as unknown as Record<string, unknown>
    const detail = (await import("./kilo-provider/session-detail")).sdkSessionToDetail(sdk)
    expect(detail.id).toBe("ses_new")
    expect(detail.directory).toBe("/tmp/ws")
    // check detailToWebview preserves null semantics
    const web = (await import("./kilo-provider/session-detail")).detailToWebview({ id: "ses_1", title: "t", parentID: null, directory: "/tmp/ws", projectID: "p", createdAt: 1, updatedAt: 2 })
    expect(web.parentID).toBeNull()
    expect(web.revert).toBeNull()
    expect(web.summary).toBeNull()
    const web2 = (await import("./kilo-provider/session-detail")).detailToWebview({ id: "ses_1", title: "t", parentID: "ses_parent", directory: "/tmp/ws", projectID: "p", createdAt: 1, updatedAt: 2, revert: { messageID: "msg_1" } })
    expect((web2.revert as Record<string, unknown>).messageID).toBe("msg_1")
  })

  it("strict signal reaches SDK fallback", async () => {
    const sdkGets: Array<{ signal?: AbortSignal }> = []
    const h = makeHarness({
      privateGet: async () => { const e = Object.assign(new Error("boom"), { code: ErrorCode.InternalError }); throw e },
      sdkGet: async (_p: unknown, opts: unknown) => {
        sdkGets.push(opts as { signal?: AbortSignal })
        return { data: makeSdkSession("ses_abc", "/tmp/ws"), error: undefined, response: { status: 200, headers: { get: () => null } } }
      },
    })
    const ctrl = new AbortController()
    const p = h.provider as unknown as { getSessionDetail: (id: string, dir: string, signal?: AbortSignal) => Promise<unknown> }
    const detail = await p.getSessionDetail("ses_abc", "/tmp/ws", ctrl.signal)
    expect((detail as Record<string, unknown>).id).toBe("ses_abc")
    expect(sdkGets[0]?.signal).toBe(ctrl.signal)
  })

  it("never calls private lifecycle (no initialize/reconnect)", async () => {
    const init = mock(() => Promise.resolve())
    const reconnect = mock(() => Promise.resolve())
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory),
    })
    const reader = h.privateReader as unknown as Record<string, unknown>
    reader.initialize = init
    reader.reconnect = reconnect
    await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
    expect(init).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it("private found no SDK/parity for refreshSessionDetails", async () => {
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory, { title: "priv" }),
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["contextSessionID"] as unknown) = "ses_abc"
    ;(anyP["trackedSessionIds"] as unknown) = new Set(["ses_abc"])
    ;(anyP["revisions"] as unknown) = new Map()
    ;(anyP["refreshes"] as unknown) = new Map()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    ;(h.provider as unknown as { refreshSessionDetails: (id: string, dir: string) => void }).refreshSessionDetails("ses_abc", "/tmp/ws")
    await new Promise((r) => setTimeout(r, 80))
    expect(h.sdkGets).toHaveLength(0)
    expect(h.parityGets).toHaveLength(0)
    const updated = posts.find((p) => (p as Record<string, unknown>).type === "sessionUpdated") as Record<string, unknown>
    expect((updated?.session as Record<string, unknown>)?.title).toBe("priv")
  })

  it("doLoadMessages strict with private not_found aborts", async () => {
    const h = makeHarness({
      privateGet: async () => ({ v: "1.0", status: "not_found" }),
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map()
    // need client for messages page but we will not reach it
    let threw = false
    try {
      await (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_missing", { mode: "focus" }, true)
    } catch (e) {
      threw = true
      expect((e as Error).name).toMatch(/NotFound/)
    }
    expect(threw).toBeTrue()
    expect(h.sdkGets).toHaveLength(0)
  })

  it("handleSyncSession private found no SDK, messages remain SDK", async () => {
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory),
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    await (h.provider as unknown as { handleSyncSession: (id: string) => Promise<void> }).handleSyncSession("ses_child")
    expect(h.privateGets).toHaveLength(1)
    expect(h.sdkGets).toHaveLength(0) // metadata no SDK
    // messages still SDK via retry - not counted in sdkGets (which counts session.get only) but ensure no throw
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
  })

  it("exportTranscript injected detail feeds header, writes markdown, cancel and failure preserved", async () => {
    const vscode = await import("vscode")
    const win = vscode.window as unknown as Record<string, unknown>
    const space = vscode.workspace as unknown as { fs: Record<string, unknown> }
    const origDialog = win["showSaveDialog"]
    const origWrite = space.fs["writeFile"]
    const writes: Array<{ uri: unknown; bytes: Uint8Array }> = []
    try {
      const detail = {
        id: "ses_abc",
        title: "exported title",
        parentID: null,
        directory: "/tmp/ws",
        projectID: "proj_test",
        createdAt: 1000,
        updatedAt: 2000,
      } as unknown as import("./kilo-provider/session-detail").SessionDetail
      const items = [
        {
          info: { id: "msg_1", sessionID: "ses_abc", role: "user", time: { created: 1000 } },
          parts: [{ type: "text", text: "hello world", synthetic: false }],
        },
      ]
      const seen: unknown[] = []
      const client = {
        session: {
          get: async (p: unknown) => {
            seen.push(p)
            return { data: makeSdkSession("ses_abc", "/tmp/ws"), error: undefined, response: { status: 200, headers: { get: () => null } } }
          },
          messages: async () => ({ data: items, error: undefined, response: { status: 200, headers: { get: () => null } } }),
        },
      } as unknown as import("@kilocode/sdk/v2/client").KiloClient
      const exp = await import("./kilo-provider/export-transcript")
      // Success: injected detail feeds header, SDK get never called, markdown written.
      win["showSaveDialog"] = async () => ({ fsPath: "/tmp/out.md" })
      space.fs["writeFile"] = async (uri: unknown, bytes: Uint8Array) => {
        writes.push({ uri, bytes })
      }
      const got: Array<{ id: string; dir: string }> = []
      const ok = await exp.exportTranscript(
        client,
        {
          sessionID: "ses_abc",
          dir: "/tmp/ws",
          getSessionDetail: async (id, dir) => {
            got.push({ id, dir })
            return detail
          },
        },
        null,
      )
      expect(ok).toBeTrue()
      expect(got).toHaveLength(1)
      expect(got[0]).toEqual({ id: "ses_abc", dir: "/tmp/ws" })
      expect(seen).toHaveLength(0)
      expect(writes).toHaveLength(1)
      const text = Buffer.from(writes[0]!.bytes).toString("utf8")
      expect(text).toContain("# exported title")
      expect(text).toContain("ses_abc")
      expect(text).toContain("hello world")
      // Cancel: returns false without write.
      writes.length = 0
      win["showSaveDialog"] = async () => undefined
      const cancelled = await exp.exportTranscript(client, { sessionID: "ses_abc", dir: "/tmp/ws", getSessionDetail: async () => detail }, null)
      expect(cancelled).toBeFalse()
      expect(writes).toHaveLength(0)
      // Detail domain failure preserves thrown behavior, no dialog and no write.
      let dialogs = 0
      win["showSaveDialog"] = async () => {
        dialogs += 1
        return { fsPath: "/tmp/out.md" }
      }
      const { SessionNotFoundError } = await import("./kilo-provider/session-detail")
      let threw = false
      try {
        await exp.exportTranscript(client, { sessionID: "ses_missing", dir: "/tmp/ws", getSessionDetail: async () => { throw new SessionNotFoundError() } }, null)
      } catch (e) {
        threw = true
        expect((e as Error).name).toBe("SessionNotFoundError")
      }
      expect(threw).toBeTrue()
      expect(dialogs).toBe(0)
      expect(writes).toHaveLength(0)
      // SDK fallback path (no injected getter) still maps via static import.
      writes.length = 0
      win["showSaveDialog"] = async () => ({ fsPath: "/tmp/out.md" })
      const sdkOk = await exp.exportTranscript(client, { sessionID: "ses_abc", dir: "/tmp/ws" }, null)
      expect(sdkOk).toBeTrue()
      expect(seen).toHaveLength(1)
      expect(writes).toHaveLength(1)
      expect(Buffer.from(writes[0]!.bytes).toString("utf8")).toContain("# hello")
    } finally {
      win["showSaveDialog"] = origDialog
      space.fs["writeFile"] = origWrite
    }
  })

  it("summary diff status number/boolean malformed -> exactly one SDK fallback", async () => {
    for (const bad of [1, true]) {
      const warns: unknown[][] = []
      const orig = console.warn
      console.warn = (...a: unknown[]) => warns.push(a)
      try {
        const h = makeHarness({
          privateGet: async (input) => ({
            v: "1.0" as const,
            status: "found" as const,
            session: {
              ...(makePrivateFound(input.sessionId, input.directory).session as unknown as Record<string, unknown>),
              summary: { additions: 1, deletions: 2, files: 1, diffs: [{ file: "a.ts", additions: 1, deletions: 0, status: bad }] },
            },
          }),
        })
        const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<Record<string, unknown> | undefined> }).getSessionInfo("ses_abc")
        expect(out?.id).toBe("ses_abc")
        expect(h.privateGets).toHaveLength(1)
        expect(h.sdkGets).toHaveLength(1)
        expect(warns.some((w) => String(w[0]).includes("[Kilo Detail]"))).toBeTrue()
      } finally {
        console.warn = orig
      }
    }
  })

  it("summary diff valid statuses/absent -> private found no SDK", async () => {
    for (const diffs of [
      [{ file: "a.ts", additions: 1, deletions: 0, status: "added" }],
      [{ file: "b.ts", additions: 0, deletions: 1, status: "deleted" }],
      [{ file: "c.ts", additions: 1, deletions: 1, status: "modified" }],
      [{ file: "d.ts", additions: 2, deletions: 0 }],
    ]) {
      const h = makeHarness({
        privateGet: async (input) => ({
          v: "1.0" as const,
          status: "found" as const,
          session: {
            ...(makePrivateFound(input.sessionId, input.directory).session as unknown as Record<string, unknown>),
            summary: { additions: 1, deletions: 1, files: 1, diffs },
          },
        }),
      })
      const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<Record<string, unknown> | undefined> }).getSessionInfo("ses_abc")
      expect(out?.id).toBe("ses_abc")
      expect(h.privateGets).toHaveLength(1)
      expect(h.sdkGets).toHaveLength(0)
      expect(h.parityGets).toHaveLength(0)
    }
  })

  it("thrown host-closed generic error -> exactly one SDK with parity, no lifecycle", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const h = makeHarness({ privateGet: async () => { throw new Error("host closed") } })
      const reader = h.privateReader as unknown as Record<string, unknown>
      const init = mock(() => Promise.resolve())
      reader["initialize"] = init
      const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<Record<string, unknown> | undefined> }).getSessionInfo("ses_abc")
      expect(out?.id).toBe("ses_abc")
      expect(h.privateGets).toHaveLength(1)
      expect(h.sdkGets).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 60))
      expect(h.parityGets.length).toBeGreaterThanOrEqual(1)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Detail]"))).toBeTrue()
      expect(init).not.toHaveBeenCalled()
    } finally {
      console.warn = orig
    }
  })

  it("scope_mismatch/not_found terminal -> no SDK and no parity", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({ privateGet: async () => ({ v: "1.0", status }) })
      const out = await (h.provider as unknown as { getSessionInfo: (id: string) => Promise<unknown> }).getSessionInfo("ses_abc")
      expect(out).toBeUndefined()
      expect(h.privateGets).toHaveLength(1)
      expect(h.sdkGets).toHaveLength(0)
      expect(h.parityGets).toHaveLength(0)
    }
  })

  it("strict replace production path forwards AbortSignal to SDK fallback", async () => {
    const seen: Array<{ signal?: AbortSignal }> = []
    const h = makeHarness({
      privateGet: async () => { throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError }) },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const sdk = h.client as unknown as { session: Record<string, unknown> }
    const base = sdk.session["get"] as (p: unknown, o: unknown) => Promise<unknown>
    void base
    sdk.session["get"] = async (p: unknown, o: unknown) => {
      h.sdkGets.push(p)
      seen.push(o as { signal?: AbortSignal })
      return { data: makeSdkSession("ses_abc", "/tmp/ws"), error: undefined, response: { status: 200, headers: { get: () => null } } }
    }
    const ok = await (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_abc", { mode: "replace" }, true)
    expect(ok).toBeTrue()
    expect(h.sdkGets).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.signal instanceof AbortSignal).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
  })

  it("strict replace aborted during SDK fallback writes no stale session", async () => {
    const h = makeHarness({
      privateGet: async () => { throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError }) },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const sdk = h.client as unknown as { session: Record<string, unknown> }
    sdk.session["get"] = async (p: unknown) => {
      h.sdkGets.push(p)
      ;(anyP["loadMessagesAbort"] as unknown as AbortController | undefined)?.abort()
      return { data: makeSdkSession("ses_abc", "/tmp/ws"), error: undefined, response: { status: 200, headers: { get: () => null } } }
    }
    const ok = await (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_abc", { mode: "replace" }, true)
    expect(ok).toBeFalse()
    expect(h.sdkGets).toHaveLength(1)
    expect(anyP["currentSession"]).toBeNull()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeFalse()
  })

  it("handleSyncSession private found -> no SDK get, messages once, both events, dedupe retry", async () => {
    const h = makeHarness({
      privateGet: async (input) => makePrivateFound(input.sessionId, input.directory),
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const sdk = h.client as unknown as { session: { messages: (p: unknown) => Promise<unknown> } }
    const calls: unknown[] = []
    const origMessages = sdk.session.messages
    sdk.session.messages = async (p: unknown) => {
      calls.push(p)
      return origMessages(p)
    }
    await (h.provider as unknown as { handleSyncSession: (id: string) => Promise<void> }).handleSyncSession("ses_child")
    expect(h.privateGets).toHaveLength(1)
    expect(h.sdkGets).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded" && (p as Record<string, unknown>).sessionID === "ses_child")).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has("ses_child")).toBeTrue()
    // Dedupe: second sync without failure does not refetch.
    await (h.provider as unknown as { handleSyncSession: (id: string) => Promise<void> }).handleSyncSession("ses_child")
    expect(calls).toHaveLength(1)
    expect(h.privateGets).toHaveLength(1)
  })

  it("handleSyncSession metadata failure clears dedupe so retry can succeed", async () => {
    let fail = true
    const h = makeHarness({
      privateGet: async (input) => {
        if (fail) throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
        return makePrivateFound(input.sessionId, input.directory)
      },
      sdkGet: async () => { throw new Error("metadata missing") },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    await (h.provider as unknown as { handleSyncSession: (id: string) => Promise<void> }).handleSyncSession("ses_retry")
    expect((anyP["syncedChildSessions"] as Set<string>).has("ses_retry")).toBeFalse()
    expect(posts).toHaveLength(0)
    fail = false
    await (h.provider as unknown as { handleSyncSession: (id: string) => Promise<void> }).handleSyncSession("ses_retry")
    expect((anyP["syncedChildSessions"] as Set<string>).has("ses_retry")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
  })
})

describe("KiloProvider detail generation invalidation", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const tick = () => new Promise((r) => setTimeout(r, 10))

  it("strict replace awaiting detail then clearSession writes nothing", async () => {
    const gate = deferred<unknown>()
    const h = makeHarness({
      privateGet: async () => gate.promise,
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const load = (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_abc", { mode: "replace" }, true)
    await tick()
    ;(h.provider as unknown as { clearSessionState: () => void }).clearSessionState()
    gate.resolve(makePrivateFound("ses_abc", "/tmp/ws"))
    const ok = await load
    expect(ok).toBeFalse()
    expect(anyP["currentSession"]).toBeNull()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeFalse()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeFalse()
  })

  it("strict replace A then replace B: A cannot overwrite B", async () => {
    const gate = deferred<unknown>()
    const h = makeHarness({
      privateGet: async (input: { directory: string; sessionId: string }) => {
        if (input.sessionId === "ses_aaa111") return gate.promise
        return makePrivateFound(input.sessionId, input.directory)
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const api = h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }
    const loadA = api.doLoadMessages("ses_aaa111", { mode: "replace" }, true)
    await tick()
    const okB = await api.doLoadMessages("ses_bbb222", { mode: "replace" }, true)
    expect(okB).toBeTrue()
    gate.resolve(makePrivateFound("ses_aaa111", "/tmp/ws"))
    const okA = await loadA
    expect(okA).toBeFalse()
    expect((anyP["currentSession"] as { id: string }).id).toBe("ses_bbb222")
    const updated = posts.filter((p) => (p as Record<string, unknown>).type === "sessionUpdated")
    expect(updated.length).toBeGreaterThan(0)
    for (const u of updated) {
      expect(((u as Record<string, unknown>).session as Record<string, unknown>).id).toBe("ses_bbb222")
    }
    const loaded = posts.filter((p) => (p as Record<string, unknown>).type === "messagesLoaded")
    expect(loaded.length).toBeGreaterThan(0)
    for (const l of loaded) {
      expect((l as Record<string, unknown>).sessionID).toBe("ses_bbb222")
    }
  })

  it("focus A then clear writes nothing", async () => {
    const gate = deferred<unknown>()
    const h = makeHarness({
      privateGet: async () => gate.promise,
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const load = (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_focus1", { mode: "focus" }, true)
    await tick()
    ;(h.provider as unknown as { clearSessionState: () => void }).clearSessionState()
    gate.resolve(makePrivateFound("ses_focus1", "/tmp/ws"))
    const ok = await load
    expect(ok).toBeFalse()
    expect(anyP["currentSession"]).toBeNull()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeFalse()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeFalse()
  })

  it("same-session strict replace still completes", async () => {
    const h = makeHarness({
      privateGet: async (input: { directory: string; sessionId: string }) => makePrivateFound(input.sessionId, input.directory),
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const ok = await (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_abc", { mode: "replace" }, true)
    expect(ok).toBeTrue()
    expect((anyP["currentSession"] as { id: string }).id).toBe("ses_abc")
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
  })

  it("SDK fallback abort-throw maps stale load to false without writes", async () => {
    const h = makeHarness({
      privateGet: async () => { throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError }) },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const sdk = h.client as unknown as { session: Record<string, unknown> }
    sdk.session["get"] = async (p: unknown) => {
      h.sdkGets.push(p)
      ;(anyP["loadMessagesAbort"] as unknown as AbortController | undefined)?.abort()
      throw Object.assign(new Error("aborted"), { name: "AbortError" })
    }
    const ok = await (h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }).doLoadMessages("ses_abc", { mode: "replace" }, true)
    expect(ok).toBeFalse()
    expect(anyP["currentSession"]).toBeNull()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeFalse()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeFalse()
  })

  it("SDK-error parity path preserves original error with bounded diagnostics only", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const secret = "sdk-boom-secret-marker"
      const sdkErr = new Error(`${secret} at /tmp/ws for ses_abc`)
      const h = makeHarness({
        privateGet: async () => { throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError }) },
        sdkGet: async () => { throw sdkErr },
      })
      let threw: unknown = null
      try {
        await (h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp/ws")
      } catch (e) {
        threw = e
      }
      expect(threw).toBe(sdkErr)
      await new Promise((r) => setTimeout(r, 60))
      for (const w of warns) {
        expect(String(w.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))).not.toContain(secret)
      }
    } finally {
      console.warn = orig
    }
  })
})
