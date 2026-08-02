# @npm-safe/core：项目交接文档

**日期：** 2026-08-01
**包名：** @npm-safe/core v0.1.0 + @npm-safe/desktop v0.1.0
**状态：** 所有第一阶段和第二阶段计划均已完成。引擎核心（13 个源文件）和 CLI（9 个文件）已交付，205 个测试全部通过，代理支持、中英文本地化以及多提供者 LLM 扫描（OpenAI / Gemini / Anthropic）已上线，零 TypeScript 错误。基于 Neutralinojs 的桌面 GUI（原生 JS、Material You）已随 `packages/desktop/` 交付。

[English](HANDOVER.md)

---

## 1. 计划状态总览

本文档记录每个项目计划及其完成状态。

| 计划 | 状态 | 备注 |
|---|---|---|
| 第一阶段：引擎核心（`npm-safe-phase1`） | **已完成** | 13 个源文件，tsc 零错误，冒烟测试通过 |
| 第一阶段：文档包（`phase1-documentation`） | **已完成** | README、README_zh、ARCHITECTURE、API、SCANNER_RULES、HANDOVER、HANDOVER_zh |
| 第二阶段：测试套件 | **已完成**（2026-07-31） | 205 个测试全部通过，11 个测试文件 |
| 第二阶段：CLI 命令行工具 | **已完成**（2026-07-31） | `src/cli/` 下 9 个文件，6 个命令，`npm-safe` 可执行文件 |
| 第二阶段：代理支持 | **已完成**（2026-07-31） | `undici.ProxyAgent`，标志 > 设置 > 环境变量解析，`NO_PROXY` 绕过，4 个测试 |
| 第二阶段：i18n | **已完成**（2026-07-31） | 中英文 CLI 本地化，持久化的 `lang` 命令，HANDOVER_zh.md |
| 基于 LLM 的扫描提供者 | **已完成**（2026-08-01） | 多提供者：OpenAI / Gemini / Anthropic，见第 3.5 节 |
| 桌面 GUI（`packages/desktop`） | **已完成**（2026-08-01） | Neutralinojs + 原生 JS + Material You（M3），见第 3.6 节 |
| Neutralinojs 图形界面（MD3） | **已完成**（2026-08-01） | 已随 `packages/desktop` 交付，基于 Neutralinojs 的窗口应用，采用 Material 3（MD3）设计体系（浅色/深色主题）。原始的 Preact+mdui 方案已被交付的原生 JS 实现取代，后者已满足 MD3 要求。 |
| AI 技能打包 | **已完成**（2026-08-02） | 全局技能 `npm-safe-scan` 已安装于 `~/.agents/skills/npm-safe-scan/SKILL.md`；将 CLI 打包为供任意 AI 代理（opencode、Claude Code）使用的技能。 |
| 插件系统 | 待办 | 未来阶段 |
| CI/CD 集成 | 待办 | 未来阶段 |
| 多包批量 API | 待办 | 未来阶段 |
| 遥测与分析 | 待办 | 未来阶段 |
| npm 发布者配置 | 待办 | 未来阶段 |

---

## 2. 第一阶段：引擎核心（已完成）

第一阶段通过 5 个批次共 14 个实现任务交付了核心 `@npm-safe/core` 引擎，随后完成了 4 个并行的验证审查。该包位于 pnpm monorepo 工作区根目录下的 `packages/core/` 中。

### 源文件

所有源文件位于 `packages/core/src/` 目录下：

