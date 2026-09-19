#!/usr/bin/env bun
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { collectBaselineFsOnly, formatBaseline } from "@opencode-ai/core/storage/baseline"

function parseArgs(): { dataRoot: string; pretty: boolean; help: boolean } {
  const args = process.argv.slice(2)
  let dataRoot = process.env.KILO_DATA_DIR ?? Global.Path.data
  let pretty = true
  let help = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--data-root" && args[i + 1]) {
      dataRoot = args[++i]
    } else if (a.startsWith("--data-root=")) {
      dataRoot = a.slice("--data-root=".length)
    } else if (a === "--compact") {
      pretty = false
    } else if (a === "--pretty") {
      pretty = true
    } else if (a === "--help" || a === "-h") {
      help = true
    }
  }
  // safety: never write, only read; resolve but don't create
  return { dataRoot: path.resolve(dataRoot), pretty, help }
}

async function main() {
  const { dataRoot, pretty, help } = parseArgs()
  if (help) {
    console.log(`storage-baseline: read-only canonical storage baseline (S0)
Usage: bun run storage-baseline [--data-root <path>] [--compact]
Env: KILO_DATA_DIR overrides Global.Path.data
Output: versioned JSON to stdout (stable, machine-readable)
  - DB files: kilo.db / wal / shm / session-export.db (+wal/shm)
  - Tables: session/message/part/event/changefeed/operation etc with rows/bytes
  - Artifacts: session_diff / session_diff_base / session_share / snapshot
  - Families: total/roots
  - Changefeed: latestSeq/retainedRows/retainedBytes
For production: defaults to Global.Path.data (${Global.Path.data}) read-only, no lease, no writes.
For fixtures: pass --data-root <tmp> pointing at isolated canonical DB.`)
    process.exit(0)
  }
  const report = await collectBaselineFsOnly(dataRoot)
  const out = pretty ? formatBaseline(report) : JSON.stringify(report)
  process.stdout.write(out + "\n")
}

await main()
