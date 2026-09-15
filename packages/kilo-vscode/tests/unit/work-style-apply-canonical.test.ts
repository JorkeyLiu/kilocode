// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"
import { handleWorkStyleApplyMessage } from "../../src/kilo-provider/work-style-apply-handler"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Posted = Record<string, unknown>

async function setupService(input?: {
  globalConfig?: Record<string, unknown>
  withProject?: boolean
  beforeConfigFinalCas?: (filePath: string) => void
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-workstyle-canonical-"))
  dirs.push(root)
  const global = path.join(root, "global")
  fs.mkdirSync(global, { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify(input?.globalConfig ?? { model: "custom/model" }))
  let project: string | null = null
  if (input?.withProject !== false) {
    project = path.join(root, "project")
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  }
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: project ? new Roots(project, global) : new Roots(undefined, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    ...(input?.beforeConfigFinalCas ? { beforeConfigFinalCas: input.beforeConfigFinalCas } : {}),
  })
  await canonical.initialize()
  return { canonical, global, project, secrets }
}

/** In-memory vscode settings backing `kilo-code.new` keys used by the handler. */
function setupVscodeSettings(initial?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(initial ?? { agentWorkStyle: "unset" }))
  const events: string[] = []
  const orig = vscode.workspace.getConfiguration
  const config = {
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      events.push(`vscode:${key}:${String(value)}`)
      if (value === undefined) store.delete(key)
      else store.set(key, value)
    },
    inspect: (key: string) => {
      const global = store.get(key)
      return {
        globalValue: global,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }
    },
  }
  ;(vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => config
  return {
    store,
    events,
    restore: () => {
      ;(vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = orig
    },
  }
}

function setupConnection(sdk: { calls: string[]; data?: unknown }) {
  return {
    isPrivateAvailable: () => false,
    getClientAsync: async () => ({
      config: {
        get: async () => ({ data: sdk.data ?? {} }),
      },
      global: {
        config: {
          update: async () => {
            sdk.calls.push("global.config.update")
            throw new Error("SDK global.config.update must not run for Work Style")
          },
        },
      },
    }),
  } as never
}

describe("work-style apply via canonical config service", () => {
  it("writes the preset through writeConfigScopes global with stamp and posts success with no SDK mutation", async () => {
    const { canonical, global } = await setupService()
    const ui = setupVscodeSettings()
    try {
      const sdk = { calls: [] as string[] }
      const connection = setupConnection(sdk)
      const seen: Array<{ source?: string }> = []
      const sub = canonical.onDidChange((event) => seen.push(event))

      const preStamp = canonical.stamp
      const spy: Array<{ scopes: unknown; stamp: unknown }> = []
      const inner = canonical.writeConfigScopes.bind(canonical)
      canonical.writeConfigScopes = (async (scopes: never, stamp?: never) => {
        spy.push({ scopes, stamp })
        return inner(scopes as never, stamp as never)
      }) as typeof canonical.writeConfigScopes

      const messages: Posted[] = []
      const handled = await handleWorkStyleApplyMessage({
        message: { type: "applyWorkStyle", style: "human-in-the-loop" },
        connection,
        directory: "/repo",
        canonical,
        post: (message) => messages.push(message as Posted),
      })

      expect(handled).toBe(true)
      expect(messages).toEqual([{ type: "workStyleApplied", style: "human-in-the-loop" }])
      expect(sdk.calls).toEqual([])
      expect(spy.length).toBe(1)
      const call = spy[0]!
      expect(Object.keys((call.scopes as Record<string, unknown>))).toEqual(["global"])
      const patch = (call.scopes as { global: { patch: Record<string, unknown>; expectedHash: string } }).global
      expect(patch.expectedHash).toBe(preStamp.globalHash ?? "absent")
      expect(call.stamp).toEqual(preStamp)
      expect(patch.patch.permission).toBeDefined()
      expect(patch.patch.terminal_command_display).toBe("expanded")
      expect(patch.patch.auto_collapse_reasoning).toBe(false)

      const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
      expect(file.model).toBe("custom/model")
      expect(file.permission).toBeDefined()
      expect(file.terminal_command_display).toBe("expanded")
      expect(file.auto_collapse_reasoning).toBe(false)
      expect(ui.store.get("showTaskTimeline")).toBe(true)
      expect(ui.store.get("agentWorkStyle")).toBe("human-in-the-loop")
      expect(seen.some((event) => event.source === "gui")).toBe(true)
      sub.dispose()
    } finally {
      ui.restore()
      canonical.dispose()
    }
  })

  it("propagates canonical write failure, rolls back vscode settings, and leaves the file untouched", async () => {
    const { canonical, global } = await setupService({
      beforeConfigFinalCas: (filePath) => {
        // Simulate a concurrent external edit between validation and CAS so the
        // real canonical path returns a stale conflict.
        fs.writeFileSync(filePath, JSON.stringify({ model: "custom/externally-changed" }))
      },
    })
    const ui = setupVscodeSettings()
    try {
      const sdk = { calls: [] as string[] }
      const connection = setupConnection(sdk)
      const before = fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")
      const messages: Posted[] = []
      const handled = await handleWorkStyleApplyMessage({
        message: { type: "applyWorkStyle", style: "autonomous" },
        connection,
        directory: "/repo",
        canonical,
        post: (message) => messages.push(message as Posted),
      })

      expect(handled).toBe(true)
      expect(messages.length).toBe(1)
      expect(messages[0]!.type).toBe("workStyleApplyFailed")
      expect(typeof (messages[0] as { message?: unknown }).message).toBe("string")
      expect(sdk.calls).toEqual([])
      // Rollback restored the vscode settings touched before the failed patch.
      expect(ui.store.get("agentWorkStyle")).toBe("unset")
      expect(ui.store.has("showTaskTimeline")).toBe(false)
      // The externally changed bytes are preserved; the preset was not applied.
      const after = fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")
      expect(after).toContain("custom/externally-changed")
      expect(after).not.toBe(before)
    } finally {
      ui.restore()
      canonical.dispose()
    }
  })

  it("fails closed without a canonical service and rolls back vscode settings", async () => {
    const ui = setupVscodeSettings()
    try {
      const sdk = { calls: [] as string[] }
      const connection = setupConnection(sdk)
      const messages: Posted[] = []
      const handled = await handleWorkStyleApplyMessage({
        message: { type: "applyWorkStyle", style: "human-in-the-loop" },
        connection,
        directory: "/repo",
        canonical: null,
        post: (message) => messages.push(message as Posted),
      })

      expect(handled).toBe(true)
      expect(messages.length).toBe(1)
      expect(messages[0]).toMatchObject({ type: "workStyleApplyFailed", rollbackFailed: false })
      expect(String((messages[0] as { message?: unknown }).message ?? "")).toContain("Canonical config authority")
      expect(sdk.calls).toEqual([])
      expect(ui.store.get("agentWorkStyle")).toBe("unset")
      expect(ui.store.has("showTaskTimeline")).toBe(false)
    } finally {
      ui.restore()
    }
  })

  it("succeeds for global scope with no workspace folder open", async () => {
    const { canonical, global } = await setupService({ withProject: false })
    expect(canonical.hasProject).toBe(false)
    const ui = setupVscodeSettings()
    try {
      const sdk = { calls: [] as string[] }
      const connection = setupConnection(sdk)
      const messages: Posted[] = []
      const handled = await handleWorkStyleApplyMessage({
        message: { type: "applyWorkStyle", style: "autonomous" },
        connection,
        directory: "/repo",
        canonical,
        post: (message) => messages.push(message as Posted),
      })

      expect(handled).toBe(true)
      expect(messages).toEqual([{ type: "workStyleApplied", style: "autonomous" }])
      expect(sdk.calls).toEqual([])
      const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
      expect(file.terminal_command_display).toBe("collapsed")
      expect(file.auto_collapse_reasoning).toBe(true)
    } finally {
      ui.restore()
      canonical.dispose()
    }
  })

  it("contains no SDK global config mutation in the handler source", async () => {
    const source = await Bun.file(new URL("../../src/kilo-provider/work-style-apply-handler.ts", import.meta.url)).text()
    expect(source).not.toContain("client.global.config.update")
    expect(source).not.toContain("global.config.update({")
    expect(source).toContain("writeConfigScopes")
  })
})
