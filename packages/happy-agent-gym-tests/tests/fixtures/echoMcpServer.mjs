// A stdio MCP server with one tool, `echo`, that answers with its label and the text it was given.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const label = process.argv[2] ?? "echo";
const server = new Server(
    { name: `${label}-server`, version: "1.0.0" },
    { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "echo",
            description: "Echo the text back.",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `${label}:${String(request.params.arguments?.text ?? "")}` }],
}));
await server.connect(new StdioServerTransport());
