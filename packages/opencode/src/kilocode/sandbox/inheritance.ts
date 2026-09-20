import { createHash, randomUUID } from "node:crypto"
import type { SessionID } from "@/session/schema"

interface Grant {
  sessionID: SessionID
  directory: string
  expires: number
  remaining: number
}

interface Reservation {
  hash: string
  sessionID: SessionID
  directory: string
  token: string
}

const ttl = 24 * 60 * 60 * 1000
const grants = new Map<string, Grant>()
const reservations = new Map<string, Reservation>()

function cleanup(now = Date.now()) {
  for (const [token, grant] of grants) {
    if (grant.expires <= now || grant.remaining <= 0) grants.delete(token)
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function shapeValid(token: string): boolean {
  return /^si-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
}

export function issue(input: { sessionID: SessionID; directory: string; count: number }) {
  cleanup()
  const token = `si-${randomUUID()}`
  grants.set(token, {
    sessionID: input.sessionID,
    directory: input.directory,
    expires: Date.now() + ttl,
    remaining: Math.max(1, input.count),
  })
  return token
}

export function validateShape(token: string): boolean {
  return shapeValid(token)
}

export function peekGrant(token: string | undefined): { sessionID: SessionID; directory: string; hash: string } | undefined {
  if (!token) return undefined
  if (!shapeValid(token)) return undefined
  cleanup()
  const grant = grants.get(token)
  if (!grant) return undefined
  return { sessionID: grant.sessionID, directory: grant.directory, hash: hashToken(token) }
}

export function reserve(opId: string, token: string | undefined | null): Reservation | undefined {
  if (!token) return undefined
  if (!shapeValid(token)) throw new Error("invalid sandbox inheritance token shape")
  cleanup()
  if (reservations.has(opId)) throw new Error("sandbox inheritance token conflict for opId")
  const grant = grants.get(token)
  if (!grant) throw new Error("Invalid sandbox inheritance token")
  if (grant.remaining <= 0) throw new Error("Invalid sandbox inheritance token")
  const hash = hashToken(token)
  const res: Reservation = { hash, sessionID: grant.sessionID, directory: grant.directory, token }
  reservations.set(opId, res)
  return res
}

export function commit(opId: string): void {
  const res = reservations.get(opId)
  if (!res) return
  const grant = grants.get(res.token)
  if (grant) {
    grant.remaining--
    if (grant.remaining <= 0) grants.delete(res.token)
  }
  reservations.delete(opId)
}

export function release(opId: string): void {
  reservations.delete(opId)
}

export function consume(token: string | undefined) {
  if (!token) return undefined
  cleanup()
  const grant = grants.get(token)
  if (!grant) return undefined
  grant.remaining--
  if (grant.remaining <= 0) grants.delete(token)
  return { sessionID: grant.sessionID, directory: grant.directory }
}

export function _resetForTest(): void {
  grants.clear()
  reservations.clear()
}

export function _getReservation(opId: string): Reservation | undefined {
  return reservations.get(opId)
}

export function _getGrant(token: string): Grant | undefined {
  return grants.get(token)
}
