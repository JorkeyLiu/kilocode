import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs"
import * as path from "path"
import { Auth } from "../../../src/auth"
import {
  CAPABILITY,
  KiloAuthStatusInternal,
  OP,
  VERSION,
  fetchKiloAuthStatusData,
  kiloAuthStatusPrivate,
  validateKiloAuthStatusData,
  validateKiloAuthStatusRequest,
} from "../../../src/kilocode/kilo-auth-status"
import { FD_CAPABILITIES } from "../../../src/kilocode/server/fd-carrier-protocol"

function authLayer(info: unknown) {
  return Layer.mock(Auth.Service, {
    get: () => Effect.succeed(info as never),
  })
}

function throwingAuthLayer() {
  return Layer.mock(Auth.Service, {
    get: () => Effect.fail(new Auth.AuthError({ message: "store failure" })),
  })
}

describe("kilo/auth-status private observation (backend)", () => {
  it("advertises the kilo/auth-status capability with op kilo/auth-status v1", () => {
    expect(CAPABILITY).toBe("kilo/auth-status")
    expect(OP).toBe("kilo/auth-status")
    expect(VERSION).toBe(1)
    expect([...FD_CAPABILITIES]).toContain("kilo/auth-status")
  })

  it("validates routing-only request strictly", () => {
    const base = { v: 1, requestId: "r1", op: "kilo/auth-status", context: { directory: "/tmp" }, payload: {} }
    expect(validateKiloAuthStatusRequest(base).op).toBe("kilo/auth-status")
    expect(() => validateKiloAuthStatusRequest({ ...base, context: { directory: "rel" } })).toThrow()
    expect(() => validateKiloAuthStatusRequest({ ...base, payload: { x: 1 } })).toThrow()
    expect(() => validateKiloAuthStatusRequest({ ...base, extra: 1 })).toThrow()
    expect(() => validateKiloAuthStatusRequest({ ...base, opId: "x", idempotencyKey: "x" })).toThrow()
  })

  it("validates the closed authenticated/type shape with no cross-field constraint", () => {
    expect(validateKiloAuthStatusData({ authenticated: true, type: "api" })).toEqual({
      authenticated: true,
      type: "api",
    })
    expect(validateKiloAuthStatusData({ authenticated: true, type: "oauth" })).toEqual({
      authenticated: true,
      type: "oauth",
    })
    expect(validateKiloAuthStatusData({ authenticated: false })).toEqual({ authenticated: false })
    // No cross-field constraint: presence of `type` while signed out is shape-valid.
    expect(validateKiloAuthStatusData({ authenticated: false, type: "api" })).toEqual({
      authenticated: false,
      type: "api",
    })
    expect(() => validateKiloAuthStatusData({ authenticated: false, type: null })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "wellknown" })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: "yes" })).toThrow()
    expect(() => validateKiloAuthStatusData({})).toThrow()
  })

  it("rejects unknown/secret fields fail-closed", () => {
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "oauth", token: "secret" })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "oauth", key: "secret" })).toThrow()
    expect(() =>
      validateKiloAuthStatusData({ authenticated: true, type: "oauth", access: "secret", refresh: "r" }),
    ).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: false, extra: 1 })).toThrow()
  })

  it("projects api/oauth credentials without returning tokens", async () => {
    const api = await Effect.runPromise(
      fetchKiloAuthStatusData().pipe(Effect.provide(authLayer({ type: "api", key: "test-token" }))),
    )
    expect(api).toEqual({ authenticated: true, type: "api" })
    const oauth = await Effect.runPromise(
      fetchKiloAuthStatusData().pipe(
        Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 })),
      ),
    )
    expect(oauth).toEqual({ authenticated: true, type: "oauth" })
  })

  it("reports signed-out for missing/wellknown/empty-token auth", async () => {
    for (const info of [
      undefined,
      { type: "wellknown", key: "k", token: "t" },
      { type: "api", key: "" },
      { type: "oauth", refresh: "r", access: "", expires: 1 },
    ]) {
      const out = await Effect.runPromise(fetchKiloAuthStatusData().pipe(Effect.provide(authLayer(info))))
      expect(out).toEqual({ authenticated: false })
    }
  })

  it("maps an Auth store failure to terminal internal (HTTP keeps BadRequest)", async () => {
    const err = await Effect.runPromise(fetchKiloAuthStatusData().pipe(Effect.provide(throwingAuthLayer()), Effect.flip))
    expect(err).toBeInstanceOf(KiloAuthStatusInternal)
  })

  it("private handler maps validation/internal strictly with no drain lane", async () => {
    const bad = (await Effect.runPromise(
      kiloAuthStatusPrivate({ v: 1 }).pipe(Effect.provide(authLayer(undefined))),
    )) as { status: string; failure: { code: string; retryable: boolean } }
    expect(bad.status).toBe("failed")
    expect(bad.failure.code).toBe("validation.failed")
    expect(bad.failure.retryable).toBe(false)

    const ok = (await Effect.runPromise(
      kiloAuthStatusPrivate({
        v: 1,
        requestId: "r1",
        op: "kilo/auth-status",
        context: { directory: "/tmp" },
        payload: {},
      }).pipe(Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 }))),
    )) as { status: string; accepted: boolean; data: unknown }
    expect(ok.status).toBe("succeeded")
    expect(ok.accepted).toBe(true)
    expect(ok.data).toEqual({ authenticated: true, type: "oauth" })

    const store = (await Effect.runPromise(
      kiloAuthStatusPrivate({
        v: 1,
        requestId: "r2",
        op: "kilo/auth-status",
        context: { directory: "/tmp" },
        payload: {},
      }).pipe(Effect.provide(throwingAuthLayer())),
    )) as { status: string; failure: { code: string; retryable: boolean } }
    expect(store.status).toBe("failed")
    expect(store.failure.code).toBe("internal")
    expect(store.failure.retryable).toBe(false)
  })

  it("shares one Auth projection between HTTP and fd with no new lifecycle", () => {
    const root = path.join(__dirname, "..", "..", "..", "src")
    const shared = fs.readFileSync(path.join(root, "kilocode", "kilo-auth-status.ts"), "utf8")
    expect(shared).toContain('auth.get("kilo")')
    expect(shared).toContain("getToken")
    expect(shared).not.toContain("drain-control-acquire")
    expect(shared).not.toContain("acquireDrainControl(")
    expect(shared).not.toContain("effect/instance-ref")
    expect(shared).not.toContain("provideService(InstanceRef")
    const handler = fs.readFileSync(
      path.join(root, "kilocode", "server", "httpapi", "handlers", "kilo-gateway.ts"),
      "utf8",
    )
    expect(handler).toContain("fetchKiloAuthStatusData")
    expect(handler).toContain("HttpApiError.BadRequest")
    const carrier = fs.readFileSync(path.join(root, "kilocode", "server", "fd-carrier.ts"), "utf8")
    expect(carrier).toContain("kiloAuthStatusPrivate")
    expect(carrier).toContain("kilo/auth-status")
  })
})
