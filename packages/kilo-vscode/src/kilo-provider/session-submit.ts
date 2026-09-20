// Shared private-first submit core for session prompt/command.
//
// Expresses the accept-or-at-most-one-private-retry-plus-at-most-one-fallback
// policy owned by both live paths: at most two private attempts using the
// identical durable tuple (opId/idempotencyKey/requestId/directory/payload)
// plus at most one same-identity SDK fallback per call. A validated
// `succeeded`+`accepted` private result returns with zero SDK; a validated
// terminal `failed` (`retryable === false`) throws with zero SDK and zero
// retry; a validated `failed` with `retryable === true` (e.g. config rebuild
// fence such as `InstanceUnavailableDuringConfigRebuild`) takes exactly one
// SDK fallback with no private retry — same-transport retry has no reasonable
// recovery value during the fence and the heterogeneous SDK transport is the
// intended alternate. Every other recoverable transport-uncertainty outcome
// (timeout with 3 s exact-cancel/epoch invalidation, peer-closed, ambiguous,
// transportUnknown, invalid wire) is retried once on the same tuple with the
// same 3 s exact-cancel semantics and no parallelism; second uncertainty then
// takes exactly one caller-provided SDK fallback for the same tuple. Any
// terminal private result (including on the second attempt) never falls back.
// Generation status stays owned by CLI runtime `session.status`/`session.error`
// — this seam never posts local status. Callers keep their op-specific payload
// construction, private dispatch methods, and SDK fallback endpoint. Backend
// first-writer/idempotency replay guarantees no second generation; the
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

function isPrivateRetryEligible(msg: string): boolean {
  if (msg.includes("private failed retryable")) return false
  return true
}

// eslint-disable-next-line complexity
export async function submitPrivateFirst(input: Input): Promise<Result> {
  if (!input.available()) {
    return input.fallback()
  }
  const op = input.scope === "Prompt" ? "prompt" : "command"
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      const retry = isPrivateRetryEligible(msg) && attempt === 0
      if (retry) {
        console.warn(`[Kilo ${input.scope}] private retry same tuple`, {
          opId: input.opId,
          attempt: attempt + 1,
          reason: msg.slice(0, 120),
        })
        continue
      }
      console.warn(`[Kilo ${input.scope}] private fallback to SDK`, {
        opId: input.opId,
        attempt: attempt + 1,
        reason: msg.slice(0, 120),
      })
      return input.fallback()
    }
  }
  return input.fallback()
}
