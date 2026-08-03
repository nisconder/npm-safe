import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NpmSafeEngine } from "../index.js";
import { setLocale, type Locale } from "./i18n.js";

export function getDefaultDbPath(): string {
  const dir = path.join(os.homedir(), ".npm-safe");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "npm-safe.db");
}

/**
 * Create an {@link NpmSafeEngine} instance.
 *
 * The persisted locale is loaded from the engine's settings table and
 * applied globally before the engine is returned. LLM configuration is loaded
 * from `~/.npm-safe/llm.json` (or environment-variable fallback) by the engine
 * itself. Proxy resolution order:
 * explicit `proxyUrl` argument > persisted `proxy` setting > environment
 * variables (handled inside the engine's registry client).
 */
export async function createEngine(
  dbPath?: string,
  proxyUrl?: string,
): Promise<NpmSafeEngine> {
  const db = dbPath ?? getDefaultDbPath();
  const engine = new NpmSafeEngine({
    dbPath: db,
    proxy: proxyUrl ?? (await readPersistedProxy(db)),
  });

  try {
    const stored = await engine.getSetting("lang");
    if (stored === "en" || stored === "zh") {
      setLocale(stored as Locale);
    }
  } catch {
    // No stored locale — keep the default (en).
  }

  return engine;
}

/**
 * Read the persisted `proxy` setting without a full engine instance.
 *
 * Returns `undefined` when the database does not exist or the setting is
 * unset, so callers can fall back to the environment.
 */
async function readPersistedProxy(dbPath: string): Promise<string | undefined> {
  try {
    const { DatabaseManager } = await import("../store/database.js");
    const { CacheManager } = await import("../store/cache-manager.js");
    const dbm = new DatabaseManager(dbPath);
    try {
      const cache = new CacheManager(dbm);
      const stored = await cache.getSetting("proxy");
      return stored ?? undefined;
    } finally {
      dbm.close();
    }
  } catch {
    return undefined;
  }
}
