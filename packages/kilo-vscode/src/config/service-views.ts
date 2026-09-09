/**
 * P4.1 Canonical Config Service — stateless read-only views.
 *
 * Stateless delegate for service.ts. Every export is pure with explicit
 * inputs and returned values: no state ownership, no mutation, no timers,
 * no watchers, no credential or rollback logic. CanonicalConfigService
 * keeps all lifecycle and forwards where a public method is preserved.
 */

import * as path from "path"
import type {
  AssetDirectory,
  AssetScanResult,
  CanonicalPaths,
  CanonicalStamp,
  EmitterFactory,
  FileReadResult,
  ValidationError,
} from "./types"
import { ASSET_DIRECTORIES, parseOwnedCredentialRef } from "./types"
import { sameCanonicalPath } from "./paths"
import { parseJsonc, readFile, parseMarkdown } from "./parse"
import { validateCrossScope } from "./validate"
import { type ConfigSnapshot } from "./snapshot"
import { type ProviderIndex, type AgentIndex } from "./selectors"
import { type SecretAdapter, hasCredential } from "./secret-adapter"

/** Per-directory asset scan summary (mirrors service.ts fixture type). */
export interface AssetDirSummaryView {
  readonly dir: AssetDirectory
  readonly scope: "global" | "project"
  readonly entries: number
  readonly errors: number
}

export interface AgentEntryView {
  readonly id: string
  readonly displayName: string
  readonly description?: string
  readonly mode?: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly color?: string
  readonly source: "global" | "project"
  readonly filePath?: string
  readonly frontmatter?: Record<string, unknown>
  readonly body?: string
  readonly assetHash?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Summarize an asset scan per directory/scope (fixture snapshot only). */
export function summarizeAssetScan(scan: AssetScanResult | null, paths: CanonicalPaths): AssetDirSummaryView[] {
  if (!scan) return []
  const out: AssetDirSummaryView[] = []
  for (const dir of ASSET_DIRECTORIES) {
    for (const scope of ["global", "project"] as const) {
      const root = scope === "global" ? paths.globalAssetDirs[dir] : paths.projectAssetDirs?.[dir]
      if (!root) continue
      out.push({
        dir,
        scope,
        entries: scan.entries.filter((e) => e.scope === scope && sameCanonicalPath(path.dirname(e.filePath), root))
          .length,
        errors: scan.errors.filter(
          (e) =>
            e.scope === scope &&
            e.file !== undefined &&
            (sameCanonicalPath(path.dirname(e.file), root) || sameCanonicalPath(e.file, root)),
        ).length,
      })
    }
  }
  return out
}

export function parseScopeDocument(raw: FileReadResult | undefined): Record<string, unknown> {
  if (!raw || raw.type !== "present") return {}
  const parsed = parseJsonc(raw.bytes)
  return parsed.ok ? parsed.value : {}
}

/**
 * Validate that an asset ID is a safe filename segment (Blocker 11).
 * No separators, traversal, or absolute path.
 */
export function isValidAssetId(id: string): boolean {
  if (!id || id.length === 0) return false
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false
  if (path.isAbsolute(id)) return false
  if (id !== path.basename(id)) return false
  return true
}

/**
 * Assemble markdown content from frontmatter and body.
 * Uses YAML library for proper formatting (Finding 11).
 */
export function assembleAssetMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const parts: string[] = ["---\n"]
  const { stringify: yamlStr, parseDocument: yamlParseDoc } = require("yaml")
  const doc = yamlParseDoc("")
  // Drop undefined keys (field cleared in UI); preserve null delete sentinels
  // so CLI ConfigAgentV1 NullOr normalization observes them.
  const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined))
  doc.contents = new Map(Object.entries(clean)) as any
  parts.push(yamlStr(doc))
  parts.push("---\n")
  if (body) {
    parts.push("\n", body)
    if (!body.endsWith("\n")) parts.push("\n")
  }
  return parts.join("")
}

/**
 * Default in-memory emitter factory. Used when no vscode or test override is provided.
 * Decouples from vscode.EventEmitter for testability.
 */
export function createDefaultEmitterFactory(): EmitterFactory {
  return {
    create: <T>() => {
      const listeners: Array<(e: T) => void> = []
      return {
        event: (listener: (e: T) => void) => {
          listeners.push(listener)
          return {
            dispose() {
              const idx = listeners.indexOf(listener)
              if (idx >= 0) listeners.splice(idx, 1)
            },
          }
        },
        fire: (e: T) => {
          for (const l of listeners) l(e)
        },
        dispose: () => {
          listeners.length = 0
        },
      }
    },
  }
}

