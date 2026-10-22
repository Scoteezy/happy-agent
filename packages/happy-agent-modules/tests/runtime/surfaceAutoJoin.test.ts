import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, agentDatabaseRun, withAgentDatabase } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "sj-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const configDirectory = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
    );
    await mkdir(configDirectory, { recursive: true });
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(
        join(configDirectory, "happy.toml"),
        `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "alice"
[feature.team.jwt]
name = "Test sign-in"
authorization_url = "https://surface.test/authorize"
token_url = "https://surface.test/token"
client_id = "surfaces"
issuer = "https://surface.test"
audience = "surfaces"
algorithms = ["EdDSA"]
public_key = """
${pem}"""
`,
    );
    let runtime: HappyAgentRuntime | undefined;
    const start = async () => {
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        runtime = await startHappyAgentRuntime({
            happyHome: join(root, ".happy"),
            inference: {
                providers,
                models: [
                    {
                        id: "gym/model",
                        providerId: "gym",
                        name: "Gym",
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                    },
                ],
            },
        });
        const ctx = withAgentDatabase(runtime.ctx.named("test.surface-autojoin"), runtime.database);
        return { runtime, ctx };
    };
    cleanups.push(async () => {
        await runtime?.close();
    });
    return {
        ...(await start()),
        restart: async () => {
            await runtime?.close();
            return start();
        },
    };
}

