import { FrameDecoder, encodeFrame } from "./frame"
import {
  ErrorCode,
  JSONRPC_VERSION,
  makeError,
  makeSuccess,
  parseMessage,
  validateRequest,
  type InitializeResult,
  type JsonRpcId,
} from "./json-rpc"
import type { ChildProcess } from "child_process"

export type PeerState = "open" | "closed"

/** Reserved wire-level notification for best-effort incoming request cancellation. */
export const CANCEL_REQUEST_METHOD = "$/cancelRequest"

/** Reserved wire-level notification for per-request correlated events. */
export const REQUEST_EVENT_METHOD = "$/event"

/** Minimal context passed to incoming request handlers. */
export interface RequestContext {
  id: JsonRpcId
  signal: AbortSignal
  emit: (event: unknown) => boolean
}

export interface PeerOptions {
  reader: NodeJS.ReadableStream
  writer: NodeJS.WritableStream
  child?: ChildProcess
  onRequest?: (method: string, params: unknown, ctx: RequestContext) => unknown | Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
  // Optional close hook — invoked exactly once when peer transitions to closed
  // (EOF, stream closed, child exit, or explicit dispose). No polling.
  onClosed?: () => void
}

export class JsonRpcPeer {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void; onEvent?: (event: unknown) => void }>()
  private readonly incoming = new Map<JsonRpcId, AbortController>()
  private nextId = 1
  private state: PeerState = "open"
  private readonly writer: NodeJS.WritableStream
  private readonly reader: NodeJS.ReadableStream
  private readonly child?: ChildProcess
  private readonly onRequest?: PeerOptions["onRequest"]
  private readonly onNotification?: PeerOptions["onNotification"]
  private readonly onClosed?: PeerOptions["onClosed"]
  private closedNotified = false
  private initialized = false

  constructor(opts: PeerOptions) {
    this.reader = opts.reader
    this.writer = opts.writer
    this.child = opts.child
    this.onRequest = opts.onRequest
    this.onNotification = opts.onNotification
    this.onClosed = opts.onClosed
    this.bindReader()
    this.bindWriter()
    if (this.child) this.bindChild()
  }

  getState(): PeerState {
    return this.state
  }

  isInitialized(): boolean {
    return this.initialized
  }

  /** Mark initialized internally (used by worker handler). */
  markInitialized(): void {
    this.initialized = true
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.requestWithId(method, params).promise
  }

  /** Allocate id and return handle atomically; caller owns exact id for timeout cancellation. */
  requestWithId(method: string, params?: unknown, onEvent?: (event: unknown) => void): { id: JsonRpcId; promise: Promise<unknown> } {
    if (this.state !== "open") {
      const err = makePeerError(ErrorCode.InternalError, "Peer is closed")
      return { id: -1 as JsonRpcId, promise: Promise.reject(err) }
    }
    const id = this.nextId++ as JsonRpcId
    const payload: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method }
    if (params !== undefined) payload.params = params
    const frame = encodeFrame(payload)
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent })
      const wrote = this.write(frame, id, reject)
      if (!wrote) {
        // write failure already transitioned to closed and cleared pending via rejectAllPending
        // ensure onEvent registration does not leak if not already cleared
        this.pending.delete(id)
      }
    })
    // If write failed synchronously, pending was cleared and peer is closed; ensure the rejection
    // propagates via the promise path above (rejectAllPending). Attach handler to silence unhandled.
    return { id, promise }
  }

  /**
   * Generic per-request correlated event support. Registers `onEvent` atomically
   * before the request frame is written, so no event can arrive before the handler.
   * `onEvent` is removed on terminal success/error, local drop/cancel, peer
   * close/dispose, and send failure. Late events are ignored and cannot recreate state.
   * Existing unary `request`/`requestWithId` remain compatible — this is an additive API
   * for future streaming (e.g. provider HTTP chunks) without encoding a provider protocol.
   */
  requestWithEvents(method: string, params?: unknown, onEvent?: (event: unknown) => void): { id: JsonRpcId; promise: Promise<unknown> } {
    return this.requestWithId(method, params, onEvent)
  }

  getPendingCount(): number {
    return this.pending.size
  }

  getPendingIds(): JsonRpcId[] {
    return [...this.pending.keys()]
  }

  getIncomingCount(): number {
    return this.incoming.size
  }

  peekNextId(): number {
    return this.nextId
  }

  /**
   * Explicit cancellation/removal API for the owned request. Removes the
   * pending entry for `id` and rejects it with a timeout error. Returns
   * true if an entry was removed, false if none existed. This is the
   * natural private-peer boundary ownership for timed-out observer
   * requests — the timed-out pending must not accumulate until peer close.
   */
  tryCancelPending(id: JsonRpcId, message = "private parity timeout"): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.reject(makePeerError(ErrorCode.InternalError, message))
    return true
  }

  /**
   * Best-effort remote cancellation for an exact outgoing pending request.
   * Only succeeds when `id` is an exact pending outgoing request. On success
   * it sends the `$/cancelRequest` wire notification with params `{ id }` and
   * rejects the local promise with the existing InternalError cancellation
   * error. Unknown or already-completed ids return false and send nothing.
   * The remote side may ignore the notification; cancellation never forces
   * termination. If the notification write fails synchronously (or the peer
   * is closed), the local pending is still removed/rejected to avoid leaks
   * but the call returns false so failure is not misreported as success.
   */
  cancel(id: JsonRpcId, message = "private parity timeout"): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    if (this.state !== "open") {
      this.pending.delete(id)
      entry.reject(makePeerError(ErrorCode.InternalError, message))
      return false
    }
    this.pending.delete(id)
    const payload: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, method: CANCEL_REQUEST_METHOD, params: { id } }
    const frame = encodeFrame(payload)
    const sent = this.write(frame, null, null)
    entry.reject(makePeerError(ErrorCode.InternalError, message))
    return sent && this.state === "open"
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== "open") return
    const payload: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, method }
    if (params !== undefined) payload.params = params
    const frame = encodeFrame(payload)
    this.write(frame, null, null)
  }

  dispose(): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.unbind()
    this.abortAllIncoming()
    this.rejectAllPending("Peer disposed")
    this.notifyClosed()
  }

  private write(frame: Buffer, _id: JsonRpcId | null, _reject: ((e: unknown) => void) | null): boolean {
    try {
      const ok = (this.writer as unknown as { write: (b: Buffer) => boolean }).write(frame)
      void ok
      return true
    } catch (e) {
      this.transitionClosed(`writer sync throw: ${String(e)}`)
      return false
    }
  }

  private bindReader(): void {
    const onData = (chunk: Buffer | string) => {
      if (this.state !== "open") return
      const bodies = this.decoder.push(chunk as Buffer)
      for (const body of bodies) this.handleBody(body)
    }
    const onEnd = () => this.transitionClosed("EOF")
    const onClose = () => this.transitionClosed("stream closed")
    const onError = (err: unknown) => this.transitionClosed(String(err))
    ;(this.reader as unknown as { on: (e: string, h: unknown) => void }).on("data", onData as unknown)
    ;(this.reader as unknown as { on: (e: string, h: unknown) => void }).on("end", onEnd as unknown)
    ;(this.reader as unknown as { on: (e: string, h: unknown) => void }).on("close", onClose as unknown)
    ;(this.reader as unknown as { on: (e: string, h: unknown) => void }).on("error", onError as unknown)
    ;(this as unknown as Record<string, unknown>)._onData = onData
    ;(this as unknown as Record<string, unknown>)._onEnd = onEnd
    ;(this as unknown as Record<string, unknown>)._onClose = onClose
    ;(this as unknown as Record<string, unknown>)._onError = onError
  }

  private bindWriter(): void {
    const w = this.writer as unknown as { on?: (e: string, h: (err?: unknown) => void) => void }
    if (!w.on) return
    const onWriterError = (err: unknown) => this.transitionClosed(`writer error: ${String(err)}`)
    const onWriterClose = () => {
      if (this.state !== "open") return
      this.transitionClosed("writer closed")
    }
    try {
      w.on("error", onWriterError as unknown as (e: unknown) => void)
      w.on("close", onWriterClose)
    } catch {
      // Platform does not support writer events — sync write throw remains the fallback
    }
    ;(this as unknown as Record<string, unknown>)._onWriterError = onWriterError
    ;(this as unknown as Record<string, unknown>)._onWriterClose = onWriterClose
  }

  private bindChild(): void {
    if (!this.child) return
    const onExit = () => this.transitionClosed("child exit")
    const onClose = () => this.transitionClosed("child close")
    const onError = () => this.transitionClosed("child error")
    this.child.on("exit", onExit as unknown as () => void)
    this.child.on("close", onClose as unknown as () => void)
    this.child.on("error", onError as unknown as () => void)
    ;(this as unknown as Record<string, unknown>)._childOnExit = onExit
    ;(this as unknown as Record<string, unknown>)._childOnClose = onClose
    ;(this as unknown as Record<string, unknown>)._childOnError = onError
  }

  private unbind(): void {
    try {
      this.unbindReader()
      this.unbindWriter()
      this.unbindChild()
    } catch {
      // ignore
    }
  }

  private unbindReader(): void {
    const onData = (this as unknown as Record<string, unknown>)._onData as ((c: unknown) => void) | undefined
    const onEnd = (this as unknown as Record<string, unknown>)._onEnd as (() => void) | undefined
    const onClose = (this as unknown as Record<string, unknown>)._onClose as (() => void) | undefined
    const onError = (this as unknown as Record<string, unknown>)._onError as (() => void) | undefined
    const r = this.reader as unknown as { removeListener: (e: string, h: unknown) => void; off?: (e: string, h: unknown) => void }
    if (onData) (r.off ?? r.removeListener).call(r, "data", onData)
    if (onEnd) (r.off ?? r.removeListener).call(r, "end", onEnd)
    if (onClose) (r.off ?? r.removeListener).call(r, "close", onClose)
    if (onError) (r.off ?? r.removeListener).call(r, "error", onError)
  }

  private unbindWriter(): void {
    const wErr = (this as unknown as Record<string, unknown>)._onWriterError as ((e: unknown) => void) | undefined
    const wClose = (this as unknown as Record<string, unknown>)._onWriterClose as (() => void) | undefined
    const w = this.writer as unknown as { removeListener?: (e: string, h: unknown) => void; off?: (e: string, h: unknown) => void }
    if (wErr) (w.off ?? w.removeListener)?.call(w, "error", wErr as never)
    if (wClose) (w.off ?? w.removeListener)?.call(w, "close", wClose as never)
  }

  private unbindChild(): void {
    if (!this.child) return
    const cExit = (this as unknown as Record<string, unknown>)._childOnExit as (() => void) | undefined
    const cClose = (this as unknown as Record<string, unknown>)._childOnClose as (() => void) | undefined
    const cErr = (this as unknown as Record<string, unknown>)._childOnError as (() => void) | undefined
    const c = this.child as unknown as { off?: (e: string, h: unknown) => void; removeListener?: (e: string, h: unknown) => void }
    const off = c.off ?? c.removeListener
    if (cExit) off?.call(c, "exit", cExit as never)
    if (cClose) off?.call(c, "close", cClose as never)
    if (cErr) off?.call(c, "error", cErr as never)
  }

  private transitionClosed(_reason: string): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.unbind()
    this.abortAllIncoming()
    this.rejectAllPending("Peer closed")
    this.notifyClosed()
  }

  private notifyClosed(): void {
    if (this.closedNotified) return
    this.closedNotified = true
    try {
      this.onClosed?.()
    } catch {
      // onClosed failures never propagate to transport
    }
  }

  private rejectAllPending(message: string): void {
    const err = makePeerError(ErrorCode.InternalError, message)
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }

  private handleBody(body: string): void {
    // Deterministic malformed framing: decoder emits sentinel for invalid Content-Length.
    // Treat as fatal transport error — send ParseError and close to avoid poisoning next frame.
    if (body === "{ malformed Content-Length") {
      this.sendRaw(makeError(null, ErrorCode.ParseError, "Parse error"))
      this.transitionClosed("malformed framing")
      return
    }
    const parsed = parseMessage(body)
    if (!parsed.ok) {
      this.sendRaw(makeError(null, ErrorCode.ParseError, "Parse error"))
      return
    }
    const obj = parsed.value
    if (isResponse(obj)) {
      this.handleResponse(obj as Record<string, unknown>)
      return
    }
    const validated = validateRequest(obj)
    if (validated.kind === "invalid") {
      this.sendRaw(makeError(validated.id, validated.code, validated.message))
      return
    }
    if (validated.kind === "notification") {
      if (validated.method === CANCEL_REQUEST_METHOD) {
        this.handleCancelNotification(validated.params)
        return
      }
      if (validated.method === REQUEST_EVENT_METHOD) {
        this.handleEventNotification(validated.params)
        return
      }
      this.onNotification?.(validated.method, validated.params)
      return
    }
    this.handleRequest(validated.id, validated.method, validated.params)
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const ctrl = this.claimIncoming(id)
    if (!ctrl) return
    const emit = (event: unknown): boolean => {
      if (this.state !== "open") return false
      if (this.incoming.get(id) !== ctrl) return false
      const payload: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, method: REQUEST_EVENT_METHOD, params: { id, event } }
      const frame = encodeFrame(payload)
      return this.write(frame, null, null)
    }
    const ctx: RequestContext = { id, signal: ctrl.signal, emit }
    try {
    if (method === "initialize") {
      if (this.initialized) {
        this.sendRaw(makeError(id, ErrorCode.InvalidRequest, "Already initialized"))
        return
      }
      if (this.onRequest) {
        try {
          const result = await this.onRequest(method, params, ctx)
          this.initialized = true
          this.sendRaw(makeSuccess(id, result))
        } catch (e) {
          this.sendHandlerError(id, e)
        }
        return
      }
      const result: InitializeResult = {
        protocolVersion: "1.0",
        serverInfo: { name: "kilo-private-worker", version: "7.4.11" },
        capabilities: {},
      }
      this.initialized = true
      this.sendRaw(makeSuccess(id, result))
      return
    }
    if (!this.onRequest) {
      this.sendRaw(makeError(id, ErrorCode.MethodNotFound, `Method not found: ${method}`))
      return
    }
    try {
      const result = await this.onRequest(method, params, ctx)
      this.sendRaw(makeSuccess(id, result))
    } catch (e) {
      this.sendHandlerError(id, e)
    }
    } finally {
      if (this.incoming.get(id) === ctrl) this.incoming.delete(id)
    }
  }

  private handleResponse(obj: Record<string, unknown>): void {
    const id = obj.id as JsonRpcId | null
    if (typeof id !== "string" && typeof id !== "number" && id !== null) return
    if (id === null) return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if ("error" in obj && obj.error !== undefined && obj.error !== null) {
      const err = obj.error as { code?: number; message?: string }
      entry.reject(makePeerError(err.code ?? ErrorCode.InternalError, err.message ?? "Request failed", obj.error))
    } else {
      entry.resolve((obj as { result: unknown }).result)
    }
  }

  private sendRaw(obj: unknown): void {
    if (this.state !== "open") return
    const frame = encodeFrame(obj)
    this.write(frame, null, null)
  }

  private sendHandlerError(id: JsonRpcId, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    const code = responseCode(e)
    const data = (e as { data?: unknown })?.data
    if (data !== undefined) this.sendRaw(makeError(id, code, msg, data))
    else this.sendRaw(makeError(id, code, msg))
  }

  private claimIncoming(id: JsonRpcId): AbortController | null {
    // Active duplicate ownership: the first active handler owns the id. A
    // second active request with the same id is rejected without invoking
    // the domain handler and without touching the first controller. After
    // the first completes, the id may be reused legally. This runs before
    // initialize semantics so a same-id duplicate initialize also reports
    // duplicate ownership; different-id repeat initialize still follows
    // the Already initialized rule in handleRequest.
    if (this.incoming.has(id)) {
      this.sendRaw(makeError(id, ErrorCode.InvalidRequest, "Duplicate active request id"))
      return null
    }
    const ctrl = new AbortController()
    this.incoming.set(id, ctrl)
    return ctrl
  }

  private handleCancelNotification(params: unknown): void {
    const target = parseCancelId(params)
    if (target === undefined) return
    const ctrl = this.incoming.get(target)
    if (!ctrl) return
    if (ctrl.signal.aborted) return
    ctrl.abort()
  }

  private handleEventNotification(params: unknown): void {
    const parsed = parseEventParams(params)
    if (!parsed) return
    const entry = this.pending.get(parsed.id)
    if (!entry?.onEvent) return
    try {
      entry.onEvent(parsed.event)
    } catch {
      // onEvent failures never propagate to transport
    }
  }

  private abortAllIncoming(): void {
    if (this.incoming.size === 0) return
    for (const [, ctrl] of this.incoming) {
      try {
        ctrl.abort()
      } catch {
        // Abort must never break close path
      }
    }
    this.incoming.clear()
  }
}

