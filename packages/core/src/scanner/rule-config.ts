/**
 * Per-rule configuration: enable/disable, severity overrides, and free-form
 * options. Configuration is persisted as JSON (default
 * `~/.npm-safe/rules.json`) and can be managed at runtime through the
 * {@link RuleConfigManager}.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Severity } from './types.js';

/** Free-form options passed to a rule at match time. */
export type RuleOptions = Readonly<Record<string, unknown>>;

/** Per-rule configuration overrides. */
export interface RuleConfig {
  /** Whether the rule is enabled. Defaults to the rule's own default. */
  readonly enabled?: boolean;
  /** Severity override applied to findings produced by the rule. */
  readonly severity?: Severity;
  /** Free-form options made available to the rule implementation. */
  readonly options?: RuleOptions;
}

/** Shape of the persisted rules configuration file. */
export interface RuleConfigFile {
  /** Per-rule overrides keyed by rule id. */
  readonly rules: Readonly<Record<string, RuleConfig>>;
}

/** Default location of the rules configuration file. */
export function getDefaultRulesConfigPath(): string {
  return path.join(os.homedir(), '.npm-safe', 'rules.json');
}

/**
 * Loads, mutates, and persists per-rule configuration. Thread-safe per
 * instance; concurrent instances may race on the file, which is acceptable
 * for a single-user desktop tool.
 */
export class RuleConfigManager {
  private readonly filePath: string;
  private config: RuleConfigFile;

  /**
   * @param filePath - Path to the JSON config file.
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultRulesConfigPath();
    this.config = this.load();
  }

  /** Load (or initialize) the config file. */
  private load(): RuleConfigFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RuleConfigFile>;
      return { rules: parsed.rules ?? {} };
    } catch {
      return { rules: {} };
    }
  }

  /** Persist the current configuration to disk. */
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
    } catch {
      // Best-effort persistence; in-memory config remains valid.
    }
  }

  /** Get the configuration for a single rule, or `undefined` if unset. */
  getRule(ruleId: string): RuleConfig | undefined {
    return this.config.rules[ruleId];
  }

  /** Whether a rule is enabled, honoring config overrides. */
  isEnabled(ruleId: string, defaultEnabled: boolean): boolean {
    const rule = this.config.rules[ruleId];
    return rule?.enabled ?? defaultEnabled;
  }

  /** Severity override for a rule, or `undefined` if not overridden. */
  getSeverityOverride(ruleId: string): Severity | undefined {
    return this.config.rules[ruleId]?.severity;
  }

  /** Options for a rule, or `{}` if none are configured. */
  getOptions(ruleId: string): RuleOptions {
    return this.config.rules[ruleId]?.options ?? {};
  }

  /** Enable or disable a rule (persisted). */
  setEnabled(ruleId: string, enabled: boolean): void {
    const rules = this.mutableRules();
    const existing = rules[ruleId] ?? {};
    rules[ruleId] = { ...existing, enabled };
    this.save();
  }

  /** Override a rule's severity (persisted). `undefined` clears the override. */
  setSeverity(ruleId: string, severity: Severity | undefined): void {
    const rules = this.mutableRules();
    const existing = rules[ruleId] ?? {};
    if (severity === undefined) {
      const { severity: _removed, ...rest } = existing;
      rules[ruleId] = rest;
    } else {
      rules[ruleId] = { ...existing, severity };
    }
    this.save();
  }

  /** Set a rule's options (persisted). */
  setOptions(ruleId: string, options: RuleOptions): void {
    const rules = this.mutableRules();
    const existing = rules[ruleId] ?? {};
    rules[ruleId] = { ...existing, options };
    this.save();
  }

  /** All configured rule ids. */
  getConfiguredRuleIds(): string[] {
    return Object.keys(this.config.rules);
  }

  /** Mutable view of the rules map for writing. */
  private mutableRules(): Record<string, RuleConfig> {
    return this.config.rules as Record<string, RuleConfig>;
  }
}
