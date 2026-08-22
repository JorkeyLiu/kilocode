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

export interface PeerOptions {
  reader: NodeJS.ReadableStream
  writer: NodeJS.WritableStream
  child?: ChildProcess
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
}

export class JsonRpcPeer {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private nextId = 1
  private state: PeerState = "open"
  private readonly writer: NodeJS.WritableStream
  private readonly reader: NodeJS.ReadableStream
  private readonly child?: ChildProcess
  private readonly onRequest?: PeerOptions["onRequest"]
  private readonly onNotification?: PeerOptions["onNotification"]
  private initialized = false

  constructor(opts: PeerOptions) {
    this.reader = opts.reader
    this.writer = opts.writer
    this.child = opts.child
    this.onRequest = opts.onRequest
    this.onNotification = opts.onNotification
    this.bindReader()
    if (this.child) this.bindChild()
  }

  getState(): PeerState {
    return this.state
  }

  isInitialized(): boolean {
    return this.initialized
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== "open") return Promise.reject(makePeerError(ErrorCode.InternalError, "Peer is closed"))
    const id = this.nextId++
    const payload: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method }
    if (params !== undefined) payload.params = params
    const frame = encodeFrame(payload)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(frame, id, reject)
    })
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
    this.rejectAllPending("Peer disposed")
  }

  private write(frame: Buffer, id: JsonRpcId | null, reject: ((e: unknown) => void) | null): void {
    try {
      const ok = (this.writer as unknown as { write: (b: Buffer) => boolean }).write(frame)
      void ok
    } catch (e) {
      if (id !== null && reject) {
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          entry.reject(makePeerError(ErrorCode.InternalError, String(e)))
        }
      }
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
      const onData = (this as unknown as Record<string, unknown>)._onData as ((c: unknown) => void) | undefined
      const onEnd = (this as unknown as Record<string, unknown>)._onEnd as (() => void) | undefined
      const onClose = (this as unknown as Record<string, unknown>)._onClose as (() => void) | undefined
      const onError = (this as unknown as Record<string, unknown>)._onError as (() => void) | undefined
      const r = this.reader as unknown as { removeListener: (e: string, h: unknown) => void; off?: (e: string, h: unknown) => void }
      if (onData) (r.off ?? r.removeListener).call(r, "data", onData)
      if (onEnd) (r.off ?? r.removeListener).call(r, "end", onEnd)
      if (onClose) (r.off ?? r.removeListener).call(r, "close", onClose)
      if (onError) (r.off ?? r.removeListener).call(r, "error", onError)
      if (this.child) {
        const cExit = (this as unknown as Record<string, unknown>)._childOnExit as (() => void) | undefined
        const cClose = (this as unknown as Record<string, unknown>)._childOnClose as (() => void) | undefined
        const cErr = (this as unknown as Record<string, unknown>)._childOnError as (() => void) | undefined
        const c = this.child as unknown as { off?: (e: string, h: unknown) => void; removeListener?: (e: string, h: unknown) => void }
        const off = c.off ?? c.removeListener
        if (cExit) off?.call(c, "exit", cExit as never)
        if (cClose) off?.call(c, "close", cClose as never)
        if (cErr) off?.call(c, "error", cErr as never)
      }
    } catch {
      // ignore
    }
  }

  private transitionClosed(_reason: string): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.unbind()
    this.rejectAllPending("Peer closed")
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
      this.onNotification?.(validated.method, validated.params)
      return
    }
    this.handleRequest(validated.id, validated.method, validated.params)
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (method === "initialize") {
      if (this.initialized) {
        this.sendRaw(makeError(id, ErrorCode.InvalidRequest, "Already initialized"))
        return
      }
      if (this.onRequest) {
        try {
          const result = await this.onRequest(method, params)
          this.initialized = true
          this.sendRaw(makeSuccess(id, result))
        } catch (e) {
          const code = (e as { code?: number })?.code
          const msg = e instanceof Error ? e.message : String(e)
          const outCode =
            code === ErrorCode.MethodNotFound ||
            code === ErrorCode.InvalidParams ||
            code === ErrorCode.InvalidRequest ||
            code === ErrorCode.ParseError
              ? code
              : ErrorCode.InternalError
          this.sendRaw(makeError(id, outCode, msg))
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
      const result = await this.onRequest(method, params)
      this.sendRaw(makeSuccess(id, result))
    } catch (e) {
      const code = (e as { code?: number })?.code
      const msg = e instanceof Error ? e.message : String(e)
      const outCode =
        code === ErrorCode.MethodNotFound ||
        code === ErrorCode.InvalidParams ||
        code === ErrorCode.InvalidRequest ||
        code === ErrorCode.ParseError
          ? code
          : ErrorCode.InternalError
      this.sendRaw(makeError(id, outCode, msg))
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
