// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "@/permission"
import { NamedError } from "@opencode-ai/core/util/error"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Truncate from "../../tool/truncate"
import { Config } from "../../config/config"
import type { Info as AgentInfo } from "../../agent/agent"
import { Schema } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"

const log = Log.create({ service: "kilocode.agent" })

import PROMPT_DEBUG from "../../agent/prompt/debug.txt"
import PROMPT_ORCHESTRATOR from "../../agent/prompt/orchestrator.txt"
import PROMPT_ASK from "../../agent/prompt/ask.txt"
import PROMPT_EXPLORE from "../../agent/prompt/explore.txt"

export const bash: Record<string, "allow" | "ask" | "deny"> = {
  "*": "ask",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "less *": "allow",
  "ls *": "allow",
  "tree *": "allow",
  "pwd *": "allow",
  "echo *": "allow",
  "wc *": "allow",
  "which *": "allow",
  "type *": "allow",
  "file *": "allow",
  "diff *": "allow",
  "du *": "allow",
  "df *": "allow",
  "date *": "allow",
  "uname *": "allow",
  "whoami *": "allow",
  "printenv *": "allow",
  "man *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "ag *": "allow",
  "sort *": "allow",
  "uniq *": "allow",
  "cut *": "allow",
  "tr *": "allow",
  "jq *": "allow",
  "touch *": "allow",
  "mkdir *": "allow",
  "cp *": "allow",
  "mv *": "allow",
  "tsc *": "allow",
  "tsgo *": "allow",
  "tar *": "allow",
  "unzip *": "allow",
  "gzip *": "allow",
  "gunzip *": "allow",
}

export const readOnlyBash: Record<string, "allow" | "ask" | "deny"> = {
  "*": "deny",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "less *": "allow",
  "ls *": "allow",
  "tree *": "allow",
  "pwd *": "allow",
  "echo *": "allow",
  "wc *": "allow",
  "which *": "allow",
  "type *": "allow",
  "file *": "allow",
  "diff *": "allow",
  "du *": "allow",
  "df *": "allow",
  "date *": "allow",
  "uname *": "allow",
  "whoami *": "allow",
  "printenv *": "allow",
  "man *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "ag *": "allow",
  "sort *": "allow",
  "uniq *": "allow",
  "cut *": "allow",
  "tr *": "allow",
  "jq *": "allow",
  "git *": "deny",
  "git log *": "allow",
  "git show *": "allow",
  "git diff *": "allow",
  "git status *": "allow",
  "git blame *": "allow",
  "git rev-parse *": "allow",
  "git rev-list *": "allow",
  "git ls-files *": "allow",
  "git ls-tree *": "allow",
  "git ls-remote *": "allow",
  "git shortlog *": "allow",
  "git describe *": "allow",
  "git cat-file *": "allow",
  "git name-rev *": "allow",
  "git stash list *": "allow",
  "git tag -l *": "allow",
  "git branch --list *": "allow",
  "git branch -a *": "allow",
  "git branch -r *": "allow",
  "git remote -v *": "allow",
  "gh *": "ask",
  // Everything below is a blocklist layered on the allowlist above: it catches ways
  // an "allowed" read-only command can still write files, chain commands, or exec an
  // arbitrary program. This is defense-in-depth, not a sandbox — the durable fix is
  // OS-level sandboxing, not command-line string matching.
  // `*` matches any run of characters (including spaces and empty), so each rule
  // catches its operator anywhere. Broad forms subsume narrow ones: `*&*` covers
  // `&&`, and `*>*` covers `>`, `>>`, `>|`, and `>(` in any spacing.
  "*\n*": "deny",
  "*<(*": "deny",
  "*|*": "deny",
  "*;*": "deny",
  "*&*": "deny",
  "*$(*": "deny",
  "*`*": "deny",
  "*>*": "deny",
  // Short -o is space-anchored (two forms) so it never matches filenames like
  // `foo-o bar`; long flags use `*--flag*`, which is specific enough to bridge both
  // "flag first" and "flag after args" positions in one rule.
  "sort -o *": "deny",
  "sort * -o *": "deny",
  "sort *--output*": "deny",
  // Flags that make otherwise "read-only" commands exec an arbitrary program.
  "sort *--compress-program*": "deny",
  "sort *--files0-from*": "deny",
  "rg *--pre *": "deny",
  "rg *--pre=*": "deny",
  "rg *--hostname-bin*": "deny",
  "ag *--pager*": "deny",
  "man *-P*": "deny",
  "man *--pager*": "deny",
  "man *-H*": "deny",
}

