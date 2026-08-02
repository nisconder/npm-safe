# @npm-safe/desktop

A [Neutralinojs](https://neutralino.js.org/) desktop GUI for the `@npm-safe/core` engine. It provides a Material You dashboard for checking, searching, watching, and refreshing npm package security assessments, with persistent check history and a custom borderless window.

## Features

- **Overview dashboard** — average security score shown on a half-circle gauge, a 7-day check histogram, total check count, risk breakdown (safe / suspicious / dangerous / unknown), and a recent-checks list.
- **Check** — enter a package name and view its security level, score, and findings.
- **Search** — keyword search against the npm registry (1-250 results); click a result to jump straight to Check.
- **Watch** — add/remove packages from the watchlist and refresh individual or all watched packages.
- **Settings** — read/write arbitrary engine settings (e.g. `proxy`, `lang`).
- **Material You theming** — independent light/dark palettes (seed `#4f8cff`), toggled from the custom title bar.
- **Custom window chrome** — borderless, draggable title bar with minimize and close buttons.
- **Persistent check history** — stored in `~/.npm-safe/history.json` (capped at 1000 entries) by the Node.js extension process.

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

- **Frontend** (`resources/`): the Material You interface and the `callEngine()` IPC bridge. Every engine call is dispatched to the extension with a request id and a 30s timeout.
- **Extension** (`resources/extensions/core/main.mjs`): a Node.js process spawned by the Neutralinojs server. It owns the `NpmSafeEngine` instance (SQLite at `~/.npm-safe/npm-safe.db`) and exposes 12 methods: `checkPackage`, `searchPackages`, `getWatchlist`, `addToWatchlist`, `removeFromWatchlist`, `refreshPackage`, `refreshAll`, `getSetting`, `setSetting`, `getHistory`, `addHistory`, `clearHistory`.
- **IPC protocol**: the frontend sends `{ event: "<method>", data: <params> }`; the extension replies with `{ event: "<method>:response", data: <result> }` or `{ event: "<method>:error", data: { message } }`.

## Data Locations

| Data | Path |
|---|---|
| SQLite database | `~/.npm-safe/npm-safe.db` |
| Check history | `~/.npm-safe/history.json` |
| Extension log | `%TEMP%/npmsafe-extension.log` (Windows) / `$TMPDIR/npmsafe-extension.log` (macOS/Linux) |

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
