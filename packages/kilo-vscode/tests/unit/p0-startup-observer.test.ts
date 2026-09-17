import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  P0_CATALOG_LOADED_FIRST,
  P0_CATALOG_PROGRESS_FIRST,
  P0_HTTP_READY,
  createP0StartupObserver,
  fireHttpReadinessProbe,
} from "../../src/perf/p0-startup"
import { loadSessions, type SessionRefreshContext } from "../../src/kilo-provider-utils"

const ROOT = path.resolve(import.meta.dir, "../..")

function ctxWith(
  list: SessionRefreshContext["listSessions"],
  over: Partial<SessionRefreshContext> = {},
): SessionRefreshContext & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    pendingSessionRefresh: false,
    connectionState: "connected",
    listSessions: list,
    loadedCount: 0,
    cursor: null,
    postMessage: (m: unknown) => sent.push(m),
    sent,
    ...over,
  }
}

function item(id: string) {
  return { id, title: id, time: { created: 1, updated: 2 } }
}

function opaque(updated: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, updated, id }), "utf8").toString("base64url")
}

describe("p0 startup observer", () => {
  it("marks http ready once with the session list probe", () => {
    const seen: Array<{ stage: string; extra?: Record<string, unknown> }> = []
    const obs = createP0StartupObserver((stage, extra) => seen.push({ stage, extra }))
    expect(obs.markHttpReady()).toBeTrue()
    expect(obs.markHttpReady()).toBeFalse()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.stage).toBe(P0_HTTP_READY)
    expect(seen[0]!.extra).toMatchObject({ via: "session.list" })
  })

  it("keeps only the first progress and the first loaded across refreshes", () => {
    const seen: Array<{ stage: string; extra?: Record<string, unknown> }> = []
    const obs = createP0StartupObserver((stage, extra) => seen.push({ stage, extra }))
    expect(obs.onCatalogProgress(7, 3)).toBeTrue()
    expect(obs.onCatalogProgress(8, 5)).toBeFalse()
    expect(obs.onCatalogLoaded(7, 10)).toBeTrue()
    expect(obs.onCatalogLoaded(8, 12)).toBeFalse()
    expect(seen.map((s) => s.stage)).toEqual([P0_CATALOG_PROGRESS_FIRST, P0_CATALOG_LOADED_FIRST])
    expect(seen[0]!.extra).toMatchObject({ refreshId: 7, count: 3 })
    expect(seen[1]!.extra).toMatchObject({ refreshId: 7, count: 10 })
  })

  it("reports legacy loaded without an id once", () => {
    const seen: Array<{ stage: string; extra?: Record<string, unknown> }> = []
    const obs = createP0StartupObserver((stage, extra) => seen.push({ stage, extra }))
    expect(obs.onCatalogLoaded(undefined, 2)).toBeTrue()
    expect(obs.onCatalogLoaded(undefined, 2)).toBeFalse()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.extra).toEqual({ count: 2 })
  })
})

