// kilocode_change - sticky custom-fallback takeover for Kilo rate-limit 429s.
//
// A session takes over to the single active custom fallback channel only when
// every gate holds:
// - the attempted primary provider is Kilo,
// - the session already completed a Kilo provider turn before this turn,
// - same-channel retries are exhausted (caller only invokes after the retry
//   schedule terminates),
// - the terminal error is an ordinary retryable 429 (not quota/auth/invalid),
// - no text/reasoning/tool output was exposed,
// - an active valid custom fallback target exists.
//
// On takeover success the caller persists a session-level sticky target; later
// turns resolve the sticky target instead of the requested Kilo model and fail
// closed when the sticky provider/model was removed.
import { Data, Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { parseFallbackModelRef } from "@opencode-ai/core/kilocode/canonical-record"
import { isKiloError } from "@/kilocode/kilo-errors"
import type { Err } from "@/session/retry"
import { isRecord } from "@/util/record"

export namespace KiloSessionFallback {
  export type Target = {
    readonly providerID: string
    readonly modelID: string
  }

  export type PriorMsg = {
    readonly info: {
      readonly role: string
      readonly id: string
      readonly providerID?: string
      readonly finish?: string
      readonly error?: unknown
    }
  }

  export class StaleTargetError extends Data.TaggedError("KiloSessionFallbackStaleTarget")<{
    readonly providerID: string
    readonly modelID: string
  }> {}

  /** Parse a "provider/model" selection into a fallback target. */
  export function parse(value: unknown): Target | undefined {
    return parseFallbackModelRef(value)
  }

  /** Read the single active fallback target from loaded config. */
  export function active(cfg: { fallback_model?: string | null }): Target | undefined {
    return parse(cfg.fallback_model ?? undefined)
  }

  /** Takeover applies only when the attempted primary provider is Kilo. */
  export function kilo(providerID: string): boolean {
    return providerID === ProviderV2.ID.kilo
  }

  const QUOTA_MARKERS = [
    "quota",
    "exceed",
    "insufficient",
    "billing",
    "freeusagelimit",
    "promotion_model_limit",
    "paid_model_auth",
  ]

  const AUTH_INVALID_MARKERS = [
    "unauthorized",
    "invalid_request",
    "invalid model",
    "model_not_found",
    "model not found",
    "authentication",
    "forbidden",
  ]

  function haystack(error: Err): string {
    if (!isRecord(error.data)) return ""
    const data = error.data as Record<string, unknown>
    const message = typeof data.message === "string" ? data.message : ""
    const body = typeof data.responseBody === "string" ? data.responseBody : ""
    return `${message}\n${body}`.toLowerCase()
  }

  /**
   * Ordinary retryable rate-limit 429 only: exact 429 status, retryable flag,
   * no Kilo product error, and no quota/auth/invalid-request signal in the
   * message or response body. Bodies are matched, never returned or logged.
   */
  export function ordinary(error: Err): boolean {
    if (error.name !== "APIError") return false
    if (!isRecord(error.data)) return false
    const data = error.data as Record<string, unknown>
    if (data.statusCode !== 429) return false
    if (data.isRetryable !== true) return false
    if (isKiloError(error)) return false
    const hay = haystack(error)
    for (const marker of QUOTA_MARKERS) {
      if (hay.includes(marker)) return false
    }
    for (const marker of AUTH_INVALID_MARKERS) {
      if (hay.includes(marker)) return false
    }
    return true
  }

  /**
   * At least one finished, error-free Kilo assistant turn other than the
   * current in-flight message. The current attempt's failed/in-flight
   * operation can never count because only finished assistant messages with
   * a different id qualify.
   */
  export function prior(msgs: Iterable<PriorMsg>, currentID: string): boolean {
    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      if (msg.info.id === currentID) continue
      if (msg.info.providerID !== ProviderV2.ID.kilo) continue
      if (!msg.info.finish) continue
      if (msg.info.error) continue
      return true
    }
    return false
  }

  /**
   * Full takeover gate. Returns the fallback target when every condition
   * holds, otherwise undefined and the caller preserves existing failure
   * behavior. Retry exhaustion is established by the caller invoking this
   * only after the same-channel retry schedule terminates.
   */
  export function check(input: {
    primaryProviderID: string
    active: Target | undefined
    error: Err
    priorKilo: boolean
    exposed: boolean
  }): Target | undefined {
    if (!kilo(input.primaryProviderID)) return undefined
    if (!input.priorKilo) return undefined
    if (input.exposed) return undefined
    if (!ordinary(input.error)) return undefined
    return input.active
  }

  export function removed(target: Target): string {
    return (
      `Custom fallback unavailable: ${target.providerID}/${target.modelID} was removed or renamed. ` +
      `Update the session fallback or clear it to route explicitly; the session will not silently return to Kilo.`
    )
  }

  /**
   * Session turn routing. Without a sticky takeover the requested model
   * resolves unchanged. With one, the sticky target resolves instead even
   * when the request still names Kilo, and a removed sticky target fails
   * with an explicit StaleTargetError instead of routing back to Kilo. A
   * changed global active selection never alters an existing sticky target
   * because the sticky target is the only input used here.
   */
  export function turn(input: {
    sticky: Target | undefined
    requested: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    resolve: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Provider.Model, never>
  }): Effect.Effect<Provider.Model, StaleTargetError> {
    const sticky = input.sticky
    if (!sticky) return input.resolve(input.requested.providerID, input.requested.modelID)
    const pid = ProviderV2.ID.make(sticky.providerID)
    const mid = ModelV2.ID.make(sticky.modelID)
    // Resolution failures are defects (the resolver dies on missing models),
    // so catch the full cause: any resolution failure means the sticky target
    // is gone. Interrupts still propagate untouched.
    return input
      .resolve(pid, mid)
      .pipe(
        Effect.catchCause(() =>
          Effect.fail(new StaleTargetError({ providerID: sticky.providerID, modelID: sticky.modelID })),
        ),
      )
  }
}
