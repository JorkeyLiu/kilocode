import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import * as Config from "@/config/config" // kilocode_change
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import path from "path"
import { existsSync, readFileSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import z from "zod" // kilocode_change
import { zod } from "@opencode-ai/core/effect-zod" // kilocode_change
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database" // kilocode_change
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionID } from "@/session/schema" // kilocode_change - used by AllowEverythingInput
// kilocode_change start
import { ConfigProtection } from "@/kilocode/permission/config-paths"
import { ProtectedFiles } from "@/kilocode/permission/protected-files" // kilocode_change
import { KiloHeadless } from "@/kilocode/permission/headless"
import { ReadPermission } from "@/kilocode/permission/read"
import { ExternalDirectoryPermission } from "@/kilocode/permission/external-directory"
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation
import * as Evaluator from "@/permission/evaluator" // R18 evaluator authoritative
import { parse as parseJsonc } from "jsonc-parser"
import { KilocodeConfig } from "@/kilocode/config/config"
// kilocode_change end

const log = Log.create({ service: "permission" })

// Global provenance truthful helpers
// Actual authored global file -> sourceKind global-file with actual path
// Merged logical override -> sourceKind global-override with memory:global-override
// Runtime approvals -> sourceKind approval with memory:global-approved (preserved)
function globalCandidateFiles(): string[] {
  return ["kilo.jsonc"].map((f) => path.join(Global.Path.config, f))
}

export function resolveAuthoredGlobalLayers(gPerm: unknown, workspaceRoot: string): Evaluator.LayerInput[] {
  const candidates = globalCandidateFiles()
  const layers: Evaluator.LayerInput[] = []
  let diskFound = false
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, "utf8")
      if (!text.trim()) continue
      const parsed = parseJsonc(text) as any
      if (!parsed || typeof parsed !== "object" || !Object.prototype.hasOwnProperty.call(parsed, "permission")) continue
      const perm = parsed.permission
      let rs: Ruleset
      if (perm && typeof perm === "object" && perm !== null && !Array.isArray(perm)) {
        const keys = Object.keys(perm as object)
        rs = keys.length === 0 ? [] : fromConfig(perm as any)
      } else if (perm === null || perm === undefined) {
        rs = []
      } else {
        // scalar permission value unlikely
        rs = []
      }
      layers.push({ kind: "global", sourceKind: "global-file", canonicalPath: file, ruleset: rs })
      diskFound = true
    } catch (err) {
      log.warn("resolveAuthoredGlobalLayers: failed to read global file", { file, err })
    }
  }
  if (diskFound) {
    return layers
  }
  // No disk file with permission key; check Config service merge as non-file override
  if (gPerm && typeof gPerm === "object" && gPerm !== null && !Array.isArray(gPerm)) {
    const keys = Object.keys(gPerm as object)
    if (keys.length > 0) {
      return [{ kind: "global", sourceKind: "global-override", canonicalPath: "memory:global-override", ruleset: fromConfig(gPerm as any) }]
    }
    // empty object without file => treat as absent (non-applicable) to preserve absent vs authored empty distinction
  }
  return []
}

export function resolvePermissionLevel(gRaw: unknown): Evaluator.PermissionLevel | undefined {
  const level = (gRaw as { permission_level?: unknown } | null | undefined)?.permission_level
  if (level === "review" || level === "autonomous") return level
  return undefined
}

function rulesetFromRawPermission(raw: unknown): Ruleset {
  if (raw && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>)
    if (keys.length === 0) return []
    return fromConfig(raw as any)
  }
  return []
}

export function globalLayersFromPolicy(policy: Config.PolicySnapshot): Evaluator.LayerInput[] {
  if (policy.globalPermission.present) {
    return [
      {
        kind: "global",
        sourceKind: "global-file",
        canonicalPath: policy.globalSource,
        ruleset: rulesetFromRawPermission(policy.globalPermission.raw),
      },
    ]
  }
  const gPerm = (policy.global as unknown as { permission?: unknown }).permission
  if (gPerm && typeof gPerm === "object" && gPerm !== null && !Array.isArray(gPerm)) {
    const keys = Object.keys(gPerm as Record<string, unknown>)
    if (keys.length > 0) {
      return [
        {
          kind: "global",
          sourceKind: "global-override",
          canonicalPath: "memory:global-override",
          ruleset: fromConfig(gPerm as any),
        },
      ]
    }
  }
  return []
}

export function projectLayerFromPolicy(policy: Config.PolicySnapshot): Evaluator.LayerInput | undefined {
  if (!policy.projectPermission.present && !policy.projectFound) return undefined
  if (!policy.projectPermission.present) return undefined
  return {
    kind: "project",
    sourceKind: "project-file",
    canonicalPath: policy.projectSource,
    ruleset: rulesetFromRawPermission(policy.projectPermission.raw),
  }
}

export function agentLayersFromPolicy(
  policy: Config.PolicySnapshot,
  agentName: string | undefined,
  testOverrides: Map<string, Ruleset>,
  fallbackAgentRuleset?: Ruleset,
): Evaluator.LayerInput[] {
  if (!agentName || agentName === "unknown") return []
  if (testOverrides.has(agentName)) {
    const ov = testOverrides.get(agentName)!
    return [{ kind: "agent", sourceKind: "agent-manifest", canonicalPath: `agent:${agentName}`, ruleset: [...ov] }]
  }
  const derived = (policy.info as { agent_permission_sources?: unknown }).agent_permission_sources
  if (Array.isArray(derived) && derived.length > 0) {
    const layers = resolveAuthoredAgentLayers(derived, agentName)
    if (layers.length === 0 && fallbackAgentRuleset && fallbackAgentRuleset.length > 0) {
      return [{ kind: "agent", sourceKind: "agent-manifest", canonicalPath: `agent:${agentName}`, ruleset: [...fallbackAgentRuleset] }]
    }
    return layers
  }
  const keys = agentName === "code" || agentName === "build" ? ["code", "build"] : [agentName]
  const out: Evaluator.LayerInput[] = []
  for (const key of keys) {
    const agentInfo = (policy.info as any).agent?.[key] as { permission?: Record<string, unknown> } | undefined
    if (agentInfo && Object.prototype.hasOwnProperty.call(agentInfo, "permission")) {
      const perm = (agentInfo as any).permission
      if (perm && typeof perm === "object" && !Array.isArray(perm) && Object.keys(perm as object).length > 0)
        out.push({ kind: "agent", sourceKind: "agent-manifest", canonicalPath: `agent:${key}`, ruleset: fromConfig(perm as any) })
      else out.push({ kind: "agent", sourceKind: "agent-manifest", canonicalPath: `agent:${key}`, ruleset: [] })
    }
  }
  if (out.length === 0 && fallbackAgentRuleset && fallbackAgentRuleset.length > 0) {
    return [{ kind: "agent", sourceKind: "agent-manifest", canonicalPath: `agent:${agentName}`, ruleset: [...fallbackAgentRuleset] }]
  }
  return out
}

export function levelFromPolicy(policy: Config.PolicySnapshot): Evaluator.PermissionLevel | undefined {
  return resolvePermissionLevel(policy.global as unknown)
}

export function protectedRulesFromPolicy(policy: Config.PolicySnapshot, agent: string): ProtectedFiles.Rules {
  return ProtectedFiles.rules(policy.global as any, agent)
}

export function trustedSkillFromPolicy(policy: Config.PolicySnapshot, skill: string, permission: string): boolean {
  if (!skill) return false
  try {
    const rules = fromConfig(((policy.global as any).permission ?? {}) as any)
    return ExternalDirectoryPermission.isTrustedSkill(skill, permission, rules)
  } catch {
    return false
  }
}

function withPolicyVersion<T extends { provenance: Evaluator.Provenance }>(
  out: T,
  policy: Config.PolicySnapshot,
): T {
  const prov = out.provenance as Evaluator.Provenance & { policyVersion?: string }
  if (prov && typeof prov === "object" && prov.policyVersion === undefined) {
    prov.policyVersion = policy.version
  }
  return out
}

function agentKey(name: string): string {
  return name === "build" ? "code" : name
}

// kilocode_change start - authored agent.permission provenance across the four
// layers (global/project JSONC + global/project markdown). Each authored definition
// becomes its own evaluator layer (kind agent) so cross-source deny > ask > allow
// holds while same-document specific/order still settles via winningRule per layer.
// Absent (no entry) yields no layer (non-applicable); authored empty {} yields an
// empty applicable ask layer. Built-in defaults stay in the caller merged ruleset
// and remain customizable per existing merge; they never become an automatic hard
// limit. Canonical paths are file truth for source attribution; ordinary
// agent.permission readback keeps the merged effective map.
export function resolveAuthoredAgentLayers(sources: unknown, agentName: string): Evaluator.LayerInput[] {
  if (!Array.isArray(sources)) return []
  if (!agentName || agentName === "unknown") return []
  const want = agentKey(agentName)
  const out: Evaluator.LayerInput[] = []
  for (const item of sources as Array<{ agent?: unknown; source?: unknown; permission?: unknown }>) {
    if (!item || typeof item !== "object") continue
    const rawAgent = (item as { agent?: unknown }).agent
    if (typeof rawAgent !== "string" || agentKey(rawAgent) !== want) continue
    const perm = (item as { permission?: unknown }).permission
    if (perm === undefined || perm === null) continue
    if (typeof perm !== "object" || Array.isArray(perm)) continue
    const keys = Object.keys(perm as Record<string, unknown>)
    let rs: Ruleset
    try {
      rs = keys.length === 0 ? [] : fromConfig(perm as any)
    } catch (err) {
      log.warn("resolveAuthoredAgentLayers: failed to convert permission", { agent: rawAgent, err })
      continue
    }
    const canonical = typeof (item as { source?: unknown }).source === "string" && ((item as { source: string }).source.length ?? 0) > 0 ? (item as { source: string }).source : `agent:${rawAgent}`
    out.push({ kind: "agent", sourceKind: "agent-manifest", canonicalPath: canonical, ruleset: rs })
  }
  return out
}

