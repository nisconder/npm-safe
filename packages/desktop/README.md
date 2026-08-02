# @npm-safe/desktop

A [Neutralinojs](https://neutralino.js.org/) desktop GUI for the `@npm-safe/core` engine. It provides a Material You dashboard for checking, searching, watching, and refreshing npm package security assessments, with persistent check history and a custom borderless window. The UI language is Chinese (zh-CN).

## Features

- **Overview dashboard** — average security score shown on a half-circle gauge, a 7-day check histogram, total check count, risk breakdown (safe / suspicious / dangerous / unknown), and a recent-checks list (latest 8).
- **Check** — enter a package name (press Enter or click 检查) and view its security level, score, and detailed findings.
- **Search** — keyword search against the npm registry (1-250 results, default 20); click a result to jump straight to Check.
- **Watch** — add/remove packages from the watchlist and refresh individual or all watched packages.
- **Settings** — read/write arbitrary engine settings (e.g. `proxy`, `lang`).
- **Material You theming** — independent light/dark palettes (seed `#4f8cff`), toggled from the custom title bar and persisted in `localStorage`.
- **Custom window chrome** — borderless, transparent, draggable title bar with minimize and close buttons.
- **Persistent check history** — stored in `~/.npm-safe/history.json` (capped at 1000 entries) by the Node.js extension process.

## Screens (Tab Navigation)

The app uses a permanent navigation drawer with five tabs:

### 总览 (Overview)

Rendered from the persisted check history:

- **整体安全评分** — average score of all recorded checks, shown on a half-circle gauge (0-100). The arc color follows score thresholds: `>=80` safe, `>=50` suspicious, else dangerous.
- **近7日检查** — a 7-bar mini histogram counting checks per day over the last 7 days.
- **总检查次数** — total number of recorded checks.
- **风险分布** — counts per security level (安全 / 可疑 / 危险 / 未知).
- **最近检查** — the latest 8 checks with level badge and score; clicking an entry jumps to Check and runs it.

The dashboard is re-rendered every time you navigate back to the tab.

### 检查 (Check)

- Enter a package name and click **检查** (or press Enter).
- The result card shows: package name, latest version, security level (colored badge), score `/100`, number of findings, plus (when available) description, homepage, and repository URL.
- Each finding lists its severity (`[CRITICAL]`, `[HIGH]`, etc.), rule id and name, message, recommendation, and code snippet / line number when present.
- If the package does not exist on the registry, a "未找到" card is shown.

### 搜索 (Search)

- Enter keywords and an optional result count (1-250, default 20), then click **搜索** (or press Enter).
- Each result shows `name@version`, description, and search score.
- Clicking a result switches to the Check tab, fills the package name, and runs the check automatically.

### 监控 (Watch)

- Type a package name and click **添加** to add it to the watchlist (the package must exist on the registry).
- Each list item offers **检查** (jump to Check) and **移除** (remove) actions.
- **刷新全部** refreshes all watched packages at once; the button shows a "处理中..." busy state during the request.

### 设置 (Settings)

- Read a setting: enter a key (e.g. `proxy`, `lang`) and click **读取**.
- Write a setting: enter a key and value, then click **写入**.
- Results are shown inline; unset keys display "(未设置)".

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later (global `fetch` required)
- [pnpm](https://pnpm.io/) 9 or later
- A webview runtime: WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux
- Neutralinojs binaries are fetched by the `@neutralinojs/neu` CLI (devDependency)

## Run in Development

From the repository root, install dependencies first:

```bash
pnpm install
```

Then launch the desktop app:

```bash
cd packages/desktop
pnpm run run
```

The `run` script builds `@npm-safe/core` first, then starts the app with `neu run`.

## Build a Release Bundle

```bash
cd packages/desktop
pnpm run build
```

The `build` script runs `pnpm run build:core && neu build --release` and outputs the release bundle via Neutralinojs.

## Windows First-Run Notes

If the WebView2 window fails to load with a loopback error, run once in an
administrator PowerShell:

```powershell
CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"
```

## Architecture

The desktop app is a three-layer Neutralinojs application:

```
┌─────────────────────────────────────────────────────┐
│  Frontend  resources/                               │
│  index.html + styles.css + js/main.js              │
│  (Material You UI, IPC bridge via neutralino.js)   │
└───────────────────────┬─────────────────────────────┘
                        │ WebSocket IPC (extensions.dispatch)
┌───────────────────────▼─────────────────────────────┐
│  Extension  resources/extensions/core/main.mjs     │
│  Node.js process hosting NpmSafeEngine (12 methods)│
│  History persistence → ~/.npm-safe/history.json    │
└───────────────────────┬─────────────────────────────┘
                        │ spawns & manages
┌───────────────────────▼─────────────────────────────┐
│  Neutralinojs server  neutralino.config.json       │
│  window mode, extension declaration, allowlist     │
└─────────────────────────────────────────────────────┘
```

### Frontend (`resources/`)

- `index.html` — Material You UI: permanent navigation drawer (5 tabs), custom title bar (drag region, theme toggle, minimize/close buttons), top app bar, per-tab panels, and a bottom status bar.
- `styles.css` — Material 3 tonal palette from seed `#4f8cff` with dedicated light/dark variable sets; M3 elevation tints; safe/suspicious/dangerous state colors.
- `js/main.js` — frontend logic:
  - `callEngine(method, data)` dispatches every engine call to the extension with a `_requestId` and a **30-second timeout**.
  - `registerEngineEvents()` / `registerHistoryEvents()` wire the `:response` / `:error` events back to pending promises.
  - Tab navigation, title-bar window controls (`setDraggableRegion`, `minimize`, `app.exit`), theme persistence under the `npm-safe-theme` key.
  - All user-provided strings are HTML-escaped before rendering (`escapeHtml` / `escapeAttr`) to prevent XSS.
- `js/neutralino.js` / `js/neutralino.d.ts` — Neutralinojs client library and types (6.9.0).

### Extension (`resources/extensions/core/main.mjs`)

A Node.js process spawned by the Neutralinojs server (declared in `neutralino.config.json` as `js.npmsafe.core`). It:

- Owns the `NpmSafeEngine` instance backed by SQLite at `~/.npm-safe/npm-safe.db`.
- Exposes **12 IPC methods**: `checkPackage`, `searchPackages`, `getWatchlist`, `addToWatchlist`, `removeFromWatchlist`, `refreshPackage`, `refreshAll`, `getSetting`, `setSetting`, `getHistory`, `addHistory`, `clearHistory`.
- Maintains check history in `~/.npm-safe/history.json` (unshift, capped at 1000 entries; `checkPackage` records an entry automatically when the package exists and a security report is produced).
- Writes diagnostic logs to `%TEMP%/npmsafe-extension.log` (Windows) or `$TMPDIR/npmsafe-extension.log` (macOS/Linux).
- Closes the engine and exits when the WebSocket connection to the server drops.

### IPC Protocol

```
frontend → extension:  { "event": "<method>", "data": <params> }
extension → frontend:  { "event": "<method>:response", "data": { requestId, result } }
extension → frontend:  { "event": "<method>:error", "data": { requestId, message } }
```

### App Configuration (`neutralino.config.json`)

- `applicationId`: `org.npmsafe.desktop`
- Window mode: 1100×750 (min 800×550), centered, `borderless` + `transparent`, resizable.
- Extension: `js.npmsafe.core` → `node ${NL_PATH}/resources/extensions/core/main.mjs`.
- `nativeAllowList`: `app.*`, `os.*`, `window.*`, `extensions.*`, `filesystem.*`, `debug.log`.
- `tokenSecurity`: `one-time`; binary/client version 6.9.0.

## Data Locations

| Data | Path |
|---|---|
| SQLite database | `~/.npm-safe/npm-safe.db` |
| Check history | `~/.npm-safe/history.json` |
| Extension log | `%TEMP%/npmsafe-extension.log` (Windows) / `$TMPDIR/npmsafe-extension.log` (macOS/Linux) |
| Theme preference | `localStorage` key `npm-safe-theme` |

## Directory Structure

```
packages/desktop/
├── package.json                # @npm-safe/desktop scripts (run, build)
├── neutralino.config.json      # Neutralino app config (window, extensions, allowlist)
├── resources/
│   ├── index.html              # Material You UI with Navigation Drawer
│   ├── styles.css              # M3 light/dark themes, custom title bar
│   ├── js/
│   │   ├── main.js             # frontend IPC bridge + dashboard logic
│   │   ├── neutralino.js       # Neutralinojs client library
│   │   └── neutralino.d.ts     # Neutralinojs type definitions
│   ├── icons/
│   │   ├── appIcon.png         # app icon
│   │   ├── trayIcon.png        # tray icon
│   │   └── logo.gif            # logo animation
│   └── extensions/
│       └── core/main.mjs       # Node.js extension hosting NpmSafeEngine
```

## Troubleshooting

- **WebView2 loopback error on Windows** — run the `CheckNetIsolation.exe` command from [Windows First-Run Notes](#windows-first-run-notes).
- **Engine requests time out after 30s** — the status bar shows the timeout error; check network connectivity (a `proxy` setting may be required on restricted networks).
- **Extension not responding** — inspect the extension log (`%TEMP%/npmsafe-extension.log`) for errors and confirm the core engine built successfully before launching.

---

## What's Next?

What's our next surprise? **It's coming soon!**