function askGuard(mcp: Record<string, "allow" | "ask" | "deny"> = {}) {
  return Permission.fromConfig({
    "*": "deny",
    bash: readOnlyBash,
    read: {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*.env.example": "allow",
    },
    grep: "allow",
    glob: "allow",
    list: "allow",
    skill: "allow",
    question: "allow",
    webfetch: "allow",
    websearch: "allow",
    codebase_search: "allow",
    external_directory: {
      [Truncate.GLOB]: "allow",
    },
    ...mcp,
  })
}

function denies(user: Permission.Ruleset) {
  return user.filter((rule) => rule.action === "deny")
}

function askEditGuard() {
  return Permission.fromConfig({ edit: "deny" })
}

// Upstream v1.14.33 builds Agent state outside the Instance ALS, so reading
// Instance.worktree here would crash. Thread worktree through from patchAgents
// instead.
function planEditRules(worktree: string) {
  return {
    "*": "deny" as const,
    [path.join(".kilo", "plans", "*.md")]: "allow" as const,
    [path.join("plans", "*.md")]: "allow" as const,
    [path.join(".plans", "*.md")]: "allow" as const,
    [path.relative(worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow" as const,
  }
}

function planEditGuard(worktree: string) {
  return Permission.fromConfig({ edit: planEditRules(worktree) })
}

function planGuard(worktree: string, mcp: Record<string, "allow" | "ask" | "deny"> = {}) {
  return Permission.fromConfig({
    "*": "deny",
    question: "allow",
    skill: "allow",
    plan_exit: "allow",
    bash: readOnlyBash,
    read: {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*.env.example": "allow",
    },
    grep: "allow",
    glob: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    codebase_search: "allow",
    external_directory: {
      [Truncate.GLOB]: "allow",
      [path.join(Global.Path.data, "plans", "*")]: "allow",
    },
    edit: planEditRules(worktree),
    ...mcp,
  })
}

// Generate per-server MCP wildcard rules that allow MCP tools with user approval.
export function getMcpRules(cfg: Config.Info): Record<string, "allow" | "ask" | "deny"> {
  const rules: Record<string, "allow" | "ask" | "deny"> = {}
  for (const key of Object.keys(cfg.mcp ?? {})) {
    const sanitized = key.replace(/[^a-zA-Z0-9_-]/g, "_")
    rules[sanitized + "_*"] = "ask"
  }
  return rules
}

export interface KiloData {
  mcpRules: Record<string, "allow" | "ask" | "deny">
  defaultsPatch: Permission.Ruleset
}

// Prepare kilo-specific data derived from config. Call once per state initialization.
export function prepare(cfg: Config.Info): KiloData {
  const mcpRules = getMcpRules(cfg)
  const defaultsPatch = Permission.fromConfig({
    bash,
    recall: "ask",
    ...(Flag.KILO_CLIENT === "vscode" && cfg.experimental?.native_notebook_tools === true
      ? { notebook_read: "ask" as const, notebook_edit: "ask" as const, notebook_execute: "ask" as const }
      : {}),
  })
  return { mcpRules, defaultsPatch }
}

export function cacheKey(cfg: Config.Info) {
  return JSON.stringify({
    agent: cfg.agent,
    default_agent: cfg.default_agent,
    mcp: cfg.mcp,
    mode: cfg.mode,
    permission: cfg.permission,
    native_notebook_tools: cfg.experimental?.native_notebook_tools,
  })
}

// Map "build" config key to "code" for backward compatibility.
export function resolveKey(name: string): string {
  return name === "build" ? "code" : name
}

// Remap "build" → "code" in agent config entries for backward compat in the config loop.
export function preprocessConfig<T>(agentConfig: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {}
  for (const [key, value] of Object.entries(agentConfig)) {
    result[key === "build" ? "code" : key] = value
  }
  return result
}

// Lift Kilo-internal metadata onto typed agent fields and remove it from `options`.
// Older org modes and marketplace agents stored `displayName`/`source` inside the
// `options` record, which is otherwise forwarded verbatim to the provider as request
// parameters. Promoting then deleting them keeps `options` provider-clean at the source
// (the request boundary still strips as a safety net).
export function processConfigItem(item: {
  options: Record<string, unknown>
  displayName?: string
  source?: string
  deprecated?: boolean
}) {
  if (!item.displayName && typeof item.options?.displayName === "string") {
    item.displayName = item.options.displayName
  }
  if (!item.source && typeof item.options?.source === "string") {
    item.source = item.options.source
  }
  if (item.options) {
    delete item.options.displayName
    delete item.options.source
  }
}

const locked = new Set(["compaction", "title", "summary"])

function hardRules() {
  return Permission.fromConfig({
    "*": "deny",
  })
}

export function harden(item?: { name: string; permission: Permission.Ruleset }) {
  if (!item) return
  if (!locked.has(item.name)) return
  item.permission = hardRules()
}

export function hardenSystemAgents<T extends { name: string; permission: Permission.Ruleset }>(
  agents: Record<string, T>,
) {
  for (const [key, item] of Object.entries(agents)) {
    if (locked.has(key)) {
      item.permission = hardRules()
      continue
    }
    harden(item)
  }
}

// Returns experimental_telemetry config for generate calls.
// AI SDK span recording (ai.* / gen_ai.*) is disabled.
export function telemetryOptions(_cfg: Config.Info) {
  return { isEnabled: false as const }
}

// Patch the base agents map in-place with all kilo-specific changes:
// - Rename build → code
// - Patch plan with readOnlyBash, mcpRules, .kilo paths
// - Patch explore with codebase_search and conditional prompt
// - Add debug, orchestrator, ask agents
export function patchAgents(
  agents: Record<
    string,
    {
      name: string
      displayName?: string
      source?: string
      description?: string
      deprecated?: boolean
      mode: "subagent" | "primary" | "all"
      native?: boolean
      hidden?: boolean
      topP?: number
      temperature?: number
      color?: string
      permission: Permission.Ruleset
      model?: { modelID: string; providerID: string }
      variant?: string
      prompt?: string
      options: Record<string, unknown>
      steps?: number
    }
  >,
  defaults: Permission.Ruleset,
  user: Permission.Ruleset,
  cfg: Config.Info,
  kilo: KiloData,
  worktree: string,
  whitelistedDirs: string[],
) {
  // Rename "build" → "code" for backward compatibility
  if (agents.build) {
    agents.code = {
      ...agents.build,
      name: "code",
      permission: Permission.merge(
        defaults,
        agents.build.permission,
        user,
      ),
    }
    delete agents.build
  }

  // Patch plan mode
  if (agents.plan) {
    agents.plan = {
      ...agents.plan,
      description: "Plan mode. Can only edit plan files; all other filesystem mutations are denied.",
      permission: Permission.merge(
        defaults,
        planGuard(worktree, kilo.mcpRules),
        user,
        planEditGuard(worktree),
        denies(user),
      ),
    }
  }

  // Patch explore with codebase_search and conditional prompt
  if (agents.explore) {
    agents.explore = {
      ...agents.explore,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          "*": "deny",
          grep: "allow",
          glob: "allow",
          list: "allow",
          bash: "allow",
          skill: "allow",
          webfetch: "allow",
          websearch: "allow",
          codebase_search: "allow",
          read: "allow",
          external_directory: {
            // Mirror upstream explore's shape: the outer "*": "deny" above wins
            // over defaults' external_directory rules via findLast, so re-apply
            // the full whitelist (Truncate.GLOB, tmp, skill, config, globalDirs)
            // here. Upstream adds these inline in agent.ts; we do the same from
            // within the patch.
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
        }),
        user,
      ),
      prompt: cfg.experimental?.codebase_search
        ? `Prefer using the codebase_search tool for codebase searches — it performs intelligent multi-step code search and returns the most relevant code spans.\n\n${PROMPT_EXPLORE}`
        : PROMPT_EXPLORE,
    }
  }

  // Add debug agent
  agents.debug = {
    name: "debug",
    description: "Diagnose and fix software issues with systematic debugging methodology.",
    prompt: PROMPT_DEBUG,
    options: {},
    permission: Permission.merge(
      defaults,
      Permission.fromConfig({
        question: "allow",
        plan_enter: "allow",
      }),
      user,
    ),
    mode: "primary",
    native: true,
  }

  // Add orchestrator agent
  agents.orchestrator = {
    name: "orchestrator",
    description: "Coordinate complex tasks by delegating to specialized agents in parallel.",
    prompt: PROMPT_ORCHESTRATOR,
    options: {},
    permission: Permission.merge(
      defaults,
      Permission.fromConfig({
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        list: "allow",
        question: "allow",
        skill: "allow",
        task: "allow",
        todoread: "allow",
        todowrite: "allow",
        webfetch: "allow",
        websearch: "allow",
        codebase_search: "allow",
        external_directory: {
          [Truncate.GLOB]: "allow",
        },
      }),
      user,
      // Enforce bash deny after user so user config cannot re-enable shell
      Permission.fromConfig({
        bash: "deny",
      }),
    ),
    mode: "primary",
    native: true,
    deprecated: true,
  }

  // Add ask agent
  agents.ask = {
    name: "ask",
    description: "Get answers and explanations without making changes to the codebase.",
    prompt: PROMPT_ASK,
    options: {},
    permission: Permission.merge(defaults, askGuard(kilo.mcpRules), user, askEditGuard(), denies(user)),
    mode: "primary",
    native: true,
  }

  hardenSystemAgents(agents)
}

