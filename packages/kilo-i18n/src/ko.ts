export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gateway는 코딩 에이전트를 위한 신뢰할 수 있는 최적화된 모델 세트를 제공합니다.",
  "provider.connect.kiloGateway.line2": "하나의 API 키로 Claude, GPT, Gemini, GLM 등의 모델을 사용할 수 있습니다.",
  "provider.connect.kiloGateway.visit.prefix": "",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": "를 방문하여 API 키를 받으세요.",
  "provider.connect.kiloGateway.byok.prefix": "더 많은 사용 통계를 보려면 ",
  "provider.connect.kiloGateway.byok.link": "Kilo's Gateway를 통해 BYOK",
  "provider.connect.kiloGateway.byok.suffix": "를 사용하세요.",

  // Provider settings translations
  "settings.providers.group.recommended": "추천",
  "settings.providers.note.opencode": "Claude, GPT, Gemini 등을 포함한 엄선된 모델",
  "settings.providers.note.anthropic": "Pro 및 Max를 포함한 Claude 모델에 직접 액세스",
  "settings.providers.note.deepseek": "추론 및 코딩 작업을 위한 DeepSeek 모델",
  "settings.providers.note.copilot": "코딩 지원을 위한 Claude 모델",
  "settings.providers.note.openai": "API 키 또는 ChatGPT 로그인으로 사용하는 GPT 및 Codex 모델",
  "settings.providers.note.google": "빠르고 구조화된 응답을 위한 Gemini 모델",
  "settings.providers.note.openrouter": "하나의 제공업체에서 모든 지원 모델에 액세스",
  "settings.providers.note.vercel": "스마트 라우팅으로 AI 모델에 통합 액세스",

  // Reasoning block label
  "ui.permission.run": "실행",
  "ui.reasoning.label": "추론",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "구현",
  "plan.followup.question": "구현할 준비가 되셨나요?",
  "plan.followup.answer.newSession": "새 세션 시작",
  "plan.followup.answer.newSession.description": "깨끗한 컨텍스트의 새 세션에서 구현",
  "plan.followup.answer.continue": "여기서 계속하기",
  "plan.followup.answer.continue.description": "이 세션에서 계획 구현",
  "plan.followup.answer.keepRefining": "계속 다듬기",
  "plan.followup.answer.keepRefining.description": "아직 구현하지 않고 계획을 계속 진행",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "스냅샷이 느립니다",
  "snapshot.slowRepo.question":
    "리포지토리 크기 때문인지 스냅샷 시스템 초기화에 시간이 오래 걸리고 있습니다.\n\n이 리포지토리에서 스냅샷을 비활성화하시겠습니까?",
  "snapshot.slowRepo.answer.continue": "스냅샷 계속 사용",
  "snapshot.slowRepo.answer.continue.description":
    "스냅샷이 완료될 때까지 기다리세요. 초기 스냅샷이 만들어지면 이후 턴은 빠릅니다.",
  "snapshot.slowRepo.answer.disable": "이 프로젝트에서 비활성화",
  "snapshot.slowRepo.answer.disable.description":
    "이 프로젝트의 Kilo 스냅샷을 끕니다. Kilo 변경에 대한 실행 취소/다시 실행은 사용할 수 없지만 git은 여전히 모든 것을 추적합니다.",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "차이점 뷰어에서 열기",
  "ui.messagePart.shell.command": "명령어",
  "ui.messagePart.shell.output": "출력",
  "ui.messagePart.openInEditor": "편집기에서 열기",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "도움이 됐어요",
  "ui.message.feedback.notHelpful": "도움이 안 됐어요",
  "ui.message.feedback.clearRating": "평가 지우기",
}
