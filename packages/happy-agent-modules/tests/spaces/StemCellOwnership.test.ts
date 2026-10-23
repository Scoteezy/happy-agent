import { expect, it } from "vitest";
import { SpacesModule, spaceMigrations, SpaceNotFoundError } from "../../sources/spaces/index.js";
import {
    insertSpace,
    writeOwnerState,
} from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

it("rejects another owner's existing stem-cell ID inside the creation transaction", async () => {
    const database = moduleDatabase(spaceMigrations, "stem-cell-ownership");
    await database.ready;
    try {
        await writeOwnerState(database.context, { ownerUserId: "owneraaaaaaaaaaaaaaaaaaa" });
        await writeOwnerState(database.context, { ownerUserId: "ownerbbbbbbbbbbbbbbbbbbb" });
        await insertSpace(database.context, {
            id: "spaceaaaaaaaaaaaaaaaaaaa",
            ownerUserId: "owneraaaaaaaaaaaaaaaaaaa",
            role: "item",
            contents: [
                {
                    kind: "task",
                    taskId: "taskaaaaaaaaaaaaaaaaaaaa",
                    agentId: "agentaaaaaaaaaaaaaaaaaaa",
                },
            ],
            orderKey: "1",
            placement: "pending",
            visibility: "shown",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        });
        const spaces = new SpacesModule(
            {} as ConstructorParameters<typeof SpacesModule>[0],
            {} as ConstructorParameters<typeof SpacesModule>[1],
            { chiefOfStaff: async () => undefined } as unknown as ConstructorParameters<
                typeof SpacesModule
            >[2],
            {} as ConstructorParameters<typeof SpacesModule>[3],
            {} as ConstructorParameters<typeof SpacesModule>[4],
            {} as ConstructorParameters<typeof SpacesModule>[5],
            { register: () => undefined } as unknown as ConstructorParameters<
                typeof SpacesModule
            >[6],
            {} as ConstructorParameters<typeof SpacesModule>[7],
            {} as ConstructorParameters<typeof SpacesModule>[8],
            { get: async () => ({ value: null }) } as unknown as ConstructorParameters<
                typeof SpacesModule
            >[9],
            {} as ConstructorParameters<typeof SpacesModule>[10],
        );
        await expect(
            spaces.createStemCell(database.context, "ownerbbbbbbbbbbbbbbbbbbb", {
                spaceId: "spaceaaaaaaaaaaaaaaaaaaa",
                task: {
                    id: "taskbbbbbbbbbbbbbbbbbbbb",
                    agentId: "agentbbbbbbbbbbbbbbbbbbb",
                } as Parameters<SpacesModule["createStemCell"]>[2]["task"],
            }),
        ).rejects.toBeInstanceOf(SpaceNotFoundError);
    } finally {
        database.close();
    }
});
