// kilocode_change - new file
import { Context, Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SessionGeneration } from "@opencode-ai/core/session/generation"

/**
 * Owner-scoped retry budget for one generation.
 *
 * Each generation owns one finite memory budget shared by its nested
 * low-level retries: provider semantic retries (`SessionRetry.policy`),
 * incomplete-response retries (`KiloSessionProcessor.recover`), and
 * pre-exposure broker retries (`CanonicalRequestExecutor` inner loop).
 * Each actual retry attempt charges the owner BEFORE touching the network;
 * an exhausted owner fails closed with the last error and starts no new
 * attempt.
 *
 * Durable binding is explicit: `strict` means the prelude observed a real
 * generation owner row (or a private accepted prompt row, even when the
 * owner is now missing) and every charge must hit that row — missing,
 * closed, exhausted, or DB failure fails closed with no network and no
 * memory fallback, never fabricating a row. `memory` means legacy
 * ownerless (no accepted prompt row, dev/TUI) and charges memory only,
 * never touching the DB. No binding (non-session callers, tests) is also
 * memory only. A terminal/cancelled member row never forges an owner; a
 * truly accepted prompt whose prelude sees terminal simply never admits a
 * retry because the strict charge fails closed.
 *
 * Scoping follows the existing `GenerationAdmissionScope` precedent: the
 * budget plus durable binding travel in the Effect context, never in a
 * process-global map, so cancellation and restart settle them with the owning
 * scope. Each generation provides a fresh budget/row, which shadows any parent
 * budget — a child task generation never consumes its parent's row implicitly.
 * Parent-owned child re-invocations (`KiloTaskRetry.recover`) explicitly charge
 * the parent row via the captured parent binding.
 *
 * The limit is always finite. `KILO_SESSION_RETRY_LIMIT` configures it;
 * the default (2) matches the pre-existing per-kind bounds
 * (`INCOMPLETE_RESPONSE_RETRIES`, `KiloTaskRetry.MAX`, broker
 * `MAX_RETRIES`) and the retry-limit tests, so no large unexplained number
 * is introduced and a configured limit is never relaxed. Only the last
 * charged layer plus the last scheduled occurrence intent are persisted
 * (`retry_layer` provenance + `retry_next_at`), atomically with the shared
 * consumed counter in the same CAS — never a per-attempt ledger, scheduler,
 * or cleanup proof. Close/crash clear the pending `retry_next_at` while
 * retaining `retry_consumed`/last-layer provenance. The legacy
 * `session_operation.recovery_next_at` panel stub stays `null` and is never
 * filled from this owner intent. Close/crash preserve consumed with
 * occurrence vs receipt kept distinct.
 */
export namespace KiloRetryBudget {
  /** Default retries per owner when `KILO_SESSION_RETRY_LIMIT` is unset. */
  export const DEFAULT_LIMIT = 2

  /** Retry layer attribution for durable owner charges. Persisted only as the last layer plus the last scheduled occurrence; never a per-attempt ledger. */
  export type Layer = "provider" | "incomplete" | "broker" | "task" | "restart"

  /** Precomputed schedule intent for one actual retry: failure occurrence time plus next-at occurrence time. */
  export type Schedule = {
    readonly occurrenceTime: number
    readonly nextAt: number
  }

  /** Mutable charge cell. `used` counts charged retries, not the free initial attempt. */
  export type Budget = {
    readonly limit: number
    used: number
  }

  /** Explicit durable kind: `strict` hits the owner row fail-closed, `memory` never touches the DB. */
  export type DurableKind = "strict" | "memory"

  /** Durable owner identity bound in the Effect context alongside the memory budget. */
  export type Binding = {
    readonly db: Parameters<typeof SessionGeneration.charge>[0]
    readonly sessionID: Parameters<typeof SessionGeneration.charge>[1]
    readonly genID: string
    readonly kind: DurableKind
  }

  export function resolveLimit(): number {
    return Flag.KILO_SESSION_RETRY_LIMIT ?? DEFAULT_LIMIT
  }

  export function make(limit?: number): Budget {
    return { limit: Math.max(0, limit ?? resolveLimit()), used: 0 }
  }

  /**
   * Charge one retry against the owner. Returns false when exhausted: the
   * caller must fail closed with the last error and start no new attempt.
   */
  export function charge(budget: Budget): boolean {
    if (budget.used >= budget.limit) return false
    budget.used += 1
    return true
  }

  export function exhausted(budget: Budget): boolean {
    return budget.used >= budget.limit
  }

