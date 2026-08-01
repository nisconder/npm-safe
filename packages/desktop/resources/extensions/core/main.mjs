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
]);

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
    case "checkPackage":
      return await engine.checkPackage(data.name);
    case "searchPackages":
      return await engine.searchPackages(data.query, data.size ?? 20);
    case "getWatchlist":
      return await engine.getWatchlist();
    case "addToWatchlist":
      await engine.addToWatchlist(data.name);
      return null;
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
