import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.3 readiness inventory — test-only, bounded.
// Encodes the closed P4.3 source taxonomy and proves the current config
// reader surface is fully classified.
// Spec anchors:
// - P0 inventory §6.1 (15-source enumeration, evidence lines)
// - Runtime direction §3.1 (4 retained legal classes)
// - Runtime direction §7 + §8.1 (13 removal classes, no dual-read/import)
// No dual-read/import tooling; do not delete production readers; P4 remains Active.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(path: string): string {
  return readFileSync(path, "utf8")
}

function readSpec(rel: string): string {
  const full = join(repo, rel)
  if (!existsSync(full)) throw new Error(`authoritative spec missing: ${rel} (resolved ${full}) — run from repo root`)
  return read(full)
}

// The 15 P0 merge sources (inventory §6.1). Order mirrors the spec.
type Source = {
  id: string
  label: string
  file: string
  anchor: string
  extraAnchors?: readonly string[]
  classification: { kind: "retained" | "removal"; name: string }
}

const RETAINED = {
  canonicalGlobal: "Canonical global config files/assets",
  canonicalProject: "Canonical project config files/assets",
  secretStorage: "SecretStorage credentials",
  runtimeDefaults: "Runtime defaults and safety invariants",
} as const

const REMOVAL = {
  kiloConfig: "KILO_CONFIG env override",
  kiloConfigDir: "KILO_CONFIG_DIR env override",
  kiloConfigContent: "KILO_CONFIG_CONTENT env override",
  kiloPermission: "KILO_PERMISSION env override",
  legacyOpencode: "Legacy opencode.* keys, .opencode / .kilocode locations",
  globalProjectAsset: "Global project-asset sources",
  ancestorWalk: "Ancestor directory walks",
  primaryWorktree: "Primary-worktree mirror reads",
  cloudOrgManaged: "Cloud/org/managed config sources",
  modeTools: "Top-level mode/tools conversions",
  arbitraryCliEnv: "Arbitrary CLI/env override layers",
  legacyGlobalFilenames: "Legacy global config filenames/readers",
  legacyMigration: "Legacy migration readers/import tooling",
} as const

const RETAINED_CLASSES = Object.values(RETAINED) as readonly string[]
const REMOVAL_CLASSES = Object.values(REMOVAL) as readonly string[]

