export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway предоставляет доступ к подборке надёжных оптимизированных моделей для агентов кодирования.",
  "provider.connect.kiloGateway.line2":
    "С одним API-ключом вы получите доступ к моделям Claude, GPT, Gemini, GLM и другим.",
  "provider.connect.kiloGateway.visit.prefix": "Посетите ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": ", чтобы получить ваш API-ключ.",
  "provider.connect.kiloGateway.byok.prefix": "Для получения дополнительной статистики использования используйте ",
  "provider.connect.kiloGateway.byok.link": "BYOK через Kilo's Gateway",
  "provider.connect.kiloGateway.byok.suffix": ".",

  // Provider settings translations
  "settings.providers.group.recommended": "Рекомендуемые",
  "settings.providers.note.opencode": "Подобранные модели, включая Claude, GPT, Gemini и другие",
  "settings.providers.note.anthropic": "Прямой доступ к моделям Claude, включая Pro и Max",
  "settings.providers.note.deepseek": "Модели DeepSeek для задач рассуждения и программирования",
  "settings.providers.note.copilot": "Модели Claude для помощи в программировании",
  "settings.providers.note.openai": "Модели GPT и Codex с API-ключом или входом через ChatGPT",
  "settings.providers.note.google": "Модели Gemini для быстрых структурированных ответов",
  "settings.providers.note.openrouter": "Доступ ко всем поддерживаемым моделям через одного провайдера",
  "settings.providers.note.vercel": "Единый доступ к AI-моделям с умной маршрутизацией",

  // Reasoning block label
  "ui.permission.run": "Запустить",
  "ui.reasoning.label": "Рассуждение",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "Реализовать",
  "plan.followup.question": "Готовы реализовать?",
  "plan.followup.answer.newSession": "Начать новую сессию",
  "plan.followup.answer.newSession.description": "Реализовать в новой сессии с чистым контекстом",
  "plan.followup.answer.continue": "Продолжить здесь",
  "plan.followup.answer.continue.description": "Реализовать план в этой сессии",
  "plan.followup.answer.keepRefining": "Продолжить уточнение",
  "plan.followup.answer.keepRefining.description": "Продолжить планирование без реализации пока что",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "Снимок выполняется медленно",
  "snapshot.slowRepo.question":
    "Инициализация системы снимков занимает много времени, вероятно, из-за размера репозитория.\n\nОтключить снимки для этого репозитория?",
  "snapshot.slowRepo.answer.continue": "Продолжить со снимками",
  "snapshot.slowRepo.answer.continue.description":
    "Подождите, пока снимок не завершится. Последующие ходы выполняются быстро после создания первоначального снимка.",
  "snapshot.slowRepo.answer.disable": "Отключить для этого проекта",
  "snapshot.slowRepo.answer.disable.description":
    "Выключите снимки Kilo для этого проекта. Вы потеряете отмену/повтор изменений Kilo, но git по-прежнему отслеживает всё.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "Открыть в просмотре различий",
  "ui.messagePart.shell.command": "Команда",
  "ui.messagePart.shell.output": "Вывод",
  "ui.messagePart.openInEditor": "Открыть в редакторе",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "Это было полезно",
  "ui.message.feedback.notHelpful": "Это было бесполезно",
  "ui.message.feedback.clearRating": "Очистить оценку",
}
