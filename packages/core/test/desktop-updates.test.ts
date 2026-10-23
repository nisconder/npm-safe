import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../desktop/resources/js/main.js", import.meta.url), "utf8")
  .split("Neutralino.init();")[0];

async function update(manifest: Record<string, unknown>, choice = "YES") {
  const calls: string[] = [];
  const context = vm.createContext({
    NL_APPVERSION: "1.1.0",
    Neutralino: {
      updater: {
        checkForUpdates: async (url: string) => {
          assert.strictEqual(url, "https://github.com/nisconder/npm-safe/releases/latest/download/update_manifest_v2.json");
          return manifest;
        },
        install: async () => { calls.push("install-resources"); },
      },
      os: {
        showMessageBox: async () => { calls.push("prompt"); return choice; },
        open: async (url: string) => { calls.push(url); },
      },
      app: { restartProcess: async () => { calls.push("restart"); } },
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext("checkForUpdates()", context);
  return calls;
}

describe("desktop complete-package updates", () => {
  it("opens the complete download without replacing only resources", async () => {
    const calls = await update({ version: "1.1.1", data: { requiresFullDownload: true } });
    assert.deepStrictEqual(calls, ["prompt", "https://github.com/nisconder/npm-safe/releases/latest"]);
  });

  it("does not download anything when the user declines", async () => {
    assert.deepStrictEqual(await update({ version: "1.1.1", data: { requiresFullDownload: true } }, "NO"), ["prompt"]);
  });

  it("retains resource-only updates for manifests that explicitly allow them", async () => {
    assert.deepStrictEqual(await update({ version: "1.1.1" }), ["prompt", "install-resources", "restart"]);
  });
});