// Each P0 source maps exactly once to a retained legal class or a single removal class.
const P0: readonly Source[] = [
  {
    id: "P0-01",
    label: "Global config.json",
    file: "config/config.ts",
    anchor: 'path.join(Global.Path.config, "config.json")',
    classification: { kind: "removal", name: REMOVAL.legacyGlobalFilenames },
  },
  {
    id: "P0-02",
    label: "Global kilo.json",
    file: "config/config.ts",
    anchor: 'path.join(Global.Path.config, "kilo.json")',
    classification: { kind: "retained", name: RETAINED.canonicalGlobal },
  },
  {
    id: "P0-03",
    label: "Global kilo.jsonc",
    file: "config/config.ts",
    anchor: 'path.join(Global.Path.config, "kilo.jsonc")',
    classification: { kind: "retained", name: RETAINED.canonicalGlobal },
  },
  {
    id: "P0-04",
    label: "Global opencode.json",
    file: "config/config.ts",
    anchor: 'path.join(Global.Path.config, "opencode.json")',
    classification: { kind: "removal", name: REMOVAL.legacyGlobalFilenames },
  },
  {
    id: "P0-05",
    label: "Global opencode.jsonc",
    file: "config/config.ts",
    anchor: 'path.join(Global.Path.config, "opencode.jsonc")',
    classification: { kind: "removal", name: REMOVAL.legacyGlobalFilenames },
  },
  {
    id: "P0-06",
    label: "Legacy global config (TOML) one-shot migration",
    file: "config/config.ts",
    anchor: 'with: { type: "toml" }',
    classification: { kind: "removal", name: REMOVAL.legacyMigration },
  },
  {
    id: "P0-07",
    label: "Legacy project config migration (loadLegacyConfigs)",
    file: "kilocode/config/config.ts",
    anchor: "async function loadLegacyConfigs",
    classification: { kind: "removal", name: REMOVAL.legacyMigration },
  },
  {
    id: "P0-08",
    label: "Organization modes (loadOrganizationModes)",
    file: "kilocode/config/config.ts",
    anchor: "async function loadOrganizationModes",
    classification: { kind: "removal", name: REMOVAL.cloudOrgManaged },
  },
  {
    id: "P0-09",
    label: "Auth-record well-known remote config (.well-known/opencode)",
    file: "config/config.ts",
    anchor: ".well-known/opencode",
    classification: { kind: "removal", name: REMOVAL.cloudOrgManaged },
  },
  {
    id: "P0-10",
    label: "Explicit KILO_CONFIG file",
    file: "config/config.ts",
    anchor: "if (Flag.KILO_CONFIG)",
    classification: { kind: "removal", name: REMOVAL.kiloConfig },
  },
  {
    id: "P0-11",
    label: "Project config files + discovered config directories",
    file: "config/config.ts",
    anchor: "ConfigPaths.files",
    extraAnchors: ["ConfigPaths.directories"],
    classification: { kind: "retained", name: RETAINED.canonicalProject },
  },
  {
    id: "P0-12",
    label: "KILO_CONFIG_DIR",
    file: "config/config.ts",
    anchor: "Flag.KILO_CONFIG_DIR",
    classification: { kind: "removal", name: REMOVAL.kiloConfigDir },
  },
  {
    id: "P0-13",
    label: "KILO_CONFIG_CONTENT env",
    file: "config/config.ts",
    anchor: "process.env.KILO_CONFIG_CONTENT",
    classification: { kind: "removal", name: REMOVAL.kiloConfigContent },
  },
  {
    id: "P0-14",
    label: "Managed config directory / macOS managed preferences",
    file: "config/config.ts",
    anchor: "managedConfigDir()",
    classification: { kind: "removal", name: REMOVAL.cloudOrgManaged },
  },
  {
    id: "P0-15",
    label: "Runtime flag-derived permission/tool behavior (KILO_PERMISSION / tools)",
    file: "config/config.ts",
    anchor: "Flag.KILO_PERMISSION",
    extraAnchors: ["result.tools"],
    classification: { kind: "removal", name: REMOVAL.kiloPermission },
  },
] as const

// Anchors that prove each removal class still has a live reader in the
// current implementation (until the P4.3 cutover). These are stable
// file/content checks using call-site / exact multi-token patterns.
// Only effective-config readers are listed here. Classes without a distinct
// source-specific reader (notification-only or generic derived conversions)
// are intentionally omitted and documented via REMOVAL_WITHOUT_DISTINCT_READER.
const REMOVAL_ANCHORS: Array<{ cls: string; file: string; substr: string }> = [
  { cls: REMOVAL.kiloConfig, file: "config/config.ts", substr: "if (Flag.KILO_CONFIG)" },
  { cls: REMOVAL.kiloConfigDir, file: "config/config.ts", substr: "Flag.KILO_CONFIG_DIR" },
  { cls: REMOVAL.kiloConfigContent, file: "config/config.ts", substr: "process.env.KILO_CONFIG_CONTENT" },
  { cls: REMOVAL.kiloPermission, file: "config/config.ts", substr: "Flag.KILO_PERMISSION" },
  { cls: REMOVAL.globalProjectAsset, file: "config/config.ts", substr: "primaryPaths(" },
  { cls: REMOVAL.ancestorWalk, file: "config/config.ts", substr: "ConfigPaths.directories" },
  { cls: REMOVAL.primaryWorktree, file: "config/config.ts", substr: "primaryPaths(" },
  { cls: REMOVAL.cloudOrgManaged, file: "config/config.ts", substr: "managedConfigDir()" },
  { cls: REMOVAL.modeTools, file: "config/config.ts", substr: "result.tools" },
  { cls: REMOVAL.legacyGlobalFilenames, file: "config/config.ts", substr: 'path.join(Global.Path.config, "opencode.json")' },
  { cls: REMOVAL.legacyMigration, file: "kilocode/config/config.ts", substr: "async function loadLegacyConfigs" },
]

