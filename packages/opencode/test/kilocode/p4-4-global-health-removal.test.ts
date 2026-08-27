import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4 transport-narrowing — server-side `/global/health` deprecated public transport surface removed.
// LOCK-002: connection liveness must continue through existing SDK SSE reconnect path; do not introduce replacement health poll.
// LOCK-003: HTTP/SSE config-console bridge and all unrelated public endpoints remain intact.
// This unit proves: global health endpoint/handler and generated SDK/OpenAPI exposures are deleted,
// while SSE heartbeat/reconnect and retained global routes survive.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))
const sdk = join(repo, "packages/sdk")

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}
function readSdk(rel: string): string {
  return readFileSync(join(sdk, rel), "utf8")
}

describe("P4.4 global health removal — server transport surface deleted", () => {
  test("groups/global.ts no longer defines health", () => {
    const src = read("server/routes/instance/httpapi/groups/global.ts")
    expect(src).not.toContain("/global/health")
    expect(src).not.toContain("GlobalHealth")
    expect(src).not.toContain('identifier: "global.health"')
    expect(src).not.toContain('get("health"')
    expect(src).not.toContain("health:")
    // Retained global routes remain
    expect(src).toContain('"/global/event"')
    expect(src).toContain('"/global/config"')
    expect(src).toContain('"/global/dispose"')
    expect(src).toContain('"/global/upgrade"')
    expect(src).toContain("GlobalPaths = {")
    expect(src).toContain("event: \"/global/event\"")
    expect(src).toContain("config: \"/global/config\"")
    expect(src).toContain("HttpApiEndpoint.get(\"event\"")
    expect(src).toContain("HttpApiEndpoint.get(\"configGet\"")
    expect(src).toContain("HttpApiEndpoint.patch(\"configUpdate\"")
    expect(src).toContain("HttpApiEndpoint.post(\"dispose\"")
    expect(src).toContain("HttpApiEndpoint.post(\"upgrade\"")
  })

  test("handlers/global.ts no longer implements health", () => {
    const src = read("server/routes/instance/httpapi/handlers/global.ts")
    expect(src).not.toContain("/global/health")
    expect(src).not.toContain("global.health")
    expect(src).not.toContain("GlobalHttpApi.health")
    expect(src).not.toContain('.handle("health"')
    expect(src).not.toContain("healthy: true")
    expect(src).not.toContain("InstallationVersion")
    // Retained handlers remain
    expect(src).toContain("GlobalHttpApi.event")
    expect(src).toContain("GlobalHttpApi.configGet")
    expect(src).toContain("GlobalHttpApi.configUpdate")
    expect(src).toContain("GlobalHttpApi.dispose")
    expect(src).toContain("GlobalHttpApi.upgrade")
    expect(src).toContain('handleRaw("event"')
    expect(src).toContain('handle("configGet"')
    expect(src).toContain('handle("dispose"')
  })

  test("OpenAPI no longer exposes /global/health", () => {
    const openapi = readRepo("packages/sdk/openapi.json")
    expect(openapi).not.toContain("/global/health")
    expect(openapi).not.toContain("\"global.health\"")
    expect(openapi).not.toContain("Get health")
    // Retained global endpoints remain
    expect(openapi).toContain("/global/event")
    expect(openapi).toContain("global.event")
    expect(openapi).toContain("/global/config")
    expect(openapi).toContain("global.config.get")
    expect(openapi).toContain("/global/dispose")
    expect(openapi).toContain("global.dispose")
    expect(openapi).toContain("/global/upgrade")
  })

  test("generated SDK v2 no longer exposes global health", () => {
    const sdkGen = readSdk("js/src/v2/gen/sdk.gen.ts")
    const typesGen = readSdk("js/src/v2/gen/types.gen.ts")
    expect(sdkGen).not.toContain("global.health")
    expect(sdkGen).not.toContain("GlobalHealth")
    expect(sdkGen).not.toContain("/global/health")
    expect(sdkGen).not.toContain('summary: "Get health"')
    expect(typesGen).not.toContain("GlobalHealth")
    expect(typesGen).not.toContain('url: "/global/health"')
    expect(typesGen).not.toContain("global.health")
    // Retained SDK surfaces remain
    expect(sdkGen).toContain('url: "/global/event"')
    expect(sdkGen).toContain('url: "/global/config"')
    expect(sdkGen).toContain('url: "/global/dispose"')
    expect(sdkGen).toContain('url: "/global/upgrade"')
    expect(typesGen).toContain('url: "/global/event"')
    expect(typesGen).toContain('url: "/global/config"')
  })

  test("httpapi exercise no longer covers /global/health", () => {
    const exercise = readRepo("packages/opencode/test/server/httpapi-exercise/index.ts")
    expect(exercise).not.toContain("/global/health")
    expect(exercise).not.toContain("global.health")
    expect(exercise).toContain("/global/event")
    expect(exercise).toContain("global.event")
  })

  test("httpapi instance OpenAPI doc expectation no longer requires health", () => {
    const inst = read("server/routes/instance/httpapi/groups/global.ts")
    expect(inst).not.toContain("/global/health")
    const test = readRepo("packages/opencode/test/server/httpapi-instance.test.ts")
    expect(test).not.toContain("/global/health")
    expect(test).toContain("/global/event")
  })

  test("daemon health probe no longer uses /global/health", () => {
    const daemon = read("kilocode/daemon/daemon.ts")
    expect(daemon).not.toContain("/global/health")
    expect(daemon).toContain("/global/config")
    expect(daemon).toContain("await fetch(`${input.url}/global/config`")
  })

  test("debug workspace plugin no longer polls /global/health", () => {
    const plugin = read("control-plane/dev/debug-workspace-plugin.ts")
    expect(plugin).not.toContain("/global/health")
    expect(plugin).toContain("/global/event")
  })

  test("SSE reconnect liveness path remains (LOCK-002)", () => {
    const group = read("server/routes/instance/httpapi/groups/global.ts")
    expect(group).toContain("/global/event")
    expect(group).toContain('identifier: "global.event"')
    const handler = read("server/routes/instance/httpapi/handlers/global.ts")
    expect(handler).toContain("GlobalBus.on")
    expect(handler).toContain("server.connected")
    expect(handler).toContain("server.heartbeat")
    expect(handler).toContain("Stream.tick")
    expect(handler).toContain("Stream.interruptWhen")
    // Extension adapter heartbeat/reconnect machinery remains
    const adapter = readRepo("packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts")
    expect(adapter).toContain("HEARTBEAT_TIMEOUT_MS")
    expect(adapter).toContain("reconnect(): void")
    expect(adapter).toContain("heartbeat")
  })

  test("retained global and v2 health contracts remain distinct", () => {
    const openapi = readRepo("packages/sdk/openapi.json")
    // v2 /api/health remains (distinct from /global/health)
    expect(openapi).toContain("/api/health")
    expect(openapi).toContain("v2.health.get")
    const v2group = readRepo("packages/server/src/groups/v2/health.ts")
    expect(v2group).toContain("/api/health")
    expect(v2group).toContain("v2.health.get")
  })

  test("serve smoke test no longer probes /global/health", () => {
    const serve = readRepo("packages/opencode/test/cli/serve/serve-process.test.ts")
    expect(serve).not.toContain("/global/health")
    expect(serve).toContain("/global/config")
  })

  test("httpapi SDK test no longer exercises global.health", () => {
    const sdkTest = readRepo("packages/opencode/test/server/httpapi-sdk.test.ts")
    expect(sdkTest).not.toContain("sdk.global.health")
    expect(sdkTest).toContain("sdk.global.config.get")
    expect(sdkTest).toContain("sdk.global.event")
  })

  test("generated SDK files exist and were regenerated", () => {
    expect(existsSync(join(sdk, "js/src/v2/gen/sdk.gen.ts"))).toBe(true)
    expect(existsSync(join(sdk, "js/src/v2/gen/types.gen.ts"))).toBe(true)
    expect(existsSync(join(repo, "packages/sdk/openapi.json"))).toBe(true)
  })
})
