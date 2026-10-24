import { createId } from "@paralleldrive/cuid2";
import { createHash } from "node:crypto";
import {
    cuid2Schema,
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
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
import {
    ArtifactsModule,
    formatSidebar,
    parseSidebar,
    sidebarNodes,
    SidebarValidationError,
    type ArtifactAuthor,
    type SidebarNode,
    type UpdateArtifactInput,
} from "../artifacts/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { EventsModule } from "../events/index.js";
import { HistoryModule } from "../history/index.js";
import { SubtasksModule } from "../subtasks/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule, type TaskRecord } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { TitlesModule } from "../titles/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, isUserOriginMetadata } from "../impl/messageOrigin.js";

import {
    SPACE_STANDALONE_OWNER,
    spaceOwnerIdSchema,
    SpaceConflictError,
    SpaceNotFoundError,
    SpaceStorageError,
    SpaceInputError,
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
import {
    PRIORITIZING_DEFAULT_MODEL_SETTING,
    selectPrioritizingRoute,
} from "./impl/selectPrioritizingRoute.js";
import { spaceContentKey } from "./impl/spaceRefKey.js";
import {
    deletePendingChanges,
    deleteSpace,
    insertBatch,
    insertSection,
    insertSpace,
    insertSpaceIfAbsent,
    queryBatches,
    queryOwnerByPrioritizingAgent,
    queryOwnerBySidebarArtifact,
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
import {
    insertSidebarSpace,
    isSidebarHeading,
    migrateLegacySidebar,
    removeSidebarNode,
    seedSidebar,
    shownSidebarRows,
    SIDEBAR_VISIBLE_BUDGET,
    SidebarConflictError,
    type ClassicSidebar,
    sidebarKey,
    sidebarEdits,
    sidebarPlacement,
} from "./impl/sidebarLayout.js";

/**
 * Without an attention report or a message for this long, the person counts as idle, which is
 * calm. Reading a reply or skimming the sidebar between clicks easily takes two minutes, so a
 * shorter wait would still move rows while the person looks; five minutes untouched means they
 * stepped away, and a tidy still lands several times an hour.
 */
export const SPACE_IDLE_MS = 5 * 60_000;
/**
 * A client that said the person is mid-interaction and then went silent is not trusted forever;
 * after this long without a word the hold lapses and idle rules apply again.
 */
export const SPACE_INTERACTION_HOLD_MS = 10 * 60_000;
/** How often queued changes are checked against the calm rule. */
const CALM_CHECK_INTERVAL_MS = 15_000;
const BRIEF_FUNCTION = "spaces.briefPrioritizing";
/** The opening task of a new Prioritizing; work seeded before it existed waits for it. */
const PRIORITIZING_OPENING =
    "Keep this person's sidebar tidy from now on. It was just made to mirror the sidebar they already know, so change nothing in it now: read it with list_sidebar and give rows and sessions icons. From your next notice on, read the conversations with read_row_conversation, then use edit_sidebar to order rows within the visible budget, under titled happy-section headings for subjects or happy-separator rules where only a visual break helps. Keep sessions hidden unless there is a strong reason to show one. Leave new work that has no first message alone. Preserve manual placement and recent work.";
const MAX_BRIEF_TEXT = 2_000;
/** The seed's default sections, which only the person may remove or rename. */
const DEFAULT_SECTION_IDS = ["bots", "tasks"];
/** Work active this recently is never folded or hidden by Prioritizing. */
export const SPACE_RECENT_WORK_MS = 2 * 60 * 60_000;

const briefArgumentsSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        messageId: cuid2Schema,
        generation: Type.Optional(Type.Integer({ minimum: 0 })),
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
    },
    { additionalProperties: false },
);

