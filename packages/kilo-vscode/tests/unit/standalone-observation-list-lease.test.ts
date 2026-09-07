import { describe, it, expect } from "bun:test"
import * as fs from "fs"
import * as path from "path"

describe("standalone private-worker session-list no-lease boundary (vscode mirror)", () => {
  it("default worker lightweight, standalone composes no-lease session-list", () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const def = fs.readFileSync(path.join(base, "worker.ts"), "utf8")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    const adapter = fs.readFileSync(path.join(base, "session-list-adapter.ts"), "utf8")
    const obs = fs.readFileSync(path.join(base, "observation.ts"), "utf8")
    const svc = fs.readFileSync(path.join(base, "private-observation-service.ts"), "utf8")

    expect(def).not.toContain("Database.layerNoLease")
    expect(def).not.toContain("createSessionListDeps")
    expect(def).not.toContain("KILO_PRIVATE_WORKER_STANDALONE")

    expect(standalone).toContain("Database.layerNoLease")
    expect(standalone).toContain("createChangefeedDeps")
    expect(standalone).toContain("createSessionListDeps")
    expect(standalone).toContain("createSessionGetDeps")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")

    expect(adapter).toContain("decodeGlobalListCursor")
    expect(adapter).toContain("encodeGlobalListCursor")
    expect(adapter).toContain("limit + 1")

    const getAdapter = fs.readFileSync(path.join(base, "session-get-adapter.ts"), "utf8")
    expect(getAdapter).toContain('status: "not_found"')
    expect(getAdapter).toContain('status: "scope_mismatch"')
    expect(getAdapter).toContain('status: "found"')
    expect(getAdapter).toContain("SessionTable")

    expect(obs).toContain('LIST: "observation/list"')
    expect(obs).toContain('GET: "observation/get"')
    expect(obs).toContain("limit must be integer 1..500")
    expect(obs).toContain("sessionId must be non-empty session id")

    expect(svc).toContain("async list(")
    expect(svc).toContain('OBSERVATION_METHODS.LIST')
    expect(svc).toContain("async get(")
    expect(svc).toContain('OBSERVATION_METHODS.GET')
    expect(svc).not.toContain("AgentManagerProvider")

    expect(standalone).not.toContain("InstanceRef")
    expect(standalone).not.toContain("AppLayer")
    expect(standalone).not.toContain("drain-control")
    expect(adapter).not.toContain("InstanceRef")
    expect(adapter).not.toContain("AppLayer")
    expect(getAdapter).not.toContain("InstanceRef")
    expect(getAdapter).not.toContain("AppLayer")
    expect(getAdapter).not.toContain("drain-control")
    expect(getAdapter).not.toContain("Database.layerFromPath")
  })
})
