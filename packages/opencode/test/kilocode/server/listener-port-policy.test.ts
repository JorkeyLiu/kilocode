import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { Context, Effect, Layer } from "effect"
import { Server } from "../../../src/server/server"
import { resolveNetworkOptionsNoConfig } from "../../../src/cli/network"
import { AppLayer } from "../../../src/effect/app-runtime"
import { withTimeout } from "../../../src/util/timeout"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

function args(port = 0) {
  return {
    port,
    hostname: "127.0.0.1",
    mdns: false,
    "mdns-domain": "kilo.local",
    cors: [] as string[],
  }
}

// The bind-conflict failure surfaces as `ServeError` with the structured
// Node `code: "EADDRINUSE"` on its cause chain (see server.ts
// `isBindConflict`); the top-level message alone does not carry it.
function hasBindCode(err: unknown): boolean {
  let cur: unknown = err
  const seen = new Set<unknown>()
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur)
    const rec = cur as { code?: unknown; cause?: unknown; error?: unknown; defect?: unknown }
    if (rec.code === "EADDRINUSE") return true
    const next = rec.cause ?? rec.error ?? rec.defect
    if (next === null || next === undefined || typeof next !== "object") return false
    cur = next
  }
  return false
}

function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

function occupyPort(port: number) {
  return new Promise<net.Server | undefined>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

function closeBlocker(blocker: net.Server | undefined) {
  if (!blocker) return Promise.resolve()
  return new Promise<void>((resolve) => blocker.close(() => resolve()))
}

class Probe extends Context.Service<Probe, { n: number }>()("test/port-policy-probe") {}

// Single-build proof for the explicit-0 path: the custom app carries one
// requirement-free fresh node; a fallback retry would construct it twice.
// (Unrequired output nodes are still constructed by the app build — the
// previous Maintenance-based counter failed only on unmet Database
// requirements, proving the build reaches custom nodes.)
function countedApp(counter: { builds: number }) {
  const probe = Layer.fresh(
    Layer.effect(
      Probe,
      Effect.sync(() => {
        counter.builds += 1
        return { n: counter.builds }
      }),
    ),
  )
  return Layer.mergeAll(AppLayer, probe)
}

describe("Server.listen port policy", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("omitted CLI port maps to the 4096-first fallback", () => {
    const resolved = resolveNetworkOptionsNoConfig({ ...args(0) })
    expect(resolved.port).toBe(0)
    expect(resolved.fallback).toBe(true)
  })

  test("configured server port binds exactly with no fallback", () => {
    const config = { server: { port: 5000 } } as unknown as ConfigV1.Info
    const resolved = resolveNetworkOptionsNoConfig({ ...args(0) }, config)
    expect(resolved.port).toBe(5000)
    expect(resolved.fallback).toBe(false)
  })

  test("explicit --port 0 binds exactly with no fallback", () => {
    process.argv.push("--port=0")
    try {
      const resolved = resolveNetworkOptionsNoConfig({ ...args(0) })
      expect(resolved.port).toBe(0)
      expect(resolved.fallback).toBe(false)
    } finally {
      process.argv.pop()
    }
  })

  test(
    "explicit port 0 binds ephemeral with one app build while 4096 is occupied",
    async () => {
      await using tmp = await tmpdir({ git: true })
      // Occupied either by this blocker or by an external owner; either way
      // the direct-0 path must not touch 4096 and must build the app once.
      const blocker = await occupyPort(4096)
      const counter = { builds: 0 }
      const listener = await Server.listen({
        hostname: "127.0.0.1",
        port: 0,
        appLayer: countedApp(counter) as never,
      })
      try {
        expect(listener.port).not.toBe(4096)
        expect(listener.port).toBeGreaterThan(0)
        expect(counter.builds).toBe(1)
        const response = await fetch(new URL("/session/status", listener.url), {
          headers: { "x-kilo-directory": tmp.path },
        })
        expect(response.status).toBe(200)
      } finally {
        await withTimeout(listener.stop(true), 10_000, "stop explicit-0 listener").catch(() => undefined)
        await closeBlocker(blocker)
      }
    },
    { timeout: 60_000 },
  )

  test(
    "fallback port 0 prefers 4096 when free, else ephemeral",
    async () => {
      const free = await isPortFree(4096)
      const blocker = free ? undefined : await occupyPort(4096)
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fallback: true })
      try {
        if (free) expect(listener.port).toBe(4096)
        else {
          expect(listener.port).not.toBe(4096)
          expect(listener.port).toBeGreaterThan(0)
        }
      } finally {
        await withTimeout(listener.stop(true), 10_000, "stop fallback listener").catch(() => undefined)
        await closeBlocker(blocker)
      }
    },
    { timeout: 60_000 },
  )

  test(
    "explicit nonzero port rejects on conflict, even with fallback set",
    async () => {
      const blocker = await occupyPort(0)
      if (!blocker) return
      const address = blocker.address()
      const taken = typeof address === "object" && address !== null ? address.port : undefined
      if (!taken) {
        await closeBlocker(blocker)
        return
      }
      try {
        for (const opts of [
          { hostname: "127.0.0.1", port: taken },
          { hostname: "127.0.0.1", port: taken, fallback: true },
        ] as const) {
          let err: unknown
          try {
            const listener = await Server.listen(opts)
            await withTimeout(listener.stop(true), 10_000, "stop conflict listener").catch(() => undefined)
          } catch (e) {
            err = e
          }
          expect(err, `listen on taken port ${taken} must reject`).toBeDefined()
          expect(hasBindCode(err)).toBe(true)
        }
      } finally {
        await closeBlocker(blocker)
      }
    },
    { timeout: 60_000 },
  )

  test(
    "fallback path does not retry arbitrary startup failures",
    async () => {
      let builds = 0
      const dying = Layer.effectDiscard(
        Effect.sync(() => {
          builds += 1
        }).pipe(Effect.andThen(Effect.die(new Error("boom-not-bind")))),
      )
      const appLayer = Layer.mergeAll(AppLayer, dying)
      await expect(
        Server.listen({ hostname: "127.0.0.1", port: 0, fallback: true, appLayer: appLayer as never }),
      ).rejects.toThrow("boom-not-bind")
      expect(builds).toBe(1)
    },
    { timeout: 60_000 },
  )
})
