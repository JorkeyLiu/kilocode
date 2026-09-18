import path from "path"
import { existsSync, realpathSync } from "fs"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@/util/wildcard"

export type Action = "allow" | "deny" | "ask"
export type LayerDecision = "deny" | "ask" | "ask-ceiling" | "allow" | "no-ceiling"
export type DecisiveResult = "deny" | "ask" | "ask-ceiling" | "allow"
export type CeilingId = "(a)" | "(b)" | "(c)" | null

export type Rule = {
  permission: string
  pattern: string
  action: Action
}

export type Ruleset = readonly Rule[]

export type LayerKind = "runtime-ceiling" | "global" | "project" | "agent" | "session-restriction"
export type SourceKind = "runtime-safety" | "global-file" | "global-override" | "project-file" | "agent-manifest" | "session-restriction" | "approval" | "protected-file"

export type LayerInput = {
  kind: LayerKind
  sourceKind: SourceKind
  canonicalPath: string
  ruleset?: Ruleset // undefined => non-applicable, defined (maybe empty) => applicable
}

export type ApprovalKind = "once" | "session" | "durable"
export type Approval = {
  kind: ApprovalKind
  operationId?: string // for once: permission:<id>
  patterns: string[]
  sessionID: string
  agent: string
  permission: string
  provenancePath?: string // for durable: actual protected_files canonical path identity
}

export type Request = {
  permission: string
  patterns: string[]
  // Canonical target identity set: patterns plus metadata filepath/files[].filePath/movePath, deduplicated and permission-aware canonicalized.
  // Evaluator must use this for class-b detection, hard-deny/durable rule matching, exact approval matching, provenance and layer rules.
  // When undefined, falls back to patterns for backwards compatibility in isolated evaluator tests.
  targets?: string[]
  permissionRequestId: string // e.g. per_abc123
  operationId: string // permission:<id>
  sessionID: string
  agent: string
  workspaceRoot?: string
  isProtectedRequest?: boolean
}

export type PermissionLevel = "review" | "autonomous"

export type Input = {
  request: Request
  layers: LayerInput[]
  approvals: Approval[]
  allowEverything: boolean
  hardDenyRuleset?: Ruleset
  permissionLevel?: PermissionLevel
}

type ProvenanceLayer = {
  sourceKind: SourceKind
  canonicalPath: string
  decision: LayerDecision
  rules: { pattern: string; action: Action; order: number }[]
}

export type Provenance = {
  schemaVersion: "1"
  request: {
    permissionRequestId: string
    operationId: string
    permission: string
    patterns: string[]
  }
  contributingLayers: ProvenanceLayer[]
  decisive: {
    result: DecisiveResult
    reason: string
    ceilingId: CeilingId
  }
  approval?: {
    kind: ApprovalKind
    operationId?: string
    patterns: string[]
    scope: string
    expiry: string
  }
}

// helpers

function hasWildcard(s: string) {
  return s.includes("*")
}

function hasGlobSyntax(s: string): boolean {
  return /[*?\[\]{}]/.test(s)
}

function wildcardTokenCount(s: string) {
  const m = s.match(/\*\*|\*/g)
  return m ? m.length : 0
}

function literalChars(s: string) {
  return s.replace(/\*\*|\*/g, "").length
}

function isBroadRule(rule: Rule) {
  return hasGlobSyntax(rule.pattern) || hasGlobSyntax(rule.permission)
}

function isModeRule(rule: Rule) {
  return rule.permission === "*" && rule.pattern === "*" && rule.action === "deny"
}

/** Non-authorizing external_directory mode predicate — boolean only, never a deny authority. */
export function isExternalDirectoryModeDeny(rule: Rule): boolean {
  return isModeRule(rule)
}

function filteredRuleset(ruleset: Ruleset, permission: string): Ruleset {
  if (permission !== "external_directory") return ruleset
  return ruleset.filter((r) => !isModeRule(r))
}

