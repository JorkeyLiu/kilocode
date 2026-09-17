import { describe, expect, test } from "bun:test"
import {
  fetchFixtureSessionListPrivateFirst,
  fetchFixtureSessionMessagesPrivateFirst,
} from "./fixture-session-privatefirst"

const DIR = "/tmp"
const SID = "ses_fixture00000000000001"
const OTHER = "ses_fixture00000000000002"

function entry(id: string, updated = 2) {
  return {
    id,
    title: `t-${id.slice(-4)}`,
    parentID: null,
    directory: DIR,
    projectID: "prj_1",
    createdAt: 1,
    updatedAt: updated,
  }
}

function listOk(entries: unknown[]) {
  return { v: "1.0", entries }
}

function detail(id: string, updated = 2) {
  return {
    v: "1.0",
    status: "found",
    session: {
      id,
      title: `t-${id.slice(-4)}`,
      parentID: null,
      directory: DIR,
      projectID: "prj_1",
      createdAt: 1,
      updatedAt: updated,
      agent: `agent-${id.slice(-4)}`,
      model: { providerID: "p", id: "m", variant: "v" },
      summary: { additions: 1, deletions: 2, files: 1, diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "modified" }] },
      revert: { messageID: "msg_0000000000000001", partID: "prt_0000000000000001", snapshot: "s", diff: "d" },
    },
  }
}

function msg(id: string, time: number, sid = SID) {
  return {
    info: {
      id,
      sessionID: sid,
      role: "user",
      time: { created: time },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: `prt_${id}`, sessionID: sid, messageID: id, type: "text", text: "hello" }],
  }
}

function reader(over: Record<string, unknown> = {}) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => listOk([entry(SID)]),
    get: async (input: { sessionId: string }) => detail(input.sessionId),
    messages: async () => ({ v: "1.0", status: "found", messages: [msg("msg_1", 100)] }),
    ...over,
  } as never
}

