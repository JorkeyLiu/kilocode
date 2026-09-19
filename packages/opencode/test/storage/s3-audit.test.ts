import { describe, expect, it } from "bun:test"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { Glob } from "bun"
import path from "path"
import fs from "fs"
import * as ts from "typescript"

const SRC_ROOTS = [path.resolve(import.meta.dir, "../../src"), path.resolve(import.meta.dir, "../../../core/src")]

async function listTsFiles(): Promise<string[]> {
  const files: string[] = []
  for (const root of SRC_ROOTS) {
    const glob = new Glob("**/*.ts")
    for await (const rel of glob.scan({ cwd: root, dot: false, absolute: false })) {
      if (rel.includes(".test.") || rel.includes("__tests__")) continue
      if (rel.startsWith("test/") || rel.includes("/test/")) continue
      const full = path.join(root, rel)
      if (full.includes("/sdk/")) continue
      files.push(full)
    }
  }
  return files
}

const familyRoots = new Set<string>(Artifact.familyKinds() as readonly string[])
const migrationAllowed = new Set(["session_diff", "project", "session", "message", "part"])

function isStorageImport(spec: string): boolean {
  return spec.includes("storage/storage")
}

function isClaimedFileImport(spec: string): boolean {
  return spec.includes("storage/claimed-file")
}

function extractStorageRoot(node: ts.Expression | undefined, src: ts.SourceFile): string | null | undefined {
  if (!node) return undefined
  if (ts.isArrayLiteralExpression(node)) {
    const first = node.elements[0]
    if (!first) return null
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
    return null
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    const txt = callee.getText(src)
    if (txt.includes("baseKey")) return "session_diff_base"
    return undefined
  }
  if (ts.isIdentifier(node)) return null
  return undefined
}

function collectStorageAliases(src: ts.SourceFile) {
  const named = new Set<string>()
  const ns = new Set<string>()
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier.getText(src).replaceAll('"', "").replaceAll("'", "")
    if (!isStorageImport(spec)) continue
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text
        const local = el.name.text
        if (imported === "Storage") named.add(local)
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) ns.add(clause.namedBindings.name.text)
    if (clause.name) {
      // default import edge, treat as storage alias if spec is storage
      // not expected but keep for completeness
    }
  }
  return { named, ns }
}

function collectClaimedAliases(src: ts.SourceFile) {
  const family = new Set<string>()
  const exclusive = new Set<string>()
  const storageKey = new Set<string>()
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier.getText(src).replaceAll('"', "").replaceAll("'", "")
    if (!isClaimedFileImport(spec)) continue
    const clause = stmt.importClause
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text
      const local = el.name.text
      if (imported === "writeFamilyExclusiveJson") family.add(local)
      if (imported === "writeExclusiveJson") exclusive.add(local)
      if (imported === "storageFileForKey") storageKey.add(local)
    }
  }
  return { family, exclusive, storageKey }
}

function isServiceUseCall(
  node: ts.CallExpression,
  src: ts.SourceFile,
  aliases: ReturnType<typeof collectStorageAliases>,
): boolean {
  const expr = node.expression
  if (!ts.isPropertyAccessExpression(expr)) return false
  if (expr.name.text !== "use") return false
  const target = expr.expression
  if (!ts.isPropertyAccessExpression(target)) return false
  if (target.name.text !== "Service") return false
  const base = target.expression
  if (ts.isIdentifier(base) && aliases.named.has(base.text)) return true
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === "Storage" &&
    ts.isIdentifier(base.expression) &&
    aliases.ns.has(base.expression.text)
  )
    return true
  return false
}

function isStorageServiceYield(
  node: ts.YieldExpression,
  src: ts.SourceFile,
  aliases: ReturnType<typeof collectStorageAliases>,
): boolean {
  if (!node.asteriskToken) return false
  const expr = node.expression
  if (!expr || !ts.isPropertyAccessExpression(expr)) return false
  if (expr.name.text !== "Service") return false
  const base = expr.expression
  if (ts.isIdentifier(base) && aliases.named.has(base.text)) return true
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === "Storage" &&
    ts.isIdentifier(base.expression) &&
    aliases.ns.has(base.expression.text)
  )
    return true
  return false
}

