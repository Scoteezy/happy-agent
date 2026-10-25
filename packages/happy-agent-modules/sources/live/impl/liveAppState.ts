import type {
    LiveActionSession,
    LiveActionTarget,
    LiveAppState,
    LiveAppStateServer,
    LiveDesktopContext,
    LiveDesktopTarget,
    LiveSessionRef,
} from "@slopus/happy-agent-client";

/** One provider append: 500 UTF-8 bytes conservatively fits the 500-token limit. */
export const LIVE_APPEND_BYTES = 500;
/**
 * AppState with an optional server kind and an extra conversation list, so a desktop without the
 * `appState` capability can still be described from its accepted context.
 */
export type LiveAppStateView = Omit<LiveAppState, "servers"> & {
    servers: (Omit<LiveAppStateServer, "kind" | "catalog"> & {
        kind?: LiveAppStateServer["kind"];
        catalog?: LiveAppStateServer["catalog"];
        conversations?: LiveAppStateServer["projects"][number]["sessions"];
    })[];
};

/** One named sidebar entity: its target, display name, and path for name matching. */
export interface LiveAppStateEntity {
    key: string;
    target: LiveDesktopTarget;
    session?: LiveSessionRef;
    connectionId: string;
    name: string;
    path: string[];
}

export function liveTargetKey(target: LiveActionTarget | LiveActionSession): string {
    if ("kind" in target && target.kind === "agent")
        return JSON.stringify(["agent", target.connectionId, target.agentId]);
    if (
        !("kind" in target) ||
        target.kind === "session" ||
        target.kind === "bot" ||
        target.kind === "task"
    )
        return JSON.stringify([
            "conversation",
            target.connectionId,
            target.groupId,
            target.sessionId,
        ]);
    return target.kind === "project"
        ? JSON.stringify(["project", target.connectionId, target.projectId, target.groupId])
        : JSON.stringify(["workspace", target.connectionId, target.workspaceId, target.groupId]);
}

/** Use the desktop's AppState when negotiated; otherwise describe the accepted context. */
export function liveAppStateView(
    context: LiveDesktopContext,
    appState: LiveAppState | undefined,
): LiveAppStateView {
    if (appState !== undefined) return appState;
    const sessionKeys = new Set<string>();
    const connectionIds = [
        ...context.connections.map((connection) => connection.connectionId),
        ...[...context.projects, ...context.bots, ...context.sessions].map(
            (item) => item.target.connectionId,
        ),
    ].filter((id, index, ids) => ids.indexOf(id) === index);
    const sessions = (groupId: string, connectionId: string) =>
        context.sessions
            .filter(
                (session) =>
                    session.target.connectionId === connectionId &&
                    session.target.groupId === groupId,
            )
            .map((session) => {
                sessionKeys.add(liveTargetKey(session.target));
                return { ...session, lastActivityAt: null };
            });
    const servers = connectionIds.map((connectionId) => {
        const connection = context.connections.find((item) => item.connectionId === connectionId);
        const bots = context.bots
            .filter((bot) => bot.target.connectionId === connectionId)
            .map((bot) => {
                sessionKeys.add(liveTargetKey(bot.target));
                return { ...bot, lastActivityAt: null };
            });
        const projects = context.projects
            .filter((project) => project.target.connectionId === connectionId)
            .map((project) => ({
                ...project,
                sessions: sessions(project.target.groupId, connectionId),
                workspaces: context.workspaces
                    .filter(
                        (workspace) =>
                            workspace.target.connectionId === connectionId &&
                            workspace.target.projectId === project.target.projectId,
                    )
                    .map((workspace) => ({
                        ...workspace,
                        sessions: sessions(workspace.target.groupId, connectionId),
                    })),
            }));
        return {
            connectionId,
            name: connection?.name ?? "Desktop",
            online: connection?.online ?? true,
            bots,
            tasks: [],
            projects,
            models: [],
            conversations: context.sessions
                .filter(
                    (session) =>
                        session.target.connectionId === connectionId &&
                        !sessionKeys.has(liveTargetKey(session.target)),
                )
                .map((session) => ({ ...session, lastActivityAt: null })),
        };
    });
    const active = context.activeTarget;
    const activeSession = context.activeSession;
    const latest = activeSession?.messages.at(-1);
    return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        servers,
        focused:
            active === null
                ? null
                : {
                      target: active,
                      title: null,
                      latestMessage:
                          activeSession === null ||
                          liveTargetKey(activeSession.target) !== liveTargetKey(active)
                              ? { state: "notLoaded" }
                              : latest === undefined
                                ? { state: "empty" }
                                : {
                                      state: "loaded",
                                      role: latest.role,
                                      text: latest.text,
                                      truncated: false,
                                  },
                  },
        truncated: context.truncated,
    };
}