// Removal classes that have no distinct effective-config reader anchor.
// - Legacy opencode.* / .opencode / .kilocode: detectOpencodeConfig explicitly
//   states "Kilo no longer reads .opencode" and only emits a synthetic
//   notification (see kilocode/config/config.ts:565-595). Not an effective-config reader.
// - Arbitrary CLI/env override layers: generic catch-all with no source-specific
//   file reader; the previous anchor result.permission is a derived permission
//   conversion, not a source reader. Both remain explicit removal boundaries
//   in the normative taxonomy §8.1, just not falsely certified as live readers.
const REMOVAL_WITHOUT_DISTINCT_READER: readonly string[] = [
  REMOVAL.legacyOpencode,
  REMOVAL.arbitraryCliEnv,
] as const

const INVENTORY_SPEC = "specs/vscode-orchestrator/p0-current-state-inventory.md"
const RUNTIME_SPEC = "specs/vscode-orchestrator/runtime-and-configuration-direction.md"

function stripTicks(s: string): string {
  return s.replace(/`/g, "")
}

function extractSection(doc: string, heading: string): string {
  const start = doc.indexOf(heading)
  if (start === -1) throw new Error(`section heading not found: ${heading}`)
  const afterStart = doc.slice(start + heading.length)
  const nextRel = afterStart.search(/\n## |\n### /)
  if (nextRel === -1) return doc.slice(start)
  return doc.slice(start, start + heading.length + nextRel)
}

const INVENTORY_61_HEADING = "### 6.1 Config authority and 12+-source merge"
const RUNTIME_31_HEADING = "### 3.1 Legal source taxonomy"
const RUNTIME_81_HEADING = "### 8.1 Effective-config source removal"

// Per-P0 authoritative phrase that must appear in inventory §6.1.
// Ties each local Source.id to its expected row phrase in the normative section.
const P0_61_PHRASE_BY_ID: Record<string, string> = {
  "P0-01": "Global config.json",
  "P0-02": "Global kilo.json",
  "P0-03": "Global kilo.jsonc",
  "P0-04": "Global opencode.json",
  "P0-05": "Global opencode.jsonc",
  "P0-06": "Legacy global config (TOML) one-shot migration",
  "P0-07": "Legacy project config migration",
  "P0-08": "Organization modes",
  "P0-09": ".well-known/opencode",
  "P0-10": "Explicit KILO_CONFIG file",
  "P0-11": "Project config files + discovered config directories",
  "P0-12": "KILO_CONFIG_DIR",
  "P0-13": "KILO_CONFIG_CONTENT",
  "P0-14": "Managed config directory",
  "P0-15": "Runtime flag-derived permission",
}

describe("P4.3 readiness inventory — closed taxonomy", () => {
  test("declares exactly 15 P0 sources with no duplicate or missing id", () => {
    expect(P0.length).toBe(15)
    const ids = P0.map((s) => s.id)
    expect(new Set(ids).size).toBe(15)
    for (let i = 1; i <= 15; i++) {
      const want = `P0-${String(i).padStart(2, "0")}`
      expect(ids).toContain(want)
    }
  })

  test("declares exactly 13 removal classes with no duplicate", () => {
    expect(REMOVAL_CLASSES.length).toBe(13)
    expect(new Set(REMOVAL_CLASSES).size).toBe(13)
  })

  test("declares exactly 4 retained legal classes with no duplicate", () => {
    expect(RETAINED_CLASSES.length).toBe(4)
    expect(new Set(RETAINED_CLASSES).size).toBe(4)
  })

  test("every P0 source maps exactly once to a known retained or removal class", () => {
    for (const src of P0) {
      const k = src.classification.kind
      const n = src.classification.name
      expect(k === "retained" || k === "removal").toBe(true)
      if (k === "retained") expect(RETAINED_CLASSES).toContain(n)
      else expect(REMOVAL_CLASSES).toContain(n)
    }
  })

  test("P0 mapping uses only the declared taxonomy (no invented class)", () => {
    const all = new Set([...RETAINED_CLASSES, ...REMOVAL_CLASSES])
    for (const src of P0) expect(all.has(src.classification.name)).toBe(true)
  })

  test("authoritative specs are present and readable from repo root", () => {
    const inv = readSpec(INVENTORY_SPEC)
    const rt = readSpec(RUNTIME_SPEC)
    expect(inv.length).toBeGreaterThan(1000)
    expect(rt.length).toBeGreaterThan(1000)
    expect(stripTicks(inv)).toContain("Config authority and 12+-source merge")
    expect(stripTicks(rt)).toContain("Legal source taxonomy")
  })

  test("retained legal classes match runtime spec §3.1 verbatim (section-local)", () => {
    const rt = readSpec(RUNTIME_SPEC)
    const sec = extractSection(rt, RUNTIME_31_HEADING)
    const normSec = stripTicks(sec)
    for (const cls of RETAINED_CLASSES) {
      expect(normSec, `retained class missing in §3.1: ${cls}`).toContain(cls)
    }
    expect(sec).toContain("Canonical global config files/assets")
    expect(sec).toContain("Canonical project config files/assets")
    expect(sec).toContain("SecretStorage credentials")
    expect(sec).toContain("Runtime defaults and safety invariants")
    const rows = sec.match(/^\| \d \|/gm) ?? []
    expect(rows.length, `§3.1 should contain exactly 4 retained rows, got ${rows.length}`).toBe(4)
  })

  test("removal classes match runtime spec §8.1 verbatim (section-local)", () => {
    const rt = readSpec(RUNTIME_SPEC)
    const sec = extractSection(rt, RUNTIME_81_HEADING)
    const normSec = stripTicks(sec)
    for (const cls of REMOVAL_CLASSES) {
      expect(normSec, `removal class missing in §8.1: ${cls}`).toContain(stripTicks(cls))
    }
    expect(normSec).toContain("KILO_CONFIG env override")
    expect(normSec).toContain("KILO_CONFIG_DIR env override")
    expect(normSec).toContain("KILO_CONFIG_CONTENT env override")
    expect(normSec).toContain("KILO_PERMISSION env override")
    expect(normSec).toContain("Legacy opencode.* keys")
    expect(normSec).toContain("Global project-asset sources")
    expect(normSec).toContain("Ancestor directory walks")
    expect(normSec).toContain("Primary-worktree mirror reads")
    expect(normSec).toContain("Cloud/org/managed config sources")
    expect(normSec).toContain("Top-level mode/tools conversions")
    expect(normSec).toContain("Arbitrary CLI/env override layers")
    expect(normSec).toContain("Legacy global config filenames/readers")
    expect(normSec).toContain("Legacy migration readers/import tooling")
    const pipeLines = sec.split("\n").filter((l) => l.trim().startsWith("|")).length
    const dataRows = pipeLines - 2 // header + separator
    expect(dataRows, `§8.1 should contain exactly 13 removal rows, got ${dataRows} (pipeLines=${pipeLines})`).toBe(13)
  })

  test("P0 inventory rows match authoritative inventory §6.1 phrases (section-local, id-bound)", () => {
    const inv = readSpec(INVENTORY_SPEC)
    const sec = extractSection(inv, INVENTORY_61_HEADING)
    const normSec = stripTicks(sec)
    for (const src of P0) {
      const phrase = P0_61_PHRASE_BY_ID[src.id]
      expect(phrase, `missing phrase mapping for ${src.id}`).toBeDefined()
      expect(normSec, `${src.id} phrase missing in §6.1: ${phrase}`).toContain(phrase)
    }
    expect(inv).toContain("loadLegacyConfigs")
    expect(inv).toContain("loadOrganizationModes")
    expect(inv).toContain(".well-known/opencode")
    const enumerated = sec.match(/^\s*\d+\.\s+/gm) ?? []
    expect(enumerated.length, `§6.1 should enumerate exactly 15 sources, got ${enumerated.length}`).toBe(15)
  })

  test("every P0 classification matches authoritative taxonomy section-local (no invented mapping)", () => {
    const rt = readSpec(RUNTIME_SPEC)
    const sec31 = stripTicks(extractSection(rt, RUNTIME_31_HEADING))
    const sec81 = stripTicks(extractSection(rt, RUNTIME_81_HEADING))
    for (const src of P0) {
      const name = stripTicks(src.classification.name)
      if (src.classification.kind === "retained") {
        expect(sec31, `${src.id} retained classification not found in §3.1: ${src.classification.name}`).toContain(name)
      } else {
        expect(sec81, `${src.id} removal classification not found in §8.1: ${src.classification.name}`).toContain(name)
      }
    }
  })

  test("removal classes without distinct live reader are documented as taxonomy-only boundaries", () => {
    const rt = readSpec(RUNTIME_SPEC)
    const sec81 = stripTicks(extractSection(rt, RUNTIME_81_HEADING))
    for (const cls of REMOVAL_WITHOUT_DISTINCT_READER) {
      expect(REMOVAL_CLASSES).toContain(cls)
      expect(sec81, `taxonomy-only removal class missing in §8.1: ${cls}`).toContain(stripTicks(cls))
      const hasAnchor = REMOVAL_ANCHORS.some((a) => a.cls === cls)
      expect(hasAnchor, `${cls} must not have a live-reader anchor (notification/derived only)`).toBe(false)
    }
    expect(REMOVAL_ANCHORS.length, "REMOVAL_ANCHORS should contain only effective-config reader anchors (11)").toBe(11)
    const anchorClss = new Set(REMOVAL_ANCHORS.map((a) => a.cls))
    expect(anchorClss.size, "REMOVAL_ANCHORS must have one anchor per distinct removal class it covers").toBe(REMOVAL_ANCHORS.length)
    for (const cls of REMOVAL_WITHOUT_DISTINCT_READER) expect(anchorClss.has(cls)).toBe(false)
  })

  test("legacy reader anchors remain present and are classified as removal (effective-config readers only)", () => {
    for (const src of P0.filter((s) => s.classification.kind === "removal")) {
      const p = join(opencode, src.file)
      expect(existsSync(p), `${src.id} anchor file missing: ${src.file}`).toBe(true)
      const txt = read(p)
      expect(txt.includes(src.anchor), `${src.id} anchor missing in ${src.file}: ${JSON.stringify(src.anchor)}`).toBe(true)
      for (const extra of src.extraAnchors ?? []) {
        expect(txt.includes(extra), `${src.id} extra anchor missing in ${src.file}: ${JSON.stringify(extra)}`).toBe(true)
      }
    }
    for (const a of REMOVAL_ANCHORS) {
      const p = join(opencode, a.file)
      expect(existsSync(p), `removal anchor file missing: ${a.file} for ${a.cls}`).toBe(true)
      const txt = read(p)
      expect(txt.includes(a.substr), `removal anchor missing: ${a.cls} -> ${a.substr} in ${a.file}`).toBe(true)
    }
    // Explicitly verify that the .opencode notification helper is NOT treated as a live reader
    const notifyFile = join(opencode, "kilocode/config/config.ts")
    const notifyTxt = read(notifyFile)
    expect(notifyTxt).toContain("detectOpencodeConfig")
    expect(notifyTxt).toContain("Kilo no longer falls back to opencode configuration")
    // result.permission is a derived conversion, not an Arbitrary CLI/env source reader
    const cfgTxt = read(join(opencode, "config/config.ts"))
    // primaryPaths is the effective-config reader for both globalProjectAsset and primaryWorktree
    expect(cfgTxt).toContain("primaryPaths(")
    expect(cfgTxt).toContain("ConfigPaths.files")
    expect(cfgTxt).toContain("ConfigPaths.directories")
    expect(cfgTxt).toContain("managedConfigDir()")
    expect(cfgTxt).toContain("result.tools")
    const canonical = join(opencode, "kilocode/config/config.ts")
    expect(existsSync(canonical)).toBe(true)
    expect(read(canonical)).toContain("ALL_CONFIG_FILES")
  })

  test("readiness artifact introduces no dual-read or import helper surface", () => {
    const self = read(join(import.meta.dir, "p4-3-readiness-inventory.test.ts"))
    const dRead = ["dual", "Read"].join("")
    const dReadCap = ["Dual", "Read"].join("")
    const cReader = ["create", "Dual", "Reader"].join("")
    const impLeg = ["import", "Legacy", "Config"].join("")
    const impTool = ["import", "Tool"].join("")
    const migTool = ["Migration", "Tool"].join("")
    expect(self).not.toContain(dRead)
    expect(self).not.toContain(dReadCap)
    expect(self).not.toContain(cReader)
    expect(self).not.toContain(impLeg)
    expect(self).not.toContain(impTool)
    expect(self).not.toContain(migTool)
    expect(self.toLowerCase()).not.toContain(["dual-read", " window"].join(""))
    expect(self.toLowerCase()).not.toContain(["compatibility", " reader"].join(""))
  })
})
