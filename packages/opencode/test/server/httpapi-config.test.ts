import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  ;(Server.Default as unknown as { reset: () => void }).reset()
})

describe("config HttpApi authenticated proof", () => {
  const original = {
    password: Flag.KILO_SERVER_PASSWORD,
    username: Flag.KILO_SERVER_USERNAME,
    envPassword: process.env.KILO_SERVER_PASSWORD,
    envUsername: process.env.KILO_SERVER_USERNAME,
    globalConfig: Global.Path.config,
  }

  afterEach(async () => {
    Flag.KILO_SERVER_PASSWORD = original.password
    Flag.KILO_SERVER_USERNAME = original.username
    if (original.envPassword === undefined) delete process.env.KILO_SERVER_PASSWORD
    else process.env.KILO_SERVER_PASSWORD = original.envPassword
    if (original.envUsername === undefined) delete process.env.KILO_SERVER_USERNAME
    else process.env.KILO_SERVER_USERNAME = original.envUsername
    ;(Global.Path as { config: string }).config = original.globalConfig
    ;(Server.Default as unknown as { reset: () => void }).reset()
    await disposeAllInstances()
    await resetDatabase()
  })

  function authHeader() {
    return `Basic ${Buffer.from(`kilo:secret`).toString("base64")}`
  }

  function requireAuth() {
    Flag.KILO_SERVER_PASSWORD = "secret"
    Flag.KILO_SERVER_USERNAME = "kilo"
    process.env.KILO_SERVER_PASSWORD = "secret"
    process.env.KILO_SERVER_USERNAME = "kilo"
  }

  test("unauthenticated rejection for project /config and global /global/config", async () => {
    requireAuth()
    await using tmp = await tmpdir({ config: { formatter: false } })
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path
    await fs.writeFile(path.join(globalTmp.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", formatter: false }))
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const base = listener.url.toString().replace(/\/$/, "")
      const noAuthProject = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`)
      expect(noAuthProject.status).toBe(401)
      expect(noAuthProject.headers.get("www-authenticate") ?? "").toContain("Basic")
      const noAuthGlobal = await fetch(`${base}/global/config`)
      expect(noAuthGlobal.status).toBe(401)
      const okProject = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, { headers: { authorization: authHeader() } })
      expect(okProject.status).toBe(200)
      const okGlobal = await fetch(`${base}/global/config`, { headers: { authorization: authHeader() } })
      expect(okGlobal.status).toBe(200)
    } finally {
      await listener.stop(true)
      ;(Server.Default as unknown as { reset: () => void }).reset()
    }
  }, { timeout: 15_000 })

  test("valid endpoint/protocol/owned credential ref round-trip for project /config", async () => {
    requireAuth()
    ;(Server.Default as unknown as { reset: () => void }).reset()
    await using tmp = await tmpdir({ config: { formatter: false } })
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path
    await fs.writeFile(path.join(globalTmp.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
    const payload = {
      provider: {
        acme: {
          endpoint: "https://project.example.com",
          protocol: "openai/completions",
          credential: "secret:kilo.credentials.project.provider.acme",
          name: "acme-project",
          models: { m1: { name: "M1 project" } },
        },
      },
    }
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const base = listener.url.toString().replace(/\/$/, "")
      const patch = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify(payload),
      })
      expect(patch.status).toBe(200)
      const body = await patch.json() as { provider: Record<string, { endpoint: string; protocol: string; credential: string }> }
      expect(body.provider.acme.endpoint).toBe("https://project.example.com")
      expect(body.provider.acme.protocol).toBe("openai/completions")
      expect(body.provider.acme.credential).toBe("secret:kilo.credentials.project.provider.acme")
      const file = await Bun.file(path.join(tmp.path, ".kilo", "kilo.jsonc")).json() as typeof body
      expect(file.provider.acme.endpoint).toBe("https://project.example.com")
      expect(file.provider.acme.protocol).toBe("openai/completions")
      expect(file.provider.acme.credential).toBe("secret:kilo.credentials.project.provider.acme")
      // also prove via raw bytes that persisted file matches and does not contain leakage
      const raw = await fs.readFile(path.join(tmp.path, ".kilo", "kilo.jsonc"), "utf8")
      expect(raw).toContain("secret:kilo.credentials.project.provider.acme")
      const get = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, { headers: { authorization: authHeader() } })
      expect(get.status).toBe(200)
      const getBody = await get.json() as typeof body
      expect(getBody.provider.acme.endpoint).toBe("https://project.example.com")
      expect(getBody.provider.acme.protocol).toBe("openai/completions")
      expect(getBody.provider.acme.credential).toBe("secret:kilo.credentials.project.provider.acme")
    } finally {
      await listener.stop(true)
    }
  }, { timeout: 15_000 })

  test("valid endpoint/protocol/owned credential ref round-trip for global /global/config", async () => {
    requireAuth()
    ;(Server.Default as unknown as { reset: () => void }).reset()
    await using projectTmp = await tmpdir({ config: { formatter: false } })
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path
    await fs.writeFile(path.join(globalTmp.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const base = listener.url.toString().replace(/\/$/, "")
      const payload = {
        provider: {
          acme: {
            endpoint: "https://global.example.com",
            protocol: "anthropic/messages",
            credential: "secret:kilo.credentials.global.provider.acme",
            name: "acme-global",
            models: { m1: { name: "M1 global" } },
          },
        },
      }
      const patch = await fetch(`${base}/global/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify(payload),
      })
      expect(patch.status).toBe(200)
      const body = await patch.json() as { provider: Record<string, { endpoint: string; protocol: string; credential: string }> }
      expect(body.provider.acme.endpoint).toBe("https://global.example.com")
      expect(body.provider.acme.protocol).toBe("anthropic/messages")
      expect(body.provider.acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
      const file = await Bun.file(path.join(globalTmp.path, "kilo.jsonc")).json() as typeof body
      expect(file.provider.acme.endpoint).toBe("https://global.example.com")
      expect(file.provider.acme.protocol).toBe("anthropic/messages")
      expect(file.provider.acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
      const raw = await fs.readFile(path.join(globalTmp.path, "kilo.jsonc"), "utf8")
      expect(raw).toContain("secret:kilo.credentials.global.provider.acme")
      const get = await fetch(`${base}/global/config`, { headers: { authorization: authHeader() } })
      expect(get.status).toBe(200)
      const getBody = await get.json() as typeof body
      expect(getBody.provider.acme.endpoint).toBe("https://global.example.com")
      expect(getBody.provider.acme.protocol).toBe("anthropic/messages")
      expect(getBody.provider.acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
    } finally {
      await listener.stop(true)
    }
  }, { timeout: 15_000 })

  test("project/global precedence: project overrides global, global retains other providers", async () => {
    Flag.KILO_SERVER_PASSWORD = undefined
    delete process.env.KILO_SERVER_PASSWORD
    Flag.KILO_SERVER_USERNAME = undefined
    delete process.env.KILO_SERVER_USERNAME
    ;(Server.Default as unknown as { reset: () => void }).reset()
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    const base = listener.url.toString().replace(/\/$/, "")
    let globalTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let projectTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      globalTmp = await tmpdir()
      projectTmp = await tmpdir()
      ;(Global.Path as { config: string }).config = globalTmp.path
      await fs.writeFile(
        path.join(globalTmp.path, "kilo.jsonc"),
        JSON.stringify({
          $schema: "https://app.kilo.ai/config.json",
          provider: {
            acme: {
              endpoint: "https://global.example.com",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.global.provider.acme",
              name: "global",
              models: { m1: { name: "M1 global" }, m2: { name: "M2 global" } },
            },
            other: {
              endpoint: "https://global.other.test",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.global.provider.other",
              name: "other-global",
            },
          },
        }),
      )
      await fs.mkdir(path.join(projectTmp.path, ".kilo"), { recursive: true })
      await fs.writeFile(
        path.join(projectTmp.path, ".kilo", "kilo.jsonc"),
        JSON.stringify({
          $schema: "https://app.kilo.ai/config.json",
          provider: {
            acme: {
              endpoint: "https://project.example.com",
              protocol: "openai/responses",
              models: { m2: null, m3: { name: "M3 project" } },
            },
          },
        }),
      )
      await disposeAllInstances()
      const projectGet = await fetch(`${base}/config?directory=${encodeURIComponent(projectTmp.path)}`)
      expect(projectGet.status).toBe(200)
      const projBody = await projectGet.json() as { provider: Record<string, Record<string, unknown> & { endpoint?: string; protocol?: string; credential?: string; name?: string; models?: Record<string, unknown> }> }
      expect(projBody.provider.acme.endpoint).toBe("https://project.example.com")
      expect(projBody.provider.acme.protocol).toBe("openai/responses")
      expect(projBody.provider.acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
      expect(projBody.provider.acme.name).toBe("global")
      const models = projBody.provider.acme.models as Record<string, unknown>
      expect(models.m1).toBeDefined()
      expect(models.m2 == null).toBe(true)
      expect(models.m3).toBeDefined()
      expect(projBody.provider.other.endpoint).toBe("https://global.other.test")
      const globalGet = await fetch(`${base}/global/config`)
      expect(globalGet.status).toBe(200)
      const globalBody = await globalGet.json() as { provider: Record<string, { endpoint: string }> }
      expect(globalBody.provider.acme.endpoint).toBe("https://global.example.com")
      expect(globalBody.provider.other.endpoint).toBe("https://global.other.test")
    } finally {
      await listener.stop(true)
      if (globalTmp) await globalTmp[Symbol.asyncDispose]()
      if (projectTmp) await projectTmp[Symbol.asyncDispose]()
    }
  }, { timeout: 15_000 })

  test("plaintext and malformed credential rejected before persistence for project and global", async () => {
    requireAuth()
    ;(Server.Default as unknown as { reset: () => void }).reset()
    const distinctProjectToken = "sk-DISTINCTIVE-LEAK-PROJECT-ABC123-XYZ-987-TOKEN"
    const distinctGlobalToken = "sk-DISTINCTIVE-LEAK-GLOBAL-DEF456-UVW-654-TOKEN"
    // Capture server logs to a tmpdir to assert redaction via actual logger sink
    const logTmp = await tmpdir()
    const prevLog = Global.Path.log
    Global.Path.log = logTmp.path
    await Log.init({ print: false })
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    const base = listener.url.toString().replace(/\/$/, "")
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let globalTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      tmp = await tmpdir({ config: { formatter: false } })
      globalTmp = await tmpdir()
      ;(Global.Path as { config: string }).config = globalTmp.path
      await fs.writeFile(path.join(globalTmp.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { endpoint: "https://keep.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } } }))
      const plainProject = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ provider: { acme: { endpoint: "https://evil.test", protocol: "openai/completions", credential: distinctProjectToken } } }),
      })
      expect(plainProject.status).toBe(400)
      const plainProjectText = await plainProject.text()
      expect(plainProjectText).not.toContain(distinctProjectToken)
      const plainBody = JSON.parse(plainProjectText) as unknown
      expect(String(JSON.stringify(plainBody))).toMatch(/credential/i)
      expect(String(JSON.stringify(plainBody))).not.toContain(distinctProjectToken)
      // non-vacuous persistence proof: read exact expected project config file with failure on missing
      await new Promise((r) => setTimeout(r, 100))
      const projectConfigPath = path.join(tmp.path, ".kilo", "kilo.jsonc")
      const projectRawAfterPlain = await fs.readFile(projectConfigPath, "utf8")
      expect(projectRawAfterPlain).not.toContain(distinctProjectToken)
      expect(projectRawAfterPlain).not.toContain(distinctGlobalToken)
      // also ensure persisted bytes do not contain the token via raw string check
      const malformedProject = await fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ provider: { acme: { endpoint: "https://evil.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider." } } }),
      })
      expect(malformedProject.status).toBe(400)
      const malformedProjectText = await malformedProject.text()
      expect(malformedProjectText).not.toContain(distinctProjectToken)
      await new Promise((r) => setTimeout(r, 50))
      const projectRawAfterMalformed = await fs.readFile(projectConfigPath, "utf8")
      expect(projectRawAfterMalformed).not.toContain(distinctProjectToken)
      expect(projectRawAfterMalformed).not.toContain("secret:kilo.credentials.global.provider.")
      const plainGlobal = await fetch(`${base}/global/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ provider: { acme: { endpoint: "https://evil.test", protocol: "openai/completions", credential: distinctGlobalToken } } }),
      })
      expect(plainGlobal.status).toBe(400)
      const plainGlobalText = await plainGlobal.text()
      expect(plainGlobalText).not.toContain(distinctGlobalToken)
      const globalConfigPath = path.join(globalTmp.path, "kilo.jsonc")
      const globalRawAfterPlain = await fs.readFile(globalConfigPath, "utf8")
      expect(globalRawAfterPlain).not.toContain(distinctGlobalToken)
      expect(globalRawAfterPlain).not.toContain(distinctProjectToken)
      const afterGlobalParsed = JSON.parse(globalRawAfterPlain) as { provider: Record<string, { credential: string }> }
      expect(afterGlobalParsed.provider.acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
      const malformedGlobal = await fetch(`${base}/global/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ provider: { acme: { endpoint: "https://evil.test", protocol: "openai/completions", credential: "secret:kilo.credentials.invalid.provider.acme" } } }),
      })
      expect(malformedGlobal.status).toBe(400)
      const malformedGlobalText = await malformedGlobal.text()
      expect(malformedGlobalText).not.toContain("secret:kilo.credentials.invalid.provider.acme")
      const globalRawAfterMalformed = await fs.readFile(globalConfigPath, "utf8")
      expect(globalRawAfterMalformed).not.toContain("secret:kilo.credentials.invalid.provider.acme")
      expect(globalRawAfterMalformed).not.toContain(distinctGlobalToken)
      // Verify server logs do not contain distinctive tokens via actual logger sink
      await new Promise((r) => setTimeout(r, 100))
      const logDirStat = await fs.stat(logTmp.path)
      expect(logDirStat.isDirectory()).toBe(true)
      const files = await fs.readdir(logTmp.path)
      const logFiles = files.filter((f) => f.endsWith(".log"))
      expect(logFiles.length).toBeGreaterThan(0)
      let logContent = ""
      for (const f of logFiles) {
        const txt = await fs.readFile(path.join(logTmp.path, f), "utf8")
        logContent += txt
      }
      const sinkPath = Log.file()
      expect(sinkPath).toContain(logTmp.path)
      const sinkStat = await fs.stat(sinkPath)
      expect(sinkStat.isFile()).toBe(true)
      const sinkContent = await fs.readFile(sinkPath, "utf8")
      logContent += sinkContent
      expect(logContent.length).toBeGreaterThan(0)
      expect(logContent).not.toContain(distinctProjectToken)
      expect(logContent).not.toContain(distinctGlobalToken)
      expect(logContent).not.toContain("sk-DISTINCTIVE-LEAK")
    } finally {
      await listener.stop(true)
      if (tmp) await tmp[Symbol.asyncDispose]()
      if (globalTmp) await globalTmp[Symbol.asyncDispose]()
      await logTmp[Symbol.asyncDispose]()
      Global.Path.log = prevLog
      await Log.init({ print: false })
    }
  }, { timeout: 20_000 })
})

