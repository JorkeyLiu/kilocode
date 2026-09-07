import type { PrivateObservationService } from "../private-worker/private-observation-service"
import type { PrivateObservationLifecycleTriggers } from "../private-worker/private-observation-lifecycle-triggers"
import type { AgentManagerProvider } from "./AgentManagerProvider"

/**
 * Wire the bounded peer-close lifecycle into the provider.
 *
 * Installs `service.setOnPeerClosed` before `service.initialize()` is called,
 * so an immediate peer close after initialize starts is not lost. The callback
 * awaits `triggers.onPeerClosed()` (one bounded reconnect+read) and forwards
 * its `TriggerResult` to `provider.handlePeerCloseObservation` with
 * fail-closed logging and no empty catch.
 */
export function wirePeerCloseObservation(
  service: PrivateObservationService,
  triggers: PrivateObservationLifecycleTriggers,
  provider: AgentManagerProvider,
): void {
  service.setOnPeerClosed(() => {
    void (async () => {
      let result: Awaited<ReturnType<typeof triggers.onPeerClosed>> | undefined
      try {
        result = await triggers.onPeerClosed()
      } catch (err) {
        console.warn("[Kilo] privateObservation peer-close trigger failed:", err)
        result = undefined
      }
      try {
        await provider.handlePeerCloseObservation(result)
      } catch (e) {
        console.warn("[Kilo] peer-close observation handling failed:", e)
      }
    })()
  })
}
