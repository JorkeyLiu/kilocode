/**
 * P4.1 Canonical config foundation — strict typed validation.
 *
 * Validates JSONC config files and markdown assets against the closed
 * registry with executable Zod schemas for every accepted field class.
 *
 * Enforcement:
 * - Unknown/deprecated key rejection (closed registry)
 * - Scope validation (global vs project)
 * - Plaintext credential rejection (provider + MCP)
 * - Opaque credential reference identity (affects materialization)
 * - Agent/command/skill/tool/plugin/rules markdown frontmatter schemas
 * - Recursive nested object validation for provider and MCP records
 * - Restrictive layer ordering (never widens)
 */

import { z } from "zod"
import type { Scope, ValidationError } from "./types"
import { parseJsonc, readFile, parseMarkdown, validateNoUnknownKeys, validateNoPlaintextCredentials, isOpaqueCredentialRef, isCredentialKey } from "./parse"
import { findAgentCredentialViolations } from "../shared/agent-credentials"
import { getEntry, isKnownKey, CLOSED_JSONC_FIELDS, type CanonicalField } from "./registry"
import { isValidCanonicalProviderEntry, isValidCanonicalMcpEntry, parseOwnedCredentialRef } from "./types"

// ── Executable Zod schemas for JSONC fields ──────────────────────────

/** model/subagent_model: provider/model format string */
const modelSchema = z.string().regex(
  /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.:-]+$/,
  'Must be in "provider/model" format (e.g. "anthropic/claude-sonnet-4-20250514")',
)

/** model_variant / subagent_variant: string identifier */
const variantSchema = z.string().min(1, "Variant must not be empty")

/** model_variant_overrides / subagent_variant_overrides: keyed by provider/model */
const variantOverridesSchema = z.record(z.string(), z.string())

/** default_agent: string asset ID */
const defaultAgentSchema = z.string().min(1, "Default agent must not be empty")

/**
 * Canonical provider config validated by the shared validator from types.ts.
 * Legacy fields (npm, env, options, baseURL, model, apiKey, headers) are rejected.
 * credential must be an exact extension-owned SecretStorage ref.
 */
const providerConfigSchema = z.custom<unknown>((val) => isValidCanonicalProviderEntry(val), {
  message: "Invalid canonical provider entry: must have only name/endpoint/protocol/models/credential with correct types, and credential must be an exact owned SecretStorage ref",
})

/** Single MCP server entry validated by the shared validator from types.ts. */
const mcpServerSchema = z.custom<unknown>((val) => isValidCanonicalMcpEntry(val), {
  message: "Invalid canonical MCP entry: must have only type/command/args/url/enabled with correct types",
})

/** MCP config: closed record of typed server entries — rejects env/environment/headers/OAuth/unknown keys. */
const mcpConfigSchema = z.record(z.string(), mcpServerSchema)

/** instructions: string array or single string */
const instructionsSchema = z.union([z.string(), z.array(z.string())])

/** permission: record (restrictive layers preserved as-is) */
const permissionSchema = z.record(z.unknown())

/** $schema: benign meta-key injected by CLI tooling; any non-empty string */
const schemaMetaSchema = z.string().min(1, "$schema must not be empty")

/** terminal_command_display: VS Code chat presentation for terminal blocks */
const terminalCommandDisplaySchema = z.enum(["expanded", "collapsed"])

/** auto_collapse_reasoning: VS Code chat reasoning auto-collapse */
const autoCollapseReasoningSchema = z.boolean()

// ── Field schema map ─────────────────────────────────────────────────

const fieldSchemas: Record<CanonicalField, z.ZodTypeAny> = {
  "$schema": schemaMetaSchema,
  model: modelSchema,
  model_variant: variantSchema,
  model_variant_overrides: variantOverridesSchema,
  subagent_model: modelSchema,
  subagent_variant: variantSchema,
  subagent_variant_overrides: variantOverridesSchema,
  fallback_model: modelSchema,
  default_agent: defaultAgentSchema,
  provider: z.record(z.string(), providerConfigSchema),
  mcp: mcpConfigSchema,
  permission: permissionSchema,
  instructions: instructionsSchema,
  terminal_command_display: terminalCommandDisplaySchema,
  auto_collapse_reasoning: autoCollapseReasoningSchema,
}

// ── Markdown asset frontmatter schemas ───────────────────────────────

