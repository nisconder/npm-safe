/**
 * Interactive TUI panel for managing the npm-safe-scan skill across the
 * supported AI agents. Entered by `npm-safe skill` (no subcommand) when the
 * terminal is interactive.
 */

import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";

import { t } from "./i18n.js";
import {
  AGENTS,
  type AgentConfig,
  agentTargetPath,
  displayPath,
  getAgentById,
  isAgentInstalled,
} from "./agent-registry.js";
import { installToAgent, uninstallFromAgent } from "./agent-installer.js";
import { getSkillPaths } from "./skill-install.js";

const CHECK = "\u2713";
const CROSS = "\u2717";

/**
 * Windows consoles default to an OEM code page (e.g. GBK/936 for Chinese
 * systems) which mangles the UTF-8 output. Switch the active console code
 * page to 65001 (UTF-8) before rendering. Best-effort: silently skipped on
 * non-Windows platforms, non-TTY output, or when `chcp` is unavailable.
 */
function ensureUtf8Console(): void {
  if (process.platform !== "win32" || !process.stdout.isTTY) return;
  try {
    spawnSync("chcp.com", ["65001"], { stdio: "ignore" });
  } catch {
    // Keep the current code page.
  }
}

/** Render the per-agent status list shown at the top of the panel. */
function statusLines(): string {
  return AGENTS.map((agent) => {
    const mark = isAgentInstalled(agent) ? CHECK : CROSS;
    const target = displayPath(agentTargetPath(agent));
    return `${mark} ${agent.name.padEnd(12)} → ${target}`;
  }).join("\n");
}

/** Handle Ctrl+C at any prompt: print a cancellation note and exit cleanly. */
function handleCancel(): never {
  p.cancel(t("skill.tui.cancelled"));
  p.outro(t("skill.tui.bye"));
  process.exit(0);
}

/** Ask which agents to operate on. Returns `[]` when the user goes back. */
async function pickAgents(message: string): Promise<AgentConfig[]> {
  const picked = await p.multiselect({
    message,
    options: AGENTS.map((agent) => ({
      value: agent.id,
      label: agent.name,
      hint: isAgentInstalled(agent) ? t("skill.tui.installedShort") : t("skill.tui.notInstalledShort"),
    })),
    required: true,
  });
  if (p.isCancel(picked)) handleCancel();
  return (picked as string[])
    .map((id) => getAgentById(id))
    .filter((a): a is AgentConfig => a !== undefined);
}

/** Perform the chosen operation on the selected agents with a spinner. */
async function runOperation(installing: boolean, selected: AgentConfig[]): Promise<void> {
  const s = p.spinner();
  s.start(t(installing ? "skill.tui.installing" : "skill.tui.uninstalling"));
  for (const agent of selected) {
    try {
      if (installing) {
        const target = installToAgent(agent);
        s.message(t("skill.tui.installed", { name: agent.name, path: displayPath(target) }));
      } else {
        const removed = uninstallFromAgent(agent);
        s.message(
          removed
            ? t("skill.tui.uninstalled", { name: agent.name })
            : t("skill.tui.notInstalled", { name: agent.name }),
        );
      }
    } catch (err) {
      s.message(t("skill.tui.failed", { name: agent.name, message: err instanceof Error ? err.message : String(err) }));
    }
  }
  s.stop(t("skill.tui.done"));
}

/** Main TUI loop. Returns when the user chooses to exit. */
export async function runSkillTui(): Promise<void> {
  ensureUtf8Console();
  p.intro(t("skill.tui.title"));
  p.note(statusLines(), t("skill.tui.statusTitle"));
  p.note(displayPath(getSkillPaths().source), t("skill.tui.sourceTitle"));

  for (;;) {
    const action = await p.select({
      message: t("skill.tui.selectAction"),
      options: [
        { value: "install", label: t("skill.tui.install") },
        { value: "uninstall", label: t("skill.tui.uninstall") },
        { value: "exit", label: t("skill.tui.exit") },
      ],
    });
    if (p.isCancel(action)) handleCancel();
    if (action === "exit") break;

    const installing = action === "install";
    const selected = await pickAgents(t("skill.tui.selectAgents"));

    const confirmed = await p.confirm({
      message: t(installing ? "skill.tui.confirmInstall" : "skill.tui.confirmUninstall", {
        count: String(selected.length),
      }),
    });
    if (p.isCancel(confirmed)) handleCancel();
    if (!confirmed) continue;

    await runOperation(installing, selected);
    p.note(statusLines(), t("skill.tui.statusTitle"));
  }

  p.outro(t("skill.tui.bye"));
}
