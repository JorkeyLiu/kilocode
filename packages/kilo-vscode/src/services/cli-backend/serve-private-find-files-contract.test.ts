import { describe, expect, test } from "bun:test"
import {
  canonicalFindFilesOpId,
  checkFindFilesScope,
  FIND_FILES_FAILED_CODE,
  FIND_FILES_FAILED_MESSAGE,
  FIND_FILES_INVALID_DETAIL,
  FindFilesValidationError,
  isFindFilesValidationError,
  isSensitiveFindFilesPath,
  makeFindFilesAmbiguous,
  normalizePrivateFindFilesWire,
  parseFindFilesOpId,
  validateFindFilesContractRequest,
  validateFindFilesEntries,
  validateFindFilesEntry,
  validateFindFilesFailure,
  validateFindFilesRelPath,
  validateFindFilesResult,
} from "./serve-private-find-files-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalFindFilesOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "find/files" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { query: "hello", type: "file", limit: 10 },
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateFindFilesContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "find/files" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { files: [{ path: "src/app.ts", type: "file" }] },
    ...over,
  }
}

describe("Gate B find/files candidate contract", () => {
  test("opId grammar is find-files single token with idempotency equality and domain separation", () => {
    expect(canonicalFindFilesOpId("t1")).toBe("find-files:t1")
    expect(() => canonicalFindFilesOpId("")).toThrow()
    expect(() => canonicalFindFilesOpId("a:b")).toThrow()
    expect(() => canonicalFindFilesOpId("a/b")).toThrow()
    expect(parseFindFilesOpId(canonicalFindFilesOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseFindFilesOpId("path:t1")).toThrow()
    expect(() => parseFindFilesOpId("remote-status:t1")).toThrow()
    expect(() => parseFindFilesOpId("command-list:t1")).toThrow()
    expect(() => parseFindFilesOpId("abort:ses_x:t1")).toThrow()
    expect(() => parseFindFilesOpId("find-files:a:b")).toThrow()
  })

  test("request validation enforces strict v1 envelope with routing-only directory", () => {
    const req = makeReq()
    expect(() => validateFindFilesContractRequest(req)).not.toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, op: "find.text" })).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, idempotencyKey: canonicalFindFilesOpId("other") }),
    ).toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } }),
    ).toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, requestId: "r/1" })).toThrow()
    const withWs = makeReq({ context: { directory: "/tmp", workspace: "w1" } })
    expect(() => validateFindFilesContractRequest(withWs)).not.toThrow()
  })

  test("request requires explicit type and rejects legacy dirs", () => {
    const req = makeReq()
    expect(() => validateFindFilesContractRequest(req)).not.toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, payload: { query: "hello", limit: 10 } })).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "other", limit: 10 } }),
    ).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file", limit: 10, dirs: "true" } }),
    ).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file", limit: 10, dirs: "false" } }),
    ).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "directory", limit: 10 } }),
    ).not.toThrow()
  })

  test("request enforces query and limit rules", () => {
    const req = makeReq()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "", type: "file", limit: 10 } }),
    ).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "a\0b", type: "file", limit: 10 } }),
    ).toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "x".repeat(256), type: "file", limit: 10 } }),
    ).not.toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "x".repeat(257), type: "file", limit: 10 } }),
    ).toThrow()
    for (const limit of [0, -1, 51, 200, 1.5, "10" as unknown]) {
      expect(() =>
        validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file", limit } }),
      ).toThrow()
    }
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file", limit: 1 } }),
    ).not.toThrow()
    expect(() =>
      validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file", limit: 50 } }),
    ).not.toThrow()
    expect(() => validateFindFilesContractRequest({ ...req, payload: { query: "hello", type: "file" } })).not.toThrow()
  })

  test("relative path safety fails closed", () => {
    expect(() => validateFindFilesRelPath("src/app.ts")).not.toThrow()
    expect(() => validateFindFilesRelPath("a/b/c")).not.toThrow()
    for (const bad of [
      "",
      "/abs/path",
      "/tmp",
      "C:/win",
      "file://x",
      "a\\b",
      "a//b",
      "a/./b",
      "../esc",
      "a/../b",
      "..",
      ".",
      "a/",
      "a\0b",
      "vscode-remote://x",
    ]) {
      expect(() => validateFindFilesRelPath(bad)).toThrow()
    }
  })

  test("sensitive-name policy rejects secrets and preserves ordinary dotfiles", () => {
    expect(isSensitiveFindFilesPath(".env")).toBeTrue()
    expect(isSensitiveFindFilesPath(".env.local")).toBeTrue()
    expect(isSensitiveFindFilesPath("config/.env.production")).toBeTrue()
    expect(isSensitiveFindFilesPath(".env.example")).toBeFalse()
    expect(isSensitiveFindFilesPath("cert.pem")).toBeTrue()
    expect(isSensitiveFindFilesPath("srv.key")).toBeTrue()
    expect(isSensitiveFindFilesPath("bundle.p12")).toBeTrue()
    expect(isSensitiveFindFilesPath("store.jks")).toBeTrue()
    expect(isSensitiveFindFilesPath("tls.crt")).toBeTrue()
    expect(isSensitiveFindFilesPath(".pem")).toBeTrue()
    expect(isSensitiveFindFilesPath(".key")).toBeTrue()
    expect(isSensitiveFindFilesPath(".crt")).toBeTrue()
    expect(isSensitiveFindFilesPath(".cer")).toBeTrue()
    expect(isSensitiveFindFilesPath(".p12")).toBeTrue()
    expect(isSensitiveFindFilesPath(".pfx")).toBeTrue()
    expect(isSensitiveFindFilesPath(".der")).toBeTrue()
    expect(isSensitiveFindFilesPath(".jks")).toBeTrue()
    expect(isSensitiveFindFilesPath("nested/.pem")).toBeTrue()
    expect(isSensitiveFindFilesPath(".ssh/config")).toBeTrue()
    expect(isSensitiveFindFilesPath(".aws/credentials")).toBeTrue()
    expect(isSensitiveFindFilesPath("secret/token.txt")).toBeTrue()
    expect(isSensitiveFindFilesPath("a/secrets/b.txt")).toBeTrue()
    expect(isSensitiveFindFilesPath(".github/workflows/ci.yml")).toBeFalse()
    expect(isSensitiveFindFilesPath(".eslintrc")).toBeFalse()
    expect(isSensitiveFindFilesPath("src/app.ts")).toBeFalse()
    for (const bad of [".env", "a/.env.local", ".ssh/config", "secret/a.txt", "k.pem", ".pem", ".key", ".crt"]) {
      expect(() => validateFindFilesRelPath(bad)).toThrow()
    }
    expect(() => validateFindFilesRelPath(".env.example")).not.toThrow()
    expect(() => validateFindFilesRelPath(".github/workflows/ci.yml")).not.toThrow()
    expect(() => validateFindFilesRelPath(".eslintrc")).not.toThrow()
  })

  test("success normalization emits only bounded relative {path,type} projection", () => {
    const req = validateFindFilesContractRequest(makeReq())
    expect(() => validateFindFilesResult(makeSucceeded(req), req)).not.toThrow()
    expect(() =>
      validateFindFilesResult(
        makeSucceeded(req, { data: { files: [{ path: "src/a.ts", type: "file", absolute: "/tmp/src/a.ts" }] } }),
        req,
      ),
    ).toThrow()
    for (const extra of ["absolute", "uri", "cwd", "root", "mime", "contents", "ignored"]) {
      expect(() =>
        validateFindFilesResult(
          makeSucceeded(req, { data: { files: [{ path: "src/a.ts", type: "file", [extra]: "x" }] } }),
          req,
        ),
      ).toThrow()
    }
    expect(() =>
      validateFindFilesResult(makeSucceeded(req, { data: { files: [{ path: "/tmp/a.ts", type: "file" }] } }), req),
    ).toThrow()
    expect(() =>
      validateFindFilesResult(makeSucceeded(req, { data: { files: [{ path: "a", type: "other" }] } }), req),
    ).toThrow()
    expect(() =>
      validateFindFilesEntries(Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, type: "file" }))),
    ).toThrow()
    expect(() =>
      validateFindFilesEntries(Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, type: "file" }))),
    ).not.toThrow()
    expect(() => validateFindFilesEntry({ path: "src/a.ts", type: "file" })).not.toThrow()
    expect(() => validateFindFilesEntry({ path: "docs", type: "directory" })).not.toThrow()
    expect(() => validateFindFilesResult({ ...makeSucceeded(req), accepted: false }, req)).toThrow()
    expect(() => validateFindFilesResult({ ...makeSucceeded(req), data: { paths: ["src/a.ts"] } }, req)).toThrow()
  })

  test("result correlation rejects mismatched requestId/opId/idempotencyKey", () => {
    const req = validateFindFilesContractRequest(makeReq())
    const otherId = canonicalFindFilesOpId("other")
    for (const bad of [
      { ...makeSucceeded(req), requestId: "other" },
      { ...makeSucceeded(req), opId: otherId },
      { ...makeSucceeded(req), idempotencyKey: otherId },
    ]) {
      expect(() => validateFindFilesResult(bad, req)).toThrow()
    }
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "find/files" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "validation.failed", message: "bad", retryable: false },
      },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: false },
    }
    for (const bad of [
      { ...failed, requestId: "other" },
      { ...failed, opId: otherId },
      { ...failed, idempotencyKey: otherId },
    ]) {
      expect(() => validateFindFilesResult(bad, req)).toThrow()
    }
    const amb = makeFindFilesAmbiguous(req)
    for (const bad of [
      { ...amb, requestId: "other" },
      { ...amb, opId: otherId },
      { ...amb, idempotencyKey: otherId },
    ]) {
      expect(() => validateFindFilesResult(bad, req)).toThrow()
    }
    expect(() => validateFindFilesResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateFindFilesResult(failed, req)).not.toThrow()
    expect(() => validateFindFilesResult(amb, req)).not.toThrow()
  })

  test("routing scope mismatch binds directory/workspace/request", () => {
    const req = validateFindFilesContractRequest(makeReq())
    expect(checkFindFilesScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkFindFilesScope(req, { directory: "/tmp/", token: "tok1" })).toEqual({ ok: true })
    expect(checkFindFilesScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkFindFilesScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
    const withWs = validateFindFilesContractRequest(makeReq({ context: { directory: "/tmp", workspace: "w1" } }))
    expect(checkFindFilesScope(withWs, { directory: "/tmp", workspace: "w1", token: "tok1" })).toEqual({ ok: true })
    expect(checkFindFilesScope(withWs, { directory: "/tmp", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
  })

  test("failures are redacted and reject path/query/raw-error material", () => {
    expect(() =>
      validateFindFilesFailure({ code: "validation.failed", message: "bad", retryable: false }),
    ).not.toThrow()
    for (const key of [
      "path",
      "directory",
      "workspace",
      "query",
      "absolute",
      "uri",
      "raw",
      "error",
      "files",
      "results",
      "type",
      "limit",
      "dirs",
      "detail",
    ]) {
      expect(() => validateFindFilesFailure({ code: "x", message: "m", retryable: false, [key]: "raw" })).toThrow()
    }
    expect(() => validateFindFilesFailure({ code: "/tmp/code", message: "m", retryable: false })).toThrow()
    expect(() => validateFindFilesFailure({ code: "x", message: "failed at /tmp/a", retryable: false })).toThrow()
    const req = validateFindFilesContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "find/files" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "validation.failed", message: "bad", retryable: false },
      },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: false },
    }
    expect(() => validateFindFilesResult(failed, req)).not.toThrow()
    expect(() => validateFindFilesResult({ ...failed, data: { files: [] } }, req)).toThrow()
    expect(() => validateFindFilesResult({ ...failed, accepted: true }, req)).toThrow()
  })

  test("wire normalization maps failures to fixed redacted shape and rejects invalid wire", () => {
    const req = validateFindFilesContractRequest(makeReq())
    const ok = validateFindFilesResult(makeSucceeded(req), req)
    expect(normalizePrivateFindFilesWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivateFindFilesWire({ bogus: true }, req)
    expect(invalid.kind).toBe("invalid")
    if (invalid.kind === "invalid") {
      expect(invalid.detail).toBe(FIND_FILES_INVALID_DETAIL)
      expect(new FindFilesValidationError(invalid.detail)).toSatisfy((e) => isFindFilesValidationError(e))
    }
    const safeFailed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "find/files" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "validation.failed", message: "bad", retryable: true },
      },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: true },
    }
    const wire = normalizePrivateFindFilesWire(safeFailed, req)
    expect(wire.kind).toBe("valid")
    if (wire.kind === "valid" && wire.result.status === "failed") {
      expect(wire.result.failure.code).toBe(FIND_FILES_FAILED_CODE)
      expect(wire.result.failure.message).toBe(FIND_FILES_FAILED_MESSAGE)
      expect(wire.result.failure.retryable).toBeTrue()
      expect(JSON.stringify(wire.result)).not.toContain("validation.failed")
    }
    const evil = "/tmp/secret-evil"
    const evilFailed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "find/files" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: `${evil}/code`, message: `at ${evil}`, retryable: false },
      },
      accepted: false as const,
      failure: { code: `${evil}/code`, message: `at ${evil}`, retryable: false },
    }
    const evilWire = normalizePrivateFindFilesWire(evilFailed, req)
    expect(evilWire.kind).toBe("invalid")
    if (evilWire.kind === "invalid") {
      expect(evilWire.detail).toBe(FIND_FILES_INVALID_DETAIL)
      expect(evilWire.detail).not.toContain(evil)
    }
    const amb = makeFindFilesAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateFindFilesResult(amb, req)).not.toThrow()
    expect(() => validateFindFilesResult({ ...amb, accepted: true }, req)).toThrow()
  })
})