type ScanResult = { violations: string[]; found: Array<{ file: string; snippet: string; root: string }> }

function scanText(file: string, text: string): ScanResult {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const aliases = collectStorageAliases(src)
  const claimed = collectClaimedAliases(src)
  const storageVars = new Set<string>()
  const writeAliases = new Set<string>()
  const updateAliases = new Set<string>()
  const violations: string[] = []
  const found: ScanResult["found"] = []

  const rel = path.relative(process.cwd(), file)
  const isSandboxFile = rel.includes("kilocode/sandbox/store")

  // pre-collect key variable -> root mapping for indirection handling
  const keyVarRoots = new Map<string, string>()
  function unwrapExpr(expr: ts.Expression): ts.Expression {
    let cur: ts.Expression = expr
    while (true) {
      if (
        ts.isAsExpression(cur) ||
        ts.isTypeAssertionExpression(cur) ||
        ts.isParenthesizedExpression(cur) ||
        (ts as unknown as { isSatisfiesExpression?: (n: ts.Node) => boolean }).isSatisfiesExpression?.(cur)
      ) {
        cur = (cur as unknown as { expression: ts.Expression }).expression
        continue
      }
      break
    }
    return cur
  }
  function deriveRootFromInit(init: ts.Expression | undefined): string | undefined {
    if (!init) return undefined
    init = unwrapExpr(init)
    if (ts.isArrayLiteralExpression(init)) {
      const first = init.elements[0]
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text
      return undefined
    }
    if (ts.isCallExpression(init)) {
      const txt = init.expression.getText(src)
      if (txt.includes("baseKey")) return "session_diff_base"
      if (txt.includes("storageFileForKey")) {
        const inner = init.arguments[0] as ts.Expression | undefined
        if (inner) {
          const r = deriveRootFromInit(inner as ts.Expression)
          if (r) return r
          const t = inner.getText(src)
          if (t.includes("baseKey")) return "session_diff_base"
          if (t.includes("session_diff_base")) return "session_diff_base"
          if (t.includes("session_diff")) return "session_diff"
          if (t.includes("session_share")) return "session_share"
        }
        return undefined
      }
      const txtFull = init.getText(src)
      if (txtFull.includes("session_diff_base")) return "session_diff_base"
      if (txtFull.includes("session_diff")) return "session_diff"
      if (txtFull.includes("session_share")) return "session_share"
      if (txtFull.includes("snapshot")) return "snapshot"
      if (txtFull.includes("session-export.db")) return "session-export.db"
      return undefined
    }
    if (ts.isIdentifier(init)) {
      const mapped = keyVarRoots.get(init.text)
      if (mapped) return mapped
      return undefined
    }
    return undefined
  }
  for (const stmt of src.statements) {
    function walkDecls(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const r = deriveRootFromInit(node.initializer)
        if (r) keyVarRoots.set(node.name.text, r)
      }
      ts.forEachChild(node, walkDecls)
    }
    walkDecls(stmt)
  }
  // second pass for nested variable declarations not at top-level (ensure capture)
  function collectAllKeyVars(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const existing = keyVarRoots.get(node.name.text)
      if (!existing) {
        const r = deriveRootFromInit(node.initializer)
        if (r) keyVarRoots.set(node.name.text, r)
      }
    }
    ts.forEachChild(node, collectAllKeyVars)
  }
  collectAllKeyVars(src)

  function resolveRoot(node: ts.Expression | undefined): string | null | undefined {
    if (!node) return undefined
    node = unwrapExpr(node)
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements[0]
      if (!first) return null
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
      return null
    }
    if (ts.isCallExpression(node)) {
      const txt = node.expression.getText(src)
      if (txt.includes("baseKey")) return "session_diff_base"
      // fallback text check for inline array via storageFileForKey etc - not needed here
      return undefined
    }
    if (ts.isIdentifier(node)) {
      const mapped = keyVarRoots.get(node.text)
      if (mapped) return mapped
      const txt = node.getText(src)
      if (txt.includes("baseKey")) return "session_diff_base"
      return null
    }
    return undefined
  }

  function handleStorageCall(call: ts.CallExpression, method: string) {
    const first = call.arguments[0] as ts.Expression | undefined
    const root = resolveRoot(first) ?? extractStorageRoot(first, src)
    const snippet = call.getText(src).slice(0, 120)
    if (root === undefined || root === null) {
      violations.push(`${rel}: dynamic Storage ${method} prefix could not be resolved: ${snippet}`)
      return
    }
    if (!familyRoots.has(root)) {
      violations.push(`${rel}: Storage.${method} uses unregistered root "${root}" in ${snippet}`)
      return
    }
    found.push({ file: rel, snippet, root })
  }

  function handleFamilyCall(call: ts.CallExpression) {
    const first = call.arguments[0] as ts.Expression | undefined
    let root = resolveRoot(first)
    if (root === null || root === undefined) root = extractStorageRoot(first, src) as string | null | undefined
    // fallback text heuristic for variable indirection where mapping failed
    if (root === null || root === undefined) {
      const txt = first ? first.getText(src) : ""
      if (txt.includes("baseKey") || call.getText(src).includes("baseKey")) root = "session_diff_base"
      else if (txt.includes("session_diff") || call.getText(src).includes("session_diff")) {
        // need to disambiguate session_diff_base vs session_diff: prefer base if present else diff
        if (call.getText(src).includes("session_diff_base") || txt.includes("session_diff_base"))
          root = "session_diff_base"
        else root = "session_diff"
      } else if (txt.includes("session_share")) root = "session_share"
    }
    const snippet = call.getText(src).slice(0, 120)
    if (root === undefined || root === null) {
      violations.push(`${rel}: dynamic writeFamilyExclusiveJson prefix could not be resolved: ${snippet}`)
      return
    }
    if (!familyRoots.has(root)) {
      violations.push(`${rel}: writeFamilyExclusiveJson uses non-family root "${root}" in ${snippet}`)
      return
    }
    found.push({ file: rel, snippet, root })
  }

  function visit(node: ts.Node) {
    // variable declarations: storage alias handling
    if (ts.isVariableDeclaration(node)) {
      const name = node.name
      const init = node.initializer
      if (ts.isIdentifier(name) && init) {
        // yield* Storage.Service -> storage var
        if (ts.isYieldExpression(init) && isStorageServiceYield(init, src, aliases)) {
          storageVars.add(name.text)
        } else if (ts.isIdentifier(init) && storageVars.has(init.text)) {
          storageVars.add(name.text)
        } else if (
          ts.isPropertyAccessExpression(init) &&
          ts.isIdentifier(init.expression) &&
          storageVars.has(init.expression.text)
        ) {
          const prop = init.name.text
          if (prop === "write") writeAliases.add(name.text)
          else if (prop === "update") updateAliases.add(name.text)
        } else if (ts.isCallExpression(init)) {
          // w = storage.write.bind(storage) edge: treat as alias if first part is storage.write
          const callee = init.expression
          if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "bind" &&
            ts.isPropertyAccessExpression(callee.expression)
          ) {
            const inner = callee.expression
            if (
              ts.isIdentifier(inner.expression) &&
              storageVars.has(inner.expression.text) &&
              (inner.name.text === "write" || inner.name.text === "update")
            ) {
              if (inner.name.text === "write") writeAliases.add(name.text)
              else updateAliases.add(name.text)
            }
          }
        }
        // type annotation Storage.Interface param without yield: handle later via param detection, but also allow direct alias via type
        // already covered by identifier alias above
      }
      if (ts.isObjectBindingPattern(name) && init && ts.isIdentifier(init) && storageVars.has(init.text)) {
        for (const el of name.elements) {
          if (!ts.isBindingElement(el)) continue
          const prop = el.propertyName
            ? ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : undefined
            : ts.isIdentifier(el.name)
              ? el.name.text
              : undefined
          const local = ts.isIdentifier(el.name) ? el.name.text : undefined
          if (!local) continue
          if (prop === "write") writeAliases.add(local)
          else if (prop === "update") updateAliases.add(local)
        }
      }
      // param type annotation Storage.Interface: when VariableDeclaration has type Storage.Interface?
      // also catch `const x: Storage.Interface = ...` already via yield above, no extra needed
    }

    // parameter: Storage.Service.use((svc) => ...) or (storage: Storage.Interface)
    if (ts.isParameter(node)) {
      const nameNode = node.name
      const typeText = node.type ? node.type.getText(src) : ""
      const isStorageType = typeText.includes("Storage.Interface") || typeText.includes("Storage.")
      if (isStorageType && ts.isIdentifier(nameNode)) storageVars.add(nameNode.text)
      // check if parent is function inside Service.use
      const parent = node.parent
      if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent)) {
        const gp = parent.parent
        if (gp && ts.isCallExpression(gp) && isServiceUseCall(gp, src, aliases) && ts.isIdentifier(nameNode)) {
          storageVars.add(nameNode.text)
        }
      }
    }

    // call expressions: Storage write/update, claimed-file family/bare
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      // family wrapper
      if (ts.isIdentifier(callee) && claimed.family.has(callee.text)) {
        handleFamilyCall(node)
      } else if (ts.isIdentifier(callee) && claimed.exclusive.has(callee.text)) {
        // bare writeExclusiveJson – check if first arg is storageFileForKey
        const first = node.arguments[0] as ts.Expression | undefined
        if (first && ts.isCallExpression(first)) {
          const innerCallee = first.expression
          const innerText = innerCallee.getText(src)
          const isStorageKeyCall = innerText.includes("storageFileForKey") || claimed.storageKey.has(innerText)
          if (isStorageKeyCall) {
            if (isSandboxFile) {
              // sandbox allowed – do not flag
            } else {
              const keyArg = first.arguments[0] as ts.Expression | undefined
              let root: string | null | undefined = resolveRoot(keyArg)
              if (root === null || root === undefined)
                root = extractStorageRoot(keyArg, src) as string | null | undefined
              if (root === null || root === undefined) {
                const txt = keyArg ? keyArg.getText(src) : ""
                if (txt.includes("baseKey") || first.getText(src).includes("baseKey")) root = "session_diff_base"
                else if (txt.includes("session_diff") || first.getText(src).includes("session_diff")) {
                  if (txt.includes("session_diff_base") || first.getText(src).includes("session_diff_base"))
                    root = "session_diff_base"
                  else root = "session_diff"
                }
              }
              const snippet = node.getText(src).slice(0, 120)
              if (root === undefined || root === null) {
                violations.push(
                  `${rel}: bare storageFileForKey+writeExclusiveJson with dynamic prefix could not be resolved: ${snippet}`,
                )
              } else if (!familyRoots.has(root)) {
                violations.push(
                  `${rel}: bare storageFileForKey+writeExclusiveJson uses non-family root "${root}" in ${snippet} — must use family wrapper or is unregistered`,
                )
              } else {
                violations.push(
                  `${rel}: bare storageFileForKey+writeExclusiveJson uses family root "${root}" in ${snippet} — must use writeFamilyExclusiveJson`,
                )
              }
            }
          }
          // else bare with non-storage path – sandbox style, allowed
        }
        // no found for bare
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text
        if (method === "write" || method === "update") {
          const obj = callee.expression
          if (ts.isIdentifier(obj) && storageVars.has(obj.text)) {
            handleStorageCall(node, method)
          } else {
            // fallback heuristic for known artifact root but unknown alias: detect hidden Storage write
            // Only when file imports Storage and method is write/update and first arg is known artifact
            if (aliases.named.size > 0 || aliases.ns.size > 0) {
              const first = node.arguments[0] as ts.Expression | undefined
              const root = resolveRoot(first) ?? extractStorageRoot(first, src)
              if (typeof root === "string" && Artifact.get(root)) {
                // artifact-like write but receiver not tracked -> unresolved alias
                if (familyRoots.has(root) || root === "session_diff_base") {
                  // if root is unregistered, this will be flagged as violation anyway, but we need to flag unresolved alias for any artifact
                  // treat as violation for unresolved alias with registered root (detects alternate alias case)
                  // For current known writers that use param storage not tracked via yield, this fallback would incorrectly flag;
                  // we mitigate by checking if obj is a parameter-like name that is likely storage (e.g., name includes storage/svc) or type-annotated
                  // Instead, we only flag as violation if root is NOT in found expected? Simpler: if object not in storageVars but root is known family, consider it a found (to avoid false positive) when the file's storageVars set is non-empty or aliases present?
                  // To keep fail-closed for unregistered roots, we still need violation for unregistered root
                  if (!familyRoots.has(root)) {
                    violations.push(
                      `${rel}: Storage.${method} uses unregistered root "${root}" in ${node.getText(src).slice(0, 120)} (unresolved alias ${obj.getText(src)})`,
                    )
                  } else {
                    // count as found to satisfy current writers with param indirection
                    found.push({ file: rel, snippet: node.getText(src).slice(0, 120), root })
                  }
                } else if (root && !familyRoots.has(root)) {
                  violations.push(
                    `${rel}: Storage.${method} uses unregistered root "${root}" in ${node.getText(src).slice(0, 120)} (unresolved alias ${obj.getText(src)})`,
                  )
                }
              } else if (root === null) {
                // dynamic with unknown alias -> violation for ambiguity
                violations.push(
                  `${rel}: dynamic Storage ${method} prefix could not be resolved: ${node.getText(src).slice(0, 120)} (unresolved alias ${obj.getText(src)})`,
                )
              } else if (root === undefined) {
                // non-storage shape, ignore unless it's baseKey-like?
                // check if text includes baseKey
                const txt = first ? first.getText(src) : ""
                if (txt.includes("baseKey")) {
                  const b = Artifact.get("session_diff_base")
                  if (!b) violations.push(`${rel}: baseKey used but session_diff_base not registered`)
                  else found.push({ file: rel, snippet: "baseKey -> session_diff_base", root: "session_diff_base" })
                }
              }
            }
          }
        }
        // also handle writeWithDirs irrelevant here
      } else if (ts.isIdentifier(callee)) {
        const name = callee.text
        if (writeAliases.has(name)) handleStorageCall(node, "write")
        else if (updateAliases.has(name)) handleStorageCall(node, "update")
        else if ((name === "write" || name === "update") && (aliases.named.size > 0 || aliases.ns.size > 0)) {
          const first = node.arguments[0] as ts.Expression | undefined
          const root = resolveRoot(first) ?? extractStorageRoot(first, src)
          if (typeof root === "string" && Artifact.get(root)) {
            if (!familyRoots.has(root))
              violations.push(
                `${rel}: Storage.${name} uses unregistered root "${root}" in ${node.getText(src).slice(0, 120)} (unresolved destructured alias)`,
              )
            else found.push({ file: rel, snippet: node.getText(src).slice(0, 120), root })
          } else if (root === null)
            violations.push(
              `${rel}: dynamic Storage ${name} prefix could not be resolved: ${node.getText(src).slice(0, 120)} (unresolved destructured alias)`,
            )
        } else if (claimed.family.has(name)) {
          handleFamilyCall(node)
        }
      }
      // special baseKey handling for direct storage.write(baseKey(...)): already handled via extractStorageRoot when callee is storage.write
      // but if callee is storage.write and first arg is baseKey call, handleStorageCall maps baseKey to session_diff_base correctly
    }

    ts.forEachChild(node, visit)
  }

  visit(src)

  // Also handle baseKey discovery for files where storage.write(baseKey) wasn't caught due to callee check? Already handled.
  // Fallback: if text contains baseKey and file imports Storage and we haven't counted baseKey found, add synthetic found for audit completeness
  // The earlier per-call handling already adds found for baseKey via extractStorageRoot; but to preserve previous audit's baseKey counting, ensure we count at least one if baseKey present and Storage import present and no violation for it.
  // We already count via handleStorageCall if baseKey was arg to storage write; so no extra needed.

  return { violations, found }
}