export function effectiveProtectedTargets(request: { patterns: readonly string[]; metadata?: Record<string, unknown>; permission: string }, base: string): string[] {
  void base
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of request.patterns) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  // Include all metadata file targets unfiltered; ceiling detection via isProtectedForCeiling will filter
  try {
    const fp = (request.metadata as any)?.filepath
    if (typeof fp === "string") {
      const parts = fp.includes(", ") ? fp.split(", ") : [fp]
      for (const part of parts) {
        const trimmed = part.trim()
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed)
          out.push(trimmed)
        }
      }
    }
    const files = (request.metadata as any)?.files
    if (Array.isArray(files)) {
      for (const file of files) {
        if (!file || typeof file !== "object") continue
        for (const key of ["filePath", "movePath"] as const) {
          const val = (file as Record<string, unknown>)[key]
          if (typeof val === "string" && val.length > 0 && !seen.has(val)) {
            seen.add(val)
            out.push(val)
          }
        }
      }
    }
  } catch (err) {
    log.warn("effectiveProtectedTargets: failed to derive metadata targets", { err })
  }
  return out
}

import { isTrustedAgentContext } from "./trusted-context"
import type { TrustedAgentContext } from "./trusted-context"
import { isTrustedReadCapability } from "@/kilocode/permission/trusted-read"
import type { TrustedReadCapability } from "@/kilocode/permission/trusted-read"
function extractTrustedAgent(input: unknown): string | undefined {
  const ctx = (input as any)?.trustedContext
  if (isTrustedAgentContext(ctx)) return ctx.agent
  const legacy = (input as any)?.trustedAgent
  if (typeof legacy === "string" && legacy.length > 0) {
    log.warn("extractTrustedAgent: ignoring caller-supplied trustedAgent string", { supplied: legacy })
  }
  const ctxSpoof = (input as any)?.trustedContext
  if (ctxSpoof !== undefined && ctxSpoof !== null && !isTrustedAgentContext(ctxSpoof)) {
    log.warn("extractTrustedAgent: ignoring invalid trustedContext without brand", { supplied: ctxSpoof })
  }
  if ((input as any)?.metadata && typeof (input as any).metadata[ConfigProtection.AGENT_KEY] === "string") {
    log.warn("extractTrustedAgent: ignoring caller-supplied protectedAgent metadata", { supplied: (input as any).metadata[ConfigProtection.AGENT_KEY] })
  }
  return undefined
}
function resolveTrustedAgent(input: { trustedAgent?: string; trustedContext?: TrustedAgentContext; metadata?: Record<string, unknown> }): string | undefined {
  return extractTrustedAgent(input as any)
}
function isTrustedExternalRead(input: unknown): boolean {
  const cap = (input as any)?.trustedReadCapability ?? (input as any)?.trustedRead
  if (cap === undefined || cap === null) return false
  if (isTrustedReadCapability(cap)) return true
  log.warn("isTrustedExternalRead: ignoring invalid trustedReadCapability without brand", { supplied: cap })
  return false
}
function isCeilingCEnvFile(pattern: string): boolean {
  if (Wildcard.match(pattern, "*.env.example")) return false
  if (Wildcard.match(pattern, "*.env")) return true
  if (Wildcard.match(pattern, "*.env.*")) return true
  return false
}
function ceilingLiterals(targets: readonly string[], permission: string, ws: string): string[] {
  if (ConfigProtection.hasGlobSyntax(permission)) return []
  const out: string[] = []
  for (const p of targets) {
    if (ConfigProtection.hasGlobSyntax(p)) continue
    if (Evaluator.isProtectedForCeiling(p, ws, permission)) {
      out.push(p)
      continue
    }
    if (permission === "read" && isCeilingCEnvFile(p)) out.push(p)
  }
  return [...new Set(out)]
}

export const Event = {
  Asked: EventV2.define({ type: "permission.asked", schema: PermissionV1.Request.fields }),
  Replied: EventV2.define({
    type: "permission.replied",
    schema: {
      sessionID: PermissionV1.Request.fields.sessionID,
      requestID: PermissionV1.ID,
      reply: PermissionV1.Reply,
    },
  }),
}
// kilocode_change start - upstream moved these types into PermissionV1; re-export them here so existing
// Kilo callers that import off `Permission.*` keep working without a repo-wide rewrite
export const Rule = PermissionV1.Rule
export type Rule = PermissionV1.Rule
export const Ruleset = PermissionV1.Ruleset
export type Ruleset = PermissionV1.Ruleset
export const Action = PermissionV1.Action
export type Action = PermissionV1.Action
export const Request = PermissionV1.Request
export type Request = PermissionV1.Request
export const Reply = PermissionV1.Reply
export type Reply = PermissionV1.Reply
export const RejectedError = PermissionV1.RejectedError
export type RejectedError = PermissionV1.RejectedError
export const CorrectedError = PermissionV1.CorrectedError
export type CorrectedError = PermissionV1.CorrectedError
export const DeniedError = PermissionV1.DeniedError
export type DeniedError = PermissionV1.DeniedError
export const NotFoundError = PermissionV1.NotFoundError
export type NotFoundError = PermissionV1.NotFoundError
export type Error = PermissionV1.Error
export const ReplyInput = PermissionV1.ReplyInput
export type ReplyInput = PermissionV1.ReplyInput
// Kilo extends upstream's AskInput with an optional hardRuleset (consumed by drain + session/prompt)
// trustedContext/trustedReadCapability are internal-only capabilities not part of public AskInput; they are interpreted via branded checks on unknown fields and never exported
export type AskInput = PermissionV1.AskInput & { hardRuleset?: PermissionV1.Ruleset }
// kilocode_change end

// kilocode_change start
export const SaveAlwaysRulesInput = z.object({
  requestID: zod(PermissionV1.ID),
  approvedAlways: z.string().array().optional(),
  deniedAlways: z.string().array().optional(),
})

export const AllowEverythingInput = z.object({
  enable: z.boolean(),
  requestID: zod(PermissionV1.ID).optional(),
  sessionID: zod(SessionID).optional(),
})
// kilocode_change end

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  // kilocode_change start
  readonly saveAlwaysRules: (input: z.infer<typeof SaveAlwaysRulesInput>) => Effect.Effect<void, NotFoundError>
  readonly allowEverything: (input: z.infer<typeof AllowEverythingInput>) => Effect.Effect<void>
  readonly pending: (id: string) => Effect.Effect<Request | undefined>
  readonly provenance: (id: string) => Effect.Effect<Evaluator.Provenance | undefined>
  readonly diagnostics: (id: string) => Effect.Effect<Evaluator.Provenance | undefined>
  readonly debugState: () => Effect.Effect<{ approvals: Evaluator.Approval[]; approved: Rule[]; session: Record<string, Ruleset>; policyVersion?: string }>
  readonly evaluateForDebug: (input: { permission: string; patterns: string[]; metadata?: Record<string, unknown>; sessionID: string; agent: string; agentPermission?: Ruleset; hardRuleset?: Ruleset; sessionPermission?: Ruleset; trustedReadCapability?: unknown }) => Effect.Effect<{ result: Evaluator.DecisiveResult; provenance: Evaluator.Provenance; ceilingId: Evaluator.CeilingId; policyVersion: string }>
  // kilocode_change end
}

interface PendingEntry {
  info: Request
  // kilocode_change start
  ruleset: Ruleset
  hardRuleset?: Ruleset
  trustedAgent?: string
  trustedRead?: TrustedReadCapability
  saved?: boolean
  provenance?: Evaluator.Provenance
  canonicalTargets: string[]
  policy: Config.PolicySnapshot
  // kilocode_change end
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: Rule[]
  session: Record<string, Ruleset> // kilocode_change
  r18: { approvals: Evaluator.Approval[] } // R18 runtime-owned approvals
  provenance: Map<string, Evaluator.Provenance>
}

// kilocode_change start — legacy decision helpers removed; no second authority remains.
// Only non-authorizing predicate utilities below. All final allow/deny uses Evaluator.evaluate.
function filterByPermission(permission: string, ruleset: Ruleset) {
  return ruleset.filter((rule) => Wildcard.match(permission, rule.permission))
}

/**
 * R18 non-authorizing predicate — does any rule in the supplied rulesets match the
 * given permission/pattern via wildcard? Boolean only, never returns allow/deny.
 * Use Evaluator.evaluate for final authorization decisions.
 */
