/**
 * Persists the most recent batch check so `npm-safe check detail <n>` can
 * re-render the full report of one package without re-fetching.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BatchPackageResult } from "../index.js";

interface LastBatchFile {
  readonly savedAt: string;
  readonly packages: readonly BatchPackageResult[];
}

/** Default location of the last batch check results. */
export function getLastBatchPath(): string {
  return path.join(os.homedir(), ".npm-safe", "last-batch.json");
}

/** Save the most recent batch check results (best effort). */
export function saveLastBatch(
  packages: readonly BatchPackageResult[],
  filePath?: string,
): void {
  const target = filePath ?? getLastBatchPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload: LastBatchFile = {
      savedAt: new Date().toISOString(),
      packages,
    };
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  } catch {
    // Best-effort persistence; the batch output is still printed.
  }
}

/** Load the most recent batch check results, or `null` when unavailable. */
export function loadLastBatch(filePath?: string): readonly BatchPackageResult[] | null {
  const target = filePath ?? getLastBatchPath();
  try {
    const parsed = JSON.parse(
      fs.readFileSync(target, "utf8"),
    ) as Partial<LastBatchFile>;
    if (!Array.isArray(parsed.packages)) return null;
    return parsed.packages;
  } catch {
    return null;
  }
}