| 文件 | 职责 |
|---|---|
| `index.ts` | `NpmSafeEngine` 门面 — 组合所有依赖，暴露 12 个公共方法 |
| `registry/types.ts` | 基础类型定义：`PackageMetadata`、`AbbreviatedVersion`、`SearchResult`、`NpmRegistryError`、`PackageIdentifier`、`ValidationResult` |
| `registry/validator.ts` | 纯校验器：`validatePackageName`、`validateVersion`、`validateDomain`、`isKnownRegistryDomain` |
| `registry/client.ts` | `NpmRegistryClient` — HTTP 请求，10s 超时，3 次重试，指数退避（1s/2s/4s） |
| `scanner/types.ts` | 枚举类型：`SecurityLevel`、`Severity`、`ScanType`、`FindingCategory`。接口：`ScanRule`、`ScanFinding`、`StaticScanReport`、`LlmScanReport`、`ScanReport`、`SecuritySummary` |
| `scanner/static-rules.ts` | `StaticAnalyzer` 类 + 10 条内置 `ScanRule` 实现：install-script、eval-obfuscation、base64-shell、binary-links、typosquatting、secret-exposure、child-process-browser、suspicious-build-metadata、homograph-attack、registry-mismatch |
| `scheduler/rate-limiter.ts` | `TokenBucket` — 5 tokens/s 补充速率，10 突发容量，100ms tick 粒度的连续补充 |
| `scheduler/refresh-scheduler.ts` | `RefreshScheduler` 继承 `EventEmitter` — 定时刷新监控列表，默认间隔 1 小时 |
| `store/schema.ts` | DDL 模式：6 张业务表 + `_migrations` 跟踪表、迁移列表、初始迁移 SQL |
| `store/database.ts` | `DatabaseManager` — better-sqlite3 连接，WAL 模式 pragma 配置，迁移执行器 |
| `store/cache-manager.ts` | `CacheManager` — 基于 TTL 的包元数据、安全报告、监控列表、设置的读写操作 |
| `translator/types.ts` | `TranslatorProviderType` 枚举、`TranslationResult`、`TranslatorConfig`、`ProviderNotConfigured`、`TranslationError` |
| `translator/provider.ts` | `TranslatorProvider` 接口、`DeepLAdapter` 和 `OpenAIAdapter` 骨架实现、`createTranslator` 工厂函数 |

### 架构概览

引擎由五层组成，`index.ts` 作为组合根：

```
                    NpmSafeEngine (index.ts)
                   /          |            \
           Registry       Scanner        Scheduler
        (client.ts)   (static-rules.ts)  (refresh-scheduler.ts)
              \            |            /
                Store (database.ts + cache-manager.ts)
```

辅助翻译器层（`translator/`）提供了可插拔的翻译接口，但第一阶段尚未接入核心扫描流水线。

### 公共 API（`NpmSafeEngine` 上的 12 个方法）

- `checkPackage(name)` — 缓存优先的安全检查；返回包含元数据 + 静态扫描报告的 `CheckResult`
- `searchPackages(query, size?)` — 委托给 registry 搜索端点
- `getWatchlist()` / `addToWatchlist(name)` / `removeFromWatchlist(name)` — 监控列表 CRUD
- `refreshPackage(name)` / `refreshAll()` — 限流的 registry 刷新，并通过事件通知
- `getSetting(key)` / `setSetting(key, value)` — 键值设置访问
- `startAutoRefresh(intervalMs?)` / `stopAutoRefresh()` — 定时刷新的生命周期管理
- `close()` — 优雅关闭（停止调度器、释放限流器、关闭数据库）

### 技术栈

- TypeScript 5.9.3，strict 模式，`ESNext` target，`bundler` 模块解析
- ESM（`"type": "module"`），所有导入使用 `.js` 扩展名
- pnpm workspace monorepo
- better-sqlite3 ^11.0.0 用于 SQLite 持久化（WAL 模式、`busy_timeout=5000`、`synchronous=NORMAL`）
- `undici` ^7.0.0（自第二阶段起用于代理支持）和 `type-fest` ^4.0.0 作为依赖
- 不提交构建产物 — 构建时通过 `tsc` 编译到 `dist/`

### 验证结果

- 通过 `pnpm -F @npm-safe/core exec tsc --noEmit` 验证，tsc 零错误零警告
- 模块图已解析：`index.ts` 中的 10 个相对导入均解析到现有文件，传递遍历无误
- 12 个公共 API 方法均可通过 `NpmSafeEngine` 实例访问
- 构造函数依赖注入已验证：6 个依赖均正确实例化
- `index.ts` 导出 3 个符号：`NpmSafeEngine`、`NpmSafeEngineOptions`、`CheckResult`

