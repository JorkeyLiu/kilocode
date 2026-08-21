import type { Agent } from "@/agent/agent"
import { Capture, type CaptureDeps } from "./capture"
import { Config } from "./config"
import { setKillSwitch } from "./eligibility"
import { createSequencer } from "./sequence"
import { SyncSubscriber } from "./sync-subscriber"
import { acquireLease, isLeaseHeld, type LeaseHandle } from "@opencode-ai/core/cutover/lease"
import path from "node:path"

declare global {
  const KILO_SESSION_EXPORT_WORKER_PATH: string
}

type WorkerTarget = string | URL
type Opts = {
  agentVersion: string
  dbPath: string
  endpoint?: string
  surface: string
  anonId?: string
  workspaceKey: string
  snapshotProvider?: CaptureDeps["snapshotProvider"]
  syncSeq: (sessionId: string) => number
  subscribeAll: (cb: (event: unknown) => void) => () => void
  createWorker: (url: WorkerTarget) => Worker
  sequencer?: ReturnType<typeof createSequencer>
}
type Instance = { options: Opts; capture: Capture; subscriber: SyncSubscriber; unsubscribe: () => void }

let worker: Worker | undefined
let attempts = 0
let shared: Opts | undefined
const instances = new Map<string, Instance>()

const maxRespawns = 3

export const enabled = false

const leaseHandles: LeaseHandle[] = []

function isFileBacked(p: string): boolean {
  return p !== ":memory:" && !p.includes(":memory:") && p !== ""
}

async function acquireDataRootLease(dbPath: string): Promise<LeaseHandle | undefined> {
  if (!isFileBacked(dbPath)) return undefined
  const dataRoot = path.dirname(path.resolve(dbPath))
  if (isLeaseHeld(dataRoot)) return undefined
  const handle = await acquireLease(dataRoot)
  leaseHandles.push(handle)
  return handle
}

async function releaseDataRootLeases(): Promise<void> {
  while (leaseHandles.length > 0) {
    const h = leaseHandles.pop()!
    try {
      await h.release()
    } catch (e) {
      console.warn("[session-export] lease release failed", e)
    }
  }
}

export function _leaseHandleCountForTests(): number {
  return leaseHandles.length
}

export const init = async (opts: {
  agentVersion: string
  dbPath: string
  endpoint?: string
  surface?: string
  anonId?: string
  snapshotProvider?: CaptureDeps["snapshotProvider"]
  workspaceKey?: string
  syncSeq?: (sessionId: string) => number
  subscribeAll: (cb: (event: unknown) => void) => () => void
  createWorker?: (url: WorkerTarget) => Worker
}): Promise<void> => {
  const url = target()
  let lease: LeaseHandle | undefined
  try {
    if (isFileBacked(opts.dbPath)) {
      lease = await acquireDataRootLease(opts.dbPath)
    }
    const key = opts.workspaceKey ?? "default"
    const previous = instances.get(key)
    previous?.unsubscribe()
    previous?.options.sequencer?.close()
    const sequencer = opts.syncSeq ? undefined : createSequencer(opts.dbPath)
    const syncSeq = opts.syncSeq ?? ((sessionId: string) => sequencer!.next(sessionId))
    const next: Opts = {
      agentVersion: opts.agentVersion,
      dbPath: opts.dbPath,
      endpoint: opts.endpoint,
      surface: opts.surface ?? currentSurface(),
      anonId: opts.anonId,
      workspaceKey: key,
      snapshotProvider: opts.snapshotProvider,
      syncSeq,
      subscribeAll: opts.subscribeAll,
      createWorker: opts.createWorker ?? ((file) => new Worker(file)),
      sequencer,
    }
    shared = shared ?? next
    if (worker) {
      configure(next)
      return
    }
    shared = next
    spawn(url)
  } catch (err) {
    if (lease) {
      try {
        await lease.release()
        const idx = leaseHandles.indexOf(lease)
        if (idx >= 0) leaseHandles.splice(idx, 1)
      } catch {}
    }
    const current = worker as unknown as Worker | undefined
    if (current) current.terminate()
    worker = undefined
    for (const item of instances.values()) {
      item.unsubscribe()
      item.options.sequencer?.close()
    }
    instances.clear()
    shared = undefined
    throw err
  }
}

export const beforeRequest = (...args: Parameters<Capture["beforeRequest"]>): void => {
  captureFor(args[0].requestMeta.workspaceKey)?.beforeRequest(...args)
}

export const afterRequest = (...args: Parameters<Capture["afterRequest"]>): void => {
  captureFor(args[0].workspaceKey)?.afterRequest(...args)
}

