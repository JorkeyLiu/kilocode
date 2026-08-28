import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Admission } from "../src/route/admission"

test("keeps concurrent request carriers isolated through a shared fetch wrapper", async () => {
  const seen: string[] = []
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let count = 0
  const fetch = async () => {
    count += 1
    if (count === 2) release()
    await ready
    await Admission.consumeSync()
  }
  const request = (label: string) => Admission.run(Effect.sync(() => void seen.push(label)), Effect.promise(fetch))

  const runs = Promise.all([Effect.runPromise(request("one")), Effect.runPromise(request("two"))])
  await ready
  await runs
  expect(seen.sort()).toEqual(["one", "two"])
})
