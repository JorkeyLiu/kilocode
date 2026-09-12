export const dict = {
  // Kilo Gateway provider translations
  "provider.connect.kiloGateway.line1":
    "Kilo Gatewayは、コーディングエージェント向けに厳選された信頼性の高い最適化モデルへのアクセスを提供します。",
  "provider.connect.kiloGateway.line2": "1つのAPIキーで、Claude、GPT、Gemini、GLMなどのモデルにアクセスできます。",
  "provider.connect.kiloGateway.visit.prefix": "",
  "provider.connect.kiloGateway.visit.link": "kilo.ai",
  "provider.connect.kiloGateway.visit.suffix": " にアクセスしてAPIキーを取得してください。",
  "provider.connect.kiloGateway.byok.prefix": "詳細な使用統計については、",
  "provider.connect.kiloGateway.byok.link": "Kilo's Gateway経由でBYOK",
  "provider.connect.kiloGateway.byok.suffix": "をご利用ください。",

  // Provider settings translations
  "settings.providers.group.recommended": "おすすめ",
  "settings.providers.note.opencode": "Claude、GPT、Geminiなどの厳選モデル",
  "settings.providers.note.anthropic": "ProやMaxを含むClaudeモデルへ直接アクセス",
  "settings.providers.note.deepseek": "推論とコーディング作業向けのDeepSeekモデル",
  "settings.providers.note.copilot": "コーディング支援向けのClaudeモデル",
  "settings.providers.note.openai": "APIキーまたはChatGPTログインで使えるGPTとCodexモデル",
  "settings.providers.note.google": "高速で構造化された応答向けのGeminiモデル",
  "settings.providers.note.openrouter": "1つのプロバイダーからすべての対応モデルにアクセス",
  "settings.providers.note.vercel": "スマートルーティングによるAIモデルへの統合アクセス",

  // Reasoning block label
  "ui.permission.run": "実行",
  "ui.reasoning.label": "推論",

  // Plan follow-up question shown after plan_exit
  "plan.followup.header": "実装",
  "plan.followup.question": "実装する準備はできましたか？",
  "plan.followup.answer.newSession": "新しいセッションを開始",
  "plan.followup.answer.newSession.description": "クリーンなコンテキストの新しいセッションで実装する",
  "plan.followup.answer.continue": "ここで続行",
  "plan.followup.answer.continue.description": "このセッションで計画を実装する",
  "plan.followup.answer.keepRefining": "さらに調整する",
  "plan.followup.answer.keepRefining.description": "まだ実装せずに計画を続ける",

  // Slow-repo snapshot prompt
  "snapshot.slowRepo.header": "スナップショットが遅い",
  "snapshot.slowRepo.question":
    "リポジトリのサイズのためか、スナップショットシステムの初期化に時間がかかっています。\n\nこのリポジトリのスナップショットを無効にしますか？",
  "snapshot.slowRepo.answer.continue": "スナップショットを続行",
  "snapshot.slowRepo.answer.continue.description":
    "スナップショットが完了するまで待機します。初回のスナップショットが作成された後は、以降のターンは高速になります。",
  "snapshot.slowRepo.answer.disable": "このプロジェクトで無効化",
  "snapshot.slowRepo.answer.disable.description":
    "このプロジェクトでは Kilo のスナップショットを無効にします。Kilo による変更の取り消し/やり直しはできなくなりますが、git は引き続きすべてを追跡します。",

  // Edit-tool header and shell-tool section labels
  "ui.messagePart.openInDiffViewer": "差分ビューアーで開く",
  "ui.messagePart.shell.command": "コマンド",
  "ui.messagePart.shell.output": "出力",
  "ui.messagePart.openInEditor": "エディタで開く",

  // Message feedback (thumbs up/down per assistant response)
  "ui.message.feedback.helpful": "役に立ちました",
  "ui.message.feedback.notHelpful": "役に立ちませんでした",
  "ui.message.feedback.clearRating": "評価をクリア",
}
