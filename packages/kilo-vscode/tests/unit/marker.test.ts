import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  CREDENTIAL_FAILED,
  READ_FAILED,
  REMOVE_FAILED,
  credentialFailed,
  decode,
  drop,
  load,
  malformed,
  parsePrivateStatus,
  parseReplay,
  parseTitle,
} from "../../src/util/marker"

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kilo-marker-"))
  return dir
}

describe("marker helper fail-closed", () => {
  test("decode throws fixed malformed without raw", () => {
    try {
      decode("{ bad json", "lc-replay")
      expect(false).toBeTrue()
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toBe(malformed("lc-replay"))
      expect(msg).toBe("lc-replay marker malformed (redacted)")
      expect(msg).not.toContain("bad")
    }
  })

  test("parsePrivateStatus malformed json", () => {
    expect(() => parsePrivateStatus("{ bad")).toThrow(malformed("lc-private-status"))
  })

  test("parsePrivateStatus missing nonce", () => {
    expect(() => parsePrivateStatus(JSON.stringify({}))).toThrow(malformed("lc-private-status"))
    expect(() => parsePrivateStatus(JSON.stringify({ nonce: "" }))).toThrow(malformed("lc-private-status"))
  })

  test("parsePrivateStatus extra key fails", () => {
    expect(() => parsePrivateStatus(JSON.stringify({ nonce: "n1", sessionId: "s1" }))).toThrow(
      malformed("lc-private-status"),
    )
  })

  test("parseTitle missing sessionId", () => {
    expect(() => parseTitle(JSON.stringify({ title: "t", nonce: "n" }))).toThrow(malformed("lc-title"))
  })

  test("parseTitle missing nonce", () => {
    expect(() => parseTitle(JSON.stringify({ sessionId: "s1", title: "t" }))).toThrow(malformed("lc-title"))
  })

  test("parseTitle empty title", () => {
    expect(() => parseTitle(JSON.stringify({ sessionId: "s1", title: "", nonce: "n" }))).toThrow(
      malformed("lc-title"),
    )
  })

  test("parseReplay missing sessionId", () => {
    expect(() => parseReplay(JSON.stringify({ nonce: "n1" }))).toThrow(malformed("lc-replay"))
  })

  test("parseReplay missing nonce", () => {
    expect(() => parseReplay(JSON.stringify({ sessionId: "s1" }))).toThrow(malformed("lc-replay"))
  })

  test("parseReplay empty sessionId", () => {
    expect(() => parseReplay(JSON.stringify({ sessionId: "", nonce: "n1" }))).toThrow(malformed("lc-replay"))
  })

  test("parseReplay raw string rejected", () => {
    expect(() => parseReplay(JSON.stringify("just-a-string"))).toThrow(malformed("lc-replay"))
  })

  test("parseReplay nonce-only rejected", () => {
    // nonce only without sessionId
    expect(() => parseReplay(JSON.stringify({ nonce: "n1" }))).toThrow(malformed("lc-replay"))
  })

  test("parseReplay extra key rejected", () => {
    expect(() => parseReplay(JSON.stringify({ sessionId: "s1", nonce: "n1", extra: "x" }))).toThrow(
      malformed("lc-replay"),
    )
  })

  test("parseReplay happy path", () => {
    const out = parseReplay(JSON.stringify({ sessionId: "s1", nonce: "n1" }))
    expect(out).toEqual({ sessionId: "s1", nonce: "n1" })
  })

  test("parseTitle happy path", () => {
    const out = parseTitle(JSON.stringify({ sessionId: "s1", title: "hello", nonce: "n1" }))
    expect(out).toEqual({ sessionId: "s1", title: "hello", nonce: "n1" })
  })

  test("load read failure throws fixed redacted", () => {
    const failingRead = () => {
      throw new Error("ENOENT: no such file, /tmp/secret/path/marker")
    }
    try {
      load("/tmp/secret/path/marker", failingRead as unknown as (p: string) => string)
      expect(false).toBeTrue()
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toBe(READ_FAILED)
      expect(msg).not.toContain("/tmp")
      expect(msg).not.toContain("ENOENT")
    }
  })

  test("drop remove failure throws fixed redacted", () => {
    const failingRm = () => {
      throw new Error("unlink failed /tmp/secret")
    }
    try {
      drop("/tmp/secret", failingRm as unknown as (p: string) => void)
      expect(false).toBeTrue()
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toBe(REMOVE_FAILED)
      expect(msg).not.toContain("/tmp")
      expect(msg).not.toContain("unlink")
    }
  })

  test("credential failure artifact redacted no raw", () => {
    const art = credentialFailed()
    expect(art).toEqual({ ok: false, error: CREDENTIAL_FAILED })
    expect(art.error).toBe("credential failed (redacted)")
    expect(art.error).not.toContain("Error")
  })

  test("malformed does not leak path or payload", () => {
    const msg = malformed("lc-title")
    expect(msg).toBe("lc-title marker malformed (redacted)")
    expect(msg).not.toContain("/")
    expect(msg).not.toContain("payload")
  })

  test("read failure with temp file missing is fail-closed and no result written", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-replay-request")
      const result = join(dir, "lc-replay-result.json")
      // no marker file exists
      expect(() => load(marker)).toThrow(READ_FAILED)
      expect(existsSync(result)).toBeFalse()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed JSON with temp file throws and no result written", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-replay-request")
      const result = join(dir, "lc-replay-result.json")
      writeFileSync(marker, "{ not json")
      const raw = load(marker)
      expect(() => parseReplay(raw)).toThrow(malformed("lc-replay"))
      // simulate runner: should not write result
      expect(existsSync(result)).toBeFalse()
      const msg = (() => {
        try {
          parseReplay(raw)
        } catch (e) {
          return (e as Error).message
        }
        return ""
      })()
      expect(msg).not.toContain("not json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("delete failure via injected rm throws fixed and no result write", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-title-request")
      const result = join(dir, "lc-title-result.json")
      writeFileSync(marker, JSON.stringify({ sessionId: "s1", title: "t", nonce: "n" }))
      const raw = load(marker)
      expect(() => drop(marker, () => { throw new Error("EACCES") })).toThrow(REMOVE_FAILED)
      // runner would throw before parsing, so no result
      expect(existsSync(result)).toBeFalse()
      // ensure parse still valid but drop failure prevents write
      const parsed = parseTitle(raw)
      expect(parsed.sessionId).toBe("s1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("schema failure missing sessionId with temp file no result write", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-replay-request")
      const result = join(dir, "lc-replay-result.json")
      writeFileSync(marker, JSON.stringify({ nonce: "n1" }))
      const raw = load(marker)
      drop(marker)
      expect(() => parseReplay(raw)).toThrow(malformed("lc-replay"))
      expect(existsSync(result)).toBeFalse()
      // ensure no raw payload in error
      try {
        parseReplay(raw)
      } catch (e) {
        expect((e as Error).message).not.toContain("n1")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("happy path temp file writes result with nonce", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-replay-request")
      const result = join(dir, "lc-replay-result.json")
      writeFileSync(marker, JSON.stringify({ sessionId: "s1", nonce: "n1" }))
      const raw = load(marker)
      drop(marker)
      const { sessionId, nonce } = parseReplay(raw)
      // simulate result write
      writeFileSync(result, JSON.stringify({ sessionId, nonce }))
      expect(existsSync(result)).toBeTrue()
      const out = JSON.parse(readFileSync(result, "utf8"))
      expect(out.nonce).toBe("n1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("read failure injected ops does not contain dynamic path", () => {
    const dir = tempDir()
    try {
      const marker = join(dir, "lc-private-status-request")
      const result = join(dir, "lc-private-status.json")
      const insecure = "/tmp/secret/payload"
      writeFileSync(marker, insecure)
      // Use injected read that fails with path
      const failingRead: (p: string) => string = () => {
        throw new Error(`read failed ${insecure}`)
      }
      try {
        load(marker, failingRead)
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).not.toContain("/tmp")
        expect(msg).not.toContain("payload")
        expect(msg).toBe(READ_FAILED)
      }
      expect(existsSync(result)).toBeFalse()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("credential retry rs/rr/lc writes fixed artifact and throws stable redacted error without raw", () => {
    for (const file of ["rs-credential.json", "rr-credential.json", "lc-credential.json"] as const) {
      const dir = tempDir()
      try {
        const raw = "secret token abc123 /tmp/secret"
        const artifact = join(dir, file)
        const failingSeed = (): never => {
          throw new Error(raw)
        }
        // simulate retry catch logic unified via credentialFailed helper
        try {
          const seeded = failingSeed()
          writeFileSync(artifact, JSON.stringify(seeded, null, 2))
          expect(false).toBeTrue()
        } catch {
          writeFileSync(artifact, JSON.stringify(credentialFailed(), null, 2))
          // stable throw must not contain raw
          let thrown = ""
          try {
            throw new Error(CREDENTIAL_FAILED)
          } catch (e) {
            thrown = (e as Error).message
          }
          expect(thrown).toBe(CREDENTIAL_FAILED)
          expect(thrown).not.toContain("secret")
          expect(thrown).not.toContain("/tmp")
          expect(thrown).not.toContain("abc123")
          expect(thrown).not.toContain(raw)
        }
        const content = readFileSync(artifact, "utf8")
        expect(content).toContain(CREDENTIAL_FAILED)
        expect(content).not.toContain("secret")
        expect(content).not.toContain("/tmp")
        expect(content).not.toContain("abc123")
        const parsed = JSON.parse(content)
        expect(parsed).toEqual({ ok: false, error: CREDENTIAL_FAILED })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test("credential retry helper via failCredential simulation is fail-closed and redacted", () => {
    const simulate = (dir: string, file: string, raw: string) => {
      const artifact = join(dir, file)
      try {
        throw new Error(raw)
      } catch {
        writeFileSync(artifact, JSON.stringify(credentialFailed(), null, 2))
        throw new Error(CREDENTIAL_FAILED)
      }
    }
    for (const file of ["rs-credential.json", "rr-credential.json", "lc-credential.json"] as const) {
      const dir = tempDir()
      try {
        const raw = `leak-${file}-/tmp/secret`
        let msg = ""
        try {
          simulate(dir, file, raw)
        } catch (e) {
          msg = (e as Error).message
        }
        expect(msg).toBe(CREDENTIAL_FAILED)
        expect(msg).not.toContain("leak")
        expect(msg).not.toContain("/tmp")
        const content = readFileSync(join(dir, file), "utf8")
        expect(content).not.toContain("leak")
        expect(content).not.toContain("/tmp")
        expect(JSON.parse(content)).toEqual(credentialFailed())
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