export const RemoveError = NamedError.create("AgentRemoveError", {
  name: Schema.String,
  message: Schema.String,
})

/**
 * Remove a custom agent by deleting its markdown source file and removing it
 * from config-backed agent entries (canonical typed assets only).
 */
export async function remove(input: { name: string; agent?: AgentInfo; dirs: string[]; directory: string; worktree?: string }) {
  if (!input.agent) throw new RemoveError({ name: input.name, message: "agent not found" })
  if (input.agent.native) throw new RemoveError({ name: input.name, message: "cannot remove native agent" })
  // Prevent removal of organization-managed agents
  if (input.agent.source === "organization" || input.agent.options?.source === "organization")
    throw new RemoveError({
      name: input.name,
      message: "cannot remove organization agent — manage it from the cloud dashboard",
    })

  // Canonical markdown asset deletion and JSONC removal are serialized together
  // under the same per-target discovery lock (LOCK-005). The scan+delete of
  // `.kilo/agent|agents` markdown files occurs inside the global/project
  // lock that also guards the kilo.jsonc atomic write, so a concurrent config
  // mutation cannot race the file scan.
  // Residual: multi-file markdown unlink is not a single atomic filesystem
  // transaction — a crash between unlinks can leave a partial set deleted;
  // JSONC persistence itself remains atomic via temp-file+rename.
  void input.dirs
  const found = await removeConfigAgent(input.name, input.directory, input.worktree)

  if (!found) throw new RemoveError({ name: input.name, message: "no agent file found on disk" })
}

