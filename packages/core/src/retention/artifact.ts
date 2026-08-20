import { Schema } from "effect"

export const FamilyArtifactKind = ["session_diff", "session_diff_base", "session_share"] as const
export type FamilyArtifactKind = (typeof FamilyArtifactKind)[number]

export const ProjectArtifactKind = ["snapshot"] as const
export type ProjectArtifactKind = (typeof ProjectArtifactKind)[number]

export const LegacyKind = ["session-export.db"] as const

type Owner = "family" | "project" | "legacy"
type Retention = "family" | "project" | "cutover"

interface Entry {
  readonly kind: FamilyArtifactKind | ProjectArtifactKind | (typeof LegacyKind)[number]
  readonly owner: Owner
  readonly retention: Retention
  readonly prefix: string[]
  readonly note: string
}

const registry: Record<string, Entry> = {
  session_diff: {
    kind: "session_diff",
    owner: "family",
    retention: "family",
    prefix: ["session_diff"],
    note: "session-family-owned file artifact, retained/deleted with family",
  },
  session_diff_base: {
    kind: "session_diff_base",
    owner: "family",
    retention: "family",
    prefix: ["session_diff_base"],
    note: "session-family-owned file artifact, retained/deleted with family",
  },
  session_share: {
    kind: "session_share",
    owner: "family",
    retention: "family",
    prefix: ["session_share"],
    note: "session-family-owned file artifact, retained/deleted with family",
  },
  snapshot: {
    kind: "snapshot",
    owner: "project",
    retention: "project",
    prefix: ["snapshot"],
    note: "project-owned, collected only by project reachability/refcount, never family pruning",
  },
  "session-export.db": {
    kind: "session-export.db",
    owner: "legacy",
    retention: "cutover",
    prefix: ["session-export.db"],
    note: "legacy R17 material, not canonical artifact",
  },
}

export function get(kind: string): Entry | undefined {
  return registry[kind]
}

export function familyKinds(): readonly FamilyArtifactKind[] {
  return FamilyArtifactKind
}

export function isFamilyKind(kind: string): boolean {
  return (FamilyArtifactKind as readonly string[]).includes(kind)
}

export function familyPrefix(kind: FamilyArtifactKind): string[] {
  const entry = registry[kind]
  return entry ? [...entry.prefix] : [kind]
}

export function familyArtifactsForSession(sessionID: string): string[][] {
  return FamilyArtifactKind.map((kind) => [...registry[kind]!.prefix, sessionID])
}

export function familyArtifactsForFamily(sessionIDs: string[]): string[][] {
  const out: string[][] = []
  for (const id of sessionIDs) out.push(...familyArtifactsForSession(id))
  return out
}

export class UnregisteredArtifactError extends Schema.TaggedErrorClass<UnregisteredArtifactError>()(
  "UnregisteredArtifactError",
  {
    prefix: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export function assertFamilyWrite(prefix: string[]): void {
  if (prefix.length === 0)
    throw new UnregisteredArtifactError({
      prefix,
      message: `Unregistered artifact write blocked: (empty) — registry entry required`,
    })
  const root = prefix[0]!
  if (isFamilyKind(root)) return
  if (registry[root]) return
  throw new UnregisteredArtifactError({
    prefix,
    message: `Unregistered session-owned artifact write blocked: ${prefix.join("/")} — registry entry required`,
  })
}

export function assertFamilyWriteEffect(prefix: string[]) {
  if (prefix.length === 0)
    return new UnregisteredArtifactError({
      prefix,
      message: `Unregistered artifact write blocked: (empty) — registry entry required`,
    })
  const root = prefix[0]!
  if (isFamilyKind(root)) return { _tag: "ok" as const }
  if (registry[root]) return { _tag: "ok" as const }
  return new UnregisteredArtifactError({
    prefix,
    message: `Unregistered session-owned artifact write blocked: ${prefix.join("/")} — registry entry required`,
  })
}

export function listRegisteredFamilyKinds(): string[] {
  return [...FamilyArtifactKind]
}

export const entries = registry
