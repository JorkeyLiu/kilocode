import type { Config } from "../types/messages"
import { getEntry } from "../../../src/config/registry"

export function splitConfigByScope(draft: Partial<Config>) {
  const global: Record<string, unknown> = {}
  const project: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(draft)) {
    const entry = getEntry(key)
    if (!entry) {
      global[key] = value
      continue
    }
    if (entry.scopes.length === 1 && entry.scopes[0] === "project") {
      project[key] = value
      continue
    }
    global[key] = value
  }
  return { global: global as Partial<Config>, project: project as Partial<Config> }
}
