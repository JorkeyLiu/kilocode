import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { prepareCommand as prepareSandbox } from "@kilocode/sandbox" // kilocode_change
import { tap as tapStdio, tapped } from "./kilocode/stdio-tap" // kilocode_change - Bun drops buffered stdio on close
import { birthOf, groupMembers, owned as verifyOwned } from "./kilocode/process-birth" // kilocode_change - shared parent birth identity + F-E verified group teardown
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
  ) => {
    let stdout = proc.stdout
      ? NodeStream.fromReadable({
          evaluate: () => tapped(proc, "stdout"), // kilocode_change - read the spawn-time tap
          onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
        })
      : Stream.empty
    let stderr = proc.stderr
      ? NodeStream.fromReadable({
          evaluate: () => tapped(proc, "stderr"), // kilocode_change - read the spawn-time tap
          onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
        })
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout, stderr, all: Stream.merge(stdout, stderr) }
  }

  // kilocode_change - prelaunch guardian wrapper: the guardian is launched
  // INSTEAD of the target and owns cleanup before the target can run
  // (no after-spawn attach, no async poll gap). Command via
  // KILO_GUARDIAN_CMD JSON [cmd, ...base] (published by the serve entry
  // from KiloPtySelfCommand); core never imports opencode. Active only
  // with a valid KILO_RUNTIME_TOKEN; KILO_GUARDIAN=1 (inside a guardian)
  // or KILO_PROCESS_GUARDIAN=0 opts out. Fail closed: install
  // absent/invalid fails the spawn with no target side effect.
  const wrapActive = (): boolean => {
    if (globalThis.process.env["KILO_GUARDIAN"] === "1") return false
    if (globalThis.process.env["KILO_PROCESS_GUARDIAN"] === "0") return false
    if (globalThis.process.argv.includes("__process-guardian")) return false
    const token = globalThis.process.env["KILO_RUNTIME_TOKEN"]
    return typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
  }

  const guardianBase = (): Array<string> | undefined => {
    try {
      const raw = globalThis.process.env["KILO_GUARDIAN_CMD"]
      if (!raw) return undefined
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return undefined
      if (!parsed.every((x) => typeof x === "string")) return undefined
      return parsed as Array<string>
    } catch {
      return undefined
    }
  }

  const b64url = (text: string): string =>
    Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

  // kilocode_change - every wrapper carries the owner birth identity;
  // unobtainable birth fails closed (undefined -> no argv -> no target).
  const wrapArgv = (target: { cmd: string; args: readonly string[]; shell?: boolean | string; extraFds: number[] }): Array<string> | undefined => {
    const base = guardianBase()
    if (!base) return undefined
    const birth = birthOf(globalThis.process.pid)
    if (!birth) return undefined
    const token = globalThis.process.env["KILO_RUNTIME_TOKEN"]
    const oracle = typeof token === "string" ? `KILO_RUNTIME_TOKEN=${token}` : undefined
    return [
      ...base.slice(1),
      "__process-guardian",
      "--cmd-b64",
      b64url(JSON.stringify({ cmd: target.cmd, args: target.args, shell: target.shell ?? false, extraFds: target.extraFds })),
      "--parent-pid",
      String(globalThis.process.pid),
      "--parent-birth",
      birth,
      ...(oracle ? ["--token", oracle] : []),
    ]
  }

  const guardianCmdFor = (target: { cmd: string; args: readonly string[]; shell?: boolean | string; extraFds: number[] }): { cmd: string; args: string[] } | undefined => {
    const base = guardianBase()
    const argv = wrapArgv(target)
    if (!base || !argv) return undefined
    return { cmd: base[0]!, args: argv }
  }

  // kilocode_change (F-E) - ownership registry: wrapped procs are signalled
  // via the guardian PID ONLY for TERM/INT (never a negative-pid group
  // kill, never taskkill /T); the guardian owns bounded tree cleanup and
  // its exit proves descendants are dead. Forced SIGKILL escalates to the
  // WHOLE owned tree only after independent verification (retained handle
  // alive + same birth + pgid === pid); without proof it fails closed with
  // reason and never guesses a shared/dead group. Unwrapped procs keep
  // group-kill behavior.
  const registry = new WeakMap<NodeChildProcess.ChildProcess, { birth: string | undefined }>()
  const isOwned = (proc: NodeChildProcess.ChildProcess): boolean => {
    try {
      return registry.has(proc)
    } catch {
      return false
    }
  }
  const birthFor = (proc: NodeChildProcess.ChildProcess): string | undefined => {
    try {
      return registry.get(proc)?.birth
    } catch {
      return undefined
    }
  }

  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitGone = async (pgid: number, ms = 3000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (groupMembers(pgid).length === 0) return true
      } catch {}
      await sleepMs(50)
    }
    try {
      return groupMembers(pgid).length === 0
    } catch {
      return false
    }
  }

  const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ExitSignal], PlatformError.PlatformError>((resume) => {
      const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
      // kilocode_change - prelaunch wrap: guardian instead of target.
      // stdio/env/cwd already mirror the target (built by spawnCommand
      // below); the guardian proxies them via inherit so behavior is
      // preserved and proc.pid is the real owned group leader.
      const start = (): NodeChildProcess.ChildProcess | undefined => {
        if (!wrapActive()) return launch(command.command, command.args, opts)
        const stdio = (opts.stdio ?? []) as Array<unknown>
        const extraFds: number[] = []
        for (let fd = 3; fd < stdio.length; fd++) {
          if (stdio[fd] !== undefined && stdio[fd] !== "ignore") extraFds.push(fd)
        }
        const shell = (opts as { shell?: boolean | string }).shell
        const wrapped = guardianCmdFor({ cmd: command.command, args: command.args, shell, extraFds })
        if (!wrapped) {
          resume(
            Effect.fail(
              toPlatformError(
                "spawn",
                Object.assign(
                  new Error("Process guardian unavailable: KILO_GUARDIAN_CMD absent or invalid; refusing to launch target without ownership"),
                  { code: "ENOENT" },
                ),
                command,
              ),
            ),
          )
          return undefined
        }
        try {
          const guardian = NodeChildProcess.spawn(wrapped.cmd, wrapped.args, {
            cwd: opts.cwd as string | undefined,
            env: opts.env as NodeJS.ProcessEnv | undefined,
            stdio: opts.stdio,
            detached: true,
            windowsHide: true,
          })
          try {
            const id = guardian.pid
            registry.set(guardian, { birth: typeof id === "number" ? birthOf(id) : undefined })
          } catch {
            try {
              registry.set(guardian, { birth: undefined })
            } catch {}
          }
          return guardian
        } catch (err) {
          resume(Effect.fail(toPlatformError("spawn", err as NodeJS.ErrnoException, command)))
          return undefined
        }
      }
      const proc = start()
      if (!proc) return Effect.sync(() => {})
      if (!proc.pid) {
        // Swallow the async 'error' of the failed spawn; the fail below
        // is the only signal.
        try {
          proc.on("error", () => {})
        } catch {}
        try {
          proc.kill("SIGKILL")
        } catch {}
        resume(
          Effect.fail(
            toPlatformError("spawn", Object.assign(new Error("Process guardian produced no pid, target not launched"), { code: "ENOENT" }), command),
          ),
        )
        return Effect.sync(() => {})
      }
      tapStdio(proc) // kilocode_change - must run in the same tick as spawn
      let end = false
      let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
      proc.on("error", (err) => {
        resume(Effect.fail(toPlatformError("spawn", err, command)))
      })
      proc.on("exit", (...args) => {
        exit = args
      })
      proc.on("close", (...args) => {
        if (end) return
        end = true
        Deferred.doneUnsafe(signal, Exit.succeed(exit ?? args))
      })
      proc.on("spawn", () => {
        resume(Effect.succeed([proc, signal]))
      })
      return Effect.sync(() => {
        proc.kill("SIGTERM")
      })
    })

  // kilocode_change (F-E) - exact guardian signal: PID only for TERM/INT,
  // so the guardian's bounded cleanup runs to completion and its exit
  // (awaited by callers) proves the tree is dead. POSIX SIGKILL to an
  // owned guardian escalates to the WHOLE owned tree only after
  // independent verification (retained handle alive + same birth + pgid
  // === pid); without proof it fails closed (PID best-effort, then fail
  // with reason, never a guessed shared/dead group). Win32 stays PID-only
  // (KILL_ON_CLOSE job owns the tree; no on-platform group claim here).
  const killOwnedPid = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.try({
      try: () => {
        if (!proc.pid) throw new Error("Process guardian has no pid")
        globalThis.process.kill(proc.pid, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })

  const killOwned = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      if (globalThis.process.platform === "win32") return killOwnedPid(command, proc, signal)
      if (signal !== "SIGKILL") return killOwnedPid(command, proc, signal)
      const pid = proc.pid
      if (!pid) {
        return Effect.fail(
          toPlatformError("kill", new Error("Owned guardian has no pid; cannot verify owned group, tree may survive"), command),
        )
      }
      const check = verifyOwned(pid, birthFor(proc))
      if (check.ok) {
        const pgid = check.pgid
        return Effect.suspend(() => {
          try {
            globalThis.process.kill(-pgid, signal)
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code
            if (code !== "ESRCH") return Effect.fail(toPlatformError("kill", toError(err), command))
          }
          return Effect.void
        })
      }
      try {
        globalThis.process.kill(pid, "SIGKILL")
      } catch {}
      return Effect.fail(
        toPlatformError(
          "kill",
          new Error(`Owned guardian group unverified (${check.reason}); PID SIGKILL best-effort only, tree may survive`),
          command,
        ),
      )
    })

  const drainOwned = (
    command: ChildProcess.StandardCommand,
    signal: ExitSignal,
    pgid: number | undefined,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      if (pgid === undefined) return Deferred.await(signal).pipe(Effect.asVoid)
      return Deferred.await(signal).pipe(
        Effect.flatMap(() =>
          Effect.promise(() => waitGone(pgid)).pipe(
            Effect.flatMap((gone) =>
              gone
                ? Effect.void
                : Effect.fail(
                    toPlatformError("kill", new Error(`Owned group ${pgid} survived SIGKILL; retaining authority, tree may survive`), command),
                  ),
            ),
          ),
        ),
      )
    })

  const killOwnedFinal = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: ExitSignal,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      if (globalThis.process.platform === "win32") {
        return killOwnedPid(command, proc, "SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
      }
      const pid = proc.pid
      if (!pid) {
        return Effect.fail(
          toPlatformError("kill", new Error("Owned guardian has no pid; cannot verify owned group, tree may survive"), command),
        )
      }
      const check = verifyOwned(pid, birthFor(proc))
      if (!check.ok) {
        try {
          globalThis.process.kill(pid, "SIGKILL")
        } catch {}
        return Deferred.await(signal).pipe(
          Effect.andThen(
            Effect.fail(toPlatformError("kill", new Error(`Owned guardian group unverified (${check.reason}); PID SIGKILL best-effort only, tree may survive`), command)),
          ),
        )
      }
      const pgid = check.pgid
      const send: Effect.Effect<void, PlatformError.PlatformError> = Effect.suspend(() => {
        try {
          globalThis.process.kill(-pgid, "SIGKILL")
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code !== "ESRCH") return Effect.fail(toPlatformError("kill", toError(err), command))
        }
        return Effect.void
      })
      return send.pipe(Effect.andThen(drainOwned(command, signal, pgid)))
    })

  const doneOwned = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      if (globalThis.process.platform === "win32") return Effect.void
      const pid = proc.pid
      if (!pid) return Effect.void
      const rest = (() => {
        try {
          return groupMembers(pid)
        } catch {
          return []
        }
      })()
      if (rest.length === 0) return Effect.void
      return Effect.fail(
        toPlatformError("kill", new Error(`Owned guardian exited with ${rest.length} group member(s) still alive; retaining authority, no group guess`), command),
      )
    })

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) => {
    if (isOwned(proc)) return killOwned(command, proc, signal)
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          if (err) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-proc.pid!, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })
  }

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  const timeout =
    (
      proc: NodeChildProcess.ChildProcess,
      command: ChildProcess.StandardCommand,
      opts: ChildProcess.KillOptions | undefined,
    ) =>
    <A, E, R>(
      f: (
        command: ChildProcess.StandardCommand,
        proc: NodeChildProcess.ChildProcess,
        signal: NodeJS.Signals,
      ) => Effect.Effect<A, E, R>,
    ) => {
      const signal = opts?.killSignal ?? "SIGTERM"
      if (Predicate.isUndefined(opts?.forceKillAfter)) return f(command, proc, signal)
      return Effect.timeoutOrElse(f(command, proc, signal), {
        duration: opts.forceKillAfter,
        orElse: () => f(command, proc, "SIGKILL"),
      })
    }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const dir = yield* cwd(command.options)
          // kilocode_change start - prepare agent-scoped commands through the selected sandbox backend
          const target = yield* prepareSandbox(command, dir, env(command.options))
          const sin = stdin(target.options)
          const sout = stdio(target.options, "stdout")
          const serr = stdio(target.options, "stderr")
          const extra = fds(target.options)
          // kilocode_change end

          const [proc, signal] = yield* Effect.acquireRelease(
            // kilocode_change start - spawn the prepared command and options
            spawn(target, {
              cwd: dir,
              env: env(target.options),
              stdio: stdios(sin, sout, serr, extra),
              detached: target.options.detached ?? process.platform !== "win32",
              shell: target.options.shell,
              // kilocode_change end
              windowsHide: process.platform === "win32",
            }),
            Effect.fnUntraced(function* ([proc, signal]) {
              const done = yield* Deferred.isDone(signal)
              const kill = timeout(proc, command, target.options) // kilocode_change
              if (done) {
                // kilocode_change (F-E): owned exit proves the tree is dead
                // via guardian cleanup; never guess a group from a dead
                // leader. Retain authority (fail, no group kill) if members
                // still linger.
                if (isOwned(proc)) return yield* Effect.ignore(doneOwned(command, proc))
                const [code] = yield* Deferred.await(signal)
                if (process.platform === "win32") return yield* Effect.void
                if (code !== 0 && Predicate.isNotNull(code)) return yield* Effect.ignore(kill(killGroup))
                return yield* Effect.void
              }
              const send = (s: NodeJS.Signals) => {
                if (isOwned(proc) && s === "SIGKILL" && globalThis.process.platform !== "win32") return killOwned(command, proc, s)
                return Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              }
              // kilocode_change start - preserve kill options from the prepared command
              const sig = target.options.killSignal ?? "SIGTERM"
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              const escalated = target.options.forceKillAfter
                ? Effect.timeoutOrElse(attempt, {
                    duration: target.options.forceKillAfter,
                    orElse: () =>
                      isOwned(proc)
                        ? killOwnedFinal(command, proc, signal)
                        : send("SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid),
                  })
                : attempt
              // kilocode_change end
              return yield* Effect.ignore(escalated)
            }),
          )

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(signal), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(signal), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts?: ChildProcess.KillOptions) => {
              const sig = opts?.killSignal ?? "SIGTERM"
              const ownedFinal = isOwned(proc) && globalThis.process.platform !== "win32"
              if (ownedFinal && sig === "SIGKILL") return killOwnedFinal(command, proc, signal)
              const send = (s: NodeJS.Signals) => {
                if (isOwned(proc) && s === "SIGKILL" && globalThis.process.platform !== "win32") return killOwned(command, proc, s)
                return Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              }
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              if (!opts?.forceKillAfter) return attempt
              return Effect.timeoutOrElse(attempt, {
                duration: opts.forceKillAfter,
                orElse: () =>
                  isOwned(proc) ? killOwnedFinal(command, proc, signal) : send("SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid),
              })
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

export const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))

export * as CrossSpawnSpawner from "./cross-spawn-spawner"
