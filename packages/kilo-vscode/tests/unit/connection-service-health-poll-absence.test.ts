/**
 * P4.4-T1a static absence + presence contract for the connection service.
 *
 * Bounded transport narrowing (LOCK-014): the redundant periodic
 * `/global/health` poll is removed from `KiloConnectionService`. The
 * `SdkSSEAdapter` heartbeat/reconnect remains the sole liveness path for the
 * migration bridge (LOCK-009), so its heartbeat and reconnect machinery must
 * survive. Request transport (`createKiloClient`, SDK client ownership) and
 * direct server-info consumers (`getServerInfo`, `getServerConfig`) must
 * remain available.
 *
 * Static analysis — reads the connection service source and verifies:
 *
 * - Absence: `HEALTH_POLL_INTERVAL_MS`, `startHealthPoll`, `stopHealthPoll`,
 *   `checkHealth`, the `healthPollTimer` field, and any `/global/health`
 *   reference are gone from the connection service; no call site or cleanup
 *   path references the removed poll.
 * - Retained check-in lifecycle: `startCheckin`, `stopCheckin`, the
 *   `checkinTimer` field, and both timer cleanup paths (dispose + stopCheckin)
 *   survive — the periodic viewed-flush check-in stays while the health poll goes.
 * - Presence: `getServerInfo()` / `getServerConfig()` (direct server-info
 *   consumers), `createKiloClient` (SDK request transport), and the SSE
 *   heartbeat/reconnect liveness path (`HEARTBEAT_TIMEOUT_MS`, `reconnect`)
 *   survive — guarding against a broader-than-approved transport cut.
 *
 * Protects against accidental reintroduction of the redundant poll or an
 * over-broad transport deletion during later phases.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const CONNECTION = path.join(ROOT, "src/services/cli-backend/connection-service.ts")
const ADAPTER = path.join(ROOT, "src/services/cli-backend/sdk-sse-adapter.ts")

const source = fs.readFileSync(CONNECTION, "utf-8")
const adapter = fs.readFileSync(ADAPTER, "utf-8")

describe("KiloConnectionService health poll removal (P4.4-T1a)", () => {
  it("removes the periodic /global/health poll surface", () => {
    for (const identifier of [
      "HEALTH_POLL_INTERVAL_MS",
      "startHealthPoll",
      "stopHealthPoll",
      "checkHealth",
      "healthPollTimer",
    ]) {
      expect(source, `connection-service must not reference ${identifier}`).not.toContain(identifier)
    }
    expect(source, "connection-service must not poll /global/health").not.toContain("global/health")
  })

  it("removes every poll cleanup call site (dispose, resetConnection, doConnect)", () => {
    // The previously coupled call sites must be gone: dispose() cleanup,
    // resetConnection() mid-connection teardown, and the doConnect() start.
    // The only remaining periodic timer is the startCheckin() viewed-flush
    // check-in, which stays.
    expect(source).not.toContain("stopHealthPoll()")
    expect(source).not.toContain("startHealthPoll(")
    expect(source).toContain("startCheckin()")
  })
})

describe("KiloConnectionService retained check-in lifecycle", () => {
  it("keeps the startCheckin/stopCheckin definitions and the checkinTimer field", () => {
    expect(source).toContain("private startCheckin(): void")
    expect(source).toContain("private stopCheckin(): void")
    expect(source).toContain("private checkinTimer: ReturnType<typeof setInterval> | null")
  })

  it("keeps the check-in start call and both timer cleanup paths", () => {
    // startCheckin() kicks the 60s viewed-flush timer only after SSE connects
    // (end of doConnect); resetConnection() tears it down via stopCheckin();
    // dispose() and stopCheckin() both clear the interval. Neither cleanup
    // path may vanish while the health-poll removal lands.
    expect(source).toContain("this.startCheckin()")
    expect(source).toContain("this.stopCheckin()")
    const clears = source.match(/clearInterval\(this\.checkinTimer\)/g) ?? []
    expect(clears.length).toBeGreaterThanOrEqual(2)
    expect(source).toContain("this.checkinTimer = null")
  })
})

describe("KiloConnectionService retained transport surface (LOCK-009)", () => {
  it("keeps server-info and direct HTTP/consumer access available", () => {
    // getServerInfo + getServerConfig back direct consumers: speech-to-text,
    // image-generation, Agent Manager terminal routing.
    expect(source).toContain("getServerInfo(): { port: number } | null")
    expect(source).toContain("getServerConfig(): ServerConfig | null")
  })

  it("keeps SDK client construction and the SSE heartbeat/reconnect liveness path", () => {
    // Request transport: the shared SDK client is still created from server
    // port/password and exposed to all SDK request methods.
    expect(source).toContain("createKiloClient({")
    expect(source).toContain("new SdkSSEAdapter(client)")
    // Liveness is now solely the adapter heartbeat + reconnect loop.
    expect(adapter).toContain("HEARTBEAT_TIMEOUT_MS")
    expect(adapter).toContain("reconnect(): void")
  })
})
