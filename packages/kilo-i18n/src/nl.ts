// Kilo-specific translations and overrides
// Keys here will override any matching keys from upstream translations
export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway geeft je toegang tot een gecureerde set van betrouwbare, geoptimaliseerde modellen voor coding agents.",
  "provider.connect.kiloGateway.line2":
    "Met één enkele API key krijg je toegang tot modellen zoals Claude, GPT, Gemini, GLM en meer.",
  "provider.connect.kiloGateway.visit.prefix": "Bezoek ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " om je API key op te halen.",
  "provider.connect.kiloGateway.byok.prefix": "Voor meer gebruiksstatistieken, gebruik ",
  "provider.connect.kiloGateway.byok.link": "BYOK via Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Aanbevolen",
  "settings.providers.note.opencode": "Geselecteerde modellen, waaronder Claude, GPT, Gemini en meer",
  "settings.providers.note.anthropic": "Directe toegang tot Claude-modellen, inclusief Pro en Max",
  "settings.providers.note.deepseek": "DeepSeek-modellen voor redeneer- en codeertaken",
  "settings.providers.note.copilot": "Claude-modellen voor hulp bij programmeren",
  "settings.providers.note.openai": "GPT- en Codex-modellen met API-sleutel of ChatGPT-login",
  "settings.providers.note.google": "Gemini-modellen voor snelle, gestructureerde antwoorden",
  "settings.providers.note.openrouter": "Toegang tot alle ondersteunde modellen via één provider",
  "settings.providers.note.vercel": "Geïntegreerde toegang tot AI-modellen met slimme routering",

  // Reasoning block label
  "ui.permission.run": "Uitvoeren",
  "ui.reasoning.label": "Redenering",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "Implementeren",
  "plan.followup.question": "Klaar om te implementeren?",
  "plan.followup.answer.newSession": "Nieuwe sessie starten",
  "plan.followup.answer.newSession.description": "Implementeren in een nieuwe sessie met een lege context",
  "plan.followup.answer.continue": "Hier doorgaan",
  "plan.followup.answer.continue.description": "Het plan in deze sessie implementeren",
  "plan.followup.answer.keepRefining": "Blijven verfijnen",
  "plan.followup.answer.keepRefining.description": "Blijven plannen zonder nu te implementeren",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "Snapshot is traag",
  "snapshot.slowRepo.question":
    "Het initialiseren van het snapshot-systeem duurt lang, waarschijnlijk vanwege de grootte van de repository.\n\nWil je snapshots voor deze repository uitschakelen?",
  "snapshot.slowRepo.answer.continue": "Doorgaan met snapshots",
  "snapshot.slowRepo.answer.continue.description":
    "Wacht tot de snapshot klaar is. Volgende beurten zijn snel zodra de eerste snapshot is gemaakt.",
  "snapshot.slowRepo.answer.disable": "Uitschakelen voor dit project",
  "snapshot.slowRepo.answer.disable.description":
    "Zet Kilo-snapshots uit voor dit project. Je verliest ongedaan maken/opnieuw doen van Kilo-wijzigingen, maar git blijft alles volgen.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "Openen in Diff-weergave",
  "ui.messagePart.shell.command": "Opdracht",
  "ui.messagePart.shell.output": "Uitvoer",
  "ui.messagePart.openInEditor": "Openen in editor",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "Dit was nuttig",
  "ui.message.feedback.notHelpful": "Dit was niet nuttig",
  "ui.message.feedback.clearRating": "Beoordeling wissen",
}
