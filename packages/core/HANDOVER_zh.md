# @npm-safe/core：第一阶段到第二阶段交接文档

**日期：** 2026-08-01
**包名：** @npm-safe/core v0.1.0 + @npm-safe/desktop v0.1.0
**状态：** 第一阶段已完成（引擎核心）。第二阶段已完成（测试、CLI、代理、桌面 GUI）。13 个源文件，零 TypeScript 错误，端到端冒烟测试通过。

> **更新（2026-07-31）：** 第二阶段第 1-3 项已完成。完整测试套件（193 个测试全部通过）覆盖每个模块；`ReadonlySet` 问题已验证为不存在；CLI 命令行工具（`check`、`search`、`watch`、`refresh`、`settings`、`lang`）已实现，并支持代理和中英文切换。
> **更新（2026-08-01）：** 第二阶段第 5 项（Web UI）已完成，采用 Neutralinojs 桌面 GUI 方案，位于 `packages/desktop/`。包含 Material You 风格总览仪表盘（半圆仪表、最近检查、近7日柱状图、总数/风险统计）、检查/搜索/监控/设置标签页、浅色/深色主题、支持拖动/最小化/关闭的自定义标题栏，以及持久化到 `~/.npm-safe/history.json` 的检查历史。

[English](HANDOVER.md)

---

## 1. 已完成内容

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
- `undici` ^7.0.0 和 `type-fest` ^4.0.0 作为依赖（undici 在第一阶段未使用；为第二阶段预留）
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

## 2. 未构建内容（推迟到第二阶段）

以下功能被有意推迟，按大致优先级排序。

1. **单元测试和集成测试。** 第一阶段零测试。这是第二阶段最高优先级的任务。每个模块都需要覆盖：`validator.ts`、`client.ts`（mock fetch）、`static-rules.ts`（每条规则）、`rate-limiter.ts`（计时）、`refresh-scheduler.ts`（事件）、`database.ts`（迁移）、`cache-manager.ts`（TTL、upsert）、`index.ts`（集成测试）。

2. **网络层自适应速率限制。** `TokenBucket` 使用固定的 5 tokens/s。没有根据注册表响应时间或 HTTP 429 响应动态调整补充速率的机制。

3. **基于 LLM 的分析提供者。** `scanner/types.ts` 中已定义 `LlmScanReport` 类型，但未实现任何 LLM 提供者。`ScanReport` 类型包含 `llmScan?: LlmScanReport` 字段，但没有任何代码向其写入数据。

4. **CLI 命令行工具。** 不存在命令行界面。引擎仅作为库使用。第二阶段应添加 `commander` 或 `yargs` 依赖并创建 `bin/` 入口点。

5. **~~Web UI。~~** 已完成 —— 位于 `packages/desktop/` 的 Neutralinojs 桌面 GUI，采用 Material You 设计，包含仪表盘、标签页、主题切换和检查历史。

6. **除 refreshAll 之外的批量 API。** `refreshAll()` 串行刷新过期包。没有多包名的批量 `checkPackage`、批量搜索、GUI 批量报告导出。

7. **遥测和分析。** 无使用追踪、无指标收集、无超出事件发射器的结构化日志。

8. **自定义规则的插件系统。** `StaticAnalyzer` 构造函数接受可选的 `ScanRule[]` 数组，但没有动态发现、注册 API 或第三方规则配置文件。

9. **CI/CD 流水线。** 无 GitHub Actions、无 npm 发布配置、无版本更新工作流。

10. **npm 发布者配置。** `package.json` 中标记为 `"private": true`。无 `.npmignore`、无 `publishConfig`、无来源证明设置。

---

## 3. 已知问题

### 3.1 `validator.ts` 中将 `ReadonlySet` 用作值（第 52 行）— 已验证：无此问题

`KNOWN_REGISTRY_DOMAINS` 常量的声明为：

```typescript
const KNOWN_REGISTRY_DOMAINS: ReadonlySet<string> = new Set<string>([...]);
```

`ReadonlySet<string>` 是 TypeScript 工具类型，此处用作类型标注；`new Set<string>(...)` 是运行时值。这是合法的 TypeScript 写法，`tsc --noEmit` 在 strict 模式下零错误。最初担心 `ReadonlySet` 被当作运行时值使用，但代码中仅将其用作类型标注。

**状态：** 无需修复。已通过 `pnpm -F @npm-safe/core exec tsc --noEmit` 验证（零错误）。

### 3.2 顶层 `npx tsc` 不可用