/**
 * One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.
 *
 * A space is one row: Happy, or an item wrapping a task, bot, or Surface. Separators are
 * untitled visual dividers. New work is a stem cell: a fresh unnamed task wrapped in a row that waits under Happy
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
    readonly #artifacts: ArtifactsModule | undefined;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #history: HistoryModule;
    readonly #subtasks: SubtasksModule;
    readonly #team: TeamModule;
    readonly #titles: TitlesModule;
    readonly #userSettings: UserSettingsModule;
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
    /** Prioritizing agents being made right now, which are not sessions to brief about. */
    readonly #creatingPrioritizing = new Set<string>();
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
        team: TeamModule,
        userSettings: UserSettingsModule,
        titles: TitlesModule,
        artifacts?: ArtifactsModule,
    ) {
        this.#config = config;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#surfaces = surfaces;
        this.#history = history;
        this.#events = events;
        this.#durableFunctions = durableFunctions;
        this.#subtasks = subtasks;
        this.#team = team;
        this.#userSettings = userSettings;
        this.#titles = titles;
        this.#artifacts = artifacts;
        artifacts?.bindSpaces(this);
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
                    call.arguments.generation ?? 0,
                );
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        afterStart: async (ctx: Context): Promise<void> => {
            this.#subscribe();
            for (const owner of await queryOwnerStates(ctx)) {
                if (!(await this.#stemCellsEnabled(ctx, owner.ownerUserId))) {
                    await this.#disablePrioritizing(ctx, owner.ownerUserId);
                }
            }
            await ctx.inTx((tx) => this.#reconcileSurfaces(tx));
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
        overrideInstructions: async (ctx, scope, input) =>
            (await queryOwnerByPrioritizingAgent(ctx, scope.agent.id)) === undefined
                ? input.instructions
                : formatPrioritizingInstructions(),
        tools: async (ctx, scope): Promise<readonly AnyAgentTool[]> => {
            // People ask for sidebar changes in the conversations they have, not in helpers.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            // Only people who opted into the sidebar have a Prioritizing to ask; nobody else's
            // conversations change.
            const owners = new Set(
                (await querySpacesByAgent(ctx, scope.agent.id)).map((row) => row.ownerUserId),
            );
            if (!this.#config.configuration.values.feature.team.enabled)
                owners.add(SPACE_STANDALONE_OWNER);
            for (const owner of owners)
                if ((await this.#livePrioritizing(ctx, owner)) !== undefined)
                    return [requestSpacePlacementTool(this, scope.agent.id)];
            return [];
        },
        // Prioritizing is one job with one tool array and nothing else.
        overrideTools: async (ctx, scope, input) => {
            const owner = await queryOwnerByPrioritizingAgent(ctx, scope.agent.id);
            return owner === undefined
                ? input.tools
                : (await this.#stemCellsEnabled(ctx, owner.ownerUserId))
                  ? prioritizingTools(this, owner.ownerUserId, scope.agent.id)
                  : [];
        },
        beforeAgentLoop: async (ctx, scope) => {
            const owner = await queryOwnerByPrioritizingAgent(ctx, scope.agent.id);
            if (owner !== undefined) {
                if (!(await this.#stemCellsEnabled(ctx, owner.ownerUserId))) {
                    await this.#requireAgents().abort(ctx, scope.agent.id);
                    return;
                }
                this.#busyPrioritizing.add(scope.agent.id);
            }
        },
        afterAgentSettled: async (ctx, scope) => {
            const owner = (await queryOwnerByPrioritizingAgent(ctx, scope.agent.id))?.ownerUserId;
            if (owner === undefined) {
                for (const row of await querySpacesByAgent(ctx, scope.agent.id)) {
                    if (row.role === "item")
                        await this.#queueSidebarBrief(
                            ctx,
                            row.ownerUserId,
                            `Work finished or paused in space ${row.id}.`,
                        );
                }
                return;
            }
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
        // Sessions under a person's rows are Prioritizing's to give icons and to show or hide.
        agentCreatedTransact: async (ctx, _scope, agent) => {
            if (
                this.#creatingPrioritizing.has(agent.id) ||
                agent.metadata?.["subtaskConversation"] === true
            )
                return;
            const title = agent.metadata?.["title"];
            for (const owner of await this.#sessionOwners(ctx, agent.id))
                await this.#queueSidebarBrief(
                    ctx,
                    owner,
                    `New session ${agent.id}${typeof title === "string" ? ` "${title}"` : ""} started under one of the person's rows. Give it an icon with set_space_icon, and show it under its parent with edit_sidebar if the person should see it.`,
                );
        },
        metadataChangedTransact: async (ctx, _scope, change) => {
            if (typeof change.update["archivedAt"] !== "number") return;
            for (const owner of await this.#sessionOwners(ctx, change.agentId))
                await this.#sidebarLifecycle(ctx, owner, { remove: change.agentId });
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
                const placedByPerson = (
                    await this.#ownerState(ctx, row.ownerUserId)
                ).sidebarManualIds?.includes(row.id);
                await this.#brief(
                    ctx,
                    row.ownerUserId,
                    newWorkBrief(row, text, placedByPerson === true),
                );
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

    async sidebar(ctx: Context, ownerUserId: SpaceOwnerId) {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            await this.#ensurePrioritizing(txCtx, ownerUserId);
            const artifactId = await this.#ensureSidebar(txCtx, ownerUserId);
            await this.#migrateSidebar(txCtx, ownerUserId, artifactId);
            return await this.#readSidebar(txCtx, ownerUserId, artifactId);
        });
    }

    /** A document in the first grammar is rewritten once, as a version of its own. */
    async #migrateSidebar(ctx: Context, ownerUserId: SpaceOwnerId, artifactId: string) {
        const current = await this.#readSidebar(ctx, ownerUserId, artifactId);
        const html = migrateLegacySidebar(current.html);
        if (html === undefined) return;
        const known = new Set(current.spaces.map((space) => space.id));
        const root = parseSidebar(html);
        const kept = root.children.filter(
            (node) => node.tag !== "happy-space" || known.has(node.attrs["id"]!),
        );
        root.children.splice(0, root.children.length, ...kept);
        await this.#writeSidebar(
            ctx,
            artifactId,
            formatSidebar(root),
            current.version,
            createId(),
            ownerAuthor(ownerUserId),
        );
        const state = await this.#ownerState(ctx, ownerUserId);
        await writeOwnerState(ctx, {
            ...state,
            sidebarPending: [],
            sidebarBrief: [
                ...(state.sidebarBrief ?? []),
                "The sidebar was rewritten in the current grammar. Decide which sessions to show under their rows.",
            ].slice(-32),
        });
    }

    async #readSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        version: number | "latest" = "latest",
    ) {
        const file = await this.#requireArtifacts().readFile(
            ctx,
            artifactId,
            version,
            "index.html",
            { maxBytes: 128 * 1024 },
        );
        const state = await this.#ownerState(ctx, ownerUserId);
        return {
            artifactId,
            version: file.version,
            html: new TextDecoder().decode(file.bytes),
            spaces: await querySpaces(ctx, ownerUserId),
            agentIcons: Object.fromEntries(
                Object.entries(state.agentIcons ?? {}).map(([agentId, slug]) => [
                    agentId,
                    { type: "library" as const, slug },
                ]),
            ),
            ...(state.sidebarSeed === true ? { seed: true as const } : {}),
        };
    }

    async #ensureSidebar(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string> {
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId !== undefined) return state.sidebarArtifactId;
        const artifacts = this.#requireArtifacts();
        const artifactId = createId();
        const classic = await this.#classicSidebar(ctx, ownerUserId);
        const html = seedSidebar(classic);
        // Rows the person already knows are placed, not new: the two-hour rule protects them from
        // the start. Untouched new work still gets its first placement after its first message.
        const untouched = new Set(
            (await querySpaces(ctx, ownerUserId))
                .filter((space) => isUntouchedStemCell(space))
                .map((space) => space.id),
        );
        const mirrored = [...classic.surfaces, ...classic.bots, ...classic.tasks].filter(
            (id) => !untouched.has(id),
        );
        // The seed is the person's to adjust first; Prioritizing changes nothing until its next run.
        await writeOwnerState(ctx, {
            ...state,
            sidebarArtifactId: artifactId,
            sidebarSeed: true,
            sidebarPlacedIds: [...new Set([...(state.sidebarPlacedIds ?? []), ...mirrored])].slice(
                -1000,
            ),
        });
        const happy = (await querySpaces(ctx, ownerUserId)).find((space) => space.role === "happy")
            ?.contents[0];
        const actor =
            state.prioritizingAgentId === undefined
                ? ownerAuthor(ownerUserId)
                : (await artifacts.actorFor(ctx, state.prioritizingAgentId)).author;
        await artifacts.create(ctx, {
            id: artifactId,
            type: "sidebar",
            title: "Sidebar",
            files: [
                { path: "index.html", uploadId: (await artifacts.stageSidebarText(ctx, html)).id },
            ],
            author: actor,
            ...(happy?.kind === "bot"
                ? {
                      source: {
                          kind: "bot" as const,
                          botId: happy.botId,
                          ...(state.prioritizingAgentId === undefined
                              ? {}
                              : { agentId: state.prioritizingAgentId }),
                      },
                  }
                : {}),
        });
        return artifactId;
    }

    /**
     * The person's classic sidebar as the daemon knows it: joined Surfaces in their member order,
     * every bot in catalog order with Happy among them, and joined tasks in membership order.
     * Sessions under them are not part of it: the sidebar shows rows, never sessions.
     */
    async #classicSidebar(ctx: Context, ownerUserId: SpaceOwnerId): Promise<ClassicSidebar> {
        const rows = await querySpaces(ctx, ownerUserId);
        const rowFor = (match: (content: SpaceRef) => boolean) =>
            rows.find((row) => row.contents[0] !== undefined && match(row.contents[0]));
        const userId = ownerUserId === SPACE_STANDALONE_OWNER ? null : ownerUserId;
        const surfaces = (await this.#surfaces.list(ctx))
            .flatMap((surface) => {
                const member = surface.members.find((candidate) => candidate.userId === userId);
                const row = rowFor((c) => c.kind === "surface" && c.surfaceId === surface.id);
                return member === undefined || row === undefined
                    ? []
                    : [{ id: row.id, orderKey: member.orderKey }];
            })
            .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
            .map(({ id }) => id);
        let happy: string | undefined;
        const bots: string[] = [];
        for (const bot of await this.#bots.list(ctx)) {
            const row = rowFor((c) => c.kind === "bot" && c.botId === bot.id);
            if (row === undefined || bot.status !== "active") continue;
            if (row.role === "happy") happy = row.id;
            else bots.push(row.id);
        }
        const tasks: string[] = [];
        for (const { task } of await this.#tasks.listForMember(ctx, ownerUserId)) {
            const row = rowFor((c) => c.kind === "task" && c.taskId === task.id);
            if (row === undefined || task.status !== "active" || task.agentId === undefined)
                continue;
            tasks.push(row.id);
        }
        return { happy, surfaces, bots, tasks };
    }

    #requireArtifacts(): ArtifactsModule {
        if (this.#artifacts === undefined)
            throw new SpaceInputError("Sidebar artifacts are unavailable.");
        return this.#artifacts;
    }

    /** Artifact storage calls this on every write, including ordinary tools and HTTP. */
    async validateSidebarWrite(
        ctx: Context,
        artifactId: string,
        html: string,
        author: ArtifactAuthor,
    ): Promise<void> {
        const owner = await queryOwnerBySidebarArtifact(ctx, artifactId);
        if (owner === undefined)
            throw new SidebarValidationError("Sidebar artifacts are created by Spaces.");
        const rows = await querySpaces(ctx, owner.ownerUserId);
        await this.#checkSidebarIds(ctx, parseSidebar(html), rows);
        if (author.kind === "user") {
            const userId = author.userId ?? SPACE_STANDALONE_OWNER;
            if (userId !== owner.ownerUserId) throw new SpaceNotFoundError();
            return;
        }
        if (author.agentId !== owner.prioritizingAgentId)
            throw new SidebarValidationError(
                "Only Prioritizing may edit this sidebar as an agent.",
            );
        await this.#requirePrioritizingEnabled(ctx, owner.ownerUserId);
        const artifact = await this.#requireArtifacts().get(ctx, artifactId);
        if (artifact === undefined) return;
        if (owner.sidebarSeed === true)
            throw new SidebarValidationError(
                "The sidebar still mirrors the person's classic sidebar. Change nothing until your next notice.",
            );
        const read = (await this.#readSidebar(ctx, owner.ownerUserId, artifactId)).html;
        const current = migrateLegacySidebar(read) ?? read;
        const { moved, carried, folded } = sidebarEdits(current, html);
        for (const key of moved) {
            if (key === "happy-search" || key === "happy-create")
                throw new SidebarValidationError("Search and Create are the person's to move.");
            if (owner.sidebarManualIds?.includes(key))
                throw new SidebarValidationError("Keep the person's manual placement.");
        }
        for (const key of folded)
            if (owner.sidebarManualFolds?.includes(key))
                throw new SidebarValidationError("Keep the person's own folds.");
        const labels = new Map(
            parseSidebar(current).children.map((node) => [sidebarKey(node), node.attrs["label"]]),
        );
        const kept = new Map(
            parseSidebar(html).children.map((node) => [sidebarKey(node), node.attrs["label"]]),
        );
        for (const id of DEFAULT_SECTION_IDS)
            if (labels.get(id) !== undefined && kept.get(id) !== labels.get(id))
                throw new SidebarValidationError(
                    "Keep the Bots and Tasks sections and their names; only the person reorganizes them.",
                );
        const sections = parseSidebar(html).children.filter(
            (node) => node.attrs["label"] !== undefined,
        );
        const name = (node: SidebarNode) =>
            node.attrs["label"]!.trim().replace(/\s+/g, " ").toLowerCase();
        for (const node of sections) {
            const label = node.attrs["label"]!;
            if (labels.get(sidebarKey(node)) === label) continue;
            if (
                labels.get(sidebarKey(node)) !== undefined &&
                owner.sidebarManualIds?.includes(sidebarKey(node))
            )
                throw new SidebarValidationError("Keep the person's name for this section.");
            if (agedLabel(label))
                throw new SidebarValidationError(
                    `Section "${label}" sorts by age or whether work is finished; name a subject instead.`,
                );
            const twin = sections.find((other) => other !== node && name(other) === name(node));
            if (twin !== undefined)
                throw new SidebarValidationError(
                    `Section ${sidebarKey(twin)} is already called "${twin.attrs["label"]!.trim()}". Move rows there instead.`,
                );
        }
        for (const row of rows) {
            const wasMoved = moved.includes(row.id);
            // A row inside a moved section moves on screen too.
            const travelled = wasMoved || carried.includes(row.id);
            const before = sidebarPlacement(current, row.id).visibility;
            const tucked =
                before === "shown" && sidebarPlacement(html, row.id).visibility !== "shown";
            if (!travelled && !tucked && !folded.includes(row.id)) continue;
            if (isUntouchedStemCell(row))
                throw new SidebarValidationError(
                    "Leave new work alone until the person sends its first message.",
                );
            if (row.role === "happy" && (travelled || tucked))
                throw new SidebarValidationError("Prioritizing cannot move or hide Happy.");
            if (wasMoved && row.manualAt !== undefined)
                throw new SidebarValidationError("Keep the person's manual placement.");
            const firstPlacement =
                row.placement === "pending" && !owner.sidebarPlacedIds?.includes(row.id);
            if (
                (travelled || tucked) &&
                !firstPlacement &&
                (await this.#recentWork(ctx, row)) !== undefined
            )
                throw new SidebarValidationError(
                    "Leave work active in the last two hours where it is, and shown.",
                );
        }
    }

    /**
     * A top-level happy-space names one of the person's rows; a nested one names a session whose
     * parent is the conversation it sits under.
     */
    async #checkSidebarIds(
        ctx: Context,
        root: SidebarNode,
        rows: readonly SpaceRecord[],
    ): Promise<void> {
        const byId = new Map(rows.map((row) => [row.id, row]));
        const agentOf = (node: SidebarNode): string | undefined => {
            if (node.parent !== root) return node.attrs["id"];
            const content = byId.get(node.attrs["id"]!)?.contents[0];
            return content === undefined || content.kind === "surface"
                ? undefined
                : content.agentId;
        };
        for (const node of sidebarNodes(root)) {
            if (node.tag !== "happy-space") continue;
            const id = node.attrs["id"]!;
            if (node.parent === root) {
                if (!byId.has(id))
                    throw new SidebarValidationError(`Unknown space ${id}.`, node.start);
                continue;
            }
            const parentAgent = agentOf(node.parent!);
            if (parentAgent === undefined || (await this.#parentOf(ctx, id)) !== parentAgent)
                throw new SidebarValidationError(
                    `${id} is not a session of the happy-space it is nested in.`,
                    node.start,
                );
        }
    }

    async updateSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: { html: string; baseVersion: number; mutationId: string },
    ) {
        const current = await this.sidebar(ctx, ownerUserId);
        const operationId = `sidebar:${createHash("sha256").update(input.mutationId).digest("hex")}`;
        return await ctx.inTx(async (txCtx) => {
            const artifacts = this.#requireArtifacts();
            const replay = await artifacts.versionForOperation(
                txCtx,
                current.artifactId,
                operationId,
            );
            if (replay !== undefined) {
                const original = await this.#readSidebar(
                    txCtx,
                    ownerUserId,
                    current.artifactId,
                    replay.number,
                );
                if (original.html !== input.html)
                    throw new SidebarConflictError(
                        current.version,
                        "The mutation ID already belongs to different content.",
                    );
                return original;
            }
            const latest = await this.#readSidebar(txCtx, ownerUserId, current.artifactId);
            if (latest.version !== input.baseVersion)
                throw new SidebarConflictError(latest.version);
            const author = {
                kind: "user" as const,
                ...(ownerUserId === SPACE_STANDALONE_OWNER ? {} : { userId: ownerUserId }),
            };
            await this.validateSidebarWrite(txCtx, current.artifactId, input.html, author);
            await this.#writeSidebar(
                txCtx,
                current.artifactId,
                input.html,
                input.baseVersion,
                operationId,
                author,
            );
            const state = await this.#ownerState(txCtx, ownerUserId);
            const edits = sidebarEdits(latest.html, input.html);
            const changed = [...edits.moved, ...edits.folded];
            delete state.sidebarSeed;
            await writeOwnerState(txCtx, {
                ...state,
                ...manualAuthority(state, edits, latest.html, input.html),
                sidebarPending: [],
                sidebarBrief: [
                    ...(state.sidebarBrief ?? []),
                    `The person changed sidebar placement or disclosure for: ${changed.join(", ")}.`,
                ].slice(-32),
            });
            return await this.#readSidebar(txCtx, ownerUserId, current.artifactId);
        });
    }

    /** Ordinary person-authored artifact edits carry the same manual authority as the app route. */
    async markSidebarManualEdit(ctx: Context, artifactId: string, html: string): Promise<void> {
        const state = await queryOwnerBySidebarArtifact(ctx, artifactId);
        if (state === undefined) throw new SpaceNotFoundError();
        const current = await this.#readSidebar(ctx, state.ownerUserId, artifactId);
        const previous = migrateLegacySidebar(current.html) ?? current.html;
        const edits = sidebarEdits(previous, html);
        const changed = [...edits.moved, ...edits.folded];
        const { sidebarSeed: _seed, ...rest } = state;
        await writeOwnerState(ctx, {
            ...rest,
            ...manualAuthority(state, edits, previous, html),
            sidebarPending: [],
            sidebarBrief: [
                ...(state.sidebarBrief ?? []),
                `The person changed sidebar placement or disclosure for: ${changed.join(", ")}.`,
            ].slice(-32),
        });
    }

    async #writeSidebar(
        ctx: Context,
        artifactId: string,
        html: string,
        baseVersion: number,
        operationId: string,
        author: ArtifactAuthor,
        metadata: Pick<UpdateArtifactInput, "title" | "background"> = {},
    ) {
        const artifacts = this.#requireArtifacts();
        const upload = await artifacts.stageSidebarText(ctx, html);
        const source =
            author.kind === "agent"
                ? (await artifacts.actorFor(ctx, author.agentId)).source
                : undefined;
        return await artifacts.commitSidebar(ctx, {
            ...metadata,
            artifactId,
            baseVersion,
            operationId,
            files: [{ path: "index.html", uploadId: upload.id }],
            author,
            ...(source === undefined ? {} : { source }),
        });
    }

    async prioritizingSidebar(ctx: Context, ownerUserId: SpaceOwnerId) {
        const current = await this.sidebar(ctx, ownerUserId);
        const state = await this.#ownerState(ctx, ownerUserId);
        const pending = state.sidebarPending?.at(-1);
        const now = Date.now();
        const age = (at: number | undefined) =>
            at === undefined ? undefined : `${formatAge(now - at)} ago`;
        const spaces = [];
        const sessions: {
            id: string;
            parentId: string;
            title: string | undefined;
            working: boolean;
            lastActive: string | undefined;
            icon: string | undefined;
        }[] = [];
        const visit = async (parentId: string, depth: number): Promise<void> => {
            if (depth > 3) return;
            for (const id of await this.#requireAgents().childOf(ctx, parentId)) {
                if (sessions.length >= 200 || id === state.prioritizingAgentId) continue;
                const metadata = (await this.#requireAgents().config(ctx, id))?.metadata;
                if (typeof metadata?.["archivedAt"] === "number") continue;
                sessions.push({
                    id,
                    parentId,
                    title: typeof metadata?.["title"] === "string" ? metadata["title"] : undefined,
                    working: this.#events.activeRunId(id) !== undefined,
                    lastActive: age(
                        await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, id),
                    ),
                    icon: state.agentIcons?.[id],
                });
                await visit(id, depth + 1);
            }
        };
        for (const space of current.spaces) {
            const description = await this.describe(ctx, space);
            const placedByPerson =
                space.manualAt !== undefined || state.sidebarManualIds?.includes(space.id) === true;
            spaces.push({
                id: space.id,
                kind: space.role === "happy" ? "happy" : (description.target?.kind ?? "empty"),
                title: description.named ? description.title : undefined,
                icon: space.icon?.type === "library" ? space.icon.slug : space.icon?.type,
                working: description.working,
                lastActive: age(description.lastActivityAt),
                ...(isUntouchedStemCell(space)
                    ? { newWork: "waiting for the person's first message; leave it alone" }
                    : space.placement === "pending" &&
                        !placedByPerson &&
                        state.sidebarPlacedIds?.includes(space.id) !== true
                      ? { newWork: "not placed yet" }
                      : {}),
                ...(placedByPerson ? { placedByPerson: true } : {}),
            });
            const content = space.contents[0];
            if (content !== undefined && content.kind !== "surface" && !isUntouchedStemCell(space))
                await visit(content.agentId, 1);
        }
        const html = pending === undefined ? current.html : pending.html;
        // Happy and new work waiting for its first message sit outside the budget.
        const exempt = new Set(
            current.spaces
                .filter((space) => space.role === "happy" || isUntouchedStemCell(space))
                .map((space) => space.id),
        );
        return {
            artifactId: current.artifactId,
            version: pending === undefined ? current.version : pending.baseVersion + 1,
            html,
            spaces,
            sessions,
            visibleRows: {
                shown: shownSidebarRows(html).filter((id) => !exempt.has(id)).length,
                budget: SIDEBAR_VISIBLE_BUDGET,
            },
            manualIds: state.sidebarManualIds ?? [],
        };
    }

    /**
     * What the person and the agent said in a row's conversation, or in a session under one of
     * the person's rows, newest first. Tool calls, their output and reasoning are left out, and the
     * answer is capped so reading a long thread stays cheap.
     */
    async rowConversation(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        id: string,
        limit: number,
    ): Promise<string> {
        let agentId = id;
        if ((await querySpace(ctx, id)) !== undefined) {
            const content = (await this.#ownedSpace(ctx, ownerUserId, id)).contents[0];
            if (content === undefined) return "This row has no conversation.";
            if (content.kind === "surface")
                return "This row is a shared Surface; it has no conversation of its own.";
            agentId = content.agentId;
        } else if (!(await this.#sessionOwners(ctx, id)).includes(ownerUserId)) {
            throw new SpaceNotFoundError();
        }
        const page = await this.#history.read(ctx, agentId, {
            from: "end",
            roles: ["user", "assistant", "agent"],
            limit: Math.min(limit * 8, 500),
        });
        const now = Date.now();
        const said: string[] = [];
        let size = 0;
        for (const { message } of [...page.messages].reverse()) {
            if (said.length >= limit) break;
            if (message.hideFromUser === true) continue;
            const text = message.blocks
                .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
                .filter((part) => part.length > 0)
                .join("\n\n");
            if (text.length === 0) continue;
            const who =
                message.role === "user"
                    ? "Person"
                    : message.role === "agent"
                      ? "Another agent"
                      : "Agent";
            const when = message.at === undefined ? "" : `, ${formatAge(now - message.at)} ago`;
            const line = `${who}${when}: ${text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text}`;
            if (size + line.length > 16_000) break;
            said.push(line);
            size += line.length;
        }
        return said.length === 0 ? "Nothing has been said here yet." : said.join("\n\n");
    }

    async editSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: { baseVersion: number; edits: readonly { oldText: string; newText: string }[] },
        operationId: string,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.prioritizingSidebar(txCtx, ownerUserId);
            const state = await this.#ownerState(txCtx, ownerUserId);
            if (
                state.sidebarPending?.some((proposal) => proposal.operationId === operationId) ||
                (await this.#requireArtifacts().versionForOperation(
                    txCtx,
                    current.artifactId,
                    operationId,
                )) !== undefined
            )
                return "This edit was already accepted.";
            if (current.version !== input.baseVersion)
                throw new SidebarConflictError(current.version);
            let html = current.html;
            for (const edit of input.edits) {
                const at = html.indexOf(edit.oldText);
                if (
                    edit.oldText.length === 0 ||
                    at < 0 ||
                    html.indexOf(edit.oldText, at + 1) !== -1
                )
                    throw new SidebarValidationError("Each oldText must occur exactly once.");
                html = html.slice(0, at) + edit.newText + html.slice(at + edit.oldText.length);
            }
            if (html === current.html) return "Nothing changed; no version was queued.";
            await this.queueSidebarArtifact(
                txCtx,
                current.artifactId,
                html,
                input.baseVersion,
                operationId,
            );
            return `Sidebar version ${input.baseVersion + 1} queued for the next calm batch.`;
        });
    }

    async queueSidebarArtifact(
        ctx: Context,
        artifactId: string,
        html: string,
        baseVersion: number,
        operationId: string,
        metadata: Pick<UpdateArtifactInput, "title" | "background"> = {},
    ): Promise<void> {
        const owner = await queryOwnerBySidebarArtifact(ctx, artifactId);
        if (owner === undefined || owner.prioritizingAgentId === undefined)
            throw new SpaceNotFoundError();
        const pending = owner.sidebarPending ?? [];
        if (pending.some((proposal) => proposal.operationId === operationId)) return;
        const current = await this.prioritizingSidebar(ctx, owner.ownerUserId);
        if (current.version !== baseVersion) throw new SidebarConflictError(current.version);
        if (pending.length >= 32)
            throw new SpaceInputError("Apply the pending sidebar batch before adding more edits.");
        await this.validateSidebarWrite(ctx, artifactId, html, {
            kind: "agent",
            agentId: owner.prioritizingAgentId,
        });
        await writeOwnerState(ctx, {
            ...owner,
            sidebarPending: [...pending, { html, baseVersion, operationId, ...metadata }],
        });
    }

    async pendingSidebarText(ctx: Context, artifactId: string): Promise<string | undefined> {
        return (await queryOwnerBySidebarArtifact(ctx, artifactId))?.sidebarPending?.at(-1)?.html;
    }

    sidebarArtifactTools(agentId: string): AnyAgentTool[] {
        return this.#artifacts?.sidebarTools(agentId) ?? [];
    }

    async #queueSidebarBrief(ctx: Context, ownerUserId: SpaceOwnerId, text: string): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return;
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId === undefined) return;
        await writeOwnerState(ctx, {
            ...state,
            sidebarBrief: [...new Set([...(state.sidebarBrief ?? []), text])].slice(-32),
        });
    }

    async #briefSidebarAtCalm(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await this.#ownerState(txCtx, ownerUserId);
            if ((state.sidebarBrief?.length ?? 0) === 0) return;
            await this.#brief(
                txCtx,
                ownerUserId,
                "The person is calm. Review these sidebar changes and the current artifact; edit only if needed.",
            );
        });
    }

    async #sidebarLifecycle(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: { add?: string; remove?: string; sectionId?: string },
    ): Promise<void> {
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId === undefined) return;
        await this.#migrateSidebar(ctx, ownerUserId, state.sidebarArtifactId);
        const current = await this.#readSidebar(ctx, ownerUserId, state.sidebarArtifactId);
        let html =
            change.remove === undefined
                ? current.html
                : removeSidebarNode(current.html, change.remove);
        if (change.add !== undefined) {
            const happyId = (await querySpaces(ctx, ownerUserId)).find(
                (space) => space.role === "happy",
            )?.id;
            html = insertSidebarSpace(html, change.add, {
                ...(change.sectionId === undefined ? {} : { headingId: change.sectionId }),
                ...(happyId === undefined ? {} : { happyId }),
            });
        }
        if (html === current.html) return;
        await this.#writeSidebar(
            ctx,
            state.sidebarArtifactId,
            html,
            current.version,
            createId(),
            ownerAuthor(ownerUserId),
        );
        const added = change.add === undefined ? undefined : await querySpace(ctx, change.add);
        const fresh = await this.#ownerState(ctx, ownerUserId);
        await writeOwnerState(ctx, {
            ...fresh,
            sidebarPending: [],
            // New work is told to Prioritizing with its first message, not when it appears.
            ...(added !== undefined && isUntouchedStemCell(added)
                ? {}
                : {
                      sidebarBrief: [
                          ...(fresh.sidebarBrief ?? []),
                          change.add === undefined
                              ? `${change.remove} left the sidebar with the sessions under it.`
                              : `New space ${change.add} was inserted${change.sectionId === undefined ? " below Happy" : ` after ${change.sectionId}`}.`,
                      ].slice(-32),
                  }),
        });
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
            const existing = await querySpace(txCtx, input.spaceId);
            if (existing !== undefined) {
                if (existing.ownerUserId !== ownerUserId) throw new SpaceNotFoundError();
                return existing;
            }
            await this.#ensureOwner(txCtx, ownerUserId);
            let legacySectionId: string | undefined;
            if (input.sectionId !== undefined) {
                const section = await querySection(txCtx, input.sectionId);
                if (section?.ownerUserId === ownerUserId) legacySectionId = section.id;
                const sidebar =
                    this.#artifacts === undefined
                        ? undefined
                        : await this.sidebar(txCtx, ownerUserId);
                const authored =
                    sidebar !== undefined &&
                    parseSidebar(sidebar.html).children.some(
                        (node) => isSidebarHeading(node) && node.attrs["id"] === input.sectionId,
                    );
                if (legacySectionId === undefined && !authored) {
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
                ...(legacySectionId === undefined ? {} : { sectionId: legacySectionId }),
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
            // A sidebar row names its subject in a few words; other work keeps standard names.
            if (await this.#stemCellsEnabled(txCtx, ownerUserId)) {
                await this.#titles.nameBySubject(txCtx, input.task.agentId);
            }
            // Prioritizing begins with the person's first new work.
            await this.#ensurePrioritizing(txCtx, ownerUserId);
            if (this.#artifacts !== undefined) {
                await this.#ensureSidebar(txCtx, ownerUserId);
                await this.#sidebarLifecycle(txCtx, ownerUserId, {
                    add: space.id,
                    ...(previous === undefined ? {} : { remove: previous.id }),
                    ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
                });
            }
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
     * the client says otherwise or goes quiet; `calm` — the person is idle or the app is out of
     * sight, never a click or a navigation — applies the queued batch now, unless Prioritizing is mid-decision, in
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
        const batch = await this.#applyIfDue(ctx, ownerUserId, "calm");
        await this.#briefSidebarAtCalm(ctx, ownerUserId);
        return batch;
    }

    /**
     * "Tidy now" is one automatic message in Prioritizing's conversation and nothing more. Before
     * the person's first new work there is no Prioritizing, and it does nothing.
     */
    async requestTidy(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            await this.#brief(txCtx, ownerUserId, "Tidy the sidebar now.");
        });
    }

    /** Queue one Prioritizing change for the next calm moment. Only Prioritizing calls this. */
    async queueChange(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: SpacePendingChange,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            if (change.type === "place" || change.type === "visibility") {
                const space = await this.#ownedSpace(txCtx, ownerUserId, change.spaceId);
                if (space.role !== "item") {
                    throw new SpaceConflictError("Happy cannot be moved.");
                }
                if (change.type === "visibility" && change.visibility !== "shown") {
                    const busy = await this.#recentWork(txCtx, space);
                    if (busy !== undefined)
                        return `${busy}, so it stays shown. Nothing was queued.`;
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
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const row = await querySpace(txCtx, spaceId);
            if (row === undefined)
                return await this.#setSessionIcon(txCtx, ownerUserId, spaceId, slug);
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            if (space.role !== "item") throw new SpaceConflictError("Only item rows take icons.");
            // A stem cell stays one until the person says what they want.
            if (isUntouchedStemCell(space))
                return "This is new work with no first message yet; its icon was left alone.";
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

    /** A session under one of the person's rows keeps its icon even when it is not shown. */
    async #setSessionIcon(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        agentId: string,
        slug: SpaceIconSlug,
    ): Promise<string> {
        const owners = await this.#sessionOwners(ctx, agentId);
        if (!owners.includes(ownerUserId)) throw new SpaceNotFoundError();
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.agentIcons?.[agentId] === slug) return `The session already shows ${slug}.`;
        const icons = Object.entries({ ...state.agentIcons, [agentId]: slug }).filter(
            ([id]) => id !== agentId,
        );
        await writeOwnerState(ctx, {
            ...state,
            agentIcons: Object.fromEntries([...icons.slice(-999), [agentId, slug]]),
        });
        return `Icon set to ${slug}.`;
    }

    /** An agent's parent, or null for a root or an agent that does not exist. */
    async #parentOf(ctx: Context, agentId: string): Promise<string | null> {
        const agents = this.#requireAgents();
        if ((await agents.config(ctx, agentId)) === undefined) return null;
        return await agents.parentOf(ctx, agentId);
    }

    /** The people whose rows hold this session: the owners of the rows of its root conversation. */
    async #sessionOwners(ctx: Context, agentId: string): Promise<string[]> {
        let root = agentId;
        for (let depth = 0; depth < 16; depth++) {
            const parent = await this.#parentOf(ctx, root);
            if (parent === null) break;
            root = parent;
        }
        if (root === agentId) return [];
        return [...new Set((await querySpacesByAgent(ctx, root)).map((row) => row.ownerUserId))];
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
            if (
                rows.length === 0 &&
                !this.#config.configuration.values.feature.team.enabled &&
                (await this.#livePrioritizing(txCtx, SPACE_STANDALONE_OWNER)) !== undefined
            ) {
                await this.#ensureOwner(txCtx, SPACE_STANDALONE_OWNER);
                rows = await querySpacesByAgent(txCtx, input.agentId);
            }
            if (rows.length === 0) {
                return "That conversation is not in anyone's sidebar, so there is nothing to move.";
            }
            let briefed = false;
            for (const row of rows) {
                const description = await this.describe(txCtx, row);
                if ((await this.#livePrioritizing(txCtx, row.ownerUserId)) === undefined) continue;
                briefed = true;
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
            if (!briefed) {
                return "Nothing organises that sidebar yet; the person can move the row themselves.";
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
            if (!(await this.#stemCellsEnabled(txCtx, ownerUserId))) return undefined;
            const state = await this.#ownerState(txCtx, ownerUserId);
            if ((state.sidebarPending?.length ?? 0) > 0)
                return await this.#applySidebarBatch(txCtx, ownerUserId, state);
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
            // Protect the final composed outcome, including indirect folds from section removal
            // and work that came back to life after its change was queued.
            const protectedSpaceIds = new Set<string>();
            for (const space of spaces) {
                if ((await this.#recentWork(txCtx, space)) !== undefined) {
                    protectedSpaceIds.add(space.id);
                }
            }
            const titles = new Map<string, string>();
            for (const space of spaces) {
                if (space.role === "item") {
                    const description = await this.describe(txCtx, space);
                    // Work that has not named itself is never called by its placeholder.
                    titles.set(space.id, description.named ? description.title : "a new chat");
                }
            }
            const now = Date.now();
            const outcome = applySpaceChanges(
                ownerUserId,
                spaces,
                sections,
                pending,
                titles,
                now,
                protectedSpaceIds,
            );
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
    async #applySidebarBatch(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        state: SpaceOwnerState,
    ): Promise<SpaceBatch | undefined> {
        if (state.sidebarArtifactId === undefined || state.prioritizingAgentId === undefined)
            return undefined;
        const pending = state.sidebarPending ?? [];
        const current = await this.#readSidebar(ctx, ownerUserId, state.sidebarArtifactId);
        const author = { kind: "agent" as const, agentId: state.prioritizingAgentId };
        let expected = current.version;
        try {
            for (const proposal of pending) {
                if (proposal.baseVersion !== expected++)
                    throw new SidebarConflictError(current.version);
                await this.validateSidebarWrite(ctx, current.artifactId, proposal.html, author);
            }
        } catch (error: unknown) {
            if (!(error instanceof SidebarValidationError || error instanceof SidebarConflictError))
                throw error;
            await writeOwnerState(ctx, {
                ...state,
                sidebarPending: [],
                sidebarBrief: [...(state.sidebarBrief ?? []), error.message].slice(-32),
            });
            return undefined;
        }
        const final = pending.at(-1);
        if (final === undefined) return undefined;
        const base = migrateLegacySidebar(current.html) ?? current.html;
        const edits = sidebarEdits(base, final.html);
        const changed = [...new Set([...edits.moved, ...edits.folded])];
        const changes: SpaceBatch["changes"] = [];
        for (const key of changed) {
            // Opening a row moves nothing; only what moved or appeared or vanished is described.
            if (
                !edits.moved.includes(key) &&
                sidebarPlacement(base, key).visibility ===
                    sidebarPlacement(final.html, key).visibility
            )
                continue;
            const row = current.spaces.find((space) => space.id === key);
            if (row?.role === "happy") continue;
            let title: string | undefined;
            if (row !== undefined) {
                const description = await this.describe(ctx, row);
                title = description.named ? description.title : "a new chat";
            } else {
                // A session under a row; separators, Search, and Create are not work.
                const metadata = (await this.#requireAgents().config(ctx, key))?.metadata;
                if (metadata === undefined) continue;
                title = typeof metadata["title"] === "string" ? metadata["title"] : "a session";
            }
            changes.push({
                spaceId: key,
                title,
                from: { ...sidebarPlacement(base, key), placement: row?.placement ?? "settled" },
                to: { ...sidebarPlacement(final.html, key), placement: "settled" },
            });
        }
        const headings = (html: string) =>
            new Map(
                parseSidebar(html)
                    .children.filter(isSidebarHeading)
                    .map((node) => [sidebarKey(node), node]),
            );
        const earlier = headings(base);
        const later = headings(final.html);
        // A section that moved carried its rows; the note names the section, not each row.
        const movedSections = edits.moved.flatMap((key) => {
            const label = later.get(key)?.attrs["label"];
            return label === undefined || !earlier.has(key) ? [] : [label];
        });
        const sections: SpaceBatch["sections"] = [];
        for (const [id, node] of later) {
            const label = node.attrs["label"];
            if (label === undefined) continue;
            const previous = earlier.get(id);
            if (previous === undefined)
                sections.push({ sectionId: id, name: label, change: "created" });
            else if (previous.attrs["label"] !== label)
                sections.push({ sectionId: id, name: label, change: "updated" });
        }
        for (const [id, node] of earlier)
            if (node.attrs["label"] !== undefined && !later.has(id))
                sections.push({ sectionId: id, name: node.attrs["label"], change: "removed" });
        // Separators have no title, so new ones are counted rather than named.
        const separators = [...later].filter(
            ([id, node]) => node.tag === "happy-separator" && !earlier.has(id),
        );
        if (separators.length > 0)
            sections.push({
                sectionId: separators[0]![0],
                name: separators.length === 1 ? "a separator" : `${separators.length} separators`,
                change: "created",
            });
        for (const proposal of pending)
            await this.#writeSidebar(
                ctx,
                current.artifactId,
                proposal.html,
                proposal.baseVersion,
                proposal.operationId,
                author,
                {
                    ...(proposal.title === undefined ? {} : { title: proposal.title }),
                    ...(proposal.background === undefined
                        ? {}
                        : { background: proposal.background }),
                },
            );
        const cleared = {
            ...state,
            sidebarPending: [],
            sidebarPlacedIds: [...new Set([...(state.sidebarPlacedIds ?? []), ...changed])].slice(
                -1000,
            ),
        };
        delete cleared.applyRequestedAt;
        await writeOwnerState(ctx, cleared);
        if (
            current.html === final.html &&
            pending.every(
                (proposal) => proposal.title === undefined && proposal.background === undefined,
            )
        )
            return undefined;
        const note =
            changes.length === 0 && sections.length === 0 && movedSections.length === 0
                ? "Updated the sidebar."
                : composeSpaceBatchNote(changes, sections, movedSections);
        const now = Date.now();
        const happyAgentId = await this.#happyAgentId(ctx, ownerUserId);
        const noteMessageId = createId();
        if (happyAgentId !== undefined) {
            const runId = createId();
            await this.#history.beginMaintenanceRun(ctx, happyAgentId, runId, now);
            await this.#history.record(ctx, happyAgentId, {
                role: "assistant",
                recordId: noteMessageId,
                runId,
                blocks: [{ type: "text", text: note }],
                at: now,
            });
            await this.#history.finishMaintenanceRun(ctx, happyAgentId, runId, "completed", now);
        }
        const batch: SpaceBatch = {
            id: createId(),
            ownerUserId,
            changes,
            sections,
            note,
            ...(happyAgentId === undefined ? {} : { noteMessageId }),
            appliedAt: now,
        };
        await insertBatch(ctx, batch);
        await this.#commitEvents(ctx, ownerUserId, undefined, [{ type: "batch_applied", batch }]);
        return batch;
    }

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
            if (
                (await queryPendingChanges(ctx, ownerUserId)).length === 0 &&
                (state.sidebarPending?.length ?? 0) === 0
            )
                return undefined;
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
            if (state.applyRequestedAt !== undefined || (state.sidebarPending?.length ?? 0) > 0)
                owners.add(state.ownerUserId);
            if (
                (state.sidebarBrief?.length ?? 0) > 0 &&
                !this.#interacting(state.ownerUserId, Date.now()) &&
                this.#idle(state.ownerUserId, Date.now())
            ) {
                await this.#briefSidebarAtCalm(ctx, state.ownerUserId);
            }
        }
        for (const owner of owners) {
            if (!Value.Check(spaceOwnerIdSchema, owner)) continue;
            try {
                await this.#applyIfDue(ctx, owner, "check");
            } catch (error: unknown) {
                // An unreadable state was already skipped above; it must not stop everyone else.
                if (!(error instanceof SpaceStorageError)) throw error;
            }
        }
    }

    /**
     * Queue a message for the person's Prioritizing, delivered after this transaction commits.
     * A person without Prioritizing yet has nobody to tell, so nothing is queued.
     */
    async #brief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        text: string,
        operationId?: string,
    ): Promise<void> {
        if ((await this.#livePrioritizing(ctx, ownerUserId)) === undefined) return;
        const state = await this.#ownerState(ctx, ownerUserId);
        const brief = [
            text,
            ...(state.sidebarBrief ?? []),
            "Read the sidebar with list_sidebar and read_row_conversation before placing or ranking anything, keep within the visible budget, and preserve manual moves and folds.",
        ]
            .join("\n\n")
            .slice(0, 20_000);
        await this.#durableFunctions.invoke(ctx, {
            function: BRIEF_FUNCTION,
            arguments: {
                ownerUserId,
                messageId: createId(),
                text: brief,
                generation: state.prioritizingGeneration ?? 0,
            },
            ...(operationId === undefined ? {} : { operationId: `spaces:${operationId}` }),
        });
        const { sidebarSeed: _seed, ...rest } = state;
        // A notice after the opening is Prioritizing's next normal run: the seed is its to tidy.
        await writeOwnerState(ctx, { ...rest, sidebarBrief: [] });
    }

    async #deliverBrief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        messageId: string,
        text: string,
        generation: number,
    ): Promise<void> {
        await ctx.inTx(async (ctx) => {
            if (
                ((await this.#ownerState(ctx, ownerUserId)).prioritizingGeneration ?? 0) !==
                generation
            )
                return;
            const prioritizingAgentId = await this.#livePrioritizing(ctx, ownerUserId);
            if (prioritizingAgentId === undefined) return;
            const route = await this.#prioritizingRoute(ctx, ownerUserId);
            if (route === undefined) throw new Error("No model is available for Prioritizing.");
            await this.#requireAgents().send(
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
        });
    }

    /** The person's Prioritizing, unless they have none yet or archived it. */
    async #livePrioritizing(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string | undefined> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return undefined;
        const agentId = (await queryOwnerState(ctx, ownerUserId))?.prioritizingAgentId;
        if (agentId === undefined) return undefined;
        const config = await this.#requireAgents().config(ctx, agentId);
        return config === undefined || typeof config.metadata?.["archivedAt"] === "number"
            ? undefined
            : agentId;
    }

    /** The sidebar experiment belongs to this person, never to the installation or another caller. */
    async #stemCellsEnabled(ctx: Context, ownerUserId: SpaceOwnerId): Promise<boolean> {
        let personCtx = ctx;
        if (this.#team.enabled) {
            const user = await this.#team.getUser(ctx, ownerUserId);
            if (user === undefined || user.authentication === "guest") return false;
            personCtx = this.#team.connectionContext(ctx, user);
        }
        return (
            (await this.#userSettings.get(personCtx, "happy-desktop.experiments.stemCells"))
                .value === true
        );
    }

    async #requirePrioritizingEnabled(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) {
            throw new SpaceConflictError(
                "Turn on Stem Cells to let Prioritizing change the sidebar.",
            );
        }
    }

    /** Disable only this person's organiser; its conversation and every existing name stay intact. */
    async #disablePrioritizing(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await queryOwnerState(txCtx, ownerUserId);
            if (state === undefined) return;
            const { applyRequestedAt: _requested, ...rest } = state;
            await deletePendingChanges(txCtx, ownerUserId);
            await writeOwnerState(txCtx, {
                ...rest,
                sidebarPending: [],
                sidebarBrief: [],
                prioritizingGeneration: (state.prioritizingGeneration ?? 0) + 1,
            });
            afterCommit(txCtx, () => {
                this.#calmSignalled.delete(ownerUserId);
            });
            if (state.prioritizingAgentId !== undefined) {
                await this.#requireAgents().abort(txCtx, state.prioritizingAgentId);
            }
        });
    }

    /** The default model from Settings, which a new chat also starts with, at its own effort. */
    async #prioritizingRoute(ctx: Context, ownerUserId: SpaceOwnerId) {
        // Settings belong to whoever the context names: the standalone person, or a team member.
        let personCtx: Context | undefined = ctx;
        if (this.#team.enabled) {
            const user = await this.#team.getUser(ctx, ownerUserId);
            personCtx =
                user === undefined || user.authentication === "guest"
                    ? undefined
                    : this.#team.connectionContext(ctx, user);
        }
        return selectPrioritizingRoute(
            this.#config.models,
            personCtx === undefined
                ? null
                : (await this.#userSettings.get(personCtx, PRIORITIZING_DEFAULT_MODEL_SETTING))
                      .value,
        );
    }

    async #happyAgentId(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string | undefined> {
        const happy = (await querySpaceByRef(ctx, ownerUserId, "happy"))?.contents[0];
        return happy?.kind === "bot" ? happy.agentId : undefined;
    }

    /**
     * Prioritizing is an ordinary subtask of Happy, made through the same path as any subtask
     * Happy creates, with its opening task. It is made with the person's first new work, and
     * again with the next new work after the person archived it.
     */
    async #ensurePrioritizing(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return;
        if ((await this.#livePrioritizing(ctx, ownerUserId)) !== undefined) return;
        const happyAgentId = await this.#happyAgentId(ctx, ownerUserId);
        const route = await this.#prioritizingRoute(ctx, ownerUserId);
        if (happyAgentId === undefined || route === undefined) return;
        const prioritizingAgentId = createId();
        this.#creatingPrioritizing.add(prioritizingAgentId);
        afterCommit(ctx, () => {
            this.#creatingPrioritizing.delete(prioritizingAgentId);
        });
        await this.#subtasks.create(
            ctx,
            happyAgentId,
            {
                title: "Prioritizing",
                text: PRIORITIZING_OPENING,
                provider: route.providerId,
                model: route.model,
                effort: route.effort,
            },
            prioritizingAgentId,
            undefined,
            { provider: route.providerId, model: route.model },
            // Happy hears from Prioritizing only through the batch note, one line per batch.
            { unreported: true },
        );
        await writeOwnerState(ctx, {
            ...(await this.#ownerState(ctx, ownerUserId)),
            prioritizingAgentId,
        });
    }

    /** Why this row's work counts as live — running now, or active in the last two hours. */
    async #recentWork(ctx: Context, space: SpaceRecord): Promise<string | undefined> {
        const description = await this.describe(ctx, space);
        if (description.working) return "This row's work is running now";
        const at = description.lastActivityAt;
        if (at !== undefined && Date.now() - at < SPACE_RECENT_WORK_MS) {
            return `This row was active ${formatAge(Date.now() - at)} ago`;
        }
        return undefined;
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
     * Make sure the person has Happy and a row for everything they already have. Existing work
     * arrives folded and unplaced, and Prioritizing organises it when it begins.
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
            if (
                surfaceType === undefined ||
                (surfaceNeedsContent(surfaceType) &&
                    !(await this.#surfaces.hasContent(ctx, surface.id)))
            )
                continue;
            await seed(
                { kind: "surface", surfaceId: surface.id, surfaceType },
                surface.image === null ? undefined : { type: "image" },
            );
        }
        // Prioritizing's opening task places the seeded rows; that first tidy applies at once.
        await writeOwnerState(ctx, {
            ownerUserId,
            ...(seeded > 0 ? { applyRequestedAt: now } : {}),
        });
        await this.#commitEvents(ctx, ownerUserId, undefined, drafts);
    }

    /** Keep rows in step with the work they hold as it is created, joined, renamed, and closed. */
    #subscribe(): void {
        if (this.#unsubscribe.length > 0) return;
        this.#unsubscribe.push(
            this.#userSettings.onEventTransactional(async (ctx, event) => {
                if (
                    event.setting.key === "happy-desktop.experiments.stemCells" &&
                    event.setting.value !== true
                ) {
                    await this.#disablePrioritizing(ctx, event.owner);
                }
            }),
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
                if (
                    event.type === "bot_created" ||
                    (event.bot.status === "active" && event.previousBot.status === "archived")
                ) {
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
            this.#surfaces.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-surface-event");
                const surfaceId =
                    event.type === "surface.created"
                        ? event.payload.surface.id
                        : event.type === "todo.created"
                          ? event.payload.todo.surfaceId
                          : event.type === "calendar_event.created"
                            ? event.payload.event.surfaceId
                            : event.payload.surfaceId;
                await ctx.inTx(async (txCtx) => {
                    // Notifications are durable and may lag later membership changes. Reconcile
                    // against current state so a delayed join cannot resurrect a row after leave.
                    await this.#reconcileSurfaces(txCtx, surfaceId);
                    if (event.type === "surface.updated") {
                        // Names and pictures are projected live; advance rows and emit their
                        // complete snapshots so connected sidebars refresh those projections.
                        await this.#touchWork(txCtx, `surface:${surfaceId}`);
                    }
                });
            }),
            this.#surfaces.onDocumentChanged(async (_ctx, surfaceId) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                await lifetime
                    .named("spaces-document-event")
                    .inTx((tx) => this.#reconcileSurfaces(tx, surfaceId));
            }),
        );
    }

    /** Eligibility is current content plus membership; existing placement remains the person's. */
    async #reconcileSurfaces(ctx: Context, onlySurfaceId?: string): Promise<void> {
        const ownerIds = (await queryOwnerStates(ctx)).map((state) => state.ownerUserId);
        if (ownerIds.length === 0) return;
        const eligible = new Map<string, SpaceRef & { kind: "surface" }>();
        const surfaces = (await this.#surfaces.list(ctx)).filter(
            (surface) => onlySurfaceId === undefined || surface.id === onlySurfaceId,
        );
        for (const surface of surfaces) {
            const surfaceType = surfaceTypeOf(surface.type);
            if (
                surfaceType === undefined ||
                !ownerIds.some((owner) => joinedBy(surface.members, owner))
            )
                continue;
            if (
                !surfaceNeedsContent(surfaceType) ||
                (await this.#surfaces.hasContent(ctx, surface.id))
            )
                eligible.set(surface.id, { kind: "surface", surfaceId: surface.id, surfaceType });
        }
        for (const owner of ownerIds) {
            for (const row of await querySpaces(ctx, owner)) {
                const content = row.contents[0];
                if (
                    content?.kind !== "surface" ||
                    (onlySurfaceId !== undefined && content.surfaceId !== onlySurfaceId)
                )
                    continue;
                const surface = surfaces.find((candidate) => candidate.id === content.surfaceId);
                if (
                    !eligible.has(content.surfaceId) ||
                    surface === undefined ||
                    !joinedBy(surface.members, owner)
                )
                    await this.#closeWork(ctx, `surface:${content.surfaceId}`, [owner]);
            }
            for (const surface of surfaces) {
                const content = eligible.get(surface.id);
                if (content !== undefined && joinedBy(surface.members, owner))
                    await this.#addWork(
                        ctx,
                        owner,
                        content,
                        surface.image === null ? undefined : { type: "image" },
                    );
            }
        }
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
                await this.#queueSidebarBrief(
                    txCtx,
                    row.ownerUserId,
                    `Space ${row.id} was renamed or its identity changed. Read its live title with list_sidebar.`,
                );
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
        if (this.#artifacts !== undefined) {
            for (const draft of drafts) {
                if (draft.type === "space_created")
                    await this.#sidebarLifecycle(ctx, ownerUserId, { add: draft.space.id });
                if (draft.type === "space_removed")
                    await this.#sidebarLifecycle(ctx, ownerUserId, { remove: draft.spaceId });
            }
        }
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

