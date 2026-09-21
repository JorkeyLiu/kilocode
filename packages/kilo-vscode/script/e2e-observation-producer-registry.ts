/**
 * Observation-producer scenario registration helper.
 * Extracted from script/e2e-probe.ts to keep that file under its max-lines cap.
 * No production semantics changed: same SCENARIO value, same derived timeout,
 * same canonical-storage and ready-marker semantics.
 */

export const OBSERVATION_PRODUCER_SCENARIO = "observation-producer" as const
export const OBSERVATION_PRODUCER_UPDATE_SCENARIO = "observation-producer-update" as const
export const OBSERVATION_PRODUCER_DELETE_SCENARIO = "observation-producer-delete" as const
export const OBSERVATION_PRODUCER_FORK_SCENARIO = "observation-producer-fork" as const
export const OBSERVATION_PRODUCER_REVERT_SCENARIO = "observation-producer-revert" as const
export const OBSERVATION_PRODUCER_SANDBOX_SCENARIO = "observation-producer-sandbox" as const
export const PROMPT_PRIVATE_FIRST_SCENARIO = "prompt-private-first" as const
export const COMMAND_PRIVATE_FIRST_SCENARIO = "command-private-first" as const

const OBSERVATION_PRODUCER_TIMEOUT_MS = 1_200_000 as const
const OBSERVATION_PRODUCER_UPDATE_TIMEOUT_MS = 1_200_000 as const
const OBSERVATION_PRODUCER_DELETE_TIMEOUT_MS = 1_200_000 as const
const OBSERVATION_PRODUCER_FORK_TIMEOUT_MS = 1_200_000 as const
const OBSERVATION_PRODUCER_REVERT_TIMEOUT_MS = 1_200_000 as const
const OBSERVATION_PRODUCER_SANDBOX_TIMEOUT_MS = 1_200_000 as const
const PROMPT_PRIVATE_FIRST_TIMEOUT_MS = 1_200_000 as const
const COMMAND_PRIVATE_FIRST_TIMEOUT_MS = 1_200_000 as const

const SCENARIO_TIMEOUTS: Record<string, number> = {
  "real-completed": 6_000_000,
  "real-overflow": 1_200_000,
  "real-restart": 6_000_000,
  "real-lifecycle": 1_200_000,
  "worktree-removal": 6_000_000,
  "r9-observation": 1_200_000,
  [OBSERVATION_PRODUCER_SCENARIO]: OBSERVATION_PRODUCER_TIMEOUT_MS,
  [OBSERVATION_PRODUCER_UPDATE_SCENARIO]: OBSERVATION_PRODUCER_UPDATE_TIMEOUT_MS,
  [OBSERVATION_PRODUCER_DELETE_SCENARIO]: OBSERVATION_PRODUCER_DELETE_TIMEOUT_MS,
  [OBSERVATION_PRODUCER_FORK_SCENARIO]: OBSERVATION_PRODUCER_FORK_TIMEOUT_MS,
  [OBSERVATION_PRODUCER_REVERT_SCENARIO]: OBSERVATION_PRODUCER_REVERT_TIMEOUT_MS,
  [OBSERVATION_PRODUCER_SANDBOX_SCENARIO]: OBSERVATION_PRODUCER_SANDBOX_TIMEOUT_MS,
  [PROMPT_PRIVATE_FIRST_SCENARIO]: PROMPT_PRIVATE_FIRST_TIMEOUT_MS,
  [COMMAND_PRIVATE_FIRST_SCENARIO]: COMMAND_PRIVATE_FIRST_TIMEOUT_MS,
}

export function e2eTimeoutForScenario(scenario: string | undefined): number {
  if (!scenario) return 300_000
  return SCENARIO_TIMEOUTS[scenario] ?? 300_000
}
