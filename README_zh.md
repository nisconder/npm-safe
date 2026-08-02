# @npm-safe — 本地 npm 包安全引擎

[English](README.md)

![版本](https://img.shields.io/badge/版本-v0.1.0-2196F3)
![许可证](https://img.shields.io/badge/许可证-Apache--2.0-4CAF50)
![语言](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![测试](https://img.shields.io/badge/测试-206%20通过-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![桌面端](https://img.shields.io/badge/桌面端-Neutralinojs-purple)

@npm-safe 是一个本地优先的引擎，用于分析 npm 包是否符合已知的供应链攻击模式。它从公共 npm 注册表获取包元数据，对元数据和 README 内容执行静态分析规则，将结果缓存到本地 SQLite 数据库，并提供类型化的 API 用于查询、监控和刷新安全评估。该引擎设计为以库的形式运行，而非独立服务。

**当前状态：第一阶段已完成（引擎核心）+ 第二阶段已完成。** 引擎核心交付，29 个源文件，零 TypeScript 错误。第二阶段已新增完整测试套件（240 个测试全部通过）、CLI 命令行工具（`check`、`search`、`watch`、`refresh`、`settings`、`lang`、`rules`、`llm` 命令）、受限网络下的代理支持、可选的多后端 LLM 扫描提供者（OpenAI / Gemini / Anthropic）及持久化配置，以及基于 Neutralinojs 的桌面 GUI，包含 Material You 风格的总览仪表盘、检查/搜索/监控/评价体系/LLM/设置标签页、浅色/深色主题和持久化检查历史。随后于 2026-08-02 完成一轮安全加固，修复了漏洞排查发现的 12 个问题，包括桌面 GUI 中两处严重的 XSS 到 RCE 漏洞（所有字段现已转义）、监控列表刷新崩溃，以及 `-j` 输出标志、亚秒级 TTL 精度等若干 CLI 正确性问题。

---

## 前置条件

- [Node.js](https://nodejs.org/) 18 或更高版本（需要全局 `fetch`）
- [pnpm](https://pnpm.io/) 9 或更高版本

---

## 安装与配置

```bash
pnpm install
pnpm -F @npm-safe/core exec tsc --noEmit
```

TypeScript 编译器（`tsc`）作为每个包的 devDependency 安装在 pnpm 的隔离存储中，**不会**提升至工作区根目录。因此在顶层运行 `npx tsc` 或 `tsc` 将会失败。`pnpm -F @npm-safe/core exec tsc --noEmit` 通过 pnpm 的过滤执行机制调用正确的二进制文件。此模式同样适用于其他包级别的 CLI 工具。

---

## 命令行工具

编译并全局链接 CLI（或直接用 `node packages/core/dist/cli/cli.js`）：

```bash
pnpm -F @npm-safe/core run build
cd packages/core && npm link
```

### 命令

```bash
npm-safe <package>                 # check 的简写
npm-safe check <package>           # 检查包的安全性
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
```

### 桌面应用

`packages/desktop/` 下提供基于 Neutralinojs 的桌面 GUI：

```bash
# 构建核心引擎并在开发模式下运行桌面应用
cd packages/desktop
pnpm run run

# 构建发布包
pnpm run build
```

功能特性：

- **总览仪表盘** — 平均安全评分半圆仪表、最近检查列表、近7日检查柱状图、总检查次数、风险分布。
- **检查** — 输入包名，查看安全等级、分数和发现项。
- **搜索** — 关键词搜索 npm 注册表；点击结果直接跳转检查。
- **监控** — 管理监控列表，刷新单个或全部监控包。
- **评价体系** — 列出所有注册规则，启用/禁用每个规则，覆盖其严重级别；可重新加载 `~/.npm-safe/rules/` 下的插件规则。
- **LLM** — 配置可选 LLM 扫描：启用开关、提供者、API 密钥、模型和基础 URL，并提供测试连接按钮。
- **设置** — 读取/写入任意引擎设置（如 `proxy`、`lang`）。
- **浅色/深色主题** — 自定义标题栏一键切换两套独立的 Material You 配色。
- **自定义窗口边框** — 无边框窗口，支持标题栏拖动、最小化和关闭按钮（Windows 需设置 WebView2 回环豁免，见下文）。

检查历史由 Node.js 扩展进程持久化到 `~/.npm-safe/history.json`。

全局选项：

- `-d, --db <path>` — 自定义 SQLite 数据库路径（默认 `~/.npm-safe/npm-safe.db`）
- `-p, --proxy <url>` — 注册表请求的 HTTP 代理
- `-j, --json` — JSON 输出
- `-v, --version` — 版本号

示例：

```bash
npm-safe check lodash
# 包名: lodash
# 最新版本: 4.18.1
# 安全等级: suspicious
# 分数: 65/100
# 发现项: 5
# ...
```

### 代理配置

在受限网络中，注册表可能只能通过代理访问。代理解析优先级：`--proxy` 参数 > 持久化的 `proxy` 设置 > `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量。`NO_PROXY` 变量（精确匹配、`.后缀` 匹配或 `*`）可绕过代理。

```bash
# 持久化代理（推荐）
npm-safe settings set proxy http://127.0.0.1:7897

# 或每次调用时传入
npm-safe --proxy http://127.0.0.1:7897 check react
```

### 语言切换

```bash
npm-safe lang          # 查看当前语言
npm-safe lang zh       # 切换为中文（持久化）
npm-safe lang en       # 切换为英文（持久化）
```

### 规则与插件

扫描规则可在运行时管理，配置持久化在 `~/.npm-safe/rules.json`：

```bash
npm-safe rules list                          # 查看所有规则及状态
npm-safe rules disable install-script        # 禁用规则
npm-safe rules enable install-script         # 重新启用
npm-safe rules severity typosquatting critical  # 覆盖规则严重级别
```

第三方规则插件可放入 `~/.npm-safe/rules/` 目录（`*.mjs` / `*.js` ES 模块文件）。
每个文件可导出 `rule`、`rules` 或 `default`，内容为一个或多个符合
`ScanRule` 接口的规则：

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

插件文件在引擎启动时自动加载，损坏的文件会被跳过。`ScanRule` 接口及完整
的引擎规则 API（`registerRule`、`unregisterRule`、`listRules`、
`setRuleEnabled`、`setRuleSeverity`）均从 `@npm-safe/core` 导出，供编程使用。

### LLM 扫描

基于 LLM 的语义扫描是可选功能，默认禁用。当未配置 API 密钥时，静态分析
照常运行。配置持久化在 `~/.npm-safe/llm.json`，也可通过环境变量提供
（`OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `ANTHROPIC_API_KEY`）。

```bash
npm-safe llm status                 # 查看当前状态
npm-safe llm enable                 # 开启 LLM 扫描
npm-safe llm set-provider openai    # 选择提供者
npm-safe llm set-key $OPENAI_API_KEY
npm-safe llm set-model gpt-4o-mini
npm-safe llm test-connection        # 验证连接
```

### 桌面应用首次运行（Windows）

如果 WebView2 窗口因回环隔离错误无法加载，请以管理员身份运行一次 PowerShell：

```powershell
CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"
```

### 测试

```bash
pnpm -F @npm-safe/core test
```

240 个测试覆盖每个模块：校验器、静态规则、限流器、存储层、注册表客户端（mock fetch）、刷新调度器、引擎集成层、LLM 提供者、LLM 配置管理器、规则插件系统以及 CLI 本身。

---

## 文档

引擎的详细文档位于 `packages/core/` 目录下：

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)** -- 分层架构图、模块依赖关系图、数据流图（热路径与刷新路径）、数据库模式（ERD）、迁移系统、错误分类体系，以及带有注释的设计决策。
- **[API.md](packages/core/API.md)** -- 完整的公共 API 参考文档，涵盖 `NpmSafeEngine` 类（全部 24 个方法）、导出的接口，以及所有类型定义（`SecurityLevel`、`Severity`、`FindingCategory`、`CheckResult`、`ScanFinding`、`StaticScanReport` 等）。
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)** -- 所有 10 条内置静态分析规则的完整参考。每条规则均文档化了其类别、严重级别、检测逻辑（正则表达式模式）和缓解建议。
  - **[README_zh.md](README_zh.md)** -- 本项目的简体中文版 README。

桌面 GUI 位于 `packages/desktop/`，详见
[桌面端 README](packages/desktop/README.md)。

---

## AI 技能

名为 `npm-safe-scan` 的代理技能随本包一同分发，并在**安装时自动安装**：
安装 `@npm-safe/core` 时，`postinstall` 钩子会将
`opencode-skill/npm-safe-scan/SKILL.md` 复制到
`~/.agents/skills/npm-safe-scan/SKILL.md`。任何 AI 代理（opencode、Claude
Code 或任何自动加载 `~/.agents/skills/` 的代理）随后即可自动调用
`npm-safe` 命令来检查、搜索、监视和刷新 npm 包的安全评估。该技能文档记录
了完整的命令集、常见工作流和 JSON 输出解读。

---

## 目录结构

```
npm-safe/
  .gitignore
  LICENSE                  # Apache-2.0
  README.md                # 项目说明（英文）
  README_zh.md             # 项目说明（中文）
  pnpm-lock.yaml           # 锁文件
  pnpm-workspace.yaml      # workspace = packages/*
  tsconfig.base.json       # 共享 TypeScript 配置（ESNext, strict）
  packages/
    core/
      package.json         # @npm-safe/core v0.1.0, ESM, private
      tsconfig.json        # extends ../../tsconfig.base.json
      API.md               # 公共 API 参考文档
      ARCHITECTURE.md      # 分层架构图、数据流、数据库模式
      SCANNER_RULES.md     # 10 条静态规则参考
      opencode-skill/
        npm-safe-scan/
          SKILL.md         # AI 技能，postinstall 自动安装
      scripts/
        install-skill.mjs  # postinstall 钩子
      src/
        index.ts           # NpmSafeEngine 门面 — 统一公共 API
        cli/
          cli.ts           # CLI 入口 — commander 程序 + check 简写
          check.ts         # check 命令（与简写共用）
          search.ts        # search 命令
          watch.ts         # 监控列表命令（list/add/remove）
          refresh.ts       # refresh 命令
          settings.ts      # settings get/set 命令
          lang.ts          # lang 命令（en/zh，持久化）
          rules.ts         # 规则管理命令
          llm.ts           # LLM 配置命令
          i18n.ts          # 中英文双语模块
          shared.ts        # 引擎工厂 + 默认数据库路径
        llm/
          provider.ts      # createLlmProvider 工厂（OpenAI / Gemini / Anthropic）
          llm-config.ts    # LlmConfigManager 持久化与环境变量回退
          gemini.ts        # Gemini LLM 提供者
          anthropic.ts     # Anthropic LLM 提供者
          parse.ts         # LLM 响应解析辅助函数
        registry/
          types.ts         # PackageMetadata, AbbreviatedVersion, SearchResult, NpmRegistryError
          validator.ts     # validatePackageName, validateVersion, validateDomain, isKnownRegistryDomain
          client.ts        # NpmRegistryClient — HTTP 请求，含重试、退避与代理支持
        scanner/
          types.ts         # SecurityLevel, Severity, ScanFinding, ScanRule, StaticScanReport
          static-rules.ts  # StaticAnalyzer — 10 条内置分析规则 + 规则注册
          rule-config.ts   # RuleConfigManager 持久化
          rule-loader.ts   # 从 ~/.npm-safe/rules/ 发现插件规则
        scheduler/
          rate-limiter.ts      # TokenBucket — 5 tokens/s, 10 burst
          refresh-scheduler.ts # RefreshScheduler — 通过 EventEmitter 实现定时刷新监控列表
        store/
          schema.ts        # SCHEMA_SQL (DDL), getMigrationList, getInitialMigration
          database.ts      # DatabaseManager — better-sqlite3, WAL 模式, 迁移系统
          cache-manager.ts # CacheManager — 基于 TTL 的缓存读写，用于包、报告、监控列表、设置
        translator/
          types.ts         # TranslationProvider 接口, 目标语言配置
          provider.ts      # 内置翻译提供者实现
      test/
        validator.test.ts      # 包名/版本/域名校验测试
        static-rules.test.ts   # 10 条规则 + 评分/等级测试
        rate-limiter.test.ts   # 令牌桶测试
        store.test.ts          # 数据库 + 缓存管理器测试
        client.test.ts         # 注册表客户端测试（mock fetch、代理）
        refresh-scheduler.test.ts # 调度器事件测试
        engine.test.ts         # NpmSafeEngine 集成测试
        cli.test.ts            # CLI 测试（命令、语言、简写）
        llm-provider.test.ts   # createLlmProvider 工厂 + 共享行为测试
        llm-gemini.test.ts     # Gemini LLM 提供者测试
        llm-anthropic.test.ts  # Anthropic LLM 提供者测试
        llm-config.test.ts     # LLM 配置持久化与引擎集成测试
        rule-config.test.ts    # RuleConfigManager 持久化测试
        rule-loader.test.ts    # 插件规则发现测试
        rule-plugin.test.ts    # 规则注册与引擎集成测试
    desktop/                         # @npm-safe/desktop（Neutralinojs 桌面 GUI）
      package.json                   # 桌面工作区包
      neutralino.config.json         # Neutralino 应用配置（无边框、扩展）
      resources/
        index.html                   # Material You 界面（Navigation Drawer）
        styles.css                   # M3 浅色/深色主题、自定义标题栏
        js/main.js                   # 前端 IPC 桥接 + 仪表盘逻辑
        js/neutralino.js             # Neutralinojs 客户端库
        js/neutralino.d.ts           # Neutralinojs 类型定义
        icons/
          appIcon.png                # 应用图标
          trayIcon.png               # 托盘图标
          logo.gif                   # 标志动画
        extensions/core/main.mjs     # 承载 NpmSafeEngine 的 Node.js 扩展
```

---

## 架构

引擎由五层组成。每层仅依赖其下方的层。`index.ts` 门面层组合所有依赖并将结果暴露为单一的 `NpmSafeEngine` 类。

```
                           +-----------------------+
                           |      index.ts          |
                           |  NpmSafeEngine 门面    |
                           |  24 个公共方法          |
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
| **Facade（门面层）** | `index.ts` | `NpmSafeEngine` 类组合上述四层。暴露 24 个公共方法：`checkPackage`、`searchPackages`、监控列表 CRUD、刷新操作、设置访问、规则管理、LLM 配置以及生命周期管理（`startAutoRefresh`、`stopAutoRefresh`、`close`）。 |

第六层为辅助层 **Translator（翻译器）**（`translator/types.ts`、`translator/provider.ts`），提供可插拔的翻译接口，用于将发现结果和摘要转换为不同语言。该层在第一阶段尚未接入核心扫描流水线，但已完整定义类型并可导入使用。

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

## 下一步计划（第三阶段）

第一阶段交付了可用的、tsc 无错误的引擎核心。第二阶段已完成测试、CLI、代理支持、LLM 扫描提供者、Neutralinojs 桌面 GUI、扫描规则插件系统，以及 LLM 配置管理（CLI + GUI），随后于 2026-08-02 完成一轮安全加固，修复了漏洞排查发现的 12 个问题。第三阶段剩余工作：

- **批量操作。** 多包 `checkPackage`、批量搜索导出、仪表盘报告下载。
- **CI/CD 集成。** 提供 GitHub Action 或 CLI 工具，在 CI 流水线中执行 `@npm-safe/core` 检查。


