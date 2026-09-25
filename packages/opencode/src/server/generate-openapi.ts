#!/usr/bin/env bun
// Direct non-public OpenAPI generator entry.
// Reuses Server.openapi() and mirrors src/cli/cmd/generate.ts transformations
// without loading the full src/index.ts yargs command tree.

import * as Server from "./server"

export async function generateOpenApiJson(): Promise<string> {
  const specs = (await Server.openapi()) as {
    info: { title: string; description: string }
    paths: Record<string, Record<string, unknown>>
  }
  specs.info.title = "kilo"
  specs.info.description = "kilo api"
  for (const item of Object.values(specs.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = (item as Record<string, unknown>)[method] as Record<string, unknown> | undefined
      if (!operation?.operationId) continue
      operation["x-codeSamples"] = [
        {
          lang: "js",
          source: [
            `import { createKiloClient } from "@kilocode/sdk"`,
            ``,
            `const client = createKiloClient()`,
            `await client.${operation.operationId}({`,
            `  ...`,
            `})`,
          ].join("\n"),
        },
      ]
    }
  }
  const raw = JSON.stringify(specs, null, 2)
    .replaceAll("OpenCode", "Kilo")
    .replaceAll("opencode.local", "kilo.local")
    .replaceAll("opencode serve", "kilo serve")
    .replaceAll("https://opencode.ai/", "https://kilo.ai/")

  const prettier = await import("prettier")
  const babel = await import("prettier/plugins/babel")
  const estree = await import("prettier/plugins/estree")
  const format = (prettier as unknown as { format: (s: string, o: unknown) => Promise<string> }).format
    ?? (prettier as unknown as { default: { format: (s: string, o: unknown) => Promise<string> } }).default.format
  const json = await format(raw, {
    parser: "json",
    plugins: [(babel as unknown as { default: unknown }).default ?? babel, (estree as unknown as { default: unknown }).default ?? estree],
    printWidth: 120,
  })
  return json
}

if (import.meta.main) {
  const json = await generateOpenApiJson()
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(json, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
