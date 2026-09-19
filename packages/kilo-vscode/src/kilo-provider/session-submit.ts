// Shared private-first submit core for session prompt/command.
//
// Expresses the single accept-or-exactly-once-fallback policy owned by both
// live paths: at most one private attempt plus at most one same-identity SDK
// fallback per call, never retried here. A validated `succeeded`+`accepted`
// private result returns with zero SDK; a validated terminal `failed`
// (`retryable === false`) throws with zero SDK; every other non-terminal
// outcome (retryable failure, invalid/ambiguous result, timeout, peer-closed,
// capability/unavailable, missing private method) takes exactly one
// caller-provided SDK fallback for the same tuple. Generation status stays
// owned by CLI runtime `session.status`/`session.error` — this seam never
// posts local status. Callers keep their op-specific payload construction,
// private dispatch methods, and SDK fallback endpoint.

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

interface Input {
  available: () => boolean
  opId: string
  scope: "Prompt" | "Command"
  request: unknown
  dispatch: Dispatch
  validate: (result: unknown) => void
  fallback: () => Promise<Result>
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

// eslint-disable-next-line complexity
export async function submitPrivateFirst(input: Input): Promise<Result> {
  if (!input.available()) {
    return input.fallback()
  }
  const op = input.scope === "Prompt" ? "prompt" : "command"
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

    let result: unknown
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

    const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
    if (typed.transportUnknown === true) throw new Error("invalid private result")
    if (typed.status === "succeeded" && typed.accepted === true) {
      try {
        input.validate(result)
      } catch {
        throw new Error("invalid private result")
      }
      return {}
    }
    if (typed.status === "failed") {
      try {
        input.validate(result)
      } catch {
        throw new Error("invalid private result")
      }
      const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
      if (failure?.retryable === true)
        throw new Error(`private failed retryable: ${String(typeof failure?.code === "string" ? failure.code : "failed")}`)
      if (failure?.retryable === false) {
        const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
        const message = typeof failure?.message === "string" && failure.message ? failure.message : code
        throw terminal(code, message)
      }
      throw new Error("invalid private result")
    }
    throw new Error(`private not succeeded: ${String(typed.status)}`)
  } catch (e) {
    if (isTerminal(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[Kilo ${input.scope}] private fallback to SDK`, { opId: input.opId, reason: msg.slice(0, 120) })
    return input.fallback()
  }
}