### 关键设计决策

| 决策 | 理由 |
|---|---|
| 仅 ESM | 与现代 Node.js 生态保持一致。所有导入使用 `.js` 扩展名。 |
| 严格 TypeScript，禁止 `any` | 每个函数和接口均完整类型化。零隐式 `any`。 |
| 每模块 250 行代码上限 | 确保每个文件职责集中、便于审查。`index.ts` 因组合职责略微超过此限制。 |
| SQLite via better-sqlite3 | 零配置嵌入式数据库。WAL 模式安全支持并发读取。 |
| 纯静态分析（无网络请求） | 扫描器仅检查注册表客户端已获取的元数据和 README。 |
| TokenBucket 速率限制器 | 5 tokens/s 补充速率，10 突发容量。基于实际时间的连续补充。 |
| 缓存优先 + TTL 过期策略 | 默认 1 小时 TTL。过期行返回为缓存未命中，不返回脏数据。 |
| SecurityLevel/Severity 使用字符串枚举 | 安全记录、序列化，可在 switch 语句中使用，无反向映射问题。 |
| 基于分数的安全等级 | 分数从 100 起算，减去严重性权重。阈值：>=80 安全，>=50 可疑，>=20 危险。 |

---

## 3. 第二阶段：测试、CLI、代理、i18n、LLM 扫描提供者（已完成）

第二阶段于 2026-07-31 交付，LLM 扫描提供者于 2026-08-01 完成。本阶段添加了完整的测试套件、终端 CLI 命令行工具、受限网络的代理支持、中英文本地化，以及多提供者 LLM 扫描核心。五条工作流全部完成并通过验证。

### 3.1 测试套件

205 个测试分布在 11 个文件中，全部通过。运行方式：

```
pnpm -F @npm-safe/core test
```

测试运行器是 Node.js 内置测试运行器，通过 `tsx` 调用（`node --import tsx --test --test-reporter spec "test/**/*.test.ts"`）。

| 测试文件 | 覆盖范围 |
|---|---|
| `test/validator.test.ts` | 包名、版本和域名校验 |
| `test/static-rules.test.ts` | 全部 10 条规则以及评分和等级映射 |
| `test/rate-limiter.test.ts` | 令牌桶计时和突发行为 |
| `test/store.test.ts` | 数据库管理器（迁移）和缓存管理器（TTL、upsert） |
| `test/client.test.ts` | 使用 mock fetch、重试/退避和代理路径的注册表客户端 |
| `test/refresh-scheduler.test.ts` | 调度器事件和监控列表刷新周期 |
| `test/engine.test.ts` | `NpmSafeEngine` 集成接口 |
| `test/cli.test.ts` | CLI 命令、语言切换和简写调用 |
| `test/llm-provider.test.ts` | `createLlmProvider` 工厂函数和共享的提供者行为 |
| `test/llm-gemini.test.ts` | Gemini 提供者的请求/响应处理 |
| `test/llm-anthropic.test.ts` | Anthropic 提供者的请求/响应处理 |

### 3.2 CLI 命令行工具

`packages/core/src/cli/` 下新增 9 个文件：`cli.ts`、`check.ts`、`search.ts`、`watch.ts`、`refresh.ts`、`settings.ts`、`lang.ts`、`i18n.ts`、`shared.ts`。

命令：

- `check <package>` — 运行安全检查（也可通过 `npm-safe <package>` 简写调用）
- `search <query>` — 搜索 npm 注册表
- `watch list` / `watch add <package>` / `watch remove <package>` — 监控列表管理
- `refresh [package]` — 刷新单个包；省略时刷新所有监控的包
- `settings get <key>` / `settings set <key> <value>` — 读写持久化设置
- `lang [en|zh]` — 获取或设置输出语言（持久化）

