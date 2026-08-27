import { existsSync } from "fs"
import * as os from "os"
import * as path from "path"

export type Scope = "global" | "local"

export type Source = "sourceGlobal" | "sourceLocal"

export interface Entry {
  file?: string
  name: string
  source: Source
  exists: boolean
  loaded: boolean
  recommended?: boolean
}

const SCHEMA = "https://app.kilo.ai/config.json"

function row(file: string, source: Source, loaded = true, recommended = false): Entry {
  const name = path.basename(file)
  return {
    file,
    name,
    source,
    exists: existsSync(file),
    loaded: loaded && existsSync(file),
    recommended,
  }
}

function ensure(list: Entry[], file: string, source: Source) {
  if (list.some((item) => item.file === file)) return list
  return [...list, row(file, source, true, true)]
}

function globalRoot(): string {
  return process.env.KILO_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "kilo")
}

export function globalFiles() {
  const root = globalRoot()
  const file = path.join(root, "kilo.jsonc")
  const list = existsSync(file) ? [row(file, "sourceGlobal")] : []
  return ensure(list, file, "sourceGlobal")
}

function projectDisabled() {
  const value = process.env.KILO_DISABLE_PROJECT_CONFIG?.toLowerCase()
  return value === "true" || value === "1"
}

export function localFiles(root: string) {
  const enabled = !projectDisabled()
  const file = path.join(root, ".kilo", "kilo.jsonc")
  const list = existsSync(file) ? [row(file, "sourceLocal", enabled, true)] : []
  const next = ensure(list, file, "sourceLocal")
  return enabled ? next : next.map((item) => ({ ...item, loaded: false }))
}

export function content() {
  return `{
  "$schema": "${SCHEMA}"
}
`
}
