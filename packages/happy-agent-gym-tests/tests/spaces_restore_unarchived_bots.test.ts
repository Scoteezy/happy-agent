import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("restores one pending row when a bot is unarchived after the sidebar was seeded", async () => {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Helper" })).bot;
    const rows = async () =>
        (
            await gym.http.ok<{
                spaces: {
                    id: string;
                    target: { id: string };
                    placement: string;
                    visibility: string;
                }[];
            }>("GET", "/v0/spaces")
        ).spaces;
    const original = (await rows()).find((space) => space.target.id === bot.id)!;
    await gym.client.archiveBot(bot.id, { ifMatch: bot.version });
    await gym.waitUntil(
        async () => ((await rows()).some((space) => space.target.id === bot.id) ? undefined : true),
        "the archived bot to leave",
    );
    const archived = (await gym.client.getBot(bot.id)).bot;
    await gym.client.unarchiveBot(bot.id, { ifMatch: archived.version });
    const restored = await gym.waitUntil(
        async () => (await rows()).find((space) => space.target.id === bot.id),
        "the restored bot's row",
    );
    expect(restored).toMatchObject({ placement: "pending", visibility: "shown" });
    expect(restored.id).not.toBe(original.id);
    expect((await rows()).filter((space) => space.target.id === bot.id)).toHaveLength(1);
}, 120_000);

it("restores a separate pending bot row for every seeded team owner", async () => {
    const {
        gym,
        alice,
        aliceHttp: owner,
        bobHttp: member,
    } = await surfaceTeamClients({ timeoutMs: 15_000 });
    running.add(gym);
    await Promise.all([owner.ok("GET", "/v0/spaces"), member.ok("GET", "/v0/spaces")]);
    const bot = (await alice.createBot({ name: "Team helper" })).bot;
    const rowsFor = async (http: typeof owner) =>
        (
            await http.ok<{
                spaces: {
                    id: string;
                    target: { id: string };
                    placement: string;
                    visibility: string;
                }[];
            }>("GET", "/v0/spaces")
        ).spaces.filter((row) => row.target.id === bot.id);
    await gym.waitUntil(
        async () =>
            (await rowsFor(owner)).length === 1 && (await rowsFor(member)).length === 1
                ? true
                : undefined,
        "both owners' bot rows",
    );
    await alice.archiveBot(bot.id, { ifMatch: bot.version });
    await gym.waitUntil(
        async () =>
            (await rowsFor(owner)).length === 0 && (await rowsFor(member)).length === 0
                ? true
                : undefined,
        "both archived bot rows to leave",
    );
    const archived = (await alice.getBot(bot.id)).bot;
    await alice.unarchiveBot(bot.id, { ifMatch: archived.version });
    await gym.waitUntil(
        async () =>
            (await rowsFor(owner)).length === 1 && (await rowsFor(member)).length === 1
                ? true
                : undefined,
        "both restored bot rows",
    );
    const [a, b] = [(await rowsFor(owner))[0]!, (await rowsFor(member))[0]!];
    expect(a).toMatchObject({ placement: "pending", visibility: "shown" });
    expect(b).toMatchObject({ placement: "pending", visibility: "shown" });
    expect(a.id).not.toBe(b.id);
}, 120_000);
