import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { ServerManager, ServerStartupError } from "../../src/services/cli-backend/server-manager"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Ctx = import("vscode").ExtensionContext

function fixture(extRoot: string, storage: string): Ctx {
  const hidden = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '__internal-storage-cutover') { console.log(JSON.stringify({ ok: true, canonical: true, archiveID: 'test' })); process.exit(0); }
console.error('unexpected hidden args'); process.exit(1);
`
  fs.mkdirSync(path.join(extRoot, "bin"), { recursive: true })
  for (const name of ["kilo-serve", "kilo"]) {
    const p = path.join(extRoot, "bin", name)
    fs.writeFileSync(p, hidden, "utf8")
    fs.chmodSync(p, 0o755)
  }
  return {
    extensionPath: extRoot,
    globalStorageUri: { fsPath: storage },
    extensionMode: 1,
    extension: { packageJSON: { version: "7.4.11" } },
  } as unknown as Ctx
}

function stubWorkspace(storage: string) {
  const ws = vscode.workspace as unknown as Record<string, unknown>
  const origFolders = ws.workspaceFolders
  const origGetConfig = ws.getConfiguration
  ws.workspaceFolders = [{ uri: { fsPath: storage } }] as unknown as typeof ws.workspaceFolders
  ws.getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
  return () => {
    ws.workspaceFolders = origFolders
    ws.getConfiguration = origGetConfig
  }
}

function stubCliPath(script: string): () => void {
  const proto = ServerManager.prototype as unknown as Record<string, unknown>
  const orig = proto.getCliPath
  proto.getCliPath = () => script
  return () => {
    proto.getCliPath = orig
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("ServerManager crash-resource lifecycle", () => {
  test("unexpected SIGKILL crash: cleanup precedes replacement, decoy survives", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-"))
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-ext-"))
    const ctx = fixture(extRoot, storage)
    const restoreWs = stubWorkspace(storage)
    const portA = 42211
    const portB = 42212
    const marker = path.join(storage, "grandchild.pid")
    const persistMarker = path.join(storage, "persist.pid")
    const scrubMarker = path.join(storage, "scrubbed.pid")
    const probe = path.join(storage, "probe.txt")
    const scriptA = path.join(os.tmpdir(), `fake-serve-crash-a-${Date.now()}.js`)
    fs.writeFileSync(
      scriptA,
      `#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
