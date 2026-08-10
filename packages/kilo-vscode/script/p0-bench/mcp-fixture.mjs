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
 * Truthfulness markers (written into the run-owned scratch dir, whose absolute
 * path is passed via P0_MCP_MARKER):
 *   <marker>       — written after the first `tools/list` request, which the
 *                    backend only issues after `initialize` succeeds. Content:
 *                    JSON {"pid":<this pid>,"connectedAt":<epoch ms>}.
 *   <marker>.pid   — this process's PID (for exact-owned cleanup).
 *
 * Lifecycle ownership: the backend kills this child (StdioClientTransport
 * close + descendant SIGTERM) when it exits; the harness additionally records
 * the PID and terminates it by exact PID during cleanup, verifying it is gone
 * before deleting scratch. When stdin closes (transport closed), this process
 * exits itself.
 */
import { createWriteStream } from "node:fs"

const marker = process.env.P0_MCP_MARKER

function writeMarker(payload) {
  if (!marker) return
  try {
    createWriteStream(marker, { flags: "a" }).end(JSON.stringify(payload) + "\n")
    createWriteStream(marker + ".pid", { flags: "w" }).end(String(process.pid) + "\n")
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
    // Notifications (e.g. notifications/initialized) and unknown methods get
    // no response — the MCP client tolerates silence for notifications.
  }
})

process.stdin.on("end", () => {
  // Transport closed (backend exited or closed the connection) — exit cleanly.
  process.exit(0)
})
