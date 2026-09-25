import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AppProcess } from "@opencode-ai/core/process"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function testLayer(
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner(spawnHandler)))
  return Installation.layer.pipe(Layer.provide(appProcess))
}

describe("installation", () => {
  describe("method", () => {
    testEffect(
      testLayer((cmd) => {
        if (cmd === "npm") return "@kilocode/cli@7.3.45"
        return ""
      }),
    ).effect("detects npm installs from the Kilo package", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.method()
        expect(result).toBe("npm")
      }),
    )

    testEffect(testLayer(() => "")).effect("falls back to unknown when no manager matches", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.method()
        expect(result).toBe("unknown")
      }),
    )
  })

  describe("self-upgrade removal", () => {
    testEffect(testLayer()).effect("exposes no latest/upgrade/info facade", () =>
      Effect.gen(function* () {
        const svc = yield* Installation.Service
        expect("latest" in svc).toBe(false)
        expect("upgrade" in svc).toBe(false)
        expect("info" in svc).toBe(false)
        expect(typeof svc.method).toBe("function")
      }),
    )

    testEffect(testLayer()).effect("preserves version display metadata", () =>
      Effect.gen(function* () {
        expect(typeof InstallationVersion).toBe("string")
        expect(InstallationVersion.length).toBeGreaterThan(0)
        expect(typeof Installation.userAgent()).toBe("string")
        expect(Installation.userAgent()).toContain(InstallationVersion)
        expect(typeof Installation.isLocal()).toBe("boolean")
        expect(typeof Installation.isPreview()).toBe("boolean")
      }),
    )
  })
})