/** Agent frontmatter strictly aligned with CLI ConfigAgentV1
 * (packages/core/src/v1/config/agent.ts — the norm; no guessing):
 * - mode is subagent|primary|all (history secondary/specialized is rejected
 *   by canonical diagnostics; no compat pseudo-mapping is written)
 * - null sentinels only where CLI NullOr allows: model/variant/temperature/
 *   top_p/prompt/description/steps (and permission action values)
 * - model is any CLI string|null (never forced to provider/model here;
 *   the JSONC config model format stays strict separately)
 * - tools is Record<string,boolean>, never string[]
 * - requirements mirrors core Requirements: at least one group, groups
 *   1..20 entries, RequirementName 1..128 chars containing non-whitespace,
 *   RequirementID 1..128 chars matching the core pattern, no duplicates,
 *   vscode_extensions deduped by id
 * - permission mirrors the actual CLI loader behavior (probed against
 *   ConfigParse.schema options): record of rules (action or per-pattern map)
 *   or top-level null; scalar strings are rejected because the CLI decodes
 *   them as Records and fails
 * - color mirrors core Color: #RRGGBB or the fixed literal set
 * - accepts CLI-legal displayName/source/hidden/disable/options/maxSteps
 * - rest semantics mirroring CLI StructWithRest + normalize: unknown
 *   top-level keys are ACCEPTED and preserved verbatim so the CLI can merge
 *   them into `options` on load. `disabled` is NOT a first-class field here
 *   (no boolean switch, no UI) — it passes through as an unknown key and the
 *   CLI folds it into `options`, exactly like any other unknown key.
 */
const agentPermissionActionSchema = z.union([z.enum(["allow", "ask", "deny"]), z.null()])
const agentPermissionRuleSchema = z.union([
  agentPermissionActionSchema,
  z.record(z.string(), agentPermissionActionSchema),
])
// NOTE: scalar permission (e.g. `permission: allow`) is rejected to match the
// actual CLI loader: ConfigAgentV1.Info via ConfigParse.schema decodes a
// scalar string as a Record (indexing its characters) and fails. Top-level
// null is accepted because the CLI decodes it (to {}).
const agentPermissionSchema = z.union([z.null(), z.record(z.string(), agentPermissionRuleSchema)])
const requirementNameSchema = z.string().min(1).max(128).refine((v) => /\S/.test(v), "Must contain a non-whitespace character")
const requirementIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Must match the CLI requirement ID pattern")
const requirementGroupSchema = z.array(requirementNameSchema).min(1).max(20)
const vscodeExtensionsSchema = z
  .array(z.object({ name: requirementNameSchema, id: requirementIdSchema }).strict())
  .min(1)
  .max(20)
