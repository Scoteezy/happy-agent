import { createId } from "@paralleldrive/cuid2";
import {
    cuid2Schema,
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { messageModeSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    detach,
    forever,
    isAbortedError,
    withLifetime,
    type Context,
    type RootContext,
} from "@steve.kite/stdlib";

import { BotsModule, type BotRecord } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { EventsModule } from "../events/index.js";
import { HistoryModule } from "../history/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule, type TaskRecord } from "../tasks/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, isUserOriginMetadata } from "../impl/messageOrigin.js";

import {
    SPACE_STANDALONE_OWNER,
    spaceManagerModelSchema,
    spaceOwnerIdSchema,
    SpaceConflictError,
    SpaceInputError,
    SpaceNotFoundError,
    type SpaceBatch,
    type SpaceDescription,
    type SpaceIconSlug,
    type SpaceManagerModel,
    type SpaceOwnerId,
    type SpaceOwnerState,
    type SpacePendingChange,
    type SpaceRecord,
    type SpaceRef,
    type SpaceSectionRecord,
    type SpaceSnapshot,
} from "./Space.js";
import { spaceEventSchema, type SpaceEvent, type SpaceEventListener } from "./SpaceEvent.js";
import { spaceMigrations } from "./SpaceMigrations.js";
import { applySpaceChanges, compareRows, rowKeyAfter } from "./impl/applySpaceChanges.js";
import { composeSpaceBatchNote } from "./impl/composeSpaceBatchNote.js";
import { formatSpaceManagerInstructions } from "./impl/formatSpaceManagerInstructions.js";
import { selectSpaceManagerRoute } from "./impl/selectSpaceManagerRoute.js";
import { spaceContentKey, spaceRefKey } from "./impl/spaceRefKey.js";
import {
    deletePendingChanges,
    insertBatch,
    insertSection,
    insertSpace,
    queryBatches,
    queryOwnerState,
    queryOwnerStates,
    queryOwnersWithPendingChanges,
    queryPendingChanges,
    querySection,
    querySections,
    querySpace,
    querySpaceByRef,
    querySpaces,
    querySpacesByAgent,
    querySpacesByRef,
    updateSection,
    updateSpace,
    updateSpaceBriefedAt,
    upsertPendingChange,
    writeOwnerState,
    deleteSection,
} from "./persistence/SpacesPersistence.js";
import { requestSpacePlacementTool } from "./tools/request_space_placement.js";
import { spaceManagerTools } from "./tools/spaceManagerTools.js";

/** Without a focus change or a message for this long, the person counts as idle, which is calm. */
export const SPACE_IDLE_MS = 2 * 60_000;
/**
 * A client that said the person is mid-interaction and then went silent is not trusted forever;
 * after this long without a word the hold lapses and idle rules apply again.
 */
export const SPACE_INTERACTION_HOLD_MS = 10 * 60_000;
/** How often queued changes are checked against the calm rule. */
const CALM_CHECK_INTERVAL_MS = 15_000;
const BRIEF_FUNCTION = "spaces.briefManager";
const MANAGER_METADATA_KEY = "spacesManagerFor";
const MAX_BRIEF_TEXT = 2_000;

const briefArgumentsSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        messageId: cuid2Schema,
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
    },
    { additionalProperties: false },
);

/**
 * One flat sidebar per person, kept tidy by a hidden manager.
 *
 * A space is one row: Happy, the manager (never shown), or an item wrapping a task, bot, Surface,
 * or other content. Sections are flat labels. New work is a stem cell: a fresh unnamed task
 * wrapped in a row that waits under Happy until the manager places it.
 *
 * Every organisation write goes through the manager's tools, except the person's own explicit
 * actions: dragging a row, collapsing a section, and creating new work. The manager's moves are
 * queued and applied together at a calm moment — a focus switch or idle — with one note in
 * Happy's chat and a recorded diff. Icons apply at once because they move nothing.
 */
export class SpacesModule implements AgentModule {
    readonly name = "spaces";
    readonly migrations = spaceMigrations;

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #history: HistoryModule;
    readonly #surfaces: SurfacesModule;
    readonly #tasks: TasksModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #listeners = new Set<SpaceEventListener>();
    /** When each person last showed they were at work. Calm is judged from this; it need not survive a restart. */
    readonly #activeAt = new Map<SpaceOwnerId, number>();
    readonly #focus = new Map<SpaceOwnerId, string | null>();
    /** When a client last said the person is mid-interaction (dragging, typing, navigating). */
    readonly #interactingSince = new Map<SpaceOwnerId, number>();
    /** People whose client signalled calm while their manager was still deciding. */
    readonly #calmSignalled = new Set<SpaceOwnerId>();
    /** Managers with a turn in progress; their batch waits until they finish. */
    readonly #busyManagers = new Set<string>();
    readonly #unsubscribe: (() => void)[] = [];
    #agents: AgentSystemRef | undefined;
    #lifetime: RootContext | undefined;
    #calmLoop: Promise<void> | undefined;
    readonly #loopLifetime = new AbortController();

