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

/** Keys that must never be written through a patch path (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function safeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key)
}

/** Deep clone records/arrays, dropping prototype-pollution keys at every level. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!safeKey(key)) continue
      out[key] = cloneValue(item)
    }
    return out
  }
  return value
}

/**
 * Deep merge `patch` into `target`. Nested objects merge recursively so
 * siblings in the base config survive a partial save patch. Arrays and
 * scalars replace wholesale. Prototype-pollution keys are dropped.
 */
export function deepMergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (!safeKey(key)) continue
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
 * claim values the save unset. Prototype-pollution segments are ignored.
 */
export function unsetPathValues(value: Record<string, unknown>, paths: string[][]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value }
  for (const path of paths) deleteAt(result, path)
  return result
}

function deleteAt(value: Record<string, unknown>, path: string[]): void {
  const [head, ...rest] = path
  if (head === undefined || !safeKey(head)) return
  if (rest.length === 0) {
    delete value[head]
    return
  }
  if (!rest.every((seg) => safeKey(seg))) return
  const next = value[head]
  if (!isRecord(next)) return
  deleteAt(next, rest)
  if (Object.keys(next).length === 0) delete value[head]
}

/**
 * Compose one scope's service patch from the current authored document plus a
 * nested webview delta. Objects merge recursively (siblings survive), arrays
 * and scalars replace, and unset paths delete exactly their target leaf with
 * empty parents pruned. Only `isField` top-level keys are included; a touched
 * key left empty becomes `undefined` so the service deletes the key instead
 * of keeping stale file content. Malformed paths and
 * `__proto__`/`constructor`/`prototype` segments are ignored.
 */
function validUnset(path: unknown, isField: (key: string) => boolean): path is string[] {
  if (!Array.isArray(path) || path.length === 0) return false
  if (!path.every((seg) => typeof seg === "string" && seg.length > 0 && safeKey(seg))) return false
  return isField(path[0] as string)
}

function mergeOneKey(baseVal: unknown, patchVal: unknown): unknown {
  if (patchVal === undefined) return cloneValue(isRecord(baseVal) ? baseVal : {})
  if (isRecord(patchVal) && isRecord(baseVal)) {
    return deepMergePatch(
      cloneValue(baseVal) as Record<string, unknown>,
      cloneValue(patchVal) as Record<string, unknown>,
    )
  }
  if (isRecord(patchVal)) return cloneValue(patchVal)
  return patchVal
}

function applyUnsets(current: unknown, key: string, paths: string[][]): unknown {
  let next = current
  for (const path of paths) {
    if (path[0] !== key) continue
    const rest = path.slice(1)
    if (rest.length === 0) return undefined
    if (isRecord(next)) deleteAt(next, rest)
  }
  if (isRecord(next) && Object.keys(next).length === 0) return undefined
  return next
}

export function composeScopePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  unsets: string[][],
  isField: (key: string) => boolean = () => true,
): Record<string, unknown> {
  const valid = unsets.filter((path) => validUnset(path, isField))
  const touched = new Set<string>()
  for (const key of Object.keys(patch)) {
    if (!safeKey(key) || !isField(key)) continue
    if (patch[key] === undefined) continue
    touched.add(key)
  }
  for (const path of valid) touched.add(path[0]!)
  const out: Record<string, unknown> = {}
  for (const key of touched) {
    const patchVal = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : undefined
    const baseVal = isRecord(base[key]) ? base[key] : undefined
    out[key] = applyUnsets(mergeOneKey(baseVal, patchVal), key, valid)
  }
  return out
}

/**
 * Recursively strip null/undefined (null = deleted).
 */
export function stripNullPatch(value: Record<string, unknown>, prefix: string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!safeKey(key)) continue
    const path = [...prefix, key]
    if (item === null || item === undefined) continue
    if (isRecord(item)) {
      result[key] = stripNullPatch(item, path)
    } else {
      result[key] = item
    }
  }
  return result
}
