import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

function isLegacy(pathname: string): boolean {
  if (pathname === "/sync" || pathname.startsWith("/sync/")) return true
  if (pathname === "/experimental/workspace/warp") return true
  if (pathname === "/api/workspace/warp") return true
  if (pathname === "/global/upgrade") return true
  return false
}

function isHexChar(c: string): boolean {
  const code = c.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}

function rawPathname(reqUrl: string): string {
  let start = 0
  const proto = reqUrl.indexOf("://")
  if (proto !== -1) {
    const slash = reqUrl.indexOf("/", proto + 3)
    if (slash === -1) return "/"
    start = slash
  } else if (reqUrl.length > 0 && reqUrl[0] !== "/") {
    // absolute without scheme? treat as path starting at first "/"
    const slash = reqUrl.indexOf("/")
    if (slash !== -1) start = slash
    else return "/"
  }
  let end = reqUrl.length
  for (let i = start; i < reqUrl.length; i++) {
    const ch = reqUrl[i]
    if (ch === "?" || ch === "#" || ch === ";") {
      end = i
      break
    }
  }
  const raw = reqUrl.slice(start, end)
  return raw.length === 0 ? "/" : raw
}

function canonicalForLegacy(raw: string): string | null {
  let cur = raw.length === 0 ? "/" : raw
  if (cur[0] !== "/") cur = "/" + cur
  {
    const s = cur.indexOf(";")
    if (s !== -1) cur = cur.slice(0, s)
  }
  for (let iter = 0; iter < 4; iter++) {
    const low = cur.toLowerCase()
    if (low.includes("%2f") || low.includes("%5c")) return null
    for (let i = 0; i < cur.length; i++) {
      if (cur[i] === "%") {
        if (i + 2 >= cur.length) return null
        if (!isHexChar(cur[i + 1]) || !isHexChar(cur[i + 2])) return null
      }
    }
    if (!cur.includes("%")) break
    try {
      const next = decodeURIComponent(cur)
      if (next === cur) break
      cur = next
      {
        const s = cur.indexOf(";")
        if (s !== -1) cur = cur.slice(0, s)
      }
    } catch {
      return null
    }
  }
  {
    const s = cur.indexOf(";")
    if (s !== -1) cur = cur.slice(0, s)
  }
  const lowFinal = cur.toLowerCase()
  if (lowFinal.includes("%2f") || lowFinal.includes("%5c")) return null
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] === "%") {
      if (i + 2 >= cur.length) return null
      if (!isHexChar(cur[i + 1]) || !isHexChar(cur[i + 2])) return null
    }
  }
  if (cur.includes("\\")) cur = cur.split("\\").join("/")
  const segs = cur.split("/")
  const stack: string[] = []
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(seg)
  }
  let norm = "/" + stack.join("/")
  norm = norm.toLowerCase()
  return norm
}

export const privateLegacyDenyLayer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      if (!Flag.KILO_PRIVATE_RUNTIME) return yield* effect
      const req = yield* HttpServerRequest.HttpServerRequest
      const raw = rawPathname(req.url)
      const canon = canonicalForLegacy(raw)
      if (canon === null) {
        return HttpServerResponse.jsonUnsafe({ error: "Bad Request", message: "Malformed path" }, { status: 400 })
      }
      if (isLegacy(canon)) {
        return HttpServerResponse.jsonUnsafe({ error: "Gone", message: "Legacy route is gone" }, { status: 410 })
      }
      return yield* effect
    }),
  { global: true },
)
