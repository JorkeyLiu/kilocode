// Kilo-specific translations and overrides
// Keys here will override any matching keys from upstream translations
export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway gives you access to a curated set of reliable optimized models for coding agents.",
  "provider.connect.kiloGateway.line2":
    "With a single API key you'll get access to models such as Claude, GPT, Gemini, GLM and more.",
  "provider.connect.kiloGateway.visit.prefix": "Visit ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " to collect your API key.",
  "provider.connect.kiloGateway.byok.prefix": "For more usage stats, ",
  "provider.connect.kiloGateway.byok.link": "BYOK via Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Recommended",
  "settings.providers.note.opencode": "Curated models including Claude, GPT, Gemini and more",
  "settings.providers.note.anthropic": "Direct access to Claude models, including Pro and Max",
  "settings.providers.note.deepseek": "DeepSeek models for reasoning and coding tasks",
  "settings.providers.note.copilot": "Claude models for coding assistance",
  "settings.providers.note.openai": "GPT and Codex models with API key or ChatGPT login",
  "settings.providers.note.google": "Gemini models for fast, structured responses",
  "settings.providers.note.openrouter": "Access all supported models from one provider",
  "settings.providers.note.vercel": "Unified access to AI models with smart routing",

  // Reasoning block label
  "ui.permission.run": "Run",
  "ui.reasoning.label": "Reasoning",

  // Plan follow-up question shown after plan_exit. The English strings here must match
  // the canonical `label`/`header`/`question` sent by the backend — those canonical labels
  // are still what the backend matches on (see packages/opencode/src/kilocode/plan-followup.ts).
  "plan.followup.header": "Implement",
  "plan.followup.question": "Ready to implement?",
  "plan.followup.answer.newSession": "Start new session",
  "plan.followup.answer.newSession.description": "Implement in a fresh session with a clean context",
  "plan.followup.answer.continue": "Continue here",
  "plan.followup.answer.continue.description": "Implement the plan in this session",
  "plan.followup.answer.keepRefining": "Keep refining",
  "plan.followup.answer.keepRefining.description": "Keep planning without implementing yet",

  // Slow-repo snapshot prompt. The English strings here are the canonical
  // labels sent by the backend and must stay in sync with
  // packages/opencode/src/kilocode/snapshot/track.ts.
  "snapshot.slowRepo.header": "Snapshot is slow",
  "snapshot.slowRepo.question":
    "It is taking a long time to initialize the snapshot system, likely due to the size of the repository.\n\nDo you want to disable Snapshots for this repository?",
  "snapshot.slowRepo.answer.continue": "Continue with snapshots",
  "snapshot.slowRepo.answer.continue.description":
    "Keep waiting for the snapshot to complete. Subsequent turns are fast once the initial snapshot is built.",
  "snapshot.slowRepo.answer.disable": "Disable for this project",
  "snapshot.slowRepo.answer.disable.description":
    "Turn off Kilo's snapshots for this project. You will lose undo/redo of Kilo file changes, but git still tracks everything.",

  // Edit-tool header: hover-revealed action opening the diff in a full tab.
  "ui.messagePart.openInDiffViewer": "Open in Diff Viewer",
  // Shell-tool section labels and actions.
  "ui.messagePart.shell.command": "Command",
  "ui.messagePart.shell.output": "Output",
  "ui.messagePart.openInEditor": "Open in Editor",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "This was helpful",
  "ui.message.feedback.notHelpful": "This wasn't helpful",
  "ui.message.feedback.clearRating": "Clear rating",
}
