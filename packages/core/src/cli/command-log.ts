/**
 * Append-only JSONL command log for the npm-safe CLI.
 *
 * Writes one line per CLI invocation to `~/.npm-safe/commands.jsonl`,
 * independent of the opt-in telemetry aggregator. Sensitive argument values
 * are redacted before persistence. Best-effort: a failure to write must never
 * break or block the CLI.
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

const REDACTED = "[REDACTED]";

/** Options whose following value may contain credentials. */
const SENSITIVE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-p",
  "--proxy",
  "--registry",
  "--token",
  "--auth-token",
  "--api-key",
  "--password",
  "--secret",
]);

/**
 * Return a copy of CLI arguments that is safe to persist in diagnostics.
 *
 * The LLM key command is redacted wherever it appears after global options.
 * Generic settings values are also omitted because settings may be used for
 * proxy URLs or future credentials. Finally, common credential-bearing flags
 * are handled in both `--flag value` and `--flag=value` forms, including npm's
 * scoped `_authToken` configuration syntax.
 */
export function sanitizeCommandArgv(argv: readonly string[]): string[] {
  const sanitized = [...argv];

  const llmIndex = sanitized.indexOf("llm");
  if (llmIndex >= 0 && sanitized[llmIndex + 1] === "set-key" && sanitized[llmIndex + 2] !== undefined) {
    sanitized[llmIndex + 2] = REDACTED;
  }

  const settingsIndex = sanitized.indexOf("settings");
  if (settingsIndex >= 0 && sanitized[settingsIndex + 1] === "set" && sanitized[settingsIndex + 3] !== undefined) {
    sanitized[settingsIndex + 3] = REDACTED;
  }

  for (let index = 0; index < sanitized.length; index++) {
    const arg = sanitized[index];
    if (SENSITIVE_VALUE_OPTIONS.has(arg) && sanitized[index + 1] !== undefined) {
      sanitized[index + 1] = REDACTED;
      index++;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) continue;
    const option = arg.slice(0, equalsIndex);
    if (
      SENSITIVE_VALUE_OPTIONS.has(option) ||
      /(?:api[-_]?key|auth(?:[-_]?token)?|token|password|passwd|secret|credential)$/i.test(option)
    ) {
      sanitized[index] = `${option}=${REDACTED}`;
    }
  }

  return sanitized;
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
    const safeEntry: CommandLogEntry = {
      ...entry,
      argv: sanitizeCommandArgv(entry.argv),
    };
    fs.appendFileSync(file, JSON.stringify(safeEntry) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Ignore platforms/filesystems where chmod is unsupported.
    }
  } catch {
    // Command logging must never break the CLI.
  }
}