工作区根目录不会将 TypeScript 提升到 `node_modules/.bin/`。在 monorepo 根目录运行 `npx tsc` 会因缺少二进制文件而失败。参见注意事项 4.1 的替代方案。

### 3.3 `security_reports` 表仅存储数值分数

`security_reports.overall_score` 列类型为 `INTEGER`。`SecurityLevel` 字符串枚举由 `CacheManager.getSecurityReport()` 通过 `cache-manager.ts`（第 94-99 行）中的局部 `scoreToLevel()` 辅助函数重建。此辅助函数使用与 `static-rules.ts`（第 732-737 行）中 `StaticAnalyzer.levelFromScore()` 相同的阈值：>=80 Safe、>=50 Suspicious、>=20 Dangerous。

**维护负担：** 如果阈值在一处变更，另一处也必须同步更新。建议在第二阶段将阈值提取到共享常量模块中。

### 3.4 重复的 `repositoryToString()` 辅助函数

`index.ts`（第 439-443 行）中的模块级 `repositoryToString()` 函数与 `cache-manager.ts`（第 109-113 行）中的私有 `repositoryToString()` 函数重复。两者实现相同逻辑：结构化 `PackageRepository` -> `"type:url"`，字符串 -> 原样返回，undefined -> `""`。

**维护负担：** 仓库字符串格式的修改必须在两处同时应用。建议在第二阶段重构为共享工具函数。

### 3.5 未提交构建输出目录

`dist/` 目录不在版本控制中。在包作为库使用之前，需要运行 `tsc` 生成构建输出。`package.json` 中的 `main` 和 `types` 字段分别指向 `./dist/index.js` 和 `./dist/index.d.ts`。

### 3.6 `undici` 依赖未使用

`package.json` 将 `undici` ^7.0.0 列为依赖。第一阶段源文件中未导入该模块。如果在第二阶段中仍保持未使用，建议移除。

### 3.7 `type-fest` 依赖未使用

`package.json` 将 `type-fest` ^4.0.0 列为依赖。第一阶段源文件中未导入该模块。引入它是为了在未来阶段可能需要使用的工具类型。

---

## 4. 第二阶段注意事项

### 4.1 tsc 调用（关键）

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

### 4.2 枚举类型的值导入 vs 类型导入

`SecurityLevel` 和 `Severity` 是 TypeScript `enum` 声明。枚举会生成运行时值，因此**必须**使用值导入：

```typescript
// ✓ 正确
import { SecurityLevel } from './scanner/types.js';

// ✗ 错误 — 运行时将为 undefined
import type { SecurityLevel } from './scanner/types.js';
```

此规则同样适用于 `ScanType`、`FindingCategory` 和 `TranslatorProviderType`。有疑问时，对任何枚举使用值导入。

### 4.3 better-sqlite3 中 `Database` 命名空间的值导入

better-sqlite3 中的 `Database` 被用作命名空间（`Database.Database`），需要值导入：

```typescript
// ✓ 正确
import Database from "better-sqlite3";

// ✗ 错误 — TS2702 "only refers to a type, used as namespace"
import type Database from "better-sqlite3";
```

此导入在运行时值层面未使用（仅使用类型命名空间）。`tsconfig.base.json` 中 `noUnusedLocals` 编译选项已关闭，因此未使用的值导入不会导致编译错误。

### 4.4 事件负载的 `satisfies` 模式

`RefreshScheduler` 在事件 `emit()` 调用中使用 `satisfies` 来验证调用点的负载类型，而不会扩大类型：

```typescript
this.emit('refresh:start', { packageName: name } satisfies RefreshStartPayload);
```

此模式强制类型安全，无需在 emit 参数上添加显式类型标注。第二阶段新增的任何事件类型应遵循相同模式。

### 4.5 `AbbreviatedVersion` 到 `Record<string, unknown>` 的双重类型转换

将 `AbbreviatedVersion` 清单转换为供静态分析器使用的纯 `Record<string, unknown>` 需要双重类型转换，因为 `AbbreviatedVersion` 是只读接口：

```typescript
const packageJson = ({ ...manifest } as unknown as Record<string, unknown>);
```

展开操作（`{ ...manifest }`）创建了可变副本。双重转换（`as unknown as ...`）解决了只读到可变的类型不兼容问题。此模式同时出现在 `index.ts`（第 216 行）和 `refresh-scheduler.ts`（第 202 行）中。

### 4.6 迁移名称类型为 `string` 而非联合类型

`getMigrationList()` 返回 `string[]`，而非字面量联合类型。这意味着 exhaustive `never` switch 守卫对迁移名称不起作用：

