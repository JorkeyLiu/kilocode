import { readFileSync, rmSync } from "node:fs"

export const READ_FAILED = "marker read failed (redacted)"
export const REMOVE_FAILED = "marker remove failed (redacted)"
export const CREDENTIAL_FAILED = "credential failed (redacted)"

export function malformed(label: string): string {
  return `${label} marker malformed (redacted)`
}

type Read = (p: string) => string
type Rm = (p: string) => void

const defaultRead: Read = (p) => readFileSync(p, "utf8")
const defaultRm: Rm = (p) => rmSync(p)

export function load(p: string, read: Read = defaultRead): string {
  try {
    return read(p)
  } catch {
    throw new Error(READ_FAILED)
  }
}

export function drop(p: string, rm: Rm = defaultRm): void {
  try {
    rm(p)
  } catch {
    throw new Error(REMOVE_FAILED)
  }
}

export function decode(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(malformed(label))
  }
}

export function parsePrivateStatus(raw: string): { nonce: string } {
  const label = "lc-private-status"
  const parsed = decode(raw, label) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(malformed(label))
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 1 || keys[0] !== "nonce") throw new Error(malformed(label))
  const nonce = rec.nonce
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error(malformed(label))
  return { nonce }
}

export function parseTitle(raw: string): { sessionId: string; title: string; nonce: string } {
  const label = "lc-title"
  const parsed = decode(raw, label) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(malformed(label))
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const expected = ["nonce", "sessionId", "title"]
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) throw new Error(malformed(label))
  const sid = rec.sessionId
  const title = rec.title
  const nonce = rec.nonce
  if (typeof sid !== "string" || sid.length === 0) throw new Error(malformed(label))
  if (typeof title !== "string" || title.length === 0) throw new Error(malformed(label))
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error(malformed(label))
  return { sessionId: sid, title, nonce }
}

export function parseReplay(raw: string): { sessionId: string; nonce: string } {
  const label = "lc-replay"
  const parsed = decode(raw, label) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(malformed(label))
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const expected = ["nonce", "sessionId"]
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) throw new Error(malformed(label))
  const sid = rec.sessionId
  const nonce = rec.nonce
  if (typeof sid !== "string" || sid.length === 0) throw new Error(malformed(label))
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error(malformed(label))
  return { sessionId: sid, nonce }
}

export function credentialFailed(): { ok: false; error: string } {
  return { ok: false, error: CREDENTIAL_FAILED }
}
