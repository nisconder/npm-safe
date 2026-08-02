/**
 * Plugin rule discovery: loads third-party {@link ScanRule}s from a directory
 * of ES module files. Each `.mjs` (or `.js`) file may export a single rule,
 * an array of rules, or a factory function returning either.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ScanRule } from './types.js';

/** Default directory scanned for third-party rule plugins. */
export function getDefaultRulesDir(): string {
  return path.join(os.homedir(), '.npm-safe', 'rules');
}

/** A rule exported by a plugin module, or a factory producing one. */
export type RuleModuleExport =
  | ScanRule
  | ScanRule[]
  | (() => ScanRule | ScanRule[]);

/** Result of loading one plugin file. */
export interface LoadedRuleFile {
  /** Absolute path of the loaded file. */
  readonly filePath: string;
  /** Rules exported by the file. */
  readonly rules: ScanRule[];
}

/** Normalize a module export into an array of rules. */
function toRules(exported: RuleModuleExport | undefined): ScanRule[] {
  if (exported === undefined) return [];
  const resolved = typeof exported === 'function' ? exported() : exported;
  if (Array.isArray(resolved)) {
    return resolved.filter(
      (r): r is ScanRule => r !== null && typeof r === 'object' && 'id' in r,
    );
  }
  if (resolved !== null && typeof resolved === 'object' && 'id' in resolved) {
    return [resolved as ScanRule];
  }
  return [];
}

/**
 * Load all rule plugin files from a directory.
 *
 * Files are read in lexical order so rule order is deterministic. Invalid
 * files are skipped — a broken plugin must not take down the whole scan.
 *
 * @param dir - Directory to scan for `*.mjs` / `*.js` rule files.
 * @returns Per-file load results for every successfully loaded file.
 */
export async function loadRulesFromDirectory(
  dir?: string,
): Promise<LoadedRuleFile[]> {
  const target = dir ?? getDefaultRulesDir();
  let entries: string[];
  try {
    entries = fs
      .readdirSync(target)
      .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
      .sort();
  } catch {
    return []; // Directory does not exist — nothing to load.
  }

  const results: LoadedRuleFile[] = [];
  for (const entry of entries) {
    const filePath = path.join(target, entry);
    try {
      const mod = (await import(
        /* webpackIgnore: true */ pathToFileURL(filePath).href
      )) as Record<string, unknown>;
      // Prefer a named `rule` / `rules` export, fall back to `default`.
      const candidate = mod.rule ?? mod.rules ?? mod.default;
      const rules = toRules(candidate as RuleModuleExport);
      if (rules.length > 0) {
        results.push({ filePath, rules });
      }
    } catch {
      // Skip unparseable plugin files silently.
    }
  }
  return results;
}
