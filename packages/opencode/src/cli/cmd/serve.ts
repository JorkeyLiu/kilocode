import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstanceRuntime } from "../../project/instance-runtime" // kilocode_change
import { startParentWatchdog } from "../../kilocode/parent-watchdog" // kilocode_change
import { createShutdownCoordinator, startSignalShutdown } from "../../kilocode/shutdown-coordinator" // kilocode_change
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

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
    if (!Flag.KILO_SERVER_PASSWORD) {
      console.log("Warning: KILO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const netTimer = P0Perf.span("resolve_network_options") // kilocode_change - P0 instrumentation
    const opts = yield* resolveNetworkOptions(args)
    netTimer.end()
    const server = yield* Effect.promise(() => Server.listen(opts))

    // kilocode_change start - fd3/fd4 private carrier (no stdout framing)
    let fdCarrier: { dispose: () => void } | null = null
    try {
      const mod = yield* Effect.promise(
        () => import("../../kilocode/server/fd-carrier") as Promise<typeof import("../../kilocode/server/fd-carrier")>,
      )
      const started = mod.tryStartFdCarrier()
      if (started) {
        // Bounded registry readiness: `awaitCarrierReady` warns and disposes
        // the started carrier on install failure or timeout, then serve
        // continues carrier-less and still publishes the HTTP port below. A
        // late install completion reconciles through the carrier state
        // machine (exact release + notify).
        const waitTimer = P0Perf.span("fd_carrier_wait") // kilocode_change - P0 instrumentation
        const result = yield* Effect.promise(() => mod.awaitCarrierReady(started))
        waitTimer.end({ meta: { status: result.status } })
        if (result.status === "ready") fdCarrier = started
      }
    } catch (err) {
      console.warn("[kilo serve] fd carrier start failed:", String(err))
      fdCarrier = null
    }
    // kilocode_change end

    // kilocode_change start
    const urls = server.urls

    console.log(`kilo server listening on ${urls.bind}`)
    if (urls.local !== urls.bind) console.log(`  Local:   ${urls.local}`)
    if (urls.network) console.log(`  Network: ${urls.network}`)
    // kilocode_change end

    // kilocode_change start - graceful signal shutdown
    // yield* Effect.never
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          // Exit if the editor client that spawned us is hard-killed (no signal reaches us).
          // The coordinator is constructed before the watchdog and signal
          // handlers are started so no callback captures an uninitialized
          // binding — the orphan and signal callbacks close over `coordinator`
          // only after it exists, and both disposers start as no-ops and are
          // assigned before any signal, interval tick, or shutdown completion
          // can reach them.
          let stopWatchdog: () => void = () => {}
          let stopSignals: () => void = () => {}
          const coordinator = createShutdownCoordinator({
            shutdown: async () => {
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
              resolve()
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
        }),
    )
    // kilocode_change end
  }),
})
