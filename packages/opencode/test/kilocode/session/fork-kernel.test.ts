// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "fs"
import { join } from "path"
import { canonicalDirectory, cloneMessageDataForFork, clonePartDataForFork, filterMessagesForFork, getForkedTitle, resolveForkModelAtCheckpoint, sessionPath } from "../../../src/kilocode/session/fork"
import { prepareForkedPart } from "../../../src/kilocode/session/fork"
import { canonicalDirectory as canonicalFromForkDispatch } from "../../../src/kilocode/session/session-fork-dispatch"
import { canonicalDirectory as canonicalFromUpdate } from "../../../src/kilocode/session/session-update-dispatch"
import { canonicalDirectory as canonicalFromCancel } from "../../../src/kilocode/session/cancel-queued-dispatch"
import { canonicalDirectory as canonicalFromNeutral } from "../../../src/kilocode/session/canonical-directory"

describe("fork kernel pure helpers", () => {
  test("getForkedTitle increments", () => {
    expect(getForkedTitle("hello")).toBe("hello (fork #1)")
    expect(getForkedTitle("hello (fork #1)")).toBe("hello (fork #2)")
    expect(getForkedTitle("hello (fork #12)")).toBe("hello (fork #13)")
    expect(getForkedTitle("a (fork #1) extra")).toBe("a (fork #1) extra (fork #1)")
  })

  test("canonicalDirectory normalizes and validates", () => {
    expect(canonicalDirectory("/tmp/a/../b")).toBe("/tmp/b")
    expect(canonicalDirectory("/tmp//a///b")).toBe("/tmp/a/b")
    expect(() => canonicalDirectory("relative/path")).toThrow()
    expect(() => canonicalDirectory("/tmp/\0evil")).toThrow()
    // re-exported variants must be same canonical function (and neutral module is the source)
    expect(canonicalFromForkDispatch("/tmp/a")).toBe(canonicalDirectory("/tmp/a"))
    expect(canonicalFromUpdate("/tmp/a")).toBe(canonicalDirectory("/tmp/a"))
    expect(canonicalFromCancel("/tmp/a")).toBe(canonicalDirectory("/tmp/a"))
    expect(canonicalFromNeutral("/tmp/a")).toBe(canonicalDirectory("/tmp/a"))
  })

  test("sessionPath computes relative", () => {
    expect(sessionPath("/a/worktree", "/a/worktree")).toBe("")
    expect(sessionPath("/a/worktree", "/a/worktree/sub/dir")).toBe("sub/dir")
    expect(sessionPath("/a/worktree", "/a/worktree/sub")).toBe("sub")
  })

  test("filterMessagesForFork ordered prefix - checkpoint truncates at first id >= checkpoint", () => {
    const items = [{ id: "msg_0001" }, { id: "msg_0002" }, { id: "msg_0003" }]
    expect(filterMessagesForFork(items, undefined).length).toBe(3)
    expect(filterMessagesForFork(items, null).length).toBe(3)
    expect(filterMessagesForFork(items, "msg_0002").map((x) => x.id)).toEqual(["msg_0001"])
    expect(filterMessagesForFork(items, "msg_9999").length).toBe(3)
    expect(filterMessagesForFork(items, "msg_9999").map((x) => x.id)).toEqual(["msg_0001", "msg_0002", "msg_0003"])
    expect(filterMessagesForFork(items, "msg_0001").length).toBe(0)
    // ordered prefix: checkpoint in middle returns prefix, not filtered scattered
    const items2 = [{ id: "msg_0001" }, { id: "msg_0002" }, { id: "msg_0003" }, { id: "msg_0004" }]
    expect(filterMessagesForFork(items2, "msg_0003").map((x) => x.id)).toEqual(["msg_0001", "msg_0002"])
    // checkpoint absent preserves all (same ordering)
    expect(filterMessagesForFork(items2, null)).toEqual(items2)
    // returns new array when checkpoint present, not same reference
    const out = filterMessagesForFork(items2, "msg_0003")
    expect(out).not.toBe(items2)
  })

  test("filterMessagesForFork non-monotonic input documents legacy prefix contract", () => {
    // Legacy Session.fork did `for (const msg of msgs) { if (input.messageID && msg.info.id >= input.messageID) break }`
    // That is prefix truncation, not a global filter. For non-monotonic ordered input, prefix and filter diverge.
    // Canonical kernel must preserve prefix semantics because callers supply canonically ordered rows.
    const nonMono = [{ id: "msg_0001" }, { id: "msg_0003" }, { id: "msg_0002" }, { id: "msg_0004" }]
    // prefix with checkpoint msg_0003 stops at second element (first >= checkpoint)
    const prefix = filterMessagesForFork(nonMono, "msg_0003")
    expect(prefix.map((x) => x.id)).toEqual(["msg_0001"])
    // a global filter would have returned ["msg_0001","msg_0002"] — must NOT happen
    const globalFilter = nonMono.filter((r) => r.id < "msg_0003")
    expect(globalFilter.map((x) => x.id)).toEqual(["msg_0001", "msg_0002"])
    expect(prefix.map((x) => x.id)).not.toEqual(globalFilter.map((x) => x.id))
    // also checkpoint beyond all still returns all even for non-monotonic
    expect(filterMessagesForFork(nonMono, "msg_9999").map((x) => x.id)).toEqual(["msg_0001", "msg_0003", "msg_0002", "msg_0004"])
  })

  test("resolveForkModelAtCheckpoint - no checkpoint returns sourceModel clone", () => {
    const src = { id: "m1", providerID: "p1", variant: "v1" }
    const out = resolveForkModelAtCheckpoint({ sourceModel: src, checkpointId: null, orderedMessages: [] })
    expect(out).toEqual(src)
    expect(out).not.toBe(src) // clone
    expect(resolveForkModelAtCheckpoint({ sourceModel: null, checkpointId: null, orderedMessages: [] })).toBeUndefined()
  })

  test("resolveForkModelAtCheckpoint - with checkpoint finds last user before id (prefix semantics)", () => {
    const msgs = [
      { id: "msg_0001", role: "user", model: { modelID: "u1", providerID: "pA", variant: "vA" } },
      { id: "msg_0002", role: "assistant", model: undefined },
      { id: "msg_0003", role: "user", model: { modelID: "u2", providerID: "pB" } },
      { id: "msg_0004", role: "assistant", model: undefined },
    ]
    // checkpoint at msg_0003 => prefix ids < msg_0003 => msg_0001, msg_0002 => last user is msg_0001
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0003", orderedMessages: msgs })).toEqual({ id: "u1", providerID: "pA", variant: "vA" })
    // checkpoint at msg_0004 => prefix includes msg_0003 => last user is msg_0003
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0004", orderedMessages: msgs })).toEqual({ id: "u2", providerID: "pB" })
    // checkpoint at msg_0002 => only msg_0001 => u1
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0002", orderedMessages: msgs })).toEqual({ id: "u1", providerID: "pA", variant: "vA" })
    // no user before checkpoint => undefined (not fallback to source)
    const noUser = [{ id: "msg_0001", role: "assistant", model: undefined }]
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0002", orderedMessages: noUser })).toBeUndefined()
    // user without model => undefined
    const userNoModel = [{ id: "msg_0001", role: "user", model: undefined }]
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0002", orderedMessages: userNoModel })).toBeUndefined()
    // model shape with id/providerID (source style) also normalized
    const altShape = [{ id: "msg_0001", role: "user", model: { id: "alt1", providerID: "pAlt", variant: "vAlt" } }]
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0002", orderedMessages: altShape })).toEqual({ id: "alt1", providerID: "pAlt", variant: "vAlt" })
  })

  test("resolveForkModelAtCheckpoint non-monotonic prefix consistency", () => {
    // Ensures model resolution uses same prefix contract as filterMessagesForFork, not global filter.
    const msgs = [
      { id: "msg_0001", role: "user", model: { modelID: "u1", providerID: "pA" } },
      { id: "msg_0003", role: "user", model: { modelID: "u3", providerID: "pC" } },
      { id: "msg_0002", role: "user", model: { modelID: "u2", providerID: "pB" } },
      { id: "msg_0004", role: "assistant", model: undefined },
    ]
    // checkpoint msg_0003 => prefix is [msg_0001] => last user before checkpoint is u1
    expect(resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0003", orderedMessages: msgs })).toEqual({ id: "u1", providerID: "pA" })
    // global filter would include msg_0002 (< msg_0003 but after the checkpoint) and return u2 — must not
    const globalFiltered = msgs.filter((m) => m.id < "msg_0003")
    const lastViaFilter = [...globalFiltered].reverse().find((m) => m.role === "user")
    expect(lastViaFilter?.id).toBe("msg_0002")
    // kernel prefix must differ
    const viaPrefix = resolveForkModelAtCheckpoint({ sourceModel: { id: "src", providerID: "pX" }, checkpointId: "msg_0003", orderedMessages: msgs })
    expect(viaPrefix?.id).not.toBe(lastViaFilter?.model?.modelID)
    expect(viaPrefix?.id).toBe("u1")
  })

  test("cloneMessageDataForFork canonical parent policy (assistant-only, unmapped keeps original)", () => {
    const idMap = new Map([["msg_0001", "msg_9001"]])
    // assistant with mapped parent -> remapped
    const old = { role: "assistant", cost: 123, parentID: "msg_0001", extra: 1 }
    const cloned = cloneMessageDataForFork(old as any, idMap as any)
    expect(cloned.cost).toBe(0)
    expect(cloned.parentID).toBe("msg_9001")
    expect(cloned.extra).toBe(1)

    // assistant with unmapped parent -> keeps original (legacy behavior)
    const old2 = { role: "assistant", cost: 5, parentID: "msg_0002" }
    const cloned2 = cloneMessageDataForFork(old2 as any, idMap as any)
    expect(cloned2.cost).toBe(0)
    expect(cloned2.parentID).toBe("msg_0002")

    // user with mapped parent -> must NOT remap (canonical assistant-only policy)
    const user = { role: "user", cost: 99, parentID: "msg_0001", extra: 2 }
    const clonedUser = cloneMessageDataForFork(user as any, idMap as any)
    expect(clonedUser.cost).toBe(99)
    expect(clonedUser.parentID).toBe("msg_0001")

    // message without parent -> stays without parent, assistant cost still reset
    const noParent = { role: "assistant", cost: 7 }
    const clonedNoPar = cloneMessageDataForFork(noParent as any, idMap as any)
    expect(clonedNoPar.cost).toBe(0)
    expect(clonedNoPar.parentID).toBeUndefined()
  })

  test("cloneMessageDataForFork regression: divergent any-role mapping would be wrong", () => {
    // This is the divergent policy that existed in session-fork-dispatch before the kernel fix:
    // it remapped any parentID regardless of role. The kernel must NOT do that.
    const idMap = new Map([["msg_0001", "msg_9999"]])
    const divergentClone = (oldData: Record<string, unknown>) => {
      const raw = oldData.parentID as string | undefined
      const mapped = raw ? idMap.get(raw) : undefined
      return { ...oldData, parentID: mapped ?? raw }
    }
    const userOld = { role: "user", parentID: "msg_0001" } as any
    const kernel = cloneMessageDataForFork(userOld, idMap as any)
    const divergent = divergentClone(userOld)
    // divergent would incorrectly remap user parent
    expect(divergent.parentID).toBe("msg_9999")
    // kernel must preserve original
    expect(kernel.parentID).toBe("msg_0001")
    expect(kernel.parentID).not.toBe(divergent.parentID)
  })

  test("clonePartDataForFork resets step-finish cost and remaps compaction tail (mapped vs unmapped)", () => {
    const partFinish = { type: "step-finish", cost: 77, id: "old", messageID: "m1", sessionID: "s1" } as any
    const mappedFinish = clonePartDataForFork(partFinish, new Map())
    expect(mappedFinish.cost).toBe(0)

    const partComp = { type: "compaction", tail_start_id: "msg_0001", id: "old", messageID: "m1", sessionID: "s1" } as any
    const idMap = new Map([["msg_0001", "msg_9999"]])
    const mappedComp = clonePartDataForFork(partComp, idMap as any)
    expect(mappedComp.tail_start_id).toBe("msg_9999")

    // unmapped tail must become undefined (legacy Session.fork behavior), not retained original
    const partCompUnmapped = { type: "compaction", tail_start_id: "msg_0005", id: "old", messageID: "m1", sessionID: "s1" } as any
    const mappedUn = clonePartDataForFork(partCompUnmapped, idMap as any)
    expect(mappedUn.tail_start_id).toBeUndefined()

    const partOther = { type: "text", text: "hi", id: "old", messageID: "m1", sessionID: "s1" } as any
    const mappedOther = clonePartDataForFork(partOther, idMap as any)
    expect(mappedOther.text).toBe("hi")
  })

  test("clonePartDataForFork unmapped tail contract regression (legacy undefined vs stale retain)", () => {
    const idMap = new Map([["msg_0001", "msg_9999"]])
    const unmapped = { type: "compaction", tail_start_id: "msg_9999_unknown", id: "old", messageID: "m1", sessionID: "s1" } as any
    // old durable helper kept original id when unmapped
    const oldDurableRetain = (() => {
      const base = { ...unmapped }
      const mapped = idMap.get(base.tail_start_id)
      if (mapped) base.tail_start_id = mapped
      return base
    })()
    expect(oldDurableRetain.tail_start_id).toBe("msg_9999_unknown")
    // kernel must assign undefined
    const kernel = clonePartDataForFork(unmapped, idMap as any)
    expect(kernel.tail_start_id).toBeUndefined()
    expect(kernel.tail_start_id).not.toBe(oldDurableRetain.tail_start_id)
  })

  test("prepareForkedPart drops transient and detaches task", () => {
    const transient = { type: "text", text: "x", metadata: { "kilocode.lifecycle": "transient" }, id: "prt_1", messageID: "msg_1", sessionID: "ses_1" } as any
    expect(prepareForkedPart(transient)).toBeUndefined()
    const taskPending = { type: "tool", tool: "task", metadata: { sessionId: "s" }, state: { status: "pending", input: { task_id: "t", foo: 1 } } } as any
    const out = prepareForkedPart(taskPending) as any
    expect(out.state.status).toBe("error")
    expect(out.state.input.task_id).toBeUndefined()
    expect(out.metadata.sessionId).toBeUndefined()
  })
})

describe("fork kernel caller wiring (source-level)", () => {
  const sessionPath = join(import.meta.dir, "../../../src/session/session.ts")
  const dispatchPath = join(import.meta.dir, "../../../src/kilocode/session/session-fork-dispatch.ts")
  const sessionText = readFileSync(sessionPath, "utf8")
  const dispatchText = readFileSync(dispatchPath, "utf8")

  test("Session.fork imports and delegates to canonical kernel, no local fork policy", () => {
    // must import from canonical kernel
    expect(sessionText).toContain('from "@/kilocode/session/fork"')
    expect(sessionText).toContain("getForkedTitle")
    expect(sessionText).toContain("sessionPath")
    expect(sessionText).toContain("filterMessagesForFork")
    expect(sessionText).toContain("resolveForkModelAtCheckpoint")
    expect(sessionText).toContain("cloneMessageDataForFork")
    expect(sessionText).toContain("clonePartDataForFork")
    // must delegate filtering through kernel, not local loop break
    expect(sessionText).toContain("filterMessagesForFork(msgs")
    // no legacy local checkpoint break policy
    expect(sessionText).not.toContain("if (input.messageID && msg.info.id >=")
    expect(sessionText).not.toContain("msg.info.id < point")
    // no local parent remap duplication (assistant-only policy lives in kernel)
    // legacy had: `msg.info.role === \"assistant\" && msg.info.parentID ? idMap.get`
    expect(sessionText).not.toContain('msg.info.role === "assistant" && msg.info.parentID')
    // no local tail remap duplication
    expect(sessionText).not.toContain("p.tail_start_id = idMap.get")
    expect(sessionText).not.toContain("tail_start_id: idMap.get")
  })

  test("SessionForkDispatch imports and delegates to canonical kernel, no local fork policy", () => {
    expect(dispatchText).toContain('from "@/kilocode/session/fork"')
    expect(dispatchText).toContain("getForkedTitle")
    expect(dispatchText).toContain("sessionPath")
    expect(dispatchText).toContain("filterMessagesForFork")
    expect(dispatchText).toContain("resolveForkModelAtCheckpoint")
    expect(dispatchText).toContain("cloneMessageDataForFork")
    expect(dispatchText).toContain("clonePartDataForFork")
    expect(dispatchText).toContain("filterMessagesForFork(msgRows")
    // no legacy divergent parent policy (any-role remap) should remain
    // durable old code had: `const mapped = raw ? idMap.get(raw) : undefined` without role check inside dispatch
    // now it must go through cloneMessageDataForFork, so raw parent remap without role guard must not appear
    // we assert the file does not contain a local inline parent mapping that bypasses kernel
    const hasLocalParentPolicy = dispatchText.includes("oldData.parentID") || dispatchText.includes("raw ? idMap.get")
    // these strings only exist in fork.ts kernel, not in dispatch after refactor
    expect(hasLocalParentPolicy).toBe(false)
    // no local tail or cost duplication
    expect(dispatchText).not.toContain("tail_start_id = idMap.get")
    expect(dispatchText).not.toContain("tail_start_id: idMap.get")
    // ensure ordering is canonical (asc time_created, asc id) and not re-sorted locally
    expect(dispatchText).toContain("orderBy(asc(MessageTable.time_created), asc(MessageTable.id))")
  })

  test("both callers share kernel for title/path/model/checkpoint - identical helpers", () => {
    // Prove both callers reference the same canonical symbols, not duplicated implementations
    const kernelSymbols = ["getForkedTitle", "sessionPath", "filterMessagesForFork", "resolveForkModelAtCheckpoint", "cloneMessageDataForFork", "clonePartDataForFork"]
    for (const sym of kernelSymbols) {
      expect(sessionText).toContain(sym)
      expect(dispatchText).toContain(sym)
    }
    // No caller reintroduces checkpoint filter policy via Array.prototype.filter on ids directly
    // (kernel owns checkpoint semantics; callers only call kernel)
    const sessionHasInlineFilter = /filter\s*\(\s*\(m\)\s*=>\s*m\.id\s*</.test(sessionText) || /filter\s*\(\s*\(r\)\s*=>\s*r\.id\s*</.test(sessionText)
    const dispatchHasInlineFilter = /filter\s*\(\s*\(m\)\s*=>\s*m\.id\s*</.test(dispatchText) || /filter\s*\(\s*\(r\)\s*=>\s*r\.id\s*</.test(dispatchText)
    expect(sessionHasInlineFilter).toBe(false)
    expect(dispatchHasInlineFilter).toBe(false)
  })
})
