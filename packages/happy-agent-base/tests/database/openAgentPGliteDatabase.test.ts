import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { agentDatabaseRows, openAgentPGliteDatabase } from "../../sources/index.js";

it("opens PGlite with the options it was given when no data directory is named", async () => {
    // PGlite took a missing data directory in first position as its options, dropping these.
    const source = new PGlite();
    let dump: Blob;
    try {
        await source.exec("CREATE TABLE carried (value TEXT NOT NULL)");
        await source.exec("INSERT INTO carried (value) VALUES ('from the loaded data')");
        dump = await source.dumpDataDir("none");
    } finally {
        await source.close();
    }

    const opened = await openAgentPGliteDatabase({ loadDataDir: dump });
    try {
        await expect(
            agentDatabaseRows<{ value: string }>(opened.database, sql`SELECT value FROM carried`),
        ).resolves.toEqual([{ value: "from the loaded data" }]);
    } finally {
        await opened.close();
    }
}, 30_000);
