import type { ProviderAuthState } from "../../types/messages"
import type { Provider } from "../../types/messages"
import { KILO_PROVIDER_ID, createKiloFallbackProvider } from "../../../../src/shared/provider-model"

export function visibleConnectedIds(connected: string[], authStates: Record<string, ProviderAuthState>) {
  return connected.filter((id) => id !== KILO_PROVIDER_ID || authStates[KILO_PROVIDER_ID] !== undefined)
}

/**
 * Filter visible connected provider IDs to exclude Kilo and disabled providers.
 * This prevents a connected-but-disabled provider from appearing in both the
 * Connected and Disabled sections.
 */
export function connectedNonDisabledIds(
  connected: string[],
  authStates: Record<string, ProviderAuthState>,
  disabledIds: Set<string>,
) {
  return visibleConnectedIds(connected, authStates).filter((id) => id !== KILO_PROVIDER_ID && !disabledIds.has(id))
}

export function providersWithKiloFallback(providers: Record<string, Provider>): Record<string, Provider> {
  if (providers[KILO_PROVIDER_ID]) return providers
  return { [KILO_PROVIDER_ID]: createKiloFallbackProvider(), ...providers }
}
