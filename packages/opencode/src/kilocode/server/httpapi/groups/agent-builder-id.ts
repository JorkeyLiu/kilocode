import { Schema } from "effect"

/**
 * Agent-builder ID path-parameter schema (LOCK-005). Shared by the
 * agent-builder route group and the write-intent classifier, which validates
 * the dynamic `/agent-builder/:id` segment against the exact schema the route
 * declares — a malformed/traversal/encoded sibling segment can never widen
 * into the classified save route. The group re-exports this under the same
 * name so the handlers and OpenAPI surface are unchanged.
 */
export const AgentBuilderID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
)
