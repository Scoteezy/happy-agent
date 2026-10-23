import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/requireGymRuntime.ts",
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
    },
});
