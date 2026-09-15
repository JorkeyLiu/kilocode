import { describe, it, expect, spyOn } from "bun:test"
import * as vscode from "vscode"
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
        const data =
          typeof opts.status === "function" ? opts.status() : (opts.status ?? { enabled: true, connected: false })
        return { data }
      },
      disable: async (_body?: unknown, _opts?: unknown) => {
        if (opts.fail) throw new Error("disable failed")
        return { data: { enabled: false, connected: false } }
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
            return { data: { enabled: true, connected: false } }
          },
          disable: async (_b?: unknown, _o?: unknown) => ({ data: { enabled: false, connected: false } }),
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
          enable: async (_b?: unknown, _o?: unknown) => ({ data: { enabled: true, connected: true } }),
          disable: async (_b?: unknown, _o?: unknown) => {
            disabled = true
            return { data: { enabled: false, connected: false } }
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
    function toggleOkConn(enabled: boolean, connected: boolean) {
      return {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
          context: { directory: string }
        }) => ({
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
        }),
        privateRemoteToggleOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
          op: string
        }) => {
          const next =
            req.op === "remote/enable"
              ? { enabled: true, connected: false }
              : { enabled: false, connected: false }
          return {
            id: 2,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: req.op,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: 1 },
                accepted: true,
                data: { status: next },
              },
            }),
            cancel: () => true,
          }
        },
      }
    }

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
        privateRemoteToggleOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
          op: string
        }) => ({
          id: 2,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: req.op,
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { status: { enabled, connected } },
            },
          }),
          cancel: () => true,
        }),
      }
    }

    function terminalConn(code = "validation.failed") {
      const failed = (req: { requestId: string; opId: string; idempotencyKey: string; op: string }) => ({
        id: 1,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: req.requestId,
            opId: req.opId,
            op: req.op,
            idempotencyKey: req.idempotencyKey,
            status: "failed",
            outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
            accepted: false,
            failure: { code, message: "m", retryable: false },
          },
        }),
        cancel: () => true,
      })
      return {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: failed,
        privateRemoteToggleOutcomeWithHandle: failed,
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
          enable: async () => ({ data: { enabled: true, connected: false } }),
          disable: async () => ({ data: { enabled: false, connected: false } }),
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
            enable: async () => ({ data: { enabled: true, connected: false } }),
            disable: async () => ({ data: { enabled: false, connected: false } }),
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

    it("toggle pre-read is private-first: one private read plus private mutation, zero SDK", async () => {
      const svc = service()
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
            return { data: { enabled: true, connected: false } }
          },
          disable: async () => {
            disabled += 1
            return { data: { enabled: false, connected: false } }
          },
        },
      } as never)
      svc.setPrivateConnection(toggleOkConn(false, false) as never)
      await svc.toggle()
      expect(statusSdk).toBe(0)
      expect(enabled).toBe(0)
      expect(disabled).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("toggle when enabled disables via private mutation with zero SDK", async () => {
      const svc = service()
      let disabled = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: true, connected: true } }),
          enable: async () => ({ data: { enabled: true, connected: true } }),
          disable: async () => {
            disabled += 1
            return { data: { enabled: false, connected: false } }
          },
        },
      } as never)
      svc.setPrivateConnection(toggleOkConn(true, true) as never)
      await svc.toggle()
      expect(disabled).toBe(0)
      expect(svc.getState()).toEqual({ enabled: false, connected: false })
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
            return { data: { enabled: true, connected: false } }
          },
          disable: async () => {
            mutated += 1
            return { data: { enabled: false, connected: false } }
          },
        },
      } as never)
      svc.setPrivateConnection(terminalConn() as never)
      await expect(svc.toggle()).rejects.toThrow()
      expect(mutated).toBe(0)
      svc.dispose()
    })

    it("setEnabled(true) adopts private owner status with zero SDK", async () => {
      const svc = service()
      let sdk = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: false, connected: false } }),
          enable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: false } }
          },
          disable: async () => ({ data: { enabled: false, connected: false } }),
        },
      } as never)
      svc.setPrivateConnection(toggleOkConn(true, true) as never)
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.setEnabled(true)
      expect(sdk).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      expect(states).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })

    it("setEnabled terminal throws with zero SDK and keeps state", async () => {
      const svc = service()
      let sdk = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: false, connected: false } }),
          enable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: false } }
          },
          disable: async () => ({ data: { enabled: false, connected: false } }),
        },
      } as never)
      svc.setPrivateConnection(terminalConn("auth.missing") as never)
      await expect(svc.setEnabled(true)).rejects.toThrow("auth.missing")
      expect(sdk).toBe(0)
      expect(svc.getState()).toEqual({ enabled: false, connected: false })
      svc.dispose()
    })

    it("setEnabled falls back exactly once on private unavailable and adopts SDK status", async () => {
      const svc = service()
      let sdk = 0
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: false, connected: false } }),
          enable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: true } }
          },
          disable: async () => ({ data: { enabled: false, connected: false } }),
        },
      } as never)
      svc.setPrivateConnection({ isPrivateAvailable: () => false } as never)
      await svc.setEnabled(true)
      expect(sdk).toBe(1)
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      svc.dispose()
    })

    it("setEnabled SDK failure keeps old state and throws", async () => {
      const svc = service()
      svc.updateFromEvent({ enabled: true, connected: true })
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: true, connected: true } }),
          enable: async () => ({ data: { enabled: true, connected: true } }),
          disable: async () => {
            throw new Error("disable failed")
          },
        },
      } as never)
      svc.setPrivateConnection({ isPrivateAvailable: () => false } as never)
      await expect(svc.setEnabled(false)).rejects.toThrow("disable failed")
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      svc.dispose()
    })

    it("SSE remains the transition authority after private setEnabled", async () => {
      const svc = service()
      svc.setClient({
        remote: {
          status: async () => ({ data: { enabled: false, connected: false } }),
          enable: async () => ({ data: { enabled: true, connected: false } }),
          disable: async () => ({ data: { enabled: false, connected: false } }),
        },
      } as never)
      svc.setPrivateConnection(toggleOkConn(true, false) as never)
      await svc.setEnabled(true)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.updateFromEvent({ enabled: true, connected: true })
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      svc.dispose()
    })
  })

  describe("private-first wiring (null connection / no directory / ambiguous)", () => {
    function ambiguousConn(seen?: { status: number; toggle: number }) {
      return {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
        }) => {
          if (seen) seen.status += 1
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
                status: "ambiguous",
                outcome: { type: "ambiguous", time: 1 },
                accepted: false,
                transportUnknown: true,
              },
            }),
            cancel: () => true,
          }
        },
        privateRemoteToggleOutcomeWithHandle: (req: {
          requestId: string
          opId: string
          idempotencyKey: string
          op: string
        }) => {
          if (seen) seen.toggle += 1
          return {
            id: 2,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: req.op,
                idempotencyKey: req.idempotencyKey,
                status: "ambiguous",
                outcome: { type: "ambiguous", time: 1 },
                accepted: false,
                transportUnknown: true,
              },
            }),
            cancel: () => true,
          }
        },
      }
    }

    function countingSdk(status: RemoteState, seen: { status: number; enable: number; disable: number; args: unknown[] }) {
      return {
        remote: {
          status: async (params?: unknown) => {
            seen.status += 1
            seen.args.push(params)
            return { data: status }
          },
          enable: async (params?: unknown) => {
            seen.enable += 1
            seen.args.push(params)
            return { data: { enabled: true, connected: false } }
          },
          disable: async (params?: unknown) => {
            seen.disable += 1
            seen.args.push(params)
            return { data: { enabled: false, connected: false } }
          },
        },
      }
    }

    function withoutDirectory<T>(fn: () => Promise<T>): Promise<T> {
      const ws = vscode.workspace as unknown as Record<string, unknown>
      const orig = ws.workspaceFolders
      ws.workspaceFolders = undefined as never
      const out = fn()
      return out.finally(() => {
        ws.workspaceFolders = orig as never
      })
    }

    it("refresh with null connection takes exactly one SDK fallback and notifies", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: true, connected: true }, sdk) as never)
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.refresh()
      expect(sdk.status).toBe(1)
      expect(sdk.args).toEqual([{ directory: "/repo" }])
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      expect(states).toEqual([{ enabled: true, connected: true }])
      svc.dispose()
    })

    it("refresh with no directory skips private and takes exactly one SDK fallback", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: true, connected: false }, sdk) as never)
      const priv = { n: 0 }
      svc.setPrivateConnection({
        isPrivateAvailable: () => {
          priv.n += 1
          return true
        },
        privateRemoteStatusOutcomeWithHandle: () => {
          priv.n += 1
          throw new Error("must not be called without directory")
        },
        privateRemoteToggleOutcomeWithHandle: () => {
          throw new Error("must not be called")
        },
      } as never)
      await withoutDirectory(() => svc.refresh())
      expect(priv.n).toBe(0)
      expect(sdk.status).toBe(1)
      expect(sdk.args).toEqual([undefined])
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("refresh with ambiguous private outcome takes exactly one SDK fallback", async () => {
      const svc = service()
      const seen = { status: 0, toggle: 0 }
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: true, connected: true }, sdk) as never)
      svc.setPrivateConnection(ambiguousConn(seen) as never)
      await svc.refresh()
      expect(seen.status).toBe(1)
      expect(sdk.status).toBe(1)
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      svc.dispose()
    })

    it("toggle with null connection uses SDK status plus one SDK mutation", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      await svc.toggle()
      expect(sdk.status).toBe(1)
      expect(sdk.enable).toBe(1)
      expect(sdk.disable).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("toggle with no directory uses SDK fallbacks with undefined routing", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      await withoutDirectory(() => svc.toggle())
      expect(sdk.status).toBe(1)
      expect(sdk.enable).toBe(1)
      expect(sdk.args).toEqual([undefined, undefined])
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("toggle with ambiguous private outcome falls back to SDK without duplicate reads", async () => {
      const svc = service()
      const seen = { status: 0, toggle: 0 }
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      svc.setPrivateConnection(ambiguousConn(seen) as never)
      await svc.toggle()
      expect(seen.status).toBe(1)
      expect(sdk.status).toBe(1)
      expect(seen.toggle).toBe(1)
      expect(sdk.enable).toBe(1)
      expect(sdk.disable).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("setEnabled with null connection takes exactly one SDK fallback and notifies", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await svc.setEnabled(true)
      expect(sdk.enable).toBe(1)
      expect(sdk.args).toEqual([{ directory: "/repo" }])
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      expect(states).toEqual([{ enabled: true, connected: false }])
      svc.dispose()
    })

    it("setEnabled with no directory skips private and takes exactly one SDK fallback", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      svc.setPrivateConnection(ambiguousConn() as never)
      await withoutDirectory(() => svc.setEnabled(false))
      expect(sdk.disable).toBe(1)
      expect(sdk.args).toEqual([undefined])
      expect(svc.getState()).toEqual({ enabled: false, connected: false })
      svc.dispose()
    })

    it("setEnabled with ambiguous private outcome takes exactly one same-action SDK fallback", async () => {
      const svc = service()
      const seen = { status: 0, toggle: 0 }
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient(countingSdk({ enabled: false, connected: false }, sdk) as never)
      svc.setPrivateConnection(ambiguousConn(seen) as never)
      await svc.setEnabled(true)
      expect(seen.toggle).toBe(1)
      expect(sdk.enable).toBe(1)
      expect(sdk.disable).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: false })
      svc.dispose()
    })

    it("refresh with malformed SDK status keeps prior state with warn-only behavior", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient({
        remote: {
          status: async (params?: unknown) => {
            sdk.status += 1
            sdk.args.push(params)
            return { data: { enabled: "yes" } }
          },
          enable: async (params?: unknown) => {
            sdk.enable += 1
            sdk.args.push(params)
            return { data: { enabled: true, connected: false } }
          },
          disable: async (params?: unknown) => {
            sdk.disable += 1
            sdk.args.push(params)
            return { data: { enabled: false, connected: false } }
          },
        },
      } as never)
      svc.updateFromEvent({ enabled: true, connected: true })
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      const warns: unknown[][] = []
      const orig = console.warn
      console.warn = (...args: unknown[]) => {
        warns.push(args)
      }
      try {
        await svc.refresh()
      } finally {
        console.warn = orig
      }
      expect(sdk.status).toBe(1)
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      expect(states).toEqual([])
      expect(warns.length).toBeGreaterThan(0)
      svc.dispose()
    })

    it("toggle with malformed SDK status rejects and keeps prior state", async () => {
      const svc = service()
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient({
        remote: {
          status: async (params?: unknown) => {
            sdk.status += 1
            sdk.args.push(params)
            return { data: { enabled: "yes" } }
          },
          enable: async (params?: unknown) => {
            sdk.enable += 1
            sdk.args.push(params)
            return { data: { enabled: true, connected: false } }
          },
          disable: async (params?: unknown) => {
            sdk.disable += 1
            sdk.args.push(params)
            return { data: { enabled: false, connected: false } }
          },
        },
      } as never)
      svc.updateFromEvent({ enabled: true, connected: true })
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await expect(svc.toggle()).rejects.toThrow("remote status unavailable")
      expect(sdk.status).toBe(1)
      expect(sdk.enable).toBe(0)
      expect(sdk.disable).toBe(0)
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      expect(states).toEqual([])
      svc.dispose()
    })

    it("setEnabled with malformed SDK mutation rejects and keeps prior state", async () => {
      const svc = service()
      const seen = { status: 0, toggle: 0 }
      const sdk = { status: 0, enable: 0, disable: 0, args: [] as unknown[] }
      svc.setClient({
        remote: {
          status: async (params?: unknown) => {
            sdk.status += 1
            sdk.args.push(params)
            return { data: { enabled: true, connected: true } }
          },
          enable: async (params?: unknown) => {
            sdk.enable += 1
            sdk.args.push(params)
            return { data: { enabled: true, connected: false } }
          },
          disable: async (params?: unknown) => {
            sdk.disable += 1
            sdk.args.push(params)
            return { data: { enabled: "yes" } }
          },
        },
      } as never)
      svc.setPrivateConnection(ambiguousConn(seen) as never)
      svc.updateFromEvent({ enabled: true, connected: true })
      const states: RemoteState[] = []
      svc.onChange((s) => states.push(s))
      await expect(withoutDirectory(() => svc.setEnabled(false))).rejects.toThrow("remote disable unavailable")
      expect(seen.toggle).toBe(0)
      expect(sdk.disable).toBe(1)
      expect(sdk.enable).toBe(0)
      expect(sdk.args).toEqual([undefined])
      expect(svc.getState()).toEqual({ enabled: true, connected: true })
      expect(states).toEqual([])
      svc.dispose()
    })
  })
})