```typescript
// 这段代码无法编译
switch (name) {
  case "001_initial.sql": return getInitialMigration();
  default: const exhaustive: never = name; // TS2322: type 'string' not assignable to 'never'
}
```

请改用普通 `default: throw` 并抛出 `DatabaseManagerError`（如 `database.ts` 第 46 行所示）。

### 4.7 `_migrations` 表在两处创建

`_migrations` 跟踪表既在 `SCHEMA_SQL` 中创建（`schema.ts`），又在 `DatabaseManager` 构造函数中的迁移循环之前创建（`database.ts` 第 120-126 行）。`database.ts` 中的预创建是有意为之：它确保在第一个迁移运行之前跟踪表已存在，从而使第一个迁移可以被记录。这不是 bug，但可能给维护者造成困惑。

### 4.8 ESM 导入使用 `.js` 扩展名

所有相对导入均使用 `.js` 文件扩展名，遵循 Node.js 原生 ESM 约定：

```typescript
import { DatabaseManager } from './store/database.js';  // 磁盘上实际是 .ts 文件
```

TypeScript 编译器通过 `bundler` 模块解析设置自动将 `.js` 说明符解析为 `.ts` 源文件。不要在导入说明符中使用 `.ts` 扩展名。

### 4.9 TokenBucket 的 interval 定时器

`TokenBucket` 使用 100ms 的 `setInterval` 进行补充 tick。定时器被 unref 以防止保持 Node.js 事件循环运行。如果第三阶段添加依赖定时的测试，需要 mock 此定时器，或测试需要考虑异步补充行为。

### 4.10 桌面 GUI 历史记录持久化

桌面 GUI 扩展将每次成功的 `checkPackage` 结果记录到 `~/.npm-safe/history.json`，最多保留 1000 条。仪表盘通过 `getHistory` 扩展事件读取该文件。该文件与 SQLite 缓存/设置数据库相互独立，仅用于 UI 分析展示。

---

## 5. 第三阶段建议实施顺序

第二阶段已完成。第三阶段应聚焦大语言模型集成、批量操作和分发部署。

| 优先级 | 工作项 | 理由 |
|---|---|---|
| 1 | **实现 LLM 扫描提供者** | 将 `translator/provider.ts` 骨架接入实际 API，把 `LlmScanReport` 集成到 `checkPackage` 和调度器中。 |
| 2 | **添加 GUI 批量操作** | 多包检查、批量搜索导出、仪表盘报告下载。 |
| 3 | **添加插件框架** | 设计基于配置或目录的插件发现系统，用于自定义 `ScanRule` 注册。 |
| 4 | **遥测和分析** | 添加结构化日志（pino 或 winston）、可选使用报告和 Prometheus 指标导出。 |
| 5 | **CI/CD 和发布** | 设置 GitHub Actions 执行 lint、类型检查和测试。配置 npm 来源证明发布。 |

以下顺序通过自下而上构建信心来最小化风险。

| 优先级 | 工作项 | 理由 |
|---|---|---|
| 1 | **为所有模块编写单元测试** | 第一阶段零测试。没有测试，后续每次变更都是盲改。从纯模块开始（`validator.ts`、`static-rules.ts`），然后过渡到有副作用的模块（mock fetch 的 `client.ts`、内存 SQLite 的 `database.ts`、`cache-manager.ts`、`rate-limiter.ts`、`refresh-scheduler.ts`）。最后编写 `index.ts` 的集成测试。 |
| 2 | **修复 `ReadonlySet` 外观错误** | 修正 `validator.ts` 第 52 行。一行修复，消除唯一的 tsc 诊断。 |
| 3 | **构建 CLI 命令行工具** | 添加 commander 或 yargs，创建 `bin/npm-safe.ts`，实现 `check`、`search`、`watch`、`refresh`、`settings` 等命令。使工具可从终端直接使用，无需编写代码。 |
| 4 | **实现 LLM 扫描提供者** | 将 `translator/provider.ts` 骨架连接到实际 API 调用。将 `LlmScanReport` 集成到 `checkPackage` 和调度器中。 |
| 5 | **添加插件框架** | 设计基于配置或基于目录的插件发现系统，用于自定义 `ScanRule` 注册。 |
| 6 | **遥测和分析** | 添加结构化日志（pino 或 winston）、可选的使用报告和 Prometheus 指标导出。 |
| 7 | **CI/CD 和发布** | 设置 GitHub Actions 用于 lint、类型检查和测试。配置 npm 来源证明发布。 |