function isResponse(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false
  const o = obj as Record<string, unknown>
  if (o.jsonrpc !== JSONRPC_VERSION) return false
  if (!("id" in o)) return false
  return "result" in o || "error" in o
}

function makePeerError(code: number, message: string, data?: unknown): Error & { code?: number; data?: unknown } {
  const err = new Error(message) as Error & { code?: number; data?: unknown }
  err.code = code
  if (data !== undefined) err.data = data
  return err
}

function parseCancelId(params: unknown): JsonRpcId | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined
  const keys = Object.keys(params)
  if (keys.length !== 1 || keys[0] !== "id") return undefined
  const raw = (params as Record<string, unknown>).id
  if (typeof raw !== "string" && typeof raw !== "number") return undefined
  return raw
}

function parseEventParams(params: unknown): { id: JsonRpcId; event: unknown } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined
  const o = params as Record<string, unknown>
  if (!("id" in o) || !("event" in o)) return undefined
  const rawId = o.id
  if (typeof rawId !== "string" && typeof rawId !== "number") return undefined
  return { id: rawId as JsonRpcId, event: o.event }
}

function responseCode(e: unknown): number {
  const code = (e as { code?: number })?.code
  if (
    code === ErrorCode.MethodNotFound ||
    code === ErrorCode.InvalidParams ||
    code === ErrorCode.InvalidRequest ||
    code === ErrorCode.ParseError
  )
    return code
  return ErrorCode.InternalError
}
