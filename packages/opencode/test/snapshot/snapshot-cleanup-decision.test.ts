import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { resolveLiveForPrune, shouldPrune } from "../../src/snapshot/cleanup-decision"

const projectID = ProjectV2.ID.make(`proj-${crypto.randomUUID().slice(0, 8)}`)

describe("snapshot cleanup decision", () => {
  test("absent Database service skips prune", async () => {
    const live = await Effect.runPromise(resolveLiveForPrune(projectID))
    expect(live).toBeNull()
    expect(shouldPrune(live)).toBe(false)
  })

  test("collection failure skips prune", async () => {
    const failingDb = {
      select: () => {
        throw new Error("simulated collection failure")
      },
    } as never
    const failing = Layer.succeed(Database.Service, { db: failingDb })
    const live = await Effect.runPromise(resolveLiveForPrune(projectID).pipe(Effect.provide(failing)))
    expect(live).toBeNull()
    expect(shouldPrune(live)).toBe(false)
  })

  test("shouldPrune true when live set present", () => {
    expect(shouldPrune(new Set(["abc"]))).toBe(true)
    expect(shouldPrune(new Set())).toBe(true)
  })
})
