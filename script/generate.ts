#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

// Patch root openapi.json parentSessionId nullable (same reason as js build)
{
  const p = "packages/sdk/openapi.json"
  try {
    const text = await Bun.file(p).text()
    const json = JSON.parse(text)
    let patched = false
    const walk = (obj: unknown) => {
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (k === "parentSessionId" && v && typeof v === "object" && !Array.isArray(v)) {
            const vv = v as Record<string, unknown>
            if (vv.type === "string" && !vv.anyOf) {
              const pattern = vv.pattern
              vv.anyOf = [{ type: "string", ...(typeof pattern === "string" ? { pattern } : {}) }, { type: "null" }]
              delete vv.type
              delete vv.pattern
              patched = true
            }
          } else if (typeof v === "object" && v !== null) walk(v)
        }
      }
    }
    walk(json)
    if (patched) await Bun.write(p, JSON.stringify(json, null, 2))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as unknown as { code?: string })?.code
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("No such file")) {
      console.warn(`[generate] openapi patch: ${p} not found, skipping`)
    } else {
      console.error(`[generate] openapi patch failed for ${p}:`, err)
      throw new Error(`[generate] openapi patch failed for ${p}: ${msg}`, { cause: err })
    }
  }
  // integrity: root openapi.json must remain valid JSON if present
  try {
    const text = await Bun.file(p).text()
    JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as unknown as { code?: string })?.code
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("No such file")) {
      // absent is allowed no-op
    } else {
      console.error(`[generate] openapi integrity failed for ${p}:`, err)
      throw new Error(`[generate] openapi integrity failed for ${p}: ${msg}`, { cause: err })
    }
  }
}

await $`bun ./script/generate-cli-docs.ts`
