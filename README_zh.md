# @npm-safe：本地 npm 包安全引擎

[English](README.md)

![版本](https://img.shields.io/github/v/release/nisconder/npm-safe?label=版本&color=2196F3)
![许可证](https://img.shields.io/badge/许可证-Apache--2.0-4CAF50)
![语言](https://img.shields.io/badge/Language-TypeScript-3178C6?logo=typescript&logoColor=white)
![测试](https://img.shields.io/badge/测试-307%20通过-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![桌面端](https://img.shields.io/badge/桌面端-Neutralinojs-purple)

@npm-safe 是一个本地优先的引擎，用于分析 npm 包是否符合已知的供应链攻击模式。它从公共 npm 注册表获取包元数据，对元数据和 README 内容执行静态分析规则，将结果缓存到本地 SQLite 数据库，并提供类型化的 API 用于查询、监控和刷新安全评估。该引擎设计为以库的形式运行，而非独立服务。

## 快速开始

需要 Node.js 18 或更高版本。

**作为 CLI 安装（全局）：**

```bash
npm install -g @npm-safe/core
npm-safe check lodash
```

**作为库安装：**

```bash
npm install @npm-safe/core
```

```ts
import { NpmSafeEngine } from "@npm-safe/core";

const engine = new NpmSafeEngine();
const result = await engine.checkPackage("lodash");
console.log(result.security.overallLevel, result.security.overallScore);
engine.close();
```

---

## 命令行用法

`npm-safe` 二进制随 `@npm-safe/core` 包一起分发。全局选项：

- `-d, --db <path>`：自定义 SQLite 数据库路径（默认 `~/.npm-safe/npm-safe.db`）
- `-p, --proxy <url>`：注册表请求的 HTTP 代理
- `-j, --json`：JSON 输出
- `-v, --version`：版本号

```bash
npm-safe <package>                 # check 的简写
npm-safe check <package>           # 检查包的安全性
npm-safe check <pkg1> <pkg2> ...   # 批量检查多个包
npm-safe check --file deps.txt     # 从文件读取包名
npm-safe search <query>            # 搜索 npm 注册表
npm-safe watch list                # 查看监控列表
npm-safe watch add <package>       # 添加监控
npm-safe watch remove <package>    # 移除监控
npm-safe refresh [package]         # 刷新单个（或全部监控）包
npm-safe settings get <key>        # 读取设置
npm-safe settings set <key> <val>  # 写入设置
npm-safe lang [en|zh]              # 查看或设置输出语言
npm-safe rules list                # 列出扫描规则及生效状态
npm-safe rules enable <rule-id>    # 启用扫描规则（持久化）
npm-safe rules disable <rule-id>   # 禁用扫描规则（持久化）
npm-safe rules severity <rule-id> <severity>  # 覆盖规则严重级别
npm-safe llm status                # 查看 LLM 提供者状态
npm-safe llm enable                # 启用 LLM 扫描
npm-safe llm disable               # 禁用 LLM 扫描
npm-safe llm set-provider <openai|gemini|anthropic>
npm-safe llm set-key <api-key>     # 设置 LLM API 密钥
npm-safe llm set-model <model>     # 设置 LLM 模型
npm-safe llm test-connection       # 测试 LLM 连接
npm-safe ci                        # 扫描依赖，严重问题时使构建失败
npm-safe ci --lockfile             # 扫描 package-lock.json 中全部依赖（含间接）
npm-safe report lodash express     # 导出安全报告（JSON/CSV）
npm-safe telemetry status          # 查看遥测状态（可选，仅本地）
npm-safe gate status               # 查看安装门禁状态（可选）
npm-safe gate enable               # 启用门禁 + 自动安装包装/shim
npm-safe gate shell                # 安装 shell 包装 + PATH shim
npm-safe gate shell --machine      # Windows（管理员）：将 shim 前置到系统 PATH
npm-safe install axios             # 带门禁安装（启用后生效）
npm-safe doctor                    # 诊断 PATH / 门禁 / shim 配置
```

日常示例：

```bash
npm-safe check react                # 检查单个包
npm-safe search "web framework"     # 搜索 npm 注册表
npm-safe watch add lodash           # 监控包，跟踪变化
npm-safe refresh                    # 刷新全部监控包
npm-safe settings set lang zh       # 写入设置
```

示例输出：

```bash
npm-safe check lodash
# 包名: lodash
# 最新版本: 4.18.1
# 安全等级: suspicious
# 分数: 65/100
# 发现项: 5
# ...
```

> **Windows PATH 说明：** 全局安装会把 `npm-safe` 放入 npm 全局 bin 目录（`%APPDATA%\npm`），外部终端需要该目录在 `PATH` 中才能找到它。官方 Node.js MSI 安装器会自动添加；自定义安装（如 Node 解压到自定义目录）需手动添加：`setx PATH "%APPDATA%\npm;%PATH%"`，然后重新打开终端。如有异常可运行 `npm-safe doctor` 诊断。

更深层的功能（代理细节、自定义规则插件、LLM 扫描、CI/CD、批量操作、报告导出、遥测、共享检查历史、命令日志和安装时安全门禁）见下方[功能特性](#功能特性)一节。

---

## 桌面图形界面

基于 Neutralinojs 的桌面应用（Material You 仪表盘，含检查、搜索、监控、规则、LLM 和设置标签页）以便携 ZIP 资产的形式随每个 GitHub Release 分发，而非作为 npm 包。下载方式：

1. 打开[发布页面](https://github.com/nisconder/npm-safe/releases)。
2. 选择最新版本，下载便携 ZIP（`npm-safe-release.zip`）。
3. 解压并运行 `npm-safe` 可执行文件（Windows）或 `npm-safe` 二进制（macOS/Linux）。应用内置 `@npm-safe/core` 引擎，数据存储在 `~/.npm-safe/`。

应用启动时会自动检查更新：当发布页面存在更新版本时，会提示并就地安装更新，然后自动重启。只有首次安装需要手动下载 ZIP；之后的更新全自动进行。

界面功能：

- **总览仪表盘**：平均安全评分半圆仪表、最近检查列表、近 7 日检查柱状图、总检查次数、风险分布。
- **检查**：输入包名，查看安全等级、分数和发现项。
- **搜索**：关键词搜索 npm 注册表；点击结果直接跳转检查。
- **监控**：管理监控列表，刷新单个或全部监控包。
- **评价体系**：列出所有注册规则，启用/禁用每个规则，覆盖其严重级别；可重新加载 `~/.npm-safe/rules/` 下的插件规则。
- **LLM**：配置可选 LLM 扫描，含测试连接按钮。
- **设置**：读取/写入任意引擎设置（如 `proxy`、`lang`），包括安装门禁。
- **浅色/深色主题**与**自定义窗口边框**：自定义标题栏一键切换两套独立的 Material You 配色；主题与上次打开的标签页会在会话间记住。

检查历史由 Node.js 扩展进程持久化到共享的 SQLite 数据库（`~/.npm-safe/npm-safe.db` 的 `check_history` 表）；详见[共享检查历史](#共享检查历史)。

> **Windows 首次运行：** 如果 WebView2 窗口因回环隔离错误无法加载，请以管理员身份运行一次 PowerShell：
> `CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"`。

运行和构建桌面应用的开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)；应用本身的文档见[桌面端 README](packages/desktop/README.md)。

---

## AI 技能

`npm-safe-scan` 代理技能（供自动加载 `~/.agents/skills/` 的 AI 代理使用）随包分发，但**不会自动安装**。在交互式终端中安装 `@npm-safe/core` 时，系统会询问您是否安装；在 CI 或其他非交互环境中则静默跳过。

手动管理技能：

- `npm-safe skill install` — 安装到 `~/.agents/skills/npm-safe-scan/`
- `npm-safe skill status` — 查看是否已安装
- `npm-safe skill uninstall` — 卸载

该技能让 AI 代理可调用 `npm-safe` 命令（check、search、watch、refresh、settings、lang）扫描 npm 包。

---

## 功能特性

### 代理

在受限网络中，注册表可能只能通过代理访问。代理解析优先级：`--proxy` 参数 > 持久化的 `proxy` 设置 > `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量。`NO_PROXY` 变量（精确匹配、`.后缀` 匹配或 `*`）可绕过代理。

```bash
# 持久化代理（推荐）
npm-safe settings set proxy http://127.0.0.1:7897

# 或每次调用时传入
npm-safe --proxy http://127.0.0.1:7897 check react
```

### 规则与插件

十条内置规则可检测安装脚本、代码混淆、仿冒包名、密钥泄露、同形字符攻击等。扫描规则可在运行时管理，配置持久化在 `~/.npm-safe/rules.json`：

```bash
npm-safe rules list                          # 查看所有规则及状态
npm-safe rules disable install-script        # 禁用规则
npm-safe rules enable install-script         # 重新启用
npm-safe rules severity typosquatting critical  # 覆盖规则严重级别
```

第三方规则插件可放入 `~/.npm-safe/rules/` 目录（`*.mjs` / `*.js` ES 模块文件）。每个文件可导出 `rule`、`rules` 或 `default`，内容为一个或多个符合 `ScanRule` 接口的规则：

```js
// ~/.npm-safe/rules/my-rule.mjs
export const rule = {
  id: "my-rule",
  name: "My rule",
  description: "Detects something bad",
  severity: "high",
  category: "informational",
  enabled: true,
  match(readme, packageJson) {
    return packageJson?.scripts?.postinstall?.includes("wget")
      ? [{ ruleId: "my-rule", ruleName: "My rule", severity: "high",
           message: "postinstall uses wget", category: "informational" }]
      : [];
  },
};
```

插件文件在引擎启动时自动加载，损坏的文件会被跳过。`ScanRule` 接口及完整的引擎规则 API（`registerRule`、`unregisterRule`、`listRules`、`setRuleEnabled`、`setRuleSeverity`）均从 `@npm-safe/core` 导出，供编程使用。内置规则参考见 [SCANNER_RULES.md](packages/core/SCANNER_RULES.md)。

### LLM 扫描

基于 LLM 的语义扫描是可选功能，默认禁用。当未配置 API 密钥时，静态分析照常运行。支持 OpenAI、Gemini、Anthropic 三家提供者。配置持久化在 `~/.npm-safe/llm.json`，也可通过环境变量提供（`OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `ANTHROPIC_API_KEY`）。

```bash
npm-safe llm status                 # 查看当前状态
npm-safe llm enable                 # 开启 LLM 扫描
npm-safe llm set-provider openai    # 选择提供者
npm-safe llm set-key $OPENAI_API_KEY
npm-safe llm set-model gpt-4o-mini
npm-safe llm test-connection        # 验证连接
```

### CI/CD 集成

`npm-safe ci` 扫描项目的直接依赖，当任一依赖达到可配置的安全级别时使构建失败：

```bash
npm-safe ci --dir ./packages/core          # 默认失败级别：dangerous
npm-safe ci --fail-level suspicious        # 更严格的阈值
npm-safe ci --prod                         # 跳过 devDependencies
npm-safe ci --lockfile                     # 扫描 lockfile 全部依赖（含间接）
npm-safe ci --json                         # 输出机器可读报告
npm-safe ci --rate-limit 50                # 每秒注册表请求数
```

退出码：`0` 通过，`1` 用法/配置错误，`2` 有依赖达到失败级别（或扫描出错）。仓库自带可直接使用的 GitHub Actions 工作流（`.github/workflows/ci.yml`）；每次 push/PR 自动运行测试套件、类型检查与依赖安全扫描。

### 批量操作

`check` 接受任意数量的包名，并支持从文件读取列表；批量扫描默认并发 5，同时仍遵守限速器：

```bash
npm-safe check lodash express axios       # 批量检查
npm-safe check --file deps.txt --concurrency 10
npm-safe check lodash express --json      # 机器可读批量报告
npm-safe check detail 2                   # 查看上次批量第 2 个包的完整详情
```

编程使用可用 `NpmSafeEngine.checkPackages(names, options)`，支持 `concurrency` 上限与 `onProgress` 进度回调。最近一次批量结果保存在 `~/.npm-safe/last-batch.json`；`check detail <n>` 可从其中重新渲染单个包的完整报告（发现项、建议、代码片段），无需重新拉取。

### 报告导出

将任意包集合的安全报告导出为 JSON 或 CSV，输出到 stdout 或文件：

```bash
npm-safe report lodash express                    # JSON 到 stdout
npm-safe report --format csv lodash express       # CSV
npm-safe report --file deps.txt --format csv --output report.csv
npm-safe report --batch                           # 导出上次批量检查
```

JSON 输出包含完整的逐包结果（`BatchPackageResult[]`）；CSV 行格式为 `name,version,level,score,findingCount`。

### 遥测与分析

本地、可选的用量遥测（默认关闭，数据不会发送到任何地方）：

```bash
npm-safe telemetry status         # 查看是否启用及聚合统计
npm-safe telemetry enable         # 开始采集（仅本地）
npm-safe telemetry disable        # 停止采集（保留已有数据）
npm-safe telemetry export         # 以 JSON 导出已采集数据
npm-safe telemetry reset          # 清空全部采集数据
```

启用后，`check` 与 `ci` 运行会记录到 `~/.npm-safe/telemetry.json`：按事件计数的计数器、已扫描包总数、安全级别分布、错误计数，以及最近 200 条事件的滚动窗口。

### 共享检查历史

通过 CLI（`check` / `ci`）检测的每个包，以及桌面 GUI 内的每次检查，都会写入共享的 SQLite 数据库（`~/.npm-safe/npm-safe.db` 的 `check_history` 表，新的在前，上限 1000 条）。桌面 GUI 的总览仪表盘直接从数据库加载这段历史；命令行扫描过的包会出现在应用中，反之亦然。旧的 `~/.npm-safe/history.json` 数据会在首次启动时一次性迁移入库。编程接口：`engine.recordCheckHistory(result)`、`engine.getCheckHistory()`、`engine.clearCheckHistory()`。

桌面扩展在启动时也会读取持久化的 `proxy` 设置并配置引擎；在 GUI 或通过 `npm-safe settings set proxy ...` 配置的代理同样作用于桌面端扫描。

### 命令日志

每次 CLI 调用都会在进程退出时向 `~/.npm-safe/commands.jsonl` 追加一行 JSONL，字段为 `{ timestamp, command, argv, exitCode, durationMs }`。可通过 `NPM_SAFE_COMMAND_LOG` 环境变量重定向日志位置。

### 安装时安全检查（可选）

`npm-safe install` 包装了 `npm install` 并带可选安全门禁：先检查每个目标包，任何**分数低于阈值（默认 85）**的包都需要用户手动确认后才能继续安装。门禁**默认关闭**，可通过 CLI 或桌面 GUI（设置 → 安装安全检查）开启：

```bash
npm-safe gate status               # 查看启用状态与阈值
npm-safe gate enable               # 开启门禁（自动安装 shell 包装）
npm-safe gate disable              # 关闭门禁
npm-safe gate set-threshold 90     # 提高阈值
npm-safe install axios             # 带门禁安装（低于阈值时提示）
npm-safe install axios --yes       # 自动确认
npm-safe install axios --dry-run   # 只检查+确认，不实际安装
```

`gate enable` 一步完成：开启检查、安装 **PATH shim**（`~/.npm-safe/bin` 下的 npm.cmd / pnpm.cmd / yarn.cmd，对所有 shell 生效），并把 `npm`、`pnpm`、`yarn` 的包装函数写入 shell 配置（Windows 上为 PowerShell `$PROFILE`，其他平台为 `~/.zshrc`/`~/.bashrc`）。激活方式：

| 你的 shell | 激活方式 |
|---|---|
| PowerShell / bash / zsh | 直接重启 shell 即可（profile 包装自动加载） |
| **Windows cmd**（或 shim 目录不在 PATH 最前的任何 shell） | **以管理员身份运行一次**：`npm-safe gate shell --machine`；该命令把 shim 目录加到**系统** PATH 最前，之后所有新终端（含 cmd）都被拦截。完成后重新打开终端。 |

在 Windows 上，只有系统 PATH 能可靠地排在 Node 安装目录之前；当某些工具把机器 PATH 放在前面时，仅修改用户 PATH 不够。`npm-safe doctor` 会验证 `where npm.cmd` 是否优先解析到 shim，并给出确切修复命令。

可用 `--shell-file <path>` 指定配置文件，`--no-shell` 跳过。激活后，任何 `pnpm add <pkg>` 或 `npm install <pkg>` 都会先执行 `npm-safe install ...`；门禁检查包，低于阈值时确认通过后才会运行真正的包管理器。移除：

```bash
npm-safe gate shell --remove
```

门禁与 GUI 共用同一张设置表，CLI 开关与 GUI 开关保持同步。

---

## 架构

引擎由五层组成。每层仅依赖其下方的层。`index.ts` 门面层组合所有依赖并将结果暴露为单一的 `NpmSafeEngine` 类。

```
                           +-----------------------+
                           |      index.ts          |
                           |  NpmSafeEngine 门面    |
                           |  29 个公共方法          |
                           +-----------+-----------+
                                       |
              +------------------------+------------------------+
              |                        |                        |
     +--------v--------+     +---------v---------+     +--------v--------+
     |   Registry      |     |    Scanner        |     |   Scheduler     |
     |  NpmRegistryClient|   |  StaticAnalyzer   |     | RefreshScheduler|
     |  Validator       |     |  10 条规则         |     |  TokenBucket    |
     |  (HTTP 请求)     |     |  (纯分析)          |     |  (速率限制)      |
     +--------+---------+     +---------+---------+     +--------+--------+
              |                          |                        |
              |                          |                        |
              +--------------------------+------------------------+
                                         |
                                +--------v--------+
                                |     Store       |
                                | DatabaseManager |
                                |  CacheManager   |
                                |  SQLite (WAL)   |
                                +-----------------+
```

### 各层职责

| 层级 | 模块 | 职责 |
|---|---|---|
| **Registry（注册表层）** | `registry/client.ts`, `registry/validator.ts`, `registry/types.ts` | 与 npm 注册表 API 进行 HTTP 通信。获取包数据，验证包名和版本，定义所有面向注册表的 TypeScript 类型。 |
| **Scanner（扫描器层）** | `scanner/static-rules.ts`, `scanner/rule-config.ts`, `scanner/rule-loader.ts`, `scanner/types.ts` | 对包元数据和 README 内容进行纯静态分析。十条内置规则可检测安装脚本、代码混淆、仿冒包名、密钥泄露、同形字符攻击等；支持规则注册、配置覆盖和插件发现。 |
| **Scheduler（调度器层）** | `scheduler/refresh-scheduler.ts`, `scheduler/rate-limiter.ts` | 管理被监控包的定时刷新周期。令牌桶（5 tokens/s, 10 burst）限制注册表请求频率。 |
| **Store（存储层）** | `store/database.ts`, `store/cache-manager.ts`, `store/schema.ts` | 基于 better-sqlite3 的持久化存储，使用 WAL 模式。处理数据库迁移、基于 TTL 的元数据和扫描报告缓存、监控列表持久化，以及键值设置。 |
| **Facade（门面层）** | `index.ts` | `NpmSafeEngine` 类组合上述四层。暴露 29 个公共方法：`checkPackage`、`searchPackages`、监控列表 CRUD、刷新操作、设置访问、规则管理、LLM 配置以及生命周期管理（`startAutoRefresh`、`stopAutoRefresh`、`close`）。 |

第六层为辅助层 **Translator（翻译器）**（`translator/types.ts`、`translator/provider.ts`），提供可插拔的翻译接口，用于将发现结果和摘要转换为不同语言。该层尚未接入核心扫描流水线，但已完整定义类型并可导入使用。

---

## 文档

详细文档位于 `packages/core/` 目录下：

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)**：分层架构图、模块依赖关系图、数据流图（热路径与刷新路径）、数据库模式（ERD）、迁移系统、错误分类体系，以及带有注释的设计决策。
- **[API.md](packages/core/API.md)**：完整的公共 API 参考文档，涵盖 `NpmSafeEngine` 类（全部 29 个方法）、导出的接口，以及所有类型定义（`SecurityLevel`、`Severity`、`FindingCategory`、`CheckResult`、`ScanFinding`、`StaticScanReport` 等）。
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)**：所有 10 条内置静态分析规则的完整参考。每条规则均文档化了其类别、严重级别、检测逻辑（正则表达式模式）和缓解建议。
- **[CONTRIBUTING.md](CONTRIBUTING.md)**：开发者指南，涵盖开发环境配置、代码规范、测试、发布流程与桌面 GUI 构建。
- **[README.md](README.md)**：本项目的英文版 README。

桌面 GUI 位于 `packages/desktop/`，详见[桌面端 README](packages/desktop/README.md)。

---

## 目录结构

```
npm-safe/
  LICENSE                  # Apache-2.0
  README.md                # 项目说明（英文）
  README_zh.md             # 项目说明（中文）
  CONTRIBUTING.md          # 开发者指南（配置、规范、发布）
  pnpm-workspace.yaml      # workspace = packages/*
  tsconfig.base.json       # 共享 TypeScript 配置（ESNext, strict）
  .github/
    workflows/
      ci.yml               # CI：类型检查 + 测试 + 依赖安全扫描
      publish.yml          # npm 发布（SLSA 来源证明，标签触发）
      desktop-release.yml  # GitHub Releases 的桌面端 ZIP 资产
  packages/
    core/
      package.json         # @npm-safe/core v0.2.0, ESM, publishConfig（public、provenance）
      .npmignore           # 发布排除规则
      tsconfig.json        # extends ../../tsconfig.base.json
      API.md               # 公共 API 参考文档
      ARCHITECTURE.md      # 分层架构图、数据流、数据库模式
      SCANNER_RULES.md     # 10 条静态规则参考
      skill/
        npm-safe-scan/
          SKILL.md         # AI 技能，postinstall 询问安装 / `skill install`
      scripts/
        install-skill.mjs  # postinstall 钩子
      src/
        index.ts           # NpmSafeEngine 门面，统一公共 API
        cli/               # 命令实现、命令日志、i18n
        llm/               # LLM 提供者（OpenAI / Gemini / Anthropic）
        registry/          # 注册表客户端、校验器、类型
        scanner/           # StaticAnalyzer、规则配置、插件加载器
        scheduler/         # 限速器 + 刷新调度器
        store/             # SQLite 数据库、迁移、缓存管理器
        translator/        # 可插拔翻译接口
      test/                # 模块测试（见 CONTRIBUTING.md）
    desktop/               # @npm-safe/desktop（Neutralinojs 桌面 GUI）
      package.json         # 桌面工作区包
      neutralino.config.json  # Neutralino 应用配置（无边框、扩展）
      resources/           # index.html, styles.css, js/, icons/, extensions/core/main.mjs
```

---

## 关键设计决策

| 决策 | 理由 |
|---|---|
| **仅 ESM**（`"type": "module"`） | 与现代 Node.js 生态系统保持一致。所有导入均使用 `.js` 后缀，符合原生 ESM 规范。 |
| **严格 TypeScript，禁止 `any`** | 每个函数和接口均具有完整类型。项目以 `--strict` 编译，不存在隐式 `any`。 |
| **每模块 250 行代码上限** | 确保每个文件职责集中、便于审查。门面层（`index.ts`）是唯一因组合职责而略微超过此限制的模块。 |
| **使用 better-sqlite3 的 SQLite** | 零配置嵌入式数据库。启用 WAL 模式、`busy_timeout=5000`、`synchronous=NORMAL` 和外键约束。 |
| **纯静态分析（无网络请求）** | 扫描器仅检查注册表客户端已获取的元数据和 README 文本。分析过程中不发起外部 API 调用。 |
| **TokenBucket 速率限制器（5 tokens/s, 10 burst）** | 防止触发注册表限流。令牌以每秒 5 个的速度恢复；突发容量允许立即处理最多 10 个请求。 |
| **缓存优先的 `checkPackage`，基于 TTL 判断过期** | TTL 未过期时立即返回缓存结果。缓存过期则触发后台刷新。默认 TTL 为 1 小时。 |
| **`SecurityLevel` / `Severity` 使用字符串枚举** | 与数字枚举不同，字符串枚举可安全地记录、序列化，以及在 `switch` 语句中使用，无需担心反向映射问题。 |
| **评分机制：100 减去严重性权重** | Critical = 25, High = 15, Medium = 8, Low = 3。从 100 分起算确保未评分的包默认为 100 分（安全）。 |
| **等级阈值** | `>=80` 安全，`>=50` 可疑，`>=20` 危险，其余为未知。`StaticAnalyzer` 与 `CacheManager` 共享这些阈值以保持一致性。 |

---

## 许可证

Apache-2.0。详见 [LICENSE](LICENSE)。