function winningRule(ruleset: Ruleset, permission: string, pattern: string, workspaceRoot?: string): { rule: Rule; order: number } | undefined {
  const effective = filteredRuleset(ruleset, permission)
  const candidates: { rule: Rule; order: number; exact: number; wildcards: number; literal: number }[] = []
  for (let i = 0; i < effective.length; i++) {
    const rule = effective[i]
    if (!Wildcard.match(permission, rule.permission)) continue
    const canonRulePattern = canonicalForPermission(rule.pattern, permission, workspaceRoot)
    if (!Wildcard.match(pattern, canonRulePattern)) continue
    const exact = canonRulePattern === pattern && !hasGlobSyntax(canonRulePattern) ? 1 : 0
    const wc = wildcardTokenCount(canonRulePattern) + wildcardTokenCount(rule.permission)
    const lit = literalChars(canonRulePattern) + literalChars(rule.permission)
    candidates.push({ rule, order: i, exact, wildcards: wc, literal: lit })
  }
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => {
    if (b.exact !== a.exact) return b.exact - a.exact
    if (a.wildcards !== b.wildcards) return a.wildcards - b.wildcards
    if (b.literal !== a.literal) return b.literal - a.literal
    return b.order - a.order
  })
  return { rule: candidates[0].rule, order: candidates[0].order }
}

function toPosix(p: string) {
  return p.replaceAll("\\", "/")
}

function canonicalPosix(p: string) {
  return path.posix.normalize(toPosix(p))
}

function physicalPath(p: string): string | undefined {
  try {
    let current = path.resolve(p)
    const parts: string[] = []
    while (!existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      parts.unshift(path.basename(current))
      current = parent
    }
    return path.join(realpathSync.native(current), ...parts)
  } catch {
    return undefined
  }
}

export function canonicalAbsolutePhysical(p: string, workspaceRoot?: string): string {
  const posixNorm = canonicalPosix(p)
  const absLexical = path.posix.isAbsolute(posixNorm) ? posixNorm : workspaceRoot ? path.posix.normalize(path.posix.join(canonicalPosix(workspaceRoot), posixNorm)) : posixNorm
  // Convert to platform path for physical resolution
  const platformAbs = path.isAbsolute(p) ? path.resolve(p) : workspaceRoot ? path.resolve(workspaceRoot, p) : path.resolve(p)
  const phys = physicalPath(platformAbs)
  if (phys) return canonicalPosix(phys)
  return absLexical
}

function isPathWithin(child: string, parent: string): boolean {
  const c = canonicalPosix(child)
  const p = canonicalPosix(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith("/") ? p : p + "/")
}

export function isProtectedForCeiling(pattern: string, workspaceRoot?: string, permission?: string): boolean {
  if (permission && !MUTATING.has(permission)) return false
  if (permission === "external_directory") {
    const hasGlob = /[*?\[\]{}]/.test(pattern)
    if (hasGlob) {
      const norm = pattern.replaceAll("\\", "/")
      const segs = norm.split("/")
      if (segs.includes("skill") || segs.includes("skills")) return true
    }
  }
  return isProtectedPath(pattern, workspaceRoot)
}

function isGlobalProtectedPath(absCanonical: string): boolean {
  const physChild = physicalPath(absCanonical) ?? absCanonical
  const normChild = canonicalPosix(physChild)
  const candidates = [
    Global.Path.config,
    path.join(os.homedir(), ".kilo"),
    path.join(os.homedir(), ".config", "kilo"),
  ]
  for (const cand of candidates) {
    const physCand = physicalPath(cand) ?? cand
    const normCand = canonicalPosix(physCand)
    if (isPathWithin(normChild, normCand)) return true
  }
  // Fallback lexical for XDG global config (test env where physical unavailable)
  const parts = normChild.split("/")
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === ".config" && parts[i + 1] === "kilo") return true
  }
  return false
}

