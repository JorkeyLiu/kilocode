import { fetchAgentsPrivateFirst } from "./agent-list-privatefirst"
import { fetchProviderCatalogPrivateFirst } from "./provider-catalog-privatefirst"

export type FixtureVariantRawProvider = { id?: unknown; name?: unknown; hasCredential?: unknown; models?: unknown }
export type FixtureVariantInjected = { id: string; name: string; variants: Record<string, unknown> }
export type FixtureVariantSelection = { providerID: string; modelID: string }
export type FixtureVariantRealState = {
  raw: Record<string, FixtureVariantRawProvider>
  connected: string[]
  defaults: Record<string, string>
  selections: Record<string, FixtureVariantSelection>
  realAgents: Array<Record<string, unknown>>
}

/**
 * Fixture-only real catalog/agents read for `provisionVariantModelFixture`.
 * Same production sources as `provider-actions.fetchProviderData` and
 * `KiloProvider.fetchAndSendAgents` via the shared private-first helpers.
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside. Valid private results are authoritative with zero SDK;
 * validated terminal results close fail-soft to the existing empty baseline
 * with zero SDK; fallback-eligible outcomes take the helper's exactly-once
 * same-directory SDK fallback with no second private request. No persistence,
 * no post, no cache.
 */
export async function fetchFixtureVariantRealPrivateFirst(opts: {
  connection?: unknown
  client?: unknown
  directory: string
  providerID: string
  modelID: string
  injected: FixtureVariantInjected
}): Promise<FixtureVariantRealState> {
  const raw: Record<string, FixtureVariantRawProvider> = {}
  let connected: string[] = []
  let defaults: Record<string, string> = {}
  const selections: Record<string, FixtureVariantSelection> = {}
  let realAgents: Array<Record<string, unknown>> = []
  const dir = opts.directory
  const pid = opts.providerID
  const mid = opts.modelID
  const injected = opts.injected
  try {
    const catalog = await fetchProviderCatalogPrivateFirst({
      connection: opts.connection as never,
      client: opts.client as never,
      directory: dir,
    })
    if (catalog.kind === "ok") {
      const data = catalog.data
      connected = data.connected ?? []
      defaults = data.default ?? {}
      for (const item of data.all ?? []) {
        const p = item as { id?: string } & FixtureVariantRawProvider
        const key = p.id ?? ""
        const models = { ...((p.models as Record<string, unknown> | undefined) ?? {}), [mid]: injected }
        raw[key] = p.id === pid ? { ...p, models } : p
      }
    }
  } catch {
    // Fail soft to the existing empty baseline.
  }
  try {
    const agents = await fetchAgentsPrivateFirst({
      connection: opts.connection as never,
      client: opts.client as never,
      directory: dir,
    })
    if (agents.kind === "ok") {
      const list = (agents.agents ?? []) as unknown as Array<Record<string, unknown>>
      realAgents = list.filter((agent) => typeof (agent as { name?: unknown }).name === "string")
      for (const agent of realAgents) {
        const name = (agent as { name?: string }).name ?? ""
        if (name.length > 0) selections[name] = { providerID: pid, modelID: mid }
      }
    }
  } catch {
    // Fail soft to the existing empty baseline.
  }
  return { raw, connected, defaults, selections, realAgents }
}
