import { iconNames, type IconName } from "@opencode-ai/ui/icons/provider"
import type { Provider } from "../../types/messages"

export const CUSTOM_PROVIDER_ID = "_custom"

function validIcon(id: string | undefined): IconName | undefined {
  if (!id) return undefined
  if (iconNames.includes(id as IconName)) return id as IconName
  return undefined
}

export function providerIcon(provider: Provider | string): IconName {
  const providerID = typeof provider === "string" ? provider : provider.id
  const icon = typeof provider === "string" ? undefined : validIcon(provider.metadata?.icon)
  if (icon) return icon
  const fallback = validIcon(providerID)
  if (fallback) return fallback
  return "synthetic"
}

export function providerNoteKey(provider: Provider | string) {
  if (typeof provider !== "string" && provider.metadata?.noteKey) return provider.metadata.noteKey
  return undefined
}

export function sortProviders(items: Provider[]) {
  return items.slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
