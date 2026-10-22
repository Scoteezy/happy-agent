import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { createSqliteDurableFunctionsStorage } from "../../sources/durableFunctions/SqliteDurableFunctionsStorage.js";
import { SurfacesModule, type SurfaceEvent } from "../../sources/surfaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    deferred,
    durableFunctionsHarness,
    pendingCallCount,
    waitForCondition,
} from "./support/durableFunctionsHarness.js";

const ids = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock("@paralleldrive/cuid2", async (original) => {
    const actual = await original<typeof import("@paralleldrive/cuid2")>();
    return { ...actual, createId: () => ids.next.shift() ?? actual.createId() };
});
afterEach(() => {
    vi.restoreAllMocks();
    ids.next = [];
});

describe("durable notification insertion order", () => {
    it("keeps insertion metadata out of invocation, execution, and completion envelopes", async () => {
        let executionKeys: string[] = [];
        let completionKeys: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "notify",
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (_ctx, call) => {
                executionKeys = Object.keys(call).sort();
                return null;
            },
            onSuccess: async (_ctx, call) => {
                completionKeys = Object.keys(call).sort();
            },
        });
        const harness = await durableFunctionsHarness("notification-envelope", { module });
        try {
            const result = await module.invoke(harness.database.context, {
                function: "notify",
                arguments: null,
            });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
            expect(Object.keys(result).sort()).toEqual(["callId", "status"]);
            expect(executionKeys).toEqual(["arguments", "callId", "kv", "operationId"]);
            expect(completionKeys).toEqual(["arguments", "callId", "operationId", "result"]);
        } finally {
            harness.close();
        }
    });

    it("skips dispatch when the creating transaction already cancelled its call", async () => {
        const executor = vi.fn(async () => null);
        const module = new DurableFunctionsModule();
        module.register({
            name: "notify",
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor,
        });
        const harness = await durableFunctionsHarness("notification-cancel-before-dispatch", {
            module,
        });
        try {
            await harness.database.context.inTx(async (ctx) => {
                await module.invoke(ctx, {
                    function: "notify",
                    operationId: "cancelled",
                    arguments: null,
                });
                expect(await module.cancel(ctx, "cancelled")).toBe(true);
            });
            expect(await pendingCallCount(harness.database.context)).toBe(0);
            expect(executor).not.toHaveBeenCalled();
        } finally {
            harness.close();
        }
    });

    it("keeps blocked same-millisecond calls in insertion order despite reverse IDs", async () => {
        const gate = deferred();
        const started: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "notify",
            argumentsSchema: Type.String(),
            resultSchema: Type.Null(),
            executor: async (_ctx, call) => {
                started.push(call.arguments);
                if (call.arguments === "holder") await gate.promise;
                return null;
            },
        });
        const harness = await durableFunctionsHarness("notification-order", { module });
        try {
            ids.next = ["zholder", "zcreated", "aupdated"];
            const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
            await module.invoke(harness.database.context, {
                function: "notify",
                arguments: "holder",
                lockKeys: ["surface"],
            });
            await harness.database.context.inTx(async (ctx) => {
                await module.invoke(ctx, {
                    function: "notify",
                    arguments: "created",
                    lockKeys: ["surface"],
                });
                await module.invoke(ctx, {
                    function: "notify",
                    arguments: "updated",
                    lockKeys: ["surface"],
                });
            });
            clock.mockRestore();
            gate.resolve();
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
            expect(started).toEqual(["holder", "created", "updated"]);
        } finally {
            gate.resolve();
            harness.close();
        }
    });

    it("recovers same-millisecond calls in insertion order despite reverse IDs", async () => {
        const started: string[] = [];
        const first = new DurableFunctionsModule();
        first.register({
            name: "notify",
            argumentsSchema: Type.String(),
            resultSchema: Type.Null(),
            executor: async () => null,
        });
        const harness = await durableFunctionsHarness("recovered-notification-order", {
            module: first,
            start: false,
        });
        let recovered: DurableFunctionsModule | undefined;
        try {
            ids.next = ["zcreated", "aupdated"];
            const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
            await harness.database.context.inTx(async (ctx) => {
                for (const label of ["created", "updated"])
                    await first.invoke(ctx, {
                        function: "notify",
                        arguments: label,
                        lockKeys: ["surface"],
                    });
            });
            clock.mockRestore();
            first.stop();
            recovered = new DurableFunctionsModule();
            recovered.register({
                name: "notify",
                argumentsSchema: Type.String(),
                resultSchema: Type.Null(),
                executor: async (_ctx, call) => {
                    started.push(call.arguments);
                    return null;
                },
            });
            await durableFunctionsHarness("notification-restart", {
                module: recovered,
                database: harness.database,
            });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
            expect(started).toEqual(["created", "updated"]);
        } finally {
            recovered?.stop();
            harness.close();
        }
    });

    it("keeps recovery's insertion cursor after deleting an incompatible last row of a full page", async () => {
        const module = new DurableFunctionsModule();
        const started: string[] = [];
        module.register({
            name: "notify",
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (_ctx, call) => {
                started.push(call.callId);
                return null;
            },
        });
        const harness = await durableFunctionsHarness("notification-page-boundary", {
            module,
            start: false,
        });
        try {
            const store = createSqliteDurableFunctionsStorage();
            const expected: string[] = [];
            await harness.database.context.inTx(async (ctx) => {
                for (let index = 0; index < 1_001; index++) {
                    const id = `z${String(1_001 - index).padStart(4, "0")}`;
                    const stale = index === 999;
                    if (!stale) expected.push(id);
                    await store.createCall(ctx, {
                        id,
                        function: stale ? "removed" : "notify",
                        arguments: null,
                        lockKeys: ["surface"],
                        createdAt: 1_000,
                    });
                }
            });
            await harness.start();
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
            expect(started).toEqual(expected);
        } finally {
            harness.close();
        }
    });

    it("delivers a Surface creation before its derived member version when notifications are blocked", async () => {
        const gate = deferred();
        const durable = new DurableFunctionsModule();
        durable.register({
            name: "holder",
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async () => {
                await gate.promise;
                return null;
            },
        });
        const surfaces = new SurfacesModule(
            durable,
            {
                enabled: true,
                getUser: async (_ctx: unknown, id: string) => ({ id, authentication: "jwt" }),
            } as unknown as TeamModule,
            {} as BotsModule,
            {} as TasksModule,
            {} as ArtifactsModule,
            {} as ComputeModule,
            {} as ConfigModule,
            {} as RunnersModule,
        );
        const db = moduleDatabase(
            [...durable.migrations, ...surfaces.migrations],
            "surface-notification-order",
        );
        ensureAgentDatabaseConnection(db.database);
        await db.ready;
        surfaces.beforeStart(db.context, {} as AgentSystemRef);
        const hooks = durable.beforeStart(db.context);
        const events: SurfaceEvent[] = [];
        surfaces.onEvent((_ctx, event) => {
            events.push(event);
        });
        surfaces.onEventTransactional(async (ctx, event) => {
            if (event.type === "surface.created")
                await surfaces.changeMember(ctx, event.payload.surface.id, "bob", "join");
        });
        await hooks.afterStart?.(db.context, {} as AgentSystemRef);
        try {
            ids.next = ["zholder", "zcreated", "aupdated"];
            const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
            await durable.invoke(db.context, {
                function: "holder",
                arguments: null,
                lockKeys: ["surfaces.notify"],
            });
            const surface = await surfaces.create(
                db.context,
                { id: "s12345678901234567890123", type: "todo", name: "Joined by default" },
                "alice",
            );
            clock.mockRestore();
            gate.resolve();
            await waitForCondition(async () => (await pendingCallCount(db.context)) === 0);
            expect(events.map((event) => event.type)).toEqual([
                "surface.created",
                "surface.updated",
            ]);
            expect(events[1]?.payload).toMatchObject({
                version: surface.version,
                changes: { members: surface.members },
            });
            expect(surface.members.map((member) => member.userId)).toEqual(["alice", "bob"]);
        } finally {
            gate.resolve();
            durable.stop();
            db.close();
        }
    });
});
