import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { wirePeerCloseObservation } from "../../src/agent-manager/peer-close-wiring"

const ROOT = path.resolve(import.meta.dir, "../..")
const EXT = path.join(ROOT, "src/extension.ts")
const WIRING = path.join(ROOT, "src/agent-manager/peer-close-wiring.ts")

describe("Extension activation ordering — peer-close race closed", () => {
  it("constructs PrivateObservationService and triggers before provider, installs hook before initialize, no TDZ", () => {
    const txt = fs.readFileSync(EXT, "utf-8")
    const wiringTxt = fs.readFileSync(WIRING, "utf-8")
    const idxService = txt.indexOf("new PrivateObservationService")
    const idxTriggers = txt.indexOf("PrivateObservationLifecycleTriggers.wireVscode")
    const idxProvider = txt.indexOf("new AgentManagerProvider")
    const idxHook = txt.indexOf("wirePeerCloseObservation(privateObservation")
    const idxInit = txt.indexOf("privateObservation.initialize()")
    expect(idxService).toBeGreaterThan(-1)
    expect(idxTriggers).toBeGreaterThan(-1)
    expect(idxProvider).toBeGreaterThan(-1)
    expect(idxHook).toBeGreaterThan(-1)
    expect(idxInit).toBeGreaterThan(-1)
    expect(idxService).toBeLessThan(idxTriggers)
    expect(idxTriggers).toBeLessThan(idxProvider)
    expect(idxProvider).toBeLessThan(idxHook)
    expect(idxHook).toBeLessThan(idxInit)
    const beforeProvider = txt.slice(0, idxProvider)
    expect(beforeProvider).not.toContain("privateObservation.initialize()")
    // wiring file must contain the setOnPeerClosed install and logging
    expect(wiringTxt).toContain("setOnPeerClosed")
    expect(wiringTxt).toContain("handlePeerCloseObservation(result)")
  })

  it("fires and forgets initialize with fail-closed logging, and hook callback catches/logs without empty catch or unknown cast", () => {
    const txt = fs.readFileSync(EXT, "utf-8")
    const wiringTxt = fs.readFileSync(WIRING, "utf-8")
    expect(txt).toContain('privateObservation.initialize().catch((err) => {')
    expect(txt).toContain('PrivateObservationService initialize failed (fail-closed)')
    expect(wiringTxt).toContain("handlePeerCloseObservation(result)")
    expect(wiringTxt).not.toContain("as unknown as { handlePeerCloseObservation")
    const hookSection = wiringTxt.slice(wiringTxt.indexOf("setOnPeerClosed"), wiringTxt.indexOf("peer-close observation handling failed") + 50)
    expect(hookSection).not.toMatch(/\}\s*catch\s*\{\s*\}/)
    expect(hookSection).toContain("privateObservation peer-close trigger failed")
    expect(hookSection).toContain("peer-close observation handling failed")
    const idxTriggersDef = txt.indexOf("const privateObservationTriggers")
    const idxHook = txt.indexOf("wirePeerCloseObservation(privateObservation")
    expect(idxTriggersDef).toBeLessThan(idxHook)
    const idxProviderDef = txt.indexOf("const agentManagerProvider")
    expect(idxProviderDef).toBeLessThan(idxHook)
    const providerTxt = fs.readFileSync(path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts"), "utf-8")
    expect(providerTxt).not.toContain("as unknown as { handlePeerCloseObservation")
  })

  it("provider exposes single typed handlePeerCloseObservation and has getPersistedCursor for freshness", () => {
    const providerTxt = fs.readFileSync(path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts"), "utf-8")
    expect(providerTxt).toContain("handlePeerCloseObservation(result: TriggerResult")
    expect(providerTxt).not.toContain("handlePeerCloseResult")
    expect(providerTxt).not.toContain("consumePeerCloseResult")
    expect(providerTxt).toContain("getPersistedCursor()")
    expect(providerTxt).toContain("current persisted cursor")
    const coordTxt = fs.readFileSync(path.join(ROOT, "src/agent-manager/observation-coordinator.ts"), "utf-8")
    expect(coordTxt).toContain("getPersistedCursor()")
    expect(coordTxt).toContain("decideFromReadResult")
  })

  it("peer-close hook trigger delivered after init ordering via wirePeerCloseObservation seam (hook installed before initialize)", () => {
    const txt = fs.readFileSync(EXT, "utf-8")
    const activateIdx = txt.indexOf("export function activate")
    const block = txt.slice(activateIdx)
    const hookIdx = block.indexOf("wirePeerCloseObservation(privateObservation")
    const initIdx = block.indexOf("privateObservation.initialize()")
    expect(hookIdx).toBeGreaterThan(-1)
    expect(initIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(initIdx)
    const initLine = block.slice(initIdx, initIdx + 200)
    expect(initLine).toContain(".catch")
    expect(block.slice(hookIdx - 500, hookIdx)).not.toContain("await privateObservation.initialize")
  })

  it("executable seam: wirePeerCloseObservation installs hook before initialize and immediate close reaches provider", async () => {
    const order: string[] = []
    let captured: (() => void) | undefined
    const fakeService: any = {
      setOnPeerClosed: (cb: () => void) => {
        order.push("hook")
        captured = cb
      },
      initialize: () => {
        order.push("initialize")
        return Promise.resolve()
      },
    }
    const expectedResult = { reason: "peer:closed", reconnectResult: {}, requestedCursor: 5, readResult: { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] } }
    let triggerCalls = 0
    const fakeTriggers: any = {
      onPeerClosed: async () => {
        triggerCalls++
        return expectedResult
      },
    }
    let providerReceived: unknown = undefined
    let providerCalls = 0
    const fakeProvider: any = {
      handlePeerCloseObservation: async (r: unknown) => {
        providerCalls++
        providerReceived = r
      },
    }
    wirePeerCloseObservation(fakeService, fakeTriggers, fakeProvider)
    expect(order).toEqual(["hook"])
    expect(captured).toBeDefined()
    // simulate initialize after hook (race closed)
    order.push("initialize")
    // immediate close before initialize completes
    captured!()
    // allow async void to run
    await new Promise((r) => setTimeout(r, 10))
    expect(triggerCalls).toBe(1)
    expect(providerCalls).toBe(1)
    expect(providerReceived).toEqual(expectedResult)
    expect(order[0]).toBe("hook")
    expect(order[1]).toBe("initialize")
  })

  it("executable seam: trigger failure still reaches provider with undefined and logs", async () => {
    let captured: (() => void) | undefined
    const fakeService: any = {
      setOnPeerClosed: (cb: () => void) => {
        captured = cb
      },
    }
    const fakeTriggers: any = {
      onPeerClosed: async () => {
        throw new Error("reconnect boom")
      },
    }
    let providerReceived: unknown = "not-called"
    let providerCalls = 0
    const fakeProvider: any = {
      handlePeerCloseObservation: async (r: unknown) => {
        providerCalls++
        providerReceived = r
      },
    }
    const warn: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warn.push(String(args[0]))
    try {
      wirePeerCloseObservation(fakeService, fakeTriggers, fakeProvider)
      captured!()
      await new Promise((r) => setTimeout(r, 10))
      expect(providerCalls).toBe(1)
      expect(providerReceived).toBeUndefined()
      expect(warn.join(" ")).toContain("privateObservation peer-close trigger failed")
    } finally {
      console.warn = origWarn
    }
  })
})
