/**
 * Static analysis rule engine for npm package security scanning.
 *
 * Pure regex/string analysis — no network calls, no LLM. The engine registers
 * a set of {@link ScanRule} implementations and aggregates their findings into
 * a {@link StaticScanReport} with a numeric score and overall security level.
 */

import {
  FindingCategory,
  ScanFinding,
  ScanRule,
  SecurityLevel,
  Severity,
  StaticScanReport,
} from './types.js';

/** Severity weights subtracted from the base score (100) per finding. */
const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  [Severity.Critical]: 25,
  [Severity.High]: 15,
  [Severity.Medium]: 8,
  [Severity.Low]: 3,
};

/** Minimum score and maximum score bounds for clamping. */
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * A small inline list of popular npm package names used as a reference set for
 * typosquatting detection. This is intentionally a compact approximation of the
 * "top-1000" — a full list would require network access, which this engine
 * forbids.
 */
const POPULAR_PACKAGES: readonly string[] = [
  'express',
  'lodash',
  'react',
  'axios',
  'chalk',
  'commander',
  'debug',
  'request',
  'moment',
  'vue',
  'angular',
  'webpack',
  'typescript',
  'jest',
  'eslint',
  'fs-extra',
  'dotenv',
  'yargs',
  'ramda',
  'underscore',
];

/** Standard npm registry URL. Any other registry in publishConfig is flagged. */
const STANDARD_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Uses the classic dynamic-programming formulation with O(a*b) time and space.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns Edit distance (number of single-character insertions/deletions/substitutions).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // dp[i][j] = distance between a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Split README content into 1-based lines, returning the array of lines
 * (without trailing newline characters).
 *
 * @param readme - Raw README content.
 * @returns Array of lines (1-based index = array index + 1).
 */
function splitLines(readme: string): string[] {
  return readme.split(/\r?\n/);
}

/**
 * Find the 1-based line number of the first line in `readme` containing `needle`,
 * or `undefined` if not found.
 */
function findLineNumber(readme: string, needle: string): number | undefined {
  const lines = splitLines(readme);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return undefined;
}

/**
 * Safely read a string-valued field from a parsed package.json object.
 *
 * @param pkg - Parsed package.json (may be undefined).
 * @param key - Top-level key to read.
 * @returns The string value if present and a string, otherwise undefined.
 */
