export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway vous donne accès à une sélection de modèles fiables et optimisés pour les agents de codage.",
  "provider.connect.kiloGateway.line2":
    "Avec une seule clé API, vous aurez accès à des modèles tels que Claude, GPT, Gemini, GLM et plus encore.",
  "provider.connect.kiloGateway.visit.prefix": "Visitez ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " pour obtenir votre clé API.",
  "provider.connect.kiloGateway.byok.prefix": "Pour plus de statistiques d'utilisation, utilisez ",
  "provider.connect.kiloGateway.byok.link": "BYOK via Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Recommandés",
  "settings.providers.note.opencode": "Modèles sélectionnés, dont Claude, GPT, Gemini et plus encore",
  "settings.providers.note.anthropic": "Accès direct aux modèles Claude, y compris Pro et Max",
  "settings.providers.note.deepseek": "Modèles DeepSeek pour les tâches de raisonnement et de codage",
  "settings.providers.note.copilot": "Modèles Claude pour l'assistance au codage",
  "settings.providers.note.openai": "Modèles GPT et Codex avec clé API ou connexion ChatGPT",
  "settings.providers.note.google": "Modèles Gemini pour des réponses rapides et structurées",
  "settings.providers.note.openrouter": "Accédez à tous les modèles pris en charge depuis un seul fournisseur",
  "settings.providers.note.vercel": "Accès unifié aux modèles IA avec routage intelligent",

  // Reasoning block label
  "ui.permission.run": "Exécuter",
  "ui.reasoning.label": "Raisonnement",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "Implémenter",
  "plan.followup.question": "Prêt à implémenter ?",
  "plan.followup.answer.newSession": "Démarrer une nouvelle session",
  "plan.followup.answer.newSession.description": "Implémenter dans une nouvelle session avec un contexte vierge",
  "plan.followup.answer.continue": "Continuer ici",
  "plan.followup.answer.continue.description": "Implémenter le plan dans cette session",
  "plan.followup.answer.keepRefining": "Continuer à affiner",
  "plan.followup.answer.keepRefining.description": "Continuer à planifier sans implémenter pour l'instant",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "Instantané lent",
  "snapshot.slowRepo.question":
    "L'initialisation du système d'instantanés prend beaucoup de temps, probablement en raison de la taille du dépôt.\n\nVoulez-vous désactiver les instantanés pour ce dépôt ?",
  "snapshot.slowRepo.answer.continue": "Continuer avec les instantanés",
  "snapshot.slowRepo.answer.continue.description":
    "Attendez la fin de l'instantané. Les tours suivants sont rapides une fois l'instantané initial créé.",
  "snapshot.slowRepo.answer.disable": "Désactiver pour ce projet",
  "snapshot.slowRepo.answer.disable.description":
    "Désactivez les instantanés Kilo pour ce projet. Vous perdez l'annulation/restauration des modifications faites par Kilo, mais git continue de tout suivre.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "Ouvrir dans le visualiseur de différences",
  "ui.messagePart.shell.command": "Commande",
  "ui.messagePart.shell.output": "Sortie",
  "ui.messagePart.openInEditor": "Ouvrir dans l'éditeur",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "C'était utile",
  "ui.message.feedback.notHelpful": "Ce n'était pas utile",
  "ui.message.feedback.clearRating": "Effacer la notation",
}
