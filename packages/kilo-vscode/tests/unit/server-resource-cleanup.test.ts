import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import {
  RUNTIME_TOKEN_ENV,
  cleanupOwnedProcesses,
  createRuntimeToken,
  enumerateOwnedPids,
  hasGuardianToken,
  hasTokenInEnviron,
  hasTokenInPsCommand,
  isValidRuntimeToken,
} from "../../src/services/cli-backend/server-resource-cleanup"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("server resource cleanup token identity", () => {
  test("mints 64-hex tokens and validates shape exactly", () => {
    const a = createRuntimeToken()
    const b = createRuntimeToken()
    expect(isValidRuntimeToken(a)).toBeTrue()
    expect(isValidRuntimeToken(b)).toBeTrue()
    expect(a).not.toBe(b)
    expect(isValidRuntimeToken("")).toBeFalse()
    expect(isValidRuntimeToken(`${a}x`)).toBeFalse()
    expect(isValidRuntimeToken(a.slice(0, 63))).toBeFalse()
    expect(isValidRuntimeToken(a.toUpperCase())).toBeFalse()
    expect(isValidRuntimeToken(undefined)).toBeFalse()
  })

  test("environ parsing is exact, never substring", () => {
    const token = createRuntimeToken()
    const entry = `${RUNTIME_TOKEN_ENV}=${token}`
    expect(hasTokenInEnviron(Buffer.from(`PATH=/bin\0${entry}\0FOO=1\0`), token)).toBeTrue()
    // Prefix collision: stored value extends past the token with hex chars.
    expect(hasTokenInEnviron(Buffer.from(`PATH=/bin\0${entry}ab\0`), token)).toBeFalse()
    // Per-process persistent oracle must not satisfy the instance check.
    expect(hasTokenInEnviron(Buffer.from(`KILO_BACKGROUND_PROCESS_TOKEN=${token}\0`), token)).toBeFalse()
    // Stale identity: a different valid token never matches.
    expect(hasTokenInEnviron(Buffer.from(`PATH=/bin\0${entry}\0`), createRuntimeToken())).toBeFalse()
    expect(hasTokenInEnviron(Buffer.from(""), token)).toBeFalse()
    expect(hasTokenInEnviron(Buffer.from(entry), "not-a-token")).toBeFalse()
  })

  test("ps parsing is exact with hex-boundary guard", () => {
    const token = createRuntimeToken()
    const needle = `${RUNTIME_TOKEN_ENV}=${token}`
    expect(hasTokenInPsCommand(`123 123 /bin/sleep 30 ${needle} FOO=1`, token)).toBeTrue()
    expect(hasTokenInPsCommand(`123 123 /bin/sleep 30 ${needle}ab FOO=1`, token)).toBeFalse()
    expect(hasTokenInPsCommand(`123 123 /bin/sleep 30 KILO_BACKGROUND_PROCESS_TOKEN=${token}`, token)).toBeFalse()
    expect(hasTokenInPsCommand(`123 123 /bin/sleep 30 ${needle}`, createRuntimeToken())).toBeFalse()
    expect(hasTokenInPsCommand("", token)).toBeFalse()
  })

  test("unsupported platform fails closed without signalling", async () => {
    const token = createRuntimeToken()
    const found = await enumerateOwnedPids(token, "win32")
    expect(found.status).toBe("unsupported")
    const out = await cleanupOwnedProcesses(token, { platform: "win32" })
    expect(out.status).toBe("unsupported")
  })

  test("invalid token fails closed without signalling", async () => {
    const out = await cleanupOwnedProcesses("not-a-token")
    expect(out.status).toBe("failed")
  })

  test("guardian argv predicate requires marker plus exact token", () => {
    const token = createRuntimeToken()
    expect(hasGuardianToken(`bun serve-entry.ts __process-guardian --inner-pid 1 --token ${token}`, token)).toBeFalse()
    expect(
      hasGuardianToken(
        `bun serve-entry.ts __process-guardian --inner-pid 1 --parent-pid 2 ${RUNTIME_TOKEN_ENV}=${token}`,
        token,
      ),
    ).toBeTrue()
    // Wrong token never matches.
    expect(
      hasGuardianToken(
        `bun serve-entry.ts __process-guardian --inner-pid 1 ${RUNTIME_TOKEN_ENV}=${token}`,
        createRuntimeToken(),
      ),
    ).toBeFalse()
    // Marker without token never matches (no lie by marker alone).
    expect(hasGuardianToken(`bun serve-entry.ts __process-guardian --inner-pid 1`, token)).toBeFalse()
    // Persistent oracle key never satisfies the guardian predicate.
    expect(hasGuardianToken(`node __background-process-runner KILO_BACKGROUND_PROCESS_TOKEN=${token}`, token)).toBeFalse()
    // Invalid token shape never matches.
    expect(hasGuardianToken(`__process-guardian ${RUNTIME_TOKEN_ENV}=short`, "short")).toBeFalse()
  })
})

