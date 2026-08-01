import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NpmSafeEngine } from "../index.js";
import { type LlmProviderOptions, LlmProviderType } from "../llm/provider.js";
import { setLocale, type Locale } from "./i18n.js";

export function getDefaultDbPath(): string {
  const dir = path.join(os.homedir(), ".npm-safe");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "npm-safe.db");
}

/**
 * Resolve LLM provider configuration from environment variables.
 *
 * Priority order: ANTHROPIC_API_KEY, then GEMINI_API_KEY, then
 * OPENAI_API_KEY. Returns `undefined` when no key is configured.
 */
function resolveLlmOptions(): LlmProviderOptions | undefined {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: LlmProviderType.Anthropic,
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      model: process.env.ANTHROPIC_MODEL,
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: LlmProviderType.Gemini,
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: process.env.GEMINI_BASE_URL,
      model: process.env.GEMINI_MODEL,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: LlmProviderType.OpenAi,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    };
  }
  return undefined;
}

/**
 * Create an {@link NpmSafeEngine} instance.
 *
 * The persisted locale is loaded from the engine's settings table and
 * applied globally before the engine is returned. Proxy resolution order:
 * explicit `proxyUrl` argument > persisted `proxy` setting > environment
 * variables (handled inside the engine's registry client).
 */
export async function createEngine(
  dbPath?: string,
  proxyUrl?: string,
): Promise<NpmSafeEngine> {
  const db = dbPath ?? getDefaultDbPath();
  const llmOptions = resolveLlmOptions();
  const engine = new NpmSafeEngine({
    dbPath: db,
    proxy: proxyUrl ?? (await readPersistedProxy(db)),
    llm: llmOptions,
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
