import { mkdir } from "fs/promises"
import path from "path"

export async function markPluginDependenciesReady(dir: string) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } } }),
  )
}

// kilocode_change start - pre-create .kilo with the plugin-deps stub
/**
 * LOCK-003/004 fixture leak fix: project config writes create `.kilo` lazily,
 * and the next instance config load runs a detached `Npm.install("@kilocode/plugin")`
 * into it that races fixture disposal and leaks node_modules dirs. Pre-create
 * `.kilo` with the plugin-deps stub so that install never fires. A project root
 * holding `opencode.json` is itself a ConfigPaths.directories entry, so the
 * ROOT is stubbed too — otherwise the install fires at the root where the
 * `.kilo` stub cannot cover it.
 */
export async function markProjectConfigReady(dir: string) {
  const kilo = path.join(dir, ".kilo")
  await mkdir(kilo, { recursive: true })
  await markPluginDependenciesReady(kilo)
  await markPluginDependenciesReady(dir) // project root with opencode.json is a config dir
}
// kilocode_change end