describe("Surface autojoin transactions and recovery", () => {
    it("rolls participation back with preferences, creation, and enrollment, excluding guests", async () => {
        const { runtime, ctx } = await fixture();
        const { team, surfaces, userSettings } = runtime.modules;
        const alice = await team.createUser(ctx, {
            authentication: "jwt",
            subject: "alice",
            firstName: "Alice",
        });
        const guest = await team.createGuest(ctx, { name: "Exported bot guest" });
        const aliceCtx = team.connectionContext(ctx, alice);
        const events: unknown[] = [];
        const stop = surfaces.onEvent((_ctx, event) => {
            events.push(event);
        });
        const first = await surfaces.create(ctx, { type: "todo", name: "Shared" }, null);
        expect(first.members.map((member) => member.userId)).toEqual([alice.id]);
        expect(first.members.some((member) => member.userId === guest.id)).toBe(false);
        await expect(surfaces.joinAutomatically(ctx, guest.id)).rejects.toMatchObject({
            code: "not_found",
        });
        await userSettings.save(aliceCtx, "surfaces.autoJoin", { value: false });
        const second = await surfaces.create(ctx, { type: "todo", name: "Opted out" }, null);
        try {
            await vi.waitFor(() => expect(events).toHaveLength(3));
            events.length = 0;
            await expect(
                aliceCtx.inTx(async (tx) => {
                    await userSettings.save(tx, "surfaces.autoJoin", { value: true });
                    expect(
                        (await surfaces.list(tx)).find((surface) => surface.id === second.id)
                            ?.members,
                    ).toHaveLength(1);
                    throw new Error("Rollback setting");
                }),
            ).rejects.toThrow("Rollback setting");
            expect((await userSettings.get(aliceCtx, "surfaces.autoJoin")).value).toBe(false);
            expect((await surfaces.list(ctx)).find((surface) => surface.id === second.id)).toEqual(
                second,
            );
            await userSettings.save(aliceCtx, "surfaces.autoJoin", { value: true });
            await vi.waitFor(() => expect(events).toHaveLength(1));
            events.length = 0;
            const reject = surfaces.onEventTransactional((_ctx, event) => {
                if (event.type === "surface.created") throw new Error("Rollback creation");
            });
            try {
                await expect(
                    surfaces.create(ctx, { type: "todo", name: "Rollback" }, null),
                ).rejects.toThrow("Rollback creation");
            } finally {
                reject();
            }
            expect(await surfaces.list(ctx)).toHaveLength(2);
            let rolledBackId = "";
            await expect(
                ctx.inTx(async (tx) => {
                    const user = await team.createUser(tx, {
                        authentication: "jwt",
                        subject: "rollback",
                        firstName: "Rolled back",
                    });
                    rolledBackId = user.id;
                    expect(
                        (await surfaces.list(tx)).every((surface) =>
                            surface.members.some((member) => member.userId === user.id),
                        ),
                    ).toBe(true);
                    throw new Error("Rollback enrollment");
                }),
            ).rejects.toThrow("Rollback enrollment");
            expect(await team.getUser(ctx, rolledBackId)).toBeUndefined();
            expect(
                (await surfaces.list(ctx)).every((surface) =>
                    surface.members.every((member) => member.userId !== rolledBackId),
                ),
            ).toBe(true);
            // A committed update is a barrier behind any erroneously retained durable events.
            await surfaces.update(ctx, first.id, { name: "Barrier" });
            await vi.waitFor(() => expect(events).toHaveLength(1));
            expect(events).toMatchObject([
                { type: "surface.updated", payload: { changes: { name: "Barrier" } } },
            ]);
        } finally {
            stop();
        }
    }, 60_000);

    it("catches up more than one batch of old missing memberships on every startup without touching withdrawn heads or explicit leaves", async () => {
        let { runtime, ctx, restart } = await fixture();
        const alice = await runtime.modules.team.createUser(ctx, {
            authentication: "jwt",
            subject: "alice",
            firstName: "Alice",
        });
        const aliceCtx = runtime.modules.team.connectionContext(ctx, alice);
        await runtime.modules.userSettings.save(aliceCtx, "surfaces.autoJoin", { value: false });
        const surfaces = await ctx.inTx(async (tx) => {
            const created = [];
            for (let index = 0; index < 102; index++)
                created.push(
                    await runtime.modules.surfaces.create(
                        tx,
                        { type: "todo", name: `Existing ${index}` },
                        null,
                    ),
                );
            return created;
        });
        const left = surfaces[0]!;
        await runtime.modules.surfaces.changeMember(ctx, left.id, alice.id, "leave");
        const withdrawn = { ...surfaces[1]!, id: "s12345678901234567890123", type: "separator" };
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surfaces(key,value_json) VALUES (${`surface.${withdrawn.id}`},${JSON.stringify(withdrawn)})`,
        );
        // A cleared/missing setting in the previous daemon leaves memberships for startup to fill.
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM happy_agent_user_settings WHERE owner_id = ${alice.id} AND setting_key = 'surfaces.autoJoin'`,
        );
        ({ runtime, ctx } = await restart());
        await vi.waitFor(
            async () =>
                expect(
                    (await runtime.modules.surfaces.list(ctx)).filter((surface) =>
                        surface.members.some((member) => member.userId === alice.id),
                    ),
                ).toHaveLength(101),
            { timeout: 20_000 },
        );
        expect(
            (await runtime.modules.surfaces.list(ctx)).find((surface) => surface.id === left.id)
                ?.members,
        ).toEqual([]);
        const target = surfaces[1]!;
        // Simulate another membership missing in a previously stored catalog; startup runs every time.
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE happy_agent_surfaces SET value_json = ${JSON.stringify(target)} WHERE key = ${`surface.${target.id}`}`,
        );
        ({ runtime, ctx } = await restart());
        await vi.waitFor(async () =>
            expect(
                (await runtime.modules.surfaces.list(ctx)).find(
                    (surface) => surface.id === target.id,
                )?.members,
            ).toHaveLength(1),
        );
        expect(
            (await runtime.modules.surfaces.list(ctx)).find((surface) => surface.id === left.id)
                ?.members,
        ).toEqual([]);
        const { SurfacesPersistence } =
            await import("../../sources/surfaces/persistence/SurfacesPersistence.js");
        expect(
            await new SurfacesPersistence(runtime.database)
                .kv()
                .read(ctx, `surface.${withdrawn.id}`),
        ).toEqual(withdrawn);
    }, 60_000);
});
