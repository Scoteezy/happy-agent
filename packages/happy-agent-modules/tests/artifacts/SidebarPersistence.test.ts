import { expect, it } from "vitest";
import { queryArtifactInline } from "../../sources/artifacts/ArtifactStore.js";
import { artifactsWorld, sha256 } from "./support/artifactsWorld.js";

it("rolls back sidebar content and its upload intent with the caller, without writing files", async () => {
    const world = await artifactsWorld("sidebar-transactional-content");
    const html = "<nav><p>Transactional sidebar</p></nav>";
    try {
        await expect(
            world.ctx.inTx(async (ctx) => {
                await world.artifacts.stageSidebarText(ctx, html);
                expect(await queryArtifactInline(ctx, sha256(html))).toBe(html);
                expect(await world.uploadFiles()).toEqual([]);
                throw new Error("Roll back the lifecycle change.");
            }),
        ).rejects.toThrow("Roll back the lifecycle change.");
        expect(await queryArtifactInline(world.ctx, sha256(html))).toBeUndefined();
        expect(await world.uploadRows()).toBe(0);
        expect(await world.pendingRemovals()).toBe(0);
        expect(await world.uploadFiles()).toEqual([]);
        const upload = await world.artifacts.stageSidebarText(world.ctx, html);
        expect(await queryArtifactInline(world.ctx, upload.sha256)).toBe(html);
        await world.expire(upload.id);
        expect(await queryArtifactInline(world.ctx, upload.sha256)).toBeUndefined();
    } finally {
        await world.close();
    }
});
