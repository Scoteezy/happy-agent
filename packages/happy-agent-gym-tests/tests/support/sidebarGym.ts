import { createAgentGym } from "@slopus/happy-agent-gym";

export type SidebarDocument = {
    artifactId: string;
    version: number;
    html: string;
    spaces: {
        id: string;
        title: string | null;
        target: { id: string; agentId: string | null };
        working: boolean;
        icon: { type: string; slug?: string } | null;
    }[];
    agentIcons?: Record<string, { type: string; slug: string }>;
    seed?: true;
};
export type SidebarStem = {
    space: {
        id: string;
        target: { id: string; agentId: string };
        placement: string;
        sectionId: string | null;
    };
    agent: { id: string };
};

/** Every operation enters through the real API and the manager's real tool loop. */
export async function sidebarGym() {
    let command: { token: string; name: string; args: unknown } | undefined;
    let sequence = 0;
    const gym = await createAgentGym({
        timeoutMs: 30000,
        inference: (request) => {
            if (request.instructions.includes("<outcome>"))
                return {
                    content: [
                        {
                            type: "text",
                            text: "<review><outcome>allow</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>Scripted sidebar artifact publication.</rationale></review>",
                        },
                    ],
                };
            // Naming answers with a title far too long for the sidebar, to prove it is cut.
            if (request.instructions.includes("You name a piece of work"))
                return {
                    content: [
                        {
                            type: "text",
                            text: "<title>Sidebar UI fixes and draggable spaces</title>\n<slug>sidebar-ui-fixes</slug>",
                        },
                    ],
                };
            const last = request.messages.at(-1);
            if (
                command !== undefined &&
                last?.role === "user" &&
                JSON.stringify(last).includes(command.token)
            ) {
                const call = command;
                command = undefined;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: call.name,
                            arguments: call.args,
                            callId: call.token,
                        },
                    ],
                };
            }
            return {
                delayMs:
                    JSON.stringify(last).includes("Keep running") &&
                    !request.instructions.includes("You are Prioritizing")
                        ? 60000
                        : 0,
                content: [{ type: "text", text: "Done." }],
            };
        },
    });
    const read = () => gym.http.ok<SidebarDocument>("GET", "/v0/spaces/sidebar");
    const manager = async () =>
        await gym.waitUntil(
            () =>
                gym.inference.requests.find((request) =>
                    request.instructions.includes("You are Prioritizing"),
                )?.sessionId,
            "Prioritizing's opening turn",
        );
    const call = async (name: string, args: unknown, sessionId?: string) => {
        sessionId ??= await manager();
        const token = `sidebar_scenario_${++sequence}`;
        command = { token, name, args };
        await gym.send(`Execute sidebar request ${token}.`, { sessionId });
        return await gym.waitUntil(
            () => gym.inference.toolResults().find((result) => result.callId === token),
            "the sidebar tool result",
        );
    };
    const edit = async (html: string) => {
        const current = await read();
        return await call("edit_sidebar", {
            baseVersion: current.version,
            edits: [{ oldText: current.html, newText: html }],
        });
    };
    const calm = async () => await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
    const hold = async () =>
        await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
    const create = async (sectionId?: string) =>
        await gym.http.ok<SidebarStem>(
            "POST",
            "/v0/spaces/stem-cells",
            sectionId === undefined ? {} : { sectionId },
        );
    /** The first notice after Prioritizing's opening ends the classic-sidebar seed. */
    const unseed = async () => {
        await manager();
        await gym.http.request("POST", "/v0/spaces/tidy", {});
        await gym.waitUntil(
            async () => ((await read()).seed === undefined ? true : undefined),
            "the end of the seed",
        );
    };
    return { gym, read, call, edit, calm, hold, create, manager, unseed };
}