/** Every named entity in sidebar order. */
export function liveAppStateEntities(view: LiveAppStateView): LiveAppStateEntity[] {
    const entities: LiveAppStateEntity[] = [];
    const conversation = (
        server: LiveAppStateView["servers"][number],
        session: { target: LiveSessionRef; title: string | null },
        path: string[],
    ) => {
        const name = session.title ?? "Untitled conversation";
        entities.push({
            key: liveTargetKey(session.target),
            target: { kind: "session", ...session.target },
            session: session.target,
            connectionId: server.connectionId,
            name,
            path: [...path, name],
        });
    };
    for (const server of view.servers) {
        for (const bot of server.bots)
            entities.push({
                key: liveTargetKey(bot.target),
                target: bot.target,
                session: sessionRef(bot.target),
                connectionId: server.connectionId,
                name: bot.name,
                path: [server.name, bot.name],
            });
        for (const task of server.tasks)
            entities.push({
                key: liveTargetKey(task.target),
                target: task.target,
                session: sessionRef(task.target),
                connectionId: server.connectionId,
                name: task.name,
                path: [server.name, task.name],
            });
        for (const project of server.projects) {
            const projectPath = [server.name, project.name];
            entities.push({
                key: liveTargetKey(project.target),
                target: project.target,
                connectionId: server.connectionId,
                name: project.name,
                path: projectPath,
            });
            for (const session of project.sessions) conversation(server, session, projectPath);
            for (const workspace of project.workspaces) {
                const workspacePath = [...projectPath, workspace.name];
                entities.push({
                    key: liveTargetKey(workspace.target),
                    target: workspace.target,
                    connectionId: server.connectionId,
                    name: workspace.name,
                    path: workspacePath,
                });
                for (const session of workspace.sessions)
                    conversation(server, session, workspacePath);
            }
        }
        for (const session of server.conversations ?? [])
            conversation(server, session, [server.name]);
    }
    return entities;
}

/** Split one push into provider appends at line boundaries; nothing is truncated. */
export function liveAppStateAppends(title: string, body: string): string[] {
    const reserve = Buffer.byteLength(`# ${title} (part 999 of 999)\n`);
    const budget = LIVE_APPEND_BYTES - reserve;
    const parts: string[] = [];
    let part = "";
    const flush = () => {
        if (part !== "") parts.push(part);
        part = "";
    };
    for (const line of body.split("\n")) {
        for (const piece of splitBytes(line, budget)) {
            const next = part === "" ? piece : `${part}\n${piece}`;
            if (Buffer.byteLength(next) > budget) {
                flush();
                part = piece;
            } else part = next;
        }
    }
    flush();
    if (parts.length <= 1) return [`# ${title}\n${parts[0] ?? ""}`.trimEnd()];
    return parts.map((text, index) => `# ${title} (part ${index + 1} of ${parts.length})\n${text}`);
}

/** Controller targets stay explicit; public message bodies are fetched only when requested. */
export function liveControllerAppState(context: LiveDesktopContext, appState?: LiveAppState) {
    return {
        ...context,
        activeSession:
            context.activeSession === null
                ? null
                : {
                      target: context.activeSession.target,
                      status: context.activeSession.status,
                      composerHasDraft: context.activeSession.composerHasDraft,
                      writeRefusal: context.activeSession.writeRefusal,
                  },
        ...(appState === undefined
            ? {}
            : {
                  sidebar: appState.servers.map((server) => ({
                      connectionId: server.connectionId,
                      name: server.name,
                      online: server.online,
                      bots: server.bots.map(({ target, name, status }) => ({
                          target,
                          name,
                          status,
                      })),
                      tasks: server.tasks.map(({ target, name, status }) => ({
                          target,
                          name,
                          status,
                      })),
                      projects: server.projects.map((project) => ({
                          target: project.target,
                          name: project.name,
                          sessions: project.sessions.map(({ target, title, status }) => ({
                              target,
                              title,
                              status,
                          })),
                          workspaces: project.workspaces.map((workspace) => ({
                              target: workspace.target,
                              name: workspace.name,
                              sessions: workspace.sessions.map(({ target, title, status }) => ({
                                  target,
                                  title,
                                  status,
                              })),
                          })),
                      })),
                      models: server.models.map(({ providerId, providerName, modelId, name }) => ({
                          providerId,
                          providerName,
                          modelId,
                          name,
                      })),
                  })),
                  focused:
                      appState.focused === null
                          ? null
                          : { target: appState.focused.target, title: appState.focused.title },
              }),
    };
}

function splitBytes(text: string, budget: number): string[] {
    if (Buffer.byteLength(text) <= budget) return [text];
    const pieces: string[] = [];
    let piece = "";
    let size = 0;
    for (const character of text) {
        const width = Buffer.byteLength(character);
        if (size + width > budget) {
            pieces.push(piece);
            piece = "";
            size = 0;
        }
        piece += character;
        size += width;
    }
    if (piece !== "") pieces.push(piece);
    return pieces;
}

function sessionRef(target: { connectionId: string; groupId: string; sessionId: string }) {
    return {
        connectionId: target.connectionId,
        groupId: target.groupId,
        sessionId: target.sessionId,
    };
}
