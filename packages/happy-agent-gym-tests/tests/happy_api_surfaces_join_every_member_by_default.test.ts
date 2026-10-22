import type { HappyAgentClient } from "@slopus/happy-agent-client";
import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function joined(client: HappyAgentClient, userId: string) {
    return (await client.listSurfaces()).surfaces
        .flatMap((surface) =>
            surface.members
                .filter((member) => member.userId === userId)
                .map((member) => ({ id: surface.id, key: member.orderKey })),
        )
        .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
        .map((row) => row.id);
}

describe("default Surface participation", () => {
    it("joins an unavailable reference without joining its target or granting archive rights", async () => {
        const { gym, alice, bob, bobId } = await surfaceTeamClients();
        running.add(gym);
        expect((await bob.getHealth()).version.protocol).toBeGreaterThanOrEqual(31);
        await bob.saveUserSetting("tasks.autoJoin", { value: false });
        await bob.saveUserSetting("surfaces.autoJoin", { value: false });
        const task = (await alice.createTask({ name: "Referenced work" })).task;
        const reference = (
            await alice.createSurface({ type: "task", name: "Work link", taskId: task.id })
        ).surface;
        const archived = (await alice.archiveTask(task.id, { ifMatch: task.version })).task;
        await bob.saveUserSetting("surfaces.autoJoin", { value: true });
        expect(await joined(bob, bobId)).toEqual([reference.id]);
        expect((await bob.listSurfaces()).surfaces[0]?.target).toEqual({
            type: "task",
            state: "unavailable",
        });
        expect(await bob.getTask(task.id)).toMatchObject({
            task: { status: "archived", canArchive: false },
            membership: null,
        });
        await expect(
            bob.unarchiveTask(task.id, { ifMatch: archived.version }),
        ).rejects.toMatchObject({ status: 403 });
        await alice.unarchiveTask(task.id, { ifMatch: archived.version });
        expect((await bob.listSurfaces()).surfaces[0]?.target).toMatchObject({
            type: "task",
            state: "available",
            taskId: task.id,
        });
        expect((await bob.getTask(task.id)).membership).toBeNull();
        expect(await joined(bob, bobId)).toEqual([reference.id]);
        expect(gym.errors).toEqual([]);
    });
    it("joins new and existing Surfaces, returns final memberships, and orders shared version events", async () => {
        const { gym, alice, bob, aliceId, bobId, clientFor, onboard } = await surfaceTeamClients();
        running.add(gym);
        await bob.saveUserSetting("tasks.autoJoin", { value: false });
        expect((await bob.getUserSetting("surfaces.autoJoin")).setting.value).toBeNull();
        const before = (await alice.getEvents()).latestCursor;
        const first = (
            await alice.createSurface({ type: "todo", name: "Shared work", mutationId: "create" })
        ).surface;
        expect(first.members.map((member) => member.userId).sort()).toEqual(
            [aliceId, bobId].sort(),
        );
        expect((await bob.listSurfaces()).surfaces).toEqual([first]);
        const second = (await bob.createSurface({ type: "calendar", name: "Team calendar" }))
            .surface;
        expect(await joined(alice, aliceId)).toEqual([first.id, second.id]);
        expect(await joined(bob, bobId)).toEqual([first.id, second.id]);
        expect((await bob.getDesktopBootstrap()).surfaces).toEqual(
            (await alice.listSurfaces()).surfaces,
        );
        await gym.waitUntil(async () => {
            const events = (await alice.getEvents({ after: before })).events.filter((event) =>
                event.type.startsWith("surface."),
            );
            return events.length === 4 ? events : undefined;
        }, "creation and derived membership events");
        for (const client of [alice, bob]) {
            const events = (await client.getEvents({ after: before })).events.filter((event) =>
                event.type.startsWith("surface."),
            );
            expect(events.map((event) => event.type)).toEqual([
                "surface.created",
                "surface.updated",
                "surface.created",
                "surface.updated",
            ]);
            const created = events[0]!;
            const updated = events[1]!;
            if (created.type !== "surface.created" || updated.type !== "surface.updated")
                throw new Error("Unexpected events");
            expect(created.payload).toMatchObject({
                mutationId: "create",
                surface: { id: first.id, members: [{ userId: aliceId }] },
            });
            expect(updated.payload).toMatchObject({
                previousVersion: created.payload.surface.version,
                version: first.version,
                changes: { members: first.members },
            });
        }
        const charlie = clientFor("charlie");
        await expect(charlie.listSurfaces()).rejects.toMatchObject({ status: 401 });
        const charlieId = await onboard(charlie, "Charlie");
        expect(new Set(await joined(charlie, charlieId))).toEqual(new Set([first.id, second.id]));
        expect(gym.errors).toEqual([]);
    });

    it("keeps opt-out separate from tasks, ignores stale writes, and catches up without moving existing memberships", async () => {
        const { gym, alice, bob, bobId } = await surfaceTeamClients();
        running.add(gym);
        const first = (await alice.createSurface({ type: "todo", name: "Joined" })).surface;
        const original = first.members.find((member) => member.userId === bobId);
        const disabled = (await bob.saveUserSetting("surfaces.autoJoin", { value: false })).setting;
        const second = (await alice.createSurface({ type: "document", name: "While disabled" }))
            .surface;
        expect(await joined(bob, bobId)).toEqual([first.id]);
        expect(
            (
                await bob.saveUserSetting("surfaces.autoJoin", {
                    value: true,
                    updatedAt: disabled.updatedAt! - 1,
                })
            ).setting,
        ).toEqual(disabled);
        const task = (await alice.createTask({ name: "Independent task" })).task;
        expect((await bob.getTask(task.id)).membership).not.toBeNull();
        await gym.restart();
        expect((await bob.getUserSetting("surfaces.autoJoin")).setting.value).toBe(false);
        expect(await joined(bob, bobId)).toEqual([first.id]);
        const before = (await bob.getEvents()).latestCursor;
        await bob.saveUserSetting("surfaces.autoJoin", { value: null });
        expect(await joined(bob, bobId)).toEqual([first.id, second.id]);
        expect(
            (await bob.listSurfaces()).surfaces
                .find((surface) => surface.id === first.id)
                ?.members.find((member) => member.userId === bobId),
        ).toEqual(original);
        await gym.waitUntil(async () => {
            const events = (await bob.getEvents({ after: before })).events.filter(
                (event) =>
                    event.type === "user_settings.updated" || event.type === "surface.updated",
            );
            return events.length === 2 ? events : undefined;
        }, "setting before derived Surface membership");
        expect(
            (await bob.getEvents({ after: before })).events
                .filter(
                    (event) =>
                        event.type === "user_settings.updated" || event.type === "surface.updated",
                )
                .map((event) => event.type),
        ).toEqual(["user_settings.updated", "surface.updated"]);
        expect(
            (await alice.getEvents({ after: before })).events.some(
                (event) => event.type === "user_settings.updated",
            ),
        ).toBe(false);
        await bob.saveUserSetting("surfaces.autoJoin", { value: false });
        const own = (await bob.createSurface({ type: "todo", name: "Own creation" })).surface;
        expect(await joined(bob, bobId)).toContain(own.id);
        expect(gym.errors).toEqual([]);
    });

    it("remembers absent and joined leaves through toggles and restart until explicit rejoin", async () => {
        const { gym, alice, bob, bobId } = await surfaceTeamClients();
        running.add(gym);
        const first = (await alice.createSurface({ type: "todo", name: "Leave" })).surface;
        await bob.leaveSurface(first.id);
        await bob.saveUserSetting("surfaces.autoJoin", { value: false });
        const second = (await alice.createSurface({ type: "todo", name: "Never joined" })).surface;
        expect((await bob.leaveSurface(second.id)).surface).toEqual(second);
        await bob.saveUserSetting("surfaces.autoJoin", { value: true });
        expect(await joined(bob, bobId)).toEqual([]);
        await gym.restart();
        expect(await joined(bob, bobId)).toEqual([]);
        await bob.saveUserSetting("surfaces.autoJoin", { value: "enabled" });
        expect(await joined(bob, bobId)).toEqual([]);
        const rejoined = (await bob.joinSurface(first.id)).surface;
        expect(await joined(bob, bobId)).toEqual([first.id]);
        expect((await bob.joinSurface(first.id)).surface).toEqual(rejoined);
        await gym.restart();
        expect(await joined(bob, bobId)).toEqual([first.id]);
        expect(
            (await bob.listSurfaces()).surfaces.find((surface) => surface.id === first.id),
        ).toEqual(rejoined);
        expect(
            (await bob.createSurface({ id: second.id, type: "todo", name: "Retry" })).surface,
        ).toEqual(second);
        expect(gym.errors).toEqual([]);
    });

    it("serializes concurrent opt-out and creation and catches up once under repeated enabling", async () => {
        const { gym, alice, bob, bobId } = await surfaceTeamClients();
        running.add(gym);
        const [, created] = await Promise.all([
            bob.saveUserSetting("surfaces.autoJoin", { value: false }),
            alice.createSurface({ type: "todo", name: "Concurrent" }),
        ]);
        const ids = await joined(bob, bobId);
        expect(ids.length).toBeLessThanOrEqual(1);
        expect(ids.every((id) => id === created.surface.id)).toBe(true);
        const later = (await alice.createSurface({ type: "todo", name: "After opt-out" })).surface;
        expect(await joined(bob, bobId)).not.toContain(later.id);
        await Promise.all([
            bob.saveUserSetting("surfaces.autoJoin", { value: true }),
            bob.saveUserSetting("surfaces.autoJoin", { value: true }),
        ]);
        expect(new Set(await joined(bob, bobId))).toEqual(new Set([created.surface.id, later.id]));
        for (const surface of (await bob.listSurfaces()).surfaces)
            expect(surface.members.filter((member) => member.userId === bobId)).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });
});
