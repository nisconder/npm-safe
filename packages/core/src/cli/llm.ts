import { Command } from "commander";

import { LlmProviderType } from "../llm/provider.js";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

const PROVIDER_VALUES: readonly string[] = Object.values(LlmProviderType);

export function registerLlmCommand(program: Command): void {
  const llm = program
    .command("llm")
    .description("Manage optional LLM-based semantic scanning");

  llm
    .command("status")
    .description("Show LLM provider status")
    .option("-j, --json", "Output raw JSON")
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        const status = engine.getLlmStatus();
        if (options.json ?? opts.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        const lines: string[] = [
          `${t("llm.status.enabled")}: ${status.enabled ? t("llm.yes") : t("llm.no")}`,
          `${t("llm.status.provider")}: ${status.provider}`,
          `${t("llm.status.configured")}: ${status.configured ? t("llm.yes") : t("llm.no")}`,
        ];
        if (status.model) {
          lines.push(`${t("llm.status.model")}: ${status.model}`);
        }
        if (status.baseUrl) {
          lines.push(`${t("llm.status.baseUrl")}: ${status.baseUrl}`);
        }
        if (status.maxTokens) {
          lines.push(`${t("llm.status.maxTokens")}: ${status.maxTokens}`);
        }
        if (status.maxInputChars) {
          lines.push(`${t("llm.status.maxInputChars")}: ${status.maxInputChars}`);
        }
        if (status.apiKey) {
          lines.push(`${t("llm.status.apiKey")}: ${status.apiKey}`);
        }
        console.log(lines.join("\n"));
      } finally {
        engine.close();
      }
    });

  llm
    .command("enable")
    .description("Enable LLM scanning")
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ enabled: true });
        console.log(t("llm.enabled"));
      } finally {
        engine.close();
      }
    });

  llm
    .command("disable")
    .description("Disable LLM scanning")
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ enabled: false });
        console.log(t("llm.disabled"));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-provider <provider>")
    .description(`Set LLM provider (${PROVIDER_VALUES.join(" / ")})`)
    .action(async (provider: string) => {
      if (!PROVIDER_VALUES.includes(provider)) {
        console.error(t("llm.providerUnknown", { provider, supported: PROVIDER_VALUES.join(" / ") }));
        process.exitCode = 1;
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ provider: provider as LlmProviderType });
        console.log(t("llm.providerSet", { provider }));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-key <api-key>")
    .description("Set the LLM API key")
    .action(async (apiKey: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ apiKey });
        console.log(t("llm.keySet"));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-model <model>")
    .description("Set the LLM model identifier")
    .action(async (model: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ model });
        console.log(t("llm.modelSet", { model }));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-base-url <url>")
    .description("Set the LLM API base URL")
    .action(async (baseUrl: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ baseUrl });
        console.log(t("llm.baseUrlSet", { baseUrl }));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-max-tokens <n>")
    .description("Set the maximum response tokens (default 4096)")
    .action(async (n: string) => {
      const value = Number(n);
      if (!Number.isFinite(value) || value < 1) {
        console.error(t("llm.invalidNumber", { n }));
        process.exitCode = 1;
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ maxTokens: Math.floor(value) });
        console.log(t("llm.maxTokensSet", { n: String(Math.floor(value)) }));
      } finally {
        engine.close();
      }
    });

  llm
    .command("set-max-input-chars <n>")
    .description("Set the maximum README/manifest characters sent to the model (default 12000)")
    .action(async (n: string) => {
      const value = Number(n);
      if (!Number.isFinite(value) || value < 1) {
        console.error(t("llm.invalidNumber", { n }));
        process.exitCode = 1;
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        engine.setLlmConfig({ maxInputChars: Math.floor(value) });
        console.log(t("llm.maxInputCharsSet", { n: String(Math.floor(value)) }));
      } finally {
        engine.close();
      }
    });

  llm
    .command("test-connection")
    .alias("test")
    .description("Test the LLM connection")
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        const status = engine.getLlmStatus();
        if (!status.enabled || !status.configured) {
          console.log(t("llm.notConfigured"));
          process.exitCode = 1;
          return;
        }
        const ok = await engine.testLlmConnection();
        if (ok) {
          console.log(t("llm.test.ok"));
        } else {
          console.error(t("llm.test.fail", { reason: "" }));
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(t("llm.test.fail", { reason: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      } finally {
        engine.close();
      }
    });
}
