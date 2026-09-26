/**
 * real-generation narrow scenario for the real VS Code E2E probe
 * (script/e2e-probe.ts imports this; Node-only, never bundled into the
 * extension). Extracted so the probe file stays under its max-lines cap.
 *
 * Minimal true generation-owner proof: ONE completed text turn against the
 * run-owned loopback scripted provider with the minimal seed (closed canonical
 * project config + no-op dependency guard — no MCP, no user tool, no skill, no
 * permission rules, no rollback file, no external network), then the terminal
 * owner/member + succeeded prompt-operation proof read-only through the Bun
 * gate child. Any terminal-owner mismatch throws as a REAL BUG — the narrow
 * scope must never mask a production conflict.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { createScriptedModel, SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { writeRealGenerationSeed } from "./e2e-restart-seed"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import { assertRealSnapGenerations, type TerminalProof } from "./e2e-generation-assert"
import { pinExpect, pinReport, type PinExpectation } from "./e2e-pin"
import {
  expectTranscriptText,
  findAgentManagerFrameAny,
  pickAgent,
  pickVariant,
  realTabStates,
  requestRgCanonicalState,
  requestRgSeedCredential,
  sendTurnWithPin,
  snapshotClient,
  waitForAgentOption,
  waitForFile,
  waitForLabel,
  waitForModelSelected,
  type E2EPlan,
} from "./e2e-probe-dom"
import { realRootSession } from "./e2e-probe-worktree"

/**
 * The single prompt typed into the real prompt input. Contains NO
 * scripted-model marker substring, so the loopback provider answers through
 * its default text branch: one real completed text turn, the smallest shape
 * that still enqueues a Runner generation.
 */
export const REAL_GENERATION_PROMPT = "E2E generation owner probe: reply briefly"

/**
 * real-generation only: create the run-owned scripted SSE provider and write
 * the MINIMAL workspace seed BEFORE VS Code launches.
 */
export async function prepareRealGeneration(
  workspace: string,
  real: boolean,
): Promise<ScriptedModelHandle | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const scratch = join(workspace, "..")
  const seed = writeRealGenerationSeed(workspace, handle.port, scratch)
  console.log(`[probe] real-generation seed: ${seed.configFile} (scripted model port ${handle.port})`)
  return handle
}

/** Fresh canonical gate must be proven before the first canonical-era session. */
async function checkGate(scratch: string): Promise<void> {
  await waitForFile(join(scratch, "canonical-gate.json"), 30_000, "canonical gate before generation")
  let gate: unknown
  try {
    gate = JSON.parse(readFileSync(join(scratch, "canonical-gate.json"), "utf8"))
  } catch {
    throw new Error("probe: canonical gate malformed")
  }
  const err = validateGateEvidence(gate)
  if (err) throw new Error(`probe: canonical gate invalid: ${err}`)
  const dataRoot = (gate as Record<string, unknown>).dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error("probe: canonical dataRoot not isolated inside scratch")
  }
}

