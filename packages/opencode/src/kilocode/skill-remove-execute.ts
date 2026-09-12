import { Effect } from "effect"
import { Skill } from "@/skill"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import * as Target from "@/kilocode/skill-remove"
import { withColdMutation, type ColdScope } from "@/kilocode/server/config-convergence"

export type SkillRemoveInstance = Pick<InstanceContext, "directory" | "worktree">

export const execute = Effect.fn("SkillRemove.execute")(function* (input: {
  location: string
  instance: SkillRemoveInstance
}) {
  const skills = yield* Skill.Service
  const entries = yield* skills.all()
  const file = yield* Effect.try({
    try: () => Target.target(input.location, entries),
    catch: (err) => err,
  })
  const scope: ColdScope = containsPath(file, input.instance as InstanceContext)
    ? { directory: input.instance.directory }
    : "global"
  return yield* withColdMutation({
    scope,
    run: () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => Target.remove(input.location, entries),
          catch: (err) => err,
        })
        return { changed: true as const, value: true as const }
      }),
  })
})

const BUILTIN_MSG = "cannot remove built-in skill"
const URL_MSG = "remove URL-backed skills from configuration"
const MISSING_MSG = "skill not found in registry"

export function codeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes(BUILTIN_MSG)) return "skill.builtin"
  if (msg.includes(URL_MSG)) return "skill.url"
  if (msg.includes(MISSING_MSG)) return "skill.not_found"
  return "validation.failed"
}

export function messageOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes(BUILTIN_MSG)) return BUILTIN_MSG
  if (msg.includes(URL_MSG)) return URL_MSG
  if (msg.includes(MISSING_MSG)) return MISSING_MSG
  return "invalid skill-remove request"
}
