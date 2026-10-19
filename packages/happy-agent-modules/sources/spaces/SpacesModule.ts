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
import { SubtasksModule } from "../subtasks/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule, type TaskRecord } from "../tasks/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, isUserOriginMetadata } from "../impl/messageOrigin.js";

import {
    SPACE_STANDALONE_OWNER,
    spaceOwnerIdSchema,
    SpaceConflictError,
    SpaceNotFoundError,
    type SpaceBatch,
    type SpaceDescription,
    type SpaceIconSlug,
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
import {
    applySpaceChanges,
    compareRows,
    rowKeyAfter,
    rowKeyAtTop,
} from "./impl/applySpaceChanges.js";
import { composeSpaceBatchNote } from "./impl/composeSpaceBatchNote.js";
import { formatPrioritizingInstructions } from "./impl/formatPrioritizingInstructions.js";
import { selectPrioritizingRoute } from "./impl/selectPrioritizingRoute.js";
import { spaceContentKey } from "./impl/spaceRefKey.js";
import {
    deletePendingChanges,
    deleteSpace,
    insertBatch,
    insertSection,
    insertSpace,
    insertSpaceIfAbsent,
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
import { prioritizingTools } from "./tools/prioritizingTools.js";

/** Without a focus change or a message for this long, the person counts as idle, which is calm. */
export const SPACE_IDLE_MS = 2 * 60_000;
/**
 * A client that said the person is mid-interaction and then went silent is not trusted forever;
 * after this long without a word the hold lapses and idle rules apply again.
 */
export const SPACE_INTERACTION_HOLD_MS = 10 * 60_000;
/** How often queued changes are checked against the calm rule. */
const CALM_CHECK_INTERVAL_MS = 15_000;
const BRIEF_FUNCTION = "spaces.briefPrioritizing";
const PRIORITIZING_METADATA_KEY = "spacesPrioritizingFor";
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
 * One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.
 *
 * A space is one row: Happy, or an item wrapping a task, bot, or Surface. Sections are flat
 * labels. New work is a stem cell: a fresh unnamed task wrapped in a row that waits under Happy
 * until Prioritizing places it.
 *
 * Every organisation write goes through Prioritizing's tools, except the person's own explicit
 * actions: moving, folding, hiding, or removing a row, opening a section, and creating new work.
 * Prioritizing's moves are queued and applied together at a calm moment with one note in Happy's
 * chat and a recorded diff. Icons apply at once because they move nothing.
 */
export class SpacesModule implements AgentModule {
    readonly name = "spaces";
    readonly migrations = spaceMigrations;

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #history: HistoryModule;
    readonly #subtasks: SubtasksModule;
    readonly #surfaces: SurfacesModule;
    readonly #tasks: TasksModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #listeners = new Set<SpaceEventListener>();
    /** When each person last showed they were at work. Calm is judged from this; it need not survive a restart. */
    readonly #activeAt = new Map<SpaceOwnerId, number>();
    /** When a client last said the person is mid-interaction (dragging, typing, navigating). */
    readonly #interactingSince = new Map<SpaceOwnerId, number>();
    /** People whose client signalled calm while Prioritizing was still deciding. */
    readonly #calmSignalled = new Set<SpaceOwnerId>();
    /** Prioritizing agents with a turn in progress; their batch waits until they finish. */
    readonly #busyPrioritizing = new Set<string>();
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
        subtasks: SubtasksModule,
    ) {
        this.#config = config;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#surfaces = surfaces;
        this.#history = history;
        this.#events = events;
        this.#durableFunctions = durableFunctions;
        this.#subtasks = subtasks;
        // Telling Prioritizing about new work commits with the work; the message is delivered
        // after the commit and survives a restart in between. A repeated delivery carries the
        // same message ID, so Prioritizing hears it once.
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
            prioritizingOwner(scope.agent.metadata) === undefined
                ? input.instructions
                : formatPrioritizingInstructions(),
        tools: async (ctx, scope): Promise<readonly AnyAgentTool[]> => {
            if (prioritizingOwner(scope.agent.metadata) !== undefined) return [];
            // People ask for sidebar changes in the conversations they have, not in helpers.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            return [requestSpacePlacementTool(this, scope.agent.id)];
        },
        // Prioritizing is one job with one tool array and nothing else.
        overrideTools: (_ctx, scope, input) => {
            const owner = prioritizingOwner(scope.agent.metadata);
            return owner === undefined ? input.tools : prioritizingTools(this, owner);
        },
        beforeAgentLoop: (_ctx, scope) => {
            if (prioritizingOwner(scope.agent.metadata) !== undefined) {
                this.#busyPrioritizing.add(scope.agent.id);
            }
        },
        afterAgentSettled: async (ctx, scope) => {
            const owner = prioritizingOwner(scope.agent.metadata);
            if (owner === undefined) return;
            this.#busyPrioritizing.delete(scope.agent.id);
            const lifetime = this.#lifetime;
            if (lifetime === undefined) return;
            // Prioritizing has finished deciding; apply now if the person asked for it, or if
            // they are calm. Otherwise the calm check picks the batch up later.
            void this.#applyIfDue(
                lifetime.named("spaces-prioritizing-settled"),
                owner,
                "settled",
            ).catch((error: unknown) => {
                ctx.log.warn("The sidebar batch could not be applied.", {}, error);
            });
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
                // New work is told to Prioritizing once, with what the person first asked.
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
     * A person's whole sidebar. The first read makes it: Happy, and a row for everything the
     * person already has, folded until Prioritizing's first tidy.
     */
    async snapshot(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceSnapshot> {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            return {
                spaces: sortForDisplay(await querySpaces(txCtx, ownerUserId)),
                sections: await querySections(txCtx, ownerUserId),
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
        if (primary === undefined) return blankDescription("Untitled", undefined);
        switch (primary.kind) {
            case "task": {
                const task = await this.#tasks.get(ctx, primary.taskId);
                return await this.#agentDescription(ctx, space, {
                    title: task?.name ?? "Task",
                    named: task === undefined || task.nameConfigured,
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
                    named: true,
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
            case "surface": {
                const surface = (await this.#surfaces.list(ctx)).find(
                    (candidate) => candidate.id === primary.surfaceId,
                );
                return {
                    title: surface?.name ?? "List",
                    named: true,
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
        }
    }

    /**
     * Wrap a freshly created task in a stem-cell row. Without a section it waits under Happy for
     * Prioritizing; with one, the person already chose where it goes, so it is settled at the top.
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
                (row) => row.sectionId === input.sectionId && row.id !== previous?.id,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: input.spaceId,
                ownerUserId,
                role: "item",
                icon: { type: "stem_cell" },
                contents: [content],
                ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
                orderKey: rowKeyAtTop(siblings),
                placement: input.sectionId === undefined ? "pending" : "settled",
                visibility: "shown",
                ...(input.sectionId === undefined ? {} : { manualAt: now }),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            // The seed may have made a row for this task already; the stem cell replaces it.
            if (previous !== undefined) {
                await deleteSpace(txCtx, previous.id);
                await deletePendingChanges(txCtx, ownerUserId, [`space:${previous.id}`]);
            }
            await insertSpace(txCtx, space);
            await this.#commitEvents(txCtx, ownerUserId, input.mutationId, [
                ...(previous === undefined
                    ? []
                    : [{ type: "space_removed" as const, spaceId: previous.id }]),
                { type: "space_created", space },
            ]);
            return space;
        });
    }

    /**
     * The person changed a row: moved, folded, or hid it. Their own action applies at once,
     * settles the row, and marks it as placed by hand so Prioritizing keeps it there until its
     * state changes. Giving `sectionId` moves the row, first unless `afterId` says otherwise; a
     * moved row is shown unless `visibility` says otherwise.
     */
    async update(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        change: {
            readonly sectionId?: string | null;
            readonly afterId?: string | null;
            readonly visibility?: SpaceRecord["visibility"];
        },
        mutationId?: string,
    ): Promise<SpaceRecord> {
        if (change.afterId === spaceId) {
            throw new SpaceConflictError("A row cannot be placed after itself.");
        }
        return await ctx.inTx(async (txCtx) => {
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            const moved = change.sectionId !== undefined || change.afterId !== undefined;
            const target =
                change.sectionId === undefined ? space.sectionId : (change.sectionId ?? undefined);
            if (target !== undefined && target !== space.sectionId) {
                const section = await querySection(txCtx, target);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const now = Date.now();
            const next: SpaceRecord = {
                ...space,
                placement: "settled",
                visibility: change.visibility ?? (moved ? "shown" : space.visibility),
                manualAt: now,
                version: space.version + 1,
                updatedAt: now,
            };
            if (moved) {
                const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                    (row) =>
                        row.id !== spaceId &&
                        row.visibility === "shown" &&
                        row.sectionId === target,
                );
                const afterId = change.afterId ?? null;
                if (afterId !== null && !siblings.some((row) => row.id === afterId)) {
                    throw new SpaceConflictError("The row to place after is not in that section.");
                }
                next.orderKey = rowKeyAfter(siblings, afterId);
                if (target === undefined) delete next.sectionId;
                else next.sectionId = target;
            }
            await updateSpace(txCtx, next, space.version);
            // A queued change of this row would undo the person's choice.
            await deletePendingChanges(txCtx, ownerUserId, [`space:${spaceId}`]);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "space_updated", space: next },
            ]);
            return next;
        });
    }

    /**
     * The person removed new work they never wrote in. Its row goes and its task is archived;
     * once its conversation holds any message it is real work and is refused. Removing a row
     * that is already gone succeeds, so a retry is harmless.
     */
    async remove(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        mutationId?: string,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const space = await querySpace(txCtx, spaceId);
            if (space === undefined) return;
            if (space.ownerUserId !== ownerUserId) {
                throw new SpaceNotFoundError();
            }
            const primary = space.contents[0];
            if (space.role !== "item" || primary?.kind !== "task" || space.contents.length > 1) {
                throw new SpaceConflictError("Only new work can be removed; hide it instead.");
            }
            if (
                space.briefedAt !== undefined ||
                (await this.#history.stats(txCtx, primary.agentId)).messages > 0 ||
                (await this.#history.pending(txCtx, primary.agentId)).length > 0
            ) {
                throw new SpaceConflictError(
                    "This conversation has messages, so it is kept; hide it instead.",
                );
            }
            await deleteSpace(txCtx, space.id);
            await deletePendingChanges(txCtx, ownerUserId, [`space:${space.id}`]);
            const task = await this.#tasks.get(txCtx, primary.taskId);
            if (task !== undefined && task.status === "active") {
                await this.#tasks.archive(txCtx, task.id, task.version);
            }
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "space_removed", spaceId: space.id },
            ]);
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
                { type: "section_updated", section: next },
            ]);
            return next;
        });
    }

    /**
     * The client's view of the person's attention. `interacting` holds every batch back until
     * the client says otherwise or goes quiet; `calm` — a navigation gesture just completed, or
     * the person is idle — applies the queued batch now, unless Prioritizing is mid-decision, in
     * which case it applies as soon as Prioritizing finishes. Returns the applied batch, if any.
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

    /** "Tidy now" is one automatic message in Prioritizing's conversation and nothing more. */
    async requestTidy(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            await this.#brief(txCtx, ownerUserId, "Tidy the sidebar now.");
        });
    }

    /** Prioritizing's view: everything it may judge, with IDs to act on. */
    async prioritizingOverview(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string> {
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

    /** Queue one Prioritizing change for the next calm moment. Only Prioritizing calls this. */
    async queueChange(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: SpacePendingChange,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            if (change.type === "place" || change.type === "visibility") {
                const space = await this.#ownedSpace(txCtx, ownerUserId, change.spaceId);
                if (space.role !== "item") {
                    throw new SpaceConflictError("Happy cannot be moved.");
                }
            }
            if (change.type === "remove_section" || (change.type === "section" && !change.create)) {
                const section = await querySection(txCtx, change.sectionId);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            // Section names are unique per person: a second "Movies" becomes the first one.
            if (change.type === "section" && change.name !== undefined) {
                const twin = await this.#sectionNamed(txCtx, ownerUserId, change.name);
                if (twin !== undefined && twin !== change.sectionId) {
                    if (!change.create) {
                        throw new SpaceConflictError(
                            `Section ${twin} is already called ${change.name.trim()}. Move rows there instead.`,
                        );
                    }
                    const { sectionId: _sectionId, create: _create, name: _name, ...rest } = change;
                    if (Object.keys(rest).filter((key) => key !== "type").length > 0) {
                        await this.queueChange(txCtx, ownerUserId, {
                            ...rest,
                            type: "section",
                            sectionId: twin,
                            create: false,
                        });
                    }
                    return `Section ${twin} is already called ${change.name.trim()}; use it.`;
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
            const what =
                change.type === "section" && change.create
                    ? `Section ${change.sectionId} queued for creation`
                    : "Change queued";
            return `${what}. ${String(count)} changes wait for the next calm moment.`;
        });
    }

    /** The section this person has, or has queued, under this name, ignoring case and spaces. */
    async #sectionNamed(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        name: string,
    ): Promise<string | undefined> {
        const key = name.trim().toLowerCase();
        const pending = await queryPendingChanges(ctx, ownerUserId);
        const removed = new Set(
            pending.flatMap((change) =>
                change.type === "remove_section" ? [change.sectionId] : [],
            ),
        );
        const names = new Map<string, string>();
        for (const section of await querySections(ctx, ownerUserId)) {
            names.set(section.id, section.name);
        }
        for (const change of pending) {
            if (change.type === "section" && change.name !== undefined) {
                names.set(change.sectionId, change.name);
            }
        }
        for (const [sectionId, sectionName] of names) {
            if (!removed.has(sectionId) && sectionName.trim().toLowerCase() === key) {
                return sectionId;
            }
        }
        return undefined;
    }

    /** Set an icon now. Only Prioritizing calls this. */
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
                { type: "space_updated", space: next },
            ]);
            return `Icon set to ${slug}.`;
        });
    }

    /**
     * Another agent asks for a row to move. Prioritizing decides; when the person asked for it in
     * their own words, the result applies as soon as Prioritizing finishes.
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
            let rows = await querySpacesByAgent(txCtx, input.agentId);
            if (rows.length === 0 && !this.#config.configuration.values.feature.team.enabled) {
                await this.#ensureOwner(txCtx, SPACE_STANDALONE_OWNER);
                rows = await querySpacesByAgent(txCtx, input.agentId);
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
                ? "Prioritizing will make the change shortly."
                : "Prioritizing has the request and will apply it at a calm moment.";
        });
    }

    /**
     * Apply every queued change for one person as one batch: one transaction, one note in
     * Happy's chat, one recorded diff. Returns `undefined` when nothing was queued.
     */
    async applyBatch(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceBatch | undefined> {
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
                    const description = await this.describe(txCtx, space);
                    // Work that has not named itself is never called by its placeholder.
                    titles.set(space.id, description.named ? description.title : "a new chat");
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
                    ({ section }): SpaceEventDraft => ({ type: "section_updated", section }),
                ),
                ...outcome.spaces.map(
                    ({ space }): SpaceEventDraft => ({ type: "space_updated", space }),
                ),
                ...outcome.removedSectionIds.map(
                    (sectionId): SpaceEventDraft => ({ type: "section_removed", sectionId }),
                ),
            ];
            if (outcome.changes.length === 0 && outcome.sectionChanges.length === 0) {
                await this.#commitEvents(txCtx, ownerUserId, undefined, events);
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
                note,
                ...(happyAgentId === undefined ? {} : { noteMessageId }),
                changes: [...outcome.changes],
                sections: [...outcome.sectionChanges],
                appliedAt: now,
            };
            await insertBatch(txCtx, batch);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                ...events,
                { type: "batch_applied", batch },
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
     * mid-interaction or while Prioritizing is still deciding. Otherwise a batch applies on a calm
     * signal, after the person asked for it (once Prioritizing has finished), or after idle.
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
        if (
            state.prioritizingAgentId !== undefined &&
            this.#busyPrioritizing.has(state.prioritizingAgentId)
        ) {
            // A calm moment that arrives mid-decision is kept for when Prioritizing finishes.
            if (moment === "calm") this.#calmSignalled.add(ownerUserId);
            return undefined;
        }
        const requested = state.applyRequestedAt !== undefined;
        const signalled = this.#calmSignalled.has(ownerUserId);
        // A request Prioritizing has not taken up yet produces nothing to apply; only the end of
        // its turn settles the request.
        if (requested && moment !== "settled") {
            if ((await queryPendingChanges(ctx, ownerUserId)).length === 0) return undefined;
        }
        if (!requested && !signalled && moment !== "calm" && !this.#idle(ownerUserId, now)) {
            return undefined;
        }
        this.#calmSignalled.delete(ownerUserId);
        return await this.applyBatch(ctx, ownerUserId);
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

    /** Queue a message for the person's Prioritizing, delivered after this transaction commits. */
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
        const { prioritizingAgentId, happyAgentId } = await this.#ensurePrioritizing(
            ctx,
            ownerUserId,
        );
        const happyMode = (await agents.config(ctx, happyAgentId))?.metadata?.["lastMode"];
        const route = selectPrioritizingRoute(
            this.#config.models,
            Value.Check(messageModeSchema, happyMode) ? happyMode.providerId : undefined,
        );
        if (route === undefined) throw new Error("No model is available for Prioritizing.");
        await agents.send(
            ctx,
            prioritizingAgentId,
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

    /**
     * Prioritizing is an ordinary conversation subtask of Happy, made the first time it has
     * something to do and made again if the person archived it.
     */
    async #ensurePrioritizing(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
    ): Promise<{ readonly prioritizingAgentId: string; readonly happyAgentId: string }> {
        return await ctx.inTx(async (txCtx) => {
            const agents = this.#requireAgents();
            await this.#ensureOwner(txCtx, ownerUserId);
            const happy = await querySpaceByRef(txCtx, ownerUserId, "happy");
            const happyRef = happy?.contents[0];
            if (happyRef?.kind !== "bot") throw new Error("Happy is not available yet.");
            const state = await this.#ownerState(txCtx, ownerUserId);
            if (state.prioritizingAgentId !== undefined) {
                const current = await agents.config(txCtx, state.prioritizingAgentId);
                if (current !== undefined && typeof current.metadata?.["archivedAt"] !== "number") {
                    return {
                        prioritizingAgentId: state.prioritizingAgentId,
                        happyAgentId: happyRef.agentId,
                    };
                }
            }
            const prioritizingAgentId = createId();
            await this.#subtasks.createConversation(
                txCtx,
                happyRef.agentId,
                { title: "Prioritizing", metadata: { [PRIORITIZING_METADATA_KEY]: ownerUserId } },
                prioritizingAgentId,
            );
            await writeOwnerState(txCtx, { ...state, prioritizingAgentId });
            return { prioritizingAgentId, happyAgentId: happyRef.agentId };
        });
    }

    async #ownerState(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceOwnerState> {
        return (await queryOwnerState(ctx, ownerUserId)) ?? { ownerUserId };
    }

    async #ownedSpace(ctx: Context, ownerUserId: SpaceOwnerId, spaceId: string) {
        const space = await querySpace(ctx, spaceId);
        if (space === undefined || space.ownerUserId !== ownerUserId) {
            throw new SpaceNotFoundError();
        }
        return space;
    }

    /**
     * Make sure the person has Happy and a row for everything they already
     * have. Existing work arrives folded and unplaced, and Prioritizing is asked to organise it.
     */
    async #ensureOwner(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        const now = Date.now();
        const existing = await queryOwnerState(ctx, ownerUserId);
        const drafts: SpaceEventDraft[] = [];
        let seeded = 0;
        const add = async (space: SpaceRecord): Promise<void> => {
            if (await insertSpaceIfAbsent(ctx, space))
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
                    } else if (
                        event.task.status === "active" &&
                        event.previousTask.status === "archived"
                    ) {
                        // Back from the archive: every member's sidebar gets it again.
                        for (const state of await queryOwnerStates(ctx)) {
                            const member = await this.#tasks.membership(
                                ctx,
                                event.task.id,
                                state.ownerUserId,
                            );
                            if (member === undefined) continue;
                            await this.#addWork(ctx, state.ownerUserId, {
                                kind: "task",
                                taskId: event.task.id,
                                agentId: event.task.agentId,
                            });
                        }
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
     * New work for one person: an unplaced row under Happy that Prioritizing places after its
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
            const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                (row) => row.sectionId === undefined,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: createId(),
                ownerUserId,
                role: "item",
                ...(icon === undefined ? {} : { icon }),
                contents: [ref],
                orderKey: rowKeyAtTop(siblings),
                placement: "pending",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            if (!(await insertSpaceIfAbsent(txCtx, space))) return;
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_created", space },
            ]);
        });
    }

    /**
     * The work was archived or left: its rows leave the sidebar at once, with anything queued
     * for them. The work itself keeps its history; unarchiving brings a fresh row back.
     */
    async #closeWork(ctx: Context, refKey: string, owners?: readonly string[]): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByRef(txCtx, refKey)) {
                if (owners !== undefined && !owners.includes(row.ownerUserId)) continue;
                if (row.role !== "item") continue;
                await deleteSpace(txCtx, row.id);
                await deletePendingChanges(txCtx, row.ownerUserId, [`space:${row.id}`]);
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_removed", spaceId: row.id },
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
                    { type: "space_updated", space: next },
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
            working: agentId !== undefined && this.#events.activeRunId(agentId) !== undefined,
            lastActivityAt:
                agentId === undefined
                    ? undefined
                    : await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, agentId),
        };
    }

    /** Publish these changes after the transaction commits. */
    async #commitEvents(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        mutationId: string | undefined,
        drafts: readonly SpaceEventDraft[],
    ): Promise<void> {
        if (drafts.length === 0) return;
        const at = Date.now();
        const events = drafts.map((draft) => {
            const event = {
                ...draft,
                at,
                ownerUserId,
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
        ? Omit<Event, "at" | "ownerUserId" | "mutationId">
        : never
    : never;

function prioritizingOwner(
    metadata: AgentConfig["metadata"] | undefined,
): SpaceOwnerId | undefined {
    const owner = metadata?.[PRIORITIZING_METADATA_KEY];
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
        named: true,
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

/** Rows by key; Happy leads because it holds the first key. */
function sortForDisplay(spaces: readonly SpaceRecord[]): SpaceRecord[] {
    return [...spaces].sort(compareRows);
}

function formatAge(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return `${String(minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${String(hours)} h`;
    return `${String(Math.round(hours / 24))} days`;
}
