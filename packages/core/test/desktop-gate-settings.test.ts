import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(
  fileURLToPath(new URL("../../desktop/resources/js/main.js", import.meta.url)),
  "utf8",
).split("Neutralino.init();")[0];

interface SettingWrite {
  readonly key: string;
  readonly value: string;
}

function gateForm(threshold: string, failThreshold = false) {
  const writes: SettingWrite[] = [];
  const elements: Record<string, any> = {
    "gate-save-btn": { textContent: "保存", dataset: {}, disabled: false },
    "gate-enabled": { checked: true },
    "gate-threshold": { value: threshold },
    "status-bar": { textContent: "", className: "" },
  };
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements[id] },
    testCallEngine: async (method: string, data: SettingWrite) => {
      if (method === "getSetting") return data.key === "installGate.enabled" ? "true" : threshold;
      assert.strictEqual(method, "setSetting");
      writes.push({ key: data.key, value: data.value });
      if (failThreshold && data.key === "installGate.threshold") {
        throw new Error("threshold save failed");
      }
    },
  });
  vm.runInContext(source, context);
  vm.runInContext("callEngine = testCallEngine", context);
  return {
    writes,
    elements,
    save: () => vm.runInContext("handleGateSave()", context) as Promise<void>,
    load: () => vm.runInContext("renderInstallGate()", context) as Promise<void>,
  };
}

describe("desktop gate settings", () => {
  it("shows the effective default when a saved threshold is corrupt", async () => {
    for (const raw of ["", "85.5", "85oops", "-1", "101"]) {
      const form = gateForm(raw);
      await form.load();
      assert.strictEqual(form.elements["gate-threshold"].value, "85");
    }
  });
  it("rejects malformed thresholds without changing saved settings", async () => {
    for (const raw of ["", "85.5", "85oops", "1e2", "Infinity", "-1", "101"]) {
      const form = gateForm(raw);
      await form.save();
      assert.deepStrictEqual(form.writes, [], `must reject ${JSON.stringify(raw)}`);
      assert.strictEqual(form.elements["status-bar"].className, "status-bar error");
    }
  });

  it("saves integer thresholds before enabling the gate", async () => {
    for (const raw of ["0", " 85 ", "100"]) {
      const form = gateForm(raw);
      await form.save();
      assert.deepStrictEqual(form.writes, [
        { key: "installGate.threshold", value: raw.trim() },
        { key: "installGate.enabled", value: "true" },
      ]);
      assert.strictEqual(form.elements["status-bar"].className, "status-bar success");
      assert.strictEqual(form.elements["gate-save-btn"].disabled, false);
    }
  });

  it("leaves the gate disabled when its threshold could not be saved", async () => {
    const form = gateForm("90", true);
    await form.save();
    assert.deepStrictEqual(form.writes, [{ key: "installGate.threshold", value: "90" }]);
    assert.strictEqual(form.elements["status-bar"].textContent, "threshold save failed");
    assert.strictEqual(form.elements["gate-save-btn"].disabled, false);
  });
});
