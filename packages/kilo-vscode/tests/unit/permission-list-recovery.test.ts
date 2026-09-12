import { describe, expect, it, spyOn } from "bun:test"
import {
  fetchAndSendPendingPermissions,
  type PermissionContext,
  type RecoverablePermission,
} from "../../src/kilo-provider/handlers/permission-handler"

function pending(id: string, sessionID: string): RecoverablePermission {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["*"],
    always: [] as string[],
    metadata: {},
    tool: undefined,
  }
}

function succeeded(req: Record<string, unknown>, perms: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { permissions: perms },
    },
  }
}

function terminal(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
    },
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

function setup(opts: {
  tracked: string[]
  dirs: Map<string, string>
  workspace?: string
  privateByDir?: Record<string, "ok" | "terminal" | "fallback">
  privatePerms?: Record<string, RecoverablePermission[]>
  sdkPerms?: Record<string, RecoverablePermission[]>
  sdkErrors?: Record<string, unknown>
}) {
  const messages: unknown[] = []
  const queries: string[] = []
  const permDirs = new Map<string, string>()
  const privateCalls: string[] = []
  const conn = {
    isPrivateAvailable: () => true,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 1,
    privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => {
      const dir = (req.context as Record<string, unknown>).directory as string
      privateCalls.push(dir)
      const mode = opts.privateByDir?.[dir] ?? "fallback"
      if (mode === "ok") return { id: 1, promise: Promise.resolve(succeeded(req, opts.privatePerms?.[dir] ?? [])), cancel: () => true }
      if (mode === "terminal") return { id: 1, promise: Promise.resolve(terminal(req)), cancel: () => true }
      return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
    },
  } as unknown as PermissionContext["connection"]
  const client = {
    permission: {
      list: async (args?: { directory?: string }) => {
        const dir = args?.directory ?? ""
        queries.push(dir)
        const err = opts.sdkErrors?.[dir]
        if (err) return { data: undefined, error: err }
        return { data: opts.sdkPerms?.[dir] ?? [], error: undefined }
      },
      saveAlwaysRules: async () => ({ data: true }),
      reply: async () => ({ data: true }),
    },
  } as unknown as PermissionContext["client"]
  const fake: PermissionContext = {
    client,
    currentSessionId: undefined,
    trackedSessionIds: new Set(opts.tracked),
    sessionDirectories: opts.dirs,
    connection: conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => opts.workspace ?? "/workspace",
    recordPermissionDirectory: (id, dir) => permDirs.set(id, dir),
    getPermissionDirectory: (id) => permDirs.get(id),
    clearPermissionDirectory: (id) => permDirs.delete(id),
    prunePermissionDirectories: (active, valid) => {
      for (const [key, dir] of permDirs) {
        if (active.has(key)) continue
        if (valid && !valid.has(dir)) continue
        permDirs.delete(key)
      }
    },
  }
  return { fake, messages, queries, permDirs, privateCalls }
}

describe("permission-list recovery", () => {
  it("mixed success and failure preserves failed-dir mappings and keeps first-wins order", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([
        ["ses_1", "/good"],
        ["ses_2", "/bad"],
      ])
      const dup = pending("per_dup00000000000000001", "ses_1")
      const { fake, messages, permDirs, privateCalls } = setup({
        tracked: ["ses_1", "ses_2"],
        dirs,
        workspace: "/workspace",
        privateByDir: { "/workspace": "ok", "/good": "fallback", "/bad": "terminal" },
        privatePerms: { "/workspace": [dup] },
        sdkPerms: { "/good": [dup, pending("per_good0000000000000002", "ses_1")] },
      })
      permDirs.set("per_stale_bad0000000000001", "/bad")
      permDirs.set("per_stale_ws00000000000001", "/workspace")

      await fetchAndSendPendingPermissions(fake)

      expect(privateCalls).toEqual(["/workspace", "/good", "/bad"])
      expect(permDirs.get("per_dup00000000000000001")).toBe("/workspace")
      expect(permDirs.get("per_stale_bad0000000000001")).toBe("/bad")
      expect(permDirs.has("per_stale_ws00000000000001")).toBe(false)
      const ids = (messages as Array<{ type: string; permission: { id: string } }>)
        .filter((m) => m.type === "permissionRequest")
        .map((m) => m.permission.id)
      expect(ids.filter((id) => id === "per_dup00000000000000001")).toHaveLength(1)
      expect(ids).toContain("per_good0000000000000002")
    } finally {
      spy.mockRestore()
    }
  })

  it("successful empty prunes only that dir while failed dir stays", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([["ses_1", "/failing"]])
      const { fake, permDirs } = setup({
        tracked: ["ses_1"],
        dirs,
        privateByDir: { "/workspace": "ok", "/failing": "fallback" },
        privatePerms: { "/workspace": [] },
        sdkErrors: { "/failing": new Error("boom") },
      })
      permDirs.set("workspace-stale", "/workspace")
      permDirs.set("worktree-pending", "/failing")

      await fetchAndSendPendingPermissions(fake)

      expect(permDirs.has("workspace-stale")).toBe(false)
      expect(permDirs.get("worktree-pending")).toBe("/failing")
    } finally {
      spy.mockRestore()
    }
  })

  it("one directory failure does not suppress another directory success", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, messages } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "terminal", "/a": "ok" },
      privatePerms: { "/a": [pending("per_a00000000000000000001", "ses_1")] },
    })
    await fetchAndSendPendingPermissions(fake)
    expect(messages).toHaveLength(1)
  })
})