全局选项：

- `-d, --db <path>` — 自定义 SQLite 数据库路径（默认 `~/.npm-safe/npm-safe.db`）
- `-p, --proxy <url>` — 注册表请求的 HTTP 代理
- `-j, --json` — JSON 输出
- `-v, --version` — 打印版本

`package.json` 声明了 `"bin": { "npm-safe": "./dist/cli/cli.js" }`，由 `commander` ^15 依赖支撑。构建方式：

```
pnpm -F @npm-safe/core run build
```

### 3.3 代理支持

`registry/client.ts` 现在通过 `undici.ProxyAgent` 路由注册表请求。代理解析顺序：

1. `--proxy` CLI 标志
2. 持久化的 `proxy` 设置（`npm-safe settings set proxy <url>`）
3. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量

`NO_PROXY` 环境变量通过精确匹配、`.suffix` 后缀匹配或 `*` 绕过代理。四个专门的代理测试覆盖了解析顺序和绕过规则。

### 3.4 i18n

CLI 内置中英文本地化模块（`cli/i18n.ts`）。`lang` 命令读写持久化的语言设置，因此选择在多次调用之间保持。中文交接文档为 `HANDOVER_zh.md`。

### 3.5 LLM 扫描提供者

可选的语义扫描现在通过 `LlmProviderType` 支持三种后端：OpenAI 兼容的
chat-completions 端点（`OpenAi`）、Google Gemini（`Gemini`）和 Anthropic
Claude（`Anthropic`）。统一的 `LlmProviderOptions` 接口为
`createLlmProvider(options?)` 工厂提供配置，工厂根据 `options.provider`
分派实现，默认使用 OpenAI 兼容提供者。`OpenAICompatibleLlmOptions` 保留为
已弃用的向后兼容别名。

提供者实现（均在 `packages/core/src/llm/` 下）：

- `OpenAICompatibleLlmProvider`（`provider.ts`）：`/chat/completions` 接口，环境变量回退 `OPENAI_API_KEY`，默认模型 `gpt-4o-mini`
- `GeminiLlmProvider`（`gemini.ts`）：`models/<model>:generateContent`，环境变量回退 `GEMINI_API_KEY`，默认模型 `gemini-2.0-flash`
- `AnthropicLlmProvider`（`anthropic.ts`）：`/v1/messages`，环境变量回退 `ANTHROPIC_API_KEY`，默认模型 `claude-3-5-sonnet-latest`

共享的解析/校验辅助函数和 `LlmProviderError` 类位于 `llm/parse.ts`；
`LlmProviderError` 从 `provider.ts` 重新导出以保持向后兼容。CLI
（`cli/shared.ts`）按优先级顺序（`ANTHROPIC_API_KEY`，其次
`GEMINI_API_KEY`，最后 `OPENAI_API_KEY`）从环境变量自动检测提供者，并将
所选选项接入 `NpmSafeEngineOptions.llm`。三个专门的测试文件覆盖提供者
工厂和两个新增后端。

### 3.6 桌面 GUI（`packages/desktop`）

基于 Neutralinojs 的桌面 GUI 于 2026-08-01 交付。它是一套独立的原生 JS
实现（未使用 Preact/mdui），采用 Material You / Material Design 3 色彩令牌
设计。桌面包采用 Apache-2.0 许可证。

- **架构：** Neutralinojs 主进程启动一个 Node.js 扩展进程
  （`resources/extensions/core/main.mjs`）承载 `NpmSafeEngine`。前端通过
  `Neutralino.extensions.dispatch` 经 WebSocket IPC 与扩展通信。
- **视图：** 总览仪表盘（平均评分半圆仪表、最近检查、近7日柱状图、总数、
  风险分布）、检查、搜索、监控和设置。
- **窗口边框：** 无边框窗口配自定义标题栏——可拖动区域、最小化和关闭按钮，
  以及浅色/深色主题切换。两套独立的 M3 配色：深色种子 `#4f8cff`，浅色
  种子 `#7c2d12`。