function isProtectedPath(p: string, workspaceRoot?: string) {
  const norm = canonicalPosix(p)
  const abs = canonicalAbsolutePhysical(p, workspaceRoot)
  const rootFiles = new Set(["kilo.json", "kilo.jsonc", "AGENTS.md"])

  // workspace .kilo/plans exemption before global (overlap: workspace == $HOME)
  if (workspaceRoot) {
    const ws = canonicalPosix(workspaceRoot)
    const physWs = canonicalPosix(physicalPath(workspaceRoot) ?? workspaceRoot)
    for (const cand of [ws, physWs]) {
      const kiloRoot = path.posix.join(cand, ".kilo")
      const absNorm = canonicalPosix(abs)
      if (absNorm === kiloRoot + "/plans" || absNorm.startsWith(kiloRoot + "/plans/")) return false
    }
  }

  // global config path - precise check (not substring)
  if (isGlobalProtectedPath(abs) || isGlobalProtectedPath(norm)) return true

  // workspace root handling
  if (workspaceRoot) {
    const ws = canonicalPosix(workspaceRoot)
    const physWs = canonicalPosix(physicalPath(workspaceRoot) ?? workspaceRoot)
    // use physical workspace for comparison as well
    const wsCandidates = [ws, physWs]
    for (const cand of wsCandidates) {
      const base = abs.split("/").pop() ?? abs
      if (rootFiles.has(base) && (abs === path.posix.join(cand, base) || canonicalPosix(abs) === path.posix.join(cand, base))) return true
      const kiloRoot = path.posix.join(cand, ".kilo")
      if (abs === kiloRoot || canonicalPosix(abs) === kiloRoot) return true
      if (abs.startsWith(kiloRoot + "/") || canonicalPosix(abs).startsWith(kiloRoot + "/")) {
        const rem = (abs.startsWith(kiloRoot + "/") ? abs.slice(kiloRoot.length + 1) : canonicalPosix(abs).slice(kiloRoot.length + 1))
        if (rem === "plans" || rem.startsWith("plans/")) return false
        return true
      }
    }
    // also check relative form directly if abs didn't match but norm is .kilo/...
    return false
  }

  // no workspaceRoot: lexical check for relative .kilo and root file alone
  if (norm === ".kilo" || norm.startsWith(".kilo/")) {
    const rem = norm.startsWith(".kilo/") ? norm.slice(".kilo/".length) : ""
    if (rem === "plans" || rem.startsWith("plans/")) return false
    return true
  }
  if (norm.includes("/.kilo/")) {
    const idx = norm.indexOf("/.kilo/")
    const rem = norm.slice(idx + "/.kilo/".length)
    if (rem === "plans" || rem.startsWith("plans/")) return false
    return true
  }
  if (norm.endsWith("/.kilo")) return true
  // root files without workspace: only exact file name without directory
  if (rootFiles.has(norm) && !norm.includes("/")) return true
  return false
}

const MUTATING = new Set(["edit", "write", "bash", "external_directory"])

function isEnvTarget(pattern: string): "exempt" | "env" | "none" {
  if (Wildcard.match(pattern, "*.env.example")) return "exempt"
  if (Wildcard.match(pattern, "*.env")) return "env"
  if (Wildcard.match(pattern, "*.env.*")) return "env"
  return "none"
}

function canonical(p: string) {
  return canonicalPosix(p)
}

function isFileBearingPermission(permission: string): boolean {
  return permission === "read" || permission === "edit" || permission === "write" || permission === "external_directory"
}

export function canonicalForPermission(pattern: string, permission: string, workspaceRoot?: string): string {
  if (hasGlobSyntax(pattern)) return pattern
  if (isFileBearingPermission(permission)) return canonicalAbsolutePhysical(pattern, workspaceRoot)
  return pattern
}

function getTargets(req: Request): string[] {
  if (req.targets) return req.targets
  // Fallback for direct evaluator tests without canonical targets: permission-aware canonicalize patterns
  return req.patterns.map((p) => canonicalForPermission(p, req.permission, req.workspaceRoot))
}

export function buildCanonicalTargets(input: { patterns: readonly string[]; metadata?: Record<string, unknown>; permission: string }, workspaceRoot?: string): string[] {
  const seen = new Set<string>()
  const raw: string[] = []
  const pushRaw = (p: unknown) => {
    if (typeof p !== "string" || p.length === 0) return
    if (!seen.has(p)) {
      seen.add(p)
      raw.push(p)
    }
  }
  for (const p of input.patterns) pushRaw(p)
  {
    const fp = (input.metadata as any)?.filepath
    if (typeof fp === "string") {
      const parts = fp.includes(", ") ? fp.split(", ") : [fp]
      for (const part of parts) {
        const trimmed = part.trim()
        if (trimmed) pushRaw(trimmed)
      }
    }
    const files = (input.metadata as any)?.files
    if (Array.isArray(files)) {
      for (const file of files) {
        if (!file || typeof file !== "object") continue
        for (const key of ["filePath", "movePath"] as const) {
          const val = (file as Record<string, unknown>)[key]
          if (typeof val === "string" && val.length > 0) pushRaw(val)
        }
      }
    }
  }
  // Permission-aware canonicalization preserves command literals for non-file permissions
  const canonSeen = new Set<string>()
  const out: string[] = []
  for (const p of raw) {
    const canon = canonicalForPermission(p, input.permission, workspaceRoot)
    if (!canonSeen.has(canon)) {
      canonSeen.add(canon)
      out.push(canon)
    }
  }
  // If no deduplication via canonical creates empty, return at least canonicalized patterns
  if (out.length === 0) {
    for (const p of input.patterns) {
      const canon = canonicalForPermission(p, input.permission, workspaceRoot)
      if (!canonSeen.has(canon)) {
        canonSeen.add(canon)
        out.push(canon)
      }
    }
  }
  return out
}

