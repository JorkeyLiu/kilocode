#!/usr/bin/env node
/**
 * Minimal run-owned stdio MCP server fixture for the P0 benchmark's
 * many-agent/MCP startup scenario.
 *
 * This is a REAL connectable MCP server, not a fake result: the `kilo serve`
 * backend spawns it via the seeded kilo config (`mcp.p0-bench-mcp.command =
 * ["node", "<abs path to this file>"]`) and performs a genuine MCP stdio
 * handshake (initialize → initialized → tools/list) against it during
 * startup. The fixture speaks the MCP stdio transport (newline-delimited
 * JSON-RPC 2.0) using no dependencies.
 *
 * Supported protocol methods: initialize, notifications/initialized (silent),
 * ping, tools/list, prompts/list, tools/call. prompts/list answers with a
 * valid empty prompt list so the backend's startup `MCP.prompts` query
 * resolves immediately instead of hitting the SDK's default 60s request
 * timeout; it must never be an error/timeout proxy for startup readiness.
 *
 * Truthfulness markers (written into the run-owned scratch dir, whose absolute
 * path is passed via P0_MCP_MARKER):
 *   <marker>  — written after the first `tools/list` request, which the
 *               backend only issues after `initialize` succeeds. Content:
 *               JSON {"pid":<this pid>,"connectedAt":<epoch ms>} (small,
 *               bounded payload). The write is ATOMIC and content-complete
 *               (temp file + renameSync): the probe polls on file existence
 *               and parses immediately, so the marker path either does not
 *               exist or already holds the full payload — an async
 *               createWriteStream open/write (or even a bare writeFileSync's
 *               open→write window) could expose an exists-but-empty file
 *               (marker read race). Once this marker appears, the probe
 *               discovers the full exact-owned identity (PID + raw ps `lstart`
 *               start string + args containing the exact fixture script path)
 *               from the live process table and re-verifies it immediately
 *               before every cleanup signal — PID-reuse-safe, never a bare-PID
 *               kill.
 *
 * Lifecycle ownership: the backend kills this child (StdioClientTransport
 * close + descendant SIGTERM) when it exits; when the backend is hard-killed
 * the OS closes this process's stdin and it exits itself. The harness
 * additionally retains the verified identity and terminates it by exact
 * identity (PID + start + script path re-verified before each SIGTERM/SIGKILL)
 * during cleanup, verifying it is gone before deleting scratch. When stdin
 * closes (transport closed), this process exits itself.
 */
import { renameSync, writeFileSync } from "node:fs"

const marker = process.env.P0_MCP_MARKER

function writeMarker(payload) {
  if (!marker) return
  try {
    // Atomic content-complete marker write: the full payload is written to a
    // sibling temp file, then renameSync over the marker path. rename is
    // atomic on POSIX, so the probe's poll-on-existence → parse-immediately
    // read can never observe an empty/partial marker — the path either does
    // not exist or already holds the complete payload (a bare writeFileSync
    // still has an open→write window another process can observe). The payload
    // stays small and bounded ({pid, connectedAt}).
    const tmp = marker + ".tmp"
    writeFileSync(tmp, JSON.stringify(payload) + "\n")
    renameSync(tmp, marker)
  } catch {
    // Marker writes are best-effort evidence; a failed write must not crash
    // the MCP server (the backend would see a connection failure and mark the
    // scenario blocked, which is a truthful outcome we report).
  }
}

const serverInfo = { name: "p0-bench-mcp", version: "1.0.0" }

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

let handshakeDone = false

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo,
      })
      continue
    }
    if (msg.method === "ping") {
      respond(msg.id, {})
      continue
    }
    if (msg.method === "tools/list") {
      respond(msg.id, {
        tools: [
          {
            name: "p0_bench_mcp_tool",
            description: "P0 benchmark fixture tool (never invoked)",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      })
      if (!handshakeDone) {
        handshakeDone = true
        writeMarker({ pid: process.pid, connectedAt: Date.now() })
      }
      continue
    }
    if (msg.method === "tools/call") {
      respond(msg.id, { content: [{ type: "text", text: "p0-bench-fixture" }] })
      continue
    }
    if (msg.method === "prompts/list") {
      // Valid spec-compliant empty prompt list. The backend issues this during
      // startup dataReady (MCP.prompts); answering it keeps startup bounded to
      // the real tools/list handshake instead of the SDK's 60s request timeout.
      // This deliberately does NOT write the truthfulness marker — the marker
      // writes only after the tools/list handshake below.
      respond(msg.id, { prompts: [] })
      continue
    }
    // Notifications (e.g. notifications/initialized) and unknown methods get
    // no response — the MCP client tolerates silence for notifications.
  }
})

process.stdin.on("end", () => {
  // Transport closed (backend exited or closed the connection) — exit cleanly.
  process.exit(0)
})
