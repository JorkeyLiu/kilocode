import { describe, expect, test } from "bun:test"
import * as vscode from "vscode"
import { KiloConnectionService } from "./connection-service"

function state(value: boolean) {
  return {
    get: <T>() => value as T,
    update: async () => undefined,
  }
}

describe("KiloConnectionService sandbox preference", () => {
  test("uses workspace state instead of extension-global state", () => {
    const service = new KiloConnectionService({
      workspaceState: state(false),
      globalState: state(true),
    } as any)

    expect(service.sandboxPreference.resolve(true)).toBe(false)
  })
})

describe("KiloConnectionService clients", () => {
  test("returns a connected client without a workspace folder", async () => {
    const service = new KiloConnectionService({} as any)
    const client = {}
    const workspace = vscode.workspace as { workspaceFolders?: readonly vscode.WorkspaceFolder[] }
    const folders = workspace.workspaceFolders

    ;(service as any).client = client
    ;(service as any).state = "connected"
    workspace.workspaceFolders = undefined

    try {
      expect(await service.getClientAsync()).toBe(client)
    } finally {
      workspace.workspaceFolders = folders
    }
  })
})

describe("KiloConnectionService config revision coordinator (LOCK-005)", () => {
  test("advance notifies subscribers and increments the current revision", () => {
    const service = new KiloConnectionService({} as any)
    let calls = 0
    const unsub = service.onConfigRevision(() => {
      calls += 1
    })

    expect(service.getConfigRevision()).toBe(0)
    service.advanceConfigRevision()
    service.advanceConfigRevision()

    expect(service.getConfigRevision()).toBe(2)
    expect(calls).toBe(2)
    unsub()

    service.advanceConfigRevision()
    expect(calls).toBe(2)
  })

  test("unsubscribe removes the listener", () => {
    const service = new KiloConnectionService({} as any)
    let calls = 0
    const unsub = service.onConfigRevision(() => {
      calls += 1
    })
    unsub()
    service.advanceConfigRevision()
    expect(calls).toBe(0)
  })

  test("a throwing listener does not break advance for other subscribers", () => {
    const service = new KiloConnectionService({} as any)
    let calls = 0
    const origError = console.error
    console.error = () => {}
    try {
      service.onConfigRevision(() => {
        throw new Error("boom")
      })
      service.onConfigRevision(() => {
        calls += 1
      })
      service.advanceConfigRevision()
    } finally {
      console.error = origError
    }
    expect(service.getConfigRevision()).toBe(1)
    expect(calls).toBe(1)
  })

  test("dispose clears revision listeners", async () => {
    const service = new KiloConnectionService({} as any)
    let calls = 0
    service.onConfigRevision(() => {
      calls += 1
    })
    await service.dispose()
    service.advanceConfigRevision()
    expect(calls).toBe(0)
  })
})

