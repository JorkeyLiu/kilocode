/**
 * Write-intent intake classification for config/settings/provider/auth save
 * routes (LOCK-001/005/006).
 *
 * The instance-context middleware must never give these routes ordinary reader
 * admission during an active convergence fence: their handlers register their
 * own fence right after the load, and a held reader lease would either
 * self-deadlock or block the save behind the active fence, while the middleware
 * load must never boot an unseen directory from pre-rebuild config. Admission
 * uses `gate.prepareWrite` instead, which never waits on a convergence fence
 * (LOCK-006).
 *
 * Recognised exact declared route shapes:
 *
 *   PATCH (config saves):
 *     /config                         legacy config update
 *     /config/overlay                 config-console overlay update
 *     /config/transaction             combined global+project save
 *     /tui/config                     TUI config update
 *     /config/model-state             config-console model-state (favorites/recents) save
 *
 *   PUT (config saves):
 *     /config/rules                   config-console project rules (AGENTS.md) save
 *     /agent-builder/:id              agent-builder agent markdown save (LOCK-005)
 *
 *   POST (settings/provider/auth saves):
 *     /custom-provider/:providerID/save
 *     /custom-provider/:providerID/delete
  *     /kilocode/agent/remove          custom agent removal (LOCK-005)
 *     /kilo/organization              Kilo Gateway organization switch
 *     /kilocode/anaconda-desktop/sync Anaconda Desktop provider sync
 *     /provider/:providerID/oauth/callback
 *     /permission/:requestID/always-rules   hot permission always-rules save (LOCK-002)
 *     /permission/allow-everything          hot allow-everything permission save (LOCK-002)
 *     /mcp/:name/auth                MCP OAuth flow start (LOCK-007)
 *     /mcp/:name/auth/callback       MCP OAuth flow completion (LOCK-007)
 *     /mcp/:name/auth/authenticate   MCP OAuth flow authenticate (LOCK-007)
 *
 *   DELETE (auth saves):
 *     /mcp/:name/auth                MCP OAuth credential removal (LOCK-007)
 *
 * The MCP auth routes (LOCK-007) persist machine-global auth storage and run
 * pending OAuth flows — full handler lifetime must be covered by the
 * middleware write lease and convergence seal/drain, so they take write-intent
 * admission and never wait on a cold convergence fence. The dynamic `name`
 * segment is validated against the same `Schema.String` schema the routes
 * declare (fail-closed on any non-string segment).
 *
 * Matching is exact segment matching on the raw path, fail-closed on malformed
 * shapes: a near-match, trailing/empty segment, traversal shape, or duplicate
 * leading slash can never widen into a classified route, and encoded static
 * segments never match their decoded literals. The permission always-rules,
 * custom-provider, and agent-builder save variable segments are additionally
 * validated against the same `PermissionV1.ID` / `ProviderV2.ID` /
 * `AgentBuilderID` schemas the routes declare (the agent-builder id is first
 * safe percent-decoded exactly like the router), so a reserved static sibling
 * (`allow-everything`, `reply`, the preview route) or encoded/traversal shape
 * can never be misclassified as a write-intent.
 */
import { Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AgentBuilderID } from "@/kilocode/server/httpapi/groups/agent-builder-id"

/**
 * Safe percent-decode of a single raw path segment (LOCK-005). Returns the
 * decoded string only when every escape is well-formed and no encoded
 * separator can hide in the segment; `undefined` (fail-closed) on a malformed
 * escape (`%` not followed by exactly two hex digits), an invalid UTF-8
 * sequence, or an encoded `/` (`%2F`) / `\` (`%5C`). Ordinary ID characters
 * that are legal to percent-encode (`%2D` `-`, `%5F` `_`, `%2E` `.`) decode
 * normally; the caller validates the result against the route schema.
 */
function decodeSegment(raw: string): string | undefined {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") continue
    const hex = raw.slice(i + 1, i + 3)
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined
    const byte = Number.parseInt(hex, 16)
    if (byte === 0x2f || byte === 0x5c) return undefined
    i += 2
  }
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

