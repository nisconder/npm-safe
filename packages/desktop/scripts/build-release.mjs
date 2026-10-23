import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "../..");
const require = createRequire(path.join(desktopRoot, "package.json"));
const neuCli = require.resolve("@neutralinojs/neu");
const neuRequire = createRequire(neuCli);
const { archiveFolder, extract } = neuRequire("zip-lib");
const { extractFile } = neuRequire("@electron/asar");
const platform = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform];
assert.ok(platform, `Unsupported release platform: ${process.platform}`);
assert.ok(["x64", "arm64"].includes(process.arch), `Unsupported architecture: ${process.arch}`);
assert.equal(Number(process.versions.node.split(".")[0]), 24, "Build releases with Node.js 24");

const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli && /pnpm/i.test(pnpmCli), "Run this builder using pnpm run build");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const config = readJson(path.join(desktopRoot, "neutralino.config.json"));
const corePackage = readJson(path.join(workspaceRoot, "packages/core/package.json"));
assert.equal(config.version, corePackage.version, "Desktop config and core versions must match");
assert.equal(readJson(path.join(desktopRoot, "package.json")).version, corePackage.version);

const releaseRoot = path.join(desktopRoot, "dist/release");
fs.mkdirSync(releaseRoot, { recursive: true });
const staging = fs.mkdtempSync(path.join(desktopRoot, "dist/.release-stage-"));
const project = path.join(staging, "project");
const app = path.join(project, "dist/npm-safe");
const target = `${platform}-${process.arch}`;

function run(binary, args, cwd = workspaceRoot) {
  const result = spawnSync(binary, args, { cwd, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "" } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Command failed: ${path.basename(binary)} ${args.join(" ")}`);
}

async function nodeLicense() {
  const root = path.dirname(process.execPath);
  for (const file of [process.env.NODE_LICENSE_FILE, path.join(root, "LICENSE"), path.resolve(root, "../LICENSE")]) {
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file);
  }
  const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Cannot retrieve the bundled Node.js license: ${response.status}`);
  const license = await response.text();
  assert.ok(license.includes("Node.js") && license.includes("Permission is hereby granted"));
  return license;
}

try {
  fs.mkdirSync(path.join(project, "bin"), { recursive: true });
  fs.cpSync(path.join(desktopRoot, "resources"), path.join(project, "resources"), { recursive: true });
  const binaryPlatform = { win32: "win", linux: "linux", darwin: "mac" }[process.platform];
  const suffix = process.platform === "win32" ? ".exe" : "";
  const neutralinoBinary = `neutralino-${binaryPlatform}_${process.arch}${suffix}`;
  fs.copyFileSync(path.join(desktopRoot, "bin", neutralinoBinary), path.join(project, "bin", neutralinoBinary));
  if (process.platform !== "win32") fs.chmodSync(path.join(project, "bin", neutralinoBinary), 0o755);

  // External Node processes cannot read scripts from resources.neu. Keep the
  // extension physical and resolve the deployed core without workspace links.
  const extension = path.join(project, "resources/extensions/core/main.mjs");
  const source = fs.readFileSync(extension, "utf8");
  assert.equal(source.split('from "@npm-safe/core"').length, 2, "Core extension import changed");
  fs.writeFileSync(extension, source.replace('from "@npm-safe/core"', 'from "../../../runtime/core/dist/index.js"'));
  const nodeName = `node${suffix}`;
  config.extensions = [{
    id: "js.npmsafe.core",
    command: `"\${NL_PATH}/runtime/${nodeName}" "\${NL_PATH}/resources/extensions/core/main.mjs"`,
  }];
  config.cli.extensionsPath = "/resources/extensions/";
  config.cli.distributionPath = "/dist/";
  config.cli.resourcesExclude = "(?:^|[\\\\/])extensions(?:[\\\\/]|$)";
  fs.writeFileSync(path.join(project, "neutralino.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  run(process.execPath, [neuCli, "build"], project);

  const runtime = path.join(app, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtime, nodeName));
  if (process.platform !== "win32") fs.chmodSync(path.join(runtime, nodeName), 0o755);
  fs.writeFileSync(path.join(runtime, "NODE-LICENSE.txt"), await nodeLicense());
  // Modern deploy derives a dedicated frozen lockfile from the workspace
  // lock. Legacy hoisted deploy disables lockfile use and must not be used.
  // Hoisting keeps transitive dependencies reachable after ZIP extraction.
  run(process.execPath, [pnpmCli, "--config.node-linker=hoisted", "--config.inject-workspace-packages=true",
    "--filter", "@npm-safe/core", "deploy", "--prod", "--frozen-lockfile", path.join(runtime, "core")]);
  fs.copyFileSync(path.join(workspaceRoot, "LICENSE"), path.join(runtime, "core/LICENSE"));
  fs.writeFileSync(path.join(app, "release-info.json"), `${JSON.stringify({
    version: corePackage.version, platform: process.platform, arch: process.arch,
    node: process.versions.node, requiresFullDownload: true,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(app, "README.txt"),
    `npm-safe ${corePackage.version} (${target})\n\nExtract the entire ZIP before opening npm-safe-${binaryPlatform}_${process.arch}${suffix}.\n` +
    "Node.js and the core engine are included. Keep the runtime and resources directories beside the application.\n" +
    "The OS webview runtime is required (WebView2 / WebKit / WebKitGTK).\n" +
    "For upgrades, download and extract the complete matching platform ZIP.\n");
  const packedConfig = JSON.parse(extractFile(path.join(app, "resources.neu"), "neutralino.config.json").toString());
  assert.equal(packedConfig.version, corePackage.version);
  assert.equal(packedConfig.extensions[0].command, config.extensions[0].command);

  // Dereference pnpm's links in ZIPs: Windows extraction must work without
  // Developer Mode, and no archived link may point back into the build machine.
  const zip = path.join(releaseRoot, `npm-safe-${target}.zip`);
  await archiveFolder(app, zip, { followSymlinks: true });
  const extracted = path.join(staging, "extracted app with spaces");
  await extract(zip, extracted);
  const bundledNode = path.join(extracted, "runtime", nodeName);
  const bundledExtension = path.join(extracted, "resources/extensions/core/main.mjs");
  assert.ok(fs.existsSync(bundledExtension), "The ZIP is missing its physical extension");
  run(bundledNode, ["--check", bundledExtension], extracted);
  const coreUrl = pathToFileURL(path.join(extracted, "runtime/core/dist/index.js")).href;
  run(bundledNode, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const { DatabaseManager, NpmSafeEngine } = await import(${JSON.stringify(coreUrl)});
    assert.equal(typeof NpmSafeEngine, 'function');
    assert.equal(typeof WebSocket, 'function');
    const db = new DatabaseManager(':memory:');
    try { assert.equal(db.getDb().prepare('SELECT 41 + 1 AS answer').get().answer, 42); }
    finally { db.close(); }
    console.log('Extracted release smoke check passed: core import, Node WebSocket, SQLite.');
  `], extracted);
  fs.copyFileSync(path.join(app, "resources.neu"), path.join(releaseRoot, `resources-${target}.neu`));
  if (process.platform === "win32" && process.arch === "x64") {
    fs.copyFileSync(zip, path.join(releaseRoot, "npm-safe-release.zip"));
    fs.copyFileSync(path.join(app, "resources.neu"), path.join(releaseRoot, "resources.neu"));
  }
  console.log(`Release ready: ${zip}`);
} finally {
  const relative = path.relative(path.join(desktopRoot, "dist"), staging);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Unsafe staging cleanup path");
  fs.rmSync(staging, { recursive: true, force: true });
}
