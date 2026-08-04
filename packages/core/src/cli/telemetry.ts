import { Command } from "commander";

import { TelemetryManager } from "../telemetry/telemetry.js";
import { t } from "./i18n.js";

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Manage optional local usage telemetry");

  telemetry
    .command("status")
    .description("Show whether telemetry is enabled and its aggregated stats")
    .option("-j, --json", "Output raw JSON")
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ json?: boolean }>();
      const manager = new TelemetryManager();
      const state = manager.getState();
      if (options.json ?? opts.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      console.log(`${t("telemetry.status.enabled")}: ${state.enabled ? t("llm.yes") : t("llm.no")}`);
      if (state.since) {
        console.log(`${t("telemetry.status.since")}: ${state.since}`);
      }
      console.log(`${t("telemetry.status.events")}: ${Object.values(state.counts).reduce((a, b) => a + b, 0)}`);
      console.log(`${t("telemetry.status.packages")}: ${state.totalPackagesScanned}`);
      console.log(`${t("telemetry.status.errors")}: ${state.totalErrors}`);
    });

  telemetry
    .command("enable")
    .description("Enable telemetry collection (local only)")
    .action(async () => {
      const manager = new TelemetryManager();
      manager.enable();
      console.log(t("telemetry.enabled"));
    });

  telemetry
    .command("disable")
    .description("Disable telemetry collection (keeps existing data)")
    .action(async () => {
      const manager = new TelemetryManager();
      manager.disable();
      console.log(t("telemetry.disabled"));
    });

  telemetry
    .command("export")
    .description("Export the collected telemetry as JSON")
    .option("-o, --output <path>", "Write to a file instead of stdout")
    .action(async (options: { output?: string }) => {
      const manager = new TelemetryManager();
      const json = JSON.stringify(manager.getState(), null, 2);
      if (options.output) {
        try {
          const fs = await import("node:fs");
          fs.writeFileSync(options.output, json);
          console.log(t("telemetry.exported", { path: options.output }));
        } catch (err) {
          console.error(t("telemetry.exportFailed", { message: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
        }
        return;
      }
      console.log(json);
    });

  telemetry
    .command("reset")
    .description("Clear all collected telemetry data")
    .action(async () => {
      const manager = new TelemetryManager();
      manager.reset();
      console.log(t("telemetry.reset"));
    });
}