/** Credential provisioning evidence (real SecretStorage, no bypass). */
async function checkCredential(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  const file = join(scratch, "rg-credential.json")
  await waitForFile(file, timeout, "rg-credential.json")
  const cred = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  if (cred.ok !== true) throw new Error(`probe: rg credential failed ${JSON.stringify(cred)}`)
  const connected = (cred as { connected?: unknown }).connected
  if (!Array.isArray(connected) || !connected.includes(plan.customProvider)) {
    throw new Error("probe: rg credential missing connected provider")
  }
  if ((cred as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`) {
    throw new Error("probe: rg credential wrong defaultModel")
  }
  const fresh = await requestRgSeedCredential(scratch, timeout)
  if (fresh.ok !== true) throw new Error(`probe: rg credential round-trip failed ${JSON.stringify(fresh)}`)
}

/** Canonical provider state must show the run-owned provider connected + ready. */
async function checkCanonical(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  const cstate = await requestRgCanonicalState(scratch, timeout)
  const prov = (
    cstate as {
      providerIndex?: { connected?: unknown; entries?: Array<{ id: string; hasCredential: boolean }> } | null
    }
  ).providerIndex
  if (!prov || !Array.isArray(prov.connected) || !prov.connected.includes(plan.customProvider)) {
    throw new Error("probe: rg canonical state missing connected provider")
  }
  const entry = prov.entries?.find((e) => e.id === plan.customProvider)
  if (!entry?.hasCredential) throw new Error("probe: rg hasCredential false")
  if ((cstate as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`) {
    throw new Error("probe: rg defaultModel wrong")
  }
  if ((cstate as { materializationReady?: unknown }).materializationReady !== true) {
    throw new Error("probe: rg canonical state not ready")
  }
}

/** Pick the seeded custom agent + Low variant + visibly selected custom model. */
async function pickIdentity(frame: Frame, plan: E2EPlan, timeout: number): Promise<void> {
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected")
}

/** Served-backend truth for the narrow turn: default-reply text, idle, zero tools. */
function turnProbe(s: BackendSnapshot): string | undefined {
  const root = realRootSession(s)
  if (!root) return "no root session yet"
  const msgs = s.messages[root.id] ?? []
  const answer = msgs.find((m) => m.role === "assistant" && m.text.includes(SCRIPTED.defaultReply))
  if (!answer) return `no default-reply assistant message yet; status=${s.statuses[root.id] ?? "idle"}`
  const tools = msgs.flatMap((m) => m.tools ?? [])
  if (tools.length > 0) return `narrow turn must use no tools, got ${tools.map((t) => t.tool).join(",")}`
  if ((s.statuses[root.id] ?? "idle") !== "idle") return `session status=${s.statuses[root.id]} expected idle`
  return undefined
}

async function sendTurn(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  exp: PinExpectation,
  timeout: number,
): Promise<BackendSnapshot> {
  return sendTurnWithPin(frame, snap, REAL_GENERATION_PROMPT, turnProbe, "real-generation single completed text turn", timeout, {
    exp,
    prompt: REAL_GENERATION_PROMPT,
    sessionID: (s) => realRootSession(s)?.id,
  })
}

function checkOperations(proofs: TerminalProof[]): void {
  for (const p of proofs) {
    if (!p.operation) throw new Error(`REAL BUG: prompt operation receipt missing for ${p.members[0]!.promptOpID}`)
    if (p.operation.outcome !== "succeeded") {
      throw new Error(`REAL BUG: prompt operation outcome must be succeeded, got ${p.operation.outcome}`)
    }
    if (!p.receipt) throw new Error(`REAL BUG: session_operation_receipt missing for run-owned prompt ${p.members[0]!.promptOpID}`)
    if (p.receipt.outcome !== p.operation.outcome || p.receipt.time !== p.operation.time) {
      throw new Error(`REAL BUG: prompt receipt outcome/time must match operation row for ${p.members[0]!.promptOpID}`)
    }
    if (p.receipt.replay !== "forbidden") throw new Error(`REAL BUG: prompt receipt replay must be forbidden for ${p.members[0]!.promptOpID}`)
    if (p.receipt.genID !== p.gid) throw new Error(`REAL BUG: prompt receipt gen must equal owner ${p.gid} via member`)
    if (p.owner.reason === "completed" && (p.receipt.used !== p.owner.used || p.receipt.limit !== p.owner.limit)) {
      throw new Error(`REAL BUG: prompt receipt owner_used/owner_limit must match generation owner at terminal for ${p.gid}`)
    }
    const byOp = new Map(p.providerReceipts.map((r) => [r.opId, r]))
    for (const o of p.providers.filter((x) => x.genID === p.gid && x.outcome === "succeeded")) {
      const pr = byOp.get(o.opId)
      if (!pr) throw new Error(`REAL BUG: session_operation_receipt missing for linked succeeded provider ${String(o.opId)}`)
      if (pr.outcome !== o.outcome || pr.time !== o.time) {
        throw new Error(`REAL BUG: provider receipt outcome/time must match operation row for ${String(o.opId)}`)
      }
      if (pr.replay !== "forbidden" || pr.genID !== p.gid) {
        throw new Error(`REAL BUG: provider receipt gen/replay mismatch for ${String(o.opId)}`)
      }
    }
  }
  if (!proofs.some((p) => p.owner.reason === "completed")) {
    throw new Error("REAL BUG: no completed owner among real-generation proofs")
  }
  console.log(
    `[probe] operation receipts: ${proofs.map((p) => `${p.gid} prompt=${p.receipt ? 1 : 0} providerReceipts=${p.providerReceipts.length}`).join(", ")}`,
  )
}

async function writeEvidence(opts: {
  scratch: string
  url: string
  plan: E2EPlan
  rootId: string
  model: ScriptedModelHandle
  pins: ReturnType<typeof pinReport>[]
  llmMatrix: ReturnType<typeof assertRunOwnedLlmRequests>
  proofs: TerminalProof[]
  frame: Frame
}): Promise<void> {
  const { scratch, url, plan, rootId, model, pins, llmMatrix, proofs, frame } = opts
  writeFileSync(
    join(scratch, "real-generation-dom-evidence"),
    JSON.stringify(
      {
        url,
        plan,
        rootId,
        modelRequests: model.requests.map((r) => ({ url: r.url, body: r.body })),
        pins,
        llmRequests: readLlmRequests(scratch),
        llmMatrix,
        owners: proofs.map((p) => ({
          opId: p.members[0]!.promptOpID,
          gid: p.gid,
          members: p.members.length,
          reason: p.owner.reason,
          limit: p.owner.limit,
          used: p.owner.used,
          occurrence: p.owner.occurrence,
          closedAt: p.owner.closedAt,
          nextAt: p.owner.nextAt,
          operation: p.operation
            ? { opId: p.operation.opId, outcome: p.operation.outcome, code: p.operation.code }
            : null,
          providers: p.providers.length,
          linked: p.providers.filter((o) => o.genID === p.gid).length,
          providerOps: p.providers.map((o) => ({ opId: o.opId, outcome: o.outcome, genID: o.genID })),
          receipt: p.receipt
            ? {
                opId: p.receipt.opId,
                outcome: p.receipt.outcome,
                time: p.receipt.time,
                genID: p.receipt.genID,
                used: p.receipt.used,
                limit: p.receipt.limit,
                replay: p.receipt.replay,
              }
            : null,
          providerReceipts: p.providerReceipts.length,
          providerReceiptOps: p.providerReceipts.map((r) => ({ opId: r.opId, outcome: r.outcome, genID: r.genID })),
        })),
        finalTabs: await realTabStates(frame),
      },
      null,
      2,
    ),
  )
}

/**
 * Drive ONE real completed text turn through the production webview path and
 * prove the terminal generation-owner facts read-only through the Bun gate.
 */
export async function assertRealGenerationLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  model: ScriptedModelHandle,
  pkgRoot: string,
): Promise<void> {
  const timeout = 30_000
  await checkGate(scratch)
  await waitForFile(join(scratch, "rg-ready"), 120_000, "rg-ready marker")
  await checkCredential(scratch, plan, timeout)
  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame
  const snap = snapshotClient(scratch, "rg-snap")
  await checkCanonical(scratch, plan, timeout)
  await pickIdentity(frame, plan, timeout)
  const exp = pinExpect(plan, plan.customAgent, plan.customVariantA)
  const snapTurn = await sendTurn(frame, snap, exp, timeout)
  const rootId = realRootSession(snapTurn)!.id
  console.log(`[probe] real-generation session: ${rootId}`)
  await expectTranscriptText(frame, SCRIPTED.defaultReply, 60_000, "real-generation panel shows the reply text")
  const finalPinSnap = await snap.request()
  const rootFinal = realRootSession(finalPinSnap)!
  const pins = [pinReport(finalPinSnap, rootFinal.id, exp, REAL_GENERATION_PROMPT)]
  console.log(`[probe] PIN EVIDENCE: ${JSON.stringify(pins, null, 2)}`)
  const llmMatrix = assertRunOwnedLlmRequests(scratch, "real-generation-final")
  const proofs = assertRealSnapGenerations(pkgRoot, scratch, canonicalDbPath(scratch), "rg-snap", "real-generation-owners.json")
  checkOperations(proofs)
  await writeEvidence({ scratch, url: found.url, plan, rootId, model, pins, llmMatrix, proofs, frame })
  console.log("[probe] real-generation lifecycle passed")
}
