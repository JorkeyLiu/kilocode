import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as os from "os"
import { resolveCanonicalDataDir, resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"

describe("canonical-db-path R9 production-enablement resolver", () => {
  it("resolves to XDG_DATA_HOME/kilo/kilo.db when XDG_DATA_HOME set (absolute, channel-disabled identity)", () => {
    const env = { XDG_DATA_HOME: "/tmp/custom-xdg-data" } as NodeJS.ProcessEnv
    expect(resolveCanonicalDataDir({ env, homedir: "/home/tester" })).toBe("/tmp/custom-xdg-data/kilo")
    expect(resolveCanonicalDbPath({ env, homedir: "/home/tester" })).toBe("/tmp/custom-xdg-data/kilo/kilo.db")
    expect(path.isAbsolute(resolveCanonicalDbPath({ env, homedir: "/home/tester" }))).toBe(true)
    expect(resolveCanonicalDbPath({ env, homedir: "/home/tester" })).toBe(
      path.join("/tmp/custom-xdg-data", "kilo", "kilo.db"),
    )
  })

  it("falls back to homedir/.local/share/kilo/kilo.db when XDG_DATA_HOME unset or empty", () => {
    const home = "/home/tester"
    expect(resolveCanonicalDbPath({ env: {}, homedir: home })).toBe(
      path.join(home, ".local", "share", "kilo", "kilo.db"),
    )
    expect(resolveCanonicalDbPath({ env: { XDG_DATA_HOME: "" } as NodeJS.ProcessEnv, homedir: home })).toBe(
      path.join(home, ".local", "share", "kilo", "kilo.db"),
    )
    expect(
      resolveCanonicalDbPath({ env: { XDG_DATA_HOME: undefined } as unknown as NodeJS.ProcessEnv, homedir: home }),
    ).toBe(path.join(home, ".local", "share", "kilo", "kilo.db"))
    expect(path.isAbsolute(resolveCanonicalDbPath({ env: {}, homedir: home }))).toBe(true)
  })

  it("defensively strips CR/LF from XDG_DATA_HOME and homedir (mirrors Global clean)", () => {
    const env = { XDG_DATA_HOME: "/tmp/xdg-data\n" } as NodeJS.ProcessEnv
    const home = "/home/tester\r\n"
    // env takes precedence and is cleaned
    expect(resolveCanonicalDbPath({ env, homedir: home })).toBe("/tmp/xdg-data/kilo/kilo.db")
    // fallback also cleaned
    expect(resolveCanonicalDbPath({ env: {}, homedir: home })).toBe(
      path.join("/home/tester", ".local", "share", "kilo", "kilo.db"),
    )
  })

  it("is pure/testable: does not read process.env or os.homedir when injectables provided, and matches real env when not provided", () => {
    const injected = resolveCanonicalDbPath({
      env: { XDG_DATA_HOME: "/tmp/injected" } as NodeJS.ProcessEnv,
      homedir: "/home/injected",
    })
    expect(injected).toBe("/tmp/injected/kilo/kilo.db")
    const real = resolveCanonicalDbPath()
    expect(path.isAbsolute(real)).toBe(true)
    expect(real.endsWith(path.join("kilo", "kilo.db"))).toBe(true)
    // real path must be under XDG_DATA_HOME or homedir fallback, never config root or globalStorage
    expect(real).not.toContain(".config/kilo")
    expect(real).not.toContain("globalStorage")
  })

  it("matches runtime Global.Path.data/kilo.db semantics (single canonical identity, not per-channel)", () => {
    // Channel-disabled identity is Global.Path.data/kilo.db, where Global.Path.data is XDG_DATA_HOME/kilo or homedir/.local/share/kilo
    const env = { XDG_DATA_HOME: "/tmp/xdg-data" } as NodeJS.ProcessEnv
    const home = os.homedir()
    const expectedDataDir = "/tmp/xdg-data/kilo"
    expect(resolveCanonicalDataDir({ env, homedir: home })).toBe(expectedDataDir)
    expect(resolveCanonicalDbPath({ env, homedir: home })).toBe(path.join(expectedDataDir, "kilo.db"))
    // Not per-channel: must be exactly kilo.db, not kilo-<channel>.db or opencode-<channel>.db
    expect(path.basename(resolveCanonicalDbPath({ env, homedir: home }))).toBe("kilo.db")
    expect(resolveCanonicalDbPath({ env, homedir: home })).not.toMatch(/kilo-.*\.db/)
    expect(resolveCanonicalDbPath({ env, homedir: home })).not.toMatch(/opencode-.*\.db/)
  })

  it("rejects when no homedir and no XDG_DATA_HOME (fail-closed, no relative fallback)", () => {
    expect(() => resolveCanonicalDataDir({ env: {}, homedir: "" })).toThrow()
    expect(() => resolveCanonicalDbPath({ env: {}, homedir: "" })).toThrow()
  })

  it("strict canonical absolute: relative XDG_DATA_HOME is ignored, falls back to homedir absolute (fail-closed for relative identity)", () => {
    const envRel = { XDG_DATA_HOME: "relative/xdg" } as NodeJS.ProcessEnv
    const home = "/home/tester"
    expect(resolveCanonicalDbPath({ env: envRel, homedir: home })).toBe(
      path.join(home, ".local", "share", "kilo", "kilo.db"),
    )
    expect(path.isAbsolute(resolveCanonicalDbPath({ env: envRel, homedir: home }))).toBe(true)
    const envRelLf = { XDG_DATA_HOME: "relative/xdg\n" } as NodeJS.ProcessEnv
    expect(resolveCanonicalDbPath({ env: envRelLf, homedir: home })).toBe(
      path.join(home, ".local", "share", "kilo", "kilo.db"),
    )
  })

  it("rejects when resolved base would be relative (relative homedir without absolute XDG, fail-closed)", () => {
    expect(() => resolveCanonicalDataDir({ env: {}, homedir: "relative/home" })).toThrow()
    expect(() => resolveCanonicalDbPath({ env: {}, homedir: "relative/home" })).toThrow()
    expect(() =>
      resolveCanonicalDataDir({
        env: { XDG_DATA_HOME: "relative/xdg" } as NodeJS.ProcessEnv,
        homedir: "relative/home",
      }),
    ).toThrow()
  })

  it("always returns absolute canonical path ending with kilo/kilo.db, never config or globalStorage, when inputs absolute", () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; homedir: string }> = [
      { env: { XDG_DATA_HOME: "/tmp/abs1" } as NodeJS.ProcessEnv, homedir: "/home/a" },
      { env: {} as NodeJS.ProcessEnv, homedir: "/home/b" },
      { env: { XDG_DATA_HOME: "/var/data\n" } as NodeJS.ProcessEnv, homedir: "/home/c\r\n" },
    ]
    for (const c of cases) {
      const p = resolveCanonicalDbPath(c)
      expect(path.isAbsolute(p)).toBe(true)
      expect(p.endsWith(path.join("kilo", "kilo.db"))).toBe(true)
      expect(p).not.toContain("globalStorage")
      expect(p).not.toContain(".config/kilo")
      expect(path.basename(p)).toBe("kilo.db")
    }
  })
})
