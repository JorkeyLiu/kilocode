export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway giver dig adgang til et udvalgt sæt pålidelige, optimerede modeller til kodningsagenter.",
  "provider.connect.kiloGateway.line2":
    "Med en enkelt API-nøgle får du adgang til modeller som Claude, GPT, Gemini, GLM og flere.",
  "provider.connect.kiloGateway.visit.prefix": "Besøg ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " for at hente din API-nøgle.",
  "provider.connect.kiloGateway.byok.prefix": "For flere brugsstatistikker, brug ",
  "provider.connect.kiloGateway.byok.link": "BYOK via Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Anbefalede",
  "settings.providers.note.opencode": "Udvalgte modeller inklusive Claude, GPT, Gemini og mere",
  "settings.providers.note.anthropic": "Direkte adgang til Claude-modeller, inklusive Pro og Max",
  "settings.providers.note.deepseek": "DeepSeek-modeller til ræsonnement og kodningsopgaver",
  "settings.providers.note.copilot": "Claude-modeller til kodningsassistance",
  "settings.providers.note.openai": "GPT- og Codex-modeller med API-nøgle eller ChatGPT-login",
  "settings.providers.note.google": "Gemini-modeller til hurtige, strukturerede svar",
  "settings.providers.note.openrouter": "Adgang til alle understøttede modeller fra én udbyder",
  "settings.providers.note.vercel": "Samlet adgang til AI-modeller med smart routing",

  // Reasoning block label
  "ui.permission.run": "Kør",
  "ui.reasoning.label": "Ræsonnement",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "Implementér",
  "plan.followup.question": "Klar til at implementere?",
  "plan.followup.answer.newSession": "Start ny session",
  "plan.followup.answer.newSession.description": "Implementér i en ny session med ren kontekst",
  "plan.followup.answer.continue": "Fortsæt her",
  "plan.followup.answer.continue.description": "Implementér planen i denne session",
  "plan.followup.answer.keepRefining": "Fortsæt med at finpudse",
  "plan.followup.answer.keepRefining.description": "Fortsæt planlægningen uden at implementere endnu",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "Snapshot er langsomt",
  "snapshot.slowRepo.question":
    "Det tager lang tid at initialisere snapshot-systemet, sandsynligvis på grund af størrelsen på repositoryet.\n\nVil du deaktivere snapshots for dette repository?",
  "snapshot.slowRepo.answer.continue": "Fortsæt med snapshots",
  "snapshot.slowRepo.answer.continue.description":
    "Vent, indtil snapshot'et er færdigt. Efterfølgende ture er hurtige, når det indledende snapshot er bygget.",
  "snapshot.slowRepo.answer.disable": "Deaktivér for dette projekt",
  "snapshot.slowRepo.answer.disable.description":
    "Slå Kilos snapshots fra for dette projekt. Du mister fortryd/gentag for Kilo-ændringer, men git sporer stadig alt.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "Åbn i Diff-visning",
  "ui.messagePart.shell.command": "Kommando",
  "ui.messagePart.shell.output": "Output",
  "ui.messagePart.openInEditor": "Åbn i editor",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "Dette var nyttigt",
  "ui.message.feedback.notHelpful": "Dette var ikke nyttigt",
  "ui.message.feedback.clearRating": "Ryd bedømmelse",
}
