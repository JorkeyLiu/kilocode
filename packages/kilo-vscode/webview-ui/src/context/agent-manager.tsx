/**
 * Agent Manager context — marks whether the webview is the Agent Manager
 * panel. Editor-tab chat renders without this context, so consumers can
 * check `useAgentManager()` to enable Agent Manager–only behavior.
 */

import { createContext, useContext, ParentComponent, Accessor } from "solid-js"

interface AgentManagerContextValue {
  present: Accessor<boolean>
}

const AgentManagerContext = createContext<AgentManagerContextValue>()

export const AgentManagerProvider: ParentComponent = (props) => {
  const present = () => true

  return <AgentManagerContext.Provider value={{ present }}>{props.children}</AgentManagerContext.Provider>
}

/**
 * Returns true when inside the Agent Manager panel.
 */
export function useAgentManager(): boolean {
  return useContext(AgentManagerContext)?.present() ?? false
}