describe("server resource cleanup real runtime evidence", () => {
  test("reaps exact owned detached children, spares decoy and persistent-stripped", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const token = createRuntimeToken()
    const owned = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [RUNTIME_TOKEN_ENV]: token },
    })
    owned.unref()
    const ownedPid = owned.pid!
    // Second owned child in its own group (proves enumeration, not group kill).
    const owned2 = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [RUNTIME_TOKEN_ENV]: token },
    })
    owned2.unref()
    const ownedPid2 = owned2.pid!
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
    })
    decoy.unref()
    const decoyPid = decoy.pid!
    // Persistent-shaped child: per-process oracle only, instance token stripped.
    const persistEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KILO_BACKGROUND_PROCESS_TOKEN: "persist-oracle",
    }
    delete persistEnv[RUNTIME_TOKEN_ENV]
    const persist = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
      env: persistEnv,
    })
    persist.unref()
    const persistPid = persist.pid!
    try {
      expect(alive(ownedPid)).toBeTrue()
      expect(alive(ownedPid2)).toBeTrue()
      expect(alive(decoyPid)).toBeTrue()
      expect(alive(persistPid)).toBeTrue()
      // Stale-token enumeration must not see any of these PIDs.
      const stale = await enumerateOwnedPids(createRuntimeToken())
      if (stale.status === "ok") {
        expect(stale.pids).not.toContain(ownedPid)
        expect(stale.pids).not.toContain(decoyPid)
      }
      const seen = await enumerateOwnedPids(token)
      expect(seen.status).toBe("ok")
      if (seen.status === "ok") {
        expect(seen.pids).toContain(ownedPid)
        expect(seen.pids).toContain(ownedPid2)
        expect(seen.pids).not.toContain(decoyPid)
        expect(seen.pids).not.toContain(persistPid)
      }
      const out = await cleanupOwnedProcesses(token)
      expect(out.status).toBe("clean")
      expect(alive(ownedPid)).toBeFalse()
      expect(alive(ownedPid2)).toBeFalse()
      expect(alive(decoyPid)).toBeTrue()
      expect(alive(persistPid)).toBeTrue()
    } finally {
      for (const pid of [ownedPid, ownedPid2, decoyPid, persistPid]) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }, 30000)

  test("shell-interpreter inheritance is owned; env-scrubbed child documents the boundary", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const token = createRuntimeToken()
    // Shell path: the exact spawner ShellTool uses on Unix is `command` with a
    // `shell` interpreter (`ChildProcess.make(command, [], { shell, env })`).
    // A `/bin/sh -c 'exec node …'` child must therefore carry the token by env
    // inheritance, exactly like runtime Shell/Effect-spawner grandchildren.
    const shellOwned = spawn("/bin/sh", ["-c", `exec ${process.execPath} -e 'setTimeout(()=>{}, 30000)'`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [RUNTIME_TOKEN_ENV]: token },
    })
    shellOwned.unref()
    const shellPid = shellOwned.pid!
    // Env-scrubbed boundary: a descendant that execs with a cleared env
    // (`env -i` shape) leaves the token boundary by construction. It must NOT
    // be reaped; main decides closure for this documented gap.
    const scrubbed = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    })
    scrubbed.unref()
    const scrubbedPid = scrubbed.pid!
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      detached: true,
      stdio: "ignore",
    })
    decoy.unref()
    const decoyPid = decoy.pid!
    try {
      expect(alive(shellPid)).toBeTrue()
      expect(alive(scrubbedPid)).toBeTrue()
      expect(alive(decoyPid)).toBeTrue()
      const seen = await enumerateOwnedPids(token)
      expect(seen.status).toBe("ok")
      if (seen.status === "ok") {
        expect(seen.pids).toContain(shellPid)
        expect(seen.pids).not.toContain(scrubbedPid)
        expect(seen.pids).not.toContain(decoyPid)
      }
      const out = await cleanupOwnedProcesses(token)
      expect(out.status).toBe("clean")
      // Exact PID before/after: shell-inheriting child dead, scrubbed + decoy alive.
      expect(alive(shellPid)).toBeFalse()
      expect(alive(scrubbedPid)).toBeTrue()
      expect(alive(decoyPid)).toBeTrue()
    } finally {
      for (const pid of [shellPid, scrubbedPid, decoyPid]) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }, 30000)

  test("argv spoof without env is never owned and never signalled (F1)", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const token = createRuntimeToken()
    // Token rides argv (`-e` script text) but the env block is scrubbed: a
    // malicious/faulty argv must not satisfy the env-only oracle. On Darwin
    // the env view (`ps -E`) contains argv too, so the separated argv-view
    // comparison is the only thing that excludes this PID.
    const spoof = spawn(process.execPath, ["-e", `setTimeout(()=>{}, 30000) // ${RUNTIME_TOKEN_ENV}=${token}`], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    })
    spoof.unref()
    const spoofPid = spoof.pid!
    try {
      expect(alive(spoofPid)).toBeTrue()
      await new Promise((r) => setTimeout(r, 300))
      const seen = await enumerateOwnedPids(token)
      expect(seen.status).toBe("ok")
      if (seen.status === "ok") expect(seen.pids).not.toContain(spoofPid)
      const out = await cleanupOwnedProcesses(token)
      expect(out.status).toBe("clean")
      expect(alive(spoofPid)).toBeTrue()
    } finally {
      try {
        process.kill(spoofPid, "SIGKILL")
      } catch {}
    }
  }, 30000)

  test("TERM-fork late child is drained to quiescence, foreign decoy survives (F2/F5)", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const token = createRuntimeToken()
    const fs = await import("fs")
    const os = await import("os")
    const dir = fs.mkdtempSync(`${os.tmpdir()}/kilo-latechild-`)
    const marker = `${dir}/grandchild.pid`
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('child_process');const fs=require('fs');` +
          `process.on('SIGTERM',()=>{const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});` +
          `g.unref();try{fs.writeFileSync(${JSON.stringify(marker)},String(g.pid));}catch{}` +
          `setTimeout(()=>process.exit(0),100);});setTimeout(()=>{},30000);`,
      ],
      { detached: true, stdio: "ignore", env: { ...process.env, [RUNTIME_TOKEN_ENV]: token } },
    )
    parent.unref()
    const parentPid = parent.pid!
    // Foreign decoy spawned mid-sweep must never be touched (TERM-window guard).
    let decoyPid = 0
    const sweep = cleanupOwnedProcesses(token)
    await new Promise((r) => setTimeout(r, 200))
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { detached: true, stdio: "ignore" })
    decoy.unref()
    decoyPid = decoy.pid!
    try {
      const out = await sweep
      expect(out.status).toBe("clean")
      expect(alive(parentPid)).toBeFalse()
      expect(alive(decoyPid)).toBeTrue()
      if (fs.existsSync(marker)) {
        const late = Number(fs.readFileSync(marker, "utf8"))
        expect(alive(late)).toBeFalse()
        try {
          process.kill(late, "SIGKILL")
        } catch {}
      }
      const fresh = await enumerateOwnedPids(token)
      expect(fresh.status).toBe("ok")
      if (fresh.status === "ok") expect(fresh.pids).toEqual([])
    } finally {
      try {
        process.kill(parentPid, "SIGKILL")
      } catch {}
      if (decoyPid) {
        try {
          process.kill(decoyPid, "SIGKILL")
        } catch {}
      }
      try {
        if (fs.existsSync(marker)) {
          const v = Number(fs.readFileSync(marker, "utf8"))
          try {
            process.kill(v, "SIGKILL")
          } catch {}
        }
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true })
      } catch {}
    }
  }, 60000)
})