export const compaction = (args: Parameters<Capture["compaction"]>[0]): void => {
  captureFor(args.workspaceKey)?.compaction(args)
}

export const agentInfo = (info: Agent.Info): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    name: info.name,
    mode: info.mode,
  }
  if (info.displayName !== undefined) out.displayName = info.displayName
  if (info.description !== undefined) out.description = info.description
  if (info.deprecated !== undefined) out.deprecated = info.deprecated
  if (info.native !== undefined) out.native = info.native
  if (info.hidden !== undefined) out.hidden = info.hidden
  if (info.topP !== undefined) out.topP = info.topP
  if (info.temperature !== undefined) out.temperature = info.temperature
  if (info.color !== undefined) out.color = info.color
  if (info.model !== undefined) out.model = info.model
  if (info.variant !== undefined) out.variant = info.variant
  if (info.steps !== undefined) out.steps = info.steps
  return out
}

export const onSessionClose = async (sessionId: string, workspaceKey?: string): Promise<void> => {
  await captureFor(workspaceKey)?.onSessionClose(sessionId)
}

export const shutdown = async (): Promise<void> => {
  if (worker) {
    const current = worker
    for (const item of instances.values()) item.unsubscribe()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Config.shutdownFlushTimeoutMs + 500)
      current.onmessage = (event: MessageEvent) => {
        if ((event.data as { kind?: string }).kind === "shutdown_done") {
          clearTimeout(timer)
          resolve()
        }
      }
      current.postMessage({ kind: "shutdown", timeoutMs: Config.shutdownFlushTimeoutMs })
    })
    current.terminate()
    worker = undefined
  } else {
    for (const item of instances.values()) item.unsubscribe()
  }
  for (const item of instances.values()) item.options.sequencer?.close()
  instances.clear()
  shared = undefined
  attempts = 0
  await releaseDataRootLeases()
}

function target(): WorkerTarget {
  if (typeof KILO_SESSION_EXPORT_WORKER_PATH !== "undefined") return KILO_SESSION_EXPORT_WORKER_PATH
  return new URL("./worker.ts", import.meta.url)
}

function spawn(url = target()): void {
  if (!shared) return
  worker = shared.createWorker(url)
  worker.postMessage({
    kind: "init",
    dbPath: shared.dbPath,
    agentVersion: shared.agentVersion,
    endpoint: shared.endpoint,
    surface: shared.surface,
    anonId: shared.anonId,
  })
  for (const item of [...instances.values()]) configure(item.options)
  if (instances.size === 0) configure(shared)
}

function configure(options: Opts): void {
  if (!worker) return
  instances.get(options.workspaceKey)?.unsubscribe()
  const capture = new Capture({
    worker,
    agentVersion: options.agentVersion,
    nowMs: () => Date.now(),
    syncSeq: options.syncSeq,
    onPostError: respawn,
    snapshotProvider: options.snapshotProvider,
  })
  const subscriber = new SyncSubscriber({
    isEligibleSession: (sessionId) => capture.hasEligibleSession(sessionId),
    dispatch: (event) => capture.dispatchRaw(event),
    agentVersion: options.agentVersion,
    now: () => Date.now(),
    syncSeq: options.syncSeq,
    getTurnId: (sessionId) => capture.turnId(sessionId),
    getRootSessionId: (sessionId) => capture.rootSessionId(sessionId),
  })
  const unsubscribe = options.subscribeAll((event) => subscriber.onSyncEvent(event as never))
  instances.set(options.workspaceKey, { options, capture, subscriber, unsubscribe })
  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { kind?: string; sessionId?: string; reason?: string; name?: string }
    if (msg.kind === "pressure" && msg.sessionId) {
      for (const item of instances.values()) item.capture.markDegraded(msg.sessionId!)
    }
    if (msg.kind === "kill_switch") setKillSwitch(true, msg.reason ?? "worker")
  }
  worker.onerror = (event: ErrorEvent) => {
    console.warn("[session-export] worker error", event.message)
    respawn(event.error ?? event.message)
  }
}

function currentSurface(): string {
  return process.env.KILOCODE_FEATURE?.trim() || "unknown"
}

function respawn(err: unknown): void {
  console.warn("[session-export] worker respawn", err)
  worker?.terminate()
  worker = undefined
  attempts++
  if (attempts > maxRespawns) {
    setKillSwitch(true, "worker_respawn_failed")
    return
  }
  spawn()
}

function captureFor(key: string | undefined): Capture | undefined {
  if (key) return instances.get(key)?.capture
  return instances.get("default")?.capture ?? instances.values().next().value?.capture
}
