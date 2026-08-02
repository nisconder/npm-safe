import { Command } from "commander";

import { Severity } from "../scanner/types.js";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

const SEVERITY_VALUES: readonly string[] = Object.values(Severity);

export function registerRulesCommand(program: Command): void {
  const rules = program.command("rules").description("Manage scan rules and plugins");

  rules
    .command("list")
    .description("List all registered scan rules with their effective status")
    .option("-j, --json", "Output raw JSON")
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        const descriptors = engine.listRules();
        if (options.json ?? opts.json) {
          console.log(JSON.stringify(descriptors, null, 2));
          return;
        }
        if (descriptors.length === 0) {
          console.log(t("rules.list.empty"));
          return;
        }
        for (const d of descriptors) {
          const state = d.enabled ? "enabled" : "disabled";
          console.log(
            `[${state}] ${d.id} (${d.source}, ${d.severity}) — ${d.name}`,
          );
        }
      } finally {
        engine.close();
      }
    });

  rules
    .command("enable <rule-id>")
    .description("Enable a scan rule (persisted)")
    .action(async (ruleId: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setRuleEnabled(ruleId, true);
        console.log(t("rules.enabled", { ruleId }));
      } finally {
        engine.close();
      }
    });

  rules
    .command("disable <rule-id>")
    .description("Disable a scan rule (persisted)")
    .action(async (ruleId: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setRuleEnabled(ruleId, false);
        console.log(t("rules.disabled", { ruleId }));
      } finally {
        engine.close();
      }
    });

  rules
    .command("severity <rule-id> <severity>")
    .description(`Override a rule's severity (${SEVERITY_VALUES.join(" / ")})`)
    .action(async (ruleId: string, severity: string) => {
      if (!SEVERITY_VALUES.includes(severity)) {
        console.error(t("rules.severityUnknown", { severity }));
        process.exitCode = 1;
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setRuleSeverity(ruleId, severity as Severity);
        console.log(t("rules.severitySet", { ruleId, severity }));
      } finally {
        engine.close();
      }
    });
}
