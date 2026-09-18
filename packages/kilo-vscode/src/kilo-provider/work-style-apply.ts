import {
  buildLevelApplyPlan,
  levelForStyle,
  type PermissionMainLevel,
  type WorkStyle,
  type WorkStyleConfig,
  type WorkStyleSettings,
} from "../shared/work-style-presets"

type Setting = keyof WorkStyleSettings | "agentWorkStyle"

export interface WorkStyleSettingSnapshot {
  customized: boolean
  global: unknown
}

export interface WorkStyleStore {
  read: () => Promise<WorkStyleConfig>
  inspect: (key: Setting) => WorkStyleSettingSnapshot
  write: (key: Setting, value: unknown) => Promise<void>
  patch: (config: WorkStyleConfig) => Promise<void>
}

type WorkStyleApplyResult =
  | { ok: true }
  | {
      ok: false
      error: string
      rollback: Setting[]
    }

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Explicit Review/Autonomous switch: atomically overwrites the canonical
 * global preset-owned permission plus the level field. Project, agent, and
 * session restrictions are never touched — project layers keep stacking
 * restrictively on top.
 */
export async function applyWorkStyle(style: WorkStyle, store: WorkStyleStore): Promise<WorkStyleApplyResult> {
  return applyPermissionLevel(levelForStyle(style), style, store)
}

export async function applyPermissionLevel(
  level: PermissionMainLevel,
  style: WorkStyle,
  store: WorkStyleStore,
): Promise<WorkStyleApplyResult> {
  const completed: Array<{ key: Setting; value: unknown }> = []

  try {
    const plan = buildLevelApplyPlan(level)
    const writes: Array<{ key: Setting; value: unknown }> = []
    if (!store.inspect("showTaskTimeline").customized) {
      const timeline = level === "review" ? true : false
      writes.push({ key: "showTaskTimeline", value: timeline })
    }
    writes.push({ key: "agentWorkStyle", value: style })

    for (const write of writes) {
      completed.push({ key: write.key, value: store.inspect(write.key).global })
      await store.write(write.key, write.value)
    }
    await store.patch(plan)
    return { ok: true }
  } catch (err) {
    const rollback: Setting[] = []
    for (const write of [...completed].reverse()) {
      await store.write(write.key, write.value).catch(() => rollback.push(write.key))
    }
    return { ok: false, error: message(err), rollback }
  }
}
