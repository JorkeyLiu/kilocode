import type { CanonicalConfigService } from "../config/service"

export interface PrivateSessionReader {
  isEnabled(): boolean
  isStarted(): boolean
  list(input: { directory: string; archived?: boolean; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<unknown>
  get(input: { directory: string; sessionId: string; signal?: AbortSignal }): Promise<unknown>
  messages?(input: { directory: string; sessionId: string; limit: number; cursor?: string; signal?: AbortSignal }): Promise<unknown>
  operations?(input: { directory: string; sessionId: string; limit?: number; signal?: AbortSignal }): Promise<unknown>
}

/** Legacy alias — prefer PrivateSessionReader. */
export type PrivateSessionList = PrivateSessionReader

export type KiloProviderOptions = {
  projectDirectory?: string | null
  platform?: string
  snapshotInitialization?: "wait"
  slimEditMetadata?: boolean
  tabTitle?: (title: string) => void
  /** Composite hosts (Agent Manager) own viewed/presence registration themselves. */
  disableViewedRegistration?: boolean
  /** Non-owning private session projection; KiloProvider never owns lifecycle. */
  privateSessionList?: PrivateSessionReader
  /** Preferred alias for privateSessionList — same non-owning projection. */
  privateSessionReader?: PrivateSessionReader
  /** Canonical GUI authority for config, custom providers, and agents. */
  canonicalConfig?: CanonicalConfigService
}
