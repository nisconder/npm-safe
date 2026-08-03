#!/usr/bin/env node
// Installs the npm-safe-scan agent skill into the user's global agent-skill
// directory (~/.agents/skills) so any AI agent can auto-load it. Runs as
// the package `postinstall` hook.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Dev-install guard -----------------------------------------------------
// Skip when this is a workspace/dev install (e.g. `pnpm install` at the repo
// root during development): INIT_CWD points at the workspace root, which is
// the pnpm-workspace.yaml directory. Real installs (tarball/registry) run
// with INIT_CWD set to the user's project, which is NOT inside this package.
const packageRoot = path.resolve(__dirname, "..");
// Find the workspace root (dir containing pnpm-workspace.yaml), if any.
let workspaceRoot = null;
for (let dir = packageRoot; dir !== path.dirname(dir); dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    workspaceRoot = dir;
    break;
  }
}
const initCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : "";
const isDevWorkspaceInstall =
  initCwd !== "" &&
  (initCwd === packageRoot ||
    initCwd === workspaceRoot ||
    (workspaceRoot !== null && initCwd.startsWith(workspaceRoot + path.sep)));
if (isDevWorkspaceInstall) {
  process.exit(0); // development install — skip skill install
}

const source = path.join(packageRoot, "skill", "npm-safe-scan", "SKILL.md");
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
