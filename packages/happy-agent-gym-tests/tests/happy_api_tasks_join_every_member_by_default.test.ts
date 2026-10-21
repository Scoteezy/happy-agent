import type { HappyAgentClient } from "@slopus/happy-agent-client";
import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function joined(client: HappyAgentClient) {
    return (await client.listTasks({ scope: "joined" })).tasks.map((task) => task.id);
}

describe("default task participation", () => {
    it("joins other people's tasks, enrolls new members, and keeps membership events private", async () => {
        const { gym, alice, bob, aliceId, bobId, clientFor, onboard } = await surfaceTeamClients();
        running.add(gym);
        expect((await bob.getUserSetting("tasks.autoJoin")).setting.value).toBeNull();
        const before = (await bob.getEvents()).latestCursor;
        const first = (await alice.createTask({ name: "Shared work" })).task;
        const second = (await bob.createTask({ name: "More shared work" })).task;
        expect(await joined(alice)).toEqual([second.id, first.id]);
        expect(await joined(bob)).toEqual([second.id, first.id]);
        expect((await bob.getTask(first.id)).task).toMatchObject({
            ownerUserId: aliceId,
            canArchive: false,
        });
        const bootstrap = await bob.getDesktopBootstrap();
        expect(bootstrap.taskMemberships?.map((row) => row.taskId)).toEqual([second.id, first.id]);
        for (const [client, userId] of [
            [alice, aliceId],
            [bob, bobId],
        ] as const) {
            const events = (await client.getEvents({ after: before })).events.filter(
                (event) => event.type === "task.joined",
            );
            expect(events).toHaveLength(2);
            expect(
                (await client.getEvents({ after: before })).events
                    .filter((event) => event.type.startsWith("task."))
                    .map((event) => event.type),
            ).toEqual(["task.created", "task.joined", "task.created", "task.joined"]);
            expect(events.map((event) => event.payload)).toEqual([
                expect.objectContaining({
                    membership: expect.objectContaining({ taskId: first.id, userId }),
                }),
                expect.objectContaining({
                    membership: expect.objectContaining({ taskId: second.id, userId }),
                }),
            ]);
        }

        const charlie = clientFor("charlie");
        await expect(charlie.listTasks()).rejects.toMatchObject({ status: 401 });
        const archived = await alice.archiveTask(first.id, { ifMatch: first.version });
        await onboard(charlie, "Charlie");
        expect(await joined(charlie)).toEqual([second.id]);
        await alice.unarchiveTask(first.id, { ifMatch: archived.task.version });
        expect(await joined(charlie)).toEqual([first.id, second.id]);
        expect(gym.errors).toEqual([]);
    });

    it("persists opt-out, ignores stale changes, and catches up when the setting is cleared", async () => {
        const { gym, alice, bob, bobId } = await surfaceTeamClients();
        running.add(gym);
        const first = (await alice.createTask({ name: "Already joined" })).task;
        const disabled = (await bob.saveUserSetting("tasks.autoJoin", { value: false })).setting;
        const second = (await alice.createTask({ name: "While disabled" })).task;
        const third = (await alice.createTask({ name: "More while disabled" })).task;
        expect(await joined(bob)).toEqual([first.id]);
        const stale = await bob.saveUserSetting("tasks.autoJoin", {
            value: true,
            updatedAt: disabled.updatedAt! - 1,
        });
        expect(stale.setting).toEqual(disabled);
        expect(await joined(bob)).toEqual([first.id]);
        await gym.restart();
        expect((await bob.getUserSetting("tasks.autoJoin")).setting.value).toBe(false);
        expect(await joined(bob)).toEqual([first.id]);
        const before = (await alice.getEvents()).latestCursor;
        const original = (await bob.getTask(first.id)).membership;
        await bob.saveUserSetting("tasks.autoJoin", { value: null });
        expect(await joined(bob)).toEqual([third.id, second.id, first.id]);
        expect((await bob.getTask(first.id)).membership).toEqual(original);
        await bob.saveUserSetting("tasks.autoJoin", { value: false });
        const own = (await bob.createTask({ name: "My own task" })).task;
        expect(await joined(bob)).toContain(own.id);

        const aliceEvents = (await alice.getEvents({ after: before })).events;
        expect(aliceEvents.some((event) => event.type === "user_settings.updated")).toBe(false);
        const bobEvents = (await bob.getEvents({ after: before })).events;
        expect(bobEvents.filter((event) => event.type === "user_settings.updated")).toHaveLength(2);
        expect(
            bobEvents.filter((event) => event.type === "task.joined").map((event) => event.payload),
        ).toEqual([
            expect.objectContaining({
                membership: expect.objectContaining({ taskId: second.id, userId: bobId }),
            }),
            expect.objectContaining({
                membership: expect.objectContaining({ taskId: third.id, userId: bobId }),
            }),
            expect.objectContaining({
                membership: expect.objectContaining({ taskId: own.id, userId: bobId }),
            }),
        ]);
        expect(gym.errors).toEqual([]);
    });

    it("remembers explicit leaves across restarts and preference changes until a manual join", async () => {
        const { gym, alice, bob } = await surfaceTeamClients();
        running.add(gym);
        const first = (await alice.createTask({ name: "Close this task" })).task;
        await bob.leaveTask(first.id);
        await bob.saveUserSetting("tasks.autoJoin", { value: false });
        const second = (await alice.createTask({ name: "Never joined" })).task;
        const before = (await bob.getEvents()).latestCursor;
        await bob.leaveTask(second.id);
        expect(
            (await bob.getEvents({ after: before })).events.some(
                (event) => event.type === "task.left",
            ),
        ).toBe(false);
        await bob.saveUserSetting("tasks.autoJoin", { value: true });
        expect(await joined(bob)).toEqual([]);
        await gym.restart();
        expect(await joined(bob)).toEqual([]);
        await bob.saveUserSetting("tasks.autoJoin", { value: null });
        expect(await joined(bob)).toEqual([]);
        const membership = (await bob.joinTask(first.id)).membership;
        await gym.restart();
        expect(await joined(bob)).toEqual([first.id]);
        expect((await bob.getTask(first.id)).membership).toEqual(membership);
        const archived = await alice.archiveTask(second.id, { ifMatch: second.version });
        await alice.unarchiveTask(second.id, { ifMatch: archived.task.version });
        expect(await joined(bob)).toEqual([first.id]);
        expect(gym.errors).toEqual([]);
    });

    it("serializes a concurrent opt-out and task creation without duplicate memberships", async () => {
        const { gym, alice, bob } = await surfaceTeamClients();
        running.add(gym);
        const [, created] = await Promise.all([
            bob.saveUserSetting("tasks.autoJoin", { value: false }),
            alice.createTask({ name: "Concurrent work" }),
        ]);
        // Either transaction may win. Disabling preserves a join that committed first.
        const afterRace = await joined(bob);
        expect(afterRace.length).toBeLessThanOrEqual(1);
        expect(afterRace.every((id) => id === created.task.id)).toBe(true);
        const later = (await alice.createTask({ name: "After opt-out" })).task;
        expect(await joined(bob)).not.toContain(later.id);
        await Promise.all([
            bob.saveUserSetting("tasks.autoJoin", { value: true }),
            bob.saveUserSetting("tasks.autoJoin", { value: true }),
        ]);
        expect(await joined(bob)).toEqual([later.id, created.task.id]);
        const memberships = (await bob.listTasks()).memberships;
        expect(new Set(memberships.map((row) => row.taskId)).size).toBe(2);
        expect(gym.errors).toEqual([]);
    });
});
