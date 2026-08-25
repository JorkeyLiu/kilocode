// kilocode_change - new file

import { Global } from "@opencode-ai/core/global"
import { staticEnvLines, type EditorContext } from "@/kilocode/editor-context"
import type { Provider } from "@/provider/provider"
import type { InstanceContext } from "@/project/instance-context"

export namespace KilocodeSystemPrompt {
  export function environment(input: { ctx: InstanceContext; model: Provider.Model; editor?: EditorContext }) {
    return [
      [
        `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Is directory a git repo: ${input.ctx.project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `  Project config: .kilo/kilo.jsonc, .kilo/command/*.md, .kilo/agent/*.md, AGENTS.md. Put new commands and agents in .kilo/. Canonical only — no .kilocode/.opencode, no kilo.json.`,
        `  Global config: ${Global.Path.config}/kilo.jsonc and assets directly under ${Global.Path.config}/ (project: canonicalRoot/.kilo/). Canonical only — no .kilocode/.opencode, no kilo.json, no mode/modes.`,
        ...staticEnvLines(input.editor),
        `</env>`,
      ].join("\n"),
    ]
  }
}
