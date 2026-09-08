import { describe, expect, it } from "bun:test"
import { agentOptions } from "./agent-options"
import { VscodeHost } from "./vscode-host"

function reader() {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [] }),
    get: async () => ({ v: "1.0", status: "not_found" }),
    messages: async () => ({ v: "1.0", status: "not_found" }),
  }
}

function hostWith(readerValue: unknown) {
  return new VscodeHost(
    { fsPath: "/tmp" } as never,
    {} as never,
    {} as never,
    {} as never,
    { materializationReady: true } as never,
    readerValue as never,
  )
}

describe("agent-options private handoff", () => {
  it("pure helper keeps reader identity when present", () => {
    const r = reader()
    const cfg = { materializationReady: true } as never
    const opts = agentOptions(cfg, r as never)
    expect(opts.privateSessionReader).toBe(r as never)
    expect(opts.platform).toBe("agent-manager")
    expect(opts.snapshotInitialization).toBe("wait")
    expect(opts.slimEditMetadata).toBeTrue()
    expect(opts.disableViewedRegistration).toBeTrue()
    expect(opts.canonicalConfig).toBe(cfg as never)
  })

  it("pure helper omits key when reader null/undefined", () => {
    const cfg = {} as never
    for (const v of [null, undefined]) {
      const opts = agentOptions(cfg, v)
      expect("privateSessionReader" in opts).toBeFalse()
    }
  })

  it("VscodeHost providerOpts carries reader into KiloProvider options", () => {
    const r = reader()
    const withReader = hostWith(r).providerOpts()
    expect(withReader.privateSessionReader).toBe(r as never)
  })

  it("VscodeHost providerOpts omits key without reader", () => {
    for (const v of [null, undefined]) {
      const opts = hostWith(v).providerOpts()
      expect("privateSessionReader" in opts).toBeFalse()
    }
  })
})
