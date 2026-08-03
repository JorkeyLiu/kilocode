/**
 * Path-aware config patch helpers used to build the immediate save
 * acknowledgement from successful PATCH responses (LOCK-003): deep merge keeps
 * siblings, unset paths remove keys, and nulls are stripped like the backend.
 * This module is extension-side; the webview has its own copies in
 * webview-ui/src/utils/config-utils.ts because the two builds are separate.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Deep merge `patch` into `target`. Nested objects merge recursively so
 * siblings in the base config survive a partial save patch.
 */
export function deepMergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMergePatch(result[key] as Record<string, unknown>, value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Remove keys by path, pruning parents that become empty so the ack does not
 * claim values the save unset.
 */
export function unsetPathValues(value: Record<string, unknown>, paths: string[][]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value }
  for (const path of paths) deleteAt(result, path)
  return result
}

function deleteAt(value: Record<string, unknown>, path: string[]): void {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    delete value[head]
    return
  }
  const next = value[head]
  if (!isRecord(next)) return
  deleteAt(next, rest)
  if (Object.keys(next).length === 0) delete value[head]
}

/**
 * Recursively strip null/undefined (null = deleted), preserving schema-valid
 * indexing model/dimension null overrides just like the backend overlay does.
 */
export function stripNullPatch(value: Record<string, unknown>, prefix: string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const path = [...prefix, key]
    if (item === null || item === undefined) {
      const isIndexingOverride =
        path.length === 2 && path[0] === "indexing" && (path[1] === "model" || path[1] === "dimension")
      if (!isIndexingOverride) continue
    }
    if (isRecord(item)) {
      result[key] = stripNullPatch(item, path)
    } else {
      result[key] = item
    }
  }
  return result
}
