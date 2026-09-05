import { describe, expect, test } from "bun:test"
import * as vscode from "vscode"
import { RemoteStatusService } from "../../src/services/RemoteStatusService"
import {
  canonicalRemoteStatusOpId,
  validateRemoteStatusResult,
} from "../../src/services/cli-backend/serve-private-peer"

function client(data: { enabled: boolean; connected: boolean }) {
  return {
    remote: {
      status: async () => ({ data }),
    },
  }
}

function withWorkspace(dir: string, fn: () => Promise<void>): Promise<void> {
  const ws = vscode.workspace as unknown as Record<string, unknown>
  const orig = ws.workspaceFolders
  ws.workspaceFolders = [{ uri: { fsPath: dir } }] as never
  return fn().finally(() => {
    ws.workspaceFolders = orig as never
  })
}

function successResult(enabled: boolean, connected: boolean) {
  const opId = canonicalRemoteStatusOpId("tok1")
  const req = {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/status" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
  return validateRemoteStatusResult(
    {
      v: 1,
      requestId: "r1",
      opId,
      op: "remote/status",
      idempotencyKey: opId,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { enabled, connected } },
    },
    req as never,
  )
}

describe("RemoteStatusService private parity wiring (SDK authoritative)", () => {
  test("refresh keeps SDK authority and observes detached private parity", async () => {
    await withWorkspace("/tmp", async () => {
      const svc = new RemoteStatusService()
      try {
        svc.setClient(client({ enabled: true, connected: false }) as never)
        let observed = 0
        let observedDir = ""
        const conn = {
          isPrivateAvailable: () => true,
          privateRemoteStatusOutcomeWithHandle: (req: unknown) => {
            observed += 1
            observedDir = (req as { context: { directory: string } }).context.directory
            return {
              id: 1,
              promise: Promise.resolve({ kind: "valid", result: successResult(true, false) }) as never,
              cancel: () => true,
            }
          },
        }
        svc.setParityConnection(conn as never)
        await svc.refresh()
        expect(svc.getState()).toEqual({ enabled: true, connected: false })
        await new Promise((r) => setTimeout(r, 50))
        expect(observed).toBe(1)
        expect(observedDir).toBe("/tmp")
      } finally {
        svc.dispose()
      }
    })
  })

  test("parity divergence is warn-only and cannot mutate SDK state", async () => {
    await withWorkspace("/tmp", async () => {
      const svc = new RemoteStatusService()
      try {
        svc.setClient(client({ enabled: true, connected: false }) as never)
        const warns: unknown[][] = []
        const orig = console.warn
        console.warn = (...args: unknown[]) => {
          warns.push(args)
        }
        try {
          const conn = {
            isPrivateAvailable: () => true,
            privateRemoteStatusOutcomeWithHandle: () => ({
              id: 1,
              promise: Promise.resolve({ kind: "valid", result: successResult(false, true) }) as never,
              cancel: () => true,
            }),
          }
          svc.setParityConnection(conn as never)
          await svc.refresh()
          expect(svc.getState()).toEqual({ enabled: true, connected: false })
          await new Promise((r) => setTimeout(r, 50))
          expect(svc.getState()).toEqual({ enabled: true, connected: false })
          expect(warns.some((w) => String(w[0]).includes("parity divergence"))).toBeTrue()
        } finally {
          console.warn = orig
        }
      } finally {
        svc.dispose()
      }
    })
  })

  test("refresh without parity connection stays SDK-only and never throws", async () => {
    await withWorkspace("/tmp", async () => {
      const svc = new RemoteStatusService()
      try {
        svc.setClient(client({ enabled: false, connected: false }) as never)
        svc.setParityConnection(null)
        await svc.refresh()
        expect(svc.getState()).toEqual({ enabled: false, connected: false })
      } finally {
        svc.dispose()
      }
    })
  })
})