// Shell-native runtime-dependent grandchild: inherits KILO_RUNTIME_TOKEN via
// /bin/sh env inheritance (the exact Unix Shell/Effect-spawner shape).
const kid = spawn('/bin/sh', ['-c', \`exec \${process.execPath} -e 'setTimeout(()=>{}, 30000)'\`], { detached: true, stdio: 'ignore' });
kid.unref();
fs.writeFileSync(${JSON.stringify(marker)}, String(kid.pid));
// Persistent-shaped grandchild: per-process oracle only, instance token stripped
// (mirrors BackgroundProcess persistent launch env composition).
const penv = { ...process.env, KILO_BACKGROUND_PROCESS_TOKEN: 'persist-oracle' };
delete penv.KILO_RUNTIME_TOKEN;
const persist = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { detached: true, stdio: 'ignore', env: penv });
persist.unref();
fs.writeFileSync(${JSON.stringify(persistMarker)}, String(persist.pid));
// Env-scrubbed boundary grandchild (env -i shape): leaves the token boundary by
// construction. Documents the gap; main decides closure. Must survive cleanup.
const scrub = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
scrub.unref();
fs.writeFileSync(${JSON.stringify(scrubMarker)}, String(scrub.pid));
console.log('kilo server listening on http://127.0.0.1:${portA}');
setInterval(()=>{}, 1000);
`,
      "utf8",
    )
    fs.chmodSync(scriptA, 0o755)
    let restoreCli = stubCliPath(scriptA)
    const mgr = new ServerManager(ctx)
    const decoy = (await import("child_process")).spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
    })
    decoy.unref()
    const decoyPid = decoy.pid!
    // Independent persistent-shaped decoy owned by the harness (never by the serve
    // instance): per-process oracle only, instance token absent by construction.
    const persistDecoyEnv: NodeJS.ProcessEnv = { ...process.env, KILO_BACKGROUND_PROCESS_TOKEN: "harness-persist" }
    delete persistDecoyEnv.KILO_RUNTIME_TOKEN
    const persistDecoy = (await import("child_process")).spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
      env: persistDecoyEnv,
    })
    persistDecoy.unref()
    const persistDecoyPid = persistDecoy.pid!
    try {
      const first = await mgr.getServer()
      expect(first.port).toBe(portA)
      const servePid = first.process.pid!
      const servePidBefore = servePid
      await waitFor(() => fs.existsSync(marker) && fs.existsSync(persistMarker) && fs.existsSync(scrubMarker))
      const victim = Number(fs.readFileSync(marker, "utf8"))
      const persistKid = Number(fs.readFileSync(persistMarker, "utf8"))
      const scrubKid = Number(fs.readFileSync(scrubMarker, "utf8"))
      expect(alive(servePidBefore)).toBeTrue()
      expect(alive(victim)).toBeTrue()
      expect(alive(persistKid)).toBeTrue()
      expect(alive(scrubKid)).toBeTrue()
      expect(alive(decoyPid)).toBeTrue()
      expect(alive(persistDecoyPid)).toBeTrue()
      const crashedBefore = mgr.getCrashedForTest()
      expect(crashedBefore).toBeNull()
      // Unexpected hard crash: SIGKILL the runtime without any dispose path.
      process.kill(servePid, "SIGKILL")
      await waitFor(() => mgr.getCrashedForTest() !== null)
      const crashed = mgr.getCrashedForTest()!
      expect(crashed.epoch).toBe(first.epoch)
      expect(crashed.token).toBe(first.token)
      expect(alive(servePid)).toBeFalse()
      const servePidAfter = servePid
      expect(servePidAfter).toBe(servePidBefore)
      // Replacement script probes at BOOT whether the victim is already dead:
      // "already-dead" proves cleanup completed before the new spawn.
      const scriptB = path.join(os.tmpdir(), `fake-serve-crash-b-${Date.now()}.js`)
      fs.writeFileSync(
        scriptB,
        `#!/usr/bin/env node
const fs = require('fs');
let state = 'unknown';
try { process.kill(${victim}, 0); state = 'still-alive'; } catch { state = 'already-dead'; }
fs.writeFileSync(${JSON.stringify(probe)}, state);
console.log('kilo server listening on http://127.0.0.1:${portB}');
setInterval(()=>{}, 1000);
`,
        "utf8",
      )
      fs.chmodSync(scriptB, 0o755)
      restoreCli()
      restoreCli = stubCliPath(scriptB)
      const second = await mgr.getServer()
      expect(second.port).toBe(portB)
      expect(second.epoch).not.toBe(first.epoch)
      expect(second.token).not.toBe(first.token)
      await waitFor(() => fs.existsSync(probe))
      expect(fs.readFileSync(probe, "utf8")).toBe("already-dead")
      // Exact PID before/after: shell-inheriting victim reaped, serve dead,
      // independent decoy + persistent-shaped + harness persistent alive.
      // Scrubbed (env -i shape) documents the boundary: alive by construction,
      // main decides closure.
      expect(alive(victim)).toBeFalse()
      expect(alive(persistKid)).toBeTrue()
      expect(alive(scrubKid)).toBeTrue()
      expect(alive(decoyPid)).toBeTrue()
      expect(alive(persistDecoyPid)).toBeTrue()
      expect(mgr.getCrashedForTest()).toBeNull()
      try {
        fs.unlinkSync(scriptB)
      } catch {}
      await mgr.dispose()
      // Disposal authority contract: dispose awaits shutdown convergence
      // (child exit + token sweep) before relinquishing — no fire-and-forget.
      // Scrubbed/out-of-boundary survivors are unowned leftovers by design;
      // this test reaps them explicitly below (no global pkill).
    } finally {
      restoreCli()
      restoreWs()
      try {
        await mgr.dispose()
      } catch {}
      for (const pid of [decoyPid, persistDecoyPid]) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      for (const file of [marker, persistMarker, scrubMarker]) {
        try {
          if (fs.existsSync(file)) {
            const v = Number(fs.readFileSync(file, "utf8"))
            try {
              process.kill(v, "SIGKILL")
            } catch {}
          }
        } catch {}
      }
      try {
        fs.unlinkSync(scriptA)
      } catch {}
      try {
        fs.rmSync(storage, { recursive: true })
      } catch {}
      try {
        fs.rmSync(extRoot, { recursive: true })
      } catch {}
    }
  }, 60000)

  test("cleanup failure withholds replacement and never spawns", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-fail-"))
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-failext-"))
    const ctx = fixture(extRoot, storage)
    const restoreWs = stubWorkspace(storage)
    let spawns = 0
    const proto = ServerManager.prototype as unknown as Record<string, unknown>
    const orig = proto.getCliPath
    proto.getCliPath = () => {
      spawns += 1
      return "/nonexistent/kilo-serve"
    }
    const mgr = new ServerManager(ctx)
    try {
      // Unknown ownership (stale identity, no valid token) must fail closed.
      ;(mgr as unknown as { crashed: unknown }).crashed = { epoch: 7, token: "", pid: 123456 }
      await expect(mgr.getServer()).rejects.toBeInstanceOf(ServerStartupError)
      expect(spawns).toBe(0)
      // Retry also withholds: the stale identity is retained, not cleared.
      await expect(mgr.getServer()).rejects.toBeInstanceOf(ServerStartupError)
      expect(spawns).toBe(0)
      expect(mgr.getCrashedForTest()).not.toBeNull()
    } finally {
      proto.getCliPath = orig
      restoreWs()
      try {
        await mgr.dispose()
      } catch {}
      try {
        fs.rmSync(storage, { recursive: true })
      } catch {}
      try {
        fs.rmSync(extRoot, { recursive: true })
      } catch {}
    }
  })

  test("dispose during pending startup kills exact child once and prevents install", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-disp-"))
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-crash-dispext-"))
    const ctx = fixture(extRoot, storage)
    const restoreWs = stubWorkspace(storage)
    const port = 42213
    const script = path.join(os.tmpdir(), `fake-serve-crash-d-${Date.now()}.js`)
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
setTimeout(()=>console.log('kilo server listening on http://127.0.0.1:${port}'), 400);
setTimeout(()=>process.exit(0), 5000);
`,
      "utf8",
    )
    fs.chmodSync(script, 0o755)
    const restoreCli = stubCliPath(script)
    const mgr = new ServerManager(ctx)
    const origKill = process.kill
    const groupKills: number[] = []
    // @ts-ignore
    process.kill = ((pid: number, signal?: string) => origKill(pid, signal as NodeJS.Signals)) as unknown as typeof process.kill
    const counting = ((pid: number, signal?: string) => {
      if (pid < 0) groupKills.push(pid)
      return (origKill as (...a: unknown[]) => unknown)(pid, signal)
    }) as unknown as typeof process.kill
    // @ts-ignore
    process.kill = counting
    try {
      const pending = mgr.getServer()
      await new Promise((r) => setTimeout(r, 50))
      await mgr.dispose()
      await expect(pending).rejects.toBeTruthy()
      expect((mgr as unknown as { instance: unknown }).instance).toBeNull()
      await mgr.dispose()
      await expect(mgr.getServer()).rejects.toThrow()
    } finally {
      process.kill = origKill
      restoreCli()
      restoreWs()
      try {
        await mgr.dispose()
      } catch {}
      try {
        fs.unlinkSync(script)
      } catch {}
      try {
        fs.rmSync(storage, { recursive: true })
      } catch {}
      try {
        fs.rmSync(extRoot, { recursive: true })
      } catch {}
    }
    // Exact group kill only for the owned starting child; no foreign groups.
    expect(groupKills.length).toBeLessThanOrEqual(2)
  })

  test("awaited dispose converges native child + token sweep before relinquishing", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-dispose-"))
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-dispose-ext-"))
    const ctx = fixture(extRoot, storage)
    const restoreWs = stubWorkspace(storage)
    const port = 42214
    const marker = path.join(storage, "native-grandchild.pid")
    const script = path.join(os.tmpdir(), `fake-serve-dispose-${Date.now()}.js`)
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
// Detached token-inheriting grandchild in its own group: the serve group-kill
// cannot reach it, so only the awaited post-dispose token sweep reaps it.
const kid = spawn('/bin/sh', ['-c', \`exec \${process.execPath} -e 'setTimeout(()=>{}, 30000)'\`], { detached: true, stdio: 'ignore' });
kid.unref();
fs.writeFileSync(${JSON.stringify(marker)}, String(kid.pid));
console.log('kilo server listening on http://127.0.0.1:${port}');
setInterval(()=>{}, 1000);
`,
      "utf8",
    )
    fs.chmodSync(script, 0o755)
    const restoreCli = stubCliPath(script)
    const mgr = new ServerManager(ctx)
    try {
      const inst = await mgr.getServer()
      expect(inst.port).toBe(port)
      await waitFor(() => fs.existsSync(marker))
      const kid = Number(fs.readFileSync(marker, "utf8"))
      expect(alive(kid)).toBeTrue()
      // Awaited convergence: when dispose resolves, the native child is gone
      // AND the detached token grandchild is reaped (no fire-and-forget).
      await mgr.dispose()
      expect(alive(kid)).toBeFalse()
      expect(mgr.getCrashedForTest()).toBeNull()
    } finally {
      restoreCli()
      restoreWs()
      try {
        await mgr.dispose()
      } catch {}
      try {
        if (fs.existsSync(marker)) {
          const v = Number(fs.readFileSync(marker, "utf8"))
          try {
            process.kill(v, "SIGKILL")
          } catch {}
        }
      } catch {}
      try {
        fs.unlinkSync(script)
      } catch {}
      try {
        fs.rmSync(storage, { recursive: true })
      } catch {}
      try {
        fs.rmSync(extRoot, { recursive: true })
      } catch {}
    }
  }, 60000)
})
