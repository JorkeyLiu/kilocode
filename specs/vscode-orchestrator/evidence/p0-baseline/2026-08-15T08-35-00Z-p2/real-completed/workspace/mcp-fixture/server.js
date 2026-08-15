import { Server } from "file:///Users/jorkeyliu/workspace/repos/kilocode/packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"
import { StdioServerTransport } from "file:///Users/jorkeyliu/workspace/repos/kilocode/packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "file:///Users/jorkeyliu/workspace/repos/kilocode/packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"
import { appendFileSync } from "node:fs"

const server = new Server({ name: "e2e-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "e2e_echo",
      description: "Echo a message back",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {}
  const message = String(args.message ?? "")
  appendFileSync(process.env.E2E_MCP_LOG ?? "mcp-fixture/calls.log", "echo:" + message + "\n")
  return { content: [{ type: "text", text: "echo:" + message }] }
})
const transport = new StdioServerTransport()
await server.connect(transport)
