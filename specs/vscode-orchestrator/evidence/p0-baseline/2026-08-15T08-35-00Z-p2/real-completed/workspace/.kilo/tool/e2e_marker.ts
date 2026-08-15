import { tool } from "file:///Users/jorkeyliu/workspace/repos/kilocode/packages/plugin/src/tool.ts"
import { writeFileSync } from "node:fs"
export default tool({
  description: "Echo a message back",
  args: { message: tool.schema.string().describe("message to echo") },
  execute: async ({ message }, ctx) => {
    writeFileSync(ctx.directory + "/e2e-custom-called.txt", "echo:" + message)
    return "echo:" + message
  },
})
