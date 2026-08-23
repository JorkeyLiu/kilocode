/**
 * R9-C2 bounded persisted-cursor abstraction.
 * Additive, testable, single-integer persistence only.
 * No polling, no background timers, no Failure/Outcome wiring.
 * No global singleton; store is injected per PrivateObservationService instance.
 * Key is namespaced single per DB/store instance.
 */

export const OBSERVATION_CURSOR_KEY = "kilo.privateObservation.cursor" as const

export interface ObservationCursorStore {
  get(): number | undefined
  set(cursor: number): Promise<void> | void
  clear(): Promise<void> | void
}

export interface Memento {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void
}

function isValidCursor(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

export class InMemoryCursorStore implements ObservationCursorStore {
  private cursor: number | undefined

  get(): number | undefined {
    return this.cursor
  }

  set(cursor: number): void {
    if (!isValidCursor(cursor)) throw new Error(`Invalid cursor: ${String(cursor)}`)
    this.cursor = cursor
  }

  clear(): void {
    this.cursor = undefined
  }
}

export function createMementoCursorStore(memento: Memento): ObservationCursorStore {
  // Single fixed key — no arbitrary override, preserves single persisted cursor invariant (R9-C2).
  const key = OBSERVATION_CURSOR_KEY
  return {
    get(): number | undefined {
      const v = memento.get<number>(key)
      return isValidCursor(v) ? v : undefined
    },
    set(cursor: number): Promise<void> | void {
      if (!isValidCursor(cursor)) throw new Error(`Invalid cursor: ${String(cursor)}`)
      const res = memento.update(key, cursor)
      if (res && typeof (res as Promise<void>).then === "function") return res as Promise<void>
      return undefined
    },
    clear(): Promise<void> | void {
      const res = memento.update(key, undefined)
      if (res && typeof (res as Promise<void>).then === "function") return res as Promise<void>
      return undefined
    },
  }
}
