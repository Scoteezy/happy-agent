import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { afterEach, expect, it } from "vitest";
import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const cleanup: (() => void)[] = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((close) => close()),
);

async function fixture() {
    const durable = new DurableFunctionsModule();
    const surfaces = new SurfacesModule(
        durable,
        { enabled: false } as TeamModule,
        {} as BotsModule,
        {} as TasksModule,
        {} as ArtifactsModule,
        {} as ComputeModule,
        {} as ConfigModule,
        { enabled: false } as RunnersModule,
    );
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "surface-content");
    ensureAgentDatabaseConnection(db.database);
    cleanup.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    surfaces.beforeStart(db.context, {} as AgentSystemRef);
    return { surfaces, ctx: db.context, actor: { userId: null, agentId: null } };
}

it("counts completed todos as content but excludes deleted todos and empty lists", async () => {
    const { surfaces, ctx, actor } = await fixture();
    const list = await surfaces.create(ctx, { type: "todo", name: "Shopping" }, null);
    expect(await surfaces.hasContent(ctx, list.id)).toBe(false);
    let todo = await surfaces.createTodo(ctx, list.id, { text: "Milk" }, actor, null);
    expect(await surfaces.hasContent(ctx, list.id)).toBe(true);
    todo = await surfaces.mutateTodo(
        ctx,
        list.id,
        todo.id,
        todo.version,
        "update",
        { status: "completed" },
        actor,
    );
    expect(await surfaces.hasContent(ctx, list.id)).toBe(true);
    todo = await surfaces.mutateTodo(ctx, list.id, todo.id, todo.version, "delete", {}, actor);
    expect(await surfaces.hasContent(ctx, list.id)).toBe(false);
    await surfaces.mutateTodo(
        ctx,
        list.id,
        todo.id,
        todo.version,
        "update",
        { status: "active" },
        actor,
    );
    expect(await surfaces.hasContent(ctx, list.id)).toBe(true);
});

it("checks current document content after clearing and transaction rollback", async () => {
    const { surfaces, ctx, actor } = await fixture();
    const empty = await surfaces.create(
        ctx,
        { type: "document", name: "Empty", text: " \n" },
        null,
    );
    expect(await surfaces.hasContent(ctx, empty.id)).toBe(false);
    const notes = await surfaces.create(
        ctx,
        { type: "document", name: "Notes", text: "Hello" },
        null,
    );
    expect(await surfaces.hasContent(ctx, notes.id)).toBe(true);
    await expect(
        ctx.inTx(async (tx) => {
            const { document } = await surfaces.document(tx, notes.id);
            await surfaces.changeDocumentFromMarkdown(tx, notes.id, document.seq, "", actor);
            expect(await surfaces.hasContent(tx, notes.id)).toBe(false);
            throw new Error("rollback");
        }),
    ).rejects.toThrow("rollback");
    expect(await surfaces.hasContent(ctx, notes.id)).toBe(true);
    const { document } = await surfaces.document(ctx, notes.id);
    await surfaces.changeDocumentFromMarkdown(ctx, notes.id, document.seq, "", actor);
    expect(await surfaces.hasContent(ctx, notes.id)).toBe(false);
});

it("finds calendar content outside any displayed range and excludes deleted series", async () => {
    const { surfaces, ctx, actor } = await fixture();
    const calendar = await surfaces.create(ctx, { type: "calendar", name: "Calendar" }, null);
    expect(await surfaces.hasContent(ctx, calendar.id)).toBe(false);
    let event = await surfaces.createCalendarEvent(
        ctx,
        calendar.id,
        {
            title: "",
            timing: { kind: "allDay", startDate: "2040-01-01", endDate: "2040-01-02" },
        },
        actor,
        null,
    );
    expect(await surfaces.hasContent(ctx, calendar.id)).toBe(true);
    event = await surfaces.mutateCalendarEvent(
        ctx,
        calendar.id,
        event.id,
        event.version,
        "delete",
        actor,
    );
    expect(await surfaces.hasContent(ctx, calendar.id)).toBe(false);
    await surfaces.mutateCalendarEvent(
        ctx,
        calendar.id,
        event.id,
        event.version,
        { status: "active" },
        actor,
    );
    expect(await surfaces.hasContent(ctx, calendar.id)).toBe(true);
    const monitor = await surfaces.create(ctx, { type: "system_monitor", name: "Host" }, null);
    expect(await surfaces.hasContent(ctx, monitor.id)).toBe(false);
});
