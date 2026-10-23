import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Traces and any data written by tests go to a temp root, never to the repo's data/.
    env: { OPENCM_ROOT: join(tmpdir(), "opencm-test-root") },
  },
});
