import { realpath } from "node:fs/promises"
import type {
  EventKilocodeNotebookCancelled,
  EventKilocodeNotebookRequested,
  KiloClient,
  NotebookFailure,
  NotebookRequest,
  NotebookResult,
} from "@kilocode/sdk/v2/client"
import { FileIgnoreController } from "./file-ignore"
import type { ConnectionState, KiloConnectionService } from "../cli-backend/connection-service"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import { NotebookAdapter } from "./adapter"
import { NotebookError } from "./path"
import {
  listNotebooksPrivateFirst,
  rejectNotebookPrivateFirst,
  replyNotebookPrivateFirst,
  type NotebookSettleOutcome,
} from "../../kilo-provider/notebook-privatefirst"

const RETAINED_REQUESTS = 1_000
const CODES = new Set<NotebookFailure["code"]>([
  "cancelled",
  "closed",
  "disconnected",
  "execution_failed",
  "invalid_cell",
  "invalid_path",
  "no_kernel",
  "not_found",
  "stale_revision",
  "timeout",
  "unsupported",
])

type NotebookAdapterLike = Pick<NotebookAdapter, "read" | "edit" | "execute">

export interface NotebookBridgeContext {
  adapter: NotebookAdapterLike
  refresh?(): Promise<void>
  dispose(): void
}

export interface NotebookBridgeOptions {
  create?: (directory: string) => Promise<NotebookBridgeContext>
  canonical?: (directory: string) => Promise<string>
}

interface NotebookConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getClient(): KiloClient
  getKnownDirectories(): string[]
}

interface ActiveRequest {
  controller: AbortController
  cancelled: boolean
}

interface RequestOrigin {
  directory: string
  root: string
  sessionID: string
}

type NotebookOutcome = { result: NotebookResult } | { error: NotebookFailure }

interface UnresolvedGuard {
  opId: string
  reason: string
  requestID: string
  sessionID: string
  directory: string
}

async function createContext(directory: string): Promise<NotebookBridgeContext> {
  const controller = new FileIgnoreController(directory)
  await controller.initialize()
  return {
    adapter: new NotebookAdapter(controller),
    refresh: () => controller.initialize(),
    dispose: () => controller.dispose(),
  }
}

function failure(error: unknown): NotebookFailure {
  const detail = error instanceof Error ? error.message : String(error)
  const message = (detail || "Notebook operation failed without an error message").slice(0, 10_000)
  if (error instanceof NotebookError && CODES.has(error.code as NotebookFailure["code"])) {
    return {
      code: error.code as NotebookFailure["code"],
      message,
      ...(error.path !== undefined ? { path: error.path } : {}),
      ...(error.index !== undefined ? { index: error.index } : {}),
      ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
    }
  }
  return { code: "execution_failed", message }
}

export class NotebookBridge {
  private readonly contexts = new Map<string, Promise<NotebookBridgeContext>>()
  private readonly active = new Map<string, ActiveRequest>()
  private readonly admitting = new Set<string>()
  private readonly origins = new Map<string, RequestOrigin>()
  private readonly outcomes = new Map<string, NotebookOutcome>()
  private readonly settled = new Set<string>()
  private readonly unresolved = new Map<string, UnresolvedGuard>()
  // Bounded overflow observability: scalar counters only, never identity lists.
  // unresolvedEvictions counts guards moved to the settled tombstone; when the
  // settled tombstone itself overflows (settledEvictions > 0) an evicted guard
  // is forgotten and reconnect replay becomes possible again (see residual).
  private unresolvedEvictions = 0
  private settledEvictions = 0
  private readonly unsubscribeEvent: () => void
  private readonly unsubscribeState: () => void
  private readonly create: (directory: string) => Promise<NotebookBridgeContext>
  private readonly canonical: (directory: string) => Promise<string>
  private disposed = false
  private revision = 0
  private backend: KiloClient | undefined

