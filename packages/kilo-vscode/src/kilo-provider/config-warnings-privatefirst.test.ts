import { describe, expect, test } from "bun:test"
import {
  attemptConfigWarningsPrivate,
  buildConfigWarningsIdentity,
  buildConfigWarningsReq,
  fetchConfigWarningsPrivateFirst,
  parseConfigWarningsResult,
} from "./config-warnings-privatefirst"
import { canonicalConfigWarningsOpId } from "../services/cli-backend/serve-private-config-warnings-contract"

const DIR = "/tmp"

function okFor(r: ReturnType<typeof buildConfigWarningsReq>, warnings: unknown[] = []) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "config/warnings",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { warnings },
  }
}

function safeEntry(pathCategory = "agent-file", messageCategory = "invalid-file") {
  return { pathCategory, messageCategory }
}

function terminalFor(r: ReturnType<typeof buildConfigWarningsReq>, code = "validation.failed") {
  const fixed: Record<string, { message: string; retryable: boolean }> = {
    "validation.failed": { message: "invalid config-warnings request", retryable: false },
    internal: { message: "internal error", retryable: false },
    transport: { message: "private config-warnings transport failed", retryable: false },
  }
  const entry = fixed[code] ?? fixed["validation.failed"]!
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "config/warnings",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: entry.message, retryable: entry.retryable } },
    accepted: false,
    failure: { code, message: entry.message, retryable: entry.retryable },
  }
}

function retryableFor(r: ReturnType<typeof buildConfigWarningsReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "config/warnings",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: {
        code: "InstanceUnavailableDuringConfigRebuild",
        message: "Instance is unavailable during config rebuild; no active runtime for this request",
        retryable: true,
      },
    },
    accepted: false,
    failure: {
      code: "InstanceUnavailableDuringConfigRebuild",
      message: "Instance is unavailable during config rebuild; no active runtime for this request",
      retryable: true,
    },
  }
}

function ambiguousFor(r: ReturnType<typeof buildConfigWarningsReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "config/warnings",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildConfigWarningsReq>) => unknown, seen?: unknown[]) {
  return {
    isPrivateAvailable: () => true,
    privateConfigWarningsOutcomeWithHandle: (q: ReturnType<typeof buildConfigWarningsReq>) => {
      seen?.push(q)
      return {
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => true,
      }
    },
  }
}

describe("config-warnings private-first", () => {
  test("identity binds canonical config-warnings tuple", () => {
    const { opId, idempotencyKey, requestId } = buildConfigWarningsIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("config-warnings:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalConfigWarningsOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted returns ok with the safe projection", () => {
    const r = buildConfigWarningsReq(DIR)
    const parsed = parseConfigWarningsResult(okFor(r, [safeEntry()]), r)
    expect(parsed).toEqual({ kind: "ok", warnings: [safeEntry()] })
  })

  test("routing identity is directory-only; payload never binds directory", () => {
    const r = buildConfigWarningsReq(DIR)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload).toEqual({})
    const parsed = parseConfigWarningsResult(okFor(r, []), r)
    expect(parsed).toEqual({ kind: "ok", warnings: [] })
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "internal"]) {
      const r = buildConfigWarningsReq(DIR)
      const out = await attemptConfigWarningsPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out.kind).toBe("terminal")
      if (out.kind === "terminal") expect(out.code).toBe(code)
    }
  })

  test("transport failure code falls back", async () => {
    const r = buildConfigWarningsReq(DIR)
    const out = await attemptConfigWarningsPrivate(connWith((q) => terminalFor(q, "transport") as never) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("unavailable/ambiguous/invalid/transport/timeout are fallback-eligible", async () => {
    const bad = buildConfigWarningsReq(DIR)
    const off = await attemptConfigWarningsPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off.kind).toBe("fallback")

    const r2 = buildConfigWarningsReq(DIR)
    const vague = await attemptConfigWarningsPrivate(connWith((q) => ambiguousFor(q)) as never, r2)
    expect(vague.kind).toBe("fallback")

    const r3 = buildConfigWarningsReq(DIR)
    const invalid = await attemptConfigWarningsPrivate(
      {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      r3,
    )
    expect(invalid.kind).toBe("fallback")

    const r4 = buildConfigWarningsReq(DIR)
    const broken = await attemptConfigWarningsPrivate(
      {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      r4,
    )
    expect(broken.kind).toBe("fallback")

    const r5 = buildConfigWarningsReq(DIR)
    const slow = await attemptConfigWarningsPrivate(
      {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: () => ({
          id: 5,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      } as never,
      r5,
      10,
    )
    expect(slow).toEqual({ kind: "fallback", reason: "timeout" })
  })

  test("retryable failed falls back", async () => {
    const r = buildConfigWarningsReq(DIR)
    const out = await attemptConfigWarningsPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending", async () => {
    const r = buildConfigWarningsReq(DIR)
    let cancelled: string | undefined
    let cancelledId = 0
    const out = await attemptConfigWarningsPrivate(
      {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: () => ({
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            cancelledId = 7
            return true
          },
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
    expect(cancelledId).toBe(7)
  })

  test("fetch returns private result with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      config: {
        warnings: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const out = await fetchConfigWarningsPrivateFirst({
      connection: connWith((q) => okFor(q, [safeEntry()])) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "ok", via: "private", warnings: [safeEntry()] })
  })

  test("fetch exposes terminal with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      config: {
        warnings: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const out = await fetchConfigWarningsPrivateFirst({
      connection: connWith((q) => terminalFor(q)) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out.kind).toBe("terminal")
  })

  test("fetch falls back exactly once with the same directory", async () => {
    const seen: unknown[] = []
    const privSeen: unknown[] = []
    const raw = [{ path: "/w/kilo.jsonc", message: "Configuration is invalid at /w/kilo.jsonc: bad" }]
    const client = {
      config: {
        warnings: (args: unknown) => {
          seen.push(args)
          return Promise.resolve({ data: raw })
        },
      },
    }
    const out = await fetchConfigWarningsPrivateFirst({
      connection: connWith((q) => ambiguousFor(q), privSeen) as never,
      client: client as never,
      directory: DIR,
    })
    expect(seen).toEqual([{ directory: DIR }])
    expect((privSeen[0] as { context: { directory: string } }).context.directory).toBe(DIR)
    expect(out).toEqual({ kind: "ok", via: "sdk", warnings: raw })
  })

  test("fetch treats SDK failure and malformed SDK data as unavailable", async () => {
    const failing = { config: { warnings: () => Promise.reject(new Error("down")) } }
    const lost = await fetchConfigWarningsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: failing as never,
      directory: DIR,
    })
    expect(lost.kind).toBe("unavailable")

    const malformed = { config: { warnings: () => Promise.resolve({ data: { path: "/p" } }) } }
    const bad = await fetchConfigWarningsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: malformed as never,
      directory: DIR,
    })
    expect(bad.kind).toBe("unavailable")
  })

  test("read never retries: one private attempt plus at most one SDK", async () => {
    let priv = 0
    let sdk = 0
    const out = await fetchConfigWarningsPrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: () => {
          priv += 1
          return {
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }
        },
      } as never,
      client: {
        config: {
          warnings: () => {
            sdk += 1
            return Promise.resolve({ data: [] })
          },
        },
      } as never,
      directory: DIR,
    })
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
    expect(out).toEqual({ kind: "ok", via: "sdk", warnings: [] })
  })
})