function patternsEqual(a: string[], b: string[], workspaceRoot?: string, permission?: string) {
  if (a.length !== b.length) return false
  const perm = permission ?? ""
  const ca = a.map((p) => canonicalForPermission(p, perm, workspaceRoot)).sort()
  const cb = b.map((p) => canonicalForPermission(p, perm, workspaceRoot)).sort()
  for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) return false
  return true
}

function exactApprovalCovers(request: Request, approvals: Approval[]): Approval | undefined {
  const targets = getTargets(request)
  for (const ap of approvals) {
    if (ap.sessionID === "*") continue
    if (ap.sessionID !== request.sessionID) continue
    if (ap.agent !== request.agent) continue
    if (ap.permission !== request.permission) continue
    if (ap.permission === "*" || hasGlobSyntax(ap.permission)) continue
    if (request.permission === "*" || hasGlobSyntax(request.permission)) continue
    if (ap.patterns.some((p) => hasGlobSyntax(p))) continue
    if (ap.patterns.length === 0) continue
    if (!patternsEqual(ap.patterns, targets, request.workspaceRoot, request.permission)) continue
    if (ap.kind === "once") {
      if (ap.operationId !== request.operationId) continue
    }
    return ap
  }
  return undefined
}

function hasBroadAllowFor(request: Request, layers: LayerInput[]) {
  for (const pat of getTargets(request)) {
    for (const layer of layers) {
      if (layer.ruleset === undefined) continue
      const win = winningRule(layer.ruleset, request.permission, pat, request.workspaceRoot)
      if (win && win.rule.action === "allow" && isBroadRule(win.rule)) return true
    }
  }
  return false
}

/**
 * Autonomous semantics: when level=autonomous, every decision that would
 * otherwise ask — ordinary ask from any layer (global/project/agent/
 * session-restriction), doom_loop, question lifecycle, runtime ceiling b/c
 * (protected files, .env reads), and the empty default-ask — resolves
 * directly to allow with an explicit autonomous provenance reason. Only
 * deny (any layer) and ceiling-a hard deny stay deny. File-authoritative
 * hint only — never an approval and never allowEverything.
 */
export function autonomousReason(ceilingAskPresent: boolean): "autonomous" | "autonomous-ceiling" {
  if (ceilingAskPresent) return "autonomous-ceiling"
  return "autonomous"
}

