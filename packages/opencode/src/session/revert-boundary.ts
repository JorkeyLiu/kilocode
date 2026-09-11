import { MessageID, PartID } from "./schema"

// kilocode_change - Snapshot v2 journal coverage planner shares this exact
// boundary resolution with SessionRevert.revert. Both call resolve; no second
// copy may drift.

export namespace SessionRevertBoundary {
  export interface Target {
    readonly messageID: string
    readonly partID?: string
  }

  export interface Boundary {
    // Resolved revert marker: existing remaining/lastUser semantics.
    readonly messageID: MessageID
    readonly partID?: PartID
    // Physical matched anchor: message-level is the first actual part of the
    // target message; part-level is the hit part even when keep=false drops
    // the resolved partID.
    readonly messageIndex: number
    readonly partIndex: number
  }

  export interface Message {
    readonly info: { readonly id: string; readonly role: string }
    readonly parts: readonly { readonly id: string; readonly type: string }[]
  }

  const anchored = (type: string) => type === "text" || type === "tool"

  export const resolve = (messages: readonly Message[], target: Target): Boundary | undefined => {
    let last: Message["info"] | undefined
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.info.role === "user") last = msg.info
      for (let j = 0; j < msg.parts.length; j++) {
        const part = msg.parts[j]!
        const hitMessage = !target.partID && msg.info.id === target.messageID
        const hitPart = !!target.partID && part.id === target.partID
        if (!hitMessage && !hitPart) continue
        if (hitMessage) {
          // Message-level never keeps a partID; the physical anchor is the
          // first actual part (j is 0 on this first hit).
          return {
            messageID: (last ? last.id : msg.info.id) as MessageID,
            messageIndex: i,
            partIndex: j,
          }
        }
        const keep = msg.parts.slice(0, j).some((item) => anchored(item.type))
        const id = keep ? target.partID : undefined
        return {
          messageID: (!id && last ? last.id : msg.info.id) as MessageID,
          ...(id ? { partID: id as PartID } : {}),
          messageIndex: i,
          partIndex: j,
        }
      }
    }
    return undefined
  }

  // Old SessionRevert patch semantics: only patch parts strictly after the
  // physical anchor. Message-level excludes the first matched part;
  // part-level (including keep=false fallback) excludes parts before and
  // including the target. This is distinct from the planner tool-call
  // interval, which follows cleanup-deletion semantics.
  export const patchesAfter = <P extends { readonly type: string }>(
    messages: readonly { readonly parts: readonly P[] }[],
    boundary: Boundary,
  ): P[] => {
    const out: P[] = []
    for (let i = boundary.messageIndex; i < messages.length; i++) {
      const msg = messages[i]!
      const from = i === boundary.messageIndex ? boundary.partIndex + 1 : 0
      for (let j = from; j < msg.parts.length; j++) {
        const part = msg.parts[j]!
        if (part.type === "patch") out.push(part)
      }
    }
    return out
  }
}
