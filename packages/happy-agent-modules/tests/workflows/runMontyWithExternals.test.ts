import { describe, expect, it, vi } from "vitest";

import { runMontyWithExternals } from "../../sources/workflows/runner/runMontyWithExternals.js";

describe("runMontyWithExternals", () => {
    it("does not execute Python after the workflow was already cancelled", async () => {
        const onPrint = vi.fn();
        await expect(
            runMontyWithExternals({
                code: "print('must not run')\n42",
                externalFunctions: {},
                inputs: {},
                limits: { maxDurationSecs: 1 },
                onPrint,
                onSnapshot: vi.fn(),
                signal: AbortSignal.abort(),
                scriptName: "cancelled.py",
            }),
        ).rejects.toThrow("The workflow was stopped.");
        expect(onPrint).not.toHaveBeenCalled();
    });
    it("reports cancellation during native execution once its execution budget settles", async () => {
        const controller = new AbortController();
        await expect(
            runMontyWithExternals({
                code: "print('started')\nwhile True:\n    pass",
                externalFunctions: {},
                inputs: {},
                limits: { maxDurationSecs: 0.05 },
                onPrint: () => controller.abort(),
                onSnapshot: vi.fn(),
                signal: controller.signal,
                scriptName: "cancelled.py",
            }),
        ).rejects.toThrow("The workflow was stopped.");
    });

    it("does not resume Python after cancellation during an external call", async () => {
        const controller = new AbortController();
        const onPrint = vi.fn();
        await expect(
            runMontyWithExternals({
                code: "checkpoint()\nprint('must not resume')",
                externalFunctions: { checkpoint: () => controller.abort() },
                inputs: {},
                limits: { maxDurationSecs: 1 },
                onPrint,
                onSnapshot: vi.fn(),
                signal: controller.signal,
                scriptName: "cancelled.py",
            }),
        ).rejects.toThrow("The workflow was stopped.");
        expect(onPrint).not.toHaveBeenCalled();
    });

    it("reloads the checkpoint after every host step so runtime budgets are per segment", async () => {
        const segmentCount = 6;
        const script = [
            "total = 0",
            ...Array.from({ length: segmentCount }, () => [
                "for i in range(500000):",
                "    total += i",
                "total = checkpoint(total)",
            ]).flat(),
            "total",
        ].join("\n");
        const snapshots: Uint8Array[] = [];

        const output = await runMontyWithExternals({
            code: script,
            externalFunctions: {
                checkpoint: async (value) => await Promise.resolve(value),
            },
            inputs: { args: null },
            limits: { maxDurationSecs: 1 },
            onPrint: vi.fn(),
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            },
            signal: new AbortController().signal,
            scriptName: "workflow.py",
        });

        expect(output).toBeTypeOf("number");
        expect(snapshots).toHaveLength(segmentCount);
        expect(snapshots.every((snapshot) => snapshot.byteLength > 0)).toBe(true);
    });
});
