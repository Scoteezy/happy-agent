/** One applied migration, named by the module that owns it. */
export interface AgentStorageMigrationKey {
    readonly module: string;
    readonly key: string;
}

/**
 * The store holds migrations this build does not know: a newer build wrote it. Nothing was
 * migrated, and opening the store would read data whose meaning this build cannot know, so the
 * owner must refuse it rather than retry.
 *
 * Only a module this build knows can make the store newer. Migrations of a module it does not
 * have are additive data it never reads, so they are ignored.
 */
export class AgentStorageNewerDataError extends Error {
    /** The applied migrations this build does not know, in each module's order. */
    readonly unknownMigrations: readonly AgentStorageMigrationKey[];

    constructor(unknownMigrations: readonly AgentStorageMigrationKey[]) {
        const modules = [...new Set(unknownMigrations.map(({ module }) => `"${module}"`))];
        super(
            `The agent store was written by a newer build: module ${modules.join(", ")} has migrations this build does not know.`,
        );
        this.name = "AgentStorageNewerDataError";
        this.unknownMigrations = unknownMigrations;
    }
}