export function evaluate(input: Input): { result: DecisiveResult; provenance: Provenance; ceilingId: CeilingId } {
  const req = input.request
  const targets = getTargets(req)
  const layersByKind = new Map<LayerKind, LayerInput[]>()
  for (const l of input.layers) {
    const list = layersByKind.get(l.kind) ?? []
    list.push(l)
    layersByKind.set(l.kind, list)
  }

  const hardDenyMatches: { rule: Rule; order: number }[] = []
  if (input.hardDenyRuleset) {
    // LOCK-002: hard deny absolute — never filter mode rules from veto evaluation
    for (const pat of targets) {
      for (let i = 0; i < input.hardDenyRuleset.length; i++) {
        const rule = input.hardDenyRuleset[i]
        if (rule.action !== "deny") continue
        if (!Wildcard.match(req.permission, rule.permission)) continue
        const canonRulePat = canonicalForPermission(rule.pattern, req.permission, req.workspaceRoot)
        if (!Wildcard.match(pat, canonRulePat)) continue
        hardDenyMatches.push({ rule, order: i })
      }
    }
  }

  const bTriggers: string[] = []
  const cTriggers: string[] = []
  for (const pat of targets) {
    const isProt = req.isProtectedRequest !== undefined ? req.isProtectedRequest : isProtectedForCeiling(pat, req.workspaceRoot, req.permission)
    if (isProt) bTriggers.push(pat)
    const env = isEnvTarget(pat)
    if (env === "exempt") {
    } else if (env === "env" && req.permission === "read") {
      const broad = hasBroadAllowFor({ ...req, patterns: [pat], targets: [pat] } as Request, input.layers) || input.allowEverything
      if (broad) cTriggers.push(pat)
    }
  }
  const ceilingB = bTriggers.length > 0
  const ceilingC = cTriggers.length > 0

  let runtimeDecision: LayerDecision
  let ceilingId: CeilingId = null
  let runtimeRuleRefs: { pattern: string; action: Action; order: number }[] = []
  let runtimeReason = ""
  if (hardDenyMatches.length > 0) {
    runtimeDecision = "deny"
    ceilingId = "(a)"
    runtimeReason = "ceiling-a"
    runtimeRuleRefs = hardDenyMatches.map((m, idx) => ({ pattern: m.rule.pattern, action: m.rule.action, order: m.order ?? idx }))
  } else if (ceilingB || ceilingC) {
    runtimeDecision = "ask-ceiling"
    if (ceilingB) {
      ceilingId = "(b)"
      runtimeReason = "ceiling-b"
      runtimeRuleRefs = bTriggers.map((p, i) => ({ pattern: p, action: "ask" as Action, order: i }))
    } else {
      ceilingId = "(c)"
      runtimeReason = "ceiling-c"
      runtimeRuleRefs = cTriggers.map((p, i) => ({ pattern: p, action: "ask" as Action, order: i }))
    }
    if (ceilingB && ceilingC) {
      const offset = runtimeRuleRefs.length
      for (let i = 0; i < cTriggers.length; i++) {
        if (!bTriggers.includes(cTriggers[i])) runtimeRuleRefs.push({ pattern: cTriggers[i], action: "ask", order: offset + i })
      }
    }
  } else {
    runtimeDecision = "no-ceiling"
    ceilingId = null
    runtimeReason = "no-ceiling"
    runtimeRuleRefs = []
  }

  const perLayer = new Map<LayerKind, LayerDecision>()
  const perLayerRules = new Map<LayerKind, { pattern: string; action: Action; order: number }[]>()
  const perLayerReasons = new Map<LayerKind, string>()

  perLayer.set("runtime-ceiling", runtimeDecision)
  // canonicalize runtime refs with permission-aware helper
  const canonicalRefs = runtimeRuleRefs.map((r) => ({ ...r, pattern: canonicalForPermission(r.pattern, req.permission, req.workspaceRoot) }))
  perLayerRules.set("runtime-ceiling", canonicalRefs)
  perLayerReasons.set("runtime-ceiling", runtimeReason)

  const applicablePolicyKinds: LayerKind[] = []

  for (const kind of ["global", "project", "agent", "session-restriction"] as LayerKind[]) {
    const list = (layersByKind.get(kind) ?? []).filter((l) => l.ruleset !== undefined)
    if (list.length === 0) continue
    applicablePolicyKinds.push(kind)
    // aggregate duplicate sources: deny > ask > allow; declaration order only within one document (via winningRule)
    let hasDeny = false
    let hasAsk = false
    const aggregatedRefs: { pattern: string; action: Action; order: number }[] = []
    for (const layer of list) {
      let layerHasDeny = false
      let layerHasAsk = false
      const refs: { pattern: string; action: Action; order: number }[] = []
      for (const pat of targets) {
        const win = winningRule(layer.ruleset as Ruleset, req.permission, pat, req.workspaceRoot)
        if (!win) {
          layerHasAsk = true
          continue
        }
        const canonPat = canonicalForPermission(win.rule.pattern, req.permission, req.workspaceRoot)
        refs.push({ pattern: canonPat, action: win.rule.action, order: win.order })
        if (win.rule.action === "deny") layerHasDeny = true
        else if (win.rule.action === "ask") layerHasAsk = true
      }
      let layerDecision: LayerDecision = "allow"
      if ((layer.ruleset as Ruleset).length === 0) layerDecision = "ask"
      else if (layerHasDeny) layerDecision = "deny"
      else if (layerHasAsk) layerDecision = "ask"
      else if (refs.length === 0) layerDecision = "ask"
      else layerDecision = "allow"
      if (layerDecision === "deny") hasDeny = true
      else if (layerDecision === "ask") hasAsk = true
      for (const r of refs) aggregatedRefs.push(r)
    }
    let kindDecision: LayerDecision = "allow"
    if (hasDeny) kindDecision = "deny"
    else if (hasAsk) kindDecision = "ask"
    else kindDecision = "allow"
    perLayer.set(kind, kindDecision)
    perLayerRules.set(kind, aggregatedRefs)
    if (kindDecision === "deny") perLayerReasons.set(kind, `${kind}-deny`)
    else if (kindDecision === "ask") perLayerReasons.set(kind, `${kind}-no-rule-ask`)
    else perLayerReasons.set(kind, `${kind}-allow`)
  }

  const evaluatedKinds: LayerKind[] = ["runtime-ceiling", ...applicablePolicyKinds]

  const denies = evaluatedKinds.some((k) => perLayer.get(k) === "deny")
  const ceilingAskPresent = perLayer.get("runtime-ceiling") === "ask-ceiling"
  const ordinaryAskPresent = applicablePolicyKinds.some((k) => perLayer.get(k) === "ask")
  const anyAsk = ceilingAskPresent || ordinaryAskPresent

  const exactApproval = exactApprovalCovers(req, input.approvals)

  // Provenance: retain each applicable source individually in input order for truthful source identity
  // Always include runtime-ceiling first
  const contributingLayers: ProvenanceLayer[] = []
  contributingLayers.push({
    sourceKind: "runtime-safety" as SourceKind,
    canonicalPath: "runtime:ceiling",
    decision: perLayer.get("runtime-ceiling")!,
    rules: perLayerRules.get("runtime-ceiling") ?? [],
  })
  for (const layer of input.layers) {
    if (layer.ruleset === undefined) continue
    if (layer.kind === "runtime-ceiling") continue
    let dec: LayerDecision = "allow"
    let hasDeny = false
    let hasAsk = false
    const refs: { pattern: string; action: Action; order: number }[] = []
    for (const pat of targets) {
      const win = winningRule(layer.ruleset, req.permission, pat, req.workspaceRoot)
      if (!win) {
        hasAsk = true
        continue
      }
      const canonPat = canonicalForPermission(win.rule.pattern, req.permission, req.workspaceRoot)
      refs.push({ pattern: canonPat, action: win.rule.action, order: win.order })
      if (win.rule.action === "deny") hasDeny = true
      else if (win.rule.action === "ask") hasAsk = true
    }
    if (hasDeny) dec = "deny"
    else if (hasAsk) dec = "ask"
    else {
      if (refs.length === 0) dec = "ask"
      else dec = "allow"
    }
    if (layer.ruleset.length === 0) dec = "ask"
    contributingLayers.push({
      sourceKind: layer.sourceKind,
      canonicalPath: layer.canonicalPath,
      decision: dec,
      rules: refs,
    })
  }
  const approvalLayer: ProvenanceLayer | undefined = exactApproval
    ? {
        sourceKind: (exactApproval.kind === "durable" ? "protected-file" : "approval") as SourceKind,
        canonicalPath:
          exactApproval.kind === "durable"
            ? (exactApproval.provenancePath ?? `protected:${exactApproval.agent}:${exactApproval.patterns.map((p) => canonicalForPermission(p, exactApproval.permission, req.workspaceRoot)).join(",")}`)
            : `approval:${exactApproval.sessionID}`,
        decision: "allow" as LayerDecision,
        rules: exactApproval.patterns.map((p, i) => ({ pattern: canonicalForPermission(p, exactApproval.permission, req.workspaceRoot), action: "allow" as Action, order: i })),
      }
    : undefined

  let result: DecisiveResult
  let reason: string
  let finalCeilingId: CeilingId = ceilingId
  let approvalMeta: Provenance["approval"] | undefined

  if (denies) {
    result = "deny"
    if (perLayer.get("runtime-ceiling") === "deny") {
      reason = "ceiling-a"
      finalCeilingId = "(a)"
    } else {
      const denyKind = evaluatedKinds.find((k) => perLayer.get(k) === "deny" && k !== "runtime-ceiling")!
      reason = `${denyKind}-deny`
      finalCeilingId = null
    }
  } else if (anyAsk) {
    const hasExact = !!exactApproval
    const ceilingResolved = !ceilingAskPresent || hasExact
    const ordinaryResolved = !ordinaryAskPresent || hasExact || input.allowEverything
    if (input.permissionLevel === "autonomous") {
      result = "allow"
      reason = autonomousReason(ceilingAskPresent)
      finalCeilingId = null
    } else if (ceilingResolved && ordinaryResolved) {
      result = "allow"
      if (hasExact) reason = "approval-exact"
      else reason = "allow-everything"
      if (hasExact) {
        finalCeilingId = null
        const isDurable = exactApproval!.kind === "durable"
        approvalMeta = {
          kind: exactApproval!.kind,
          operationId: exactApproval!.kind === "once" ? exactApproval!.operationId : undefined,
          patterns: exactApproval!.patterns.map((p) => canonicalForPermission(p, exactApproval.permission, req.workspaceRoot)),
          scope: isDurable ? `${exactApproval!.agent}:${exactApproval!.provenancePath ?? exactApproval!.patterns.map((p) => canonicalForPermission(p, exactApproval.permission, req.workspaceRoot)).join(",")}` : `${exactApproval!.sessionID}:${exactApproval!.agent}`,
          expiry: exactApproval!.kind === "once" ? "once-consumed" : isDurable ? "persistent" : "session-end",
        }
        contributingLayers.push(approvalLayer!)
      } else {
        finalCeilingId = null
      }
    } else if (!ceilingResolved) {
      result = "ask-ceiling"
      reason = ceilingId === "(b)" ? "ceiling-b" : "ceiling-c"
      finalCeilingId = ceilingId
    } else {
      result = "ask"
      const askKind = applicablePolicyKinds.find((k) => perLayer.get(k) === "ask")
      reason = askKind ? `${askKind}-no-rule-ask` : "default-ask"
      finalCeilingId = null
    }
  } else {
    if (applicablePolicyKinds.length > 0 && applicablePolicyKinds.every((k) => perLayer.get(k) === "allow") && perLayer.get("runtime-ceiling") === "no-ceiling") {
      result = "allow"
      reason = "all-allow"
      finalCeilingId = null
    } else if (applicablePolicyKinds.length === 0 && perLayer.get("runtime-ceiling") === "no-ceiling") {
      if (exactApproval) {
        result = "allow"
        reason = "approval-exact"
        finalCeilingId = null
        const isDurable2 = exactApproval.kind === "durable"
        approvalMeta = {
          kind: exactApproval.kind,
          operationId: exactApproval.kind === "once" ? exactApproval.operationId : undefined,
          patterns: exactApproval.patterns.map((p) => canonicalForPermission(p, exactApproval.permission, req.workspaceRoot)),
          scope: isDurable2 ? `${exactApproval.agent}:${exactApproval.provenancePath ?? exactApproval.patterns.map((p) => canonicalForPermission(p, exactApproval.permission, req.workspaceRoot)).join(",")}` : `${exactApproval.sessionID}:${exactApproval.agent}`,
          expiry: exactApproval.kind === "once" ? "once-consumed" : isDurable2 ? "persistent" : "session-end",
        }
        contributingLayers.push(approvalLayer!)
      } else if (input.permissionLevel === "autonomous") {
        result = "allow"
        reason = "autonomous"
        finalCeilingId = null
      } else {
        result = "ask"
        reason = "default-ask"
        finalCeilingId = null
      }
    } else {
      result = "ask"
      reason = "default-ask"
      finalCeilingId = null
    }
  }

  const provenance: Provenance = {
    schemaVersion: "1",
    request: {
      permissionRequestId: req.permissionRequestId,
      operationId: req.operationId,
      permission: req.permission,
      patterns: targets.map((p) => canonicalForPermission(p, req.permission, req.workspaceRoot)),
    },
    contributingLayers,
    decisive: {
      result,
      reason,
      ceilingId: result === "ask-ceiling" ? finalCeilingId : result === "deny" && finalCeilingId === "(a)" ? "(a)" : finalCeilingId && result === "allow" && approvalMeta ? null : finalCeilingId,
    },
    ...(approvalMeta ? { approval: approvalMeta } : {}),
  }

  if (result === "deny" && hardDenyMatches.length > 0) provenance.decisive.ceilingId = "(a)"
  if (result === "ask-ceiling") provenance.decisive.ceilingId = ceilingId

  return { result, provenance, ceilingId: provenance.decisive.ceilingId }
}

export function hasWildcardPattern(p: string) {
  return hasGlobSyntax(p)
}
export function hasGlobSyntaxPattern(p: string) {
  return hasGlobSyntax(p)
}
