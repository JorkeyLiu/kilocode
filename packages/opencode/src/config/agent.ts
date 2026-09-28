export * as ConfigAgent from "./agent"

import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"
import { ConfigVariable } from "./variable" // kilocode_change
// kilocode_change start
import { ConfigErrorV1 as ConfigError, FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { KilocodeConfig } from "@/kilocode/config/config"
import { report } from "@/kilocode/config/report"
import type { Warning } from "./config"
// kilocode_change end

const log = Log.create({ service: "config" })

// kilocode_change start - trusted gates {env:}; fileScope confines untrusted agent prompt {file:} reads
export type PermissionSource = {
  agent: string
  file: string
  present: boolean
  raw: unknown
}

export async function loadWithSources(
  dir: string,
  warnings?: Warning[],
  trusted = false,
  fileScope?: ConfigVariable.FileScope,
  sourceScope?: ConfigVariable.FileScope,
): Promise<{ agents: Record<string, ConfigAgentV1.Info>; sources: PermissionSource[] }> {
  const result: Record<string, ConfigAgentV1.Info> = {}
  const sources: PermissionSource[] = []
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    // kilocode_change start
    const md = await ConfigMarkdown.parse(item, { trusted, fileScope, sourceScope }).catch(async (err) => {
      // kilocode_change end
      const message = FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse agent ${item}`
      // kilocode_change start
      if (warnings) warnings.push({ path: item, message })
      try {
        const { capture } = await import("@/kilocode/instance")
        const ctx = capture()
        if (ctx) await report(ctx, message)
      } catch (error) {
        log.warn("could not publish session error", { message, err: error })
      }
      // kilocode_change end
      log.error("failed to load agent", { agent: item, err })
      return undefined
    })
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])
    const present = Object.prototype.hasOwnProperty.call(md.data ?? {}, "permission")
    const raw = (md.data as Record<string, unknown> | undefined)?.permission

    // kilocode_change start - substitute agent prompt variables relative to the agent file. Project agents are
    // untrusted (no {env:}, {file:} confined to fileScope.root); a rejected substitution must skip only this
    // agent with a warning, not fail the whole config load, mirroring the frontmatter-parse handling above.
    const prompt = await ConfigVariable.substitute({
      text: md.content.trim(),
      type: "virtual",
      dir: path.dirname(item),
      source: item,
      missing: "empty",
      escapeJson: false,
      trusted,
      fileScope,
    }).catch((err): string | undefined => {
      const message =
        (ConfigError.InvalidError.isInstance(err) ? err.data.message : undefined) ??
        `Failed to substitute variables in agent ${item}`
      if (warnings) warnings.push({ path: item, message })
      log.error("failed to substitute agent prompt", { agent: item, err })
      return undefined
    })
    if (prompt === undefined) continue
    const config = {
      name,
      ...md.data,
      prompt,
    }
    // kilocode_change end
    // kilocode_change start - use Effect schema (propertyOrder: original) + non-fatal handleInvalid
    try {
      result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
    } catch (err) {
      if (ConfigError.InvalidError.isInstance(err)) {
        await KilocodeConfig.handleInvalid("agent", item, err.data.issues ?? [], err, warnings)
        continue
      }
      throw err
    }
    // kilocode_change end
    // Only successfully decoded agents contribute permission provenance, so an
    // invalid markdown file never creates a phantom allow/deny layer. Presence
    // is raw frontmatter truth (empty {} stays applicable ask, absent stays
    // non-applicable) independent of schema normalization.
    sources.push({ agent: config.name, file: item, present, raw })
  }
  return { agents: result, sources }
}

export async function load(
  dir: string,
  warnings?: Warning[],
  trusted = false,
  fileScope?: ConfigVariable.FileScope,
  sourceScope?: ConfigVariable.FileScope,
) {
  const out = await loadWithSources(dir, warnings, trusted, fileScope, sourceScope)
  return out.agents
}
