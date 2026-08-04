# @npm-safe/desktop

[English](README.md)

基于 [Neutralinojs](https://neutralino.js.org/) 的 `@npm-safe/core` 引擎桌面 GUI。提供 Material You 风格的仪表盘，用于检查、搜索、监控和刷新 npm 包的安全评估，支持持久化检查历史与自定义无边框窗口。界面语言为中文（zh-CN）。

## 功能特性

- **总览仪表盘** — 平均安全评分以半圆仪表展示，含近 7 日检查柱状图、总检查次数、风险分布（安全 / 可疑 / 危险 / 未知）以及最近检查列表（最近 8 条）。
- **检查（Check）** — 输入包名（回车或点击「检查」），查看安全等级、分数和详细发现项。
- **搜索（Search）** — 针对 npm 注册表的关键词搜索（1-250 条结果，默认 20 条）；点击结果可直接跳转到检查。
- **监控（Watch）** — 添加/移除监控包，刷新单个或全部监控包。
- **评价体系（Rules）** — 列出所有已注册规则及其来源与描述；启用/禁用每条规则并覆盖其严重级别；可重新加载 `~/.npm-safe/rules/` 下的插件规则。
- **LLM** — 配置可选 LLM 扫描：启用开关、提供者（OpenAI / Gemini / Anthropic）、API 密钥、模型和基础 URL，以及测试连接按钮。状态显示中的 API 密钥会被打码。
- **设置（Settings）** — 读取/写入任意引擎设置（如 `proxy`、`lang`）。
- **Material You 主题** — 独立浅色/深色配色（seed `#4f8cff`），通过自定义标题栏切换，并在会话间记住选择。
- **偏好记忆** — 主题与上次打开的标签页同时持久化到 `localStorage`（启动即应用）和引擎设置表（WebView 缓存被清也不丢失）。
- **自定义窗口边框** — 无边框透明窗口，标题栏可拖动，含最小化和关闭按钮。
- **持久化检查历史** — 存储在共享 SQLite 数据库（`~/.npm-safe/npm-safe.db` 的 `check_history` 表，新的在前，上限 1000 条）。桌面 GUI 与 CLI 共享这段历史——命令行扫描的包会出现在应用中，反之亦然。旧的 `~/.npm-safe/history.json` 数据会在首次启动时一次性迁移入库。

## 页面（标签页导航）

应用使用常驻导航抽屉，共七个标签页：

### 总览 (Overview)

基于持久化的检查历史渲染：

- **整体安全评分** — 所有已记录检查的平均分，以半圆仪表展示（0-100）。弧线颜色按分数阈值变化：`>=80` 安全，`>=50` 可疑，其余为危险。
- **近7日检查** — 统计最近 7 天每日检查次数的 7 柱迷你柱状图。
- **总检查次数** — 已记录检查的总数。
- **风险分布** — 各安全等级计数（安全 / 可疑 / 危险 / 未知）。
- **最近检查** — 最近 8 条检查记录，含等级徽章和分数；点击条目会跳转到检查页并执行检查。

每次切换回该标签页时，仪表盘都会重新渲染。

### 检查 (Check)

- 输入包名并点击「检查」（或按回车）。
- 结果卡片显示：包名、最新版本、安全等级（彩色徽章）、分数 `/100`、发现项数量，以及（如可用）描述、主页和仓库地址。
- **主页 / 仓库链接** — 每行带「复制」按钮，一键复制链接到剪贴板；**Ctrl+点击**链接可在默认浏览器中打开（`github:user/repo`、`git@…`、`ssh://…` 等仓库描述会自动规范化为 https 地址）。
- 每条发现项列出严重级别（`[CRITICAL]`、`[HIGH]` 等）、规则 ID 与名称、消息、修复建议，以及代码片段/行号（如有）。
- 如果包在注册表中不存在，会显示「未找到」卡片。

### 搜索 (Search)

- 输入关键词和可选的结果数量（1-250，默认 20），然后点击「搜索」（或按回车）。
- 每条结果显示 `name@version`、描述和搜索分数。
- 点击结果会切换到检查页、填入包名并自动执行检查。

### 监控 (Watch)

- 输入包名并点击「添加」将其加入监控列表（该包必须存在于注册表）。
- 每个列表项提供「检查」（跳转到检查页）和「移除」操作。
- 「刷新全部」一次性刷新所有监控包；请求期间按钮会显示「处理中...」忙碌状态。

### 评价体系 (Rules)

- 列出所有已注册规则，含名称、ID、来源（`builtin` / `plugin`）、描述、启用状态和生效严重级别。
- 「启用」开关持久化启用/禁用状态；严重级别下拉框持久化严重级别覆盖。两者在下次扫描时生效。
- 「重新加载插件」重新扫描 `~/.npm-safe/rules/` 并注册新发现的插件规则。

### LLM

- 「启用 LLM 扫描」开关及提供者 / API 密钥 / 模型 / 基础 URL 字段持久化到 `~/.npm-safe/llm.json`。
- 「保存」立即应用配置（运行时重建引擎提供者）。
- 「测试连接」向配置的提供者发送测试请求。
- 「重置」清除未保存的编辑并恢复当前持久化配置。
- 若未配置 API 密钥，LLM 扫描保持禁用，静态分析照常运行。

### 设置 (Settings)

- 读取设置：输入键名（如 `proxy`、`lang`）并点击「读取」。
- 写入设置：输入键名和值，然后点击「写入」。
- 结果内联显示；未设置的键显示「(未设置)」。
- **安装安全检查** —— 开关 + 阈值输入（0-100，默认 85）。开启后启用与
  CLI 共享的门禁（设置表 `installGate.enabled` / `installGate.threshold`）：
  启用时，`npm-safe install`（或 PATH shim / shell 包装）会检查每个包，
  分数低于阈值的包需确认后才安装。

## 前置条件

- [Node.js](https://nodejs.org/) 18 或更高版本（需要全局 `fetch`）
- [pnpm](https://pnpm.io/) 9 或更高版本
- Webview 运行时：Windows 上的 WebView2、macOS 上的 WebKit、Linux 上的 WebKitGTK
- Neutralinojs 二进制文件由 `@neutralinojs/neu` CLI（devDependency）获取

## 开发模式运行

首先在仓库根目录安装依赖：

```bash
pnpm install
```

然后启动桌面应用：

```bash
cd packages/desktop
pnpm run run
```

`run` 脚本会先构建 `@npm-safe/core`，再通过 `neu run` 启动应用。

## 构建发布版

```bash
cd packages/desktop
pnpm run build
```

`build` 脚本执行 `pnpm run build:core && neu build --release`，在
`packages/desktop/dist/` 下生成所有平台的便携 ZIP 文件（例如
`npm-safe-win_x64.zip`、`npm-safe-linux_x64.zip`、`npm-safe-mac_x64.zip`）。
这些 ZIP 即分发产物——由 `desktop-release.yml` 工作流在每个 `v*` 标签上附加到
GitHub Release，用户无需自行构建即可下载 GUI。

## Windows 首次运行注意事项

如果 WebView2 窗口因回环隔离错误无法加载，请以管理员身份在 PowerShell 中运行一次：

```powershell
CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"
```

## 架构

桌面应用是三层 Neutralinojs 应用：

```
┌─────────────────────────────────────────────────────┐
│  前端  resources/                                    │
│  index.html + styles.css + js/main.js               │
│  (Material You UI, 通过 neutralino.js 的 IPC 桥接)  │
└───────────────────────┬─────────────────────────────┘
                        │ WebSocket IPC (extensions.dispatch)
┌───────────────────────▼─────────────────────────────┐
│  扩展  resources/extensions/core/main.mjs           │
│  承载 NpmSafeEngine 的 Node.js 进程（20 个方法）   │
│  共享检查历史 → SQLite（check_history 表）          │
└───────────────────────┬─────────────────────────────┘
                        │ 启动与管理
┌───────────────────────▼─────────────────────────────┐
│  Neutralinojs 服务器  neutralino.config.json       │
│  window 模式、扩展声明、权限 allowlist              │
└─────────────────────────────────────────────────────┘
```

### 前端（`resources/`）

- `index.html` — Material You UI：常驻导航抽屉（7 个标签页）、自定义标题栏（拖动区域、主题切换、最小化/关闭按钮）、顶部应用栏、各标签页面板以及底部状态栏。
- `styles.css` — 基于 seed `#4f8cff` 的 Material 3 色调色板，含独立的浅色/深色变量集、M3 抬升色调以及安全/可疑/危险状态颜色。
- `js/main.js` — 前端逻辑：
  - `callEngine(method, data)` 将每个引擎调用以 `_requestId` 分发给扩展，并带有 **30 秒超时**。
  - `registerEngineEvents()` / `registerHistoryEvents()` 将 `:response` / `:error` 事件回接到待处理的 Promise。
  - 标签页导航、标题栏窗口控制（`setDraggableRegion`、`minimize`、`app.exit`）、偏好持久化（`npm-safe-theme` / `npm-safe-last-tab` 键并镜像写入引擎设置表）。
  - 所有用户输入字符串在渲染前均经过 HTML 转义（`escapeHtml` / `escapeAttr`）以防止 XSS。
- `js/neutralino.js` / `js/neutralino.d.ts` — Neutralinojs 客户端库与类型定义（6.9.0）。

### 扩展（`resources/extensions/core/main.mjs`）

由 Neutralinojs 服务器启动的 Node.js 进程（在 `neutralino.config.json` 中声明为 `js.npmsafe.core`）。它：

- 持有基于 SQLite 的 `NpmSafeEngine` 实例，数据库位于 `~/.npm-safe/npm-safe.db`。
- WebSocket 连接建立时广播 `engineReady`，供前端从设置表回灌持久化偏好（主题、上次标签页）。
- 暴露 **20 个 IPC 方法**：`checkPackage`、`searchPackages`、`getWatchlist`、`addToWatchlist`、`removeFromWatchlist`、`refreshPackage`、`refreshAll`、`getSetting`、`setSetting`、`getHistory`、`addHistory`、`clearHistory`、`listRules`、`setRuleEnabled`、`setRuleSeverity`、`setRuleOptions`、`loadRulePlugins`、`getLlmStatus`、`setLlmConfig`、`testLlmConnection`。
- 启动时读取持久化的 `proxy` 设置并配置引擎。将每次检查结果通过 `engine.recordCheckHistory(result)` 写入共享 SQLite `check_history` 表；旧的 `~/.npm-safe/history.json` 数据会在首次启动时一次性迁移入库。
- 将诊断日志写入 `%TEMP%/npmsafe-extension.log`（Windows）或 `$TMPDIR/npmsafe-extension.log`（macOS/Linux）。
- 与服务器的 WebSocket 连接断开时，关闭引擎并退出。

### IPC 协议

```
前端 → 扩展:  { "event": "<method>", "data": <params> }
扩展 → 前端:  { "event": "<method>:response", "data": { requestId, result } }
扩展 → 前端:  { "event": "<method>:error", "data": { requestId, message } }
扩展 → 前端:  { "event": "engineReady", "data": {} }   （WebSocket 连接建立时）
```

### 应用配置（`neutralino.config.json`）

- `applicationId`：`org.npmsafe.desktop`
- 窗口模式：1100×750（最小 800×550），居中，`borderless` + `transparent`，可调整大小。
- 扩展：`js.npmsafe.core` → `node ${NL_PATH}/resources/extensions/core/main.mjs`。
- `nativeAllowList`：`app.*`、`os.*`、`window.*`、`extensions.*`、`filesystem.*`、`debug.log`。
- `tokenSecurity`：`one-time`；binary/client 版本 6.9.0。

## 数据位置

| 数据 | 路径 |
|---|---|
| SQLite 数据库 | `~/.npm-safe/npm-safe.db` |
| 检查历史 | SQLite `check_history` 表，位于 `~/.npm-safe/npm-safe.db` |
| 扩展日志 | `%TEMP%/npmsafe-extension.log`（Windows）/ `$TMPDIR/npmsafe-extension.log`（macOS/Linux） |
| 主题偏好 | 设置表键 `theme` + `localStorage` 键 `npm-safe-theme` |
| 上次标签页 | 设置表键 `lastTab` + `localStorage` 键 `npm-safe-last-tab` |

偏好会同时写入两层；启动时先应用 `localStorage`，待扩展广播 `engineReady` 后从设置表回灌（后端优先）。

## 目录结构

```
packages/desktop/
├── package.json                # @npm-safe/desktop 脚本（run、build）
├── neutralino.config.json      # Neutralino 应用配置（窗口、扩展、allowlist）
├── resources/
│   ├── index.html              # Material You UI（导航抽屉）
│   ├── styles.css              # M3 浅色/深色主题、自定义标题栏
│   ├── js/
│   │   ├── main.js             # 前端 IPC 桥接 + 仪表盘逻辑
│   │   ├── neutralino.js       # Neutralinojs 客户端库
│   │   └── neutralino.d.ts     # Neutralinojs 类型定义
│   ├── icons/
│   │   ├── appIcon.png         # 应用图标
│   │   ├── trayIcon.png        # 托盘图标
│   │   └── logo.gif            # 标志动画
│   └── extensions/
│       └── core/main.mjs       # 承载 NpmSafeEngine 的 Node.js 扩展
```

## 故障排查

- **Windows 上出现 WebView2 回环错误** — 在[Windows 首次运行注意事项](#windows-首次运行注意事项)中运行 `CheckNetIsolation.exe` 命令。
- **引擎请求 30 秒超时** — 状态栏会显示超时错误；请检查网络连接（受限网络可能需要设置 `proxy`）。
- **扩展无响应** — 检查扩展日志（`%TEMP%/npmsafe-extension.log`）中的错误，并确认启动前核心引擎已成功构建。


