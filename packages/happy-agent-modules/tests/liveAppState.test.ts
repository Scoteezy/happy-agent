import { describe, expect, it } from "vitest";
import type { LiveAppState, LiveDesktopContext } from "@slopus/happy-agent-client";
import {
    LIVE_APPEND_BYTES,
    liveAppStateAppends,
    liveAppStateEntities,
    liveAppStateView,
    liveControllerAppState,
    liveTargetKey,
} from "../sources/live/impl/liveAppState.js";
import { liveMentionedTarget } from "../sources/live/impl/liveMentionedTarget.js";

/** 3:42 PM on October 12, 2026 in Los Angeles. */
const now = Date.UTC(2026, 9, 12, 22, 42);
const minutesAgo = (minutes: number) => now - minutes * 60_000;
const notes = { connectionId: "local", groupId: "garden", sessionId: "notes" };
const release = { connectionId: "local", groupId: "garden", sessionId: "release" };
const garden = {
    kind: "workspace" as const,
    connectionId: "local",
    projectId: "observatory",
    workspaceId: "garden",
    groupId: "garden",
};
const observatory = {
    kind: "project" as const,
    connectionId: "local",
    projectId: "observatory",
    groupId: "observatory",
};

function appState(): LiveAppState {
    return {
        timeZone: "America/Los_Angeles",
        servers: [
            {
                connectionId: "local",
                name: "This Mac",
                kind: "local",
                online: true,
                catalog: "ready",
                bots: [
                    {
                        target: {
                            kind: "bot",
                            connectionId: "local",
                            groupId: "bots",
                            sessionId: "happy-agent",
                            botId: "happy",
                        },
                        name: "Happy",
                        status: "running",
                        lastActivityAt: minutesAgo(2),
                    },
                ],
                tasks: [],
                projects: [
                    {
                        target: observatory,
                        name: "Observatory",
                        sessions: [],
                        workspaces: [
                            {
                                target: garden,
                                name: "Garden",
                                status: "ready",
                                sessions: [
                                    {
                                        target: notes,
                                        title: "Garden notes",
                                        status: "idle",
                                        lastActivityAt: minutesAgo(42),
                                    },
                                    {
                                        target: release,
                                        title: "Release notes",
                                        status: "idle",
                                        lastActivityAt: Date.UTC(2026, 9, 9, 22, 0),
                                    },
                                ],
                            },
                        ],
                    },
                ],
                models: [],
            },
        ],
        focused: {
            target: { kind: "session", ...notes },
            title: "Garden notes",
            latestMessage: {
                state: "loaded",
                role: "assistant",
                text: "The requested changes are complete.",
                truncated: false,
            },
        },
        truncated: false,
    };
}

describe("Desktop AppState for voice", () => {
    it("splits a large push into labeled appends without losing a line", () => {
        const body = Array.from(
            { length: 40 },
            (_, index) => `- Conversation ${index} — a deliberately long description line`,
        ).join("\n");
        const appends = liveAppStateAppends("Sidebar", body);
        expect(appends.length).toBeGreaterThan(1);
        for (const [index, text] of appends.entries()) {
            expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_APPEND_BYTES);
            expect(text.startsWith(`# Sidebar (part ${index + 1} of ${appends.length})\n`)).toBe(
                true,
            );
        }
        expect(appends.map((text) => text.slice(text.indexOf("\n") + 1)).join("\n")).toBe(body);
        expect(liveAppStateAppends("Sidebar", "- Happy")).toEqual(["# Sidebar\n- Happy"]);
    });

    it("keys an agent target apart from every desktop target", () => {
        expect(liveTargetKey({ kind: "agent", connectionId: "local", agentId: "notes" })).toBe(
            JSON.stringify(["agent", "local", "notes"]),
        );
        expect(liveTargetKey(notes)).toBe(liveTargetKey({ kind: "session", ...notes }));
        expect(liveTargetKey(notes)).not.toBe(
            liveTargetKey({ kind: "agent", connectionId: "local", agentId: "notes" }),
        );
    });

    it("describes a desktop without AppState from its accepted context", () => {
        const context: LiveDesktopContext = {
            windowId: "window",
            connections: [{ connectionId: "local", name: "My Mac", online: true }],
            activeConnectionId: "local",
            activeTarget: { kind: "session", ...notes },
            projects: [{ target: observatory, name: "Observatory" }],
            workspaces: [{ target: garden, name: "Garden", status: "preparing" }],
            sessions: [
                { target: notes, title: "Garden notes", status: "idle" },
                {
                    target: { ...notes, groupId: "elsewhere", sessionId: "loose" },
                    title: null,
                    status: "error",
                },
            ],
            bots: [],
            activeSession: {
                target: notes,
                status: "idle",
                composerHasDraft: true,
                writeRefusal: null,
                messages: [{ id: "message", role: "assistant", text: "All done." }],
            },
            truncated: false,
        };
        const view = liveAppStateView(context, undefined);
        expect(liveAppStateEntities(view).map((entity) => entity.path.join(" / "))).toEqual([
            "My Mac / Observatory",
            "My Mac / Observatory / Garden",
            "My Mac / Observatory / Garden / Garden notes",
            "My Mac / Untitled conversation",
        ]);
        expect(view.focused).toEqual({
            target: { kind: "session", ...notes },
            title: null,
            latestMessage: {
                state: "loaded",
                role: "assistant",
                text: "All done.",
                truncated: false,
            },
        });
        expect(liveControllerAppState(context)).toMatchObject({
            activeSession: { target: notes, composerHasDraft: true },
        });
        expect(JSON.stringify(liveControllerAppState(context))).not.toContain("All done.");
    });

    it("highlights only a uniquely named entity before the controller runs", () => {
        const state = appState();
        expect(liveMentionedTarget(state, "open garden notes please")).toEqual({
            kind: "session",
            ...notes,
        });
        expect(liveMentionedTarget(state, "Open Garden notes in Observatory")).toEqual({
            kind: "session",
            ...notes,
        });
        expect(liveMentionedTarget(state, "show me the garden")).toEqual(garden);
        expect(
            liveMentionedTarget(state, "compare garden notes with release notes"),
        ).toBeUndefined();
        expect(liveMentionedTarget(state, "Stage a message for Happy")).toEqual(
            state.servers[0]!.bots[0]!.target,
        );
        expect(liveMentionedTarget(state, "gardening tips")).toBeUndefined();
        const twin = structuredClone(state);
        twin.servers[0]!.projects[0]!.sessions.push({
            target: { ...notes, groupId: "observatory", sessionId: "twin" },
            title: "Garden notes",
            status: "idle",
            lastActivityAt: null,
        });
        expect(liveMentionedTarget(twin, "open garden notes")).toBeUndefined();
    });
});
