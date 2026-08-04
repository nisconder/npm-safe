/**
 * Append-only JSONL command log for the npm-safe CLI.
 *
 * Writes one line per CLI invocation to `~/.npm-safe/commands.jsonl`,
 * independent of the opt-in telemetry aggregator. Best-effort: a failure to
 * write must never break or block the CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A single recorded CLI invocation. */
export interface CommandLogEntry {
  /** ISO-8601 timestamp of when the command finished. */
  readonly timestamp: string;
  /** Top-level command name, e.g. `check`, `search`. */
  readonly command: string;
  /** Raw `process.argv` slice(2). */
  readonly argv: readonly string[];
  /** Process exit code. */
  readonly exitCode: number;
  /** Wall-clock duration of the invocation, in milliseconds. */
  readonly durationMs: number;
}

/** Default location of the command log. */
export function getCommandLogPath(): string {
  return path.join(os.homedir(), ".npm-safe", "commands.jsonl");
}

/**
 * Append one JSONL entry. Best-effort — never throws, never blocks the CLI.
 *
 * @param entry - The invocation to record.
 * @param filePath - Optional override (used by tests). Falls back to the
 *   `NPM_SAFE_COMMAND_LOG` env var, then to the default path.
 */
export function logCommand(entry: CommandLogEntry, filePath?: string): void {
  try {
    const file = filePath ?? process.env.NPM_SAFE_COMMAND_LOG ?? getCommandLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // Command logging must never break the CLI.
  }
}
