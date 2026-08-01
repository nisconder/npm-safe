# @npm-safe — 本地 npm 包安全引擎

[English](README.md)

@npm-safe 是一个本地优先的引擎，用于分析 npm 包是否符合已知的供应链攻击模式。它从公共 npm 注册表获取包元数据，对元数据和 README 内容执行静态分析规则，将结果缓存到本地 SQLite 数据库，并提供类型化的 API 用于查询、监控和刷新安全评估。该引擎设计为以库的形式运行，而非独立服务。

**当前状态：第一阶段已完成（引擎核心）+ 第二阶段已完成（CLI + 桌面 GUI）。** 引擎核心交付，13 个源文件，零 TypeScript 错误。第二阶段已新增完整测试套件（193 个测试全部通过）、CLI 命令行工具（`check`、`search`、`watch`、`refresh`、`settings`、`lang` 命令）、受限网络下的代理支持，以及基于 Neutralinojs 的桌面 GUI，包含 Material You 风格的总览仪表盘、检查/搜索/监控/设置标签页、浅色/深色主题和持久化检查历史。

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
```

### 桌面应用

`packages/desktop/` 下提供基于 Neutralinojs 的桌面 GUI：

```bash
# 构建核心引擎并在开发模式下运行桌面应用
cd packages/desktop
pnpm run

# 构建发布包
pnpm run build:release
```

功能特性：

- **总览仪表盘** — 平均安全评分半圆仪表、最近检查列表、近7日检查柱状图、总检查次数、风险分布。
- **检查** — 输入包名，查看安全等级、分数和发现项。
- **搜索** — 关键词搜索 npm 注册表；点击结果直接跳转检查。
- **监控** — 管理监控列表，刷新单个或全部监控包。
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

### 桌面应用首次运行（Windows）

如果 WebView2 窗口因回环隔离错误无法加载，请以管理员身份运行一次 PowerShell：

```powershell
CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"
```

### 测试

```bash
pnpm -F @npm-safe/core test
```

193 个测试覆盖每个模块：校验器、静态规则、限流器、存储层、注册表客户端（mock fetch）、刷新调度器、引擎集成层以及 CLI 本身。

---

## 文档

引擎的详细文档位于 `packages/core/` 目录下：

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)** -- 分层架构图、模块依赖关系图、数据流图（热路径与刷新路径）、数据库模式（ERD）、迁移系统、错误分类体系，以及带有注释的设计决策。
- **[API.md](packages/core/API.md)** -- 完整的公共 API 参考文档，涵盖 `NpmSafeEngine` 类（全部 12 个方法）、导出的接口，以及所有类型定义（`SecurityLevel`、`Severity`、`FindingCategory`、`CheckResult`、`ScanFinding`、`StaticScanReport` 等）。
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)** -- 所有 10 条内置静态分析规则的完整参考。每条规则均文档化了其类别、严重级别、检测逻辑（正则表达式模式）和缓解建议。
  - **[HANDOVER.md](packages/core/HANDOVER.md)** -- 第一阶段到第二阶段的交接文档。涵盖已构建的内容、被推迟的内容、已知问题、开发注意事项，以及建议的第二阶段实施顺序。另有中文版 **[HANDOVER_zh.md](packages/core/HANDOVER_zh.md)**。
  - **[README_zh.md](README_zh.md)** -- 本项目的简体中文版 README。

桌面 GUI 位于 `packages/desktop/`，详见
[桌面端 README](packages/desktop/README.md)。

---

## 目录结构

```
npm-store/
  pnpm-workspace.yaml          # workspace = packages/*
  tsconfig.base.json           # 共享 TypeScript 配置（ESNext, strict）
  .codegraph/
    .gitignore
  .omo/                        # OpenCode 规划与证据（内部）
  packages/
    core/
      package.json             # @npm-safe/core v0.1.0, ESM, private
      tsconfig.json            # extends ../../tsconfig.base.json
      src/
        index.ts               # NpmSafeEngine 门面 — 统一公共 API
        cli/
          cli.ts               # CLI 入口 — commander 程序 + check 简写
          check.ts             # check 命令（与简写共用）
          search.ts            # search 命令
          watch.ts             # 监控列表命令（list/add/remove）
          refresh.ts           # refresh 命令
          settings.ts          # settings get/set 命令
          lang.ts              # lang 命令（en/zh，持久化）
          i18n.ts              # 中英文双语模块
          shared.ts            # 引擎工厂 + 默认数据库路径
        registry/
          types.ts             # PackageMetadata, AbbreviatedVersion, SearchResult, NpmRegistryError
          validator.ts         # validatePackageName, validateVersion, validateDomain, isKnownRegistryDomain
          client.ts            # NpmRegistryClient — HTTP 请求，含重试、退避与代理支持
        scanner/
          types.ts             # SecurityLevel, Severity, ScanFinding, ScanRule, StaticScanReport
          static-rules.ts      # StaticAnalyzer — 10 条内置分析规则
        scheduler/
          rate-limiter.ts      # TokenBucket — 5 tokens/s, 10 burst
          refresh-scheduler.ts # RefreshScheduler — 通过 EventEmitter 实现定时刷新监控列表
        store/
          schema.ts            # SCHEMA_SQL (DDL), getMigrationList, getInitialMigration
          database.ts          # DatabaseManager — better-sqlite3, WAL 模式, 迁移系统
          cache-manager.ts     # CacheManager — 基于 TTL 的缓存读写，用于包、报告、监控列表、设置
        translator/
          types.ts             # TranslationProvider 接口, 目标语言配置
          provider.ts          # 内置翻译提供者实现
      test/
        validator.test.ts      # 包名/版本/域名校验测试
        static-rules.test.ts   # 10 条规则 + 评分/等级测试
        rate-limiter.test.ts   # 令牌桶测试
        store.test.ts          # 数据库 + 缓存管理器测试
        client.test.ts         # 注册表客户端测试（mock fetch、代理）
        refresh-scheduler.test.ts # 调度器事件测试
        engine.test.ts         # NpmSafeEngine 集成测试
        cli.test.ts            # CLI 测试（命令、语言、简写）
    desktop/                         # @npm-safe/desktop（Neutralinojs 桌面 GUI）
      package.json                   # 桌面工作区包
      neutralino.config.json         # Neutralino 应用配置（无边框、扩展）
      resources/
        index.html                   # Material You 界面（Navigation Drawer）
        styles.css                   # M3 浅色/深色主题、自定义标题栏
        js/main.js                   # 前端 IPC 桥接 + 仪表盘逻辑
        extensions/core/main.mjs     # 承载 NpmSafeEngine 的 Node.js 扩展
