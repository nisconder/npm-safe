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

export async function createEngine(dbPath?: string): Promise<NpmSafeEngine> {
  const engine = new NpmSafeEngine({ dbPath: dbPath ?? getDefaultDbPath() });
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
