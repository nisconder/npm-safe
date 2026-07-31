import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NpmSafeEngine } from "../index.js";

/**
 * Default filesystem path for the CLI's SQLite cache database.
 *
 * Uses a per-user directory under the home directory so multiple projects do
 * not fight over the same database file.
 */
export function getDefaultDbPath(): string {
  const dir = path.join(os.homedir(), ".npm-safe");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "npm-safe.db");
}

/**
 * Create a single {@link NpmSafeEngine} instance for the lifetime of a CLI
 * command. Defaults to {@link getDefaultDbPath} when no path is supplied.
 */
export function createEngine(dbPath?: string): NpmSafeEngine {
  return new NpmSafeEngine({ dbPath: dbPath ?? getDefaultDbPath() });
}
