/**
 * Install / uninstall the npm-safe-scan skill into the directory a given AI
 * agent expects. Two strategies exist:
 *
 * - skill:        copy SKILL.md verbatim into `<agent>/skills/npm-safe-scan/`
 * - instructions: append the skill body, wrapped in markers, to the agent's
 *                 global instructions file (AGENTS.md / GEMINI.md)
 */

import fs from "node:fs";
import path from "node:path";

import { type AgentConfig, agentTargetPath, BLOCK_START, BLOCK_END } from "./agent-registry.js";
import { getSkillPaths } from "./skill-install.js";

export interface AgentInstallOptions {
  /** Override the bundled SKILL.md source path. */
  readonly source?: string;
}

/** Strip the YAML frontmatter block from SKILL.md content. */
function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end >= 0) {
      return content.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  return content;
}

/** Remove a previously installed marker block (idempotent). */
function removeBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  if (start < 0) return content;
  const end = content.indexOf(BLOCK_END, start);
  if (end < 0) return content;
  const before = content.slice(0, start).replace(/\s+$/, "");
  const after = content.slice(end + BLOCK_END.length).replace(/^\s+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/**
 * Install the skill for one agent. Returns the target path written.
 * Instructions-type installs are idempotent: an existing marker block is
 * replaced instead of appended twice.
 */
export function installToAgent(agent: AgentConfig, options?: AgentInstallOptions): string {
  const source = options?.source ?? getSkillPaths().source;
  if (!fs.existsSync(source)) throw new Error("skill source not found");
  const target = agentTargetPath(agent);
  const raw = fs.readFileSync(source, "utf8");
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (agent.type === "skill") {
    fs.copyFileSync(source, target);
    return target;
  }

  // instructions: replace any existing block, then append the new one.
  const body = stripFrontmatter(raw).trim();
  const block = `${BLOCK_START}\n${body}\n${BLOCK_END}`;
  let existing = "";
  if (fs.existsSync(target)) {
    existing = removeBlock(fs.readFileSync(target, "utf8")).trimEnd();
  }
  const merged = existing.length > 0 ? `${existing}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(target, merged, "utf8");
  return target;
}

/**
 * Remove the skill from one agent. Returns `true` when something was
 * removed; `false` when the skill was not installed (no-op).
 */
export function uninstallFromAgent(agent: AgentConfig): boolean {
  const target = agentTargetPath(agent);
  if (!fs.existsSync(target)) return false;

  if (agent.type === "skill") {
    // The skill directory is dedicated to this skill — remove it entirely.
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    return true;
  }

  // instructions: only remove the marker block, keep the user's own content.
  const content = fs.readFileSync(target, "utf8");
  if (!content.includes(BLOCK_START)) return false;
  const stripped = removeBlock(content);
  if (stripped.trim().length === 0) {
    fs.rmSync(target, { force: true });
  } else {
    fs.writeFileSync(target, stripped, "utf8");
  }
  return true;
}
