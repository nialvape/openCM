import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: two levels up from src/core (or build/core). OPENCM_ROOT overrides it for tests. */
const root = process.env.OPENCM_ROOT
  ? resolve(process.env.OPENCM_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const paths = {
  root,
  data: join(root, "data"),
  projects: join(root, "projects"),
  prompts: join(root, "prompts"),
  skills: join(root, "skills"),
  decisions: join(root, "decisions"),
  projectDir: (id: string) => join(root, "projects", id),
  projectData: (id: string) => join(root, "data", id),
  traces: join(root, "data", "traces"),
  db: join(root, "data", "opencm.sqlite"),
};