- **历史记录：** 每次成功的 `checkPackage` 由扩展记录到
  `~/.npm-safe/history.json`（最多 1000 条），仪表盘通过 `getHistory`
  事件读取。
- **Windows 首次运行：** 需要一次性执行 WebView2 回环豁免：
  `CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"`。

运行方式：`cd packages/desktop && pnpm run`（开发）或
`pnpm run build:release`。

### 3.7 AI 技能打包

全局技能 `npm-safe-scan` 于 2026-08-02 安装至
`~/.agents/skills/npm-safe-scan/SKILL.md`。它将 `npm-safe` CLI 打包为可供
任意 AI 代理（opencode、Claude Code）使用的代理技能，暴露工具的各个命令
（check、search、watch、refresh、settings、lang），使代理能够直接调用
它们来扫描 npm 包。该技能随包一同分发于 `opencode-skill/npm-safe-scan/SKILL.md`，
并在每次安装本包时通过 `postinstall` 钩子（`scripts/install-skill.mjs`）
自动安装至 `~/.agents/skills/`。

---

## 4. 文档交付物（已完成）

第一阶段文档包以及第二阶段更新已完成：

| 文档 | 用途 |
|---|---|
| `README.md`（工作区根目录） | 英文项目说明：安装配置、CLI 用法、架构、设计决策、阶段状态 |
| `README_zh.md`（工作区根目录） | 说明文档的中文翻译，与英文版互相链接 |
| `packages/core/ARCHITECTURE.md` | 层映射、模块依赖图、数据流（热路径和刷新路径）、数据库模式、迁移系统、错误分类、设计决策 |
| `packages/core/API.md` | 完整公共 API 参考：`NpmSafeEngine`（全部 12 个方法）、导出的接口和类型定义 |
| `packages/core/SCANNER_RULES.md` | 全部 10 条内置规则的参考：类别、严重性、检测逻辑、缓解措施 |
| `packages/core/HANDOVER.md` | 本文档，英文版 |
| `packages/core/HANDOVER_zh.md` | 中文交接文档 |

---

## 5. 剩余计划（未来阶段）

以下计划尚未启动。它们按大致优先级排列。
Neutralinojs 图形界面（MD3）计划已交付，不再列入下表；详见第 3.6 节
已交付的桌面 GUI。

| 优先级 | 计划 | 描述 |
|---|---|---|
| 1 | **插件系统** | 动态注册第三方 `ScanRule`。`StaticAnalyzer` 构造函数已经接受可选的 `ScanRule[]` 数组；增加发现机制、注册 API 和配置文件。 |
| 2 | **CI/CD 集成** | 一个 GitHub Action 或 CLI 工具，作为 CI 流水线的一部分运行 `@npm-safe/core` 检查。 |
| 3 | **多包批量 API** | 在 `refreshAll()` 之外扩展：支持多包名的批量 `checkPackage`、批量搜索和批量报告导出。 |
| 4 | **遥测与分析** | 结构化日志、可选的使用报告和指标导出。 |
| 5 | **npm 发布者配置** | 该包目前为 `"private": true`。当需要发布时，添加 `publishConfig`、`.npmignore` 和来源证明（provenance）设置。 |

---

## 6. 已知问题

### 6.1 `validator.ts` 中将 `ReadonlySet` 用作值（第 52 行）— 已验证：无此问题

`KNOWN_REGISTRY_DOMAINS` 常量的声明为：

```typescript
const KNOWN_REGISTRY_DOMAINS: ReadonlySet<string> = new Set<string>([...]);
```

`ReadonlySet<string>` 是 TypeScript 工具类型，此处用作类型标注；`new Set<string>(...)` 是运行时值。这是合法的 TypeScript 写法，`tsc --noEmit` 在 strict 模式下零错误。最初担心 `ReadonlySet` 被当作运行时值使用，但代码中仅将其用作类型标注。

