import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assertPublicInstallRegistry } from "../src/cli/install-registry.js";

function relevantEnvironment(key: string): boolean {
  return /^(?:npm_config_|yarn_|home$|userprofile$)/i.test(key);
}

describe("install gate public registry provenance", () => {
  let home: string;
  let project: string;
  let previousEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    previousEnvironment = { ...process.env };
    for (const key of Object.keys(process.env)) if (relevantEnvironment(key)) delete process.env[key];
    home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-registry-"));
    project = path.join(home, "project", "child");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(home, "project", "package.json"), JSON.stringify({ name: "registry-test-project", version: "1.0.0" }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.npm_config_globalconfig = path.join(home, "global.npmrc");
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (relevantEnvironment(key)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    rmSync(home, { recursive: true, force: true });
  });

  it("allows absent configuration and explicitly public registry settings", () => {
    assert.doesNotThrow(() => assertPublicInstallRegistry(project));
    process.env.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
    writeFileSync(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org\n@acme:registry='https://registry.npmjs.org/'\n");
    writeFileSync(path.join(home, "project", ".npmrc"), "\uFEFF; registry=https://ignored.test\nregistry=\"https://registry.npmjs.org:443/\" # public\n");
    writeFileSync(path.join(project, ".yarnrc.yml"), "npmScopes:\n  acme:\n    npmRegistryServer: https://registry.npmjs.org/ # public\n");
    assert.doesNotThrow(() => assertPublicInstallRegistry(project));
  });

  it("rejects non-public registry environment variables including scoped overrides", () => {
    for (const key of ["npm_config_registry", "NPM_CONFIG_REGISTRY", "npm_config_@acme:registry", "YARN_NPM_REGISTRY_SERVER", "YARN_REGISTRY"]) {
      process.env[key] = "https://private.example/";
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/, key);
      delete process.env[key];
    }
  });

  it("rejects deceptive URLs, credentials, HTTP and registry URL subpaths", () => {
    for (const registry of ["http://registry.npmjs.org/", "https://registry.npmjs.org.evil.test/", "https://registry.npmjs.org/private", "https://user:secret@registry.npmjs.org/", "https://registry.npmjs.org/?source=other", "not-a-url"]) {
      writeFileSync(path.join(project, ".npmrc"), `registry=${registry}\n`);
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    }
  });

  it("checks project ancestors and the user config even when another value shadows it", () => {
    process.env.npm_config_registry = "https://registry.npmjs.org/";
    for (const directory of [project, path.dirname(project), home]) {
      const filename = path.join(directory, ".npmrc");
      writeFileSync(filename, "@acme:registry=https://private.example/\n");
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
      rmSync(filename);
    }
  });

  it("ignores a private npmrc above the actual project root", () => {
    const ancestor = path.join(home, "unrelated-ancestor");
    const projectRoot = path.join(ancestor, "project");
    const child = path.join(projectRoot, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "isolated-project", version: "1.0.0" }));
    writeFileSync(path.join(ancestor, ".npmrc"), "registry=https://private.example/\n");
    assert.doesNotThrow(() => assertPublicInstallRegistry(child));
  });

  it("includes a pnpm or npm workspace root configuration", () => {
    const workspace = path.join(home, "workspace");
    const projectRoot = path.join(workspace, "packages", "child");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "workspace-child", version: "1.0.0" }));
    writeFileSync(path.join(workspace, ".npmrc"), "registry=https://private.example/\n");
    writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    assert.throws(() => assertPublicInstallRegistry(projectRoot), /Cannot verify install registry/);
    rmSync(path.join(workspace, "pnpm-workspace.yaml"));
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    assert.throws(() => assertPublicInstallRegistry(projectRoot), /Cannot verify install registry/);
  });

  it("checks redirected user/global config and resolves environment values", () => {
    const custom = path.join(home, "custom.npmrc");
    process.env.npm_config_userconfig = custom;
    process.env.TEST_GATE_REGISTRY = "https://registry.npmjs.org/";
    try {
      writeFileSync(custom, "registry=${TEST_GATE_REGISTRY}\n");
      assert.doesNotThrow(() => assertPublicInstallRegistry(project));
      process.env.TEST_GATE_REGISTRY = "https://private.example/";
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
      delete process.env.TEST_GATE_REGISTRY;
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
      writeFileSync(custom, "registry=https://registry.npmjs.org/\n");
      writeFileSync(process.env.npm_config_globalconfig!, "registry=https://private.example/\n");
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    } finally {
      if (previousEnvironment.TEST_GATE_REGISTRY === undefined) delete process.env.TEST_GATE_REGISTRY;
      else process.env.TEST_GATE_REGISTRY = previousEnvironment.TEST_GATE_REGISTRY;
    }
  });

  it("checks Yarn root, scoped and classic registry configuration", () => {
    for (const content of [
      "npmRegistryServer: https://private.example/\n",
      "npmScopes:\n  acme:\n    npmRegistryServer: https://private.example/\n",
      "npmScopes: {acme: {npmRegistryServer: https://private.example/}}\n",
      "npmRegistryServer: ${MISSING_GATE_REGISTRY}\n",
      "npmRegistryServer: >\n  https://private.example/\n",
    ]) {
      writeFileSync(path.join(project, ".yarnrc.yml"), content);
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    }
    rmSync(path.join(project, ".yarnrc.yml"));
    writeFileSync(path.join(home, ".yarnrc"), 'registry "https://private.example/"\n');
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
  });

  it("rejects ambiguous registry arrays, YAML aliases and unreadable config paths", () => {
    writeFileSync(path.join(project, ".npmrc"), "registry[]=https://registry.npmjs.org/\n");
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    rmSync(path.join(project, ".npmrc"));
    writeFileSync(path.join(project, ".yarnrc.yml"), "defaults: &settings\n  npmRegistryServer: https://registry.npmjs.org/\nnpmScopes:\n  acme:\n    <<: *settings\n");
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    rmSync(path.join(project, ".yarnrc.yml"));
    mkdirSync(path.join(project, ".npmrc"));
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot read registry configuration/);
  });

  it("honors a custom Yarn configuration filename", () => {
    process.env.YARN_RC_FILENAME = "custom-yarn.yml";
    writeFileSync(path.join(home, "project", "custom-yarn.yml"), 'npmRegistryServer: "https://private.example/"\n');
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
  });

  it("treats environment config filenames containing comment characters literally", () => {
    const custom = path.join(home, "custom # registry.npmrc");
    writeFileSync(custom, "registry=https://private.example/\n");
    process.env.npm_config_userconfig = custom;
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
  });

  it("decodes quoted registry keys and rejects YAML keys it cannot resolve", () => {
    writeFileSync(path.join(project, ".npmrc"), '"\\u0072egistry"=https://private.example/\n');
    assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    rmSync(path.join(project, ".npmrc"));
    for (const content of [
      '"npmRegistry\\u0053erver": https://private.example/\n',
      '? npmRegistryServer\n: https://private.example/\n',
    ]) {
      writeFileSync(path.join(project, ".yarnrc.yml"), content);
      assert.throws(() => assertPublicInstallRegistry(project), /Cannot verify install registry/);
    }
  });

  it("does not expose credentials in registry validation errors", () => {
    writeFileSync(path.join(project, ".npmrc"), "registry=https://username:TOP_SECRET_TOKEN@private.example/\n");
    assert.throws(() => assertPublicInstallRegistry(project), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path.join(project, ".npmrc")));
      assert.ok(error.message.includes('"registry"'));
      assert.ok(!error.message.includes("TOP_SECRET_TOKEN"));
      assert.ok(!error.message.includes("username"));
      return true;
    });
  });
});