describe("KiloConnectionService SSE dispatch config revision ownership (LOCK-001/004/005)", () => {
  function configUpdated() {
    return { id: crypto.randomUUID(), type: "global.config.updated" as const, properties: {} }
  }

  test("a single transaction's per-scope echo burst coalesces into exactly one revision advance", () => {
    const service = new KiloConnectionService({} as any)
    const revisions: number[] = []
    service.onConfigRevision(() => revisions.push(service.getConfigRevision()))

    // One logical transaction: the backend emits one global.config.updated per
    // changed scope (project + global), both tagged with the same transaction id.
    const tx = crypto.randomUUID()
    service.handleSseEvent(configUpdated(), "/repo", tx)
    service.handleSseEvent(configUpdated(), "global", tx)

    expect(service.getConfigRevision()).toBe(1)
    expect(revisions).toEqual([1])
  })

  test("a single-scope transaction advances exactly once", () => {
    const service = new KiloConnectionService({} as any)
    const tx = crypto.randomUUID()
    service.handleSseEvent(configUpdated(), "global", tx)
    expect(service.getConfigRevision()).toBe(1)
    service.handleSseEvent(configUpdated(), "global", tx)
    expect(service.getConfigRevision()).toBe(1)
  })

  test("same tagged events delivered in separate tasks advance exactly once (LOCK-004)", async () => {
    const service = new KiloConnectionService({} as any)
    const revisions: number[] = []
    service.onConfigRevision(() => revisions.push(service.getConfigRevision()))

    // The backend transaction's scope echoes can straddle an SSE delivery
    // turn; the transaction-id keyed dedupe must still yield ONE advance.
    const tx = crypto.randomUUID()
    service.handleSseEvent(configUpdated(), "/repo", tx)
    await Promise.resolve()
    service.handleSseEvent(configUpdated(), "global", tx)
    await Promise.resolve()

    expect(service.getConfigRevision()).toBe(1)
    expect(revisions).toEqual([1])
  })

  test("separate untagged events in the same task advance separately (LOCK-004)", () => {
    const service = new KiloConnectionService({} as any)
    const revisions: number[] = []
    service.onConfigRevision(() => revisions.push(service.getConfigRevision()))

    // Untagged events each represent an independent external edit — the old
    // microtask fallback must never merge them into one revision.
    service.handleSseEvent(configUpdated(), "global")
    service.handleSseEvent(configUpdated(), "/repo")

    expect(service.getConfigRevision()).toBe(2)
    expect(revisions).toEqual([1, 2])
  })

  test("separate external edits in separate tasks each advance once and are never dropped", () => {
    const service = new KiloConnectionService({} as any)
    const revisions: number[] = []
    service.onConfigRevision(() => revisions.push(service.getConfigRevision()))

    // Foreign untagged edit → its own revision.
    service.handleSseEvent(configUpdated(), "global")
    expect(revisions).toEqual([1])

    // A later unrelated untagged edit arrives in its own task → its own revision.
    service.handleSseEvent(configUpdated(), "global")
    expect(revisions).toEqual([1, 2])
  })

  test("tagged transaction echoes never absorb a later untagged external edit", () => {
    const service = new KiloConnectionService({} as any)
    const tx = crypto.randomUUID()
    service.handleSseEvent(configUpdated(), "global", tx)
    service.handleSseEvent(configUpdated(), "/repo", tx)
    expect(service.getConfigRevision()).toBe(1)
    // A distinct untagged external edit is independent of the tagged burst.
    service.handleSseEvent(configUpdated(), "global")
    expect(service.getConfigRevision()).toBe(2)
  })

  test("dispatch broadcasts every event to subscribers with its transaction id", () => {
    const service = new KiloConnectionService({} as any)
    const seen: Array<{ type: string; directory?: string; transaction?: string }> = []
    const unsub = service.onEvent((event, directory, transaction) => {
      seen.push({ type: event.type, directory, transaction })
    })

    const tx = crypto.randomUUID()
    service.handleSseEvent(configUpdated(), "global", tx)
    service.handleSseEvent(configUpdated(), "/repo")

    expect(seen.map((s) => s.type)).toEqual(["global.config.updated", "global.config.updated"])
    expect(seen.map((s) => s.directory)).toEqual(["global", "/repo"])
    expect(seen[0].transaction).toBe(tx)
    expect(seen[1].transaction).toBeUndefined()
    unsub()
  })

  test("queueReconcile is not part of the connection service — non-config events never advance", () => {
    const service = new KiloConnectionService({} as any)
    service.handleSseEvent({ id: crypto.randomUUID(), type: "server.heartbeat", properties: {} }, "global")
    service.handleSseEvent({ id: crypto.randomUUID(), type: "session.status", properties: {} }, "/repo")
    expect(service.getConfigRevision()).toBe(0)
  })

  test("onEventFiltered forwards the transaction id exactly and drops non-matching events (LOCK-004)", () => {
    const service = new KiloConnectionService({} as any)
    const seen: Array<{ type: string; directory?: string; transaction?: string }> = []
    const tx = crypto.randomUUID()
    // Filter accepts only events for the project directory; the listener must
    // observe the same (event, directory, transaction) envelope a plain
    // onEvent subscriber receives — including the tagged transaction id.
    const unsub = service.onEventFiltered(
      (event, directory) => directory === "/repo",
      (event, directory, transaction) => {
        seen.push({ type: event.type, directory, transaction })
      },
    )

    service.handleSseEvent(configUpdated(), "/repo", tx)
    service.handleSseEvent(configUpdated(), "global", tx)
    service.handleSseEvent(configUpdated(), "/repo")

    expect(seen.map((s) => s.directory)).toEqual(["/repo", "/repo"])
    expect(seen[0].transaction).toBe(tx)
    expect(seen[1].transaction).toBeUndefined()
    expect(seen.every((s) => s.type === "global.config.updated")).toBe(true)
    unsub()

    service.handleSseEvent(configUpdated(), "/repo", tx)
    expect(seen).toHaveLength(2)
  })
})