**状态：** 无需修复。已通过 `pnpm -F @npm-safe/core exec tsc --noEmit` 验证（零错误）。

### 6.2 顶层 `npx tsc` 不可用

工作区根目录不会将 TypeScript 提升到 `node_modules/.bin/`。在 monorepo 根目录运行 `npx tsc` 会因缺少二进制文件而失败。参见注意事项 7.1 的替代方案。

### 6.3 `security_reports` 表仅存储数值分数

`security_reports.overall_score` 列类型为 `INTEGER`。`SecurityLevel` 字符串枚举由 `CacheManager.getSecurityReport()` 通过 `cache-manager.ts`（第 94-99 行）中的局部 `scoreToLevel()` 辅助函数重建。此辅助函数使用与 `static-rules.ts`（第 732-737 行）中 `StaticAnalyzer.levelFromScore()` 相同的阈值：>=80 Safe、>=50 Suspicious、>=20 Dangerous。

**维护负担：** 如果阈值在一处变更，另一处也必须同步更新。建议将阈值提取到共享常量模块中。

### 6.4 重复的 `repositoryToString()` 辅助函数

`index.ts`（第 439-443 行）中的模块级 `repositoryToString()` 函数与 `cache-manager.ts`（第 109-113 行）中的私有 `repositoryToString()` 函数重复。两者实现相同逻辑：结构化 `PackageRepository` -> `"type:url"`，字符串 -> 原样返回，undefined -> `""`。

**维护负担：** 仓库字符串格式的修改必须在两处同时应用。建议重构为共享工具函数。

### 6.5 未提交构建输出目录

`dist/` 目录不在版本控制中。在包作为库或作为 CLI 命令行工具使用之前，需要运行 `tsc` 生成构建输出。`package.json` 中的 `main` 和 `types` 字段分别指向 `./dist/index.js` 和 `./dist/index.d.ts`，`bin` 指向 `./dist/cli/cli.js`。

### 6.6 `type-fest` 依赖未使用

`package.json` 将 `type-fest` ^4.0.0 列为依赖。它没有被任何源文件导入。引入它是为了在未来阶段可能使用的工具类型。如果继续保持未使用，建议移除。

### 6.7 `undici` 在第一阶段未使用，现已使用

`undici` ^7.0.0 在第一阶段被列为依赖，当时未被任何地方导入。自第二阶段起，`registry/client.ts` 从其中导入 `ProxyAgent` 和 `Dispatcher` 以支持代理（第 31-32 行）。该依赖现在名正言顺；之前关于「未使用依赖」的备注不再适用。

---

## 7. 第二阶段注意事项

以下是开发过程中记录的实际陷阱。它们对未来的工作仍然适用。

### 7.1 tsc 调用（关键）

TypeScript 是 pnpm 隔离存储中每个包独立的 devDependency。工作区根目录的 `node_modules/.bin/` 中没有 `typescript`。

**请勿运行：**
```
npx tsc                                    # 会失败
tsc                                        # 会失败
```

**请使用以下方式之一：**
```
pnpm -F @npm-safe/core exec tsc --noEmit   # 推荐方式
node .\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc -p packages\core\tsconfig.json
```

### 7.2 枚举类型的值导入 vs 类型导入

`SecurityLevel` 和 `Severity` 是 TypeScript `enum` 声明。枚举会生成运行时值，因此**必须**使用值导入：

```typescript
// CORRECT
import { SecurityLevel } from './scanner/types.js';

// WRONG — will produce a runtime undefined
import type { SecurityLevel } from './scanner/types.js';
```

此规则同样适用于 `ScanType`、`FindingCategory`、`TranslatorProviderType` 和 `LlmProviderType`。有疑问时，对任何枚举使用值导入。

### 7.3 better-sqlite3 中 `Database` 命名空间的值导入

better-sqlite3 中的 `Database` 被用作命名空间（`Database.Database`），需要值导入：

```typescript
// CORRECT
import Database from "better-sqlite3";

// WRONG — TS2702 "only refers to a type, used as namespace"
import type Database from "better-sqlite3";
```

