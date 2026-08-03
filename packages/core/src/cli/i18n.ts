export type Locale = "en" | "zh";

const messages: Record<Locale, Record<string, string>> = {
  en: {
    "common.noPackages": "No packages on the watchlist.",
    "common.notSet": 'Setting "{key}" is not set.',

    "check.notFound": 'Package "{name}" was not found on the registry.',
    "check.label.package": "Package",
    "check.label.latestVersion": "Latest version",
    "check.label.securityLevel": "Security level",
    "check.label.score": "Score",
    "check.label.description": "Description",
    "check.label.homepage": "Homepage",
    "check.label.repository": "Repository",
    "check.label.cachedAt": "Cached at",
    "check.label.findings": "Findings",
    "check.finding.recommendation": "Recommendation",
    "check.finding.snippet": "Snippet",
    "check.finding.line": "Line",

    "search.noResults": "No packages found.",

    "watch.list.empty": "No packages on the watchlist.",
    "watch.list.header": "Watched packages",
    "watch.add.added": 'Added "{name}" to the watchlist.',
    "watch.add.notFound": 'Package "{name}" was not found on the registry.',
    "watch.remove.removed": 'Removed "{name}" from the watchlist.',

    "refresh.single": 'Refreshed "{name}".',
    "refresh.all": "Refreshed all watched packages.",
    "refresh.failed": 'Failed to refresh "{name}".',
    "refresh.failedAll": "One or more packages failed to refresh.",

    "settings.notSet": 'Setting "{key}" is not set.',
    "settings.set": 'Set "{key}" = "{value}".',

    "lang.current": 'Current language: {lang}',
    "lang.set": 'Language set to {lang}.',
    "lang.unknown": 'Unknown locale "{locale}". Supported: en, zh.',

    "rules.list.empty": "No scan rules are registered.",
    "rules.enabled": 'Rule "{ruleId}" enabled.',
    "rules.disabled": 'Rule "{ruleId}" disabled.',
    "rules.severitySet": 'Rule "{ruleId}" severity set to {severity}.',
    "rules.severityUnknown": 'Unknown severity "{severity}". Supported: low, medium, high, critical.',

    "llm.status.enabled": "Enabled",
    "llm.status.provider": "Provider",
    "llm.status.configured": "Configured",
    "llm.status.model": "Model",
    "llm.status.baseUrl": "Base URL",
    "llm.status.apiKey": "API key",
    "llm.yes": "yes",
    "llm.no": "no",
    "llm.enabled": "LLM scanning enabled.",
    "llm.disabled": "LLM scanning disabled.",
    "llm.providerSet": "LLM provider set to {provider}.",
    "llm.providerUnknown": 'Unknown provider "{provider}". Supported: {supported}.',
    "llm.keySet": "LLM API key updated.",
    "llm.modelSet": "LLM model set to {model}.",
    "llm.baseUrlSet": "LLM base URL set to {baseUrl}.",
    "llm.notConfigured": "LLM is not enabled or no API key is configured.",
    "llm.test.ok": "LLM connection OK.",
    "llm.test.fail": "LLM connection failed: {reason}",

    "ci.noManifest": 'No package.json found in "{dir}".',
    "ci.noDependencies": "No direct dependencies to scan.",
    "ci.unknownLevel": 'Unknown fail level "{level}". Supported: {supported}.',
    "ci.invalidRateLimit": 'Invalid rate limit "{value}".',
    "ci.summary": "Scanning {count} dependencies in {dir}:",
    "ci.findings": "findings",
    "ci.notFound": "not found on the registry",
    "ci.passed": "All dependencies are below the {level} threshold. Passed.",
    "ci.failed": "One or more dependencies reach the {level} threshold. Failed.",
  },

  zh: {
    "common.noPackages": "监控列表中没有包。",
    "common.notSet": '设置 "{key}" 未配置。',

    "check.notFound": '在注册表中未找到包 "{name}"。',
    "check.label.package": "包名",
    "check.label.latestVersion": "最新版本",
    "check.label.securityLevel": "安全等级",
    "check.label.score": "分数",
    "check.label.description": "描述",
    "check.label.homepage": "主页",
    "check.label.repository": "仓库",
    "check.label.cachedAt": "缓存时间",
    "check.label.findings": "发现项",
    "check.finding.recommendation": "建议",
    "check.finding.snippet": "代码片段",
    "check.finding.line": "行号",

    "search.noResults": "未找到匹配的包。",

    "watch.list.empty": "监控列表中没有包。",
    "watch.list.header": "已监控的包",
    "watch.add.added": '已将 "{name}" 加入监控列表。',
    "watch.add.notFound": '在注册表中未找到包 "{name}"。',
    "watch.remove.removed": '已将 "{name}" 从监控列表中移除。',

    "refresh.single": '已刷新 "{name}"。',
    "refresh.all": "已刷新所有监控的包。",
    "refresh.failed": '刷新 "{name}" 失败。',
    "refresh.failedAll": "一个或多个包刷新失败。",

    "settings.notSet": '设置 "{key}" 未配置。',
    "settings.set": '已将 "{key}" 设为 "{value}"。',

    "lang.current": '当前语言: {lang}',
    "lang.set": '语言已切换为 {lang}。',
    "lang.unknown": '不支持的语言 "{locale}"。支持: en, zh。',

    "rules.list.empty": "尚未注册任何扫描规则。",
    "rules.enabled": '规则 "{ruleId}" 已启用。',
    "rules.disabled": '规则 "{ruleId}" 已禁用。',
    "rules.severitySet": '规则 "{ruleId}" 的严重级别已设为 {severity}。',
    "rules.severityUnknown": '未知的严重级别 "{severity}"。支持: low, medium, high, critical。',

    "llm.status.enabled": "已启用",
    "llm.status.provider": "提供者",
    "llm.status.configured": "已配置",
    "llm.status.model": "模型",
    "llm.status.baseUrl": "基础 URL",
    "llm.status.apiKey": "API 密钥",
    "llm.yes": "是",
    "llm.no": "否",
    "llm.enabled": "LLM 扫描已启用。",
    "llm.disabled": "LLM 扫描已禁用。",
    "llm.providerSet": "LLM 提供者已设为 {provider}。",
    "llm.providerUnknown": '未知的提供者 "{provider}"。支持: {supported}。',
    "llm.keySet": "LLM API 密钥已更新。",
    "llm.modelSet": "LLM 模型已设为 {model}。",
    "llm.baseUrlSet": "LLM 基础 URL 已设为 {baseUrl}。",
    "llm.notConfigured": "LLM 未启用或未配置 API 密钥。",
    "llm.test.ok": "LLM 连接正常。",
    "llm.test.fail": "LLM 连接失败: {reason}",

    "ci.noManifest": '在 "{dir}" 中未找到 package.json。',
    "ci.noDependencies": "没有可直接扫描的依赖。",
    "ci.unknownLevel": '未知的失败级别 "{level}"。支持: {supported}。',
    "ci.invalidRateLimit": '无效的速率限制 "{value}"。',
    "ci.summary": "正在扫描 {dir} 中的 {count} 个依赖:",
    "ci.findings": "项发现",
    "ci.notFound": "注册表中不存在",
    "ci.passed": "所有依赖均低于 {level} 阈值。通过。",
    "ci.failed": "存在达到 {level} 阈值的依赖。失败。",
  },
};

let locale: Locale = "en";

export function setLocale(l: Locale): void {
  locale = l;
}

export function getLocale(): Locale {
  return locale;
}

export function t(key: string, params?: Record<string, string>): string {
  let template = messages[locale][key];
  if (template === undefined) {
    template = messages.en[key];
    if (template === undefined) return key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(`{${k}}`, v);
    }
  }
  return template;
}
