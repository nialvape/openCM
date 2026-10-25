import { cpSync } from "node:fs";
import { join } from "node:path";
import { TEST_ROOT } from "./vitest.config.js";

/** Runs once before all workers: the generic decision schemas are part of the harness under test. */
export default function setup(): void {
  cpSync(join(process.cwd(), "decisions"), join(TEST_ROOT, "decisions"), { recursive: true });
}