/**
 * Build agent index entries from validated scan results (Blocker 4).
 * Uses retained frontmatter from scan entries — never rereads malformed bytes.
 * On malformed/unreadable replacement, the prior entry's frontmatter is used.
 */
export function buildAgentEntriesFromScan(scan: AssetScanResult, paths: CanonicalPaths): AgentEntryView[] {
  return scan.entries
    .filter((e) =>
      sameCanonicalPath(
        path.dirname(e.filePath),
        e.scope === "global" ? paths.globalAssetDirs.agent : paths.projectAssetDirs!.agent,
      ),
    )
    .map((e) => {
      // Use retained frontmatter from the scan entry (Correction 5).
      // For malformed/unreadable replacements, prior entry carries valid frontmatter.
      const fm = e.frontmatter ?? {}
      return {
        id: e.id,
        displayName:
          (typeof fm.displayName === "string" ? fm.displayName : undefined) ??
          (typeof fm.name === "string" ? fm.name : e.id),
        description: typeof fm.description === "string" ? fm.description : undefined,
        mode:
          fm.mode === "primary" || fm.mode === "subagent" || fm.mode === "all"
            ? (fm.mode as "primary" | "subagent" | "all")
            : undefined,
        hidden: typeof fm.hidden === "boolean" ? fm.hidden : undefined,
        color: typeof fm.color === "string" ? fm.color : undefined,
        source: e.scope,
        filePath: e.filePath,
        frontmatter: e.frontmatter,
        body: e.body,
        assetHash: e.contentHash,
      }
    })
}

/**
 * Compute per-provider credential status from each record's exact credential ref.
 * Reads the ref from the materialized config and validates against SecretStorage.
 * No prefix scan — each status traces to a validated canonical record ref.
 */
export async function computeProviderCredentialStatus(
  snapshot: ConfigSnapshot,
  secrets: SecretAdapter,
): Promise<Map<string, boolean>> {
  const status = new Map<string, boolean>()
  const providerMap = snapshot.config.value.provider
  if (!providerMap || typeof providerMap !== "object" || Array.isArray(providerMap)) return status
  for (const [id, entry] of Object.entries(providerMap as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const credential = (entry as Record<string, unknown>).credential
    if (typeof credential !== "string") {
      status.set(id, false)
      continue
    }
    const parsed = parseOwnedCredentialRef(credential)
    if (parsed && parsed.kind === "provider" && parsed.id === id) {
      status.set(id, await hasCredential(secrets, credential))
    } else {
      status.set(id, false)
    }
  }
  return status
}

/** Build the canonical stamp from explicit hashes and generation. */
export function stampView(
  globalHash: string | null,
  projectHash: string | null,
  generation: number,
): CanonicalStamp {
  return {
    globalHash,
    projectHash,
    materializationVersion: generation,
    assetHash: null,
  }
}

/** Read-only asset stamp from explicit paths and project presence. */
export function assetStampView(
  paths: CanonicalPaths,
  hasProject: boolean,
  assetType: AssetDirectory,
  id: string,
  scope: "global" | "project",
): string {
  if (scope === "project" && !hasProject) return "absent"
  const dir = scope === "global" ? paths.globalAssetDirs[assetType] : paths.projectAssetDirs![assetType]
  const raw = readFile(path.join(dir, `${id}.md`))
  return raw.type === "present" ? raw.hash : "absent"
}

/** Read-only asset read from explicit paths and project presence. */
export function readAssetView(
  paths: CanonicalPaths,
  hasProject: boolean,
  assetType: AssetDirectory,
  id: string,
  scope: "global" | "project",
):
  | { ok: true; frontmatter: Record<string, unknown>; body: string; contentHash: string }
  | { ok: false; message: string } {
  if (scope === "project" && !hasProject)
    return { ok: false, message: "No workspace folder available; project scope is not configured" }
  const dir = scope === "global" ? paths.globalAssetDirs[assetType] : paths.projectAssetDirs![assetType]
  const raw = readFile(path.join(dir, `${id}.md`))
  if (raw.type !== "present") return { ok: false, message: raw.type === "failure" ? raw.message : "Asset not found" }
  const parsed = parseMarkdown(raw.bytes)
  if (parsed.errors.length > 0) return { ok: false, message: parsed.errors.join("; ") }
  return { ok: true, frontmatter: parsed.data, body: parsed.content, contentHash: raw.hash }
}

/** Read-only authored scope document from an explicit file result. */
export function scopeConfigView(raw: FileReadResult | undefined): Record<string, unknown> {
  return parseScopeDocument(raw)
}

/**
 * Check stale/conflict for a write operation using discriminated read result (Blocker 10).
 */
export function checkStaleForWriteView(
  existing: FileReadResult,
  expectedHash: string,
): { ok: false; kind: "stale"; message: string } | null {
  if (!expectedHash || expectedHash === "absent") return null
  if (existing.type === "absent") {
    return { ok: false, kind: "stale", message: "Config file was deleted externally" }
  }
  if (existing.type === "failure") {
    return { ok: false, kind: "stale", message: `Config file unreadable: ${existing.message}` }
  }
  if (existing.type === "present" && existing.hash !== expectedHash) {
    return {
      ok: false,
      kind: "stale",
      message: `Config file was modified externally (expected ${expectedHash}, got ${existing.hash})`,
    }
  }
  return null
}

/**
 * Build merged document from existing file + patch (Blocker 9).
 */
export function buildMergedDocView(
  existing: FileReadResult,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  let doc: Record<string, unknown> = {}
  if (existing.type === "present") {
    const parsed = parseJsonc(existing.bytes)
    if (parsed.ok) doc = { ...parsed.value }
  }
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) {
      delete doc[key]
    } else {
      doc[key] = val
    }
  }
  return doc
}

