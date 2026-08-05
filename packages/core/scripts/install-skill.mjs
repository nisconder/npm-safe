#!/usr/bin/env node
// Asks the user whether to install the npm-safe-scan agent skill into
// ~/.agents/skills during package installation. Skips silently in
// non-interactive (CI / piped) environments and never fails the install.

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

// --- Interactive detection -------------------------------------------------
// A real terminal AND not a CI environment. CI runners pipe stdin, so
// process.stdin.isTTY is false there and we skip without prompting.
const isInteractive = () => Boolean(process.stdin.isTTY) && !process.env.CI;

async function askYesNo(question) {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/n] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const source = path.join(packageRoot, "skill", "npm-safe-scan", "SKILL.md");
const targetDir = path.join(os.homedir(), ".agents", "skills", "npm-safe-scan");
const target = path.join(targetDir, "SKILL.md");

async function main() {
  try {
    if (!isInteractive()) {
      process.exit(0); // CI or piped — skip silently, never hang
    }
    if (!fs.existsSync(source)) {
      console.warn("[npm-safe] skill source not found; skipping skill install.");
      process.exit(0);
    }
    const ok = await askYesNo("是否安装 npm-safe-scan 技能（供 AI 代理使用）？");
    if (!ok) {
      console.log("[npm-safe] 跳过技能安装。稍后可用 `npm-safe skill install` 安装。");
      process.exit(0);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, target);
    console.log(`[npm-safe] skill installed to ${target}`);
  } catch (err) {
    // A skill install failure must never break the package install.
    console.warn(`[npm-safe] could not install skill: ${err.message}`);
    process.exit(0);
  }
}

main();
