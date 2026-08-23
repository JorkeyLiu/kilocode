import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Project, SyntaxKind } from "ts-morph"

const ROOT = path.resolve(import.meta.dir, "../..")
const PROVIDER = path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts")

describe("AgentManagerProvider R9 session-switch forwarding", () => {
  it("exposes onActiveSessionChanged with disposable and emit helper", () => {
    const text = fs.readFileSync(PROVIDER, "utf-8")
    expect(text).toContain("onActiveSessionChanged")
    expect(text).toContain("emitActiveSessionChanged")
    expect(text).toContain("activeSessionCbs")
  })
  it("onPanelVisibilityChange is additive (array, not single field)", () => {
    const text = fs.readFileSync(PROVIDER, "utf-8")
    expect(text).toContain("visibilityCbs")
    expect(text).not.toMatch(/private onVisibilityChange:\s*\(\(visible: boolean\) => void\)/)
  })
  it("loadMessages emits activeSessionChanged", () => {
    const project = new Project({ compilerOptions: { allowJs: true } })
    const source = project.addSourceFileAtPath(PROVIDER)
    const cls = source.getFirstDescendantByKind(SyntaxKind.ClassDeclaration)!
    const method = cls.getMethod("onSessionMessage")
    expect(method, "onSessionMessage not found").toBeTruthy()
    const body = method!.getText()
    expect(body).toContain("loadMessages")
    expect(body).toContain("emitActiveSessionChanged")
  })
  it("attachPanel emits visibility on both initial and onDidChangeVisibility", () => {
    const project = new Project({ compilerOptions: { allowJs: true } })
    const source = project.addSourceFileAtPath(PROVIDER)
    const cls = source.getFirstDescendantByKind(SyntaxKind.ClassDeclaration)!
    const method = cls.getMethod("attachPanel")
    expect(method).toBeTruthy()
    const body = method!.getText()
    // initial emit plus emit inside onDidChangeVisibility
    const emits = (body.match(/emitVisibilityChanged/g) ?? []).length
    expect(emits).toBeGreaterThanOrEqual(2)
  })
})