    constructor(
        config: ConfigModule,
        tasks: TasksModule,
        bots: BotsModule,
        surfaces: SurfacesModule,
        history: HistoryModule,
        events: EventsModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#surfaces = surfaces;
        this.#history = history;
        this.#events = events;
        this.#durableFunctions = durableFunctions;
        // Telling the manager about new work commits with the work; the message is delivered
        // after the commit and survives a restart in between. A repeated delivery carries the
        // same message ID, so the manager hears it once.
        durableFunctions.register({
            name: BRIEF_FUNCTION,
            argumentsSchema: briefArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#deliverBrief(
                    ctx,
                    call.arguments.ownerUserId,
                    call.arguments.messageId,
                    call.arguments.text,
                );
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        afterStart: async (ctx: Context): Promise<void> => {
            this.#subscribe();
            const lifetime = this.#lifetime;
            if (lifetime === undefined) return;
            // The calm check belongs to the daemon and stops when this module closes.
            const signal =
                ctx.lifetime === undefined
                    ? this.#loopLifetime.signal
                    : AbortSignal.any([ctx.lifetime, this.#loopLifetime.signal]);
            this.#calmLoop = forever(
                withLifetime(lifetime.named("spaces-calm"), signal),
                { delay: CALM_CHECK_INTERVAL_MS, delayFirst: true, name: "spaces-calm" },
                async (loopCtx) => {
                    await this.#applyCalmBatches(loopCtx);
                },
            ).catch((error: unknown) => {
                if (!isAbortedError(error) && !signal.aborted) {
                    ctx.log.warn("Sidebar tidying stopped.", {}, error);
                }
            });
        },
        instructions: () => "",
        overrideInstructions: (_ctx, scope, input) =>
            managerOwner(scope.agent.metadata) === undefined
                ? input.instructions
                : formatSpaceManagerInstructions(),
        tools: async (ctx, scope): Promise<readonly AnyAgentTool[]> => {
            if (managerOwner(scope.agent.metadata) !== undefined) return [];
            // People ask for sidebar changes in the conversations they have, not in helpers.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            return [requestSpacePlacementTool(this, scope.agent.id)];
        },
        // The manager is one job with one tool array and nothing else.
        overrideTools: (_ctx, scope, input) => {
            const owner = managerOwner(scope.agent.metadata);
            return owner === undefined ? input.tools : spaceManagerTools(this, owner);
        },
        beforeAgentLoop: (_ctx, scope) => {
            if (managerOwner(scope.agent.metadata) !== undefined) {
                this.#busyManagers.add(scope.agent.id);
            }
        },
        afterAgentSettled: async (ctx, scope) => {
            const owner = managerOwner(scope.agent.metadata);
            if (owner === undefined) return;
            this.#busyManagers.delete(scope.agent.id);
            const lifetime = this.#lifetime;
            if (lifetime === undefined) return;
            // The manager has finished deciding; apply now if the person asked for it, or if
            // they are calm. Otherwise the calm check picks the batch up later.
            void this.#applyIfDue(lifetime.named("spaces-manager-settled"), owner, "settled").catch(
                (error: unknown) => {
                    ctx.log.warn("The sidebar batch could not be applied.", {}, error);
                },
            );
        },
        messageAcceptedTransact: async (ctx, scope, accepted) => {
            if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata)) {
                return;
            }
            const rows = await querySpacesByAgent(ctx, scope.agent.id);
            const now = Date.now();
            for (const row of rows) {
                afterCommit(ctx, () => {
                    this.#activeAt.set(row.ownerUserId, now);
                });
                // New work is told to the manager once, with what the person first asked.
                if (row.role !== "item" || row.briefedAt !== undefined) continue;
                if (row.icon !== undefined && row.icon.type !== "stem_cell") continue;
                const text = accepted.message.content
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .trim();
                if (text.length === 0) continue;
                await updateSpaceBriefedAt(ctx, row.id, now);
                await this.#brief(ctx, row.ownerUserId, newWorkBrief(row, text));
            }
        },
    };

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        this.#lifetime = withAgentDatabase(detach(ctx), ctx.db) as RootContext;
        return this.#hooks;
    };

    async close(): Promise<void> {
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        this.#lifetime = undefined;
        this.#loopLifetime.abort();
        await this.#calmLoop;
    }

    onEvent(listener: SpaceEventListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Who a person is as a sidebar owner: the standalone person, or a team user. */
    ownerFor(userId: string | undefined): SpaceOwnerId | undefined {
        return this.#tasks.memberFor(userId);
    }

    /**
     * A person's whole sidebar. The first read makes it: Happy, the hidden manager row, and a
     * row for everything the person already has, folded until the manager's first tidy.
     */
    async snapshot(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceSnapshot> {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const state = await this.#ownerState(txCtx, ownerUserId);
            return {
                spaces: sortForDisplay(await querySpaces(txCtx, ownerUserId)),
                sections: await querySections(txCtx, ownerUserId),
                pendingChanges: (await queryPendingChanges(txCtx, ownerUserId)).length,
                revision: state.revision,
            };
        });
    }

    async get(ctx: Context, spaceId: string): Promise<SpaceRecord | undefined> {
        return await querySpace(ctx, spaceId);
    }

    async section(ctx: Context, sectionId: string): Promise<SpaceSectionRecord | undefined> {
        return await querySection(ctx, sectionId);
    }

    async batches(ctx: Context, ownerUserId: SpaceOwnerId, limit: number): Promise<SpaceBatch[]> {
        return await queryBatches(ctx, ownerUserId, Math.max(1, Math.min(limit, 100)));
    }

    /** Resolve a row's content for display: its live title, what a click opens, and its activity. */
    async describe(ctx: Context, space: SpaceRecord): Promise<SpaceDescription> {
        const primary = space.contents[0];
        if (space.role === "manager") {
            return blankDescription("Sidebar manager", undefined);
        }
        if (primary === undefined) return blankDescription(space.name ?? "Untitled", undefined);
        switch (primary.kind) {
            case "task": {
                const task = await this.#tasks.get(ctx, primary.taskId);
                return await this.#agentDescription(ctx, space, {
                    title: task?.name ?? "Task",
                    target: {
                        kind: "task",
                        id: primary.taskId,
                        agentId: primary.agentId,
                        ...(task === undefined ? {} : { workspaceId: task.workspaceId }),
                    },
                    archived: task === undefined || task.status === "archived",
                    imageUrl: undefined,
                });
            }
            case "bot": {
                const bot = await this.#bots.get(ctx, primary.botId);
                return await this.#agentDescription(ctx, space, {
                    title: space.role === "happy" ? "Happy" : (bot?.name ?? "Bot"),
                    target: {
                        kind: "bot",
                        id: primary.botId,
                        agentId: primary.agentId,
                        ...(bot === undefined ? {} : { workspaceId: bot.workspaceId }),
                    },
                    archived: bot === undefined || bot.status === "archived",
                    imageUrl: bot?.avatar === undefined ? undefined : `/v0/bots/${bot.id}/avatar`,
                });
            }
            case "agent": {
                const config = await this.#requireAgents().config(ctx, primary.agentId);
                return await this.#agentDescription(ctx, space, {
                    title: config?.metadata?.title ?? "Conversation",
                    target: { kind: "agent", id: primary.agentId, agentId: primary.agentId },
                    archived: config === undefined,
                    imageUrl: undefined,
                });
            }
            case "surface": {
                const surface = (await this.#surfaces.list(ctx)).find(
                    (candidate) => candidate.id === primary.surfaceId,
                );
                return {
                    title: space.name ?? surface?.name ?? "List",
                    target: { kind: "surface", id: primary.surfaceId },
                    archived: surface === undefined,
                    working: false,
                    lastActivityAt: surface?.updatedAt,
                    imageUrl:
                        surface?.image === null || surface === undefined
                            ? undefined
                            : `/v0/surfaces/${surface.id}/image`,
                };
            }
            case "artifact":
                return blankDescription(space.name ?? "Artifact", {
                    kind: "artifact",
                    id: primary.artifactId,
                });
            case "file":
                return blankDescription(space.name ?? primary.path.split("/").at(-1) ?? "File", {
                    kind: "file",
                    id: `${primary.workspaceId}:${primary.path}`,
                    workspaceId: primary.workspaceId,
                    path: primary.path,
                });
        }
    }

    /**
     * Wrap a freshly created task in a stem-cell row. Without a section it waits under Happy for
     * the manager; with one, the person already chose where it goes, so it is settled at the top.
     */
    async createStemCell(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly spaceId: string;
            readonly task: TaskRecord;
            readonly sectionId?: string;
            readonly mutationId?: string;
        },
    ): Promise<SpaceRecord> {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const existing = await querySpace(txCtx, input.spaceId);
            if (existing !== undefined) return existing;
            if (input.sectionId !== undefined) {
                const section = await querySection(txCtx, input.sectionId);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const content: SpaceRef = {
                kind: "task",
                taskId: input.task.id,
                agentId: input.task.agentId,
            };
            // The task's own membership event may have made a plain row already; it becomes this one.
            const previous = await querySpaceByRef(txCtx, ownerUserId, spaceContentKey(content));
            const rows = await querySpaces(txCtx, ownerUserId);
            const siblings = rows.filter(
                (row) =>
                    row.role === "item" &&
                    row.sectionId === input.sectionId &&
                    row.id !== previous?.id,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: input.spaceId,
                ownerUserId,
                role: "item",
                icon: { type: "stem_cell" },
                contents: [content],
                ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
                orderKey: rowKeyAfter(siblings, null),
                placement: input.sectionId === undefined ? "pending" : "settled",
                visibility: "shown",
                ...(input.sectionId === undefined ? {} : { manualAt: now }),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            if (previous !== undefined) {
                // Hand the content over; the earlier row stays as an empty hidden record.
                await updateSpace(
                    txCtx,
                    {
                        ...previous,
                        contents: [],
                        visibility: "hidden",
                        version: previous.version + 1,
                        updatedAt: now,
                    },
                    previous.version,
                );
            }
            await insertSpace(txCtx, space);
            await this.#commitEvents(txCtx, ownerUserId, input.mutationId, [
                { type: "space_created", space },
            ]);
            return space;
        });
    }

    /**
     * The person dragged a row. Their own action applies at once, shows the row, settles it, and
     * marks it as placed by hand so the manager keeps it there until its state changes.
     */
    async move(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        sectionId: string | null,
        afterId: string | null,
        mutationId?: string,
    ): Promise<SpaceRecord> {
        if (afterId === spaceId)
            throw new SpaceConflictError("A row cannot be placed after itself.");
        return await ctx.inTx(async (txCtx) => {
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            if (space.role !== "item") {
                throw new SpaceConflictError("Happy and the sidebar manager cannot be moved.");
            }
            if (sectionId !== null) {
                const section = await querySection(txCtx, sectionId);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const target = sectionId ?? undefined;
            const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                (row) =>
                    row.role === "item" &&
                    row.id !== spaceId &&
                    row.visibility === "shown" &&
                    row.sectionId === target,
            );
            if (afterId !== null && !siblings.some((row) => row.id === afterId)) {
                throw new SpaceConflictError("The row to place after is not in that section.");
            }
            const now = Date.now();
            const next: SpaceRecord = {
                ...space,
                orderKey: rowKeyAfter(siblings, afterId),
                placement: "settled",
                visibility: "shown",
                manualAt: now,
                version: space.version + 1,
                updatedAt: now,
            };
            if (target === undefined) delete next.sectionId;
            else next.sectionId = target;
            await updateSpace(txCtx, next, space.version);
            // A queued move of this row would undo the person's choice.
            await deletePendingChanges(txCtx, ownerUserId, [`space:${spaceId}`]);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "space_updated", space: next, previousVersion: space.version },
            ]);
            return next;
        });
    }

    /** The person opened or closed a section, or its "+k more" tail. */
    async setSectionDisclosure(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        sectionId: string,
        disclosure: { readonly collapsed?: boolean; readonly tailExpanded?: boolean },
        mutationId?: string,
    ): Promise<SpaceSectionRecord> {
        return await ctx.inTx(async (txCtx) => {
            const section = await querySection(txCtx, sectionId);
            if (section === undefined || section.ownerUserId !== ownerUserId) {
                throw new SpaceNotFoundError("The section was not found.");
            }
            const next: SpaceSectionRecord = {
                ...section,
                collapsed: disclosure.collapsed ?? section.collapsed,
                tailExpanded: disclosure.tailExpanded ?? section.tailExpanded,
            };
            if (
                next.collapsed === section.collapsed &&
                next.tailExpanded === section.tailExpanded
            ) {
                return section;
            }
            next.version = section.version + 1;
            next.updatedAt = Date.now();
            await updateSection(txCtx, next, section.version);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "section_updated", section: next, previousVersion: section.version },
            ]);
            return next;
        });
    }

    /**
     * What the person is looking at. A report is a sign they are at work, so it defers the
     * idle rule; it never applies a batch by itself and never changes anything in the sidebar.
     */
    focus(ownerUserId: SpaceOwnerId, spaceId: string | null): void {
        this.#focus.set(ownerUserId, spaceId);
        this.#activeAt.set(ownerUserId, Date.now());
    }

    /**
     * The client's view of the person's attention. `interacting` holds every batch back until
     * the client says otherwise or goes quiet; `calm` — a navigation gesture just completed, or
     * the person is idle — applies the queued batch now, unless the manager is mid-decision, in
     * which case it applies as soon as the manager finishes. Returns the applied batch, if any.
     */
    async reportAttention(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        attention: "interacting" | "calm",
    ): Promise<SpaceBatch | undefined> {
        const now = Date.now();
        this.#activeAt.set(ownerUserId, now);
        if (attention === "interacting") {
            this.#interactingSince.set(ownerUserId, now);
            this.#calmSignalled.delete(ownerUserId);
            return undefined;
        }
        this.#interactingSince.delete(ownerUserId);
        return await this.#applyIfDue(ctx, ownerUserId, "calm");
    }

    /** "Tidy now": ask the manager, and apply its batch as soon as it finishes. */
    async requestTidy(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const state = await this.#ownerState(txCtx, ownerUserId);
            await writeOwnerState(txCtx, { ...state, applyRequestedAt: Date.now() });
            await this.#brief(
                txCtx,
                ownerUserId,
                "The person asked you to tidy the sidebar now. Read it with list_sidebar and apply the rules. Your changes apply as soon as you finish.",
            );
        });
    }

    /** Choose the manager's model, or `undefined` for the cheapest model of Happy's account. */
    async setManagerModel(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        model: SpaceManagerModel | undefined,
    ): Promise<void> {
        if (model !== undefined && !Value.Check(spaceManagerModelSchema, model)) {
            throw new SpaceInputError("The manager model is invalid.");
        }
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const state = await this.#ownerState(txCtx, ownerUserId);
            const next: SpaceOwnerState = { ...state };
            if (model === undefined) delete next.managerModel;
            else next.managerModel = model;
            await writeOwnerState(txCtx, next);
        });
    }

    /** The manager's view: everything it may judge, with IDs to act on. */
    async managerOverview(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string> {
        const snapshot = await this.snapshot(ctx, ownerUserId);
        const pending = await queryPendingChanges(ctx, ownerUserId);
        const now = Date.now();
        const describe = async (space: SpaceRecord): Promise<string> => {
            const description = await this.describe(ctx, space);
            const facts = [
                `id ${space.id}`,
                space.icon === undefined
                    ? "no icon"
                    : space.icon.type === "library"
                      ? `icon ${space.icon.slug}`
                      : space.icon.type === "stem_cell"
                        ? "new work, no icon yet"
                        : "own picture",
                description.target?.kind ?? "empty",
                description.working ? "working now" : undefined,
                description.lastActivityAt === undefined
                    ? undefined
                    : `last active ${formatAge(now - description.lastActivityAt)} ago`,
                description.archived ? "archived" : undefined,
                space.placement === "pending" ? "not placed yet" : undefined,
                space.manualAt === undefined ? undefined : "placed by the person",
            ].filter((fact) => fact !== undefined);
            return `- ${description.title} (${facts.join(", ")})`;
        };
        const items = snapshot.spaces.filter((space) => space.role === "item");
        const lines: string[] = ["Under Happy:"];
        for (const space of items.filter(
            (row) => row.visibility === "shown" && row.sectionId === undefined,
        )) {
            lines.push(await describe(space));
        }
        for (const section of snapshot.sections) {
            const extra = [
                section.context,
                section.visibleCount === undefined
                    ? undefined
                    : `shows first ${String(section.visibleCount)}`,
            ].filter((value) => value !== undefined);
            lines.push(
                "",
                `Section "${section.name}" (id ${section.id}${extra.length === 0 ? "" : `, ${extra.join(", ")}`}):`,
            );
            for (const space of items.filter(
                (row) => row.visibility === "shown" && row.sectionId === section.id,
            )) {
                lines.push(await describe(space));
            }
        }
        lines.push("", "Older:");
        for (const space of items.filter((row) => row.visibility === "folded")) {
            lines.push(await describe(space));
        }
        const hidden = items.filter(
            (row) => row.visibility === "hidden" && row.contents.length > 0,
        );
        lines.push("", `Hidden: ${String(hidden.length)} rows.`);
        for (const space of hidden.slice(0, 20)) lines.push(await describe(space));
        if (pending.length > 0) {
            lines.push("", `Queued for the next calm moment: ${String(pending.length)} changes.`);
            for (const change of pending) lines.push(`- ${JSON.stringify(change)}`);
        }
        return lines.join("\n");
    }

    /** Queue one manager change for the next calm moment. Only the manager calls this. */
    async queueChange(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: SpacePendingChange,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            if (change.type === "place" || change.type === "visibility") {
                const space = await this.#ownedSpace(txCtx, ownerUserId, change.spaceId);
                if (space.role !== "item") {
                    throw new SpaceConflictError("Happy and the sidebar manager cannot be moved.");
                }
            }
            if (change.type === "remove_section" || (change.type === "section" && !change.create)) {
                const section = await querySection(txCtx, change.sectionId);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const target =
                change.type === "place" || change.type === "visibility"
                    ? `space:${change.spaceId}`
                    : `section:${change.sectionId}`;
            // A section is changed by merging into what was already queued for it.
            let stored = change;
            if (change.type === "section") {
                const earlier = (await queryPendingChanges(txCtx, ownerUserId)).find(
                    (pending) =>
                        pending.type === "section" && pending.sectionId === change.sectionId,
                );
                if (earlier?.type === "section") {
                    stored = { ...earlier, ...change, create: earlier.create || change.create };
                }
            }
            await upsertPendingChange(txCtx, ownerUserId, target, stored, Date.now());
            const count = (await queryPendingChanges(txCtx, ownerUserId)).length;
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "batch_queued", pendingChanges: count },
            ]);
            const what =
                change.type === "section" && change.create
                    ? `Section ${change.sectionId} queued for creation`
                    : "Change queued";
            return `${what}. ${String(count)} changes wait for the next calm moment.`;
        });
    }

    /** Set an icon now. Only the manager calls this. */
    async setIcon(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        slug: SpaceIconSlug,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            if (space.role !== "item") throw new SpaceConflictError("Only item rows take icons.");
            if (space.icon?.type === "library" && space.icon.slug === slug) {
                return `The row already shows ${slug}.`;
            }
            const now = Date.now();
            const next: SpaceRecord = {
                ...space,
                icon: { type: "library", slug },
                version: space.version + 1,
                updatedAt: now,
            };
            await updateSpace(txCtx, next, space.version);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_updated", space: next, previousVersion: space.version },
            ]);
            return `Icon set to ${slug}.`;
        });
    }

    /**
     * Another agent asks for a row to move. The manager decides; when the person asked for it in
     * their own words, the result applies as soon as the manager finishes.
     */
    async requestPlacement(
        ctx: Context,
        actingAgentId: string,
        input: {
            readonly request: string;
            readonly agentId: string;
            readonly personAsked: boolean;
            readonly requestId: string;
        },
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            let rows = (await querySpacesByAgent(txCtx, input.agentId)).filter(
                (row) => row.role !== "manager",
            );
            if (rows.length === 0 && !this.#config.configuration.values.feature.team.enabled) {
                await this.#ensureOwner(txCtx, SPACE_STANDALONE_OWNER);
                rows = (await querySpacesByAgent(txCtx, input.agentId)).filter(
                    (row) => row.role !== "manager",
                );
            }
            if (rows.length === 0) {
                return "That conversation is not in anyone's sidebar, so there is nothing to move.";
            }
            for (const row of rows) {
                const description = await this.describe(txCtx, row);
                if (input.personAsked) {
                    const state = await this.#ownerState(txCtx, row.ownerUserId);
                    await writeOwnerState(txCtx, { ...state, applyRequestedAt: Date.now() });
                }
                await this.#brief(
                    txCtx,
                    row.ownerUserId,
                    [
                        `Agent ${actingAgentId} asks about the row "${description.title}" (id ${row.id}):`,
                        input.request.slice(0, MAX_BRIEF_TEXT),
                        input.personAsked
                            ? "The person asked for this explicitly, so your changes apply as soon as you finish."
                            : "Decide whether it fits the rules; it applies at the next calm moment.",
                    ].join("\n\n"),
                    // One request is one message, however often the tool call is retried.
                    `${input.requestId}:${row.ownerUserId}`,
                );
            }
            return input.personAsked
                ? "The sidebar manager will make the change shortly."
                : "The sidebar manager has the request and will apply it at a calm moment.";
        });
    }

    /**
     * Apply every queued change for one person as one batch: one transaction, one note in
     * Happy's chat, one recorded diff. Returns `undefined` when nothing was queued.
     */
    async applyBatch(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        reason: SpaceBatch["reason"],
    ): Promise<SpaceBatch | undefined> {
        return await ctx.inTx(async (txCtx) => {
            const state = await this.#ownerState(txCtx, ownerUserId);
            const pending = await queryPendingChanges(txCtx, ownerUserId);
            const cleared: SpaceOwnerState = { ...state };
            delete cleared.applyRequestedAt;
            if (pending.length === 0) {
                if (state.applyRequestedAt !== undefined) {
                    await writeOwnerState(txCtx, cleared);
                }
                return undefined;
            }
            const spaces = await querySpaces(txCtx, ownerUserId);
            const sections = await querySections(txCtx, ownerUserId);
            const titles = new Map<string, string>();
            for (const space of spaces) {
                if (space.role === "item") {
                    titles.set(space.id, (await this.describe(txCtx, space)).title);
                }
            }
            const now = Date.now();
            const outcome = applySpaceChanges(ownerUserId, spaces, sections, pending, titles, now);
            for (const section of outcome.createdSections) await insertSection(txCtx, section);
            for (const { section, previousVersion } of outcome.updatedSections) {
                await updateSection(txCtx, section, previousVersion);
            }
            for (const { space, previousVersion } of outcome.spaces) {
                await updateSpace(txCtx, space, previousVersion);
            }
            for (const sectionId of outcome.removedSectionIds)
                await deleteSection(txCtx, sectionId);
            await deletePendingChanges(txCtx, ownerUserId);
            await writeOwnerState(txCtx, cleared);
            const events: SpaceEventDraft[] = [
                ...outcome.createdSections.map(
                    (section): SpaceEventDraft => ({ type: "section_created", section }),
                ),
                ...outcome.updatedSections.map(
                    ({ section, previousVersion }): SpaceEventDraft => ({
                        type: "section_updated",
                        section,
                        previousVersion,
                    }),
                ),
                ...outcome.spaces.map(
                    ({ space, previousVersion }): SpaceEventDraft => ({
                        type: "space_updated",
                        space,
                        previousVersion,
                    }),
                ),
                ...outcome.removedSectionIds.map(
                    (sectionId): SpaceEventDraft => ({ type: "section_removed", sectionId }),
                ),
            ];
            if (outcome.changes.length === 0 && outcome.sectionChanges.length === 0) {
                await this.#commitEvents(txCtx, ownerUserId, undefined, [
                    ...events,
                    { type: "batch_queued", pendingChanges: 0 },
                ]);
                return undefined;
            }
            const note = composeSpaceBatchNote(outcome.changes, outcome.sectionChanges);
            const happy = spaces.find((space) => space.role === "happy")?.contents[0];
            const noteMessageId = createId();
            const happyAgentId = happy?.kind === "bot" ? happy.agentId : undefined;
            if (happyAgentId !== undefined) {
                // The note is Happy speaking without a model turn: one finished run of its own,
                // so it reads like any other message in Happy's chat, live and after a reload.
                const runId = createId();
                await this.#history.beginMaintenanceRun(txCtx, happyAgentId, runId, now);
                await this.#history.record(txCtx, happyAgentId, {
                    role: "assistant",
                    recordId: noteMessageId,
                    runId,
                    blocks: [{ type: "text", text: note }],
                    at: now,
                });
                await this.#history.finishMaintenanceRun(
                    txCtx,
                    happyAgentId,
                    runId,
                    "completed",
                    now,
                );
            }
            const batch: SpaceBatch = {
                id: createId(),
                ownerUserId,
                reason,
                note,
                ...(happyAgentId === undefined ? {} : { noteAgentId: happyAgentId, noteMessageId }),
                changes: [...outcome.changes],
                sections: [...outcome.sectionChanges],
                appliedAt: now,
            };
            await insertBatch(txCtx, batch);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                ...events,
                { type: "batch_applied", batch },
                { type: "batch_queued", pendingChanges: 0 },
            ]);
            return batch;
        });
    }

    /** Whether a client is holding batches back because the person is mid-interaction. */
    #interacting(ownerUserId: SpaceOwnerId, now: number): boolean {
        const since = this.#interactingSince.get(ownerUserId);
        if (since === undefined) return false;
        if (now - since < SPACE_INTERACTION_HOLD_MS) return true;
        this.#interactingSince.delete(ownerUserId);
        return false;
    }

    /** Whether the person has been idle long enough since their last sign of work. */
    #idle(ownerUserId: SpaceOwnerId, now: number): boolean {
        const activeAt = this.#activeAt.get(ownerUserId);
        return activeAt === undefined || now - activeAt >= SPACE_IDLE_MS;
    }

    /**
     * Apply the queued batch if this is the moment for it. Nothing applies while the person is
     * mid-interaction or while the manager is still deciding. Otherwise a batch applies on a calm
     * signal, after the person asked for it (once the manager has finished), or after idle.
     */
    async #applyIfDue(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        moment: "calm" | "check" | "settled",
    ): Promise<SpaceBatch | undefined> {
        const now = Date.now();
        if (this.#interacting(ownerUserId, now)) return undefined;
        const state = await queryOwnerState(ctx, ownerUserId);
        if (state === undefined) return undefined;
        if (state.managerAgentId !== undefined && this.#busyManagers.has(state.managerAgentId)) {
            // A calm moment that arrives mid-decision is kept for when the manager finishes.
            if (moment === "calm") this.#calmSignalled.add(ownerUserId);
            return undefined;
        }
        const requested = state.applyRequestedAt !== undefined;
        const signalled = this.#calmSignalled.has(ownerUserId);
        // A request the manager has not taken up yet produces nothing to apply; only the end of
        // its turn settles the request.
        if (requested && moment !== "settled") {
            if ((await queryPendingChanges(ctx, ownerUserId)).length === 0) return undefined;
        }
        if (!requested && !signalled && moment !== "calm" && !this.#idle(ownerUserId, now)) {
            return undefined;
        }
        this.#calmSignalled.delete(ownerUserId);
        return await this.applyBatch(ctx, ownerUserId, requested ? "tidy" : "calm");
    }

    async #applyCalmBatches(ctx: Context): Promise<void> {
        const owners = new Set(await queryOwnersWithPendingChanges(ctx));
        for (const state of await queryOwnerStates(ctx)) {
            if (state.applyRequestedAt !== undefined) owners.add(state.ownerUserId);
        }
        for (const owner of owners) {
            if (!Value.Check(spaceOwnerIdSchema, owner)) continue;
            await this.#applyIfDue(ctx, owner, "check");
        }
    }

    /** Queue a message for the person's manager, delivered after this transaction commits. */
    async #brief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        text: string,
        operationId?: string,
    ): Promise<void> {
        await this.#durableFunctions.invoke(ctx, {
            function: BRIEF_FUNCTION,
            arguments: { ownerUserId, messageId: createId(), text },
            ...(operationId === undefined ? {} : { operationId: `spaces:${operationId}` }),
        });
    }

    async #deliverBrief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        messageId: string,
        text: string,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const { managerAgentId, happyAgentId } = await this.#ensureManager(ctx, ownerUserId);
        const state = await this.#ownerState(ctx, ownerUserId);
        const happyMode = (await agents.config(ctx, happyAgentId))?.metadata?.["lastMode"];
        const route = selectSpaceManagerRoute(
            this.#config.models,
            state.managerModel,
            Value.Check(messageModeSchema, happyMode) ? happyMode.providerId : undefined,
        );
        if (route === undefined) throw new Error("No model is available for the sidebar manager.");
        await agents.send(
            ctx,
            managerAgentId,
            { role: "user", content: [{ type: "text", text }] },
            {
                id: messageId,
                metadata: { ...AGENT_MESSAGE_ORIGIN_METADATA },
                provider: route.providerId,
                model: route.model,
                effort: route.effort,
                permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
            },
        );
    }

    /** The manager is a hidden helper of Happy, made the first time it has something to do. */
    async #ensureManager(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
    ): Promise<{ readonly managerAgentId: string; readonly happyAgentId: string }> {
        return await ctx.inTx(async (txCtx) => {
            const agents = this.#requireAgents();
            await this.#ensureOwner(txCtx, ownerUserId);
            const happy = await querySpaceByRef(txCtx, ownerUserId, "happy");
            const happyRef = happy?.contents[0];
            if (happyRef?.kind !== "bot") throw new Error("Happy is not available yet.");
            const state = await this.#ownerState(txCtx, ownerUserId);
            if (
                state.managerAgentId !== undefined &&
                (await agents.config(txCtx, state.managerAgentId)) !== undefined
            ) {
                return { managerAgentId: state.managerAgentId, happyAgentId: happyRef.agentId };
            }
            const parent = await agents.config(txCtx, happyRef.agentId);
            const config: AgentConfig = {
                ...(parent?.environment === undefined ? {} : { environment: parent.environment }),
                ...(parent?.modules === undefined ? {} : { modules: parent.modules }),
                metadata: {
                    title: "Sidebar manager",
                    // Its replies are bookkeeping; Happy is not told each time it finishes.
                    collaboration: { reportToCreator: false },
                    [MANAGER_METADATA_KEY]: ownerUserId,
                },
            };
            const created = await agents.create(txCtx, config, {
                id: createId(),
                parent: happyRef.agentId,
            });
            await writeOwnerState(txCtx, { ...state, managerAgentId: created.id });
            const row = await querySpaceByRef(txCtx, ownerUserId, "manager");
            if (row !== undefined) {
                await updateSpace(
                    txCtx,
                    {
                        ...row,
                        contents: [{ kind: "agent", agentId: created.id }],
                        version: row.version + 1,
                        updatedAt: Date.now(),
                    },
                    row.version,
                );
            }
            return { managerAgentId: created.id, happyAgentId: happyRef.agentId };
        });
    }

    async #ownerState(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceOwnerState> {
        return (await queryOwnerState(ctx, ownerUserId)) ?? { ownerUserId, revision: 0 };
    }

    async #ownedSpace(ctx: Context, ownerUserId: SpaceOwnerId, spaceId: string) {
        const space = await querySpace(ctx, spaceId);
        if (space === undefined || space.ownerUserId !== ownerUserId) {
            throw new SpaceNotFoundError();
        }
        return space;
    }

    /**
     * Make sure the person has Happy, the manager row, and a row for everything they already
     * have. Existing work arrives folded and unplaced, and the manager is asked to organise it.
     */
    async #ensureOwner(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        const now = Date.now();
        const existing = await queryOwnerState(ctx, ownerUserId);
        const drafts: SpaceEventDraft[] = [];
        let seeded = 0;
        const add = async (space: SpaceRecord): Promise<void> => {
            if ((await querySpaceByRef(ctx, ownerUserId, spaceRefKey(space))) !== undefined) return;
            await insertSpace(ctx, space);
            drafts.push({ type: "space_created", space });
        };
        const happyBot = await this.#bots.chiefOfStaff(ctx);
        if (happyBot !== undefined) {
            await add({
                id: createId(),
                ownerUserId,
                role: "happy",
                icon: { type: "image" },
                contents: [{ kind: "bot", botId: happyBot.id, agentId: happyBot.agentId }],
                orderKey: "1",
                placement: "settled",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            });
        }
        if (existing !== undefined) {
            if (drafts.length > 0) await this.#commitEvents(ctx, ownerUserId, undefined, drafts);
            return;
        }
        await add({
            id: createId(),
            ownerUserId,
            role: "manager",
            contents: [],
            orderKey: "1",
            placement: "settled",
            visibility: "hidden",
            version: 1,
            createdAt: now,
            updatedAt: now,
        });
        const seed = async (content: SpaceRef, icon?: SpaceRecord["icon"]): Promise<void> => {
            seeded += 1;
            await add({
                id: createId(),
                ownerUserId,
                role: "item",
                ...(icon === undefined ? {} : { icon }),
                contents: [content],
                orderKey: String(seeded).padStart(6, "0"),
                placement: "pending",
                visibility: "folded",
                version: 1,
                createdAt: now,
                updatedAt: now,
            });
        };
        for (const bot of await this.#bots.list(ctx)) {
            if (bot.systemKey !== undefined || bot.status !== "active") continue;
            await seed({ kind: "bot", botId: bot.id, agentId: bot.agentId }, botIcon(bot));
        }
        for (const { task } of await this.#tasks.listForMember(ctx, ownerUserId)) {
            if (task.status !== "active") continue;
            await seed({ kind: "task", taskId: task.id, agentId: task.agentId });
        }
        for (const surface of await this.#surfaces.list(ctx)) {
            if (!joinedBy(surface.members, ownerUserId)) continue;
            const surfaceType = surfaceTypeOf(surface.type);
            if (surfaceType === undefined) continue;
            await seed({ kind: "surface", surfaceId: surface.id, surfaceType });
        }
        await writeOwnerState(ctx, {
            ownerUserId,
            revision: 0,
            ...(seeded > 0 ? { applyRequestedAt: now } : {}),
        });
        if (seeded > 0) {
            await this.#brief(
                ctx,
                ownerUserId,
                "This is a new sidebar. Everything the person already has is folded into Older and not placed yet. Read it with list_sidebar, choose an icon for each row, group the active work into a few sections, and leave quiet work in Older. Your changes apply as soon as you finish.",
            );
        }
        await this.#commitEvents(ctx, ownerUserId, undefined, drafts);
    }

    /** Keep rows in step with the work they hold as it is created, joined, renamed, and closed. */
    #subscribe(): void {
        if (this.#unsubscribe.length > 0) return;
        this.#unsubscribe.push(
            this.#tasks.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-task-event");
                if (event.type === "task_joined") {
                    await this.#addWork(ctx, event.membership.memberId, {
                        kind: "task",
                        taskId: event.membership.taskId,
                        agentId: (await this.#tasks.get(ctx, event.membership.taskId))?.agentId,
                    });
                } else if (event.type === "task_left") {
                    await this.#closeWork(ctx, `task:${event.membership.taskId}`, [
                        event.membership.memberId,
                    ]);
                } else if (event.type === "task_updated") {
                    if (
                        event.task.status === "archived" &&
                        event.previousTask.status !== "archived"
                    ) {
                        await this.#closeWork(ctx, `task:${event.task.id}`);
                    } else if (event.task.name !== event.previousTask.name) {
                        await this.#touchWork(ctx, `task:${event.task.id}`);
                    }
                }
            }),
            this.#bots.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-bot-event");
                if (event.bot.systemKey !== undefined) return;
                if (event.type === "bot_created") {
                    for (const state of await queryOwnerStates(ctx)) {
                        await this.#addWork(
                            ctx,
                            state.ownerUserId,
                            { kind: "bot", botId: event.bot.id, agentId: event.bot.agentId },
                            botIcon(event.bot),
                        );
                    }
                } else if (
                    event.bot.status === "archived" &&
                    event.previousBot.status !== "archived"
                ) {
                    await this.#closeWork(ctx, `bot:${event.bot.id}`);
                } else if (event.bot.name !== event.previousBot.name) {
                    await this.#touchWork(ctx, `bot:${event.bot.id}`);
                }
            }),
        );
    }

    /**
     * New work for one person: an unplaced row under Happy that the manager places after its
     * first message. A row that already exists is left alone.
     */
    async #addWork(
        ctx: Context,
        ownerUserId: string,
        content: { kind: "task"; taskId: string; agentId: string | undefined } | SpaceRef,
        icon?: SpaceRecord["icon"],
    ): Promise<void> {
        if (!Value.Check(spaceOwnerIdSchema, ownerUserId)) return;
        if (content.kind === "task" && content.agentId === undefined) return;
        const ref = content as SpaceRef;
        await ctx.inTx(async (txCtx) => {
            if ((await queryOwnerState(txCtx, ownerUserId)) === undefined) return;
            if ((await querySpaceByRef(txCtx, ownerUserId, spaceContentKey(ref))) !== undefined) {
                return;
            }
            const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                (row) => row.role === "item" && row.sectionId === undefined,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: createId(),
                ownerUserId,
                role: "item",
                ...(icon === undefined ? {} : { icon }),
                contents: [ref],
                orderKey: rowKeyAfter(siblings, null),
                placement: "pending",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            await insertSpace(txCtx, space);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_created", space },
            ]);
        });
    }

    /** The work ended or was left: its rows are hidden at once, never deleted. */
    async #closeWork(ctx: Context, refKey: string, owners?: readonly string[]): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByRef(txCtx, refKey)) {
                if (owners !== undefined && !owners.includes(row.ownerUserId)) continue;
                if (row.visibility === "hidden") continue;
                const next: SpaceRecord = {
                    ...row,
                    visibility: "hidden",
                    placement: "settled",
                    version: row.version + 1,
                    updatedAt: Date.now(),
                };
                await updateSpace(txCtx, next, row.version);
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_updated", space: next, previousVersion: row.version },
                ]);
            }
        });
    }

    /** The content's title changed; the row advances so clients read it again. */
    async #touchWork(ctx: Context, refKey: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByRef(txCtx, refKey)) {
                const next: SpaceRecord = {
                    ...row,
                    version: row.version + 1,
                    updatedAt: Date.now(),
                };
                await updateSpace(txCtx, next, row.version);
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_updated", space: next, previousVersion: row.version },
                ]);
            }
        });
    }

    async #agentDescription(
        ctx: Context,
        space: SpaceRecord,
        base: Omit<SpaceDescription, "working" | "lastActivityAt">,
    ): Promise<SpaceDescription> {
        const agentId = base.target?.agentId;
        return {
            ...base,
            title: space.name ?? base.title,
            working: agentId !== undefined && this.#events.activeRunId(agentId) !== undefined,
            lastActivityAt:
                agentId === undefined
                    ? undefined
                    : await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, agentId),
        };
    }

    /** Advance the person's revision and publish these changes after the transaction commits. */
    async #commitEvents(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        mutationId: string | undefined,
        drafts: readonly SpaceEventDraft[],
    ): Promise<void> {
        if (drafts.length === 0) return;
        const state = await this.#ownerState(ctx, ownerUserId);
        const revision = state.revision + 1;
        await writeOwnerState(ctx, { ...state, revision });
        const at = Date.now();
        const events = drafts.map((draft) => {
            const event = {
                ...draft,
                at,
                ownerUserId,
                revision,
                ...(mutationId === undefined ? {} : { mutationId }),
            } as SpaceEvent;
            if (!Value.Check(spaceEventSchema, event))
                throw new Error("The space event is invalid.");
            return structuredClone(event);
        });
        afterCommit(ctx, async (eventCtx) => {
            for (const event of events) {
                for (const listener of [...this.#listeners]) {
                    try {
                        await listener(eventCtx, event);
                    } catch (error: unknown) {
                        eventCtx.log.error("A sidebar subscriber failed.", { ownerUserId }, error);
                    }
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The spaces module has not started.");
        return this.#agents;
    }
}

type SpaceEventDraft = SpaceEvent extends infer Event
    ? Event extends SpaceEvent
        ? Omit<Event, "at" | "ownerUserId" | "revision" | "mutationId">
        : never
    : never;

function managerOwner(metadata: AgentConfig["metadata"] | undefined): SpaceOwnerId | undefined {
    const owner = metadata?.[MANAGER_METADATA_KEY];
    return Value.Check(spaceOwnerIdSchema, owner) ? owner : undefined;
}

function newWorkBrief(row: SpaceRecord, text: string): string {
    const excerpt = text.length > MAX_BRIEF_TEXT ? `${text.slice(0, MAX_BRIEF_TEXT)}…` : text;
    return [
        `New work started in row ${row.id}. Its first message:`,
        excerpt,
        row.placement === "pending"
            ? "Choose its icon now with set_space_icon, then place it with place_space (create a section if none fits). The person is working in it, so the move waits for a calm moment."
            : "The person already placed it. Choose its icon now with set_space_icon; do not move it.",
    ].join("\n\n");
}

function blankDescription(title: string, target: SpaceDescription["target"]): SpaceDescription {
    return {
        title,
        target,
        archived: false,
        working: false,
        lastActivityAt: undefined,
        imageUrl: undefined,
    };
}

function botIcon(bot: BotRecord): SpaceRecord["icon"] {
    return bot.avatar === undefined ? undefined : { type: "image" };
}

function joinedBy(
    members: readonly { readonly userId: string | null }[],
    ownerUserId: SpaceOwnerId,
): boolean {
    const userId = ownerUserId === SPACE_STANDALONE_OWNER ? null : ownerUserId;
    return members.some((member) => member.userId === userId);
}

function surfaceTypeOf(type: string): "todo" | "document" | "calendar" | "reference" | undefined {
    return type === "todo" || type === "document" || type === "calendar" || type === "reference"
        ? type
        : undefined;
}

/** Happy first, then sections' rows by key, then everything else by key. */
function sortForDisplay(spaces: readonly SpaceRecord[]): SpaceRecord[] {
    const rank = (space: SpaceRecord): number =>
        space.role === "happy" ? 0 : space.role === "manager" ? 2 : 1;
    return [...spaces].sort((left, right) => rank(left) - rank(right) || compareRows(left, right));
}

function formatAge(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return `${String(minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${String(hours)} h`;
    return `${String(Math.round(hours / 24))} days`;
}
