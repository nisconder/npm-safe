/**
 * Shared logic for installing, removing, and checking the npm-safe-scan
 * agent skill. Used by the CLI `skill` command.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillPaths {
  readonly source: string;
  readonly targetDir: string;
  readonly target: string;
}

/**
 * Resolve the bundled skill source and the user-global install target.
 * `../../skill` resolves to package-root/skill from BOTH src/cli (dev via
 * tsx) and dist/cli (built) because tsc preserves the cli/ nesting under
 * dist/.
 */
export function getSkillPaths(): SkillPaths {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, "..", "..", "skill", "npm-safe-scan", "SKILL.md");
  const targetDir = path.join(os.homedir(), ".agents", "skills", "npm-safe-scan");
  return { source, targetDir, target: path.join(targetDir, "SKILL.md") };
}

/** Whether the skill is currently installed at the user-global path. */
export function isSkillInstalled(): boolean {
  const { target } = getSkillPaths();
  return fs.existsSync(target);
}

/**
 * Install the skill into the user's global agent-skill directory.
 *
 * @returns The installed target path.
 * @throws When the bundled skill source is missing.
 */
export function installSkill(): { installed: boolean; path: string } {
  const { source, targetDir, target } = getSkillPaths();
  if (!fs.existsSync(source)) throw new Error("skill source not found");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  return { installed: true, path: target };
}

/** Remove the skill from the user's global agent-skill directory. */
export function uninstallSkill(): void {
  const { targetDir } = getSkillPaths();
  fs.rmSync(targetDir, { recursive: true, force: true });
}

/**
 * True when stdin is a real terminal AND the process is not running in a CI
 * environment (where a prompt would hang or be inappropriate).
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.CI;
}

/**
 * Ask a yes/no question on the terminal. Returns `true` on y/yes.
 * When non-interactive (CI or piped stdin), returns `false` without
 * prompting. Never throws.
 */
export async function confirmInstall(prompt: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
