/**
 * Simple localization module for the npm-safe CLI.
 *
 * Supports `en` (default) and `zh` (Simplified Chinese). Auto-detects the
 * locale from the `LANG` / `LC_ALL` / `LANGUAGE` environment variables, with
 * a CLI `--lang` flag taking precedence.
 */

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
    "watch.remove.removed": 'Removed "{name}" from the watchlist.',

    "refresh.single": 'Refreshed "{name}".',
    "refresh.all": "Refreshed all watched packages.",

    "settings.notSet": 'Setting "{key}" is not set.',
    "settings.set": 'Set "{key}" = "{value}".',
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
    "watch.remove.removed": '已将 "{name}" 从监控列表中移除。',

    "refresh.single": '已刷新 "{name}"。',
    "refresh.all": "已刷新所有监控的包。",

    "settings.notSet": '设置 "{key}" 未配置。',
    "settings.set": '已将 "{key}" 设为 "{value}"。',
  },
};

let locale: Locale = "en";

/**
 * Detect the locale from environment variables.
 */
function detectLocale(): Locale {
  const v = (process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? "").toLowerCase();
  if (v.startsWith("zh")) return "zh";
  return "en";
}

/**
 * Set the active locale. Call this once at CLI startup.
 */
export function setLocale(l: Locale): void {
  locale = l;
}

/**
 * Auto-detect and set the locale. Called before `--lang` is parsed so the
 * flag can override it.
 */
export function autoDetectLocale(): void {
  locale = detectLocale();
}

/**
 * Get the current locale.
 */
export function getLocale(): Locale {
  return locale;
}

/**
 * Retrieve a localised message by key. Template parameters in the form
 * `{key}` are substituted with values from `params`.
 */
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