describe("config HttpApi", () => {
  beforeEach(() => {
    Flag.KILO_SERVER_PASSWORD = undefined
    delete process.env.KILO_SERVER_PASSWORD
    Flag.KILO_SERVER_USERNAME = undefined
    delete process.env.KILO_SERVER_USERNAME
    ;(Server.Default as unknown as { reset: () => void }).reset()
  })
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const listener = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" }))
      try {
        const base = listener.url.toString().replace(/\/$/, "")
        const response = yield* Effect.promise(() =>
          fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          username: "patched-user",
          formatter: false,
          lsp: false,
        })
        yield* Fiber.join(disposed)
        const raw = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, ".kilo", "kilo.jsonc"), "utf8"))
        expect(JSON.parse(raw)).toMatchObject({
          username: "patched-user",
          formatter: false,
          lsp: false,
        })
      } finally {
        yield* Effect.promise(() => listener.stop(true))
      }
    }),
    { timeout: 15_000 },
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })
      const listener = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" }))
      try {
        const base = listener.url.toString().replace(/\/$/, "")
        const response = yield* Effect.promise(() => fetch(`${base}/config?directory=${encodeURIComponent(tmp.path)}`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        })
      } finally {
        yield* Effect.promise(() => listener.stop(true))
      }
    }),
    { timeout: 15_000 },
  )
})
