import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function makeFakeCliScript(port: number): string {
  const content = `#!/usr/bin/env node
console.log('kilo server listening on http://127.0.0.1:${port}');
setTimeout(()=>process.exit(0), 5000);
try { if (process.stdio[3]) process.stdio[3].on('data', ()=>{}); } catch (_err) {}
try { if (process.stdio[4]) process.stdio[4].on('data', ()=>{}); } catch (_err) {}
`
  const p = path.join(os.tmpdir(), `fake-kilo-${port}-${Date.now()}.js`)
  fs.writeFileSync(p, content, "utf8")
  fs.chmodSync(p, 0o755)
  return p
}

describe("ServerManager fd3/fd4", () => {
  test("spawn uses 5 stdio and exposes private streams while preserving port discovery", async () => {
    const port = 41821
    const script = makeFakeCliScript(port)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-storage-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as { workspaceFolders?: unknown; getConfiguration: unknown }
    const origFolders = (ws as Record<string, unknown>).workspaceFolders
    const origGetConfig = (ws as Record<string, unknown>).getConfiguration
    ;(ws as Record<string, unknown>).workspaceFolders = [{ uri: { fsPath: storage } }]
    ;(ws as Record<string, unknown>).getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = function () {
      return script
    }
    const mgr = new ServerManager(ctx as unknown as import("vscode").ExtensionContext)
    try {
      const inst = await mgr.getServer()
      expect(inst.port).toBe(port)
      expect((inst.process.stdio as unknown[]).length).toBe(5)
      expect(inst.privateReader).toBeTruthy()
      expect(inst.privateWriter).toBeTruthy()
      expect(inst.privateWriter).toBe(inst.process.stdio[3] as unknown)
      expect(inst.privateReader).toBe(inst.process.stdio[4] as unknown)
      expect(inst.pid).toBe(inst.process.pid)
      expect(inst.epoch).toBe(1)
      const inst2 = await mgr.getServer()
      expect(inst2.epoch).toBe(1)
      expect(inst2.pid).toBe(inst.pid)
      expect(inst.process.exitCode).toBeNull()
    } finally {
      mgr.dispose()
      await new Promise((r) => setTimeout(r, 300))
      try {
        fs.unlinkSync(script)
      } catch (err) {
        note("unlink", err)
      }
      try {
        fs.rmSync(storage, { recursive: true })
      } catch (err) {
        note("storage", err)
      }
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ;(ws as Record<string, unknown>).workspaceFolders = origFolders
      ;(ws as Record<string, unknown>).getConfiguration = origGetConfig
    }
  })

  test("dispose releases owned fd streams without interfering with borrow", async () => {
    const port = 41829
    const script = makeFakeCliScript(port)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-storage-release-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as { workspaceFolders?: unknown; getConfiguration: unknown }
    const origFolders = (ws as Record<string, unknown>).workspaceFolders
    const origGetConfig = (ws as Record<string, unknown>).getConfiguration
    ;(ws as Record<string, unknown>).workspaceFolders = [{ uri: { fsPath: storage } }]
    ;(ws as Record<string, unknown>).getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = () => script
    const mgr = new ServerManager(ctx as unknown as import("vscode").ExtensionContext)
    try {
      const inst = await mgr.getServer()
      const writer = inst.privateWriter as unknown as { destroyed?: boolean; writableEnded?: boolean }
      const reader = inst.privateReader as unknown as { destroyed?: boolean; readableEnded?: boolean }
      expect(writer).toBeTruthy()
      expect(reader).toBeTruthy()
      mgr.dispose()
      await new Promise((r) => setTimeout(r, 400))
      expect(writer.destroyed || writer.writableEnded).toBeTrue()
    } finally {
      mgr.dispose()
      try {
        fs.unlinkSync(script)
      } catch (err) {
        note("unlink", err)
      }
      try {
        fs.rmSync(storage, { recursive: true })
      } catch (err) {
        note("storage", err)
      }
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ;(ws as Record<string, unknown>).workspaceFolders = origFolders
      ;(ws as Record<string, unknown>).getConfiguration = origGetConfig
    }
  })

  test("active spawn identity is exact and clears on dead/dispose", () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-storage-spawn-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const mgr = new ServerManager(ctx as unknown as import("vscode").ExtensionContext)
    try {
      const rec = mgr as unknown as Record<string, unknown>
      expect(mgr.getActiveSpawnCwd()).toBeNull()
      const live = {
        process: { exitCode: null, pid: 1, on: () => {}, kill: () => true },
        spawnCwd: "/exact/spawn-cwd",
        privateReader: null,
        privateWriter: null,
      }
      rec.instance = live
      expect(mgr.getActiveSpawnCwd()).toBe("/exact/spawn-cwd")
      const dead = {
        process: { exitCode: 1, pid: 1, on: () => {}, kill: () => true },
        spawnCwd: "/exact/spawn-cwd",
        privateReader: null,
        privateWriter: null,
      }
      rec.instance = dead
      expect(mgr.getActiveSpawnCwd()).toBeNull()
      rec.instance = null
      expect(mgr.getActiveSpawnCwd()).toBeNull()
    } finally {
      mgr.dispose()
      try {
        fs.rmSync(storage, { recursive: true })
      } catch (err) {
        note("storage", err)
      }
    }
  })

  test("exact PID cleanup kills only owned process", async () => {
    const port = 41822
    const script = makeFakeCliScript(port)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-storage2-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws2 = vscode.workspace as unknown as { workspaceFolders?: unknown; getConfiguration: unknown }
    const origFolders2 = (ws2 as Record<string, unknown>).workspaceFolders
    const origGetConfig2 = (ws2 as Record<string, unknown>).getConfiguration
    ;(ws2 as Record<string, unknown>).workspaceFolders = [{ uri: { fsPath: storage } }]
    ;(ws2 as Record<string, unknown>).getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = () => script
    const mgr = new ServerManager(ctx as unknown as import("vscode").ExtensionContext)
    try {
      const inst = await mgr.getServer()
      const pid = inst.pid
      expect(pid).toBeDefined()
      const { spawn: spawnDecoy } = await import("child_process")
      const decoy = spawnDecoy(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { detached: true, stdio: "ignore" })
      decoy.unref()
      const decoyPid = decoy.pid
      expect(decoyPid).toBeDefined()
      expect(decoyPid).not.toBe(pid)
      mgr.dispose()
      await new Promise((r) => setTimeout(r, 500))
      let ownedAlive = true
      try {
        process.kill(pid!, 0)
      } catch (_err) {
        ownedAlive = false
      }
      expect(ownedAlive).toBeFalse()
      let decoyAlive = true
      try {
        process.kill(decoyPid!, 0)
      } catch (_err) {
        decoyAlive = false
      }
      expect(decoyAlive).toBeTrue()
      try {
        process.kill(-decoyPid!, "SIGTERM")
      } catch (_err) {
        try {
          decoy.kill("SIGTERM")
        } catch (err) {
          note("decoy", err)
        }
      }
      try {
        decoy.kill("SIGTERM")
      } catch (err) {
        note("decoy2", err)
      }
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      mgr.dispose()
      try {
        fs.unlinkSync(script)
      } catch (err) {
        note("unlink", err)
      }
      try {
        fs.rmSync(storage, { recursive: true })
      } catch (err) {
        note("storage", err)
      }
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ;(ws2 as Record<string, unknown>).workspaceFolders = origFolders2
      ;(ws2 as Record<string, unknown>).getConfiguration = origGetConfig2
    }
  })
})