function scanMigrations(): { violations: string[]; foundRoot: string[] } {
  const file = path.resolve(import.meta.dir, "../../src/storage/storage.ts")
  const text = fs.readFileSync(file, "utf8")
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const violations: string[] = []
  const foundRoot: string[] = []
  let migrationsNode: ts.Node | undefined
  for (const stmt of src.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "MIGRATIONS" && decl.initializer) {
          migrationsNode = decl.initializer
        }
      }
    }
  }
  if (!migrationsNode) {
    violations.push("MIGRATIONS array not found in storage.ts")
    return { violations, foundRoot }
  }
  const start = migrationsNode.getFullStart()
  const end = migrationsNode.getEnd()
  const pathJoinVars = new Map<string, string>()
  function collectJoins(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const call = node.initializer
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "join") {
        const args = call.arguments
        const rootArg = args[1] as ts.Expression | undefined
        if (rootArg && (ts.isStringLiteral(rootArg) || ts.isNoSubstitutionTemplateLiteral(rootArg))) {
          pathJoinVars.set(node.name.text, rootArg.text)
        }
      }
    }
    ts.forEachChild(node, collectJoins)
  }
  collectJoins(migrationsNode)

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "writeWithDirs") {
        const pos = node.getFullStart()
        if (pos >= start && pos <= end) {
          const first = node.arguments[0] as ts.Expression | undefined
          let root: string | undefined
          if (
            first &&
            ts.isCallExpression(first) &&
            ts.isPropertyAccessExpression(first.expression) &&
            first.expression.name.text === "join"
          ) {
            const args = first.arguments
            const rootArg = args[1] as ts.Expression | undefined
            if (rootArg && (ts.isStringLiteral(rootArg) || ts.isNoSubstitutionTemplateLiteral(rootArg)))
              root = rootArg.text
          } else if (first && ts.isIdentifier(first) && pathJoinVars.has(first.text)) {
            root = pathJoinVars.get(first.text)
          }
          if (root) {
            foundRoot.push(root)
            if (!migrationAllowed.has(root) && !Artifact.get(root)) {
              violations.push(
                `storage.ts migration writes unknown destination "${root}" not in disposition allowlist: ${node.getText(src).slice(0, 120)}`,
              )
            }
          } else {
            violations.push(
              `storage.ts migration destination could not be resolved: ${node.getText(src).slice(0, 120)}`,
            )
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(migrationsNode)
  if (foundRoot.length === 0) violations.push("no migration destinations found")
  return { violations, foundRoot }
}

function auditSnippet(text: string): ScanResult {
  // synthetic file path for relative reporting
  return scanText("/tmp/synthetic.ts", text)
}

function auditMigrationSnippet(destRoot: string): string[] {
  const fake = `
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
const dir = "/tmp/storage"
const fs = null as never
const MIGRATIONS = [ (dir: string, fs: FSUtil.Interface) => fs.writeWithDirs(path.join(dir, "${destRoot}", "id.json"), "{}") ]
`
  const res = scanMigrationsFromText(fake)
  return res.violations
}

function scanMigrationsFromText(text: string): { violations: string[]; foundRoot: string[] } {
  const src = ts.createSourceFile("/tmp/fake-storage.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const violations: string[] = []
  const foundRoot: string[] = []
  let migrationsNode: ts.Node | undefined
  for (const stmt of src.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "MIGRATIONS" && decl.initializer)
          migrationsNode = decl.initializer
      }
    }
  }
  if (!migrationsNode) return { violations: ["no MIGRATIONS"], foundRoot }
  const pathJoinVars = new Map<string, string>()
  function collect(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const call = node.initializer
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "join") {
        const rootArg = call.arguments[1] as ts.Expression | undefined
        if (rootArg && (ts.isStringLiteral(rootArg) || ts.isNoSubstitutionTemplateLiteral(rootArg)))
          pathJoinVars.set(node.name.text, rootArg.text)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(migrationsNode)
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "writeWithDirs") {
        const first = node.arguments[0] as ts.Expression | undefined
        let root: string | undefined
        if (
          first &&
          ts.isCallExpression(first) &&
          ts.isPropertyAccessExpression(first.expression) &&
          first.expression.name.text === "join"
        ) {
          const rootArg = first.arguments[1] as ts.Expression | undefined
          if (rootArg && (ts.isStringLiteral(rootArg) || ts.isNoSubstitutionTemplateLiteral(rootArg)))
            root = rootArg.text
        } else if (first && ts.isIdentifier(first) && pathJoinVars.has(first.text)) root = pathJoinVars.get(first.text)
        if (root) {
          foundRoot.push(root)
          if (!migrationAllowed.has(root) && !Artifact.get(root)) violations.push(`unknown destination "${root}"`)
        } else violations.push("could not resolve")
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(migrationsNode)
  return { violations, foundRoot }
}

describe("S3 static audit", () => {
  it("all production Storage write/update sites use registered prefixes", async () => {
    const files = await listTsFiles()
    const violations: string[] = []
    const found: Array<{ file: string; snippet: string; root: string }> = []
    for (const file of files) {
      if (file.endsWith("/storage/storage.ts")) continue
      const text = fs.readFileSync(file, "utf8")
      const res = scanText(file, text)
      violations.push(...res.violations)
      found.push(...res.found)
    }
    expect(found.length).toBeGreaterThanOrEqual(6)
    const rootsSeen = new Set(found.map((f) => f.root))
    expect(rootsSeen.has("session_diff")).toBe(true)
    expect(rootsSeen.has("session_diff_base")).toBe(true)
    expect(rootsSeen.has("session_share")).toBe(true)
    // ensure zero updates: no update found
    const updateFound = found.filter((f) => f.snippet.includes(".update"))
    // we haven't tracked update separately; scan verifies no update violations, but we can assert no update writes
    // Use a second scan that counts update calls via AST: if any .update on storage var found, it would be in violations or found
    // For now check that no file contributed an update root
    expect(updateFound.length).toBe(0)
    if (violations.length)
      throw new Error(`S3 audit failures:\n${violations.join("\n")}\nFound: ${JSON.stringify(found, null, 2)}`)
  })

  it("snapshot remains project-owned and direct writer is dispositioned", async () => {
    expect(Artifact.get("snapshot")?.owner).toBe("project")
    expect(Artifact.get("snapshot")?.retention).toBe("project")
    expect(Artifact.isFamilyKind("snapshot")).toBe(false)
    const snapshotIndex = path.resolve(import.meta.dir, "../../src/snapshot/index.ts")
    const snapshotText = fs.readFileSync(snapshotIndex, "utf8")
    expect(snapshotText).toContain("KiloSnapshotMaterialize")
    const files = await listTsFiles()
    for (const file of files) {
      if (file.endsWith("/storage/storage.ts")) continue
      const text = fs.readFileSync(file, "utf8")
      const res = scanText(file, text)
      for (const f of res.found) {
        expect(f.root).not.toBe("snapshot")
      }
      // also ensure no raw Storage write with snapshot via quick text check as backup
      if (text.includes('["snapshot"')) {
        const has = /Storage[\s\S]*\.write\s*\(\s*\[\s*["']snapshot["']/.test(text)
        expect(has).toBe(false)
      }
    }
  })

  it("legacy session-export.db is registered and dispositioned", async () => {
    expect(Artifact.get("session-export.db")?.owner).toBe("legacy")
    const bootstrap = path.resolve(import.meta.dir, "../../src/kilocode/bootstrap.ts")
    const text = fs.readFileSync(bootstrap, "utf8")
    expect(text).toContain("session-export.db")
    const workerStorage = path.resolve(import.meta.dir, "../../src/kilocode/session-export/worker/storage.ts")
    expect(fs.existsSync(workerStorage)).toBe(true)
    expect(fs.statSync(workerStorage).size).toBeGreaterThan(0)
    expect(Artifact.familyKinds()).not.toContain("session-export.db" as never)
  })

  it("storage migrations are explicit and do not introduce unregistered Storage writes", async () => {
    const storageFile = path.resolve(import.meta.dir, "../../src/storage/storage.ts")
    const text = fs.readFileSync(storageFile, "utf8")
    expect(text).toContain("MIGRATIONS")
    expect(text).toContain("session_diff")
    const { violations, foundRoot } = scanMigrations()
    expect(foundRoot.length).toBeGreaterThan(0)
    expect(foundRoot).toContain("session_diff")
    expect(foundRoot).toContain("session")
    expect(text.includes("Storage.write")).toBe(false)
    if (violations.length) throw new Error(`migration disposition failures:\n${violations.join("\n")}`)
  })

  it("future unregistered writer is rejected (negative probe)", async () => {
    const fake2 = `import { Storage } from "@/storage/storage"; import { Effect } from "effect"; Effect.gen(function* () { const mySvc = yield* Storage.Service; mySvc.write(["totally_new_kind", "id"], {}) })`
    const res = auditSnippet(fake2)
    expect(res.violations.some((v) => v.includes("totally_new_kind"))).toBe(true)
    expect(Artifact.get("totally_new_kind")).toBeUndefined()
  })

  it("alternate receiver alias is detected", async () => {
    const fake = `import { Storage } from "@/storage/storage"; import { Effect } from "effect"; Effect.gen(function* () { const myStorage = yield* Storage.Service; myStorage.write(["totally_new_kind", "id"], {}) })`
    const res = auditSnippet(fake)
    expect(res.violations.length).toBeGreaterThan(0)
    expect(res.violations.some((v) => v.includes("totally_new_kind"))).toBe(true)
  })

  it("destructured and indirect write shapes are detected", async () => {
    const fakeDestructure = `import { Storage } from "@/storage/storage"; import { Effect } from "effect"; Effect.gen(function* () { const storage = yield* Storage.Service; const { write } = storage; write(["totally_new_kind", "id"], {}) })`
    const res1 = auditSnippet(fakeDestructure)
    expect(res1.violations.some((v) => v.includes("totally_new_kind"))).toBe(true)
    const fakeIndirect = `import { Storage } from "@/storage/storage"; import { Effect } from "effect"; Effect.gen(function* () { const storage = yield* Storage.Service; const w = storage.write; w(["totally_new_kind", "id"], {}) })`
    const res2 = auditSnippet(fakeIndirect)
    expect(res2.violations.some((v) => v.includes("totally_new_kind"))).toBe(true)
    const fakeUpdate = `import { Storage } from "@/storage/storage"; import { Effect } from "effect"; Effect.gen(function* () { const storage = yield* Storage.Service; storage.update(["totally_new_kind", "id"], () => {}) })`
    const res3 = auditSnippet(fakeUpdate)
    expect(res3.violations.some((v) => v.includes("totally_new_kind"))).toBe(true)
  })

  it("unknown migration destination fails", async () => {
    const { violations } = scanMigrations()
    expect(violations.length).toBe(0)
    const bad = auditMigrationSnippet("totally_unknown_root")
    expect(bad.length).toBeGreaterThan(0)
    expect(bad[0]).toContain("unknown")
  })

  it("family claimed-file wrapper is recognized and bare claimed-file writer is rejected", async () => {
    const fakeFamily = `import { writeFamilyExclusiveJson } from "@/storage/claimed-file"; writeFamilyExclusiveJson(["session_diff", "id"], {})`
    const resOk = auditSnippet(fakeFamily)
    expect(resOk.violations.length).toBe(0)
    expect(resOk.found.some((f) => f.root === "session_diff")).toBe(true)
    const fakeFamilyBase = `import { writeFamilyExclusiveJson } from "@/storage/claimed-file"; import { baseKey } from "@/kilocode/session-portability/cumulative-diff"; writeFamilyExclusiveJson(baseKey("sid"), {})`
    const resBase = auditSnippet(fakeFamilyBase)
    expect(resBase.violations.length).toBe(0)
    expect(resBase.found.some((f) => f.root === "session_diff_base")).toBe(true)
    const fakeFamilyBad = `import { writeFamilyExclusiveJson } from "@/storage/claimed-file"; writeFamilyExclusiveJson(["snapshot", "id"], {})`
    const resBad = auditSnippet(fakeFamilyBad)
    expect(resBad.violations.some((v) => v.includes("snapshot"))).toBe(true)
    const fakeBare = `import { writeExclusiveJson, storageFileForKey } from "@/storage/claimed-file"; writeExclusiveJson(storageFileForKey(["session_diff", "id"]), {})`
    const resBare = auditSnippet(fakeBare)
    expect(resBare.violations.some((v) => v.includes("bare") && v.includes("session_diff"))).toBe(true)
    const fakeBareSnapshot = `import { writeExclusiveJson, storageFileForKey } from "@/storage/claimed-file"; writeExclusiveJson(storageFileForKey(["snapshot", "id"]), {})`
    const resBareSnap = auditSnippet(fakeBareSnapshot)
    expect(resBareSnap.violations.some((v) => v.includes("snapshot"))).toBe(true)
  })

  it("sandbox bare writer is not flagged as storage artifact", async () => {
    const sandboxPath = path.resolve(import.meta.dir, "../../src/kilocode/sandbox/store.ts")
    const text = fs.readFileSync(sandboxPath, "utf8")
    const res = scanText(sandboxPath, text)
    expect(res.violations.length).toBe(0)
    expect(res.found.length).toBe(0)
  })
})