function readStringField(
  pkg: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!pkg) return undefined;
  const value = pkg[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a nested object field from a parsed package.json object.
 */
function readObjectField(
  pkg: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!pkg) return undefined;
  const value = pkg[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Read the `scripts` map from package.json as a string-keyed record of string
 * command values.
 */
function readScripts(
  pkg: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const scripts = readObjectField(pkg, 'scripts');
  if (!scripts) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Matches an IPv4 address such as 192.168.1.1. */
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/** Matches curl or wget invocations. */
const CURL_WGET_PATTERN = /\b(?:curl|wget)\b/;

/** Matches base64-looking blobs (long runs of base64 alphabet chars). */
const BASE64_BLOB_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;

/** Matches shell command keywords commonly used in malicious payloads. */
const SHELL_KEYWORD_PATTERN = /\b(?:sh|bash|curl|wget|nc|ncat|python|perl|ruby|powershell)\b/;

/** Matches npm auth tokens. */
const NPM_TOKEN_PATTERN = /npm_[A-Za-z0-9]{20,}/;

/** Matches AWS access key ids. */
const AWS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/;

/** Matches SSH private key headers. */
const SSH_KEY_PATTERN = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/;

/** Matches links to executable files in markdown. */
const BINARY_LINK_PATTERN =
  /\bhttps?:\/\/[^\s)]+?\.(?:exe|sh|bat|ps1|cmd|com|scr|msi)\b/i;

/** Matches require/import of the child_process module. */
const CHILD_PROCESS_PATTERN =
  /(?:require\s*\(\s*['"]child_process['"]\)|\bfrom\s+['"]child_process['"]\b|import\s*\(\s*['"]child_process['"]\s*\))/;

/** Matches eval( and Function( invocations. */
const EVAL_FUNCTION_PATTERN = /\b(?:eval|Function)\s*\(/;

/** Matches hex-encoded escape sequences or unicode escapes that suggest obfuscation. */
const ENCODED_STRING_PATTERN = /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/;

/**
 * Rule: install-script
 *
 * Detects lifecycle scripts (postinstall/preinstall) that fetch remote content
 * via curl/wget to a raw IP address — a common supply-chain attack pattern.
 */
const installScriptRule: ScanRule = {
  id: 'install-script',
  name: 'Suspicious install script',
  description:
    'Lifecycle scripts (postinstall/preinstall) that curl/wget a raw IP address.',
  severity: Severity.Critical,
  category: FindingCategory.InstallScript,
  enabled: true,
  match(readme, packageJson) {
    const findings: ScanFinding[] = [];
    const scripts = readScripts(packageJson);
    if (!scripts) return findings;
    for (const [name, command] of Object.entries(scripts)) {
      if (
        name === 'postinstall' ||
        name === 'preinstall' ||
        name === 'install'
      ) {
        if (CURL_WGET_PATTERN.test(command) && IPV4_PATTERN.test(command)) {
          findings.push({
            ruleId: 'install-script',
            ruleName: 'Suspicious install script',
            severity: Severity.Critical,
            message: `Lifecycle script "${name}" fetches content from a raw IP address via curl/wget.`,
            codeSnippet: command,
            recommendation:
              'Remove network fetches from lifecycle scripts; vendor required assets instead.',
            category: FindingCategory.InstallScript,
          });
        }
      }
    }
    return findings;
  },
};

/**
 * Rule: eval-obfuscation
 *
 * Detects `eval(` or `Function(` invocations combined with encoded/nested
 * string content (hex/unicode escapes), which is a hallmark of obfuscated
 * malicious payloads.
 */
const evalObfuscationRule: ScanRule = {
  id: 'eval-obfuscation',
  name: 'eval/Function obfuscation',
  description:
    'Use of eval() or Function() with encoded (hex/unicode) string content.',
  severity: Severity.High,
  category: FindingCategory.CodeObfuscation,
  enabled: true,
  match(readme) {
    const findings: ScanFinding[] = [];
    if (!EVAL_FUNCTION_PATTERN.test(readme)) return findings;
    if (!ENCODED_STRING_PATTERN.test(readme)) return findings;
    const lineNumber = findLineNumber(
      readme,
      EVAL_FUNCTION_PATTERN.source.includes('eval') ? 'eval' : 'Function',
    );
    findings.push({
      ruleId: 'eval-obfuscation',
      ruleName: 'eval/Function obfuscation',
      severity: Severity.High,
      message:
        'eval() or Function() used alongside hex/unicode-encoded strings, suggesting obfuscation.',
      lineNumber,
      recommendation:
        'Avoid eval/Function; replace with static imports or JSON.parse for trusted data.',
      category: FindingCategory.CodeObfuscation,
    });
    return findings;
  },
};

/**
 * Rule: base64-shell
 *
 * Detects base64-encoded blobs appearing near shell command keywords, a
 * common pattern for hiding payloads that are decoded and piped to a shell.
 */
const base64ShellRule: ScanRule = {
  id: 'base64-shell',
  name: 'Base64-encoded shell payload',
  description:
    'Base64-encoded blobs appearing near shell command keywords (curl, sh, bash, ...).',
  severity: Severity.High,
  category: FindingCategory.CodeObfuscation,
  enabled: true,
  match(readme) {
    const findings: ScanFinding[] = [];
    if (!BASE64_BLOB_PATTERN.test(readme)) return findings;
    if (!SHELL_KEYWORD_PATTERN.test(readme)) return findings;
    const lines = splitLines(readme);
    let blobLine: number | undefined;
    let shellLine: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (blobLine === undefined && BASE64_BLOB_PATTERN.test(lines[i])) {
        blobLine = i + 1;
      }
      if (shellLine === undefined && SHELL_KEYWORD_PATTERN.test(lines[i])) {
        shellLine = i + 1;
      }
      if (blobLine !== undefined && shellLine !== undefined) break;
    }
    findings.push({
      ruleId: 'base64-shell',
      ruleName: 'Base64-encoded shell payload',
      severity: Severity.High,
      message:
        'Base64-encoded blob found near shell command keywords, possibly hiding a decoded payload.',
      lineNumber: blobLine ?? shellLine,
      recommendation:
        'Decode and inspect any base64 blobs; remove shell execution from package code.',
      category: FindingCategory.CodeObfuscation,
    });
    return findings;
  },
};

/**
 * Rule: binary-links
 *
 * Detects README links pointing directly to executable files (.exe/.sh/.bat/
 * .ps1), which may be used to trick users into running untrusted binaries.
 */
const binaryLinksRule: ScanRule = {
  id: 'binary-links',
  name: 'Direct binary download links',
  description:
    'README links pointing directly to executable files (.exe/.sh/.bat/.ps1).',
  severity: Severity.Medium,
  category: FindingCategory.BinaryDownload,
  enabled: true,
  match(readme) {
    const findings: ScanFinding[] = [];
    const lines = splitLines(readme);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(BINARY_LINK_PATTERN);
      if (match) {
        findings.push({
          ruleId: 'binary-links',
          ruleName: 'Direct binary download links',
          severity: Severity.Medium,
          message: `README links directly to an executable: ${match[0]}`,
          codeSnippet: match[0],
          lineNumber: i + 1,
          recommendation:
            'Avoid linking to raw executables; publish to a registry or provide source.',
          category: FindingCategory.BinaryDownload,
        });
      }
    }
    return findings;
  },
};

/**
 * Rule: typosquatting
 *
 * Detects package names within Levenshtein distance <= 2 of a popular package
 * name, while not being an exact match (scoped variants are compared on the
 * unscoped portion).
 */
const typosquattingRule: ScanRule = {
  id: 'typosquatting',
  name: 'Typosquatting candidate',
  description:
    'Package name within edit distance 2 of a popular package name.',
  severity: Severity.High,
  category: FindingCategory.Typosquatting,
  enabled: true,
  match(_readme, packageJson) {
    const findings: ScanFinding[] = [];
    const rawName = readStringField(packageJson, 'name');
    if (!rawName) return findings;
    const name = rawName.startsWith('@')
      ? rawName.split('/').pop() ?? rawName
      : rawName;
    if (name.length < 3) return findings;
    for (const popular of POPULAR_PACKAGES) {
      if (name === popular) return findings; // exact match — not typosquatting
      const distance = levenshtein(name.toLowerCase(), popular.toLowerCase());
      if (distance > 0 && distance <= 2) {
        findings.push({
          ruleId: 'typosquatting',
          ruleName: 'Typosquatting candidate',
          severity: Severity.High,
          message: `Package name "${rawName}" is within edit distance ${distance} of popular package "${popular}".`,
          recommendation: `Verify this is the intended package and not a typosquat of "${popular}".`,
          category: FindingCategory.Typosquatting,
        });
        return findings; // one finding is enough
      }
    }
    return findings;
  },
};

/**
 * Rule: secret-exposure
 *
 * Detects exposed secrets in README or package.json fields: npm tokens
 * (`npm_...`), AWS access keys (`AKIA...`), and SSH private key blocks.
 */
const secretExposureRule: ScanRule = {
  id: 'secret-exposure',
  name: 'Exposed secret',
  description:
    'npm tokens, AWS keys, or SSH private keys found in README or package.json.',
  severity: Severity.Critical,
  category: FindingCategory.SensitiveExposure,
  enabled: true,
  match(readme, packageJson) {
    const findings: ScanFinding[] = [];
    const haystacks: { text: string; source: string }[] = [
      { text: readme, source: 'README' },
    ];
    if (packageJson) {
      haystacks.push({
        text: JSON.stringify(packageJson),
        source: 'package.json',
      });
    }
    for (const { text, source } of haystacks) {
      if (NPM_TOKEN_PATTERN.test(text)) {
        findings.push({
          ruleId: 'secret-exposure',
          ruleName: 'Exposed secret',
          severity: Severity.Critical,
          message: `npm access token found in ${source}.`,
          recommendation: 'Rotate the token immediately and remove it from the package.',
          category: FindingCategory.SensitiveExposure,
        });
      }
      if (AWS_KEY_PATTERN.test(text)) {
        findings.push({
          ruleId: 'secret-exposure',
          ruleName: 'Exposed secret',
          severity: Severity.Critical,
          message: `AWS access key id found in ${source}.`,
          recommendation: 'Rotate the AWS key immediately and remove it from the package.',
          category: FindingCategory.SensitiveExposure,
        });
      }
      if (SSH_KEY_PATTERN.test(text)) {
        findings.push({
          ruleId: 'secret-exposure',
          ruleName: 'Exposed secret',
          severity: Severity.Critical,
          message: `SSH private key block found in ${source}.`,
          recommendation: 'Remove the private key and regenerate the keypair.',
          category: FindingCategory.SensitiveExposure,
        });
      }
    }
    return findings;
  },
};

/**
 * Rule: child-process-browser
 *
 * Detects use of `child_process` in packages that appear to target the
 * browser (declared `browser` field in package.json, or a name suggesting a
 * frontend framework).
 */
const childProcessBrowserRule: ScanRule = {
  id: 'child-process-browser',
  name: 'child_process in browser-targeted package',
  description:
    'Use of child_process in a package that declares browser targeting.',
  severity: Severity.High,
  category: FindingCategory.SuspiciousDep,
  enabled: true,
  match(readme, packageJson) {
    const findings: ScanFinding[] = [];
    if (!packageJson) return findings;
    const hasBrowserField = Object.prototype.hasOwnProperty.call(
      packageJson,
      'browser',
    );
    const name = readStringField(packageJson, 'name') ?? '';
    const frontendHint =
      /\b(?:react|vue|angular|svelte|solid|frontend|client|browser|dom|ui)\b/i.test(
        name,
      );
    if (!hasBrowserField && !frontendHint) return findings;
    if (!CHILD_PROCESS_PATTERN.test(readme)) {
      // Also check package.json scripts for child_process usage.
      const scripts = readScripts(packageJson);
      if (!scripts) return findings;
      const allScripts = Object.values(scripts).join(' ');
      if (!CHILD_PROCESS_PATTERN.test(allScripts)) return findings;
    }
    findings.push({
      ruleId: 'child-process-browser',
      ruleName: 'child_process in browser-targeted package',
      severity: Severity.High,
      message:
        'Package appears browser-targeted but references child_process, which is unavailable in browsers.',
      recommendation:
        'Remove child_process usage from browser-targeted code paths.',
      category: FindingCategory.SuspiciousDep,
    });
    return findings;
  },
};

/**
 * Rule: suspicious-build-metadata
 *
 * Detects odd build metadata in package.json such as a `_generatedBy` field
 * or other underscore-prefixed private keys that are not part of the standard
 * npm metadata set.
 */
const suspiciousBuildMetadataRule: ScanRule = {
  id: 'suspicious-build-metadata',
  name: 'Suspicious build metadata',
  description:
    'Non-standard underscore-prefixed metadata fields in package.json.',
  severity: Severity.Low,
  category: FindingCategory.Informational,
  enabled: true,
  match(_readme, packageJson) {
    const findings: ScanFinding[] = [];
    if (!packageJson) return findings;
    const knownUnderscoreKeys = new Set<string>([
      '_from',
      '_id',
      '_nodeVersion',
      '_npmVersion',
      '_npmUser',
      '_npmOperationalInternal',
      '_resolved',
      '_shasum',
      '_integrity',
      '_location',
      '_phantomChildren',
      '_requested',
      '_requiredBy',
      '_inCache',
    ]);
    for (const key of Object.keys(packageJson)) {
      if (!key.startsWith('_')) continue;
      if (knownUnderscoreKeys.has(key)) continue;
      findings.push({
        ruleId: 'suspicious-build-metadata',
        ruleName: 'Suspicious build metadata',
        severity: Severity.Low,
        message: `Non-standard metadata field "${key}" present in package.json.`,
        recommendation: 'Inspect the field; remove if injected by a build tool.',
        category: FindingCategory.Informational,
      });
    }
    return findings;
  },
};

/**
 * Rule: homograph-attack
 *
 * Detects Unicode homograph characters in the package name — e.g. Cyrillic
 * 'а' (U+0430) substituted for Latin 'a' (U+0061) to impersonate a popular
 * package.
 */
const homographAttackRule: ScanRule = {
  id: 'homograph-attack',
  name: 'Homograph attack in package name',
  description:
    'Non-ASCII (homograph) characters in the package name that mimic ASCII lookalikes.',
  severity: Severity.Critical,
  category: FindingCategory.HomographAttack,
  enabled: true,
  match(_readme, packageJson) {
    const findings: ScanFinding[] = [];
    const name = readStringField(packageJson, 'name');
    if (!name) return findings;
    // Strip the scope prefix; homograph attacks target the unscoped portion.
    const unscoped = name.startsWith('@')
      ? (name.split('/').pop() ?? name)
      : name;
    // Allowed ASCII for npm package names: a-z 0-9 - _ . ~
    // Anything outside this set (excluding the scope slash handled above) is
    // a potential homograph character.
    const allowed = /^[a-z0-9._-]+$/i;
    if (!allowed.test(unscoped)) {
      const suspiciousChars: string[] = [];
      for (const ch of unscoped) {
        if (!/[a-z0-9._-]/i.test(ch)) {
          suspiciousChars.push(ch);
        }
      }
      findings.push({
        ruleId: 'homograph-attack',
        ruleName: 'Homograph attack in package name',
        severity: Severity.Critical,
        message: `Package name "${name}" contains non-ASCII characters that may be homograph lookalikes: ${suspiciousChars.join(', ')}.`,
        recommendation:
          'Verify the package name uses only ASCII characters and is the intended package.',
        category: FindingCategory.HomographAttack,
      });
    }
    return findings;
  },
};

/**
 * Rule: registry-mismatch
 *
 * Detects a `publishConfig.registry` value that does not point to the
 * standard npm registry, which can indicate packages published to a private or
 * attacker-controlled registry.
 */
const registryMismatchRule: ScanRule = {
  id: 'registry-mismatch',
  name: 'Non-standard publish registry',
  description:
    'publishConfig.registry points to a registry other than registry.npmjs.org.',
  severity: Severity.Medium,
  category: FindingCategory.RegistryMismatch,
  enabled: true,
  match(_readme, packageJson) {
    const findings: ScanFinding[] = [];
    const publishConfig = readObjectField(packageJson, 'publishConfig');
    if (!publishConfig) return findings;
    const registry = readStringField(publishConfig, 'registry');
    if (!registry) return findings;
    if (registry !== STANDARD_REGISTRY && !registry.startsWith(STANDARD_REGISTRY)) {
      findings.push({
        ruleId: 'registry-mismatch',
        ruleName: 'Non-standard publish registry',
        severity: Severity.Medium,
        message: `publishConfig.registry is set to a non-standard registry: ${registry}`,
        codeSnippet: registry,
        recommendation:
          'Confirm the registry is trusted; standard npm packages use https://registry.npmjs.org/.',
        category: FindingCategory.RegistryMismatch,
      });
    }
    return findings;
  },
};

/** All built-in static analysis rules, in registration order. */
export const BUILTIN_RULES: readonly ScanRule[] = [
  installScriptRule,
  evalObfuscationRule,
  base64ShellRule,
  binaryLinksRule,
  typosquattingRule,
  secretExposureRule,
  childProcessBrowserRule,
  suspiciousBuildMetadataRule,
  homographAttackRule,
  registryMismatchRule,
];

/**
 * Static analysis engine that runs a set of {@link ScanRule}s against a
 * package's README and package.json and aggregates the findings into a
 * {@link StaticScanReport}.
 */
export class StaticAnalyzer {
  private readonly rules: readonly ScanRule[];

  /**
   * @param rules - Optional custom rule set. Defaults to all built-in rules.
   */
  constructor(rules?: ScanRule[]) {
    this.rules = rules ?? BUILTIN_RULES;
  }

  /**
   * Run all enabled rules against the given README and package.json, aggregate
   * the findings, and compute a numeric score plus overall security level.
   *
   * Scoring starts at 100 and subtracts a per-finding weight based on severity:
   * critical=-25, high=-15, medium=-8, low=-3. The score is clamped to [0, 100].
   *
   * Overall level: score >= 80 → Safe, >= 50 → Suspicious, >= 20 → Dangerous,
   * else Unknown.
   *
   * @param readme - README content as a string (may be empty).
   * @param packageJson - Parsed package.json, if available.
   * @returns The aggregated static scan report.
   */
  analyze(
    readme: string,
    packageJson?: Record<string, unknown>,
  ): StaticScanReport {
    const findings: ScanFinding[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const ruleFindings = rule.match(readme, packageJson);
      for (const f of ruleFindings) findings.push(f);
    }

    let score = MAX_SCORE;
    for (const f of findings) {
      score -= SEVERITY_WEIGHT[f.severity];
    }
    score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

    const overallLevel = this.levelFromScore(score);

    const packageName =
      readStringField(packageJson, 'name') ?? '<unknown>';
    const version =
      readStringField(packageJson, 'version') ?? '0.0.0';

    return {
      packageName,
      version,
      overallLevel,
      score,
      findings,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Map a numeric score to a {@link SecurityLevel}.
   *
   * @param score - Clamped score in [0, 100].
   * @returns The corresponding security level.
   */
  private levelFromScore(score: number): SecurityLevel {
    if (score >= 80) return SecurityLevel.Safe;
    if (score >= 50) return SecurityLevel.Suspicious;
    if (score >= 20) return SecurityLevel.Dangerous;
    return SecurityLevel.Unknown;
  }
}