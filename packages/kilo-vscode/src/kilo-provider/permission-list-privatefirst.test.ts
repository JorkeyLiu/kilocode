import { describe, expect, test, spyOn } from "bun:test"
import {
  buildPermissionListIdentity,
  listPermissionsPrivateFirst,
  readPermissionsForDir,
} from "./permission-privatefirst"
import {
  canonicalPermissionListOpId,
  isPermissionListValidationError,
  PermissionListValidationError,
  validatePermissionListContractRequest,
  validatePermissionListResult,
} from "../services/cli-backend/serve-private-permission-list-contract"

const DIR = "/workspace/perm-list-origin"

function entry(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["npm install lodash"],
    metadata: {},
    always: [] as string[],
    tool: undefined,
  }
}

function succeeded(req: Record<string, unknown>, perms: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { permissions: perms },
    },
  }
}

function failed(req: Record<string, unknown>, code: string, retryable: boolean) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
      accepted: false,
      failure: { code, message: "m", retryable },
    },
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

describe("permission-list private-first", () => {
  test("validation error brand is detectable", () => {
    expect(isPermissionListValidationError(new PermissionListValidationError("bad"))).toBeTrue()
    expect(isPermissionListValidationError({ kind: "other" })).toBeFalse()
  })

  test("identity binds permission-list token and validators accept it", () => {
    const ids = buildPermissionListIdentity()
    expect(ids.opId).toBe(ids.idempotencyKey)
    expect(ids.opId.startsWith("permission-list:")).toBeTrue()
    const token = ids.opId.split(":")[1]!
    expect(canonicalPermissionListOpId(token)).toBe(ids.opId)
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "permission/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validatePermissionListContractRequest(req)).not.toThrow()
  })

  test("strict request rejects unknown fields and non-empty payload", () => {
    const ids = buildPermissionListIdentity()
    const base = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "permission/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validatePermissionListContractRequest({ ...base, extra: 1 })).toThrow()
    expect(() => validatePermissionListContractRequest({ ...base, payload: { filter: {} } })).toThrow()
    expect(() =>
      validatePermissionListContractRequest({ ...base, context: { directory: DIR, workspace: "w" } }),
    ).toThrow()
  })

  test("full entry shape validated and directory never trusted from payload", () => {
    const ids = buildPermissionListIdentity()
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "permission/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    } as unknown as Parameters<typeof validatePermissionListResult>[1]
    const good = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "permission/list",
      idempotencyKey: ids.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { permissions: [entry("per_good00000000000000001", "ses_1")] },
    }
    expect(() => validatePermissionListResult(good, req)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    const data = badId.data as Record<string, unknown>
    data.permissions = [{ ...entry("per_good00000000000000001", "ses_1"), id: "bad" }]
    expect(() => validatePermissionListResult(badId, req)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).permissions = [
      { ...entry("per_good00000000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validatePermissionListResult(badSession, req)).toThrow()
    const withDir = structuredClone(good) as unknown as Record<string, unknown>
    ;(withDir.data as Record<string, unknown>).permissions = [
      { ...entry("per_good00000000000000001", "ses_1"), directory: DIR } as unknown,
    ]
    expect(() => validatePermissionListResult(withDir, req)).toThrow()
  })

  test("accepted success uses zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(succeeded(req, [entry("per_ok000000000000000001", "ses_1")])),
        cancel: () => true,
      }),
    } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"]
    const client = {
      permission: {
        list: async () => {
          sdk += 1
          return { data: [], error: undefined }
        },
      },
    }
    const out = await readPermissionsForDir({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("ok")
    expect(sdk).toBe(0)
    if (out.kind === "ok") expect(out.perms).toHaveLength(1)
  })

  test("terminal non-retryable yields unknown with zero SDK, not known empty", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(failed(req, "validation.failed", false)),
        cancel: () => true,
      }),
    } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"]
    const client = {
      permission: {
        list: async () => {
          sdk += 1
          return { data: [], error: undefined }
        },
      },
    }
    const out = await readPermissionsForDir({ connection: conn, client, directory: DIR })
    expect(out).toEqual({ kind: "unknown" })
    expect(sdk).toBe(0)
  })

  test("fallback-eligible takes exactly one SDK list, never retry", async () => {
    for (const mode of ["fence", "ambiguous", "invalid", "timeout", "unavailable"] as const) {
      let sdk = 0
      const conn =
        mode === "unavailable"
          ? ({ isPrivateAvailable: () => false } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"])
          : ({
              isPrivateAvailable: () => true,
              privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => {
                if (mode === "fence") return { id: 1, promise: Promise.resolve(failed(req, "InstanceUnavailableDuringConfigRebuild", true)), cancel: () => true }
                if (mode === "ambiguous") return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
                if (mode === "invalid") return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
                return { id: 1, promise: Promise.reject(new Error("private parity timeout after 3000ms")), cancel: () => true }
              },
            } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"])
      const client = {
        permission: {
          list: async (args: { directory: string }) => {
            sdk += 1
            expect(args.directory).toBe(DIR)
            return { data: [entry("per_sdk00000000000000001", "ses_1")], error: undefined }
          },
        },
      }
      const out = await readPermissionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    }
  })

  test("timeout cancels the exact pending", async () => {
    const cancelled: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionListOutcomeWithHandle: () => ({
        id: 9,
        promise: Promise.reject(new Error("private parity timeout after 3000ms")),
        cancel: (msg?: string) => {
          cancelled.push(String(msg))
          return true
        },
      }),
    } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"]
    const client = { permission: { list: async () => ({ data: [], error: undefined }) } }
    const out = await readPermissionsForDir({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("ok")
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.includes("permission-list:")).toBeTrue()
  })

  test("response identity mismatch falls back, never trusts payload directory", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(succeeded({ ...req, requestId: "other" }, [])),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listPermissionsPrivateFirst>[0]["connection"]
      let sdk = 0
      const client = {
        permission: {
          list: async () => {
            sdk += 1
            return { data: [], error: undefined }
          },
        },
      }
      const out = await readPermissionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