  /** Ambient owning budget, if the current Effect runs inside a generation. */
  export const Owner = Context.Reference<Budget | undefined>("@kilocode/RetryBudgetOwner", {
    defaultValue: () => undefined,
  })

  /** Ambient durable owner binding, provided with the known gen in the body. */
  export const Durable = Context.Reference<Binding | undefined>("@kilocode/RetryBudgetDurable", {
    defaultValue: () => undefined,
  })

  /**
   * Durable-aware charge for one actual retry (never the free initial attempt).
   * Must run before the next network/tool dispatch.
   *
   * Callers compute `wait` from the existing error/retry-after policy plus the
   * failure occurrence time first, then pass `schedule { occurrenceTime,
   * nextAt = occurrenceTime + wait }` so the DB CAS persists charge + layer +
   * intent atomically; only after CAS success may the caller set/sleep/dispatch.
   * A failed CAS persists nothing and the caller must fail closed with the last
   * error and start no new attempt.
   *
   * - No binding, or `memory` binding (legacy ownerless, no accepted prompt
   *   row): bounded memory charge only, never touches the DB and never
   *   fabricates an owner row. The schedule is irrelevant in-memory.
   * - `strict` binding: single SQLite owner CAS (`retry_consumed <
   *   retry_limit` while open) setting `retry_consumed + 1` plus `retry_layer`
   *   plus `retry_next_at` together. Success syncs the memory mirror monotonically
   *   (`max`, capped by both config and DB limits so a stale read can neither
   *   regress nor fake-exhaust). Missing, exhausted, closed, DB failure, defect,
   *   or invalid schedule fails closed with no new attempt and no memory fallback; an
   *   observed durable count on success/exhaustion/closed only moves the
   *   mirror forward. Cross-identity dies inside `charge` and surfaces here
   *   as fail-closed.
   * - Only the last layer plus the last scheduled occurrence are persisted;
   *   there is no per-layer ledger, scheduler, replay, or cleanup proof.
   */
  export const chargeShared = Effect.fn("KiloRetryBudget.chargeShared")(function* (
    budget: Budget,
    _layer: Layer,
    explicit?: Binding | Schedule | undefined,
    schedule?: Schedule | undefined,
  ) {
    let binding: Binding | undefined
    let intent: Schedule | undefined
    if (explicit && typeof explicit === "object" && !("kind" in explicit) && ("occurrenceTime" in explicit || "nextAt" in explicit)) {
      binding = yield* Durable
      intent = explicit as Schedule
    } else {
      binding = (explicit as Binding | undefined) ?? (yield* Durable)
      intent = schedule
    }
    if (intent !== undefined) {
      if (
        typeof intent.occurrenceTime !== "number" ||
        !Number.isFinite(intent.occurrenceTime) ||
        typeof intent.nextAt !== "number" ||
        !Number.isFinite(intent.nextAt) ||
        intent.nextAt < intent.occurrenceTime
      )
        return false
    }
    if (!binding) return charge(budget)
    if (binding.kind === "memory") return charge(budget)
    const exit = yield* Effect.exit(
      SessionGeneration.charge(binding.db, binding.sessionID, binding.genID, intent ? { layer: _layer, occurrenceTime: intent.occurrenceTime, nextAt: intent.nextAt } : undefined),
    )
    if (exit._tag === "Failure") return false
    const res = exit.value as SessionGeneration.ChargeResult
    if (res.charged) {
      const cap = Math.min(budget.limit, res.limit)
      const sync = Math.min(res.used, cap)
      if (sync > budget.used) budget.used = sync
      return true
    }
    if (res.missing) return false
    if ((res.exhausted || res.closed) && Number.isInteger(res.used) && res.used >= 0) {
      const cap = Math.min(budget.limit, res.limit)
      const sync = Math.min(res.used, cap)
      if (sync > budget.used) budget.used = sync
    }
    return false
  })

  export const exhaustedShared = Effect.fn("KiloRetryBudget.exhaustedShared")(function* (budget: Budget) {
    if (exhausted(budget)) return true
    const binding = yield* Durable
    if (!binding) return exhausted(budget)
    if (binding.kind === "memory") return exhausted(budget)
    const owner = yield* Effect.exit(SessionGeneration.getOwner(binding.db, binding.genID))
    if (owner._tag === "Failure") return true
    const row = owner.value
    if (!row) return true
    if ((row.sessionID as unknown as string) !== (binding.sessionID as unknown as string)) return true
    if (row.used > budget.used) {
      const cap = Math.min(budget.limit, row.limit)
      const sync = Math.min(row.used, cap)
      if (sync > budget.used) budget.used = sync
    }
    return budget.used >= budget.limit || row.used >= row.limit
  })
}
