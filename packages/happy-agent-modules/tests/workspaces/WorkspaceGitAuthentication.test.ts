import { afterEach, expect, it } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations } from "../../sources/workspaces/index.js";
import { cleanupRoots, commitFile, createRepository, createRoot } from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

afterEach(cleanupRoots);

it("creates a workspace from an existing GitHub checkout without a stored credential", async () => {
    const repository = await createRepository();
    await commitFile(repository, "fixture.txt", "workspace fixture\n");
    const config = await testConfigRootedAt(await createRoot("workspace-auth-"));
    const catalog = workspacesCatalogFrom(config);
    const database = moduleDatabase(
        [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
        "workspace-auth",
    );
    await database.ready;
    const ctx = database.context;
    try {
        // Leave durable execution stopped to inspect the reservation boundary.
        catalog.durableFunctions.beforeStart(ctx);
        catalog.projects.beforeStart(ctx, catalog.agents.asRef());
        catalog.workspaces.beforeStart(ctx, catalog.agents.asRef());
        catalog.projects.open("test-instance");
        const project = await catalog.projects.create(ctx, {
            name: "GitHub project",
            repositoryRef: repository,
            remoteSource: { kind: "github", repository: "workspace-gym/fixture" },
            requiredSecretKind: "github",
        });
        await catalog.projects.markCloneReady(ctx, project.id);
        await catalog.projects.probe(ctx, project.id);
        await catalog.projects.markInitializationReady(ctx, project.id);
        await expect(
            catalog.workspaces.createWorkspace(ctx, project.id, { name: "child" }),
        ).resolves.toMatchObject({ projectRef: project.id, status: "initializing" });
    } finally {
        catalog.durableFunctions.stop();
        await catalog.workspaces.close(ctx);
        catalog.git.dispose();
        database.close();
    }
});
