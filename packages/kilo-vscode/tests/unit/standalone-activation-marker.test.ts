import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"

describe("standalone private observation activation marker gate (vscode mirror)", () => {
  it("vscode standalone mirrors opencode marker gate without lease/AppLayer", async () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    const opencode = fs.readFileSync(
      path.resolve(process.cwd(), "../opencode/src/private-worker/standalone-worker.ts"),
      "utf8",
    )
    expect(standalone).toContain("Database.assertNoActivationMarker")
    expect(opencode).toContain("Database.assertNoActivationMarker")
    expect(standalone).toContain("Database.layerNoLease")
    expect(standalone).not.toContain("Database.layerFromPath")
    expect(standalone).not.toContain("acquireLease")
    expect(standalone).not.toContain("AppLayer")
    expect(standalone).not.toContain("InstanceRef")
    expect(standalone).not.toContain("GenerationGate")
    expect(standalone).not.toContain("Snapshot")
    expect(standalone).not.toContain("leasePathFor")
    // mirror must be in sync with opencode source logic
    const gateLine = "await Database.assertNoActivationMarker(file)"
    expect(standalone).toContain(gateLine)
    expect(opencode).toContain(gateLine)
    // database layer exports shared helper
    const db = fs.readFileSync(path.resolve(process.cwd(), "../core/src/database/database.ts"), "utf8")
    expect(db).toContain("export function markerPathsForFile")
    expect(db).toContain("export async function assertNoActivationMarker")
    expect(db).toContain("DB activation blocked: marker exists at")
  })
})