/**
 * Validate cross-scope composition for single/keyed conflict detection (Blocker 9).
 * Delegates to the shared validateCrossScope rule.
 */
export function validateCrossScopeCompositionView(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
): ValidationError[] {
  return validateCrossScope(global, project)
}

/** Pure fixture snapshot assembly from explicit read-only inputs. */
export function fixtureSnapshotView(input: {
  paths: CanonicalPaths
  scan: AssetScanResult | null
  provider: ProviderIndex | null
  agent: AgentIndex | null
  snapshot: ConfigSnapshot | null
  ready: boolean
  readyStamp: CanonicalStamp | null
  error: string | null
}): {
  globalRoot: string
  projectRoot: string | null
  materializationReady: boolean
  successfulMaterializationStamp: CanonicalStamp | null
  lastMaterializationError: string | null
  assetScan: AssetDirSummaryView[]
  agentIndex: { readonly size: number; readonly ids: readonly string[] } | null
  providerIndex: {
    readonly size: number
    readonly ids: readonly string[]
    readonly entries: readonly {
      readonly id: string
      readonly hasCredential: boolean
      readonly modelIds: readonly string[]
    }[]
    readonly connected: readonly string[]
  } | null
  defaultModel: string | null
  defaultSelection: { readonly providerID: string; readonly modelID: string } | null
} {
  const rawModel = input.snapshot?.config.value.model
  const defaultModel = typeof rawModel === "string" ? rawModel : null
  const selected = defaultModel ? defaultModel.split("/") : []
  const providerID =
    selected[0] && input.provider?.providers.some((p) => p.id === selected[0]) ? selected[0] : ""
  const defaultSelection =
    defaultModel && providerID
      ? { providerID, modelID: selected.slice(1).join("/") || "auto" }
      : providerID
        ? { providerID, modelID: "" }
        : null
  return {
    globalRoot: input.paths.globalRoot,
    projectRoot: input.paths.projectRoot ?? null,
    materializationReady: input.ready,
    successfulMaterializationStamp: input.readyStamp,
    lastMaterializationError: input.error,
    assetScan: summarizeAssetScan(input.scan, input.paths),
    providerIndex: input.provider
      ? {
          size: input.provider.providers.length,
          ids: input.provider.providers.map((p) => p.id),
          entries: input.provider.providers.map((p) => ({
            id: p.id,
            hasCredential: p.hasCredential,
            modelIds: [...p.modelIds],
          })),
          connected: input.provider.providers.filter((p) => p.hasCredential).map((p) => p.id),
        }
      : null,
    agentIndex: input.agent ? { size: input.agent.agents.length, ids: input.agent.agents.map((a) => a.id) } : null,
    defaultModel,
    defaultSelection,
  }
}
