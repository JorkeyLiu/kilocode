export interface NewTaskDraft {
  id: string
  contextId: string
}

export function createNewTaskDrafts(timeout = 30_000) {
  let seq = 0
  const tasks = new Map<string, string[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const remove = (task: NewTaskDraft, discard = false) => {
    const ids = tasks.get(task.contextId) ?? []
    const next = ids.filter((id) => id !== task.id)
    if (next.length === 0) tasks.delete(task.contextId)
    else tasks.set(task.contextId, next)
    const timer = timers.get(task.id)
    if (timer) clearTimeout(timer)
    timers.delete(task.id)
    if (!discard) return
    window.dispatchEvent(new CustomEvent("agentManagerDiscardDraft", { detail: { id: task.id } }))
  }

  const create = (contextId: string) => {
    const task = { id: `task:${++seq}`, contextId }
    tasks.set(contextId, [...(tasks.get(contextId) ?? []), task.id])
    timers.set(
      task.id,
      setTimeout(() => remove(task, true), timeout),
    )
    return task
  }

  const take = (contextId: string) => {
    const id = tasks.get(contextId)?.[0]
    if (!id) return undefined
    const task = { id, contextId }
    remove(task)
    return task
  }

  const cleanup = () => {
    for (const ids of tasks.values()) {
      for (const id of ids) {
        window.dispatchEvent(new CustomEvent("agentManagerDiscardDraft", { detail: { id } }))
      }
    }
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    tasks.clear()
  }

  const apply = (contextId: string, sessionId: string) => {
    const task = take(contextId)
    if (!task) return
    window.dispatchEvent(
      new CustomEvent("agentManagerApplyDraft", {
        detail: { id: task.id, sessionId, boxId: `agent-manager:${contextId}` },
      }),
    )
  }

  return { create, apply, cleanup }
}
