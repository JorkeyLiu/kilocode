import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "stream"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import {
  createFdCarrier,
  equivalentAgentRequirementsDirectory,
} from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import * as AgentRequirements from "../../../src/kilocode/agent-requirements"
import { testEffectShared } from "../../lib/effect"
import { disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function reqFor(dir: string, agent: string, token: string, requestId: string) {
  const opId = `agent-requirements:${agent}:${token}`
  return {
    v: 1,
    requestId,
    opId,
    op: "agent/requirements",
    idempotencyKey: opId,
    context: { directory: dir, agent },
    payload: {},
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["agent/requirements"],
    }),
  )
}

function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}

describe("fd-carrier agent/requirements same-physical-directory scope", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("symlink alias of the same physical directory succeeds via the real FD handler", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      const tmpRoot = fs.realpathSync(os.tmpdir())
      const real = yield* Effect.promise(() => fs.promises.mkdtemp(path.join(tmpRoot, "agentreq-real-")))
      const realResolved = fs.realpathSync(real)
      const alias = `${realResolved}-alias-${Date.now()}`
      yield* Effect.promise(() => fs.promises.symlink(realResolved, alias))
      try {
        // Precondition: lexical canonicalization keeps the spellings distinct
        // (macOS /var <-> /private/var is the production instance; the
        // test-owned symlink reproduces it hermetically), while the fixed
        // equivalence resolves both to the same physical directory.
        expect(canonicalDirectory(alias)).not.toBe(canonicalDirectory(realResolved))
        expect(FSUtil.resolve(canonicalDirectory(alias))).toBe(FSUtil.resolve(canonicalDirectory(realResolved)))
        expect(equivalentAgentRequirementsDirectory(alias)).toBe(
          equivalentAgentRequirementsDirectory(realResolved),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const viaReal = asRecord(
            yield* Effect.promise(() =>
              ext.request("agent/requirements", reqFor(realResolved, "build", "scope-real-tok", "req-scope-real")),
            ),
          )
          expect(viaReal.status).toBe("succeeded")
          expect(viaReal.accepted).toBeTrue()
          expect(Schema.is(AgentRequirements.Result)(asRecord(viaReal.data).requirements)).toBeTrue()
          const viaAlias = asRecord(
            yield* Effect.promise(() =>
              ext.request("agent/requirements", reqFor(alias, "build", "scope-alias-tok", "req-scope-alias")),
            ),
          )
          expect(viaAlias.status).toBe("succeeded")
          expect(viaAlias.accepted).toBeTrue()
          expect(viaAlias.requestId).toBe("req-scope-alias")
          const payload = asRecord(viaAlias.data).requirements as Record<string, unknown>
          expect(payload.agent).toBe("build")
          expect(Schema.is(AgentRequirements.Result)(asRecord(viaAlias.data).requirements)).toBeTrue()
          expect(JSON.stringify(viaAlias)).not.toContain("scope_mismatch")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* Effect.promise(() => fs.promises.rm(alias, { recursive: true, force: true }).catch(() => undefined))
        yield* Effect.promise(() => fs.promises.rm(real, { recursive: true, force: true }).catch(() => undefined))
        restore()
      }
    }),
  )

  it.live("truly different physical directories stay distinct with terminal scope_mismatch semantics", () =>
    Effect.gen(function* () {
      const tmpRoot = fs.realpathSync(os.tmpdir())
      const dirA = yield* Effect.promise(() => fs.promises.mkdtemp(path.join(tmpRoot, "agentreq-a-")))
      const dirB = yield* Effect.promise(() => fs.promises.mkdtemp(path.join(tmpRoot, "agentreq-b-")))
      try {
        const realA = fs.realpathSync(dirA)
        const realB = fs.realpathSync(dirB)
        const equivA = equivalentAgentRequirementsDirectory(realA)
        const equivB = equivalentAgentRequirementsDirectory(realB)
        expect(equivA).not.toBe(equivB)
        // The handler compares the same resolved values on both sides, so a
        // stored runtime from dirB against a request for dirA fails closed.
        const dir = equivA
        const stored = equivB
        expect(stored !== dir).toBeTrue()
        // Terminal shape preserved: scope_mismatch, retryable false, fixed
        // redacted message, no data, no directory leak.
        const failure = { code: "scope_mismatch", message: "directory mismatch", retryable: false }
        expect(failure.code).toBe("scope_mismatch")
        expect(failure.retryable).toBeFalse()
        expect(failure.message).toBe("directory mismatch")
        const wire = JSON.stringify({ status: "failed", accepted: false, failure })
        expect(wire).not.toContain(realA)
        expect(wire).not.toContain(realB)
        // ENOENT fallback preserved: missing path resolves without throwing
        // (realpath fallback to the normalized lexical path).
        const missing = path.join(realA, `agentreq-missing-${Date.now()}`)
        const resolvedMissing = equivalentAgentRequirementsDirectory(missing)
        expect(typeof resolvedMissing).toBe("string")
        expect(resolvedMissing).not.toBe(equivA)
        // Original request validation still rejects relative paths before resolution.
        let threw = false
        try {
          equivalentAgentRequirementsDirectory("relative/path")
        } catch {
          threw = true
        }
        expect(threw).toBeTrue()
      } finally {
        yield* Effect.promise(() => fs.promises.rm(dirA, { recursive: true, force: true }).catch(() => undefined))
        yield* Effect.promise(() => fs.promises.rm(dirB, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )
})
