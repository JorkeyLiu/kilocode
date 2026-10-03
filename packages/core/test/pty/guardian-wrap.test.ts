/**
 * kilocode_change - PTY prelaunch guardian acceptance (F-B/F-C).
 *
 * F-B: with a valid private token, a missing/corrupt KILO_GUARDIAN_CMD
 * must fail closed (throw, no target side effect) - never a direct
 * target spawn. F-C: wrapped PTY creation carries the owner birth
 * identity (admission requires it, so success proves it).
 */
import { describe, expect, test } from "bun:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"

const SERVE_ENTRY = path.resolve(import.meta.dirname, "..", "..", "..", "opencode", "src", "serve-entry.ts")

function token(): string {
  return crypto.randomBytes(32).toString("hex")
}

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const ptyLayer = Pty.layer.pipe(Layer.provideMerge(EventV2.defaultLayer), Layer.provideMerge(locationLayer))

function withEnv(vars: Record<string, string | undefined>) {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key])
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]!
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("pty guardian wrap (F-B/F-C)", () => {
  test("valid token + missing/corrupt CMD throws with no target side effect", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-pty-guardian-"))
    const sentinel = path.join(dir, "touched")
    const run = async (cmd: string | undefined) => {
      const restore = withEnv({
        KILO_RUNTIME_TOKEN: token(),
        KILO_GUARDIAN_CMD: cmd,
        KILO_GUARDIAN: undefined,
        KILO_PROCESS_GUARDIAN: undefined,
      })
      try {
        const program = Effect.gen(function* () {
          const svc = yield* Pty.Service
          return yield* svc.create({
            command: "/bin/sh",
            args: ["-c", `touch ${JSON.stringify(sentinel)}; exit 0`],
            cwd: os.tmpdir(),
            env: { TERM: "xterm-256color" },
          })
        }).pipe(Effect.scoped, Effect.provide(ptyLayer))
        await expect(Effect.runPromise(program)).rejects.toThrow()
      } finally {
        restore()
      }
    }
    // Absent install (deleted, not merely invalid JSON).
    await run(undefined)
    expect(fs.existsSync(sentinel)).toBeFalse()
    // Corrupt install.
    await run("not-json")
    expect(fs.existsSync(sentinel)).toBeFalse()
    await fs.promises.rm(dir, { recursive: true, force: true })
  }, 60000)

  test("wrapped create carries --parent-birth with the owner identity", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const { birthOf } = await import("@opencode-ai/core/kilocode/process-birth")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-pty-birth-"))
    const argsFile = path.join(dir, "argv.txt")
    const doneFile = path.join(dir, "done")
    const recorder = path.join(dir, "recorder.sh")
    fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\ntouch ${JSON.stringify(doneFile)}\nexit 0\n`, "utf8")
    fs.chmodSync(recorder, 0o755)
    const restore = withEnv({
      KILO_RUNTIME_TOKEN: token(),
      // Recorder instead of the real guardian: captures the exact argv the
      // PTY wrapper would exec, proving --parent-birth is actually sent.
      KILO_GUARDIAN_CMD: JSON.stringify(["/bin/sh", recorder]),
      KILO_GUARDIAN: undefined,
      KILO_PROCESS_GUARDIAN: undefined,
    })
    try {
      // The wait stays inside the scope so teardown cannot kill the pty
      // before the recorder runs.
      const program = Effect.gen(function* () {
        const svc = yield* Pty.Service
        yield* svc.create({
          command: "/bin/sh",
          args: ["-c", "echo pty-birth-ok; exit 0"],
          cwd: os.tmpdir(),
          env: { TERM: "xterm-256color" },
        })
        const done = yield* Effect.promise(async () => {
          const end = Date.now() + 15000
          while (!fs.existsSync(doneFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
          return fs.existsSync(doneFile)
        })
        if (!done) return yield* Effect.fail(new Error("recorder never ran"))
        return fs.readFileSync(argsFile, "utf8").split("\n")
      }).pipe(Effect.scoped, Effect.provide(ptyLayer))
      const lines = await Effect.runPromise(program)
      const at = lines.indexOf("--parent-birth")
      expect(at).toBeGreaterThan(-1)
      const birth = lines[at + 1] ?? ""
      const want = birthOf(process.pid) ?? ""
      expect(want).not.toBe("")
      expect(birth).toBe(want)
      expect(lines.includes("--parent-pid")).toBeTrue()
    } finally {
      restore()
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})
