import type { ServePrivatePeer } from "./serve-private-peer"

// Sanitized quarantine branch for owner timeout invalidation. Preserves the
// same peer/streams/epoch for lazy health recovery; never disposes, nulls,
// or clears listeners. Logs only fixed op labels with no raw reason/epoch.
export function quarantinePeerOnTimeout(peer: ServePrivatePeer, reason: string, epoch: number | null): void {
  const childrenSafe = reason.startsWith("children ")
  const remoteSafe = reason.startsWith("remote-status ")
  const pathSafe = reason.startsWith("path ")
  const warningsSafe = reason.startsWith("config-warnings ")
  const projectSafe = reason.startsWith("project-current ")
  const findSafe = reason.startsWith("find-files ")
  const messagesSafe = [
    "observer timeout cancel throw",
    "observer timeout exact cancel miss",
    "messages observer timeout",
  ].includes(reason)
  if (childrenSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "session/children", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "session/children", invalidateFailed: true })
    }
    return
  }
  if (remoteSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "remote/status", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "remote/status", invalidateFailed: true })
    }
    return
  }
  if (pathSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "path/get", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "path/get", invalidateFailed: true })
    }
    return
  }
  if (warningsSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "config/warnings", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "config/warnings", invalidateFailed: true })
    }
    return
  }
  if (projectSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "project/current", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "project/current", invalidateFailed: true })
    }
    return
  }
  if (findSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "find/files", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "find/files", invalidateFailed: true })
    }
    return
  }
  if (messagesSafe) {
    console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "session/messages", quarantined: true, invalidated: true })
    try {
      peer.invalidateOnObserverTimeout(reason)
    } catch {
      console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "session/messages", invalidateFailed: true })
    }
    return
  }
  void epoch
  console.warn(`[Kilo] PrivatePeer observer timeout quarantines:`, { op: "quarantine", quarantined: true, invalidated: true })
  try {
    peer.invalidateOnObserverTimeout(reason)
  } catch {
    console.warn("[Kilo] invalidateOnObserverTimeout failed:", { op: "quarantine", invalidateFailed: true })
  }
}