此导入在运行时值层面未使用（仅使用类型命名空间）。`tsconfig.base.json` 中 `noUnusedLocals` 编译选项已关闭，因此未使用的值导入不会导致编译错误。

### 7.4 事件负载的 `satisfies` 模式

`RefreshScheduler` 在事件 `emit()` 调用中使用 `satisfies` 来验证调用点的负载类型，而不会扩大类型：

```typescript
this.emit('refresh:start', { packageName: name } satisfies RefreshStartPayload);
```

此模式强制类型安全，无需在 emit 参数上添加显式类型标注。未来新增的任何事件类型应遵循相同模式。

### 7.5 `AbbreviatedVersion` 到 `Record<string, unknown>` 的双重类型转换

将 `AbbreviatedVersion` 清单转换为供静态分析器使用的纯 `Record<string, unknown>` 需要双重类型转换，因为 `AbbreviatedVersion` 是只读接口：

```typescript
const packageJson = ({ ...manifest } as unknown as Record<string, unknown>);
```

展开操作（`{ ...manifest }`）创建了可变副本。双重转换（`as unknown as ...`）解决了只读到可变的类型不兼容问题。此模式同时出现在 `index.ts`（第 216 行）和 `refresh-scheduler.ts`（第 202 行）中。

### 7.6 迁移名称类型为 `string` 而非联合类型

`getMigrationList()` 返回 `string[]`，而非字面量联合类型。这意味着 exhaustive `never` switch 守卫对迁移名称不起作用：

```typescript
// THIS DOES NOT COMPILE
switch (name) {
  case "001_initial.sql": return getInitialMigration();
  default: const exhaustive: never = name; // TS2322: type 'string' not assignable to 'never'
}
```

请改用普通 `default: throw` 并抛出 `DatabaseManagerError`（如 `database.ts` 第 46 行所示）。

### 7.7 `_migrations` 表在两处创建

`_migrations` 跟踪表既在 `SCHEMA_SQL` 中创建（`schema.ts`），又在 `DatabaseManager` 构造函数中的迁移循环之前创建（`database.ts` 第 120-126 行）。`database.ts` 中的预创建是有意为之：它确保在第一个迁移运行之前跟踪表已存在，从而使第一个迁移可以被记录。这不是 bug，但可能给维护者造成困惑。

### 7.8 ESM 导入使用 `.js` 扩展名

所有相对导入均使用 `.js` 文件扩展名，遵循 Node.js 原生 ESM 约定：

```typescript
import { DatabaseManager } from './store/database.js';  // 磁盘上实际是 .ts 文件
```

TypeScript 编译器通过 `bundler` 模块解析设置自动将 `.js` 说明符解析为 `.ts` 源文件。不要在导入说明符中使用 `.ts` 扩展名。

### 7.9 TokenBucket 的 interval 定时器

`TokenBucket` 使用 100ms 的 `setInterval` 进行补充 tick。定时器被 unref 以防止保持 Node.js 事件循环运行。依赖定时的测试必须考虑异步补充行为；现有的 `rate-limiter.test.ts` 使用假时钟处理这一问题。

### 7.10 桌面 GUI 历史记录持久化

桌面扩展将每次成功的 `checkPackage` 结果记录到 `~/.npm-safe/history.json`
（最多 1000 条）。仪表盘通过 `getHistory` 扩展事件读取该文件。此文件与
SQLite 缓存/设置数据库相互独立，仅用于 UI 分析展示——不要将其视为权威的
扫描存储。

### 7.11 桌面 IPC 消息过滤

扩展（`packages/desktop/resources/extensions/core/main.mjs`）只处理
`event` 在 `SUPPORTED_METHODS` 中的消息。携带原生 `method` 字段的消息
（例如它自身 `app.broadcast` 调用的 ACK）以及框架内部事件
（`appClientConnect`、`clientConnect` 等）必须忽略——否则会报
`Unknown method: undefined` 错误。
