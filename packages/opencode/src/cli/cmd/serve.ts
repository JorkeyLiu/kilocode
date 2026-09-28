import { Effect } from "effect"
import { CliError, effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "@opencode-ai/core/database/database" // kilocode_change - crash convergence sweep
import { SessionOperation } from "@opencode-ai/core/session/operation" // kilocode_change - crash convergence sweep
import { SessionGeneration } from "@opencode-ai/core/session/generation" // kilocode_change - generation owner sweep
import { InstanceRuntime } from "../../project/instance-runtime" // kilocode_change
import { startParentWatchdog } from "../../kilocode/parent-watchdog" // kilocode_change
import { createShutdownCoordinator, startSignalShutdown } from "../../kilocode/shutdown-coordinator" // kilocode_change
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

// kilocode_change start - crash convergence pre-bind gate (fail-closed, testable)
// Runs BEFORE Server.listen bind on the canonical Database.Service (same
// memoMap lease+marker gate as the listener). A single invalid in-flight row
// never fabricates a terminal; the gate refuses listener startup with a safe
// opId/count message (no detail/stack/secret). Scans prompt + provider +
// cancelQueued in-flight rows under the one gate: prompt rows converge with
// revision + `changed` + `generation`, provider rows with exactly one
// revision + `changed` (never `generation`, never recovery fields),
// cancelQueued rows converge to terminal `ambiguous` (result unknown, never
// `succeeded`) with exactly one revision + `changed` and no repeated side
// effect. Extracted so tests can inject listener creation and prove no bind
// until the sweep completes.
export const runCrashConvergenceGate = (
  db: Database.Interface["db"],
): Effect.Effect<SessionOperation.ConvergeOrphanedSummary, CliError> =>
  SessionOperation.convergeOrphanedInFlight(db).pipe(
    Effect.mapError((f: unknown) => {
      const rec = f as Partial<SessionOperation.ConvergeOrphanedFailure> | undefined
      const opIds = Array.isArray(rec?.opIds) ? (rec?.opIds as string[]) : []
      const count = typeof rec?.count === "number" ? (rec?.count as number) : opIds.length
      const conv = Array.isArray(rec?.converged) ? (rec?.converged as string[]).length : 0
      const raced = Array.isArray(rec?.raced) ? (rec?.raced as string[]).length : 0
      const list = opIds.length > 0 ? ` (opIds: ${opIds.slice(0, 10).join(", ")}${opIds.length > 10 ? "…" : ""})` : ""
      return new CliError({
        message: `[kilo serve] operation crash convergence failed: ${count} invalid in-flight operations require manual recovery${list}; valid ${conv} converged, ${raced} raced. Refusing listener startup to avoid silent replay.`,
        exitCode: 1,
      })
    }),
    Effect.catchDefect(
      () =>
        Effect.fail(
          new CliError({
            message:
              "[kilo serve] operation crash convergence failed with internal error; refusing listener startup to avoid silent replay.",
            exitCode: 1,
          }),
        ) as Effect.Effect<never, CliError>,
    ),
  )

export const gateThenListen = <T>(
  db: Database.Interface["db"],
  listen: () => Promise<T>,
): Effect.Effect<{ sweep: SessionOperation.ConvergeOrphanedSummary; generation: SessionGeneration.ConvergeSummary; server: T }, CliError> =>
  Effect.gen(function* () {
    const sweep = yield* runCrashConvergenceGate(db)
    const generation = yield* runGenerationConvergenceGate(db)
    const server = yield* Effect.promise(() => listen())
    return { sweep, generation, server }
  })

export const runGenerationConvergenceGate = (
  db: Database.Interface["db"],
): Effect.Effect<SessionGeneration.ConvergeSummary, CliError> =>
  SessionGeneration.convergeOrphaned(db).pipe(
    Effect.mapError((f: unknown) => {
      const rec = f as Partial<SessionGeneration.ConvergeFailure> | undefined
      const opIds = Array.isArray(rec?.opIds) ? (rec?.opIds as string[]) : []
      const count = typeof rec?.count === "number" ? (rec?.count as number) : opIds.length
      const conv = Array.isArray(rec?.converged) ? (rec?.converged as string[]).length : 0
      const raced = Array.isArray(rec?.raced) ? (rec?.raced as string[]).length : 0
      const list = opIds.length > 0 ? ` (genIds: ${opIds.slice(0, 10).join(", ")}${opIds.length > 10 ? "…" : ""})` : ""
      return new CliError({
        message: `[kilo serve] generation crash convergence failed: ${count} invalid generation owners require manual recovery${list}; valid ${conv} converged, ${raced} raced. Refusing listener startup to avoid silent replay.`,
        exitCode: 1,
      })
    }),
    Effect.catchDefect(
      () =>
        Effect.fail(
          new CliError({
            message:
              "[kilo serve] generation crash convergence failed with internal error; refusing listener startup to avoid silent replay.",
            exitCode: 1,
          }),
        ) as Effect.Effect<never, CliError>,
    ),
  )
// kilocode_change end

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless kilo server",
  // Server loads instances per-request via x-kilo-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false, // kilocode_change
  handler: Effect.fn("Cli.serve")(function* (args) {
    P0Perf.mark("serve_cli_entry", { id: String(process.pid) }) // kilocode_change - P0 instrumentation
    const modTimer = P0Perf.span("server_module_import") // kilocode_change - P0 instrumentation
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    modTimer.end()
    if (Flag.KILO_PRIVATE_RUNTIME) {
      const pwd = process.env.KILO_SERVER_PASSWORD ?? Flag.KILO_SERVER_PASSWORD
      if (!pwd) return yield* Effect.die(new Error("KILO_PRIVATE_RUNTIME requires KILO_SERVER_PASSWORD"))
    } else if (!Flag.KILO_SERVER_PASSWORD) {
      console.log("Warning: KILO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const netTimer = P0Perf.span("resolve_network_options") // kilocode_change - P0 instrumentation
    const opts = yield* resolveNetworkOptions(args)
    netTimer.end()
    // kilocode_change start - crash convergence pre-bind gate: a dead runtime
    // leaves accepted prompt + provider + cancelQueued in-flight rows with no live owner. The fresh boot
    // owns no volatile generation or provider state by construction, so converge the
    // durable rows once via the same CAS terminalization (prompt: abandoned with
    // revision + changed + generation; provider: abandoned with exactly one
    // revision + changed, never generation, never recovery; cancelQueued:
    // ambiguous with exactly one revision + changed, never generation, never
    // recovery, never repeated side effect) BEFORE Server.listen bind on the canonical
    // Database.Service (same memoMap lease+marker gate as the listener).
    // Fail-closed: invalid rows refuse listener startup; never post-bind
    // re-sweep (a post-bind sweep could misjudge a newly accepted prompt as
    // orphan).
    const { db } = yield* Database.Service
    const { sweep, generation, server } = yield* gateThenListen(db, () => Server.listen(opts))
    if (sweep.converged.length > 0) {
      console.log(
        `[kilo serve] converged ${sweep.converged.length} orphaned operations (${sweep.raced.length} raced)`,
      )
    }
    if (generation.converged.length > 0) {
      console.log(
        `[kilo serve] converged ${generation.converged.length} orphaned generations (${generation.raced.length} raced)`,
      )
    }
    // kilocode_change end

    // kilocode_change start - port-first: publish the bound port immediately
    // so server-manager parseServerPort captures it without waiting for the
    // fd carrier. Carrier init/ready below never blocks this line. The sweep
    // above already completed pre-bind, so no post-bind orphan misjudgment.
    const urls = server.urls

    console.log(`kilo server listening on ${urls.bind}`)
    if (urls.local !== urls.bind) console.log(`  Local:   ${urls.local}`)
    if (urls.network) console.log(`  Network: ${urls.network}`)
    P0Perf.mark("port_announced", { id: String(process.pid) }) // kilocode_change - P0 instrumentation
    // kilocode_change end

    // kilocode_change start - fd3/fd4 private carrier (no stdout framing)
    // Ownership: `carrierSettled` is the explicitly held ready-wait promise
    // for the single live handle. Both the steady-state join below and the
    // coordinator shutdown join the same promise, so shutdown never releases
    // server/fd before init settles and no detached work escapes.
    let fdCarrier: { dispose: () => void } | null = null
    let carrierSettled: Promise<{ status: string; err?: unknown } | null> | null = null
    try {
      const mod = yield* Effect.promise(
        () => import("../../kilocode/server/fd-carrier") as Promise<typeof import("../../kilocode/server/fd-carrier")>,
      )
      const candidate = mod.tryStartFdCarrier()
      if (candidate) {
        // Bounded registry readiness: `awaitCarrierReady` warns and disposes
        // the started carrier on install failure or timeout, then serve
        // continues carrier-less with the HTTP port already published. A
        // late install completion reconciles through the carrier state
        // machine (exact release + notify).
        const waitTimer = P0Perf.span("fd_carrier_wait") // kilocode_change - P0 instrumentation
        carrierSettled = mod.awaitCarrierReady(candidate).then(
          (result) => {
            waitTimer.end({ meta: { status: result.status } })
            if (result.status === "ready") fdCarrier = candidate
            return result
          },
          (err: unknown) => {
            waitTimer.end({ meta: { status: "error" } })
            console.warn("[kilo serve] fd carrier ready wait failed:", String(err))
            fdCarrier = null
            return { status: "failed" as const, err }
          },
        )
      }
    } catch (err) {
      console.warn("[kilo serve] fd carrier start failed:", String(err))
      carrierSettled = null
      fdCarrier = null
    }
    // kilocode_change end

    // kilocode_change start - graceful signal shutdown
    // The coordinator is constructed before the watchdog and signal handlers
    // are started so no callback captures an uninitialized binding. Signals
    // stay armed across the bounded carrier join below, so SIGTERM during
    // carrier init still funnels into the same idempotent shutdown, which
    // joins `carrierSettled` before disposing server/fd.
    const shutdownDone: Promise<void> = (() => {
      let stopWatchdog: () => void = () => {}
      let stopSignals: () => void = () => {}
      let complete: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        complete = resolve
      })
      const coordinator = createShutdownCoordinator({
        shutdown: async () => {
          // Join the explicitly held carrier wait first: shutdown never
          // releases server/fd before init settles. `awaitCarrierReady`
          // already disposes on failed/timeout, so only a ready carrier is
          // disposed here; the chained promise also published `fdCarrier`.
          if (carrierSettled) {
            try {
              await carrierSettled
            } catch (err) {
              console.warn("[kilo serve] fd carrier join failed:", String(err))
            }
          }
          try {
            fdCarrier?.dispose()
          } catch (err) {
            console.warn("[kilo serve] fd carrier dispose failed:", String(err))
          }
          try {
            const mod = await import("../../kilocode/server/fd-carrier")
            await mod.awaitPeerClosedHandoffs()
          } catch (err) {
            // Handoff join is best-effort; service shutdown still
            // releases fences without rebooting.
            console.warn("[kilo serve] lifecycle handoff join failed:", String(err))
          }
          try {
            const mod = await import("../../kilocode/server/fd-carrier")
            await mod.shutdownFileConvergence()
          } catch (err) {
            console.warn("[kilo serve] file convergence shutdown failed:", String(err))
          }
          await InstanceRuntime.disposeAllInstances()
          await server.stop(true)
        },
        onComplete: () => {
          stopWatchdog()
          stopSignals()
          complete()
        },
      })
      // The watchdog stays active until shutdown settles, so an orphaned
      // backend cannot outlive disposal; the coordinator's referenced
      // hard-stop timer then bounds shutdown to the extension-side 5s grace.
      // The hard-stop is a JS timer: it bounds async disposal hangs (a
      // pending promise that never settles) but cannot preempt a synchronous
      // event-loop stall, which blocks the timer from ever firing.
      stopWatchdog = startParentWatchdog(() => coordinator.begin())
      // Signals funnel into the same idempotent coordinator as the watchdog;
      // completion removes the listeners so the process carries no signal
      // listener residue into its final teardown.
      stopSignals = startSignalShutdown(() => coordinator.begin())
      return done
    })()
    // Steady-state join: the port is already published above; this bounded
    // wait only completes carrier registration before idling. Shutdown joins
    // the same held promise, so no path leaks detached work.
    const settled = carrierSettled
    if (settled) {
      yield* Effect.promise(() => settled.then(
        () => undefined,
        () => undefined,
      ))
    }
    yield* Effect.promise(() => shutdownDone)
    // kilocode_change end
  }),
})
