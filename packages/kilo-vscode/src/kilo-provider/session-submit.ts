// Shared private-first submit core for session prompt/command.
//
// Accepted-only private-first: exactly one private attempt using the durable
// tuple (opId/idempotencyKey/requestId/directory/payload). A validated
// `succeeded`+`accepted` private result returns with zero SDK; a validated
// terminal `failed` (`retryable === false`) throws with zero SDK and zero
// retry; a validated `failed` with `retryable === true` (e.g. config rebuild
// fence such as `InstanceUnavailableDuringConfigRebuild`) takes exactly one
// SDK fallback with no private retry — same-transport retry has no reasonable
// recovery value during the fence and the heterogeneous SDK transport is the
// intended alternate. Pre-send no-private-available also takes exactly one SDK
// dispatch.
//
// Recoverable transport uncertainty (timeout with 3 s exact-cancel/epoch
// invalidation, peer-closed, ambiguous, transportUnknown, invalid wire) never
// retries private and never calls SDK: it re-observes the exact prompt op
// once via the internal `observation/operation` exact opId projection
// (directory+session+opId, panel-safe, no SDK). A matching accepted
// in-flight/succeeded entry returns accepted; a terminal failed/abandoned
// entry surfaces the runtime-owned failure; absent/unavailable/invalid
// returns an explicit unresolved submission failure carrying the stable
// messageId with no redispatch. Absence never fabricates accepted and no
// diagnostic or secret-bearing fields cross this seam. Generation status stays
// owned by CLI runtime `session.status`/`session.error` — this seam never
// posts local status. Callers keep their op-specific payload construction,
// private dispatch methods, SDK fallback endpoint, and exact-op observer.
// Backend first-writer/idempotency replay guarantees no second generation; the
// extension keeps no new persistent state and no new messageID/operation.

interface Handle {
  id: number
  promise: Promise<unknown>
  cancel?: (msg?: string) => boolean
}

interface Dispatch {
  factory: ((req: unknown) => Handle) | null
  direct: ((req: unknown) => Promise<unknown>) | null
  cancel: ((id: number, msg?: string) => boolean) | null
  invalidate: ((reason: string) => void) | null
  peek: (() => number | null) | null
}

interface Result {
  data?: unknown
  error?: unknown
  response?: Response
}

export interface ExactOperation {
  opId: string
  outcome: string
  code: string
  message: string
}

export type ExactAttempt =
  | { kind: "found"; operation: ExactOperation }
  | { kind: "terminal"; error: unknown }
  | { kind: "unavailable" }

interface Input {
  available: () => boolean
  opId: string
  scope: "Prompt" | "Command"
  request: unknown
  dispatch: Dispatch
  validate: (result: unknown) => void
  fallback: () => Promise<Result>
  messageId: string
  observeExact?: () => Promise<ExactAttempt>
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function terminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

function isTerminal(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { terminal?: unknown }).terminal === true
}

function unresolved(scope: "Prompt" | "Command", messageId: string): Error {
  const code = scope === "Prompt" ? "prompt.unresolved" : "command.unresolved"
  const label = scope === "Prompt" ? "Prompt" : "Command"
  return terminal(code, `${label} submission status could not be confirmed (messageId=${messageId}). No retry was issued.`)
}

function isUncertainMessage(msg: string): boolean {
  if (msg.includes("private parity timeout")) return true
  if (msg.includes("Peer closed")) return true
  if (msg.includes("private failed retryable")) return false
  return true
}

// eslint-disable-next-line complexity
export async function submitPrivateFirst(input: Input): Promise<Result> {
  if (!input.available()) {
    return input.fallback()
  }
  const op = input.scope === "Prompt" ? "prompt" : "command"
  let result: unknown
  try {
    const dispatch = input.dispatch
    let handle: Handle | null = null
    let exact: number | null = null
    let promise: Promise<unknown>
    if (dispatch.factory) {
      try {
        const h = dispatch.factory(input.request)
        handle = h
        exact = h.id
        promise = h.promise
      } catch (e) {
        promise = Promise.reject(e)
      }
    } else if (dispatch.direct) {
      exact = dispatch.peek ? dispatch.peek() : null
      promise = dispatch.direct(input.request)
    } else {
      return input.fallback()
    }

    try {
      result = await withTimeout(promise, 3000)
    } catch (e) {
      const msg = String(e)
      if (msg.includes("private parity timeout")) {
        if (handle?.cancel) {
          try {
            handle.cancel(`private parity timeout opId=${input.opId}`)
          } catch {}
        } else if (exact !== null && dispatch.cancel) {
          let cleaned = false
          try {
            cleaned = dispatch.cancel(exact, `private parity timeout opId=${input.opId}`)
          } catch {}
          if (!cleaned && dispatch.invalidate) {
            try {
              dispatch.invalidate(`${op} observer timeout opId=${input.opId}`)
            } catch {}
          }
        } else if (dispatch.invalidate) {
          try {
            dispatch.invalidate(`${op} observer timeout opId=${input.opId}`)
          } catch {}
        }
      }
      throw e
    }
  } catch (e) {
    if (isTerminal(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (!isUncertainMessage(msg) && msg.includes("private failed retryable")) {
      console.warn(`[Kilo ${input.scope}] private fallback to SDK`, { opId: input.opId, reason: msg.slice(0, 120) })
      return input.fallback()
    }
    return reobserve(input, msg)
  }

  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return reobserve(input, "invalid private result")
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      input.validate(result)
    } catch {
      return reobserve(input, "invalid private result")
    }
    return {}
  }
  if (typed.status === "failed") {
    try {
      input.validate(result)
    } catch {
      return reobserve(input, "invalid private result")
    }
    const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true) {
      console.warn(`[Kilo ${input.scope}] private fallback to SDK`, { opId: input.opId, reason: "private failed retryable" })
      return input.fallback()
    }
    if (failure?.retryable === false) {
      const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
      const message = typeof failure?.message === "string" && failure.message ? failure.message : code
      throw terminal(code, message)
    }
    return reobserve(input, "invalid private result")
  }
  return reobserve(input, `private not succeeded: ${String(typed.status)}`)
}

async function reobserve(input: Input, reason: string): Promise<Result> {
  console.warn(`[Kilo ${input.scope}] private uncertain, re-observe exact op`, {
    opId: input.opId,
    reason: reason.slice(0, 120),
  })
  if (!input.observeExact) throw unresolved(input.scope, input.messageId)
  let attempt: ExactAttempt
  try {
    attempt = await input.observeExact()
  } catch {
    throw unresolved(input.scope, input.messageId)
  }
  if (attempt.kind === "found") {
    const entry = attempt.operation
    if (entry.opId !== input.opId) throw unresolved(input.scope, input.messageId)
    if (entry.outcome === "in-flight" || entry.outcome === "succeeded") return {}
    if (entry.outcome === "failed" || entry.outcome === "abandoned") {
      const code = typeof entry.code === "string" && entry.code ? entry.code : "failed"
      const message = typeof entry.message === "string" && entry.message ? entry.message : code
      throw terminal(code, message)
    }
    throw unresolved(input.scope, input.messageId)
  }
  throw unresolved(input.scope, input.messageId)
}
