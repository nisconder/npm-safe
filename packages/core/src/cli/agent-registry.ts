/**
 * Registry of AI coding agents supported by the npm-safe-scan skill
 * installer. Each agent has its own conventions for where skills or
 * instructions live and in which format.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How an agent consumes the skill. */
export type AgentType = "skill" | "instructions";

export interface AgentConfig {
  /** Stable identifier used by the `--agent` option (e.g. `claude-code`). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Installation strategy. */
  readonly type: AgentType;
}

/** Skill directory/file name used by skill-type agents. */
export const SKILL_NAME = "npm-safe-scan";

/** Markers wrapping the skill inside instructions-type files. */
export const BLOCK_START = `<!-- >>> ${SKILL_NAME} skill >>> -->`;
export const BLOCK_END = `<!-- <<< ${SKILL_NAME} skill <<< -->`;

/** Fixed display order of the supported agents. */
export const AGENTS: readonly AgentConfig[] = [
  { id: "codex", name: "Codex", type: "instructions" },
  { id: "claude-code", name: "Claude Code", type: "skill" },
  { id: "opencode", name: "OpenCode", type: "instructions" },
  { id: "trae", name: "Trae", type: "skill" },
  { id: "qoder", name: "Qoder", type: "skill" },
  { id: "zcode", name: "Zcode", type: "skill" },
  { id: "gemini-cli", name: "Gemini CLI", type: "instructions" },
];

/** Resolve an agent by id. Returns `undefined` for unknown ids. */
export function getAgentById(id: string): AgentConfig | undefined {
  return AGENTS.find((a) => a.id === id);
}

/**
 * Parse a comma-separated list of agent ids (as given to `--agent`).
 * Throws with the unknown id in the message when an id is not registered.
 */
export function parseAgentIds(raw: string): AgentConfig[] {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.map((id) => {
    const agent = getAgentById(id);
    if (!agent) throw new Error(`unknown agent id "${id}"`);
    return agent;
  });
}

/**
 * Absolute path of the file the skill is installed into for a given agent.
 * Every supported agent is user-level under the home directory.
 */
export function agentTargetPath(agent: AgentConfig): string {
  const home = os.homedir();
  switch (agent.id) {
    case "codex":
      return path.join(home, ".codex", "AGENTS.md");
    case "claude-code":
      return path.join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
    case "opencode":
      return path.join(home, ".config", "opencode", "AGENTS.md");
    case "trae":
      return path.join(home, ".trae", "skills", SKILL_NAME, "SKILL.md");
    case "qoder":
      return path.join(home, ".qoder", "skills", SKILL_NAME, "SKILL.md");
    case "zcode":
      return path.join(home, ".zcode", "skills", SKILL_NAME, "SKILL.md");
    case "gemini-cli":
      return path.join(home, ".gemini", "GEMINI.md");
    default:
      throw new Error(`unknown agent id "${agent.id}"`);
  }
}

/** Whether the skill is currently installed for a given agent. */
export function isAgentInstalled(agent: AgentConfig): boolean {
  const target = agentTargetPath(agent);
  if (!fs.existsSync(target)) return false;
  if (agent.type === "instructions") {
    try {
      return fs.readFileSync(target, "utf8").includes(BLOCK_START);
    } catch {
      return false;
    }
  }
  return true;
}

/** Pretty-print a path using `~` for the home directory. */
export function displayPath(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}
