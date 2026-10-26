import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { mcpServerConfigSchema, mcpServerPageSchema } from "./Mcp.js";
import type { McpModule } from "./McpModule.js";

const configureMcpServerInputSchema = Type.Object(
    {
        action: Type.Union([Type.Literal("set"), Type.Literal("remove")]),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        server: Type.Optional(mcpServerConfigSchema),
        scope: Type.Optional(
            Type.Union([Type.Literal("user"), Type.Literal("folder")], {
                description:
                    'Where the server is configured. "user" (the default) writes ~/Happy/Config/mcp.toml, which every session uses. "folder" writes mcp.toml at the root of this session\'s folder (its project workspace, bot folder, or task folder), which only the agents working in that folder use.',
            }),
        ),
    },
    { additionalProperties: false },
);

const reloadMcpServersInputSchema = Type.Object(
    {
        global: Type.Optional(
            Type.Boolean({
                description:
                    "Reload the user-wide ~/Happy/Config/mcp.toml catalog instead of this folder's mcp.toml.",
            }),
        ),
    },
    { additionalProperties: false },
);

export function createMcpConfigurationTools(
    module: McpModule,
    agentId: string,
): readonly AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "configure_mcp_server",
            defer: true,
            capabilities: [
                "Configure Happy Agent MCP servers and reload them without restarting the daemon.",
            ],
            searchKeywords: ["add MCP server", "edit mcp.toml", "remove MCP server"],
            description:
                'Adds, replaces, or removes one server in ~/Happy/Config/mcp.toml, or with scope "folder" in mcp.toml at the root of this session\'s folder, then reloads the live MCP connections. Existing unrelated servers are preserved. A user-wide server wins over a folder server of the same name.',
            parameters: configureMcpServerInputSchema,
            returnType: mcpServerPageSchema,
            requiresAutoOrFullAccess: true,
            autoPermissionInstructions:
                'This updates the user-wide Happy MCP configuration, or with scope "folder" this folder\'s mcp.toml, and reconnects external servers.',
            describeAutoPermissionAction: ({ action, name, scope }) => {
                const verb = action === "remove" ? "removing" : "updating";
                return scope === "folder"
                    ? `${verb} MCP server “${name}” in ${module.workspaceMcpConfigLocation(agentId) ?? "this session's folder mcp.toml"}, which every agent working in that folder uses, and reloading that folder's external MCP connections`
                    : `${verb} MCP server “${name}” in ~/Happy/Config/mcp.toml, which every session uses, and reloading external MCP connections`;
            },
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            execute: async (ctx, input) => {
                if ((input.action === "set") !== (input.server !== undefined)) {
                    throw new Error(
                        input.action === "set"
                            ? "Setting an MCP server requires its configuration."
                            : "Removing an MCP server must not include configuration.",
                    );
                }
                const server = input.action === "remove" ? undefined : input.server;
                if (input.scope === "folder") {
                    await module.configureWorkspaceServer(ctx, agentId, input.name, server);
                } else {
                    await module.configureServer(ctx, input.name, server);
                }
                return await module.listServerPage(ctx, agentId, {}, "auto");
            },
            toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
        }),
        defineAgentTool({
            name: "reload_mcp_servers",
            defer: true,
            capabilities: [
                "Configure Happy Agent MCP servers and reload them without restarting the daemon.",
            ],
            searchKeywords: ["reload MCP", "reconnect MCP", "refresh mcp.toml"],
            description:
                "Reconciles the mcp.toml at the root of this session's folder (its project workspace, bot folder, or task folder) with the live shared MCP connections. Set global to true to reconcile ~/Happy/Config/mcp.toml instead. Unchanged connections keep running.",
            parameters: reloadMcpServersInputSchema,
            returnType: mcpServerPageSchema,
            requiresAutoOrFullAccess: true,
            describeAutoPermissionAction: ({ global }) =>
                global === true
                    ? "reconciling external MCP servers from ~/Happy/Config/mcp.toml"
                    : "reconciling external MCP servers from this session's folder mcp.toml",
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            execute: async (ctx, input) => {
                if (input.global === true) await module.reload(ctx);
                else await module.reloadWorkspace(ctx, agentId);
                return await module.listServerPage(ctx, agentId, {}, "auto");
            },
            toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
        }),
    ];
}
