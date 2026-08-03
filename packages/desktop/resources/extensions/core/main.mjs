/**
 * Node.js extension for the npm-safe Neutralinojs desktop app.
 *
 * Bridges the Neutralinojs frontend with the @npm-safe/core engine via
 * WebSocket IPC. The engine runs entirely inside this extension process,
 * which is spawned by the Neutralinojs main process at startup.
 *
 * Protocol:
 *   frontend -> extension: { "event": "<method>", "data": <params> }
 *   extension -> frontend: { "event": "<method>:response", "data": <result> }
 *   extension -> frontend: { "event": "<method>:error", "data": { message } }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NpmSafeEngine } from "@npm-safe/core";

// ---------------------------------------------------------------------------
// Startup: read connectivity info passed via stdin by the Neutralinojs server
// ---------------------------------------------------------------------------

const processInput = JSON.parse(fs.readFileSync(process.stdin.fd, "utf8"));
const NL_PORT = processInput.nlPort;
const NL_TOKEN = processInput.nlToken;
const NL_CTOKEN = processInput.nlConnectToken;
const NL_EXTID = processInput.nlExtensionId;

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

const engine = new NpmSafeEngine({
  dbPath: path.join(os.homedir(), ".npm-safe", "npm-safe.db"),
});

// ---------------------------------------------------------------------------
// WebSocket connection to the Neutralinojs server
// ---------------------------------------------------------------------------

const ws = new WebSocket(
  `ws://localhost:${NL_PORT}?extensionId=${NL_EXTID}&connectToken=${NL_CTOKEN}`,
);

ws.onopen = () => {
  log("Connected to Neutralinojs server");
  // Notify the frontend that the engine is ready so it can hydrate
  // persisted user preferences (theme, last tab) from the settings table.
  send("engineReady", {});
};

ws.onclose = async () => {
  log("Connection closed, shutting down");
  try {
    engine.close();
  } catch {
    // already closed
  }
  process.exit(0);
};

ws.onerror = (err) => {
  log(`WebSocket error: ${err.message ?? err}`, "ERROR");
};

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

const SUPPORTED_METHODS = new Set([
  "checkPackage",
  "searchPackages",
  "getWatchlist",
  "addToWatchlist",
  "removeFromWatchlist",
  "refreshPackage",
  "refreshAll",
  "getSetting",
  "setSetting",
  "getHistory",
  "addHistory",
  "clearHistory",
  "listRules",
  "setRuleEnabled",
  "setRuleSeverity",
  "setRuleOptions",
  "loadRulePlugins",
  "getLlmStatus",
  "setLlmConfig",
  "testLlmConnection",
]);

const HISTORY_DIR = path.join(os.homedir(), ".npm-safe");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");

// One-time migration: the pre-database builds stored check history in
// history.json. Import it into the shared check_history table (which the CLI
// also writes) and remove the legacy file.
async function migrateLegacyHistory() {
  try {
    const current = await engine.getCheckHistory(1);
    if (current.length > 0) return;
    if (!fs.existsSync(HISTORY_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (!Array.isArray(legacy)) return;
    for (const entry of legacy) {
      if (!entry?.packageName) continue;
      await engine.recordHistoryEntry({
        packageName: entry.packageName,
        level: entry.level ?? "unknown",
        score: typeof entry.score === "number" ? entry.score : 0,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      });
    }
    fs.rmSync(HISTORY_FILE, { force: true });
    log(`Migrated ${legacy.length} legacy history entries into the database`);
  } catch (err) {
    log(`migrateLegacyHistory failed: ${err.message}`, "ERROR");
  }
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // Skip native method responses (e.g. ACKs for our own app.broadcast calls).
  if (msg.method) return;
  const method = msg.event;
  // Ignore framework-internal events (appClientConnect, clientConnect, ...).
  if (!method || !SUPPORTED_METHODS.has(method)) return;
  const data = msg.data;
  void handle(method, data);
};

async function handle(method, data) {
  const requestId = data?._requestId ?? crypto.randomUUID();
  try {
    const result = await invoke(method, data);
    send(`${method}:response`, { requestId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`invoke ${method} failed: ${message}`, "ERROR");
    send(`${method}:error`, { requestId, message });
  }
}

function log(message, type = "INFO") {
  const line = `[${NL_EXTID}] ${type} ${message}\n`;
  try {
    fs.appendFileSync(path.join(os.tmpdir(), "npmsafe-extension.log"), line);
  } catch {
    // ignore
  }
  console.log(line.trimEnd());
}

async function invoke(method, data) {
  switch (method) {
    case "checkPackage": {
      const result = await engine.checkPackage(data.name);
      if (result.exists && result.security) {
        await engine.recordCheckHistory(result);
      }
      return result;
    }
    case "searchPackages":
      return await engine.searchPackages(data.query, data.size ?? 20);
    case "getWatchlist":
      return await engine.getWatchlist();
    case "addToWatchlist": {
      const result = await engine.checkPackage(data.name);
      if (!result.exists) {
        throw new Error(`Package not found: ${data.name}`);
      }
      await engine.addToWatchlist(data.name);
      return null;
    }
    case "removeFromWatchlist":
      await engine.removeFromWatchlist(data.name);
      return null;
    case "refreshPackage":
      await engine.refreshPackage(data.name);
      return null;
    case "refreshAll":
      await engine.refreshAll();
      return null;
    case "getSetting":
      return await engine.getSetting(data.key);
    case "setSetting":
      await engine.setSetting(data.key, data.value);
      return null;
    case "getHistory":
      await migrateLegacyHistory();
      return await engine.getCheckHistory();
    case "addHistory":
      await engine.recordHistoryEntry({
        packageName: data.packageName,
        level: data.level,
        score: data.score,
        timestamp: data.timestamp ?? new Date().toISOString(),
      });
      return null;
    case "clearHistory":
      await engine.clearCheckHistory();
      fs.rmSync(HISTORY_FILE, { force: true });
      return null;
    case "listRules":
      return engine.listRules();
    case "setRuleEnabled":
      engine.setRuleEnabled(data.ruleId, data.enabled);
      return null;
    case "setRuleSeverity":
      engine.setRuleSeverity(data.ruleId, data.severity);
      return null;
    case "setRuleOptions":
      engine.setRuleOptions(data.ruleId, data.options);
      return null;
    case "loadRulePlugins":
      return await engine.loadRulePlugins(data.dir);
    case "getLlmStatus":
      return engine.getLlmStatus();
    case "setLlmConfig":
      engine.setLlmConfig(data);
      return null;
    case "testLlmConnection":
      return await engine.testLlmConnection();
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function send(event, data) {
  ws.send(
    JSON.stringify({
      id: crypto.randomUUID(),
      method: "app.broadcast",
      accessToken: NL_TOKEN,
      data: { event, data },
    }),
  );
}
