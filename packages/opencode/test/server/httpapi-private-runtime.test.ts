import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as http from "node:http"
import * as os from "os"
import * as path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../src/server/server"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { resolveNetworkOptionsNoConfig } from "../../src/cli/network"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const auth = { username: "kilo", password: "private-secret-123" }

type Snapshot = {
  KILO_PRIVATE_RUNTIME: string | undefined
  KILO_SERVER_PASSWORD: string | undefined
  envPassword: string | undefined
  KILO_SERVER_USERNAME: string | undefined
  envUsername: string | undefined
  KILO_DB: string | undefined
  envDb: string | undefined
}

let snapshot: Snapshot

beforeEach(() => {
  snapshot = {
    KILO_PRIVATE_RUNTIME: process.env.KILO_PRIVATE_RUNTIME,
    KILO_SERVER_PASSWORD: Flag.KILO_SERVER_PASSWORD,
    envPassword: process.env.KILO_SERVER_PASSWORD,
    KILO_SERVER_USERNAME: Flag.KILO_SERVER_USERNAME,
    envUsername: process.env.KILO_SERVER_USERNAME,
    KILO_DB: (Flag as unknown as Record<string, unknown>).KILO_DB as string | undefined,
    envDb: process.env.KILO_DB,
  }
})

function setPrivateEnv() {
  process.env.KILO_PRIVATE_RUNTIME = "1"
  // Flag.KILO_PRIVATE_RUNTIME is a getter reading env, no need to set
}

function clearPrivateEnv() {
  delete process.env.KILO_PRIVATE_RUNTIME
}

function setAuth() {
  Flag.KILO_SERVER_PASSWORD = auth.password
  Flag.KILO_SERVER_USERNAME = auth.username
  process.env.KILO_SERVER_PASSWORD = auth.password
  process.env.KILO_SERVER_USERNAME = auth.username
}

function clearAuth() {
  Flag.KILO_SERVER_PASSWORD = undefined as unknown as string
  Flag.KILO_SERVER_USERNAME = undefined as unknown as string
  delete process.env.KILO_SERVER_PASSWORD
  delete process.env.KILO_SERVER_USERNAME
}

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function stopListener(listener: Awaited<ReturnType<typeof Server.listen>>, label: string) {
  return withTimeout(listener.stop(true), 10_000, label)
}

afterEach(async () => {
  if (snapshot.KILO_PRIVATE_RUNTIME === undefined) delete process.env.KILO_PRIVATE_RUNTIME
  else process.env.KILO_PRIVATE_RUNTIME = snapshot.KILO_PRIVATE_RUNTIME
  Flag.KILO_SERVER_PASSWORD = snapshot.KILO_SERVER_PASSWORD as unknown as string
  Flag.KILO_SERVER_USERNAME = snapshot.KILO_SERVER_USERNAME as unknown as string
  if (snapshot.envPassword === undefined) delete process.env.KILO_SERVER_PASSWORD
  else process.env.KILO_SERVER_PASSWORD = snapshot.envPassword
  if (snapshot.envUsername === undefined) delete process.env.KILO_SERVER_USERNAME
  else process.env.KILO_SERVER_USERNAME = snapshot.envUsername
  if (snapshot.envDb === undefined) delete process.env.KILO_DB
  else process.env.KILO_DB = snapshot.envDb
  ;(Flag as unknown as Record<string, unknown>).KILO_DB = snapshot.KILO_DB
  await disposeAllInstances()
  await resetDatabase()
})

