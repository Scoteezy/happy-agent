import { join } from "node:path";

import { openHappyAgentDatabase } from "@slopus/happy-agent-modules";

/**
 * Record in a stopped daemon's main database that `module` applied one more migration, `key`,
 * after every migration it already has: what a newer Happy Agent release leaves behind when it
 * adds a migration. The migration itself is not run; only the ledger an older build reads at
 * startup is changed.
 */
export async function recordGymMigration(
    happyHome: string,
    migration: { readonly module: string; readonly key: string },
): Promise<void> {
    const opened = await openHappyAgentDatabase(join(happyHome, "agent", "agent.sqlite"));
    try {
        const module = quote(migration.module);
        await opened.database.run(
            `INSERT INTO happy_agent_migrations (module_key, migration_key, position)
             SELECT ${module}, ${quote(migration.key)}, COUNT(*)
             FROM happy_agent_migrations WHERE module_key = ${module}`,
        );
    } finally {
        await opened.close();
    }
}

/** A SQL string literal. */
function quote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}
