#!/usr/bin/env node
// Installs the npm-safe-scan agent skill into the user's global agent-skill
// directory (~/.agents/skills) so any agent (opencode, Claude Code) can
// auto-load it. Runs as the package `postinstall` hook.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Dev-install guard -----------------------------------------------------
// When @npm-safe/core is installed as a workspace package (e.g. `pnpm install`
// at the repo root during development), postinstall fires for the workspace
// package too. Skip the skill copy in that case so dev installs do not touch
// the global skill dir; only real installs (tarball/registry) install it.
const packageRoot = path.resolve(__dirname, "..");
const initCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : "";
const isDevWorkspaceInstall =
  initCwd !== "" &&
  (initCwd === packageRoot || initCwd === path.dirname(packageRoot));
if (isDevWorkspaceInstall) {
  process.exit(0); // development install — skip skill install
}

const source = path.join(packageRoot, "opencode-skill", "npm-safe-scan", "SKILL.md");
const targetDir = path.join(os.homedir(), ".agents", "skills", "npm-safe-scan");
const target = path.join(targetDir, "SKILL.md");

if (!fs.existsSync(source)) {
  console.warn("[npm-safe] skill source not found; skipping skill install.");
  process.exit(0); // do not fail the install
}

try {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`[npm-safe] skill installed to ${target}`);
} catch (err) {
  // A skill install failure must NOT break package installation.
  console.warn(`[npm-safe] could not install skill: ${err.message}`);
  process.exit(0);
}
