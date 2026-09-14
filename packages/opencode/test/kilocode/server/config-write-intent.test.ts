/**
 * Write-intent intake classification coverage (LOCK-001/006/007).
 *
 * Every named settings/provider/auth save route must classify as a config write
 * so the instance-context middleware takes `gate.prepareWrite` admission (never
 * ordinary reader admission) during an active convergence fence; every
 * near-match and read route must stay on reader admission. Shapes are copied
 * from the actual route declarations:
 *
 *   PATCH /config /config/overlay /config/transaction /tui/config /config/model-state
 *   PUT   /config/rules
 *   PUT   /agent-builder/:id                              (LOCK-005 agent-builder save)
 *   POST  /custom-provider/:providerID/save|delete
 *   POST  /kilocode/agent/remove                          (LOCK-005 agent removal)
 *   POST  /kilo/organization
 *   POST  /kilocode/anaconda-desktop/sync
 *   POST  /provider/:providerID/oauth/callback
 *   POST  /permission/:requestID/always-rules        (LOCK-002 hot permission save)
 *   POST  /permission/allow-everything               (LOCK-002 hot permission save)
 *   POST  /mcp/:name/auth                            (LOCK-007 MCP OAuth start)
 *   POST  /mcp/:name/auth/callback                   (LOCK-007 MCP OAuth completion)
 *   POST  /mcp/:name/auth/authenticate               (LOCK-007 MCP OAuth authenticate)
 *   DELETE /mcp/:name/auth                           (LOCK-007 MCP credential removal)
 */
import { describe, expect, test } from "bun:test"
import { isConfigWrite } from "../../../src/kilocode/server/config-write-intent"

