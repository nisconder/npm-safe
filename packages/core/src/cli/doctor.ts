import { Command } from "commander";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DatabaseManager } from "../index.js";
import { getDefaultDbPath } from "./shared.js";
import {
  getShimDir,
  detectShellConfig,
  hasShellBlock,
  readGateConfig,
} from "./install-gate.js";

interface CheckResult {
  readonly ok: boolean;
  readonly label: string;
  readonly fix?: string;
}

/**
 * Run a diagnostic check, print the result, and count problems.
 */
function runCheck(
  ok: boolean,
  label: string,
  fix?: string,
  problems?: string[],
): void {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${label}`);
  if (!ok) {
    if (fix) console.log(`      ${fix}`);
    problems?.push(label);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the npm-safe installation and install-gate setup")
    .action(async () => {
      const problems: string[] = [];
      const pathParts = (process.env.PATH ?? "").split(path.delimiter).map((p) => path.resolve(p));

      console.log("npm-safe doctor");
      console.log(`  CLI: npm-safe (Node ${process.version})`);

      // 1. npm global bin directory reachable from PATH.
      const globalBin = getNpmGlobalBin();
      const globalBinInPath =
        globalBin !== null && pathParts.includes(path.resolve(globalBin));
      runCheck(
        globalBinInPath,
        `npm global bin in PATH: ${globalBin ?? "(not detected)"}`,
        globalBin
          ? `Run: setx PATH "${globalBin};%PATH%" (then reopen the terminal)`
          : "Cannot locate the npm global bin directory",
        problems,
      );

      // 2. Install gate switch.
      const config = await readGateConfig();
      runCheck(
        config.enabled,
        `Install gate: ${config.enabled ? "enabled" : "disabled"} (threshold ${config.threshold})`,
        "Run: npm-safe gate enable",
        problems,
      );

      // 3. Shell wrappers / PATH shims.
      if (process.platform === "win32") {
        const shimDir = getShimDir();
        const shimsExist = ["npm", "pnpm", "yarn"].every((pm) =>
          fs.existsSync(path.join(shimDir, `${pm}.cmd`)),
        );
        runCheck(
          shimsExist,
          `Command shims installed: ${shimDir}`,
          "Run: npm-safe gate shell",
          problems,
        );
        if (shimsExist) {
          const shimIndex = pathParts.indexOf(path.resolve(shimDir));
          runCheck(
            shimIndex >= 0,
            "Shim directory present in PATH",
            `Run: setx PATH "${shimDir};%PATH%" (then reopen the terminal)`,
            problems,
          );
          if (shimIndex >= 0) {
            // Authoritative check: `where npm.cmd` must resolve to the shim
            // first (the directory-index comparison is fragile against
            // duplicate PATH entries and case/short-path variants).
            let first = "";
            try {
              first =
                execFileSync("where", ["npm.cmd"], { encoding: "utf8" })
                  .split(/\r?\n/)
                  .find((l) => l.trim().length > 0) ?? "";
            } catch {
              first = "";
            }
            const shimFile = path.join(shimDir, "npm.cmd");
            const intercepted =
              first.length > 0 &&
              path.resolve(first).toLowerCase() === shimFile.toLowerCase();
            runCheck(
              intercepted,
              "npm resolves to the gate shim first (gate intercepts)",
              `Move the shim directory ahead of the real npm in PATH: setx PATH "${shimDir};%PATH%" (note: setx does not refresh running processes — log off/on or restart explorer.exe, then open a NEW terminal)`,
              problems,
            );
          }
        }
      } else {
        const rc = detectShellConfig();
        const installed = rc !== null && hasShellBlock(rc);
        runCheck(
          installed,
          `Shell wrappers installed: ${rc ?? "(no shell config detected)"}`,
          "Run: npm-safe gate shell",
          problems,
        );
      }

      // 4. Shared database is writable.
      const dbPath = getDefaultDbPath();
      try {
        const dbm = new DatabaseManager(dbPath);
        dbm.close();
        runCheck(true, `Database writable: ${dbPath}`, undefined, problems);
      } catch (err) {
        runCheck(
          false,
          `Database not writable: ${dbPath}`,
          `Check permissions: ${err instanceof Error ? err.message : String(err)}`,
          problems,
        );
      }

      if (problems.length > 0) {
        console.log(`\n${problems.length} problem(s) found:`);
        for (const p of problems) console.log(`  - ${p}`);
        process.exitCode = 1;
      } else {
        console.log("\nEverything looks good.");
      }
    });
}

/** Locate the npm global bin directory (e.g. %APPDATA%\npm on Windows). */
function getNpmGlobalBin(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, "npm") : null;
  }
  try {
    const out = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}