export function hasMatchingRule(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): boolean {
  return rulesets.flat().some((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}

/**
 * R18 non-authorizing predicate — does an exact permission/pattern pair exist
 * in the ruleset with the given action? Exact string equality, no wildcard expansion.
 */
export function hasExactRule(permission: string, pattern: string, action: Action, ruleset: Ruleset): boolean {
  return ruleset.some((r) => r.permission === permission && r.pattern === pattern && r.action === action)
}
// kilocode_change end

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service // kilocode_change
    const database = yield* Database.Service // kilocode_change
    const testAgentOverrides = new Map<string, Ruleset>()
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [] as Rule[], // kilocode_change - upstream dropped DB-seeded approvals; Kilo persists via config.updateGlobal
          session: {} as Record<string, Ruleset>, // kilocode_change
          r18: { approvals: [] as Evaluator.Approval[] },
          provenance: new Map<string, Evaluator.Provenance>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              const existing = state.provenance.get(String(item.info.id)) ?? item.provenance
              const base = existing ?? {
                schemaVersion: "1" as const,
                request: {
                  permissionRequestId: String(item.info.id),
                  operationId: `permission:${String(item.info.id)}`,
                  permission: item.info.permission,
                  patterns: [...item.info.patterns],
                },
                contributingLayers: [],
                decisive: { result: "deny" as const, reason: "rejected", ceilingId: null },
              }
              const prov: Evaluator.Provenance = {
                ...base,
                decisive: { result: "deny", reason: "rejected", ceilingId: (base as any).decisive.ceilingId ?? null },
              }
              if ((prov as any).approval) delete (prov as any).approval
              state.provenance.set(String(item.info.id), prov)
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
            state.r18.approvals = []
            state.provenance.clear()
          }),
        )

        return state
      }),
    )

    // Centralized helper to update final provenance for a permission request — sole terminal finalization point, retained until disposal
    const storeFinalProvenance = (id: string, prov: Evaluator.Provenance) =>
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        s.provenance.set(id, prov)
      })
    const finalizeProvenance = (id: string, prov: Evaluator.Provenance) => storeFinalProvenance(id, prov)
    const storeRejectedProvenance = (entry: PendingEntry, st: State) =>
      Effect.gen(function* () {
        const existing = st.provenance.get(String(entry.info.id)) ?? entry.provenance
        const base = existing ?? {
          schemaVersion: "1" as const,
          request: {
            permissionRequestId: String(entry.info.id),
            operationId: `permission:${String(entry.info.id)}`,
            permission: entry.info.permission,
            patterns: [...entry.info.patterns],
          },
          contributingLayers: [],
          decisive: { result: "deny" as const, reason: "rejected", ceilingId: null },
        }
        const prov: Evaluator.Provenance = {
          ...base,
          decisive: { result: "deny", reason: "rejected", ceilingId: base.decisive.ceilingId ?? null },
        }
        // never attach approval for rejected
        if ((prov as any).approval) delete (prov as any).approval
        if (entry.policy?.version !== undefined && (prov as Evaluator.Provenance & { policyVersion?: string }).policyVersion === undefined) {
          ;(prov as Evaluator.Provenance & { policyVersion?: string }).policyVersion = entry.policy.version
        }
        yield* finalizeProvenance(String(entry.info.id), prov)
        return prov
      })
    // Centralized evaluator builder — sole construction for all ask/drain re-evaluations, includes protected_files state.
    // Generation policy (global/project permission layers, level, trusted-skill
    // inputs, protected-file constraints, agent layers) comes exclusively from
    // the pending entry's originating policy snapshot. Runtime session-bound
    // approvals and session restrictions stay live. No disk or live-config
    // reads occur here.
    const buildEvaluatorInputForEntry = (entry: PendingEntry, st: State) =>
      Effect.gen(function* () {
        const policy = entry.policy
        const ctx = yield* InstanceState.context
        const ws = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        const base = ProtectedFiles.base(ctx)
        const reqAgent = entry.trustedAgent ?? resolveTrustedAgent(entry.info as any) ?? "unknown"
        const isExternalReadOnly = entry.info.permission === "external_directory" && isTrustedExternalRead(entry as any)
        const canonicalTargetsForEntry = (entry as any).canonicalTargets ?? Evaluator.buildCanonicalTargets({ patterns: [...entry.info.patterns], metadata: entry.info.metadata as any, permission: entry.info.permission }, ws)
        const isProtectedForEntry = !isExternalReadOnly && canonicalTargetsForEntry.some((p: string) => Evaluator.isProtectedForCeiling(p, ws, entry.info.permission))
        const evalReq: Evaluator.Request = {
          permission: entry.info.permission,
          patterns: [...entry.info.patterns],
          targets: canonicalTargetsForEntry,
          permissionRequestId: String(entry.info.id),
          operationId: `permission:${String(entry.info.id)}`,
          sessionID: String(entry.info.sessionID),
          agent: reqAgent,
          workspaceRoot: ws,
          ...(isExternalReadOnly ? { isProtectedRequest: false as const } : isProtectedForEntry ? { isProtectedRequest: true as const } : {}),
        }
        const allowEverythingFlag =
          st.approved.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow") ||
          (st.session[String(entry.info.sessionID)] ?? []).some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        const globalLayers: Evaluator.LayerInput[] = [...globalLayersFromPolicy(policy)]
        if (st.approved.length > 0) globalLayers.push({ kind: "global", sourceKind: "approval", canonicalPath: "memory:global-approved", ruleset: [...st.approved] })
        const projLayer = projectLayerFromPolicy(policy)
        const projectFound = policy.projectFound
        let callerFallbackLayer: Evaluator.LayerInput | undefined
        if (entry.ruleset.length > 0) {
          callerFallbackLayer = { kind: "session-restriction", sourceKind: "session-restriction", canonicalPath: "memory:request-ruleset", ruleset: entry.ruleset }
        }
        const agentLayers: Evaluator.LayerInput[] = agentLayersFromPolicy(policy, reqAgent !== "unknown" ? reqAgent : undefined, testAgentOverrides)
        const sessRules = st.session[String(entry.info.sessionID)] ?? []
        const sessLayer: Evaluator.LayerInput | undefined = sessRules.length > 0 ? { kind: "session-restriction", sourceKind: "session-restriction", canonicalPath: `session:${String(entry.info.sessionID)}`, ruleset: sessRules } : undefined
        // Durable protected_files state — included in every reevaluation, preserving hard-deny/session restrictions
        const skill = ConfigProtection.globalSkillPattern(entry.info)
        const trusted = skill
          ? ExternalDirectoryPermission.isTrustedSkill(skill, entry.info.permission, st.approved) ||
            trustedSkillFromPolicy(policy, skill, entry.info.permission)
          : false
        const isExternalReadOnly2 = entry.info.permission === "external_directory" && isTrustedExternalRead(entry as any)
        const targetsProtected = !isExternalReadOnly2 && canonicalTargetsForEntry.some((p: string) => Evaluator.isProtectedForCeiling(p, ws, entry.info.permission))
        const protectedRules = reqAgent !== "unknown" && targetsProtected && !trusted ? protectedRulesFromPolicy(policy, reqAgent) : ({} as ProtectedFiles.Rules)
        const protectedPaths = reqAgent !== "unknown" && targetsProtected ? new Set(ProtectedFiles.requestPaths(entry.info, base)) : undefined
        let syntheticApprovals: Evaluator.Approval[] = []
        let protectedDenyLayer: Evaluator.LayerInput | undefined
        if (targetsProtected && reqAgent !== "unknown" && protectedPaths && !trusted) {
          const hasAllow = (() => {
            if (protectedPaths.size === 0) return false
            for (const canon of protectedPaths) {
              if (ProtectedFiles.actionFor(protectedRules, canon) !== "allow") return false
            }
            // For pattern-based requests, ensure every pattern that is protected is covered; for metadata-only, this holds because protectedPaths covers metadata
            const protectedPatternCanons = entry.info.patterns.map((p: string) => ConfigProtection.canonicalKey(p, base)).filter((c) => protectedPaths.has(c))
            if (protectedPatternCanons.length > 0) {
              for (const pat of entry.info.patterns) {
                const canon = ConfigProtection.canonicalKey(pat, base)
                if (Evaluator.isProtectedForCeiling(pat, ws, entry.info.permission) && !protectedPaths.has(canon)) return false
              }
            }
            return true
          })()
          const hasDeny = (() => {
            for (const canon of protectedPaths) {
              if (ProtectedFiles.actionFor(protectedRules, canon) === "deny") return true
            }
            return false
          })()
          if (hasAllow) {
            const allCanons = canonicalTargetsForEntry
            const provPath = `protected:${reqAgent}:${allCanons.join(",")}`
            syntheticApprovals = [{ kind: "durable" as const, patterns: allCanons, sessionID: String(entry.info.sessionID), agent: reqAgent, permission: entry.info.permission, provenancePath: provPath }]
          }
          if (hasDeny) {
            const denyTargets = canonicalTargetsForEntry.filter((p: string) => {
              const canon = ConfigProtection.canonicalKey(p, base)
              const canonWs = ConfigProtection.canonicalKey(p, ws)
              return protectedPaths.has(canon) || protectedPaths.has(canonWs) || protectedPaths.has(p)
            })
            const denyRules: Evaluator.Rule[] = denyTargets.map((p: string) => ({ permission: entry.info.permission, pattern: p, action: "deny" as const }))
            const denyCanons = denyTargets.map((p: string) => ConfigProtection.canonicalKey(p, base))
            const denyPath = `protected:${reqAgent}:${denyCanons.join(",")}`
            protectedDenyLayer = { kind: "session-restriction", sourceKind: "protected-file" as const, canonicalPath: denyPath, ruleset: denyRules }
          }
        }
        const layers: Evaluator.LayerInput[] = [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }]
        for (const g of globalLayers) layers.push(g)
        if (projLayer) layers.push(projLayer)
        if (callerFallbackLayer) layers.push(callerFallbackLayer)
        for (const al of agentLayers) layers.push(al)
        if (sessLayer) layers.push(sessLayer)
        if (protectedDenyLayer) layers.push(protectedDenyLayer)
        const approvals = [...st.r18.approvals, ...syntheticApprovals]
        return { evalReq, layers, approvals, allowEverything: allowEverythingFlag, hardDenyRuleset: entry.hardRuleset, permissionLevel: levelFromPolicy(policy) }
      })
    const computeProvenanceForEntry = (entry: PendingEntry, st: State) =>
      Effect.gen(function* () {
        const { evalReq, layers, approvals, allowEverything, hardDenyRuleset, permissionLevel } = yield* buildEvaluatorInputForEntry(entry, st)
        const raw = Evaluator.evaluate({ request: evalReq, layers, approvals, allowEverything, hardDenyRuleset, permissionLevel })
        const out = withPolicyVersion(raw, entry.policy)
        yield* finalizeProvenance(String(entry.info.id), out.provenance)
        return out
      })

    // Shared private evaluator input/context builder — sole policy composition for both normal Permission.ask and debug handler.
    // Debug must call this via evaluateForDebug, not duplicate layer assembly.
    // Generation policy comes from the supplied snapshot; session approvals stay live. No disk or live-config reads.
    const buildSharedEvaluatorInput = (opts: {
      request: { permission: string; patterns: string[]; metadata?: Record<string, unknown>; sessionID: string }
      agentName?: string
      workspaceRoot: string
      base: string
      ruleset: Ruleset
      hardRuleset?: Ruleset
      localSessionRules: Ruleset
      st: State
      policy: Config.PolicySnapshot
      permissionRequestId: string
      operationId: string
      fallbackAgentRuleset?: Ruleset
      trustedReadCapability?: TrustedReadCapability
    }) =>
      Effect.gen(function* () {
        const { request, agentName, workspaceRoot, base, ruleset, hardRuleset, localSessionRules, st, policy, permissionRequestId, operationId } = opts
        const { approved, r18 } = st
        void r18
        const skill = ConfigProtection.globalSkillPattern(request as any)
        const trustedSkill = skill
          ? ExternalDirectoryPermission.isTrustedSkill(skill, request.permission, approved) ||
            trustedSkillFromPolicy(policy, skill, request.permission)
          : false
        const isExternalReadOnly = request.permission === "external_directory" && isTrustedExternalRead(opts as any)
        const canonicalTargets = Evaluator.buildCanonicalTargets({ patterns: [...request.patterns], metadata: request.metadata as any, permission: request.permission }, workspaceRoot)
        const targetsProtected = !isExternalReadOnly && canonicalTargets.some((p: string) => Evaluator.isProtectedForCeiling(p, workspaceRoot, request.permission))
        const protectedRules = agentName && targetsProtected && !trustedSkill ? protectedRulesFromPolicy(policy, agentName) : ({} as ProtectedFiles.Rules)
        const protectedPaths = agentName && targetsProtected ? new Set(ProtectedFiles.requestPaths(request as any, base)) : undefined
        const hasDurableProtectedAllow = (() => {
          if (!targetsProtected || !agentName || !protectedPaths || trustedSkill) return false
          if (protectedPaths.size === 0) return false
          for (const canon of protectedPaths) {
            if (ProtectedFiles.actionFor(protectedRules, canon) !== "allow") return false
          }
          return true
        })()
        const hasDurableProtectedDeny = (() => {
          if (!targetsProtected || !agentName || !protectedPaths || trustedSkill) return false
          for (const canon of protectedPaths) {
            if (ProtectedFiles.actionFor(protectedRules, canon) === "deny") return true
          }
          return false
        })()
        const agentForEval = agentName ?? "unknown"
        const evalReq: Evaluator.Request = {
          permission: request.permission,
          patterns: [...request.patterns],
          targets: canonicalTargets,
          permissionRequestId,
          operationId,
          sessionID: String(request.sessionID),
          agent: agentForEval,
          workspaceRoot,
          ...(isExternalReadOnly ? { isProtectedRequest: false as const } : targetsProtected ? { isProtectedRequest: true as const } : {}),
        }
        const hasGlobalAllowEverything = approved.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        const hasSessionAllowEverything = (st.session[String(request.sessionID)] ?? []).some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        const allowEverythingFlag = hasGlobalAllowEverything || hasSessionAllowEverything
        const globalLayers: Evaluator.LayerInput[] = [...globalLayersFromPolicy(policy)]
        if (approved.length > 0) globalLayers.push({ kind: "global", sourceKind: "approval", canonicalPath: "memory:global-approved", ruleset: [...approved] })
        const projectLayer: Evaluator.LayerInput | undefined = projectLayerFromPolicy(policy)
        const callerFallbackLayer: Evaluator.LayerInput | undefined = ruleset.length > 0 ? { kind: "session-restriction" as const, sourceKind: "session-restriction" as const, canonicalPath: "memory:request-ruleset", ruleset } : undefined
        const agentLayers: Evaluator.LayerInput[] = agentName ? agentLayersFromPolicy(policy, agentName, testAgentOverrides, opts.fallbackAgentRuleset) : []
        const sessionLayer: Evaluator.LayerInput | undefined = localSessionRules.length > 0 ? { kind: "session-restriction", sourceKind: "session-restriction", canonicalPath: `session:${String(request.sessionID)}`, ruleset: localSessionRules } : undefined
        const syntheticApprovals: Evaluator.Approval[] = hasDurableProtectedAllow ? (() => {
          const provPath = `protected:${agentName}:${canonicalTargets.join(",")}`
          return [{ kind: "durable" as const, patterns: canonicalTargets, sessionID: String(request.sessionID), agent: agentName!, permission: request.permission, provenancePath: provPath }]
        })() : []
        let protectedDenyLayer: Evaluator.LayerInput | undefined
        if (hasDurableProtectedDeny) {
          const denyTargets = canonicalTargets.filter((p: string) => {
            const canon = ConfigProtection.canonicalKey(p, base)
            const canonWs = ConfigProtection.canonicalKey(p, workspaceRoot)
            return protectedPaths?.has(canon) || protectedPaths?.has(canonWs) || protectedPaths?.has(p)
          })
          const denyRules: Evaluator.Rule[] = denyTargets.map((p: string) => ({ permission: request.permission, pattern: p, action: "deny" as const }))
          const denyCanons = denyTargets.map((p: string) => ConfigProtection.canonicalKey(p, workspaceRoot))
          const denyPath = `protected:${agentName}:${denyCanons.join(",")}`
          protectedDenyLayer = { kind: "session-restriction", sourceKind: "protected-file" as const, canonicalPath: denyPath, ruleset: denyRules }
        }
        const layers: Evaluator.LayerInput[] = [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }]
        for (const gl of globalLayers) layers.push(gl)
        if (projectLayer) layers.push(projectLayer)
        if (callerFallbackLayer) layers.push(callerFallbackLayer)
        for (const al of agentLayers) layers.push(al)
        if (sessionLayer) layers.push(sessionLayer)
        if (protectedDenyLayer) layers.push(protectedDenyLayer)
        const allApprovals = [...st.r18.approvals, ...syntheticApprovals]
        return { evalReq, layers, approvals: allApprovals, allowEverything: allowEverythingFlag, hardDenyRuleset: hardRuleset, permissionLevel: levelFromPolicy(policy) }
      })

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const st = yield* InstanceState.get(state)
      const { approved, pending, r18 } = st
      const { ruleset, hardRuleset, trustedContext, trustedReadCapability, ...request } = input as AskInput & { trustedContext?: TrustedAgentContext; trustedReadCapability?: TrustedReadCapability }
      const local = st.session[request.sessionID] ?? []

      const ctx = yield* InstanceState.context
      const base = ProtectedFiles.base(ctx)
      const workspaceRoot = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const trustedAgent = extractTrustedAgent({ trustedContext } as any)
      // also warn if caller tried to spoof via metadata/trustedAgent string
      extractTrustedAgent(input as any)
      const agentName = trustedAgent
      const rawId = (request as unknown as { id?: string }).id ?? PermissionV1.ID.ascending()
      const permissionRequestId = String(rawId)
      const operationId = `permission:${permissionRequestId}`
      const trustedReadForShared = isTrustedReadCapability(trustedReadCapability) ? trustedReadCapability : undefined
      if ((input as any).trustedReadCapability && !isTrustedReadCapability((input as any).trustedReadCapability)) {
        log.warn("ask: ignoring invalid trustedReadCapability without brand", { supplied: (input as any).trustedReadCapability })
      }
      if ((request as any).metadata && typeof (request as any).metadata.access === "string") {
        log.warn("ask: ignoring metadata.access for isProtectedRequest; use trustedReadCapability", { supplied: (request as any).metadata.access })
      }
      const isHardModeAsk = !agentName || agentName === "unknown" || ["ask", "plan", "architect"].includes(agentName.toLowerCase())
      const effectiveHardRuleset = isHardModeAsk ? hardRuleset : undefined
      const policy = yield* config.getPolicySnapshot().pipe(
        Effect.catch((err) => {
          log.warn("ask: policy snapshot unavailable, using empty policy", { err })
          return Effect.succeed({
            version: "empty",
            info: {} as any,
            canonical: { providers: {}, conflicts: [] } as any,
            global: {} as any,
            globalSource: "memory:empty",
            globalPermission: { present: false, raw: undefined },
            projectSource: `${workspaceRoot}/.kilo/kilo.jsonc`,
            projectFound: false,
            projectPermission: { present: false, raw: undefined },
          } as Config.PolicySnapshot)
        }),
      )
      const shared = yield* buildSharedEvaluatorInput({
        request: request as any,
        agentName,
        workspaceRoot,
        base,
        ruleset,
        hardRuleset: effectiveHardRuleset,
        localSessionRules: local,
        st,
        policy,
        permissionRequestId,
        operationId,
        fallbackAgentRuleset: effectiveHardRuleset,
        trustedReadCapability: trustedReadForShared,
      })
      const { evalReq, layers, approvals: allApprovals, allowEverything: allowEverythingFlag, hardDenyRuleset: sharedHardDeny, permissionLevel } = shared
      const rawOut = Evaluator.evaluate({
        request: evalReq,
        layers,
        approvals: allApprovals,
        allowEverything: allowEverythingFlag,
        hardDenyRuleset: sharedHardDeny,
        permissionLevel,
      })
      const evalOut = withPolicyVersion(rawOut, policy)
      const skill = ConfigProtection.globalSkillPattern(request as any)
      const canonicalTargetsForMeta = (evalReq as any).targets as string[] ?? [...request.patterns]
      const isExternalReadOnlyMeta = request.permission === "external_directory" && isTrustedExternalRead(input as any)
      const targetsProtected = !isExternalReadOnlyMeta && canonicalTargetsForMeta.some((p: string) => Evaluator.isProtectedForCeiling(p, workspaceRoot, request.permission))

      log.info("evaluated via R18", { permission: request.permission, patterns: request.patterns, result: evalOut.result, reason: evalOut.provenance.decisive.reason, provenance: evalOut.provenance })
      // Store provenance for read-model diagnostics before branching — terminal for immediate allow/deny, interim for ask
      yield* finalizeProvenance(permissionRequestId, evalOut.provenance)

      if (evalOut.result === "deny") {
        return yield* new DeniedError({ ruleset: filterByPermission(request.permission, ruleset) })
      }
      if (evalOut.result === "allow") {
        if (evalOut.provenance.approval?.kind === "once" && evalOut.provenance.approval.operationId) {
          const op = evalOut.provenance.approval.operationId
          const idx = r18.approvals.findIndex((a) => a.kind === "once" && a.operationId === op && a.sessionID === evalReq.sessionID)
          if (idx >= 0) r18.approvals.splice(idx, 1)
        }
        return
      }
      // ask or ask-ceiling => need to prompt (hard deny already dominated)
      if (yield* KiloHeadless.denies(request.sessionID).pipe(Effect.provideService(Database.Service, database))) {
        return yield* new DeniedError({ ruleset: filterByPermission(request.permission, ruleset) })
      }

      const id = PermissionV1.ID.make(permissionRequestId)
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: {
          ...request.metadata,
          ...(skill ? { rules: [skill] } : {}),
          ...(targetsProtected && skill === undefined
            ? {
                [ConfigProtection.DISABLE_ALWAYS_KEY]: true,
                [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
                ...(agentName ? { [ConfigProtection.PATHS_KEY]: ProtectedFiles.requestPaths(request, base) } : {}),
              }
            : {}),
          // R18 provenance/read-model: expose provenance via metadata for UI diagnostics without second store
          provenance: evalOut.provenance,
          permissionRequestId,
          operationId,
        },
        always: skill ? [skill] : request.always,
        tool: request.tool,
      }
      log.info("asking", { id, permission: info.permission, patterns: info.patterns, provenance: evalOut.provenance })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, ruleset, hardRuleset, trustedAgent: agentName, trustedRead: trustedReadForShared, deferred, provenance: evalOut.provenance, canonicalTargets: (shared.evalReq as any).targets ?? Evaluator.buildCanonicalTargets({ patterns: [...request.patterns], metadata: request.metadata as any, permission: request.permission }, workspaceRoot), policy })
      yield* events.publish(Event.Asked, info)
      const timer = P0Perf.span("permission_wait", {
        id: String(id),
        meta: { sessionID: String(info.sessionID), permission: info.permission },
      })
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.await(deferred)
          timer.end()
        }),
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          if (s.pending.has(id)) {
            const entry = s.pending.get(id)
            if (entry) yield* storeRejectedProvenance(entry, s)
            s.pending.delete(id)
          } else {
            pending.delete(id)
          }
        }),
      )
    })

    // Shared parity helpers — compute production-effective ruleset exactly as KiloSessionPrompt without duplicating layer assembly
    const guardPermissionsLocal = (agentName: string, agentPerm: Ruleset | undefined, sessionPerm: Ruleset | undefined): Ruleset => {
      const sessionRules = sessionPerm ?? []
      const modes = ["ask", "plan", "architect"]
      if (!modes.includes(agentName.toLowerCase())) return sessionRules
      const denyOnly = sessionRules.filter((r) => r.action === "deny")
      return merge(sessionRules, agentPerm ?? [], denyOnly)
    }
    const hardPermissionsLocal = (agentName: string, agentPerm: Ruleset | undefined): Ruleset | undefined => {
      const modes = ["ask", "plan", "architect"]
      if (!modes.includes(agentName.toLowerCase())) return undefined
      return agentPerm && agentPerm.length > 0 ? [...agentPerm] : undefined
    }
    const effectiveRulesetLocal = (agentName: string, agentPerm: Ruleset | undefined, sessionPerm: Ruleset | undefined): Ruleset => {
      const guard = guardPermissionsLocal(agentName, agentPerm, sessionPerm)
      return merge(agentPerm ?? [], guard)
    }

    const evaluateForDebug = Effect.fn("Permission.evaluateForDebug")(function* (input: { permission: string; patterns: string[]; metadata?: Record<string, unknown>; sessionID: string; agent: string; agentPermission?: Ruleset; hardRuleset?: Ruleset; sessionPermission?: Ruleset; trustedReadCapability?: unknown }) {
      const st = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      const base = ProtectedFiles.base(ctx)
      const workspaceRoot = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const permissionRequestId = PermissionV1.ID.ascending()
      const operationId = `permission:${permissionRequestId}`
      const localSessionRules = st.session[input.sessionID] ?? input.sessionPermission ?? []
      const policy = yield* config.getPolicySnapshot()
      // Determine hard deny from agent permission if applicable (same as KiloSessionPrompt.hardPermissions) — mode-gated, not all agent rules
      const hardMode = ["ask", "plan", "architect"].includes(input.agent.toLowerCase())
      let hardRuleset: Ruleset | undefined = input.hardRuleset
      if (hardMode) {
        if (!hardRuleset) {
          try {
            const aInfo = (policy.info as any).agent?.[input.agent] as { permission?: Record<string, unknown> } | undefined
            if (aInfo && aInfo.permission && typeof aInfo.permission === "object" && !Array.isArray(aInfo.permission) && Object.keys(aInfo.permission as object).length > 0) {
              hardRuleset = fromConfig(aInfo.permission as any)
            } else if (input.agentPermission && input.agentPermission.length > 0) {
              hardRuleset = [...input.agentPermission]
            } else {
              hardRuleset = undefined
            }
          } catch (err) {
            log.warn("evaluateForDebug: hardDeny lookup failed", { err })
            hardRuleset = input.agentPermission ? [...input.agentPermission] : undefined
          }
        }
      } else {
        hardRuleset = undefined
      }
      // Production-effective ruleset via same merge as KiloSessionPrompt — ensures non-empty agent/session are exercised truthfully
      const effectiveRuleset = effectiveRulesetLocal(input.agent, input.agentPermission, input.sessionPermission)
      const shared = yield* buildSharedEvaluatorInput({
        request: { permission: input.permission, patterns: input.patterns, metadata: input.metadata as any, sessionID: input.sessionID as any },
        agentName: input.agent,
        workspaceRoot,
        base,
        ruleset: effectiveRuleset,
        hardRuleset,
        localSessionRules,
        st,
        policy,
        permissionRequestId,
        operationId,
        fallbackAgentRuleset: input.agentPermission,
        trustedReadCapability: input.trustedReadCapability as any,
      })
      const raw = Evaluator.evaluate({ request: shared.evalReq, layers: shared.layers, approvals: shared.approvals, allowEverything: shared.allowEverything, hardDenyRuleset: shared.hardDenyRuleset, permissionLevel: shared.permissionLevel })
      const out = withPolicyVersion(raw, policy)
      return { result: out.result, provenance: out.provenance, ceilingId: out.ceilingId, policyVersion: policy.version }
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const st = yield* InstanceState.get(state)
      const { approved, pending, r18, provenance } = st
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      // remove stored provenance for this request id after reply
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* storeRejectedProvenance(existing, st)
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* storeRejectedProvenance(item, st)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      // R18: once/session approvals are runtime-owned in-memory only; no durable write
      const ctx = yield* InstanceState.context
      const wsCtx = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const agentForApproval = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
      if (input.reply === "once") {
        const opId = `permission:${String(existing.info.id)}`
        let didAddOnce = false
        const canonicalTargetsOnce = (existing as any).canonicalTargets ?? Evaluator.buildCanonicalTargets({ patterns: [...existing.info.patterns], metadata: existing.info.metadata as any, permission: existing.info.permission }, wsCtx)
        // only exact canonical targets, no glob syntax, permission not "*"
        if (existing.info.permission !== "*" && !ConfigProtection.hasGlobSyntax(existing.info.permission) && canonicalTargetsOnce.every((p: string) => !ConfigProtection.hasGlobSyntax(p))) {
          r18.approvals.push({
            kind: "once",
            operationId: opId,
            patterns: canonicalTargetsOnce,
            sessionID: String(existing.info.sessionID),
            agent: agentForApproval,
            permission: existing.info.permission,
          })
          didAddOnce = true
        }
        // Final provenance truthfully via Evaluator — only succeed if evaluator returns allow
        const onceOut = yield* computeProvenanceForEntry(existing, st)
        // Atomically finalize deferred + provenance: only allow resolves, deny/ask terminalize as reject/keep-consistent
        if (onceOut && (onceOut as any).provenance?.decisive?.result === "allow") {
          yield* Deferred.succeed(existing.deferred, undefined)
        } else if (onceOut && (onceOut as any).provenance?.decisive?.result === "deny") {
          yield* Deferred.fail(existing.deferred, new PermissionV1.RejectedError())
        } else {
          // ask / ask-ceiling -> rejected wildcard or hard-deny/ceiling not resolved: fail consistently, never succeed with ask provenance
          yield* Deferred.fail(existing.deferred, new PermissionV1.RejectedError())
        }
        const idx = r18.approvals.findIndex((a) => a.kind === "once" && a.operationId === opId)
        if (idx >= 0) r18.approvals.splice(idx, 1)
        // drain other pending that may be covered by remaining session approvals (once not carried) via evaluator — centralized with protected state
        for (const [id, item] of [...pending.entries()]) {
          const { evalReq, layers, approvals, allowEverything: allowEv, hardDenyRuleset, permissionLevel } = yield* buildEvaluatorInputForEntry(item, st)
          const rawDrain = Evaluator.evaluate({ request: evalReq, layers, approvals, allowEverything: allowEv, hardDenyRuleset, permissionLevel })
          const out = withPolicyVersion(rawDrain, item.policy)
          if (out.result === "allow") {
            yield* finalizeProvenance(String(item.info.id), out.provenance)
            pending.delete(id)
            yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "once" })
            yield* Deferred.succeed(item.deferred, undefined)
            if (out.provenance.approval?.kind === "once" && out.provenance.approval.operationId) {
              const idx2 = r18.approvals.findIndex((a) => a.kind === "once" && a.operationId === out.provenance.approval!.operationId)
              if (idx2 >= 0) r18.approvals.splice(idx2, 1)
            }
          } else if (out.result === "deny") {
            yield* finalizeProvenance(String(item.info.id), out.provenance)
            pending.delete(id)
            yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
            yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
          } else {
            // ask / ask-ceiling remains pending — finalize interim provenance but keep deferred pending
            yield* finalizeProvenance(String(item.info.id), out.provenance)
          }
        }
        return
      }

      // handle "always" as session-bound in-memory approval (no durable file write, no cross-session leak)
      // Ordinary + protected both bind exact current sessionID + agent + permission + canonical exact patterns
      // as r18 kind:session; evaluator exactApprovalCovers enforces the binding. No wildcard session "*"
      const ws2 = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const canonicalTargetsAlways = (existing as any).canonicalTargets ?? Evaluator.buildCanonicalTargets({ patterns: [...existing.info.patterns], metadata: existing.info.metadata as any, permission: existing.info.permission }, ws2)
      const isProtForR18 = canonicalTargetsAlways.some(
        (p: string) => Evaluator.isProtectedForCeiling(p, ws2, existing.info.permission) || (existing.info.permission === "read" && isCeilingCEnvFile(p)),
      )
      const isExact = canonicalTargetsAlways.every((p: string) => !ConfigProtection.hasGlobSyntax(p)) && existing.info.permission !== "*" && !ConfigProtection.hasGlobSyntax(existing.info.permission)
      const effectiveIsExact = isExact
      const literalProtAlways = ceilingLiterals(canonicalTargetsAlways, existing.info.permission, ws2)
      if (!existing.saved && isProtForR18) {
        if (literalProtAlways.length > 0) {
          // Protected (ceiling b/c): persist only canonical exact literal identities; mixed literal+glob stores literals, glob-only stores nothing
          const agentForProt2 = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
          const canonSet = [...literalProtAlways].sort()
          const exists = r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForProt2 && a.permission === existing.info.permission && a.patterns.length === canonSet.length && a.patterns.slice().sort().every((v, i) => v === canonSet[i]))
          if (!exists) r18.approvals.push({ kind: "session", patterns: canonSet, sessionID: String(existing.info.sessionID), agent: agentForProt2, permission: existing.info.permission })
        }
      } else if (!existing.saved && effectiveIsExact) {
            const skillForAlways = ConfigProtection.globalSkillPattern(existing.info)
            // Lexical wildcard and full glob rejection independent of filesystem existence — all approvals must be exact
            const hasLexicalWildcardForAlways =
              [...existing.info.patterns, ...(existing.info.always ?? [])].some((p: string) =>
                ConfigProtection.isLexicalSkillWildcard(p),
              )
            const hasGlobForAlways = ConfigProtection.hasGlobSyntax(existing.info.permission) || [...existing.info.patterns, ...(existing.info.always ?? [])].some((p: string) => ConfigProtection.hasGlobSyntax(p))
            if ((skillForAlways && ConfigProtection.hasGlobSyntax(skillForAlways)) || hasLexicalWildcardForAlways || hasGlobForAlways) {
              // Reject any glob syntax for approval identities — exact only
            } else {
              // Ordinary: session-bound exact approval only — explicitly selected/validated patterns, no cross-session widening
              const validAlways = new Set(existing.info.always ?? [])
              const selected: string[] = []
              for (const pat of existing.info.patterns) {
                if (!validAlways.has(pat)) continue
                if (ConfigProtection.isLexicalSkillWildcard(pat)) continue
                if (ConfigProtection.hasGlobSyntax(pat) || ConfigProtection.hasGlobSyntax(existing.info.permission)) continue
                selected.push(pat)
              }
              for (const pat of existing.info.always ?? []) {
                if (!validAlways.has(pat)) continue
                if (ConfigProtection.isLexicalSkillWildcard(pat)) continue
                if (ConfigProtection.hasGlobSyntax(pat) || ConfigProtection.hasGlobSyntax(existing.info.permission)) continue
                if (!existing.info.patterns.includes(pat)) selected.push(pat)
              }
              const canonSelected = [...new Set(selected.map((p: string) => Evaluator.canonicalForPermission(p, existing.info.permission, ws2)).filter((c: string) => !ConfigProtection.hasGlobSyntax(c)))].sort()
              if (canonSelected.length > 0) {
                const agentForOrdinary = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
                const existsOrd = r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForOrdinary && a.permission === existing.info.permission && a.patterns.length === canonSelected.length && a.patterns.slice().sort().every((v, i) => v === canonSelected[i]))
                if (!existsOrd) r18.approvals.push({ kind: "session", patterns: canonSelected, sessionID: String(existing.info.sessionID), agent: agentForOrdinary, permission: existing.info.permission })
              }
            }
        } else if (!existing.saved && !effectiveIsExact && !isProtForR18) {
          const skillBroad = ConfigProtection.globalSkillPattern(existing.info)
          const hasLexicalWildcardBroad = [...existing.info.patterns, ...(existing.info.always ?? [])].some((p: string) =>
            ConfigProtection.isLexicalSkillWildcard(p),
          )
          const hasGlobBroad = ConfigProtection.hasGlobSyntax(existing.info.permission) || [...existing.info.patterns, ...(existing.info.always ?? [])].some((p: string) => ConfigProtection.hasGlobSyntax(p))
          if ((skillBroad && ConfigProtection.hasGlobSyntax(skillBroad)) || hasLexicalWildcardBroad || hasGlobBroad) {
            // Reject any glob syntax for approval identities — exact only, even in broad path
          } else {
            // For non-exact (broad) patterns on ordinary, still require exact via always — glob rejected, session-bound
            const selectedBroad = (existing.info.always ?? []).filter((pat: string) => !ConfigProtection.isLexicalSkillWildcard(pat) && !ConfigProtection.hasGlobSyntax(pat) && !ConfigProtection.hasGlobSyntax(existing.info.permission))
            const canonBroad = [...new Set(selectedBroad.map((p: string) => Evaluator.canonicalForPermission(p, existing.info.permission, ws2)).filter((c: string) => !ConfigProtection.hasGlobSyntax(c)))].sort()
            if (canonBroad.length > 0) {
              const agentForBroad = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
              const existsBroad = r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForBroad && a.permission === existing.info.permission && a.patterns.length === canonBroad.length && a.patterns.slice().sort().every((v, i) => v === canonBroad[i]))
              if (!existsBroad) r18.approvals.push({ kind: "session", patterns: canonBroad, sessionID: String(existing.info.sessionID), agent: agentForBroad, permission: existing.info.permission })
            }
          }
        }
      existing.saved = true
      // Final provenance for original request — only succeed when evaluator returns allow, else terminalize consistently
      const alwaysOut = yield* computeProvenanceForEntry(existing, st)
      if (alwaysOut.result === "allow") {
        yield* Deferred.succeed(existing.deferred, undefined)
      } else if (alwaysOut.result === "deny") {
        yield* Deferred.fail(existing.deferred, new PermissionV1.RejectedError())
      } else {
        yield* Deferred.fail(existing.deferred, new PermissionV1.RejectedError())
      }
      // drain pending covered by this session approval (same session only via evaluator's sessionID check) — centralized with protected state
      for (const [id, item] of [...pending.entries()]) {
        const { evalReq: evalReq2, layers: layers2, approvals: approvals2, allowEverything: allow2, hardDenyRuleset: hd2, permissionLevel: pl2 } = yield* buildEvaluatorInputForEntry(item, st)
        const raw2 = Evaluator.evaluate({ request: evalReq2, layers: layers2, approvals: approvals2, allowEverything: allow2, hardDenyRuleset: hd2, permissionLevel: pl2 })
        const out2 = withPolicyVersion(raw2, item.policy)
        if (out2.result === "allow") {
          yield* finalizeProvenance(String(item.info.id), out2.provenance)
          pending.delete(id)
          yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "once" })
          yield* Deferred.succeed(item.deferred, undefined)
        } else if (out2.result === "deny") {
          yield* finalizeProvenance(String(item.info.id), out2.provenance)
          pending.delete(id)
          yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    // kilocode_change start
    const saveAlwaysRules = Effect.fn("Permission.saveAlwaysRules")(function* (
      input: z.infer<typeof SaveAlwaysRulesInput>,
    ) {
      const s = yield* InstanceState.get(state)
      const existing = s.pending.get(input.requestID)
      if (!existing) return yield* new NotFoundError({ requestID: input.requestID })

      const ctx2 = yield* InstanceState.context
      const ws2 = ctx2.worktree === "/" ? ctx2.directory : ctx2.worktree
      let approvedRaw = input.approvedAlways ?? []
      let deniedRaw = input.deniedAlways ?? []
      const canonicalTargetsSave = Evaluator.buildCanonicalTargets({ patterns: [...existing.info.patterns], metadata: existing.info.metadata as any, permission: existing.info.permission }, ws2)
      const isProt = canonicalTargetsSave.some(
        (p: string) => Evaluator.isProtectedForCeiling(p, ws2, existing.info.permission) || (existing.info.permission === "read" && isCeilingCEnvFile(p)),
      )
      if (isProt) {
        // Protected (ceiling b): exact same-session/same-agent/exact canonical pattern set, no wildcard, no prefix, no "*"
        const canonicalReq = canonicalTargetsSave
        const agentForProt = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
        const hasStar = approvedRaw.includes("*")
        let didApprove = false
        const literalProt = ceilingLiterals(canonicalTargetsSave, existing.info.permission, ws2)
        if (hasStar) {
          if (literalProt.length === 0) {
            // reject - glob-only or permission-glob: never persist glob syntax; mixed persists only literals below
          } else {
            const sorted = [...literalProt].sort()
            const exists = s.r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForProt && a.permission === existing.info.permission && a.patterns.length === sorted.length && a.patterns.slice().sort().every((v, i) => v === sorted[i]))
            if (!exists) s.r18.approvals.push({ kind: "session", patterns: sorted, sessionID: String(existing.info.sessionID), agent: agentForProt, permission: existing.info.permission })
            didApprove = true
          }
        } else {
          const approvedFiltered: string[] = []
          for (const p of approvedRaw) {
            if (ConfigProtection.hasGlobSyntax(p)) continue
            const cp = Evaluator.canonicalForPermission(p, existing.info.permission, ws2)
            if (canonicalReq.includes(cp)) approvedFiltered.push(p)
          }
          const filteredCanon = approvedFiltered.map((p: string) => Evaluator.canonicalForPermission(p, existing.info.permission, ws2)).sort()
          if (filteredCanon.length > 0) {
            const subset = filteredCanon
            const exists = s.r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForProt && a.permission === existing.info.permission && a.patterns.length === subset.length && a.patterns.slice().sort().every((v, i) => v === subset[i]))
            if (!exists) s.r18.approvals.push({ kind: "session", patterns: subset, sessionID: String(existing.info.sessionID), agent: agentForProt, permission: existing.info.permission })
            didApprove = true
          }
        }
        const hasDeniedStar = deniedRaw.includes("*")
        const deniedFiltered: string[] = []
        if (hasDeniedStar) {
          if (literalProt.length === 0) {
            // reject - glob-only or permission-glob: never store fallback deny containing glob
          } else {
            for (const cp of literalProt) {
              deniedFiltered.push(cp)
            }
          }
        } else {
          for (const p of deniedRaw) {
            if (ConfigProtection.hasGlobSyntax(p)) continue
            const cp = Evaluator.canonicalForPermission(p, existing.info.permission, ws2)
            if (canonicalReq.includes(cp)) deniedFiltered.push(p)
          }
        }
        if (deniedFiltered.length > 0) {
          const cur: Rule[] = [...(s.session[String(existing.info.sessionID)] ?? [])]
          for (const pat of deniedFiltered) {
            const canonPat = Evaluator.canonicalForPermission(pat, existing.info.permission, ws2)
            if (!cur.some((r) => Evaluator.canonicalForPermission(r.pattern, existing.info.permission, ws2) === canonPat && r.permission === existing.info.permission && r.action === "deny")) cur.push({ permission: existing.info.permission, pattern: pat, action: "deny" })
          }
          s.session[String(existing.info.sessionID)] = cur as Ruleset
        }
        if (!didApprove && deniedFiltered.length === 0) return
      } else {
        // Ordinary: all approvals must be exact — reject any glob syntax including *, ?, [], {}
        const skill = ConfigProtection.globalSkillPattern(existing.info)
        const hasLexicalWildcardOrdinary = [...approvedRaw, ...deniedRaw].some((p: string) => ConfigProtection.isLexicalSkillWildcard(p))
        const hasGlobOrdinary = ConfigProtection.hasGlobSyntax(existing.info.permission) || [...approvedRaw, ...deniedRaw, ...((existing.info.metadata?.rules as string[] | undefined) ?? []), ...existing.info.always].some((p: string) => ConfigProtection.hasGlobSyntax(p))
        if ((skill && ConfigProtection.hasGlobSyntax(skill)) || hasLexicalWildcardOrdinary || hasGlobOrdinary) {
          // Reject any glob syntax for approval identities — exact only; also reject permission glob
          const filteredApprovedRaw = approvedRaw.filter((p: string) => !ConfigProtection.isLexicalSkillWildcard(p) && !ConfigProtection.hasGlobSyntax(p))
          const filteredDeniedRaw = deniedRaw.filter((p: string) => !ConfigProtection.isLexicalSkillWildcard(p) && !ConfigProtection.hasGlobSyntax(p))
          if (ConfigProtection.hasGlobSyntax(existing.info.permission)) return
          if (filteredApprovedRaw.length === 0 && filteredDeniedRaw.length === 0) return
          if (skill && ConfigProtection.hasGlobSyntax(skill)) return
          approvedRaw = filteredApprovedRaw
          deniedRaw = filteredDeniedRaw
          if (approvedRaw.length === 0 && deniedRaw.length === 0) return
        }
        const validRules = new Set(
          skill ? [skill] : [...((existing.info.metadata?.rules as string[] | undefined) ?? []), ...existing.info.always],
        )
        const approvedSet = new Set(approvedRaw.filter((p: string) => !ConfigProtection.hasGlobSyntax(p) && !ConfigProtection.hasGlobSyntax(existing.info.permission)))
        const deniedSet = new Set(deniedRaw.filter((p: string) => !ConfigProtection.hasGlobSyntax(p) && !ConfigProtection.hasGlobSyntax(existing.info.permission)))
        // Ordinary saveAlwaysRules: session-bound only — allows become r18 kind:session approvals,
        // denies become session-restriction rules for the current sessionID. Never touches global st.approved.
        const allowSelected: string[] = []
        const denySelected: string[] = []
        for (const pattern of validRules) {
          if (ConfigProtection.hasGlobSyntax(pattern) || ConfigProtection.hasGlobSyntax(existing.info.permission)) continue
          if (skill && ConfigProtection.hasGlobSyntax(pattern)) continue
          if (approvedSet.has(pattern)) allowSelected.push(pattern)
          if (deniedSet.has(pattern)) denySelected.push(pattern)
        }
        if (allowSelected.length === 0 && denySelected.length === 0) return
        const agentForSave = existing.trustedAgent ?? resolveTrustedAgent(existing.info as any) ?? "unknown"
        if (allowSelected.length > 0) {
          const canonAllow = [...new Set(allowSelected.map((p: string) => Evaluator.canonicalForPermission(p, existing.info.permission, ws2)).filter((c: string) => !ConfigProtection.hasGlobSyntax(c)))].sort()
          if (canonAllow.length > 0) {
            const existsSave = s.r18.approvals.some((a) => a.kind === "session" && a.sessionID === String(existing.info.sessionID) && a.agent === agentForSave && a.permission === existing.info.permission && a.patterns.length === canonAllow.length && a.patterns.slice().sort().every((v, i) => v === canonAllow[i]))
            if (!existsSave) s.r18.approvals.push({ kind: "session", patterns: canonAllow, sessionID: String(existing.info.sessionID), agent: agentForSave, permission: existing.info.permission })
          }
        }
        if (denySelected.length > 0) {
          const cur: Rule[] = [...(s.session[String(existing.info.sessionID)] ?? [])]
          for (const pat of denySelected) {
            const canonPat = Evaluator.canonicalForPermission(pat, existing.info.permission, ws2)
            if (!cur.some((r) => Evaluator.canonicalForPermission(r.pattern, existing.info.permission, ws2) === canonPat && r.permission === existing.info.permission && r.action === "deny")) cur.push({ permission: existing.info.permission, pattern: pat, action: "deny" })
          }
          s.session[String(existing.info.sessionID)] = cur as Ruleset
        }
      }
      existing.saved = true
      // Drain other pending via evaluator — centralized with protected state
      for (const [id, item] of [...s.pending.entries()]) {
        if (String(item.info.id) === String(input.requestID)) continue
        const { evalReq: evalReq2, layers: layers2, approvals: approvals2, allowEverything: allow2, hardDenyRuleset: hd2, permissionLevel: pl2 } = yield* buildEvaluatorInputForEntry(item, s)
        const rawSave = Evaluator.evaluate({ request: evalReq2, layers: layers2, approvals: approvals2, allowEverything: allow2, hardDenyRuleset: hd2, permissionLevel: pl2 })
        const out2 = withPolicyVersion(rawSave, item.policy)
        if (out2.result === "allow") {
          yield* finalizeProvenance(String(item.info.id), out2.provenance)
          s.pending.delete(id)
          yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "once" })
          yield* Deferred.succeed(item.deferred, undefined)
        } else if (out2.result === "deny") {
          yield* finalizeProvenance(String(item.info.id), out2.provenance)
          s.pending.delete(id)
          yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
      }
    })

    const allowEverything = Effect.fn("Permission.allowEverything")(function* (
      input: z.infer<typeof AllowEverythingInput>,
    ) {
      const s = yield* InstanceState.get(state)

      if (!input.enable) {
        if (input.sessionID) {
          const cur = s.session[input.sessionID] ?? []
          const filtered = cur.filter((r) => !(r.permission === "*" && r.pattern === "*" && r.action === "allow"))
          if (filtered.length === 0) delete s.session[input.sessionID]
          else s.session[input.sessionID] = filtered as Ruleset
          return
        }
        s.approved = s.approved.filter((r) => !(r.permission === "*" && r.pattern === "*" && r.action === "allow")) as typeof s.approved
        return
      }

      const rule = { permission: "*", pattern: "*", action: "allow" } as const
      if (input.sessionID) {
        const cur = s.session[input.sessionID] ?? []
        const has = cur.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        if (!has) s.session[input.sessionID] = [...cur, rule] as Ruleset
      } else {
        const has = s.approved.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
        if (!has) s.approved.push(rule)
      }

      const evalOne = (entry: PendingEntry): Effect.Effect<boolean> => Effect.gen(function* () {
        const { evalReq, layers: layersAE, approvals, allowEverything: allowEv, hardDenyRuleset, permissionLevel } = yield* buildEvaluatorInputForEntry(entry, s)
        const rawAE = Evaluator.evaluate({ request: evalReq, layers: layersAE, approvals, allowEverything: allowEv, hardDenyRuleset, permissionLevel })
        const outAE = withPolicyVersion(rawAE, entry.policy)
        if (outAE.result === "allow") yield* finalizeProvenance(String(entry.info.id), outAE.provenance)
        else if (outAE.result === "deny") {
          yield* finalizeProvenance(String(entry.info.id), outAE.provenance)
          // keep provenance terminal but ensure state/provenance agree — remove pending and fail consistently when drain denies
          const idxAE = [...s.pending.entries()].find(([k, v]) => String(v.info.id) === String(entry.info.id))
          if (idxAE) s.pending.delete(idxAE[0])
          else s.pending.delete(entry.info.id as any)
          yield* events.publish(Event.Replied, { sessionID: entry.info.sessionID, requestID: entry.info.id, reply: "reject" }).pipe(Effect.catch(() => Effect.void))
          yield* Deferred.fail(entry.deferred, new PermissionV1.RejectedError()).pipe(Effect.catch(() => Effect.void))
        }
        return outAE.result === "allow"
      })

      if (input.requestID) {
        const entry = s.pending.get(input.requestID)
        if (entry && (!input.sessionID || entry.info.sessionID === input.sessionID)) {
          const ok = yield* evalOne(entry)
          if (ok) {
            // idempotent: only delete/succeed once; evalOne for allow only finalized provenance
            if (s.pending.has(input.requestID)) {
              s.pending.delete(input.requestID)
              yield* events.publish(Event.Replied, {
                sessionID: entry.info.sessionID,
                requestID: entry.info.id,
                reply: "once",
              })
              yield* Deferred.succeed(entry.deferred, undefined).pipe(Effect.catch(() => Effect.void))
            }
          }
        }
      }

      for (const [id, entry] of [...s.pending]) {
        if (input.requestID && String(id) === String(input.requestID)) continue
        if (input.sessionID && entry.info.sessionID !== input.sessionID) continue
        if (!s.pending.has(id)) continue
        const ok = yield* evalOne(entry)
        if (ok) {
          if (!s.pending.has(id)) continue
          s.pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: entry.info.sessionID,
            requestID: entry.info.id,
            reply: "once",
          }).pipe(Effect.catch(() => Effect.void))
          yield* Deferred.succeed(entry.deferred, undefined).pipe(Effect.catch(() => Effect.void))
        } else {
          // check if it was a hard deny (provenance terminal deny) — then fail and remove to keep state/provenance consistent
          const prov = yield* InstanceState.get(state).pipe(Effect.map((st) => st.provenance.get(String(entry.info.id))))
          if (prov?.decisive.result === "deny") {
            if (!s.pending.has(id)) continue
            s.pending.delete(id)
            yield* events.publish(Event.Replied, {
              sessionID: entry.info.sessionID,
              requestID: entry.info.id,
              reply: "reject",
            }).pipe(Effect.catch(() => Effect.void))
            yield* Deferred.fail(entry.deferred, new PermissionV1.RejectedError()).pipe(Effect.catch(() => Effect.void))
          }
        }
      }
    })

    const pending = Effect.fn("Permission.pending")(function* (id: string) {
      const s = yield* InstanceState.get(state)
      return s.pending.get(PermissionV1.ID.make(id))?.info
    })

    const provenance = Effect.fn("Permission.provenance")(function* (id: string) {
      const s = yield* InstanceState.get(state)
      return s.provenance.get(id) ?? s.pending.get(PermissionV1.ID.make(id))?.provenance
    })

    const diagnostics = Effect.fn("Permission.diagnostics")(function* (id: string) {
      const s = yield* InstanceState.get(state)
      return s.provenance.get(id) ?? s.pending.get(PermissionV1.ID.make(id))?.provenance
    })
    const debugState = Effect.fn("Permission.debugState")(function* () {
      const s = yield* InstanceState.get(state)
      const policy = yield* config.getPolicySnapshot().pipe(Effect.catch(() => Effect.succeed(undefined as unknown as Config.PolicySnapshot)))
      return {
        approvals: [...s.r18.approvals],
        approved: [...s.approved],
        session: { ...s.session },
        ...(policy?.version !== undefined ? { policyVersion: policy.version } : {}),
      }
    })
    const __testSetSessionRules = Effect.fn("Permission.__testSetSessionRules")(function* (sessionID: string, ruleset: Ruleset) {
      const s = yield* InstanceState.get(state)
      if (ruleset.length === 0) delete s.session[sessionID]
      else s.session[sessionID] = [...ruleset] as Ruleset
    })
    const __testSetAgentRules = Effect.fn("Permission.__testSetAgentRules")(function* (agent: string, ruleset: Ruleset) {
      if (ruleset.length === 0) testAgentOverrides.delete(agent)
      else testAgentOverrides.set(agent, [...ruleset] as Ruleset)
    })
    // kilocode_change end

    return Service.of({ ask, reply, list, saveAlwaysRules, allowEverything, pending, provenance, diagnostics, debugState, evaluateForDebug, __testSetSessionRules, __testSetAgentRules } as any) // kilocode_change
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    if (value === null) continue // kilocode_change — null is a delete sentinel
    ruleset.push(
      // kilocode_change start — filter out null entries (delete sentinels)
      ...Object.entries(value)
        .filter(([, action]) => action !== null)
        .map(([pattern, action]) => ({
          permission: key,
          pattern: expand(pattern),
          action: action as Action,
        })),
      // kilocode_change end
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

// kilocode_change start - Kilo permission persistence and headless ancestry dependencies
export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
// kilocode_change end

// kilocode_change start — inverse of fromConfig: convert rules back to config format
const SCALAR_ONLY_PERMISSIONS = new Set(["todowrite", "todoread", "question", "question_tool", "webfetch", "websearch", "doom_loop"])

export function toConfig(rules: Ruleset): ConfigPermissionV1.Info {
  const result: ConfigPermissionV1.Info = {}
  for (const rule of rules) {
    const existing = result[rule.permission]

    if (SCALAR_ONLY_PERMISSIONS.has(rule.permission)) {
      if (rule.pattern === "*") result[rule.permission] = rule.action
      continue
    }

    if (existing === undefined || existing === null) {
      result[rule.permission] = { [rule.pattern]: rule.action }
      continue
    }
    if (typeof existing === "string") {
      result[rule.permission] = { "*": existing, [rule.pattern]: rule.action }
      continue
    }
    result[rule.permission] = { ...existing, [rule.pattern]: rule.action }
  }
  return result
}
// kilocode_change end

export * as Permission from "."
