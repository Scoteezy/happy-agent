import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TeamModule, type TeamUser } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";

/** Surface participation is independent of the person's task preference. */
export const SURFACE_AUTO_JOIN_SETTING = "surfaces.autoJoin";
const RECONCILE_FUNCTION = "surfaceAutoJoin.reconcile";

/** Default sidebar participation; settings remain opaque and Surfaces own membership storage. */
export class SurfaceAutoJoinModule implements AgentModule {
    readonly name = "surfaceAutoJoin";

    constructor(
        readonly surfaces: SurfacesModule,
        readonly team: TeamModule,
        readonly settings: UserSettingsModule,
        readonly durableFunctions: DurableFunctionsModule,
    ) {
        durableFunctions.register({
            name: RECONCILE_FUNCTION,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                if (!team.enabled) return null;
                for (const user of await team.listMembers(ctx)) await this.#joinAll(ctx, user);
                return null;
            },
        });

        surfaces.onEventTransactional(async (ctx, event) => {
            if (!team.enabled || event.type !== "surface.created") return;
            for (const user of await team.listMembers(ctx)) {
                // The creator's mandatory membership already exists, regardless of preference.
                if (user.id === event.payload.surface.creatorUserId) continue;
                await this.#joinBatch(ctx, user, event.payload.surface.id);
            }
        });

        team.onProfileUpdatedTransactional(async (ctx, event) => {
            if (!team.enabled || event.previousVersion !== null) return;
            if (event.user.authentication === "guest") return;
            await this.#joinAll(ctx, event.user);
        });

        settings.onEventTransactional(async (ctx, event) => {
            if (!team.enabled || event.setting.key !== SURFACE_AUTO_JOIN_SETTING) return;
            if (event.setting.value === false) return;
            const user = await team.getUser(ctx, event.owner);
            if (user === undefined || user.authentication === "guest") return;
            await this.#joinAll(ctx, user);
        });
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        afterStart: async (ctx) => {
            if (!this.team.enabled) return;
            await this.durableFunctions.invoke(ctx, {
                function: RECONCILE_FUNCTION,
                arguments: null,
                operationId: RECONCILE_FUNCTION,
                lockKeys: [RECONCILE_FUNCTION],
            });
        },
    });

    async #joinAll(ctx: Context, user: TeamUser): Promise<void> {
        // Startup releases the database between bounded batches. Enrollment and preference
        // writes retain the caller's transaction so participation rolls back with its trigger.
        while ((await this.#joinBatch(ctx, user)) > 0) ctx.lifetime?.throwIfAborted();
    }

    async #joinBatch(ctx: Context, user: TeamUser, surfaceId?: string): Promise<number> {
        return ctx.inTx(async (tx) => {
            const userCtx = this.team.connectionContext(tx, user);
            if ((await this.settings.get(userCtx, SURFACE_AUTO_JOIN_SETTING)).value === false)
                return 0;
            return this.surfaces.joinAutomatically(tx, user.id, surfaceId);
        });
    }
}
