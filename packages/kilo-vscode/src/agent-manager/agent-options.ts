import type { CanonicalConfigService } from "../config/service"
import type { KiloProviderOptions, PrivateSessionReader } from "../kilo-provider/options"
import { PLATFORM, SNAPSHOT_INITIALIZATION } from "./constants"

/**
 * Vscode-free Agent Manager provider options. Single handoff for the
 * non-owning private session projection: present only when a reader exists.
 */
export function agentOptions(
  canonical: CanonicalConfigService,
  reader?: PrivateSessionReader | null,
): KiloProviderOptions {
  return {
    platform: PLATFORM,
    snapshotInitialization: SNAPSHOT_INITIALIZATION,
    slimEditMetadata: true,
    disableViewedRegistration: true,
    canonicalConfig: canonical,
    ...(reader ? { privateSessionReader: reader } : {}),
  }
}
