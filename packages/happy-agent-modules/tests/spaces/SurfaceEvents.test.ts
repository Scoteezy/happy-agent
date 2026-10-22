import type { Surface } from "@slopus/happy-agent-client";
import { expect, it } from "vitest";
import {
    SpacesModule,
    spaceMigrations,
    type SpaceEvent,
    type SpaceRecord,
} from "../../sources/spaces/index.js";
import type { SurfacesModule, SurfaceEvent } from "../../sources/surfaces/index.js";
import {
    insertSpace,
    querySpace,
    querySpaces,
    writeOwnerState,
} from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents } from "../support/moduleHooks.js";

it("refreshes Surface names and pictures from current state and removes its subscription on close", async () => {
    const database = moduleDatabase(spaceMigrations, "surface-events");
    await database.ready;
    const listeners = new Set<Parameters<SurfacesModule["onEvent"]>[0]>();
    const events: SpaceEvent[] = [];
    let content = true;
    let surface: Surface = {
        id: "surfaceaaaaaaaaaaaaaaaaa",
        type: "todo",
        name: "Original",
        image: null,
        members: [{ userId: null, joinedAt: 1, orderKey: "1" }],
        updatedAt: 1,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    };
    const subscribe = () => () => undefined;
    const spaces = new SpacesModule(
        {} as ConstructorParameters<typeof SpacesModule>[0],
        { onEvent: subscribe } as unknown as ConstructorParameters<typeof SpacesModule>[1],
        { onEvent: subscribe } as unknown as ConstructorParameters<typeof SpacesModule>[2],
        {
            list: async () => [surface],
            hasContent: async () => content,
            onDocumentChanged: () => () => undefined,
            onEvent(listener: Parameters<SurfacesModule["onEvent"]>[0]) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        } as unknown as ConstructorParameters<typeof SpacesModule>[3],
        {} as ConstructorParameters<typeof SpacesModule>[4],
        {} as ConstructorParameters<typeof SpacesModule>[5],
        { register: () => undefined } as unknown as ConstructorParameters<typeof SpacesModule>[6],
        {} as ConstructorParameters<typeof SpacesModule>[7],
    );
    try {
        await writeOwnerState(database.context, { ownerUserId: "standalone" });
        await insertSpace(database.context, {
            id: "spaceaaaaaaaaaaaaaaaaaaa",
            ownerUserId: "standalone",
            role: "item",
            icon: { type: "image" },
            contents: [{ kind: "surface", surfaceId: surface.id, surfaceType: "todo" }],
            orderKey: "1",
            placement: "settled",
            visibility: "shown",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        });
        spaces.onEvent((_ctx, event) => {
            events.push(event);
        });
        const hooks = spaces.beforeStart(database.context, primaryAgents());
        await hooks.afterStart?.(database.context, {} as never);
        surface = { ...surface, name: "Renamed", image: { thumbhash: "picture" }, updatedAt: 2 };
        const event: SurfaceEvent = {
            type: "surface.updated",
            payload: {
                surfaceId: surface.id,
                previousVersion: surface.version,
                version: surface.version,
                changes: { members: surface.members, updatedAt: 2 },
            },
        };
        for (const listener of listeners) await listener(database.context, event);
        const row = (await querySpace(database.context, "spaceaaaaaaaaaaaaaaaaaaa"))!;
        expect(row.version).toBe(2);
        expect(await spaces.describe(database.context, row)).toMatchObject({
            title: "Renamed",
            imageUrl: `/v0/surfaces/${surface.id}/image`,
        });
        expect(events).toContainEqual(
            expect.objectContaining({ type: "space_updated", ownerUserId: "standalone" }),
        );
        const todoEvent: SurfaceEvent = {
            type: "todo.updated",
            payload: {
                surfaceId: surface.id,
                todoId: "todoaaaaaaaaaaaaaaaaaaaa",
                previousVersion: surface.version,
                version: surface.version,
                changes: { status: "deleted", updatedAt: 3 },
            },
        };
        content = false;
        for (const listener of listeners) await listener(database.context, todoEvent);
        expect(await querySpace(database.context, row.id)).toBeUndefined();
        expect(events).toContainEqual(
            expect.objectContaining({ type: "space_removed", spaceId: row.id }),
        );
        content = true;
        for (const listener of listeners) await listener(database.context, todoEvent);
        const restored = await querySpaces(database.context, "standalone");
        expect(restored).toHaveLength(1);
        for (const listener of listeners) await listener(database.context, todoEvent);
        expect(await querySpaces(database.context, "standalone")).toEqual(restored);
        surface = { ...surface, members: [] };
        // An old content notification cannot undo a newer leave.
        for (const listener of listeners) await listener(database.context, todoEvent);
        expect(await querySpaces(database.context, "standalone")).toEqual([]);
        await spaces.close();
        expect(listeners.size).toBe(0);
    } finally {
        await spaces.close();
        database.close();
    }
});

it.each([false, true])(
    "keeps a joined reference Surface at startup (existing row: %s)",
    async (existing) => {
        const database = moduleDatabase(spaceMigrations, "reference-startup");
        await database.ready;
        const surface: Surface = {
            id: "surfaceaaaaaaaaaaaaaaaaa",
            type: "reference",
            name: "Shared reference",
            image: null,
            members: [{ userId: null, joinedAt: 1, orderKey: "1" }],
            updatedAt: 1,
            version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        };
        const subscribe = () => () => undefined;
        const spaces = new SpacesModule(
            {} as ConstructorParameters<typeof SpacesModule>[0],
            { onEvent: subscribe } as unknown as ConstructorParameters<typeof SpacesModule>[1],
            { onEvent: subscribe } as unknown as ConstructorParameters<typeof SpacesModule>[2],
            {
                list: async () => [surface],
                hasContent: async () => false,
                onDocumentChanged: subscribe,
                onEvent: subscribe,
            } as unknown as ConstructorParameters<typeof SpacesModule>[3],
            {} as ConstructorParameters<typeof SpacesModule>[4],
            {} as ConstructorParameters<typeof SpacesModule>[5],
            { register: () => undefined } as unknown as ConstructorParameters<
                typeof SpacesModule
            >[6],
            {} as ConstructorParameters<typeof SpacesModule>[7],
        );
        try {
            await writeOwnerState(database.context, { ownerUserId: "standalone" });
            const original: SpaceRecord = {
                id: "spaceaaaaaaaaaaaaaaaaaaa",
                ownerUserId: "standalone",
                role: "item",
                contents: [{ kind: "surface", surfaceId: surface.id, surfaceType: "reference" }],
                orderKey: "1",
                placement: "settled",
                visibility: "shown",
                version: 1,
                createdAt: 1,
                updatedAt: 1,
            };
            if (existing) await insertSpace(database.context, original);
            const hooks = spaces.beforeStart(database.context, primaryAgents());
            await hooks.afterStart?.(database.context, {} as never);
            const rows = await querySpaces(database.context, "standalone");
            expect(rows).toHaveLength(1);
            expect(rows[0]?.contents).toEqual(original.contents);
            if (existing) expect(rows[0]).toEqual(original);
        } finally {
            await spaces.close();
            database.close();
        }
    },
);
