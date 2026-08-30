#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

// Patch openapi.json parentSessionId to be nullable (Effect OpenAPI generator drops null for optional NullOr, source is correct)
for (const p of [`${dir}/openapi.json`, path.resolve(dir, "../openapi.json")]) {
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
          } else if (typeof v === "object" && v !== null) {
            walk(v)
          }
        }
      }
    }
    walk(json)
    if (patched) await Bun.write(p, JSON.stringify(json, null, 2))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as unknown as { code?: string })?.code
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("No such file")) {
      console.warn(`[sdk/build] openapi patch: ${p} not found, skipping`)
      continue
    }
    console.error(`[sdk/build] openapi patch failed for ${p}:`, err)
    throw new Error(`[sdk/build] openapi patch failed for ${p}: ${msg}`, { cause: err })
  }
}
// integrity: patched openapi.json must remain valid JSON
for (const p of [`${dir}/openapi.json`, path.resolve(dir, "../openapi.json")]) {
  try {
    const text = await Bun.file(p).text()
    JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as unknown as { code?: string })?.code
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("No such file")) continue
    console.error(`[sdk/build] openapi integrity failed for ${p}:`, err)
    throw new Error(`[sdk/build] openapi integrity failed for ${p}: ${msg}`, { cause: err })
  }
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "KiloClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch parentSessionId nullable (Hey API may drop null even with anyOf, ensure string | null)
for (const genPath of ["./src/v2/gen/types.gen.ts", "./src/v2/gen/sdk.gen.ts"]) {
  try {
    const f = Bun.file(genPath)
    const src = await f.text()
    const patched = src.replace(/parentSessionId\?: string;/g, "parentSessionId?: string | null;").replace(/parentSessionId\?: string\s*\n/g, "parentSessionId?: string | null;\n")
    if (patched !== src) await Bun.write(genPath, patched)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[sdk/build] gen patch failed for ${genPath}:`, err)
    throw new Error(`[sdk/build] gen patch failed for ${genPath}: ${msg}`, { cause: err })
  }
}
// integrity: patched gen must contain nullable parentSessionId
for (const genPath of ["./src/v2/gen/types.gen.ts", "./src/v2/gen/sdk.gen.ts"]) {
  const src = await Bun.file(genPath).text()
  if (!src.includes("parentSessionId?: string | null;")) {
    throw new Error(`[sdk/build] gen integrity failed: ${genPath} missing parentSessionId?: string | null`)
  }
}

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// The legacy SDK generator is retired, but this public Config type remains exported.
// Keep Kilo's released sandbox settings aligned with the current generated client.
const legacyTypesPath = "./src/gen/types.gen.ts"
const legacyTypesFile = Bun.file(legacyTypesPath)
const legacySource = await legacyTypesFile.text()
const sandbox = `  /**
   * Sandbox configuration for agent tools
   */
  sandbox?: {
    /**
     * Enable sandbox confinement for new sessions (default: false)
     */
    enabled?: boolean
    /**
     * Control outbound network access from sandboxed tools (default: deny)
     */
    network?: "allow" | "deny"
    /**
     * Additional filesystem paths that sandboxed tools may write to
     */
    writable_paths?: Array<string>
  }
`
const legacyPatched = legacySource.includes(sandbox)
  ? legacySource
  : legacySource.replace("  experimental?: {\n", sandbox + "  experimental?: {\n")
if (!legacyPatched.includes(sandbox)) {
  throw new Error(`Legacy Config sandbox patch did not apply (${legacyTypesPath})`)
}
await Bun.write(legacyTypesPath, legacyPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist tsconfig.tsbuildinfo`
await $`bun tsc`
await $`rm openapi.json`
