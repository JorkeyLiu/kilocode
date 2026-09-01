import { isProviderID } from "@/kilocode/custom-provider"

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidModelID(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && MODEL_ID_PATTERN.test(value)
}

export function isValidEnvName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && ENV_NAME_PATTERN.test(value)
}

export function isValidProviderID(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && isProviderID(value)
}

export function validateProviderID(provider: string): void {
  if (!isValidProviderID(provider)) throw new Error(`Invalid provider ID: ${provider}`)
}

export function validateModelID(model: string): void {
  if (!isValidModelID(model)) throw new Error(`Invalid model ID: ${model}`)
}

export function validateEnvName(name: string): void {
  if (!isValidEnvName(name)) throw new Error(`Invalid env name: ${name}`)
}

export function validateWorkflowInputs(provider: string, model: string, env: string[]): void {
  validateProviderID(provider)
  validateModelID(model)
  for (const e of env) validateEnvName(e)
}

export function buildGithubWorkflowEnv(provider: string, env: string[]): string {
  for (const e of env) validateEnvName(e)
  if (provider === "amazon-bedrock") return ""
  const envPart = env.map((e) => `\n          ${e}: \${{ secrets.${e} }}`).join("")
  const kilo = provider === "kilo" ? `\n          KILO_API_KEY: \${{ secrets.KILO_API_KEY }}\n          KILO_ORG_ID: \${{ secrets.KILO_ORG_ID }}` : ""
  const str = envPart || kilo ? `\n        env:${envPart}${kilo}` : ""
  return str
}

export function buildWorkflowContent(provider: string, model: string, env: string[]): string {
  validateWorkflowInputs(provider, model, env)
  const envStr = buildGithubWorkflowEnv(provider, env)
  return `name: kilo

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  kilo:
    if: |
      contains(github.event.comment.body, ' /kc') ||
      startsWith(github.event.comment.body, '/kc') ||
      contains(github.event.comment.body, ' /kilo') ||
      startsWith(github.event.comment.body, '/kilo')
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
      issues: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Run Kilo
        uses: Kilo-Org/kilocode/github@latest${envStr}
        with:
          model: ${provider}/${model}`
}