```

---

## 架构

引擎由五层组成。每层仅依赖其下方的层。`index.ts` 门面层组合所有依赖并将结果暴露为单一的 `NpmSafeEngine` 类。

```
                           +-----------------------+
                           |      index.ts          |
                           |  NpmSafeEngine 门面    |
                           |  12 个公共方法          |
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
| **Scanner（扫描器层）** | `scanner/static-rules.ts`, `scanner/types.ts` | 对包元数据和 README 内容进行纯静态分析。十条内置规则可检测安装脚本、代码混淆、仿冒包名、密钥泄露、同形字符攻击等。 |
| **Scheduler（调度器层）** | `scheduler/refresh-scheduler.ts`, `scheduler/rate-limiter.ts` | 管理被监控包的定时刷新周期。令牌桶（5 tokens/s, 10 burst）限制注册表请求频率。 |
| **Store（存储层）** | `store/database.ts`, `store/cache-manager.ts`, `store/schema.ts` | 基于 better-sqlite3 的持久化存储，使用 WAL 模式。处理数据库迁移、基于 TTL 的元数据和扫描报告缓存、监控列表持久化，以及键值设置。 |
| **Facade（门面层）** | `index.ts` | `NpmSafeEngine` 类组合上述四层。暴露 12 个公共方法：`checkPackage`、`searchPackages`、监控列表 CRUD、刷新操作、设置访问，以及生命周期管理（`startAutoRefresh`、`stopAutoRefresh`、`close`）。 |

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

第一阶段交付了可用的、tsc 无错误的引擎核心。第二阶段已完成测试、CLI、代理支持和 Neutralinojs 桌面 GUI。第三阶段剩余工作：

- **基于大语言模型的扫描提供者。** 将翻译器层与大语言模型（本地或远程）集成，用于包行为的语义分析和功能不匹配检测。
- **批量操作。** 多包 `checkPackage`、批量搜索导出、仪表盘报告下载。
- **插件系统。** 允许第三方扫描规则和输出格式化器动态注册。
- **CI/CD 集成。** 提供 GitHub Action 或 CLI 工具，在 CI 流水线中执行 `@npm-safe/core` 检查。