  constructor(
    private readonly connection: NotebookConnection,
    options: NotebookBridgeOptions = {},
  ) {
    this.create = options.create ?? createContext
    this.canonical = options.canonical ?? realpath
    this.unsubscribeEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.unsubscribeState = connection.onStateChange((state) => {
      if (state !== "connected") return
      const backend = connection.getClient()
      if (this.backend && this.backend !== backend) this.reset()
      this.backend = backend
      const revision = ++this.revision
      void this.recover(revision).catch((error: unknown) => {
        console.error("[Kilo New] NotebookBridge: pending request recovery failed:", error)
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.unsubscribeEvent()
    this.unsubscribeState()
    for (const request of this.active.values()) {
      request.cancelled = true
      request.controller.abort()
    }
    this.active.clear()
    this.admitting.clear()
    for (const context of this.contexts.values()) {
      void context
        .then((value) => value.dispose())
        .catch((error: unknown) => console.error("[Kilo New] NotebookBridge: context disposal failed:", error))
    }
    this.contexts.clear()
    this.origins.clear()
    this.outcomes.clear()
    this.settled.clear()
    this.unresolved.clear()
  }

  private reset(): void {
    for (const request of this.active.values()) {
      request.cancelled = true
      request.controller.abort()
    }
    this.active.clear()
    this.admitting.clear()
    this.origins.clear()
    this.outcomes.clear()
    this.settled.clear()
    this.unresolved.clear()
  }

  private event(event: SSEPayload, directory?: string): void {
    if (event.type === "kilocode.notebook.requested") {
      this.request(event as EventKilocodeNotebookRequested, directory)
      return
    }
    if (event.type === "kilocode.notebook.cancelled") {
      this.cancel(event as EventKilocodeNotebookCancelled, directory)
    }
  }

  private request(event: EventKilocodeNotebookRequested, directory?: string): void {
    const request = event.properties
    // Accepted-only: an unresolved semantic op is never silently replayed.
    // The guard discriminates ID+session/directory like origins, but a same-ID
    // collision is never treated as safely retryable: same origin suppresses
    // reconnect replay, different origin suppresses a colliding execution.
    const guard = this.unresolved.get(request.id)
    if (guard) {
      if (guard.sessionID !== request.sessionID || (directory && guard.directory !== directory)) {
        console.warn("[Kilo New] NotebookBridge: notebook unresolved ID collision suppressed:", {
          requestID: request.id,
        })
      }
      return
    }
    const origin = this.origins.get(request.id)
    if (origin) {
      if (origin.sessionID !== request.sessionID || (directory && origin.directory !== directory)) return
      this.start(request, origin)
      return
    }
    if (!directory || this.disposed || this.admitting.has(request.id) || this.settled.has(request.id)) return
    this.admitting.add(request.id)
    void this.admit(request, directory).finally(() => this.admitting.delete(request.id))
  }

  private async admit(request: NotebookRequest, directory: string): Promise<void> {
    const root = await this.allowed(directory)
    if (this.disposed || this.settled.has(request.id) || this.unresolved.has(request.id)) return
    if (!root) {
      const outcome = await this.reject(request.id, directory, {
        code: "invalid_path",
        message: "Notebook request directory is not an active VS Code workspace",
      })
      if (outcome.kind === "settled") this.remember(this.settled, request.id)
      else if (outcome.kind === "unresolved")
        this.rememberUnresolved(
          request.id,
          {
            opId: outcome.opId,
            reason: outcome.reason,
            requestID: outcome.requestID,
          },
          { sessionID: request.sessionID, directory },
        )
      return
    }
    const origin = { directory, root, sessionID: request.sessionID }
    this.rememberOrigin(request.id, origin)
    this.start(request, origin)
  }

  private start(request: NotebookRequest, origin: RequestOrigin): void {
    if (this.disposed || this.active.has(request.id) || this.settled.has(request.id)) return
    if (this.unresolved.has(request.id)) return
    const active = { controller: new AbortController(), cancelled: false }
    this.active.set(request.id, active)
    void this.run(request, origin, active).catch((error: unknown) => {
      console.error(`[Kilo New] NotebookBridge: request ${request.id} failed:`, error)
    })
  }

  private cancel(event: EventKilocodeNotebookCancelled, directory?: string): void {
    const id = event.properties.requestID
    // Fail closed: a cancel only clears the guard when its origin matches the
    // recorded origin (or the unresolved guard's origin when origins evicted).
    // Cross-origin or unknown-origin cancels never clear the guard and never
    // settle; absence handling stays read-only.
    const origin = this.origins.get(id)
    const guard = this.unresolved.get(id)
    const known = origin ?? (guard ? { sessionID: guard.sessionID, directory: guard.directory } : undefined)
    const active = this.active.get(id)
    if (!known) {
      // No verifiable origin: never clear the guard, never settle. Still abort
      // a matching in-flight run so it cannot post a late completion.
      if (!active) return
      active.cancelled = true
      active.controller.abort()
      return
    }
    if (known.sessionID !== event.properties.sessionID || (directory && known.directory !== directory)) return
    this.unresolved.delete(id)
    this.remember(this.settled, id)
    if (!active) return
    active.cancelled = true
    active.controller.abort()
  }

  private async run(request: NotebookRequest, origin: RequestOrigin, active: ActiveRequest): Promise<void> {
    try {
      if (this.unresolved.has(request.id)) return
      const outcome = this.outcomes.get(request.id) ?? (await this.execute(request, origin.root, active))
      if (!outcome || this.disposed || active.cancelled) return
      this.rememberOutcome(request.id, outcome)
      const result: NotebookSettleOutcome =
        "result" in outcome
          ? await this.reply(request.id, origin.directory, outcome.result)
          : await this.reject(request.id, origin.directory, outcome.error)
      if (result.kind === "settled") {
        this.outcomes.delete(request.id)
        this.unresolved.delete(request.id)
        this.remember(this.settled, request.id)
        return
      }
      if (result.kind === "unresolved") {
        // Accepted-only: retain the cached adapter result for diagnostics and
        // keep list re-observation read-only. Never automatically reissue the
        // same semantic op; absence in a later list is not acceptance.
        this.rememberUnresolved(
          request.id,
          { opId: result.opId, reason: result.reason, requestID: result.requestID },
          { sessionID: origin.sessionID, directory: origin.directory },
        )
        return
      }
      if (result.kind === "retry" && result.code === undefined) {
        // SDK-dispatch failure (or missing client) whose acceptance is unknown:
        // fail closed as unresolved instead of silently replaying the cached
        // semantic action on reconnect. Only terminal invalid_reply /
        // scope_mismatch (proven not accepted, carrying code) stays retryable.
        this.rememberUnresolved(
          request.id,
          { opId: "", reason: "retry-unknown", requestID: request.id },
          { sessionID: origin.sessionID, directory: origin.directory },
        )
        return
      }
      // Terminal retry with code (invalid_reply/scope_mismatch, proven not
      // accepted with pending intact): keep the cached outcome for reconnect
      // replay without rerunning the adapter. Unresolved never replays.
      this.unresolved.delete(request.id)
    } finally {
      if (this.active.get(request.id) === active) this.active.delete(request.id)
    }
  }

  private async execute(
    request: NotebookRequest,
    directory: string,
    active: ActiveRequest,
  ): Promise<NotebookOutcome | undefined> {
    try {
      const context = await this.context(directory)
      if (this.disposed || active.cancelled) return undefined
      await context.refresh?.()
      if (this.disposed || active.cancelled) return undefined
      const result = await this.dispatch(context.adapter, request, directory, active.controller.signal)
      return { result }
    } catch (error) {
      if (this.disposed || active.cancelled) return undefined
      return { error: failure(error) }
    }
  }

  private dispatch(
    adapter: NotebookAdapterLike,
    request: NotebookRequest,
    directory: string,
    signal: AbortSignal,
  ): Promise<NotebookResult> {
    if (request.operation === "read") {
      return adapter.read({ path: request.path, directory, includeOutputs: request.includeOutputs })
    }
    if (request.operation === "edit") {
      return adapter.edit({
        path: request.path,
        directory,
        ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
        index: request.index,
        edit: request.edit,
      })
    }
    return adapter.execute({
      path: request.path,
      directory,
      expectedRevision: request.expectedRevision,
      index: request.index,
      signal,
    })
  }

  private async allowed(directory: string): Promise<string | undefined> {
    const root = await this.canonical(directory).catch(() => undefined)
    if (!root) return undefined
    const known = await Promise.all(
      this.connection.getKnownDirectories().map((dir) => this.canonical(dir).catch(() => undefined)),
    )
    return known.includes(root) ? root : undefined
  }

  private context(directory: string): Promise<NotebookBridgeContext> {
    const existing = this.contexts.get(directory)
    if (existing) return existing
    const context = this.create(directory).catch((error: unknown) => {
      this.contexts.delete(directory)
      throw error
    })
    this.contexts.set(directory, context)
    return context
  }

  private async reply(requestID: string, directory: string, result: NotebookResult): Promise<NotebookSettleOutcome> {
    try {
      const { outcome } = await replyNotebookPrivateFirst({
        connection: this.connection as never,
        client: this.connection.getClient() as never,
        directory,
        requestID,
        result,
      })
      return outcome
    } catch (error) {
      console.error(`[Kilo New] NotebookBridge: reply ${requestID} failed:`, error)
      return { kind: "retry" }
    }
  }

  private async reject(
    requestID: string,
    directory: string,
    error: NotebookFailure,
  ): Promise<NotebookSettleOutcome> {
    try {
      const { outcome } = await rejectNotebookPrivateFirst({
        connection: this.connection as never,
        client: this.connection.getClient() as never,
        directory,
        requestID,
        error,
      })
      return outcome
    } catch (cause) {
      console.error(`[Kilo New] NotebookBridge: rejection ${requestID} failed:`, cause)
      return { kind: "retry" }
    }
  }

  private async recover(revision: number): Promise<void> {
    for (const directory of this.connection.getKnownDirectories()) {
      try {
        const { outcome } = await listNotebooksPrivateFirst({
          connection: this.connection as never,
          client: this.connection.getClient() as never,
          directory,
        })
        if (this.disposed || revision !== this.revision) return
        if (outcome.kind !== "ok") {
          console.error("[Kilo New] NotebookBridge: could not list pending notebook requests")
          continue
        }
        for (const request of outcome.items) {
          this.request({ id: request.id, type: "kilocode.notebook.requested", properties: request } as never, directory)
        }
      } catch (error) {
        console.error("[Kilo New] NotebookBridge: could not list pending notebook requests:", error)
      }
    }
  }

  private rememberOutcome(id: string, outcome: NotebookOutcome): void {
    this.outcomes.set(id, outcome)
    if (this.outcomes.size <= RETAINED_REQUESTS) return
    const oldest = this.outcomes.keys().next().value
    if (oldest !== undefined) this.outcomes.delete(oldest)
  }

  private rememberOrigin(id: string, origin: RequestOrigin): void {
    this.origins.set(id, origin)
    if (this.origins.size <= RETAINED_REQUESTS) return
    const oldest = this.origins.keys().next().value
    if (oldest !== undefined) this.origins.delete(oldest)
  }

  private rememberUnresolved(
    id: string,
    detail: { opId: string; reason: string; requestID: string },
    origin: { sessionID: string; directory: string },
  ): void {
    this.unresolved.set(id, { ...detail, sessionID: origin.sessionID, directory: origin.directory })
    if (this.unresolved.size <= RETAINED_REQUESTS) return
    // Fail closed on overflow: the evicted guard cannot be forgotten, or a
    // later reconnect would silently replay its cached semantic action. Move
    // it to the bounded settled tombstone so the ID stays suppressed instead
    // of replaying. Genuinely new IDs (never seen) are unaffected.
    const oldest = this.unresolved.keys().next().value
    if (oldest !== undefined) {
      this.unresolved.delete(oldest)
      this.unresolvedEvictions += 1
      console.warn("[Kilo New] NotebookBridge: notebook unresolved guard overflow, suppressing evicted ID:", {
        evictions: this.unresolvedEvictions,
      })
      this.remember(this.settled, oldest)
    }
  }

  private remember(set: Set<string>, id: string): void {
    set.add(id)
    if (set.size <= RETAINED_REQUESTS) return
    // Bounded tombstone overflow: the forgotten ID may replay on reconnect.
    // Counted (scalar) for observability; see residual: clearing this requires
    // unbounded identity retention or a runtime-owned receipt.
    const oldest = set.keys().next().value
    if (oldest !== undefined) {
      set.delete(oldest)
      if (set === this.settled) {
        this.settledEvictions += 1
        console.warn("[Kilo New] NotebookBridge: notebook settled tombstone overflow, guard forgotten:", {
          evictions: this.settledEvictions,
        })
      }
    }
  }
}

export function createNotebookBridge(connection: KiloConnectionService): NotebookBridge {
  return new NotebookBridge(connection)
}
