import * as fs from "fs"
import * as path from "path"
import type { FileReadResult } from "./types"
import { readFile } from "./parse"

export function checkAssetStamp(
  existing: FileReadResult,
  filePath: string,
  expectedHash: string,
): { ok: false; kind: "invalid" | "stale"; message: string } | null {
  if (existing.type === "absent") {
    if (expectedHash !== "absent") return { ok: false, kind: "stale", message: `Asset file was deleted externally: ${filePath}` }
    return null
  }
  if (existing.type === "failure") return { ok: false, kind: "stale", message: `Asset file unreadable: ${filePath}: ${existing.message}` }
  if (expectedHash === "absent") return { ok: false, kind: "stale", message: `Asset file already exists: ${filePath}` }
  if (existing.hash !== expectedHash)
    return { ok: false, kind: "stale", message: `Asset file was modified externally (expected ${expectedHash}, got ${existing.hash})` }
  return null
}

export function checkAssetFinalCas(
  filePath: string,
  expectedHash: string,
): { ok: false; kind: "invalid" | "stale"; message: string } | null {
  return checkAssetStamp(readFile(filePath), filePath, expectedHash)
}

export function removeTemp(filePath: string, message: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    console.error(`[Kilo Config] ${message} for ${filePath}: ${String(err)}`)
  }
}

export function writeAssetFile(
  filePath: string,
  content: string,
  expectedHash: string,
  beforeCas?: (filePath: string) => void,
): { ok: true } | { ok: false; value: { ok: false; kind: "invalid" | "stale"; message: string } } {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(tmp, content, "utf-8")
    beforeCas?.(filePath)
    const finalStamp = checkAssetFinalCas(filePath, expectedHash)
    if (finalStamp) {
      removeTemp(tmp, "Asset temp cleanup failed")
      return { ok: false, value: finalStamp }
    }
    fs.renameSync(tmp, filePath)
    return { ok: true }
  } catch (err) {
    removeTemp(tmp, "Asset temp cleanup failed")
    throw err
  }
}
