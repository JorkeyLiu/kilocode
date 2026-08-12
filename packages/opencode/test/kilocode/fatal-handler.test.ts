import { describe, expect, test } from "bun:test"
import type { EventEmitter } from "node:events"
import { installFatalHandlers } from "../../src/kilocode/fatal-handler"

interface Recorder {
  readonly logs: Array<{ kind: string; message: string }>
  readonly exits: number[]
}

function recorder(): Recorder & { readonly install: () => () => void } {
  const logs: Array<{ kind: string; message: string }> = []
  const exits: number[] = []
  return {
    logs,
    exits,
    install: () =>
      installFatalHandlers({
        exit: (code) => {
          exits.push(code)
        },
        log: (kind, message) => {
          logs.push({ kind, message })
        },
      }),
  }
}

const epipe = (): Error => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" })

const emit = (event: "uncaughtException" | "unhandledRejection", err: unknown): void => {
  // process.emit is typed for Signals only; the fatal events are dispatched
  // the same way the runtime dispatches real throws.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  ;(process as unknown as EventEmitter).emit(event, err)
}

describe("installFatalHandlers", () => {
  test("normal fatal uncaughtException logs once, then exits — crash semantics preserved", () => {
    const rec = recorder()
    const stop = rec.install()
    try {
      emit("uncaughtException", new Error("boom"))
      expect(rec.logs).toEqual([{ kind: "exception", message: "boom" }])
      expect(rec.exits).toEqual([1])
    } finally {
      stop()
    }
  })

  test("EPIPE trigger exits without logging — never writes to the broken stream", () => {
    const rec = recorder()
    const stop = rec.install()
    try {
      emit("uncaughtException", epipe())
      expect(rec.logs).toEqual([])
      expect(rec.exits).toEqual([1])
    } finally {
      stop()
    }
  })

  test("EAGAIN trigger exits without logging", () => {
    const rec = recorder()
    const stop = rec.install()
    try {
      const err = Object.assign(new Error("EAGAIN: resource temporarily unavailable"), { code: "EAGAIN" })
      emit("uncaughtException", err)
      expect(rec.logs).toEqual([])
      expect(rec.exits).toEqual([1])
    } finally {
      stop()
    }
  })

  test("a throwing log sink (handler log throw) exits without re-logging", () => {
    const logs: Array<{ kind: string; message: string }> = []
    const exits: number[] = []
    const stop = installFatalHandlers({
      exit: (code) => {
        exits.push(code)
      },
      log: (kind, message) => {
        logs.push({ kind, message })
        throw epipe()
      },
    })
    try {
      emit("uncaughtException", new Error("boom"))
      expect(logs).toEqual([{ kind: "exception", message: "boom" }])
      expect(exits).toEqual([1])
    } finally {
      stop()
    }
  })

  test("re-entrant handler invocation exits without a second log", () => {
    const logs: Array<{ kind: string; message: string }> = []
    const exits: number[] = []
    const stop = installFatalHandlers({
      exit: (code) => {
        exits.push(code)
      },
      log: (kind, message) => {
        logs.push({ kind, message })
        // Simulate the failure path re-entering the handler while it runs.
        process.emit("uncaughtException", epipe())
      },
    })
    try {
      emit("uncaughtException", new Error("boom"))
      // The nested re-entry exits immediately (no second log); the outer frame
      // also exits once the sink returns. The second record is an artifact of
      // the non-terminating test exit mock — in production the first process.exit
      // terminates synchronously. The contract under test: exactly one log, and
      // the process is terminated (never a recursive second log).
      expect(logs).toEqual([{ kind: "exception", message: "boom" }])
      expect(exits.length).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
    }
  })

  test("healthy unhandledRejection logs and continues — not fatal", () => {
    const rec = recorder()
    const stop = rec.install()
    try {
      emit("unhandledRejection", new Error("rejected"))
      expect(rec.logs).toEqual([{ kind: "rejection", message: "rejected" }])
      expect(rec.exits).toEqual([])
    } finally {
      stop()
    }
  })

  test("unhandledRejection on a broken pipe exits without logging", () => {
    const rec = recorder()
    const stop = rec.install()
    try {
      emit("unhandledRejection", epipe())
      expect(rec.logs).toEqual([])
      expect(rec.exits).toEqual([1])
    } finally {
      stop()
    }
  })

  test("stop removes the handlers — later events are untouched", () => {
    const rec = recorder()
    const stop = rec.install()
    stop()
    emit("uncaughtException", new Error("boom"))
    emit("unhandledRejection", new Error("rejected"))
    expect(rec.logs).toEqual([])
    expect(rec.exits).toEqual([])
  })
})
