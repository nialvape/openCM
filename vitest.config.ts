import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/** Traces and any data written by tests go to a temp root, never to the repo's data/. */
export const TEST_ROOT = join(tmpdir(), "opencm-test-root");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["vitest.global-setup.ts"],
    env: { OPENCM_ROOT: TEST_ROOT },
  },
});