export function isConfigWrite(method: string, path: string): boolean {
  if (method === "PATCH") {
    return (
      path === "/config" ||
      path === "/config/overlay" ||
      path === "/config/transaction" ||
      path === "/tui/config" ||
      path === "/config/model-state"
    )
  }
  if (method === "PUT") {
    if (path === "/config/rules") return true
    // LOCK-005: agent-builder save — PUT /agent-builder/:id. The dynamic ID
    // segment is safe percent-decoded exactly like the router and validated
    // against the same AgentBuilderID schema the route declares: a valid
    // percent-encoded ordinary ID character (`%2D`, `%5F`, `%2E`) is accepted,
    // while an encoded `/` or `\`, dot-segment traversal, malformed escape, or
    // an over-long/undersized id fails the schema and stays on reader admission.
    const segs = path.slice(1).split("/")
    if (segs.length !== 2 || segs[0] !== "agent-builder") return false
    const id = decodeSegment(segs[1])
    return id !== undefined && Schema.is(AgentBuilderID)(id)
  }
  if (method === "DELETE") {
    // LOCK-007: MCP auth credential removal (DELETE /mcp/:name/auth) is an
    // auth write; it takes write-intent admission like the config PATCHes.
    if (!path.startsWith("/") || path.startsWith("//") || path === "/") return false
    const segs = path.slice(1).split("/")
    if (segs.some((seg) => seg.length === 0 || seg === "." || seg === "..")) return false
    return segs.length === 3 && segs[0] === "mcp" && segs[2] === "auth" && Schema.is(Schema.String)(segs[1])
  }
  if (method !== "POST") return false
  if (!path.startsWith("/") || path.startsWith("//") || path === "/") return false
  const segs = path.slice(1).split("/")
  if (segs.some((seg) => seg.length === 0 || seg === "." || seg === "..")) return false
  if (segs.length === 2 && segs[0] === "kilo" && segs[1] === "organization") return true
  if (segs.length === 3 && segs[0] === "kilocode" && segs[1] === "anaconda-desktop" && segs[2] === "sync") return true
  // LOCK-001: custom-provider save/delete — POST /custom-provider/:providerID/save
  // and /custom-provider/:providerID/delete. The providerID segment is validated
  // against the same `ProviderV2.ID` schema the routes declare, and the
  // empty/`.`/`..` guard above keeps encoded/traversal shapes fail-closed.
  if (segs.length === 3 && segs[0] === "custom-provider" && (segs[2] === "save" || segs[2] === "delete")) {
    return Schema.is(ProviderV2.ID)(segs[1])
  }
  // LOCK-005: agent removal route. Its handler registers its own convergence
  // fence right after the load (via withColdMutation), so it takes write-intent
  // admission like the config PATCHes — a held reader lease would either
  // self-deadlock or block the removal behind an active fence. Skill removal is
  // private-only over the `skill/remove` FD op and has no HTTP route.
  if (segs.length === 3 && segs[0] === "kilocode" && segs[1] === "agent" && segs[2] === "remove") {
    return true
  }
  if (segs.length === 4 && segs[0] === "provider" && segs[2] === "oauth") {
    return segs[3] === "callback"
  }
  // LOCK-002: permission settings writes are hot; they must never wait on a
  // cold convergence fence, so they take write-intent admission like the
  // config PATCHes.
  if (segs[0] === "permission" && segs.length === 2) {
    return segs[1] === "allow-everything"
  }
  if (segs[0] === "permission" && segs.length === 3) {
    return segs[2] === "always-rules" && Schema.is(PermissionV1.ID)(segs[1])
  }
  // LOCK-007: MCP auth persistence routes are hot write-intent — the start /
  // callback / authenticate handlers write machine-global auth storage and run
  // pending OAuth flows whose full lifetime must be covered by the middleware
  // write lease, so they never wait on a cold convergence fence. The `name`
  // segment is validated against the same `Schema.String` schema the routes
  // declare (fail-closed on any non-string segment). `connect` / `disconnect`
  // and the `add` route are runtime-state mutations, not auth writes, and stay
  // on reader admission.
  if (segs[0] === "mcp" && segs.length === 3 && segs[2] === "auth") {
    return Schema.is(Schema.String)(segs[1])
  }
  if (segs[0] === "mcp" && segs.length === 4 && segs[2] === "auth") {
    return (segs[3] === "callback" || segs[3] === "authenticate") && Schema.is(Schema.String)(segs[1])
  }
  return false
}