async function removeConfigAgent(name: string, directory: string, worktree?: string) {
  const { KilocodeConfigOverlay } = await import("@/kilocode/config/overlay")
  const { KilocodeConfig } = await import("@/kilocode/config/config")
  const globalFile = KilocodeConfigOverlay.globalTarget()
  const projectFile = await KilocodeConfigOverlay.projectTarget({ directory, worktree })
  const files = [globalFile, projectFile]
  let found = false

  for (const file of new Set(files)) {
    const isGlobal = file === globalFile
    const dir = path.dirname(file)
    const key = isGlobal
      ? KilocodeConfig.configDiscoveryGlobalKey()
      : KilocodeConfig.configDiscoveryProjectKey(directory, worktree)
    const { Effect, Layer } = await import("effect")
    const { FSUtil } = await import("@opencode-ai/core/fs-util")
    const { KilocodeAtomicWrite } = await import("@/kilocode/config/atomic-write")
    const { EffectFlock } = await import("@opencode-ai/core/util/effect-flock")
    const did = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const flock = yield* EffectFlock.Service
        const ok = yield* flock
          .withLock(
            Effect.gen(function* () {
              let localFound = false
              // Canonical agent markdown deletion serialized under the same lock as JSONC.
              // Retired `mode`/`modes` assets are never scanned or deleted here (P4.3).
              const patterns = ["{agent,agents}/**/" + name + ".md"]
              for (const pattern of patterns) {
                const matches: string[] = yield* Effect.promise(() =>
                  Glob.scan(pattern, { cwd: dir, absolute: true, dot: true }).catch((err: unknown) => {
                    const code = (err as { code?: string })?.code
                    if (code === "ENOENT") return [] as string[]
                    log.error("failed to scan agent markdown", { pattern, dir, cause: String(err) })
                    throw err
                  }),
                )
                for (const m of matches) {
                  const exists = yield* Effect.promise(() => Bun.file(m).exists())
                  if (!exists) continue
                  yield* Effect.promise(() => import("fs/promises").then(({ unlink }) => unlink(m))).pipe(
                    Effect.tapError((cause) =>
                      Effect.sync(() => log.error("failed to delete agent markdown", { file: m, cause: String(cause) })),
                    ),
                    Effect.orDie,
                  )
                  localFound = true
                }
              }
              const exists = yield* Effect.promise(() => Bun.file(file).exists())
              if (exists) {
                const text = yield* Effect.promise(() => Bun.file(file).text())
                const root = parseJsonc(text)
                if (root?.agent && Object.hasOwn(root.agent, name)) {
                  const opts = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
                  const next = applyEdits(text, modify(text, ["agent", name], undefined, opts))
                  const parsed = parseJsonc(next)
                  const final =
                    parsed.default_agent === name
                      ? applyEdits(next, modify(next, ["default_agent"], undefined, opts))
                      : next
                  yield* KilocodeAtomicWrite.write(fs, file, final)
                  localFound = true
                }
              }
              return localFound
            }),
            key,
          )
          .pipe(
            Effect.catchTag("LockTimeoutError", (error) => Effect.die(error)),
            Effect.catchTag("LockCompromisedError", (error) => Effect.die(error)),
          )
        return ok
      }).pipe(Effect.provide(Layer.merge(EffectFlock.defaultLayer, FSUtil.defaultLayer))),
    )
    if (did) found = true
  }

  return found
}