describe("isConfigWrite write-intent classification", () => {
  test.each([
    // config-console + legacy config PATCHes
    ["PATCH", "/config"],
    ["PATCH", "/config/overlay"],
    ["PATCH", "/config/transaction"],
    ["PATCH", "/tui/config"],
    ["PATCH", "/config/model-state"],
    // config-console project rules save (PUT)
    ["PUT", "/config/rules"],
    // agent-builder save (PUT, route-schema-validated dynamic id)
    ["PUT", "/agent-builder/my-agent"],
    ["PUT", "/agent-builder/code.1_2-3"],
    ["PUT", "/agent-builder/a"],
    // agent-builder save with router-decoded id segments: valid percent-encoded
    // ordinary ID characters decode exactly like the router and must classify
    ["PUT", "/agent-builder/my%2Dagent"],
    ["PUT", "/agent-builder/code%2E1_2%2D3"],
    ["PUT", "/agent-builder/%61gent"],
    ["PUT", "/agent-builder/a%2Eb"],
    // custom-provider save/delete (canonical route shape)
    ["POST", "/custom-provider/ollama/save"],
    ["POST", "/custom-provider/ollama/delete"],
    ["POST", "/custom-provider/my_provider-2/save"],
    // agent removal (LOCK-005 durable mutation)
    ["POST", "/kilocode/agent/remove"],
    // Kilo Gateway organization switch
    ["POST", "/kilo/organization"],
    // Anaconda Desktop provider sync
    ["POST", "/kilocode/anaconda-desktop/sync"],
    // provider OAuth callback
    ["POST", "/provider/ollama/oauth/callback"],
    // hot permission settings writes (LOCK-002): never wait on a cold fence
    ["POST", "/permission/per_1/always-rules"],
    ["POST", "/permission/allow-everything"],
    // MCP auth persistence routes (LOCK-007): start/callback/authenticate/remove
    // are hot write-intent — they never wait on a cold convergence fence and
    // hold the middleware write lease through the whole handler.
    ["POST", "/mcp/demo/auth"],
    ["POST", "/mcp/demo/auth/callback"],
    ["POST", "/mcp/demo/auth/authenticate"],
    ["DELETE", "/mcp/demo/auth"],
  ] as const)("classifies %s %s as a write intent", (method, path) => {
    expect(isConfigWrite(method, path)).toBe(true)
  })

  test.each([
    // same tree, non-write methods
    ["GET", "/config"],
    ["PUT", "/config"],
    ["DELETE", "/config"],
    ["GET", "/tui/config"],
    ["GET", "/kilo/organization"],
    ["GET", "/kilocode/anaconda-desktop/sync"],
    ["GET", "/provider/ollama/oauth/callback"],
    ["GET", "/config/rules"],
    ["PATCH", "/config/rules"],
    ["GET", "/config/model-state"],
    ["PUT", "/config/model-state"],
    ["GET", "/permission/per_1/always-rules"],
    ["GET", "/permission/allow-everything"],
    // agent-builder save near-misses: the dynamic id must satisfy the route
    // AgentBuilderID schema after safe router-style percent-decoding; siblings,
    // malformed shapes, and encoded separators/traversal stay on reader
    // admission (preview is the POST sibling, PUT on it is a route miss)
    ["PUT", "/agent-builder/"],
    ["PUT", "/agent-builder"],
    ["PUT", "/agent-builder/."],
    ["PUT", "/agent-builder/.."],
    ["PUT", "/agent-builder/bad:id"],
    ["PUT", "/agent-builder/my agent"],
    ["PUT", "/agent-builder/my%20agent"],
    ["PUT", "/agent-builder/preview/"],
    ["PUT", "/agent-builder/preview/extra"],
    ["PUT", "/agent-builder/my-agent/"],
    ["PUT", "/agent-builder/my-agent/extra"],
    ["PUT", "/agent-builders/my-agent"],
    ["PUT", "//agent-builder/my-agent"],
    ["PUT", "/agent-builder/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    // agent-builder encoded near-misses: encoded separators, dot-segment
    // traversal, malformed escapes, and non-ID decoded values fail closed
    ["PUT", "/agent-builder/my%2Fagent"],
    ["PUT", "/agent-builder/my%5Cagent"],
    ["PUT", "/agent-builder/%2F"],
    ["PUT", "/agent-builder/%5C"],
    ["PUT", "/agent-builder/%2E%2E"],
    ["PUT", "/agent-builder/%2e%2e"],
    ["PUT", "/agent-builder/%2Eagent"],
    ["PUT", "/agent-builder/%"],
    ["PUT", "/agent-builder/%2"],
    ["PUT", "/agent-builder/%GG"],
    ["PUT", "/agent-builder/my%agent"],
    ["PUT", "/agent-builder/my%2"],
    ["PUT", "/agent-builder/%252F"],
    ["PUT", "/agent-builder/%C3"],
    ["PUT", "/agent-builder/%C3%A9"],
    ["PUT", "/agent-builder/my%2Fagent/"],
    ["POST", "/agent-builder/my-agent"],
    ["DELETE", "/agent-builder/my-agent"],
    ["GET", "/agent-builder/my-agent"],
    ["POST", "/agent-builder/preview"],
    // agent removal near-misses: siblings, trailing segments, wrong trees.
    // Skill removal is private-only over the `skill/remove` FD op and has no
    // HTTP route, so every `/kilocode/skill/remove` shape stays on reader
    // admission.
    ["POST", "/kilocode/agent/remove/"],
    ["POST", "/kilocode/agent/remove/extra"],
    ["POST", "/kilocode/agent/removes"],
    ["POST", "/kilocode/agent/requirements"],
    ["POST", "/kilocode/skill/remove"],
    ["POST", "/kilocode/skill/remove/"],
    ["POST", "/kilocode/skill/remove/extra"],
    ["POST", "/kilocode/skills/remove"],
    ["POST", "/kilocode/skill/removes"],
    ["GET", "/kilocode/agent/remove"],
    ["GET", "/kilocode/skill/remove"],
    ["DELETE", "/kilocode/agent/remove"],
    ["DELETE", "/kilocode/skill/remove"],
    ["POST", "//kilocode/agent/remove"],
    ["POST", "/kilocode/./skill/remove"],
    // PATCH near-misses: wrong path, extra/trailing segments, sibling routes
    ["PATCH", "/configs"],
    ["PATCH", "/config/"],
    ["PATCH", "/config/extra"],
    ["PATCH", "/config/overlays"],
    ["PATCH", "/config/overlay/"],
    ["PATCH", "/config/overlay/extra"],
    ["PATCH", "/config/transaction/extra"],
    ["PATCH", "/tui/config/"],
    ["PATCH", "/tui/config/extra"],
    ["PATCH", "/tui/configs"],
    ["PATCH", "/tui/keybinds"],
    ["PATCH", "/config/model-states"],
    ["PATCH", "/config/model-state/"],
    ["PATCH", "/config/model-state/extra"],
    // PUT /config/rules near-misses: sibling reads, trailing segments, wrong tree
    ["PUT", "/config/rules/"],
    ["PUT", "/config/rules/extra"],
    ["PUT", "/config/rule"],
    ["PUT", "/configs/rules"],
    ["PUT", "/tui/rules"],
    // custom-provider near-misses: wrong arity, wrong leaf, missing root, empty
    // providerID, traversal, and the old nonexistent `/kilocode/...` tree
    ["POST", "/custom-provider/ollama/save/"],
    ["POST", "/custom-provider/ollama/delete/extra"],
    ["POST", "/custom-provider/save"],
    ["POST", "/custom-provider/ollama/saves"],
    ["POST", "/custom-provider/ollama/delete2"],
    ["POST", "/custom-provider/ollama/save/delete"],
    ["POST", "/custom-provider//save"],
    ["POST", "/custom-provider/../save"],
    ["POST", "/custom-provider/./save"],
    ["POST", "/kilocode/custom-provider/ollama/save"],
    ["POST", "/kilocode/custom-provider/ollama/delete"],
    ["POST", "/kilocode/custom-provider/ollama/save/"],
    // organization near-misses
    ["POST", "/kilo/organizations"],
    ["POST", "/kilo/organization/"],
    ["POST", "/kilo/organization/extra"],
    ["POST", "/kilo/"],
    ["POST", "/kilo/profile"],
    // anaconda-desktop near-misses: read/open siblings stay on reader admission
    ["POST", "/kilocode/anaconda-desktop/status"],
    ["POST", "/kilocode/anaconda-desktop/open"],
    ["POST", "/kilocode/anaconda-desktop/sync/"],
    ["POST", "/kilocode/anaconda-desktop/synced"],
    ["POST", "/kilocode/anaconda-desktop/sync/extra"],
    // oauth near-misses: authorize is not a callback
    ["POST", "/provider/ollama/oauth/authorize"],
    ["POST", "/provider/ollama/oauth/callback/"],
    ["POST", "/provider/ollama/oauth/callback/extra"],
    ["POST", "/provider/ollama/oauth/callbacks"],
    ["POST", "/providers/ollama/oauth/callback"],
    ["POST", "/provider/ollama/oauth"],
    ["POST", "/provider/ollama/oauth/callback/redirect"],
    // permission near-misses: reply/read siblings and malformed always-rules
    // stay on reader admission (or the drain-control lane — never write intent)
    ["POST", "/permission/per_1/reply"],
    ["POST", "/permission/per_1/replies"],
    ["POST", "/permission/per_1/always"],
    ["POST", "/permission/per_1/always-rules/"],
    ["POST", "/permission/per_1/always-rules/extra"],
    ["POST", "/permissions/per_1/always-rules"],
    ["POST", "/permission/allow-everything/"],
    ["POST", "/permission/allow-everything/extra"],
    ["POST", "/permission/allow-everythings"],
    ["POST", "/permission/allow-everything/always-rules"],
    ["POST", "/permission//always-rules"],
    ["GET", "/permission"],
    ["GET", "/permission/per_1"],
    ["GET", "/permission/allow-everything"],
    // MCP auth near-misses (LOCK-007): connect/disconnect/add are runtime-state
    // mutations, not auth writes; trailing/extra segments, wrong methods, wrong
    // tree, and malformed/traversal shapes all stay on reader admission
    ["POST", "/mcp"],
    ["POST", "/mcp/demo/connect"],
    ["POST", "/mcp/demo/disconnect"],
    ["POST", "/mcp/demo/auth/"],
    ["POST", "/mcp/demo/auth/extra"],
    ["POST", "/mcp/demo/auths"],
    ["POST", "/mcp/demo/authenticate"],
    ["POST", "/mcp/demo/auth/callback/"],
    ["POST", "/mcp/demo/auth/callback/extra"],
    ["POST", "/mcp/demo/auth/callback/redirect"],
    ["POST", "/mcp/demo/auth/callbacked"],
    ["POST", "/mcp/demo/auth/authenticate/"],
    ["POST", "/mcp/demo/auth/authenticate/extra"],
    ["POST", "/mcp/demo/auth/authenticated"],
    ["POST", "/mcps/demo/auth"],
    ["POST", "/mcp/demo/auths/callback"],
    ["POST", "//mcp/demo/auth"],
    ["POST", "/mcp//auth"],
    ["POST", "/mcp/../auth"],
    ["POST", "/mcp/./demo/auth"],
    ["POST", "/mcp/demo%2Fauth"],
    ["POST", "/mcp%2Fdemo/auth"],
    ["POST", "/mcp/demo/auth%2Fcallback"],
    ["GET", "/mcp/demo/auth"],
    ["PUT", "/mcp/demo/auth"],
    ["PATCH", "/mcp/demo/auth"],
    ["GET", "/mcp/demo/auth/callback"],
    ["GET", "/mcp/demo/auth/authenticate"],
    // DELETE near-misses: only the exact /mcp/:name/auth shape classifies
    ["DELETE", "/mcp/demo/auth/"],
    ["DELETE", "/mcp/demo/auth/extra"],
    ["DELETE", "/mcp/demo/authenticate"],
    ["DELETE", "/mcp/demo/auth/callback"],
    ["DELETE", "/mcp/auth"],
    ["DELETE", "/mcp/../auth"],
    ["DELETE", "//mcp/demo/auth"],
    ["DELETE", "/mcp//auth"],
    ["DELETE", "/mcp/auth/"],
    ["DELETE", "/config"],
    ["DELETE", "/config/rules"],
    ["DELETE", "/permission/per_1/always-rules"],
    ["DELETE", "/kilo/organization"],
    // traversal / malformed / encoded static segments
    ["POST", "/kilo/../organization"],
    ["POST", "/kilocode/./anaconda-desktop/sync"],
    ["POST", "//kilo/organization"],
    ["POST", "///kilocode/anaconda-desktop/sync"],
    ["POST", "/"],
    ["POST", ""],
    ["POST", "/custom%2Dprovider/ollama/save"],
    ["POST", "/kilo%2Forganization"],
    ["POST", "/permission/allow%2Deverything"],
    ["POST", "/permission/%2E/always-rules"],
    // unrelated instance routes
    ["POST", "/session/ses_a/abort"],
    ["POST", "/session/ses_a/permissions/per_1"],
    ["GET", "/session/status"],
    ["POST", "/notebook/req_1/reply"],
    ["POST", "/kilocode/notebook/nbr_abc123/reply"],
    ["POST", "/kilocode/notebook/nbr_abc123/reject"],
    ["GET", "/kilocode/notebook"],
  ] as const)("keeps %s %s on reader admission", (method, path) => {
    expect(isConfigWrite(method, path)).toBe(false)
  })
})
