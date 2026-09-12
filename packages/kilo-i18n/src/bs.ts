export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway omogućava pristup pažljivo odabranom skupu pouzdanih modela optimizovanih za rad sa agentima za kodiranje.",
  "provider.connect.kiloGateway.line2":
    "Sa jednim API ključem dobijate pristup modelima kao što su Claude, GPT, Gemini, GLM i drugi.",
  "provider.connect.kiloGateway.visit.prefix": "Posjetite ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " da preuzmete svoj API ključ.",
  "provider.connect.kiloGateway.byok.prefix": "Za više statistika korištenja, koristite ",
  "provider.connect.kiloGateway.byok.link": "BYOK putem Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Preporučeno",
  "settings.providers.note.opencode": "Odabrani modeli uključujući Claude, GPT, Gemini i još mnogo toga",
  "settings.providers.note.anthropic": "Direktan pristup Claude modelima, uključujući Pro i Max",
  "settings.providers.note.deepseek": "DeepSeek modeli za zadatke rezonovanja i programiranja",
  "settings.providers.note.copilot": "Claude modeli za pomoć pri programiranju",
  "settings.providers.note.openai": "GPT i Codex modeli uz API ključ ili ChatGPT prijavu",
  "settings.providers.note.google": "Gemini modeli za brze, strukturirane odgovore",
  "settings.providers.note.openrouter": "Pristup svim podržanim modelima od jednog provajdera",
  "settings.providers.note.vercel": "Objedinjen pristup AI modelima s pametnim usmjeravanjem",

  // Desktop translations
  "desktop.menu.reloadWebview": "Ponovno učitavanje webview-a",
  "desktop.updater.installFailed.message": "Neuspjelo instaliranje ažuriranja",
  "desktop.cli.installed.message": "CLI je instaliran u {{path}}\n\nRestartuj terminal da bi koristio komandu 'kilo'.",

  // Reasoning block label
  "ui.permission.run": "Pokreni",
  "ui.reasoning.label": "Rezonovanje",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "Implementiraj",
  "plan.followup.question": "Spreman za implementaciju?",
  "plan.followup.answer.newSession": "Pokreni novu sesiju",
  "plan.followup.answer.newSession.description": "Implementiraj u novoj sesiji s čistim kontekstom",
  "plan.followup.answer.continue": "Nastavi ovdje",
  "plan.followup.answer.continue.description": "Implementiraj plan u ovoj sesiji",
  "plan.followup.answer.keepRefining": "Nastavi dorađivati",
  "plan.followup.answer.keepRefining.description": "Nastavi planirati bez implementacije za sada",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "Snapshot je spor",
  "snapshot.slowRepo.question":
    "Inicijalizacija sistema snapshotova traje dugo, vjerovatno zbog veličine repozitorija.\n\nŽelite li onemogućiti snapshotove za ovaj repozitorij?",
  "snapshot.slowRepo.answer.continue": "Nastavi sa snapshotovima",
  "snapshot.slowRepo.answer.continue.description":
    "Sačekaj da se snapshot završi. Naredni potezi su brzi kada se početni snapshot jednom napravi.",
  "snapshot.slowRepo.answer.disable": "Onemogući za ovaj projekat",
  "snapshot.slowRepo.answer.disable.description":
    "Isključi Kilo snapshotove za ovaj projekat. Izgubićete poništi/vrati za izmjene koje napravi Kilo, ali git i dalje prati sve.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "Otvori u pregledniku razlika",
  "ui.messagePart.shell.command": "Naredba",
  "ui.messagePart.shell.output": "Izlaz",
  "ui.messagePart.openInEditor": "Otvori u editoru",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "Ovo je bilo korisno",
  "ui.message.feedback.notHelpful": "Ovo nije bilo korisno",
  "ui.message.feedback.clearRating": "Obriši ocjenu",
}
