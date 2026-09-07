import { describe, it, expect } from "bun:test"
import * as fs from "fs"
import * as path from "path"

describe("standalone private-worker session-list no-lease boundary", () => {
  it("default worker remains lightweight without DB lease, standalone composes no-lease session-list", () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const def = fs.readFileSync(path.join(base, "worker.ts"), "utf8")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    const adapter = fs.readFileSync(path.join(base, "session-list-adapter.ts"), "utf8")
    const obs = fs.readFileSync(path.join(base, "observation.ts"), "utf8")

    // default worker must not acquire lease nor import session-list adapter
    expect(def).not.toContain("Database.layerFromPath")
    expect(def).not.toContain("Database.layerNoLease")
    expect(def).not.toContain("createChangefeedDeps")
    expect(def).not.toContain("createSessionListDeps")
    expect(def).not.toContain("KILO_PRIVATE_WORKER_STANDALONE")
    // standalone must use no-lease and compose both adapters
    expect(standalone).toContain("Database.layerNoLease")
    expect(standalone).not.toContain("Database.layerFromPath")
    expect(standalone).toContain("createChangefeedDeps")
    expect(standalone).toContain("createSessionListDeps")
    expect(standalone).toContain("createSessionGetDeps")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")
    expect(standalone).toContain("KILO_DB")
    // adapter must reuse canonical cursor codec and query with limit+1
    expect(adapter).toContain("decodeGlobalListCursor")
    expect(adapter).toContain("encodeGlobalListCursor")
    expect(adapter).toContain("limit + 1")
    expect(adapter).toContain("desc(SessionTable.time_updated)")
    const getAdapter = fs.readFileSync(path.join(base, "session-get-adapter.ts"), "utf8")
    expect(getAdapter).toContain("SessionTable")
    expect(getAdapter).toContain('status: "not_found"')
    expect(getAdapter).toContain('status: "scope_mismatch"')
    expect(getAdapter).toContain('status: "found"')
    // observation must expose LIST/GET method and strict validation
    expect(obs).toContain('LIST: "observation/list"')
    expect(obs).toContain('GET: "observation/get"')
    expect(obs).toContain("limit must be integer 1..500")
    expect(obs).toContain("cursor must be opaque session-list cursor string")
    expect(obs).toContain("unsupported observation version")
    expect(obs).toContain("unexpected field")
    expect(obs).toContain("sessionId must be non-empty session id")
    // ensure no InstanceRef/drain-control leakage
    expect(standalone).not.toContain("InstanceRef")
    expect(standalone).not.toContain("drain-control")
    expect(standalone).not.toContain("InstanceState")
    expect(standalone).not.toContain("AppLayer")
    expect(adapter).not.toContain("InstanceRef")
    expect(adapter).not.toContain("AppLayer")
    expect(getAdapter).not.toContain("InstanceRef")
    expect(getAdapter).not.toContain("AppLayer")
    expect(getAdapter).not.toContain("drain-control")
    expect(getAdapter).not.toContain("Database.layerFromPath")
  })
})