const agentRequirementsSchema = z
  .object({
    skills: requirementGroupSchema.optional(),
    mcps: requirementGroupSchema.optional(),
    vscode_extensions: vscodeExtensionsSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.skills && !val.mcps && !val.vscode_extensions) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one requirement group is required" })
      return
    }
    for (const group of ["skills", "mcps"] as const) {
      const seen = new Set<string>()
      for (const [index, value] of (val[group] ?? []).entries()) {
        if (seen.has(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${group} requirement`, path: [group, index] })
        }
        seen.add(value)
      }
    }
    const seen = new Set<string>()
    for (const [index, extension] of (val.vscode_extensions ?? []).entries()) {
      if (seen.has(extension.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate vscode_extensions requirement",
          path: ["vscode_extensions", index, "id"],
        })
      }
      seen.add(extension.id)
    }
  })
const agentColorSchema = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
  z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])
const agentFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    source: z.string().optional(),
    description: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    variant: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    permission: agentPermissionSchema.optional(),
    requirements: agentRequirementsSchema.optional(),
    hidden: z.boolean().optional(),
    disable: z.boolean().optional(),
    color: agentColorSchema.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    maxSteps: z.number().int().positive().optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    steps: z.number().int().positive().nullable().optional(),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
  })
  // Rest semantics, not strict: unknown top-level keys are accepted and kept
  // verbatim for CLI normalize (StructWithRest merges them into `options`).
  // Only the agent schema is rest-open; command/skill/tool/plugin/rules stay
  // strict because their loaders have no rest/options merging.
  .catchall(z.unknown())

/** Command frontmatter: description, agent, model, variant */
const commandFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: modelSchema.optional(),
    variant: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  .strict()

/** Skill/plugin frontmatter: minimal */
const skillPluginFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()

/** Tool frontmatter: tool definition */
const toolFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()

/** Rules frontmatter: minimal */
const rulesFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()

const assetSchemas: Record<string, z.ZodTypeAny> = {
  agent: agentFrontmatterSchema,
  command: commandFrontmatterSchema,
  skill: skillPluginFrontmatterSchema,
  tool: toolFrontmatterSchema,
  plugin: skillPluginFrontmatterSchema,
  rules: rulesFrontmatterSchema,
}

// ── Config validation ────────────────────────────────────────────────

export interface ConfigValidationResult {
  readonly valid: boolean
  readonly errors: readonly ValidationError[]
  readonly parsed: Record<string, unknown> | null
}

/**
 * Validate a JSONC config file against the closed registry with
 * executable Zod schemas. Returns the parsed value if valid, or errors.
 */
export function validateConfig(
  rawText: string,
  scope: Scope,
  file: string,
): ConfigValidationResult {
  const parsed = parseJsonc(rawText)
  if (!parsed.ok) {
    return {
      valid: false,
      errors: [{ path: [], message: `JSONC parse error: ${parsed.error}`, scope, file }],
      parsed: null,
    }
  }

  const errors: ValidationError[] = []

  // 1. Unknown keys (closed registry)
  errors.push(...validateNoUnknownKeys(parsed.value, scope, file))

  // 2. Plaintext credentials (provider + MCP)
  errors.push(...validateNoPlaintextCredentials(parsed.value, scope, file))

  // 3. Strict canonical validation — no legacy normalization.
  errors.push(...validateSchemaFields(parsed.value, scope, file))

  // 4. Provider credential scope context
  errors.push(...validateCredentialScopes(parsed.value.provider, "provider", scope, file))

  // 5. MCP credential scope context
  errors.push(...validateCredentialScopes(parsed.value.mcp, "mcp", scope, file))

  return {
    valid: errors.length === 0,
    errors,
    parsed: errors.length === 0 ? parsed.value : null,
  }
}

/** Validate each known config field against its Zod schema. */
function validateSchemaFields(
  config: Record<string, unknown>,
  scope: Scope,
  file: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  for (const [key, val] of Object.entries(config)) {
    if (!isKnownKey(key)) continue
    const schema = fieldSchemas[key as CanonicalField]
    if (!schema) {
      // Invariant failure: registry key exists but schema is missing.
      // This is a programming error, not a user validation issue.
      errors.push({
        path: [key],
        message: `Programming invariant: registry key "${key}" has no schema definition`,
        scope,
        file,
      })
      continue
    }
    const result = schema.safeParse(val)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          path: [key, ...issue.path.map(String)],
          message: `Field "${key}": ${issue.message}`,
          scope,
          file,
        })
      }
    }
  }
  return errors
}

/** Validate credential refs in a keyed section (provider or MCP) carry the exact owning scope. */
function validateCredentialScopes(
  section: unknown,
  kind: "provider" | "mcp",
  scope: Scope,
  file: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  if (!section || typeof section !== "object" || Array.isArray(section)) return errors
  const label = kind === "provider" ? "Provider" : "MCP"
  for (const [id, entry] of Object.entries(section as Record<string, unknown>)) {
    const credential = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).credential
      : undefined
    if (typeof credential !== "string") continue
    const parsedRef = parseOwnedCredentialRef(credential)
    if (!parsedRef || parsedRef.kind !== kind || parsedRef.id !== id || parsedRef.scope !== scope) {
      errors.push({
        path: [kind, id, "credential"],
        message: `${label} credential ref must be an exact owned ref "secret:kilo.credentials.${scope}.${kind}.${id}"`,
        scope,
        file,
      })
    }
  }
  return errors
}

// Legacy providers are never normalized in canonical validation.
// Legacy shapes (npm, env, options, baseURL, model, apiKey) are rejected
// by the closed provider config schema rather than silently normalized.
// The normalizeLegacyProviders function has been removed — legacy readers
// remain only in noncanonical bridge paths and never feed CanonicalConfigService.

// ── Markdown asset validation ────────────────────────────────────────

export interface AssetValidationResult {
  readonly valid: boolean
  readonly errors: readonly ValidationError[]
  readonly data: Record<string, unknown> | null
  readonly content: string | null
}

type AssetType = "agent" | "command" | "skill" | "tool" | "plugin" | "rules"

/**
 * Validate a markdown asset file against its executable Zod schema.
 * Checks frontmatter structure, credential rejection, and content requirements.
 * Validates credentials in frontmatter (F7).
 * Correction 6: fails closed on any YAML document parse errors.
 */
export function validateMarkdownAsset(
  rawText: string,
  assetType: AssetType,
  file: string,
): AssetValidationResult {
  const parsed = parseMarkdown(rawText)
  const errors: ValidationError[] = []

  // Correction 6: fail closed on any YAML document errors
  if (parsed.errors.length > 0) {
    for (const msg of parsed.errors) {
      errors.push({
        path: ["frontmatter"],
        message: `YAML parse error: ${msg}`,
        file,
      })
    }
    return {
      valid: false,
      errors,
      data: null,
      content: null,
    }
  }

  // Schema-specific validation
  const schema = assetSchemas[assetType]
  if (schema && Object.keys(parsed.data).length > 0) {
    const result = schema.safeParse(parsed.data)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          path: ["frontmatter", ...issue.path.map(String)],
          message: `${assetType} frontmatter: ${issue.message}`,
          file,
        })
      }
    }
  }

  // Command-specific: must have content (template body)
  if (assetType === "command") {
    if (!parsed.content || parsed.content.trim().length === 0) {
      errors.push({
        path: ["content"],
        message: "Command asset must have a non-empty template body",
        file,
      })
    }
  }

  // Agent model format is owned by agentFrontmatterSchema (CLI accepts any
  // string|null there; the provider/model grammar applies only to JSONC
  // config model fields, never to agent frontmatter).

  if (assetType === "agent") {
    // Agent markdown has no credential mechanism: any credential-bearing
    // key with non-empty/non-null content is rejected — plaintext AND
    // SecretStorage refs alike. The provider/MCP `secret:` allowance must
    // never be applied here. Shared rule with webview import/export.
    for (const violation of findAgentCredentialViolations(parsed.data, ["frontmatter"])) {
      errors.push({
        path: [...violation.path],
        message:
          violation.kind === "unsafe-key"
            ? `Unsafe frontmatter key "${violation.key}" is rejected`
            : `Agent credential "${violation.key}" is rejected — agent markdown must not contain credentials`,
        file,
      })
    }
  } else {
    // F7: Validate credentials in ALL other asset frontmatter (recursive)
    checkAssetCredentialPatterns(parsed.data, ["frontmatter"], file, errors)
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? parsed.data : null,
    content: errors.length === 0 ? parsed.content : null,
  }
}

/**
 * Check asset frontmatter for plaintext credential patterns recursively.
 */
function checkAssetCredentialPatterns(
  data: Record<string, unknown>,
  pathPrefix: string[],
  file: string,
  errors: ValidationError[],
): void {
  for (const [key, val] of Object.entries(data)) {
    if (isCredentialKey(key) && typeof val === "string" && val.length > 0 && !isOpaqueCredentialRef(val)) {
      errors.push({
        path: [...pathPrefix, key],
        message: `Plaintext credential "${key}" is rejected — use SecretStorage reference (prefix "secret:")`,
        file,
      })
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      checkAssetCredentialPatterns(val as Record<string, unknown>, [...pathPrefix, key], file, errors)
    }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const el = val[i]
        if (el && typeof el === "object" && !Array.isArray(el)) {
          checkAssetCredentialPatterns(el as Record<string, unknown>, [...pathPrefix, key, String(i)], file, errors)
        }
      }
    }
  }
}

// ── Cross-scope validation ───────────────────────────────────────────

/**
 * Validate that two scoped configs don't have cross-scope conflicts.
 * Returns errors for:
 * - Duplicate IDs in keyed fields that have crossScopeConflict
 * - Explicit values in both scopes for single fields that have crossScopeConflict
 *
 * This is the shared rule used by direct writes, composite writes, and materialization.
 */
export function validateCrossScope(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = []

  // Collect all unique keys from both scopes
  const allKeys = new Set([...Object.keys(global), ...Object.keys(project)])

  for (const key of allKeys) {
    if (!isKnownKey(key)) continue
    const reg = getEntry(key)
    if (!reg || !reg.crossScopeConflict) continue

    if (reg.composition === "single") {
      const gExplicit = key in global
      const pExplicit = key in project
      if (gExplicit && pExplicit) {
        errors.push({
          path: [key],
          message: `Conflicting values for single field "${key}" in global and project scopes`,
          scope: "project",
        })
      }
    }

    if (reg.composition === "keyed") {
      const gVal = global[key]
      const pVal = project[key]
      if (!isRecord(gVal) || !isRecord(pVal)) continue

      for (const id of Object.keys(pVal)) {
        if (id in gVal) {
          errors.push({
            path: [key, id],
            message: `Duplicate keyed ID "${id}" in field "${key}" across global and project scopes`,
            scope: "project",
          })
        }
      }
    }
  }

  return errors
}

// ── Helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// ── Invariant: fieldSchemas key set matches CLOSED_JSONC_FIELDS ──────

const schemaKeys = Object.keys(fieldSchemas).sort()
const closedKeys = [...CLOSED_JSONC_FIELDS].sort()
if (
  schemaKeys.length !== closedKeys.length ||
  schemaKeys.some((k, i) => k !== closedKeys[i])
) {
  throw new Error(
    `Programming invariant: fieldSchemas keys [${schemaKeys.join(", ")}] do not match CLOSED_JSONC_FIELDS [${closedKeys.join(", ")}]`,
  )
}