describe.serial("private runtime network boundary", () => {
  test.serial("resolveNetworkOptionsNoConfig forces loopback/ephemeral/no mdns/no cors when config wants LAN", async () => {
    setPrivateEnv()
    const out = resolveNetworkOptionsNoConfig(
      { port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "kilo.local", cors: [] },
      { server: { hostname: "0.0.0.0", port: 8765, mdns: true, cors: ["https://evil.example"] } as never },
    )
    expect(out.hostname).toBe("127.0.0.1")
    expect(out.port).toBe(0)
    expect(out.mdns).toBe(false)
    expect(out.cors).toEqual([])
    expect(out.fallback).toBe(false)
    clearPrivateEnv()
    const pub = resolveNetworkOptionsNoConfig(
      { port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "kilo.local", cors: [] },
      { server: { hostname: "0.0.0.0", port: 8765, mdns: true, cors: ["https://evil.example"] } as never },
    )
    // public must respect config, not forced
    expect(pub.hostname).toBe("0.0.0.0")
    expect(pub.port).toBe(8765)
    expect(pub.mdns).toBe(true)
    expect(pub.cors).toEqual(["https://evil.example"])
  })

  test.serial("private mode forces Server.listen loopback/ephemeral/no mdns even when caller asks LAN", async () => {
    await using tmp = await tmpdir()
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-private-db-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    setPrivateEnv()
    setAuth()
    // Ask for LAN explicitly — private must override to loopback/ephemeral
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 8765, mdns: true, cors: ["https://evil.example"], mdnsDomain: "kilo.local" } as never)
    try {
      expect(listener.hostname).toBe("127.0.0.1")
      expect(listener.port).not.toBe(8765)
      expect(listener.port).toBeGreaterThan(0)
      expect(listener.url.hostname).toBe("127.0.0.1")
      // urls.bind should be loopback, not network
      expect(listener.urls.bind).toContain("127.0.0.1")
      expect(listener.urls.network).toBeUndefined()
    } finally {
      await stopListener(listener, "private loopback listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("private mode fail-closed if password missing/empty", async () => {
    await using tmp = await tmpdir()
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-private-nopw-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    setPrivateEnv()
    clearAuth()
    // missing
    await expect(Server.listen({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow(/KILO_PRIVATE_RUNTIME requires KILO_SERVER_PASSWORD/)
    // empty string
    Flag.KILO_SERVER_PASSWORD = "" as unknown as string
    process.env.KILO_SERVER_PASSWORD = ""
    await expect(Server.listen({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow(/KILO_PRIVATE_RUNTIME requires KILO_SERVER_PASSWORD/)
    fs.rmSync(dbDir, { recursive: true, force: true })
  })

  test.serial("private mode unauth 401 / auth SSE / legacy 410 / ordinary route still works", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-private-auth-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    setPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      // unauth -> 401 for protected global/event
      const unauth = await fetch(new URL("/global/event", listener.url), { headers: {} })
      expect(unauth.status).toBe(401)

      // auth SSE works
      const authed = await fetch(new URL("/global/event", listener.url), {
        headers: { authorization: authorization(), accept: "text/event-stream" },
      })
      // SSE returns 200 with event-stream
      expect(authed.status).toBe(200)
      const ct = authed.headers.get("content-type") ?? ""
      expect(ct).toContain("text/event-stream")
      // consume body to close
      await authed.body?.cancel()

      // legacy routes must be 410 even with auth
      for (const p of ["/sync/start?directory=" + encodeURIComponent(tmp.path), "/sync/replay?directory=" + encodeURIComponent(tmp.path), "/experimental/workspace/warp?directory=" + encodeURIComponent(tmp.path), "/api/workspace/warp"]) {
        const res = await fetch(new URL(p, listener.url), {
          method: "POST",
          headers: { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(410)
        const body = await res.json().catch(() => null) as unknown
        expect(JSON.stringify(body)).toContain("Gone")
      }
      // GET legacy also 410
      const getSync = await fetch(new URL("/sync/history?directory=" + encodeURIComponent(tmp.path), listener.url), {
        headers: { authorization: authorization(), "x-kilo-directory": tmp.path },
      })
      expect(getSync.status).toBe(410)

      // ordinary internal route still works
      const doc = await fetch(new URL("/doc", listener.url), { headers: { authorization: authorization() } })
      expect(doc.status).toBe(200)
      const globalCfg = await fetch(new URL("/global/config", listener.url), { headers: { authorization: authorization() } })
      expect(globalCfg.status).toBe(200)

      // authenticated WebSocket (PTY) still works
      if (process.platform !== "win32") {
        const create = await fetch(new URL(PtyPaths.create, listener.url), {
          method: "POST",
          headers: { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" },
          body: JSON.stringify({ command: "/bin/cat", title: "private-ws" }),
        })
        expect(create.status).toBe(200)
        const info = await create.json() as { id: string }
        const ticketRes = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", info.id), listener.url), {
          method: "POST",
          headers: { authorization: authorization(), "x-kilo-directory": tmp.path, "x-kilo-ticket": "1" },
        })
        expect(ticketRes.status).toBe(200)
        const ticket = await ticketRes.json() as { ticket: string }
        const url = new URL(PtyPaths.connect.replace(":ptyID", info.id), listener.url)
        url.protocol = "ws:"
        url.searchParams.set("directory", tmp.path)
        url.searchParams.set("cursor", "-1")
        url.searchParams.set("ticket", ticket.ticket)
        const ws = new WebSocket(url)
        await withTimeout(new Promise<void>((res, rej) => { ws.addEventListener("open", () => res(), { once: true }); ws.addEventListener("error", () => rej(new Error("ws open failed")), { once: true }) }), 5_000, "ws open")
        ws.close(1000)
        await withTimeout(new Promise<void>((res) => ws.addEventListener("close", () => res(), { once: true })), 5_000, "ws close")
      }
    } finally {
      await stopListener(listener, "private auth/legacy listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("public (non-private) legacy routes are not forced to 410", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-public-legacy-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    clearPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const res = await fetch(new URL("/sync/start?directory=" + encodeURIComponent(tmp.path), listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "x-kilo-directory": tmp.path },
      })
      // Should NOT be 410 in public mode (could be 200 or 400 depending on workspace, but not Gone)
      expect(res.status).not.toBe(410)
    } finally {
      await stopListener(listener, "public legacy check stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("private mode raw bypass variants return 410 via raw Node http (handler not reached) and benign preserved", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-private-raw-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    setPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const dirParam = encodeURIComponent(tmp.path)
    function rawRequest(rawPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: listener.port,
            method,
            path: rawPath,
            headers,
          },
          (res) => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", (chunk) => (data += chunk))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }))
          },
        )
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
      })
    }
    try {
      const authHeaders = { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" }
      // Dynamically proven bypass variants (these were 200/400 before fix, must now be 410). Use raw http path to avoid fetch normalization.
      const bypass410: Array<{ path: string; method: string }> = [
        { path: `/%73ync/start?directory=${dirParam}`, method: "POST" },
        { path: `/%53ync/start?directory=${dirParam}`, method: "POST" },
        { path: `/SYNC/start?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start/?directory=${dirParam}`, method: "POST" },
        { path: `/sync//start?directory=${dirParam}`, method: "POST" },
        { path: `/sync/./start?directory=${dirParam}`, method: "POST" },
        { path: `/sync/../sync/start?directory=${dirParam}`, method: "POST" },
        { path: `/%2573ync/start?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp/?directory=${dirParam}`, method: "POST" },
        { path: `/experimental//workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace//warp?directory=${dirParam}`, method: "POST" },
        { path: `/%65xperimental/workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/%45xperimental/workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/EXPERIMENTAL/WORKSPACE/WARP?directory=${dirParam}`, method: "POST" },
        { path: `/EXPERIMENTAL/workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/api/workspace/warp/?directory=${dirParam}`, method: "POST" },
        { path: `/api//workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/%61pi/workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/API/workspace/warp?directory=${dirParam}`, method: "POST" },
        { path: `/API/WORKSPACE/WARP?directory=${dirParam}`, method: "POST" },
        { path: `/sync?directory=${dirParam}`, method: "GET" },
        { path: `/SYNC?directory=${dirParam}`, method: "GET" },
        { path: `/sync/?directory=${dirParam}`, method: "GET" },
        { path: `/%73ync?directory=${dirParam}`, method: "GET" },
        { path: `/sync/history?directory=${dirParam}`, method: "POST" },
        { path: `/SYNC/history?directory=${dirParam}`, method: "POST" },
        { path: `/%73ync/history?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of bypass410) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `raw bypass ${v.method} ${v.path}`)
        expect(res.status).toBe(410)
        expect(res.text).toContain("Gone")
      }
      // Encoded slash / malformed must not reach handler (safe 410 or 400, never 200)
      const encodedSlashVariants: Array<{ path: string; method: string }> = [
        { path: `/sync%2fstart?directory=${dirParam}`, method: "POST" },
        { path: `/sync%2Fstart?directory=${dirParam}`, method: "POST" },
        { path: `/experimental%2Fworkspace%2Fwarp?directory=${dirParam}`, method: "POST" },
        { path: `/api%2Fworkspace%2Fwarp?directory=${dirParam}`, method: "POST" },
        { path: `/%2fexperimental/workspace/warp?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of encodedSlashVariants) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `encoded slash ${v.path}`)
        expect([400, 410]).toContain(res.status)
        expect(res.text).not.toContain(`"sync"`)
      }
      const malformedVariants: Array<{ path: string; method: string }> = [
        { path: `/%zzync/start?directory=${dirParam}`, method: "POST" },
        { path: `/%2ync/start?directory=${dirParam}`, method: "POST" },
        { path: `/sync/%?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of malformedVariants) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `malformed ${v.path}`)
        expect([400, 410]).toContain(res.status)
      }

      // Benign non-legacy routes must not be 410 (handler reachable)
      const benign = [
        { path: `/doc`, method: "GET" },
        { path: `/global/config`, method: "GET" },
        { path: `/session?directory=${dirParam}`, method: "GET" },
        { path: `/file/status?path=.&directory=${dirParam}`, method: "GET" },
        { path: `/config?directory=${dirParam}`, method: "GET" },
      ]
      for (const v of benign) {
        const res = await withTimeout(
          rawRequest(v.path, v.method, { authorization: authorization(), "x-kilo-directory": tmp.path }),
          5_000,
          `benign ${v.method} ${v.path}`,
        )
        expect(res.status).not.toBe(410)
        // also not 400 malformed
        expect(res.status).not.toBe(400)
      }
      // Positive: fetch still works for ordinary route (sanity)
      const doc = await fetch(new URL("/doc", listener.url), { headers: { authorization: authorization() } })
      expect(doc.status).toBe(200)
    } finally {
      await stopListener(listener, "private raw bypass listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("public mode raw bypass variants not forced to 410 via raw http", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-public-raw-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    clearPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const dirParam = encodeURIComponent(tmp.path)
    function rawRequest(rawPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: listener.port, method, path: rawPath, headers },
          (res) => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", (c) => (data += c))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }))
          },
        )
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
      })
    }
    try {
      const authHeaders = { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" }
      const variants = [
        `/%73ync/start?directory=${dirParam}`,
        `/SYNC/start?directory=${dirParam}`,
        `/experimental/workspace/warp/?directory=${dirParam}`,
        `/%65xperimental/workspace/warp?directory=${dirParam}`,
        `/experimental//workspace/warp?directory=${dirParam}`,
      ]
      for (const p of variants) {
        const res = await withTimeout(rawRequest(p, "POST", authHeaders, JSON.stringify({})), 5_000, `public raw ${p}`)
        expect(res.status).not.toBe(410)
      }
    } finally {
      await stopListener(listener, "public raw bypass listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("private mode semicolon matrix-param bypass blocked via raw Node http and benign semicolon preserved", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-private-semi-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    setPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const dirParam = encodeURIComponent(tmp.path)
    function rawRequest(rawPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: listener.port, method, path: rawPath, headers },
          (res) => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", (c) => (data += c))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }))
          },
        )
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
      })
    }
    try {
      const authHeaders = { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" }
      const core410: Array<{ path: string; method: string }> = [
        { path: `/sync/start;foo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start;foo`, method: "POST" },
        { path: `/experimental/workspace/warp;jsessionid=1?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp;jsessionid=1`, method: "POST" },
        { path: `/experimental/workspace/warp;jsessionid=1`, method: "GET" },
        { path: `/api/workspace/warp;jsessionid=1?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of core410) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `semi core ${v.method} ${v.path}`)
        expect(res.status).toBe(410)
        expect(res.text).toContain("Gone")
      }
      const encoded410: Array<{ path: string; method: string }> = [
        { path: `/sync/start%3bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start%3Bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start%253bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start%253Bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start%25253bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp%3bjsessionid=1?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp%3Bjsessionid=1?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp%253bjsessionid=1?directory=${dirParam}`, method: "POST" },
        { path: `/experimental/workspace/warp%253Bjsessionid=1?directory=${dirParam}`, method: "POST" },
        { path: `/api/workspace/warp%3bfoo?directory=${dirParam}`, method: "POST" },
        { path: `/api/workspace/warp%253bfoo?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of encoded410) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `semi encoded ${v.path}`)
        expect(res.status).toBe(410)
        expect(res.text).toContain("Gone")
      }
      const extra410: Array<{ path: string; method: string }> = [
        { path: `/sync;foo?directory=${dirParam}`, method: "GET" },
        { path: `/sync/;foo?directory=${dirParam}`, method: "POST" },
        { path: `/sync/start;?directory=${dirParam}`, method: "POST" },
        { path: `/SYNC/start;foo?directory=${dirParam}`, method: "POST" },
      ]
      for (const v of extra410) {
        const res = await withTimeout(rawRequest(v.path, v.method, authHeaders, JSON.stringify({})), 5_000, `semi extra ${v.path}`)
        expect(res.status).toBe(410)
        expect(res.text).toContain("Gone")
      }
      const slashSemi = await withTimeout(rawRequest(`/sync%2fstart;foo?directory=${dirParam}`, "POST", authHeaders, JSON.stringify({})), 5_000, "slash semi")
      expect([400, 410]).toContain(slashSemi.status)
      expect(slashSemi.text).not.toContain(`"sync"`)

      const benign: Array<{ path: string; method: string }> = [
        { path: `/doc;foo`, method: "GET" },
        { path: `/doc%3bfoo`, method: "GET" },
        { path: `/global/config;foo`, method: "GET" },
        { path: `/session;foo?directory=${dirParam}`, method: "GET" },
        { path: `/file/status;foo?path=.&directory=${dirParam}`, method: "GET" },
      ]
      for (const v of benign) {
        const res = await withTimeout(rawRequest(v.path, v.method, { authorization: authorization(), "x-kilo-directory": tmp.path }), 5_000, `benign semi ${v.method} ${v.path}`)
        expect(res.status).not.toBe(410)
        expect(res.status).not.toBe(400)
      }
      const doc = await fetch(new URL("/doc", listener.url), { headers: { authorization: authorization() } })
      expect(doc.status).toBe(200)
    } finally {
      await stopListener(listener, "private semi listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })

  test.serial("public mode semicolon variants not forced to 410 via raw http", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-public-semi-"))
    const dbPath = path.join(dbDir, "kilo.db")
    process.env.KILO_DB = dbPath
    ;(Flag as unknown as Record<string, unknown>).KILO_DB = dbPath
    clearPrivateEnv()
    setAuth()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const dirParam = encodeURIComponent(tmp.path)
    function rawRequest(rawPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: listener.port, method, path: rawPath, headers },
          (res) => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", (c) => (data += c))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }))
          },
        )
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
      })
    }
    try {
      const authHeaders = { authorization: authorization(), "x-kilo-directory": tmp.path, "content-type": "application/json" }
      const variants = [
        `/sync/start;foo?directory=${dirParam}`,
        `/experimental/workspace/warp;jsessionid=1?directory=${dirParam}`,
        `/sync/start%3bfoo?directory=${dirParam}`,
        `/experimental/workspace/warp%3bjsessionid=1?directory=${dirParam}`,
        `/sync/start%253bfoo?directory=${dirParam}`,
        `/experimental/workspace/warp%253bjsessionid=1?directory=${dirParam}`,
      ]
      for (const p of variants) {
        const res = await withTimeout(rawRequest(p, "POST", authHeaders, JSON.stringify({})), 5_000, `public semi ${p}`)
        expect(res.status).not.toBe(410)
      }
      const benign = await withTimeout(rawRequest(`/doc;foo`, "GET", { authorization: authorization() }), 5_000, "public benign semi")
      expect(benign.status).not.toBe(410)
    } finally {
      await stopListener(listener, "public semi listener stop")
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })
})