describe("KiloConnectionService viewed sessions", () => {
  test("keeps Agent Manager sessions when sidebar visibility changes during a flush", async () => {
    const service = new KiloConnectionService({} as any)
    const calls: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let max = 0

    ;(service as any).client = {
      session: {
        viewed: async (input: { viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }) => {
          calls.push(input)
          active += 1
          max = Math.max(max, active)
          if (calls.length === 1) await gate
          active -= 1
        },
      },
    }

    service.registerVisible("agent-manager", ["am-1"])
    service.registerAttached("agent-manager", ["am-1", "am-2"])
    await Bun.sleep(175)
    expect(calls).toHaveLength(1)
    expect([...calls[0].visible].sort()).toEqual(["am-1"])
    expect([...calls[0].attached].sort()).toEqual(["am-1", "am-2"])

    service.registerVisible("sidebar", ["side-1"])
    await Bun.sleep(175)
    expect(calls).toHaveLength(1)

    release()
    await Bun.sleep(10)
    expect(max).toBe(1)
    expect([...calls[1].visible].sort()).toEqual(["am-1", "side-1"])
    expect([...calls[1].attached].sort()).toEqual(["am-1", "am-2", "side-1"])

    service.registerVisible("sidebar", [])
    await Bun.sleep(175)
    expect([...calls[2].visible].sort()).toEqual(["am-1"])
    expect([...calls[2].attached].sort()).toEqual(["am-1", "am-2"])
    expect(calls[0].viewer.sequence).toBe(1)
    expect(calls[1].viewer.sequence).toBe(2)
    expect(calls[2].viewer.sequence).toBe(3)
    expect(calls[0].viewer.id).toBe(calls[1].viewer.id)
    expect(calls[1].viewer.id).toBe(calls[2].viewer.id)
  })

  test("window focus gates viewer.active but not attachment", async () => {
    const window = vscode.window as unknown as {
      state: { focused: boolean }
      onDidChangeWindowState: (listener: (ws: { focused: boolean }) => void) => { dispose(): void }
    }
    const original = window.onDidChangeWindowState
    let listener: ((ws: { focused: boolean }) => void) | undefined
    window.onDidChangeWindowState = (cb) => {
      listener = cb
      return { dispose: () => {} }
    }

    try {
      const service = new KiloConnectionService({} as any)
      const calls: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
      ;(service as any).client = {
        session: {
          viewed: async (input: (typeof calls)[number]) => {
            calls.push(input)
          },
        },
      }

      service.registerVisible("sidebar", ["ses-1"])
      service.registerAttached("sidebar", ["ses-1", "ses-2"])
      await Bun.sleep(175)
      expect(calls).toHaveLength(1)
      expect(calls[0].viewer.active).toBe(true)

      listener!({ focused: false })
      await Bun.sleep(175)
      expect(calls).toHaveLength(2)
      expect(calls[1].viewer.active).toBe(false)
      expect([...calls[1].visible].sort()).toEqual(["ses-1"])
      expect([...calls[1].attached].sort()).toEqual(["ses-1", "ses-2"])
      expect(calls[1].viewer.sequence).toBeGreaterThan(calls[0].viewer.sequence)
      expect(calls[0].viewer.id).toBe(calls[1].viewer.id)
    } finally {
      window.onDidChangeWindowState = original
    }
  })

  test("emits one viewer UUID with strictly increasing sequence", async () => {
    const service = new KiloConnectionService({} as any)
    const calls: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
    ;(service as any).client = {
      session: {
        viewed: async (input: (typeof calls)[number]) => {
          calls.push(input)
        },
      },
    }
    service.registerVisible("sidebar", ["ses-1"])
    await Bun.sleep(175)
    service.registerVisible("sidebar", ["ses-2"])
    await Bun.sleep(175)
    service.registerVisible("sidebar", [])
    await Bun.sleep(175)
    expect(calls).toHaveLength(3)
    const id = calls[0].viewer.id
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    for (const c of calls) expect(c.viewer.id).toBe(id)
    const seqs = calls.map((c) => c.viewer.sequence)
    expect(seqs).toEqual([1, 2, 3])
  })

  test("sends snapshots while remote control is disabled", async () => {
    const service = new KiloConnectionService({} as any)
    const calls: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
    ;(service as any).client = {
      session: {
        viewed: async (input: (typeof calls)[number]) => {
          calls.push(input)
        },
      },
    }
    service.setRemoteService({
      getState: () => ({ enabled: false, connected: false }),
      onChange: () => () => {},
    } as any)

    service.registerVisible("sidebar", ["ses-1"])
    service.registerAttached("agent-manager", ["ses-2"])
    await Bun.sleep(175)

    expect(calls).toHaveLength(1)
    expect([...calls[0].visible].sort()).toEqual(["ses-1"])
    expect([...calls[0].attached].sort()).toEqual(["ses-1", "ses-2"])
  })
})
