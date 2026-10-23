import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { AgentDatabaseConnection } from "./AgentDatabaseConnection.js";

export type AgentPGliteDatabase = PgliteDatabase;
export type OpenAgentPGliteDatabaseOptions = PGliteOptions & {
    readonly dataDir?: string;
};

/** Open one embedded PostgreSQL database with Agent Base's shared ownership contract. */
export async function openAgentPGliteDatabase(
    options: OpenAgentPGliteDatabaseOptions = {},
): Promise<AgentDatabaseConnection<AgentPGliteDatabase>> {
    // PGlite reads a non-string first argument as the options object, so passing an absent data
    // directory first silently discards every option. Pass one options object instead.
    const client = new PGlite(options);
    try {
        await client.waitReady;
        return new AgentDatabaseConnection(drizzle(client), async () => await client.close());
    } catch (error) {
        await client.close();
        throw error;
    }
}