describe("loadSessions p0 wiring", () => {
  it("posts per-page progress and one loaded while keeping the wire protocol", async () => {
    const c1 = opaque(20, "ses_page1")
    const pages = [{ sessions: [item("ses_a")], cursor: c1 }, { sessions: [item("ses_b")], cursor: null }]
    let n = 0
    const list = (async () => pages[n++]!) as unknown as SessionRefreshContext["listSessions"]
    const progress: Array<{ id: number; count: number }> = []
    const loaded: Array<{ id: number | undefined; count: number }> = []
    const ctx = ctxWith(list, {
      refreshId: 7,
      p0: {
        onProgress: (id, count) => progress.push({ id, count }),
        onLoaded: (id, count) => loaded.push({ id, count }),
      },
    })
    await loadSessions(ctx)
    expect(ctx.sent.map((m) => (m as { type: string }).type)).toEqual([
      "sessionsProgress",
      "sessionsProgress",
      "sessionsLoaded",
    ])
    expect(progress).toEqual([
      { id: 7, count: 1 },
      { id: 7, count: 1 },
    ])
    expect(loaded).toEqual([{ id: 7, count: 2 }])
    const final = ctx.sent[2] as { refreshId: number; sessions: Array<{ id: string }> }
    expect(final.refreshId).toBe(7)
    expect(final.sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
  })

  it("drains identically without p0 and reports legacy loaded", async () => {
    const list = (async () => ({ sessions: [item("ses_a")], cursor: null })) as unknown as SessionRefreshContext["listSessions"]
    const plain = ctxWith(list)
    await loadSessions(plain)
    expect(plain.sent.map((m) => (m as { type: string }).type)).toEqual(["sessionsLoaded"])

    const seen: Array<{ stage: string; extra?: Record<string, unknown> }> = []
    const obs = createP0StartupObserver((stage, extra) => seen.push({ stage, extra }))
    const legacy = ctxWith(list, {
      p0: {
        onProgress: (id, count) => obs.onCatalogProgress(id, count),
        onLoaded: (id, count) => obs.onCatalogLoaded(id, count),
      },
    })
    await loadSessions(legacy)
    expect(legacy.sent.map((m) => (m as { type: string }).type)).toEqual(["sessionsLoaded"])
    expect(seen.map((s) => s.stage)).toEqual([P0_CATALOG_LOADED_FIRST])
  })

  it("never reports loaded when the drain fails", async () => {
    const list = (async () => {
      throw new Error("backend down")
    }) as unknown as SessionRefreshContext["listSessions"]
    const progress: unknown[] = []
    const loaded: unknown[] = []
    const ctx = ctxWith(list, {
      refreshId: 9,
      p0: {
        onProgress: (id: number, count: number) => progress.push([id, count]),
        onLoaded: (id: number | undefined, count: number) => loaded.push([id, count]),
      },
    })
    await expect(loadSessions(ctx)).rejects.toThrow("backend down")
    expect(loaded).toEqual([])
    expect(progress).toEqual([])
    expect(ctx.sent.some((m) => (m as { type: string }).type === "sessionsLoaded")).toBeFalse()
  })
})

describe("fireHttpReadinessProbe", () => {
  it("initiates one limit-1 list synchronously and marks on REST success", async () => {
    let resolveList!: (v: unknown) => void
    const pending = new Promise<unknown>((r) => {
      resolveList = r
    })
    const seenArgs: unknown[] = []
    const seenOpts: unknown[] = []
    const fake = {
      experimental: {
        session: {
          list: (args: unknown, opts: unknown) => {
            seenArgs.push(args)
            seenOpts.push(opts)
            return pending
          },
        },
      },
    }
    let marked = 0
    const out = fireHttpReadinessProbe(
      fake as unknown as Parameters<typeof fireHttpReadinessProbe>[0],
      "/repo",
      () => {
        marked++
      },
    )
    expect(out).toBeUndefined()
    // Initiated before the promise settles: non-blocking by construction.
    expect(seenArgs).toEqual([{ directory: "/repo", limit: 1 }])
    expect(seenOpts).toEqual([{ throwOnError: true }])
    expect(marked).toBe(0)
    resolveList({ data: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(marked).toBe(1)
  })

  it("swallows REST failure without marking or throwing", async () => {
    const fake = {
      experimental: {
        session: {
          list: async () => {
            throw new Error("down")
          },
        },
      },
    }
    let marked = 0
    fireHttpReadinessProbe(
      fake as unknown as Parameters<typeof fireHttpReadinessProbe>[0],
      "/repo",
      () => {
        marked++
      },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(marked).toBe(0)
  })
})

describe("http probe call sites", () => {
  const svc = fs.readFileSync(path.join(ROOT, "src/services/cli-backend/connection-service.ts"), "utf-8")
  const kilo = fs.readFileSync(path.join(ROOT, "src/KiloProvider.ts"), "utf-8")

  it("fires before the SSE connect/wait inside doConnect and never awaits", () => {
    const body = svc.slice(svc.indexOf("private async doConnect"))
    const probeAt = body.indexOf("this.observeHttpReadiness(client, workspaceDir)")
    const sseAt = body.indexOf("sse.connect()")
    const waitAt = body.indexOf("await connectedPromise")
    expect(probeAt).toBeGreaterThan(-1)
    expect(sseAt).toBeGreaterThan(-1)
    expect(waitAt).toBeGreaterThan(-1)
    expect(probeAt).toBeLessThan(sseAt)
    expect(sseAt).toBeLessThan(waitAt)
    expect(body).not.toContain("await this.observeHttpReadiness")
  })

  it("is owned once by the connection service, gated, silent on failure", () => {
    expect(svc).toContain("private p0 = createP0StartupObserver()")
    const start = svc.indexOf("private observeHttpReadiness")
    const end = svc.indexOf("\n  private async doConnect", start)
    const method = svc.slice(start, end === -1 ? undefined : end)
    expect(method).toContain("if (!isP0PerfEnabled()) return")
    expect(method).toContain("fireHttpReadinessProbe")
    expect(method).toContain("this.p0.markHttpReady()")
    expect(method).not.toContain("await")
  })

  it("no longer probes from KiloProvider after connect", () => {
    expect(kilo).not.toContain("observeHttpReadiness")
    expect(kilo).not.toContain("markHttpReady")
  })
})
