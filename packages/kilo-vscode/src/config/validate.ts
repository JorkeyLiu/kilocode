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

// ── Field schema map ─────────────────────────────────────────────────

const fieldSchemas: Record<CanonicalField, z.ZodTypeAny> = {
  "$schema": schemaMetaSchema,
  model: modelSchema,
  model_variant: variantSchema,
  model_variant_overrides: variantOverridesSchema,
  subagent_model: modelSchema,
  subagent_variant: variantSchema,
  subagent_variant_overrides: variantOverridesSchema,
  default_agent: defaultAgentSchema,
  provider: z.record(z.string(), providerConfigSchema),
  mcp: mcpConfigSchema,
  permission: permissionSchema,
  instructions: instructionsSchema,
}

// ── Markdown asset frontmatter schemas ───────────────────────────────

/** Agent frontmatter: prompt, model/variant defaults, tool availability, permission narrowing, requirements */
const agentFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    model: modelSchema.optional(),
    variant: z.string().optional(),
    prompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    permission: z.record(z.unknown()).optional(),
    requirements: z.union([z.array(z.string()), z.record(z.unknown())]).optional(),
    hidden: z.boolean().optional(),
    disable: z.boolean().optional(),
    color: z.string().optional(),
    maxSteps: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    steps: z.number().int().positive().optional(),
    mode: z.enum(["primary", "secondary", "specialized"]).optional(),
  })
  .strict()

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

  // Agent-specific: reject credentials in frontmatter
  if (assetType === "agent" && parsed.data.model) {
    const model = parsed.data.model
    if (typeof model === "string") {
      const result = modelSchema.safeParse(model)
      if (!result.success) {
        errors.push({
          path: ["frontmatter", "model"],
          message: `Agent model: ${result.error.issues[0]?.message ?? "invalid format"}`,
          file,
        })
      }
    }
  }

  // F7: Validate credentials in ALL asset frontmatter (recursive)
  checkAssetCredentialPatterns(parsed.data, ["frontmatter"], file, errors)

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