describe("fixture session list/messages private-first", () => {
  test("list private hydration success is authoritative with zero SDK and full truth", async () => {
    let calls = 0
    let gets = 0
    const client = {
      session: {
        list: async () => {
          calls += 1
          return { data: [] }
        },
      },
    }
    const r = reader({
      get: async (input: { sessionId: string }) => {
        gets += 1
        return detail(input.sessionId)
      },
    })
    const out = await fetchFixtureSessionListPrivateFirst({ reader: r, client, directory: DIR })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("private")
    expect(out.sessions.map((s) => (s as { id: string }).id)).toEqual([SID])
    const row = out.sessions[0] as unknown as Record<string, unknown>
    expect(row.agent).toBe(`agent-${SID.slice(-4)}`)
    expect(row.model).toEqual({ providerID: "p", id: "m", variant: "v" })
    expect(row.revert).toEqual({ messageID: "msg_0000000000000001", partID: "prt_0000000000000001", snapshot: "s", diff: "d" })
    expect(row.summary).toEqual({
      additions: 1,
      deletions: 2,
      files: 1,
      diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "modified" }],
    })
    expect((row.time as { created: number; updated: number }).created).toBe(1)
    expect(calls).toBe(0)
    expect(gets).toBe(1)
  })

  test("list hydration preserves list order", async () => {
    const seen: string[] = []
    const r = reader({
      list: async () => listOk([entry(SID), entry(OTHER, 3)]),
      get: async (input: { sessionId: string }) => {
        seen.push(input.sessionId)
        return detail(input.sessionId, input.sessionId === OTHER ? 3 : 2)
      },
    })
    const out = await fetchFixtureSessionListPrivateFirst({ reader: r, client: { session: { list: async () => ({ data: [] }) } }, directory: DIR })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.sessions.map((s) => (s as { id: string }).id)).toEqual([SID, OTHER])
    expect(seen).toEqual([SID, OTHER])
  })

  test("list hydration race fails over to exactly one SDK list with no partial mix", async () => {
    let calls = 0
    let gets = 0
    let sdkData: unknown[] = []
    const client = {
      session: {
        list: async () => {
          calls += 1
          return { data: sdkData }
        },
      },
    }
    sdkData = [{ id: "ses_sdk00000000000001", title: "sdk", parentID: null, directory: DIR, projectID: "prj_1", time: { created: 5, updated: 6 } }]
    const r = reader({
      list: async () => listOk([entry(SID), entry(OTHER, 3)]),
      get: async (input: { sessionId: string }) => {
        gets += 1
        if (input.sessionId === OTHER) return { v: "1.0", status: "not_found" }
        return detail(input.sessionId)
      },
    })
    const out = await fetchFixtureSessionListPrivateFirst({ reader: r, client, directory: DIR })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
    expect(gets).toBe(2)
    expect(out.sessions.map((s) => (s as { id: string }).id)).toEqual(["ses_sdk00000000000001"])
  })

  test("list hydration transport failure fails over to exactly one SDK list", async () => {
    let calls = 0
    let gets = 0
    const client = {
      session: {
        list: async () => {
          calls += 1
          return { data: [{ id: SID }] }
        },
      },
    }
    const out = await fetchFixtureSessionListPrivateFirst({
      reader: reader({
        get: async () => {
          gets += 1
          throw new Error("transport closed")
        },
      }),
      client,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
    expect(gets).toBe(1)
  })

  test("list hydration malformed model fails over to exactly one SDK list", async () => {
    let calls = 0
    const client = {
      session: {
        list: async () => {
          calls += 1
          return { data: [{ id: SID }] }
        },
      },
    }
    const out = await fetchFixtureSessionListPrivateFirst({
      reader: reader({
        get: async (input: { sessionId: string }) => ({
          v: "1.0",
          status: "found",
          session: {
            id: input.sessionId,
            title: "t",
            parentID: null,
            directory: DIR,
            projectID: "prj_1",
            createdAt: 1,
            updatedAt: 2,
            model: { providerID: "", id: "" },
          },
        }),
      }),
      client,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
  })

  test("list gate-off takes exactly one same-directory SDK read", async () => {
    let calls = 0
    const seen: unknown[] = []
    const client = {
      session: {
        list: async (p: { directory: string }) => {
          calls += 1
          seen.push(p)
          return { data: [{ id: SID }] }
        },
      },
    }
    const out = await fetchFixtureSessionListPrivateFirst({
      reader: reader({ isEnabled: () => false }),
      client,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
    expect(seen).toEqual([{ directory: DIR }])
  })

  test("list private invalid takes exactly one SDK fallback", async () => {
    let calls = 0
    const client = {
      session: {
        list: async () => {
          calls += 1
          return { data: [{ id: SID }] }
        },
      },
    }
    const out = await fetchFixtureSessionListPrivateFirst({
      reader: reader({ list: async () => ({ v: "bad", entries: [] }) }),
      client,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
  })

  test("list SDK failure closes unavailable with exactly one read", async () => {
    let calls = 0
    const client = {
      session: {
        list: async () => {
          calls += 1
          throw new Error("down")
        },
      },
    }
    const out = await fetchFixtureSessionListPrivateFirst({
      reader: reader({ isStarted: () => false }),
      client,
      directory: DIR,
    })
    expect(out.kind).toBe("unavailable")
    expect(calls).toBe(1)
  })

  test("messages private found is authoritative with zero SDK", async () => {
    let calls = 0
    const client = {
      session: {
        messages: async () => {
          calls += 1
          return { data: [] }
        },
      },
    }
    const out = await fetchFixtureSessionMessagesPrivateFirst({
      reader: reader(),
      client,
      directory: DIR,
      sessionId: SID,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("private")
    expect(out.items.map((m) => (m.info as { id: string }).id)).toEqual(["msg_1"])
    expect(calls).toBe(0)
  })

  test("messages terminal closes with zero SDK", async () => {
    let calls = 0
    const client = {
      session: {
        messages: async () => {
          calls += 1
          return { data: [msg("msg_9", 900)] }
        },
      },
    }
    const out = await fetchFixtureSessionMessagesPrivateFirst({
      reader: reader({ messages: async () => ({ v: "1.0", status: "not_found" }) }),
      client,
      directory: DIR,
      sessionId: SID,
    })
    expect(out.kind).toBe("terminal")
    expect(calls).toBe(0)
  })

  test("messages fallback takes exactly one same-session SDK read", async () => {
    let calls = 0
    const seen: unknown[] = []
    const client = {
      session: {
        messages: async (p: { sessionID: string; directory: string }) => {
          calls += 1
          seen.push(p)
          return { data: [msg("msg_2", 200)] }
        },
      },
    }
    const out = await fetchFixtureSessionMessagesPrivateFirst({
      reader: reader({ isEnabled: () => false }),
      client,
      directory: DIR,
      sessionId: SID,
    })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.via).toBe("sdk")
    expect(calls).toBe(1)
    expect(seen).toEqual([{ sessionID: SID, directory: DIR }])
  })

  test("messages SDK failure closes unavailable with exactly one read", async () => {
    let calls = 0
    const client = {
      session: {
        messages: async () => {
          calls += 1
          throw new Error("down")
        },
      },
    }
    const out = await fetchFixtureSessionMessagesPrivateFirst({
      reader: reader({
        messages: async () => {
          throw new Error("transport closed")
        },
      }),
      client,
      directory: DIR,
      sessionId: SID,
    })
    expect(out.kind).toBe("unavailable")
    expect(calls).toBe(1)
  })
})

describe("fixture backendSnapshot list/messages private-first", () => {
  async function snapshotWith(opts: {
    listImpl: () => Promise<unknown>
    getImpl?: (sid: string) => Promise<unknown>
    msgImpl: (sid: string) => Promise<unknown>
    sdkList: () => Promise<unknown>
    sdkMsg: (sid: string) => Promise<unknown>
  }) {
    const { AgentManagerProvider } = await import("../agent-manager/AgentManagerProvider")
    let sdkListCalls = 0
    let sdkMsgCalls = 0
    const seenMsg: string[] = []
    const fakeClient = {
      session: {
        list: async () => {
          sdkListCalls += 1
          return opts.sdkList()
        },
        status: async () => ({ data: {} }),
        messages: async (p: { sessionID: string }) => {
          sdkMsgCalls += 1
          seenMsg.push(p.sessionID)
          return opts.sdkMsg(p.sessionID)
        },
        children: async () => ({ data: [] }),
      },
      app: { agents: async () => ({ data: [] }) },
      provider: { catalog: async () => ({ data: { connected: [] } }) },
      mcp: { status: async () => ({ data: {} }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    }
    const fakeReader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: opts.listImpl,
      get: (input: { sessionId: string }) => (opts.getImpl ? opts.getImpl(input.sessionId) : detail(input.sessionId)),
      messages: (input: { sessionId: string }) => opts.msgImpl(input.sessionId),
    }
    const provider = Object.create(AgentManagerProvider.prototype) as {
      backendSnapshotForFixture(): Promise<{
        sessions: Array<{ id: string; agent: string | null; model: unknown; revert?: unknown; summary?: unknown }>
        messages: Record<string, Array<{ id: string }>>
        messagesReadable?: Record<string, boolean>
      }>
    } & Record<string, unknown>
    provider.host = { workspacePath: () => DIR }
    provider.connectionService = { getClientAsync: async () => fakeClient }
    provider.outputChannel = { appendLine: () => {} }
    provider.coordinator = { observationReader: () => fakeReader }
    const snap = await provider.backendSnapshotForFixture()
    return { snap, sdkListCalls, sdkMsgCalls, seenMsg }
  }

  test("private list+detail+messages authoritative with zero SDK and same projection", async () => {
    const r = await snapshotWith({
      listImpl: async () => listOk([entry(SID), entry(OTHER, 3)]),
      getImpl: async (sid) => detail(sid, sid === OTHER ? 3 : 2),
      msgImpl: async (sid) => ({ v: "1.0", status: "found", messages: [msg("msg_1", 100, sid)] }),
      sdkList: async () => {
        throw new Error("must not read")
      },
      sdkMsg: async () => {
        throw new Error("must not read")
      },
    })
    expect(r.snap.sessions.map((s) => s.id).sort()).toEqual([OTHER, SID].sort())
    expect(Object.keys(r.snap.messages).sort()).toEqual([OTHER, SID].sort())
    expect(r.snap.messages[SID]?.map((m) => m.id)).toEqual(["msg_1"])
    expect(r.snap.messagesReadable).toBeUndefined()
    expect(r.sdkListCalls).toBe(0)
    expect(r.sdkMsgCalls).toBe(0)
  })

  test("private authoritative snapshot preserves non-null agent/model and revert/summary", async () => {
    const r = await snapshotWith({
      listImpl: async () => listOk([entry(SID)]),
      getImpl: async (sid) => detail(sid),
      msgImpl: async (sid) => ({ v: "1.0", status: "found", messages: [msg("msg_1", 100, sid)] }),
      sdkList: async () => {
        throw new Error("must not read")
      },
      sdkMsg: async () => {
        throw new Error("must not read")
      },
    })
    const row = r.snap.sessions.find((s) => s.id === SID)
    expect(row).toBeDefined()
    expect(row!.agent).toBe(`agent-${SID.slice(-4)}`)
    expect(row!.model).toEqual({ providerID: "p", modelID: "m", variant: "v" })
    expect(row!.revert).toEqual({ messageID: "msg_0000000000000001", partID: "prt_0000000000000001", snapshot: "s", diff: "d" })
    expect(row!.summary).toEqual({
      additions: 1,
      deletions: 2,
      files: 1,
      diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "modified" }],
    })
    expect(r.sdkListCalls).toBe(0)
  })

  test("hydration race fails whole list over to exactly one SDK list", async () => {
    const r = await snapshotWith({
      listImpl: async () => listOk([entry(SID), entry(OTHER, 3)]),
      getImpl: async (sid) => {
        if (sid === OTHER) return { v: "1.0", status: "scope_mismatch" }
        return detail(sid)
      },
      msgImpl: async (sid) => ({ v: "1.0", status: "found", messages: [msg("msg_1", 100, sid)] }),
      sdkList: async () => ({
        data: [{ id: "ses_sdk00000000000001", title: "sdk", parentID: null, directory: DIR, projectID: "prj_1", time: { created: 5, updated: 6 } }],
      }),
      sdkMsg: async () => ({ data: [] }),
    })
    expect(r.snap.sessions.map((s) => s.id)).toEqual(["ses_sdk00000000000001"])
    expect(r.sdkListCalls).toBe(1)
  })

  test("messages terminal fails soft to empty unreadable with zero SDK", async () => {
    const r = await snapshotWith({
      listImpl: async () => listOk([entry(SID)]),
      msgImpl: async () => ({ v: "1.0", status: "scope_mismatch" }),
      sdkList: async () => ({ data: [] }),
      sdkMsg: async () => {
        throw new Error("must not read")
      },
    })
    expect(r.snap.messages[SID]).toEqual([])
    expect(r.snap.messagesReadable).toEqual({ [SID]: false })
    expect(r.sdkMsgCalls).toBe(0)
  })

  test("fallback-eligible list+messages take exactly one SDK read each", async () => {
    const r = await snapshotWith({
      listImpl: async () => {
        throw new Error("transport closed")
      },
      msgImpl: async () => {
        throw new Error("transport closed")
      },
      sdkList: async () => ({
        data: [{ id: SID, title: "t", agent: null, model: null, parentID: null, time: { created: 1, updated: 2 } }],
      }),
      sdkMsg: async () => ({ data: [] }),
    })
    expect(r.snap.sessions.map((s) => s.id)).toEqual([SID])
    expect(r.snap.messages[SID]).toEqual([])
    expect(r.snap.messagesReadable).toBeUndefined()
    expect(r.sdkListCalls).toBe(1)
    expect(r.sdkMsgCalls).toBe(1)
    expect(r.seenMsg).toEqual([SID])
  })
})
