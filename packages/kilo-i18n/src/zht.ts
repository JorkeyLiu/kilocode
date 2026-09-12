export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1": "Kilo Gateway 為您提供一組精選的可靠優化模型，專為編碼代理設計。",
  "provider.connect.kiloGateway.line2": "只需一個 API 金鑰，您就可以使用 Claude、GPT、Gemini、GLM 等模型。",
  "provider.connect.kiloGateway.visit.prefix": "訪問 ",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " 獲取您的 API 金鑰。",
  "provider.connect.kiloGateway.byok.prefix": "如需更多使用統計資訊，請",
  "provider.connect.kiloGateway.byok.link": "透過 Kilo's Gateway 進行 BYOK",
  "provider.connect.kiloGateway.byok.suffix": "。",

  // Provider settings translations
  "settings.providers.group.recommended": "推薦",
  "settings.providers.note.opencode": "精選模型，包括 Claude、GPT、Gemini 等",
  "settings.providers.note.anthropic": "直接存取 Claude 模型，包括 Pro 和 Max",
  "settings.providers.note.deepseek": "用於推理和程式設計工作的 DeepSeek 模型",
  "settings.providers.note.copilot": "用於程式設計輔助的 Claude 模型",
  "settings.providers.note.openai": "使用 API 金鑰或 ChatGPT 登入存取 GPT 和 Codex 模型",
  "settings.providers.note.google": "用於快速結構化回應的 Gemini 模型",
  "settings.providers.note.openrouter": "透過單一供應商存取所有支援的模型",
  "settings.providers.note.vercel": "透過智慧路由統一存取 AI 模型",

  // Reasoning block label
  "ui.permission.run": "執行",
  "ui.reasoning.label": "推理",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "實作",
  "plan.followup.question": "準備好實作了嗎？",
  "plan.followup.answer.newSession": "開啟新工作階段",
  "plan.followup.answer.newSession.description": "在具有乾淨上下文的新工作階段中實作",
  "plan.followup.answer.continue": "在此繼續",
  "plan.followup.answer.continue.description": "在本工作階段中實作計畫",
  "plan.followup.answer.keepRefining": "繼續完善",
  "plan.followup.answer.keepRefining.description": "繼續規劃，暫不實作",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "快照速度較慢",
  "snapshot.slowRepo.question": "初始化快照系統耗時較長，可能是由於儲存庫的大小。\n\n是否要為此儲存庫停用快照？",
  "snapshot.slowRepo.answer.continue": "繼續使用快照",
  "snapshot.slowRepo.answer.continue.description": "等待快照完成。初始快照建立後，後續回合會很快。",
  "snapshot.slowRepo.answer.disable": "為此專案停用",
  "snapshot.slowRepo.answer.disable.description":
    "關閉本專案的 Kilo 快照。你將失去對 Kilo 變更的撤銷/重做，但 git 仍會追蹤所有內容。",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "在差異檢視器中開啟",
  "ui.messagePart.shell.command": "命令",
  "ui.messagePart.shell.output": "輸出",
  "ui.messagePart.openInEditor": "在編輯器中開啟",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "這有幫助",
  "ui.message.feedback.notHelpful": "這沒有幫助",
  "ui.message.feedback.clearRating": "清除評分",
}
