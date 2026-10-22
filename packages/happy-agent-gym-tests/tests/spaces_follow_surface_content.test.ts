import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";

let gym: AgentGym | undefined;
afterEach(async () => {
    await gym?.dispose();
    gym = undefined;
});

it("shows only joined populated Surfaces and follows content changes without an open editor", async () => {
    gym = await createAgentGym({ timeoutMs: 15_000 });
    const client = gym.client;
    const todo = (await client.createSurface({ type: "todo", name: "Shopping" })).surface;
    const notes = (await client.createSurface({ type: "document", name: "Notes" })).surface;
    const calendar = (await client.createSurface({ type: "calendar", name: "Calendar" })).surface;
    const monitor = (await client.createSurface({ type: "system_monitor", name: "Host" })).surface;
    const targets = new Set([todo.id, notes.id, calendar.id, monitor.id]);
    type Row = { id: string; target: { kind: string; id: string } };
    const rows = async () =>
        (await gym!.http.ok<{ spaces: Row[] }>("GET", "/v0/spaces")).spaces.filter((row) =>
            targets.has(row.target.id),
        );
    const present = (id: string, expected: boolean) =>
        gym!.waitUntil(
            async () => {
                const found = (await rows()).find((row) => row.target.id === id);
                return expected ? found : found === undefined ? true : undefined;
            },
            `Surface ${id} ${expected ? "appears" : "leaves"}`,
        );
    expect(await rows()).toEqual([]);

    let milk = (await client.createTodo(todo.id, { text: "Milk" })).todo;
    await present(todo.id, true);
    milk = (
        await client.updateTodo(
            todo.id,
            milk.id,
            { status: "completed" },
            { ifMatch: milk.version },
        )
    ).todo;
    await present(todo.id, true);
    milk = (await client.deleteTodo(todo.id, milk.id, { ifMatch: milk.version })).todo;
    await present(todo.id, false);
    await client.updateTodo(todo.id, milk.id, { status: "active" }, { ifMatch: milk.version });
    await present(todo.id, true);
    await client.leaveSurface(todo.id);
    await present(todo.id, false);
    await client.joinSurface(todo.id);
    await present(todo.id, true);

    const event = (
        await client.createCalendarEvent(calendar.id, {
            title: "",
            timing: { kind: "allDay", startDate: "2040-01-01", endDate: "2040-01-02" },
        })
    ).event;
    await present(calendar.id, true);
    const deleted = (
        await client.deleteCalendarEvent(calendar.id, event.id, { ifMatch: event.version })
    ).event;
    await present(calendar.id, false);
    await client.updateCalendarEvent(
        calendar.id,
        event.id,
        { status: "active" },
        { ifMatch: deleted.version },
    );
    await present(calendar.id, true);

    // Transfer real editor state, then clear it, without subscribing any document stream.
    const donor = (
        await client.createSurface({ type: "document", name: "Source", text: "Shared notes" })
    ).surface;
    const state = await client.getSurfaceDocumentState(donor.id);
    await client.sendSurfaceDocumentUpdate(notes.id, { update: state.update, mutationId: "fill" });
    await present(notes.id, true);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(state.update, "base64"));
    const vector = Y.encodeStateVector(doc);
    const fragment = doc.getXmlFragment("document");
    fragment.delete(0, fragment.length);
    await client.sendSurfaceDocumentUpdate(notes.id, {
        update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
        mutationId: "clear",
    });
    doc.destroy();
    await present(notes.id, false);
    const before = (await rows()).map((row) => row.id).sort();
    await gym.restart();
    expect((await rows()).map((row) => row.id).sort()).toEqual(before);
    expect(
        (await rows()).every(
            (row) => row.target.kind === "surface" && row.target.id !== monitor.id,
        ),
    ).toBe(true);
}, 120_000);
