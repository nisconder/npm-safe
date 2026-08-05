import { Command } from "commander";
import { installSkill, uninstallSkill, isSkillInstalled } from "./skill-install.js";

export function registerSkillCommand(program: Command): void {
  const skill = program.command("skill").description("Manage the npm-safe-scan agent skill");

  skill
    .command("install")
    .description("Install the agent skill to ~/.agents/skills/")
    .action(() => {
      try {
        const { path: p } = installSkill();
        console.log(`[npm-safe] skill installed to ${p}`);
      } catch (err) {
        console.error(`[npm-safe] skill install failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  skill
    .command("status")
    .description("Show whether the agent skill is installed")
    .action(() => {
      console.log(isSkillInstalled() ? "[npm-safe] skill installed" : "[npm-safe] skill not installed");
    });

  skill
    .command("uninstall")
    .description("Remove the agent skill")
    .action(() => {
      uninstallSkill();
      console.log("[npm-safe] skill removed");
    });
}
