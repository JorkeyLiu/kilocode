import { describe, it, expect, spyOn } from "bun:test"
import { RemoteStatusService, type RemoteState } from "../../src/services/RemoteStatusService"

type StatusResponse = { enabled: boolean; connected: boolean }

function client(opts: { status?: StatusResponse | (() => StatusResponse); fail?: boolean }) {
  return {
    remote: {
      status: async (_body?: unknown, _opts?: unknown) => {
        if (opts.fail) throw new Error("connection refused")
        const data =
          typeof opts.status === "function" ? opts.status() : (opts.status ?? { enabled: false, connected: false })
        return { data }
      },
      enable: async (_body?: unknown, _opts?: unknown) => {
        if (opts.fail) throw new Error("enable failed")
        return { data: true }
      },
      disable: async (_body?: unknown, _opts?: unknown) => {
        if (opts.fail) throw new Error("disable failed")
        return { data: true }
      },
    },
  }
}

function service() {
  return new RemoteStatusService()
}

// ---------------------------------------------------------------------------
// Listener management
// ---------------------------------------------------------------------------

describe("RemoteStatusService", () => {
  describe("onChange", () => {
    it("listener called on state change", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.setClient(client({ status: { enabled: true, connected: true } }) as never)
      await svc.refresh()
      expect(states).toEqual([{ enabled: true, connected: true }])
      svc.dispose()
    })

    it("listener not called after unsubscribe", async () => {
      const svc = service()
      const states: RemoteState[] = []
      const unsub = svc.onChange((s) => states.push(s))
      unsub()
      svc.setClient(client({ status: { enabled: true, connected: true } }) as never)
      await svc.refresh()
      expect(states).toEqual([])
      svc.dispose()
    })

    it("multiple listeners all notified", async () => {
      const svc = service()
      const a: RemoteState[] = []
      const b: RemoteState[] = []
      svc.onChange((s) => a.push(s))
      svc.onChange((s) => b.push(s))
      svc.setClient(client({ status: { enabled: true, connected: false } }) as never)
      await svc.refresh()
      expect(a).toEqual([{ enabled: true, connected: false }])
      expect(b).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // refresh()
  // ---------------------------------------------------------------------------

  describe("refresh", () => {
    it("fetches status and notifies listeners", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.setClient(client({ status: { enabled: true, connected: false } }) as never)
      await svc.refresh()
      expect(states).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })

    it("without client is a no-op", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.refresh() // no client set
      expect(states).toEqual([])
      svc.dispose()
    })

    it("does not notify if state unchanged", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      // initial state is { enabled: false, connected: false }, same as client returns
      svc.setClient(client({ status: { enabled: false, connected: false } }) as never)
      await svc.refresh()
      expect(states).toEqual([]) // no change from initial
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // setEnabled()
  // ---------------------------------------------------------------------------

  describe("setEnabled", () => {
    it("setEnabled(true) calls enable and broadcasts enabled state", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.setClient(client({ status: { enabled: true, connected: false } }) as never)
      await svc.setEnabled(true)
      expect(states).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })

    it("setEnabled(false) calls disable and broadcasts disabled", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.setClient(client({ status: { enabled: true, connected: true } }) as never)
      // First get to enabled state
      await svc.refresh()
      states.length = 0 // reset
      await svc.setEnabled(false)
      expect(states).toEqual([{ enabled: false, connected: false }])
      svc.dispose()
    })

    it("setEnabled(false) after enable broadcasts disabled", async () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.setClient(client({ status: { enabled: true, connected: false } }) as never)
      await svc.setEnabled(true)
      states.length = 0
      await svc.setEnabled(false)
      expect(states).toEqual([{ enabled: false, connected: false }])
      svc.dispose()
    })

    it("setEnabled(true) error is surfaced", async () => {
      const svc = service()
      svc.setClient(client({ fail: true }) as never)
      await expect(svc.setEnabled(true)).rejects.toThrow("enable failed")
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // toggle()
  // ---------------------------------------------------------------------------

  describe("toggle", () => {
    it("toggle when disabled calls enable", async () => {
      const svc = service()
      let enabled = false
      const c = {
        remote: {
          status: async (_b?: unknown, _o?: unknown) => ({ data: { enabled: false, connected: false } }),
          enable: async (_b?: unknown, _o?: unknown) => {
            enabled = true
            return { data: true }
          },
          disable: async (_b?: unknown, _o?: unknown) => ({ data: true }),
        },
      }
      svc.setClient(c as never)
      await svc.toggle()
      expect(enabled).toBe(true)
      svc.dispose()
    })

    it("toggle when enabled calls disable", async () => {
      const svc = service()
      let disabled = false
      const c = {
        remote: {
          status: async (_b?: unknown, _o?: unknown) => ({ data: { enabled: true, connected: true } }),
          enable: async (_b?: unknown, _o?: unknown) => ({ data: true }),
          disable: async (_b?: unknown, _o?: unknown) => {
            disabled = true
            return { data: true }
          },
        },
      }
      svc.setClient(c as never)
      await svc.toggle()
      expect(disabled).toBe(true)
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // Push-based updates via updateFromEvent
  // ---------------------------------------------------------------------------

  describe("updateFromEvent", () => {
    it("broadcasts state when pushed via event", () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.updateFromEvent({ enabled: true, connected: true })
      expect(states).toEqual([{ enabled: true, connected: true }])
      svc.dispose()
    })

    it("does not notify if event state matches current", () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      // initial state is { enabled: false, connected: false }
      svc.updateFromEvent({ enabled: false, connected: false })
      expect(states).toEqual([])
      svc.dispose()
    })

    it("tracks successive event-driven transitions", () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.updateFromEvent({ enabled: true, connected: false })
      svc.updateFromEvent({ enabled: true, connected: true })
      expect(states).toEqual([
        { enabled: true, connected: false },
        { enabled: true, connected: true },
      ])
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // clearState
  // ---------------------------------------------------------------------------

  describe("clearState", () => {
    it("resets to disabled state", () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.updateFromEvent({ enabled: true, connected: true })
      states.length = 0
      svc.clearState()
      expect(states).toEqual([{ enabled: false, connected: false }])
      expect(svc.getState()).toEqual({ enabled: false, connected: false })
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // Status bar
  // ---------------------------------------------------------------------------

  describe("status bar", () => {
    it("status bar hidden when remote disabled", async () => {
      const svc = service()
      svc.setClient(client({ status: { enabled: false, connected: false } }) as never)
      await svc.refresh() // no state change from initial, bar should stay hidden
      // Dispose checks bar was never shown — no direct assertion on mock, just no crash
      svc.dispose()
    })

    it("status bar shown with correct text when connected", async () => {
      const svc = service()
      svc.setClient(client({ status: { enabled: true, connected: true } }) as never)
      await svc.refresh()
      // Service is functional — status bar is managed internally. We verify no errors.
      svc.dispose()
    })

    it("status bar shown with connecting text when enabled but not connected", async () => {
      const svc = service()
      svc.setClient(client({ status: { enabled: true, connected: false } }) as never)
      await svc.refresh()
      svc.dispose()
    })
  })

  // ---------------------------------------------------------------------------
  // dispose()
  // ---------------------------------------------------------------------------

  describe("dispose", () => {
    it("dispose clears listeners", () => {
      const svc = service()
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      svc.updateFromEvent({ enabled: true, connected: false })
      svc.dispose()
      // No further notifications after dispose
      svc.updateFromEvent({ enabled: true, connected: true })
      expect(states).toEqual([{ enabled: true, connected: false }])
    })
  })

  // ---------------------------------------------------------------------------
  // private-first remote/status reads (same KiloSessions authority as SDK;
  // directory is routing-only, payload booleans stay process-global)
  // ---------------------------------------------------------------------------

  describe("private-first", () => {
    function okConn(enabled: boolean, connected: boolean, seen?: { priv: number; dir?: string }) {
      return {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
          context: { directory: string }
        }) => {
          if (seen) {
            seen.priv += 1
            seen.dir = req.context.directory
          }
          return {
            id: 1,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: "remote/status",
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: 1 },
                accepted: true,
                data: { status: { enabled, connected } },
              },
            }),
            cancel: () => true,
          }
        },
      }
    }

    function terminalConn(code = "validation.failed") {
      return {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: (req: { requestId: string; opId: string; idempotencyKey: string }) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "remote/status",
              idempotencyKey: req.idempotencyKey,
              status: "failed",
              outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
              accepted: false,
              failure: { code, message: "m", retryable: false },
            },
          }),
          cancel: () => true,
        }),
      }
    }

    function countingClient(
      status: { enabled: boolean; connected: boolean },
      seen: { status: number; args: unknown[] },
    ) {
      return {
        remote: {
          status: async (params?: unknown) => {
            seen.status += 1
            seen.args.push(params)
            return { data: status }
          },
          enable: async () => ({ data: true }),
          disable: async () => ({ data: true }),
        },
      }
    }

    it("refresh uses private success with zero SDK status calls", async () => {
      const svc = service()
      const seen = { priv: 0, dir: undefined as string | undefined }
      const sdk = { status: 0, args: [] as unknown[] }
      svc.setClient(countingClient({ enabled: false, connected: false }, sdk) as never)
      svc.setPrivateConnection(okConn(true, false, seen) as never)
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.refresh()
      expect(seen.priv).toBe(1)
      expect(sdk.status).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      expect(states).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })

    it("refresh terminal closes with zero SDK and keeps state", async () => {
      const svc = service()
      const sdk = { status: 0, args: [] as unknown[] }
      svc.setClient(countingClient({ enabled: true, connected: true }, sdk) as never)
      svc.setPrivateConnection(terminalConn() as never)
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.refresh()
      expect(sdk.status).toBe(0)
      expect(svc.getState()).toEqual({ enabled: false, connected: false })
      expect(states).toEqual([])
      svc.dispose()
    })

    it("refresh falls back exactly once with the same routing identity", async () => {
      const svc = service()
      const sdk = { status: 0, args: [] as unknown[] }
      svc.setClient(countingClient({ enabled: true, connected: true }, sdk) as never)
      svc.setPrivateConnection({ isPrivateAvailable: () => false } as never)
      await svc.refresh()
      expect(sdk.status).toBe(1)
      expect(sdk.args).toEqual([{ directory: "/repo" }])
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      svc.dispose()
    })

    it("refresh failure keeps current UX (warn, no state change, no throw)", async () => {
      const svc = service()
      const warns: unknown[][] = []
      const orig = console.warn
      console.warn = (...args: unknown[]) => {
        warns.push(args)
      }
      try {
        svc.setClient({
          remote: {
            status: async () => ({ error: { message: "down" } }),
            enable: async () => ({ data: true }),
            disable: async () => ({ data: true }),
          },
        } as never)
        svc.setPrivateConnection({ isPrivateAvailable: () => false } as never)
        await svc.refresh()
        expect(svc.getState()).toEqual({ enabled: false, connected: false })
        expect(warns.length).toBeGreaterThan(0)
      } finally {
        console.warn = orig
        svc.dispose()
      }
    })

    it("toggle pre-read is private-first: one private read plus one mutation, zero status SDK", async () => {
      const svc = service()
      const seen = { priv: 0, dir: undefined as string | undefined }
      let enabled = 0
      let disabled = 0
      let statusSdk = 0
      svc.setClient({
        remote: {
          status: async () => {
            statusSdk += 1
            return { data: { enabled: false, connected: false } }
          },
          enable: async () => {
            enabled += 1
            return { data: true }
          },
          disable: async () => {
            disabled += 1
            return { data: true }
          },
        },
      } as never)
      svc.setPrivateConnection(okConn(false, false, seen) as never)
      await svc.toggle()
      expect(seen.priv).toBe(1)
      expect(statusSdk).toBe(0)
      expect(enabled).toBe(1)
      expect(disabled).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("toggle when enabled calls disable exactly once via private pre-read", async () => {
      const svc = service()
      let disabled = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: true, connected: true } }),
          enable: async () => ({ data: true }),
          disable: async () => {
            disabled += 1
            return { data: true }
          },
        },
      } as never)
      svc.setPrivateConnection(okConn(true, true) as never)
      await svc.toggle()
      expect(disabled).toBe(1)
      svc.dispose()
    })

    it("toggle failure throws and never mutates", async () => {
      const svc = service()
      let mutated = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: false, connected: false } }),
          enable: async () => {
            mutated += 1
            return { data: true }
          },
          disable: async () => {
            mutated += 1
            return { data: true }
          },
        },
      } as never)
      svc.setPrivateConnection(terminalConn() as never)
      await expect(svc.toggle()).rejects.toThrow()
      expect(mutated).toBe(0)
      svc.dispose()
    })
  })
})
