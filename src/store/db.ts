import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../core/paths.js";

/**
 * State is split in separate tables on purpose: what a run did (runs, checkpoints), what the
 * owner sees in Telegram (later: transcript) and what the agent learned (later: memory) never
 * share a table, so the chat history is never mistaken for the model's context or for memory.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  steps INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL REFERENCES runs(id),
  step INTEGER NOT NULL,
  messages TEXT NOT NULL,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project TEXT,
  schema TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  model TEXT NOT NULL,
  subject TEXT,
  state TEXT NOT NULL,
  answers TEXT NOT NULL,
  needs_owner TEXT NOT NULL,
  owner_answers TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  messages TEXT NOT NULL,
  summary TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_usage (
  run_id TEXT NOT NULL REFERENCES runs(id),
  skill TEXT NOT NULL,
  source TEXT NOT NULL,
  step INTEGER NOT NULL
);
`;

let shared: DatabaseSync | undefined;

/** Opens (and migrates) the database. ':memory:' is used by tests. */
export function openDb(file = paths.db): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function db(): DatabaseSync {
  shared ??= openDb();
  return shared;
}

export const now = () => new Date().toISOString();
