// kilocode_change - new file
// Built-in skills that ship inside the CLI binary.
// Content is inlined at compile time via Bun's static import of .md files.
// Registered before all discovery phases so user skills with the same name override.

import KILO_CONFIG from "./kilo-config.md"

export interface BuiltinSkill {
  name: string
  description: string
  content: string
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "kilo-config",
    description:
      "Guide for Kilo configuration: config paths, kilo.json fields, commands, agents, skills, permissions, MCPs, providers, TUI settings, plus Agent Manager root-local sessions, workflows, and state. Use for Kilo config questions, locating loaded config, changing settings, or Agent Manager questions about root-local sessions and missing sessions.",
    content: KILO_CONFIG,
  },
]