function newWorkBrief(row: SpaceRecord, text: string, placedByPerson: boolean): string {
    const excerpt = text.length > MAX_BRIEF_TEXT ? `${text.slice(0, MAX_BRIEF_TEXT)}…` : text;
    return [
        `New work started in row ${row.id}. Its first message:`,
        excerpt,
        row.placement === "pending" && !placedByPerson
            ? "Choose its icon now with set_space_icon, then read the sidebar with list_sidebar and place it with edit_sidebar next to the rows it belongs with. This first placement waits for a calm moment."
            : "The person already placed it. Choose its icon now with set_space_icon; do not move it.",
    ].join("\n\n");
}

/** The person's moves and folds, kept so Prioritizing leaves exactly those alone. */
/**
 * What a person's write makes theirs: the items they moved, and the sections they named, keep
 * their place and their name; the switches they set keep their state.
 */
function manualAuthority(
    state: SpaceOwnerState,
    edits: { moved: readonly string[]; folded: readonly string[] },
    before: string,
    after: string,
) {
    const labelOf = (html: string) =>
        new Map(
            parseSidebar(html)
                .children.filter((node) => node.attrs["label"] !== undefined)
                .map((node) => [sidebarKey(node), node.attrs["label"]]),
        );
    const earlier = labelOf(before);
    const named = [...labelOf(after)]
        .filter(([key, label]) => earlier.get(key) !== label)
        .map(([key]) => key);
    return {
        sidebarManualIds: [
            ...new Set([...(state.sidebarManualIds ?? []), ...edits.moved, ...named]),
        ].slice(-1000),
        sidebarManualFolds: [
            ...new Set([...(state.sidebarManualFolds ?? []), ...edits.folded]),
        ].slice(-1000),
    };
}

/** New work nobody has written in yet: it stays a stem cell until its first message. */
function isUntouchedStemCell(row: SpaceRecord): boolean {
    return row.role === "item" && row.icon?.type === "stem_cell" && row.briefedAt === undefined;
}

/** An "Older" or "Done" section reads as finished work; sections name subjects instead. */
function agedLabel(label: string): boolean {
    return /\b(old|older|oldest|done|finished|archive|archived|stale)\b/i.test(label);
}

function ownerAuthor(ownerUserId: SpaceOwnerId): ArtifactAuthor {
    return {
        kind: "user",
        ...(ownerUserId === SPACE_STANDALONE_OWNER ? {} : { userId: ownerUserId }),
    };
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

function surfaceNeedsContent(type: NonNullable<ReturnType<typeof surfaceTypeOf>>): boolean {
    return type === "todo" || type === "document" || type === "calendar";
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
