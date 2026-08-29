/**
 * DSH plugin installation risk assessment.
 *
 * The analyzer is deliberately pure: callers resolve an npm manifest or a
 * GitHub package.json, provide the files that are actually available from the
 * source, and receive a compact report suitable for a CLI or visual risk card.
 */

import type { AbbreviatedVersion } from '../registry/types.js';
import { Severity, type ScanFinding, type StaticScanReport } from '../scanner/types.js';

export type InstallRiskLevel = 'low' | 'medium' | 'high';
export type InstallRiskStatus = 'pass' | 'warning' | 'danger' | 'unknown';
export type InstallRiskSourceKind = 'npm' | 'github';

export interface ParsedPluginSource {
  readonly kind: InstallRiskSourceKind;
  readonly raw: string;
  readonly packageName?: string;
  readonly requestedVersion?: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly requestedRef?: string;
}

export interface InstallRiskCheck {
  readonly id: string;
  readonly label: string;
  readonly status: InstallRiskStatus;
  readonly detail: string;
}

export interface InstallRiskFinding {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: 'info' | 'warning' | 'danger';
  readonly recommendation: string;
}

export interface InstallRiskAssessment {
  readonly input: string;
  readonly sourceKind: InstallRiskSourceKind;
  readonly sourceLabel: string;
  readonly sourceUrl: string;
  readonly packageName: string;
  readonly version: string;
  readonly pinnedSpec: string;
  readonly safeInstallCommand: string;
  readonly riskLevel: InstallRiskLevel;
  readonly safetyScore: number;
  readonly summary: string;
  readonly checks: readonly InstallRiskCheck[];
  readonly findings: readonly InstallRiskFinding[];
  readonly integrityVerified: boolean | null;
  readonly inspectedAt: string;
}

export interface DshManifestRiskInput {
  readonly input: string;
  readonly sourceKind: InstallRiskSourceKind;
  readonly sourceLabel: string;
  readonly sourceUrl: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly pinnedSpec: string;
  readonly profile?: string;
  readonly availableFiles?: readonly string[];
  readonly patchFileExists?: boolean;
  readonly currentDshToolsVersion?: string;
  readonly staticScan?: StaticScanReport;
  readonly integrityVerified?: boolean | null;
}

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;
const REMOTE_OR_SHELL = /(?:\bcurl\b|\bwget\b|Invoke-WebRequest|DownloadString|\|\s*(?:sh|bash|zsh|pwsh|powershell)\b|child_process|\beval\s*\()/i;
const UNSAFE_SPEC = /^(?:git(?:\+[^:]+)?:|https?:|file:|link:|workspace:)|^(?:latest|next|\*)$/i;
const SHARED_DSH_PACKAGE = /^(?:@deepseek-ai\/cordis|@deepseek-ai\/dsh(?:$|-))/;
const SAFE_PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function normalizeArchivePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^package\//, '')
    .replace(/^\/+/, '');
}

export function getBundlePatchPath(manifest: Readonly<Record<string, unknown>>): string | undefined {
  const dsh = asRecord(manifest.dsh);
  const bundle = asRecord(dsh.bundle);
  const patch = bundle.patch;
  return typeof patch === 'string' && patch.trim() ? patch.trim() : undefined;
}

function scoreRisk(findings: readonly InstallRiskFinding[], staticScore?: number): number {
  let score = 100;
  for (const finding of findings) {
    score -= finding.severity === 'danger' ? 24 : finding.severity === 'warning' ? 10 : 3;
  }
  if (typeof staticScore === 'number') score = Math.min(score, staticScore);
  return Math.max(0, Math.min(100, score));
}

function riskFrom(score: number, findings: readonly InstallRiskFinding[]): InstallRiskLevel {
  if (findings.some((finding) => finding.severity === 'danger') || score < 50) return 'high';
  if (findings.some((finding) => finding.severity === 'warning') || score < 80) return 'medium';
  return 'low';
}

interface SemverValue {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (number | string)[];
}

function parseSemver(value: string): SemverValue | null {
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
}

function compareSemver(left: SemverValue, right: SemverValue): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return -1;
    if (typeof a === 'string' && typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function upperBoundFor(base: SemverValue, mode: '^' | '~'): SemverValue {
  if (mode === '~') {
    return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
  }
  if (base.major > 0) {
    return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
  }
  if (base.minor > 0) {
    return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  }
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
}

function comparatorMatches(version: SemverValue, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed || trimmed === '*' || /^x$/i.test(trimmed)) return true;
  const wildcard = trimmed.match(/^(\d+)(?:\.(\d+))?\.(?:x|\*)$/i);
  if (wildcard) {
    return version.major === Number(wildcard[1]) &&
      (wildcard[2] === undefined || version.minor === Number(wildcard[2]));
  }
  const match = trimmed.match(/^(\^|~|>=|<=|>|<|=)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const base = parseSemver(match[2]);
  if (!base) return false;
  const compared = compareSemver(version, base);
  if (operator === '^' || operator === '~') {
    return compared >= 0 && compareSemver(version, upperBoundFor(base, operator)) < 0;
  }
  if (operator === '>=') return compared >= 0;
  if (operator === '<=') return compared <= 0;
  if (operator === '>') return compared > 0;
  if (operator === '<') return compared < 0;
  return compared === 0;
}

/** Return whether a common npm peer range includes a concrete version. */
export function peerRangeIncludes(range: string, version: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => comparatorMatches(parsed, token));
  });
}

/** Parse an npm package spec or a public GitHub repository URL/shorthand. */
export function parsePluginSource(input: string): ParsedPluginSource {
  const raw = input.trim();
  if (!raw) throw new Error('请输入 npm 包名或 GitHub 插件地址。');

  const github = raw.match(/^(?:https?:\/\/github\.com\/|github:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#([^\s]+))?(?:\/)?$/i);
  if (github) {
    return {
      kind: 'github',
      raw,
      owner: github[1],
      repository: github[2],
      requestedRef: github[3],
    };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    const [owner, repository] = raw.split('/');
    return { kind: 'github', raw, owner, repository };
  }

  let packageName = raw;
  let requestedVersion: string | undefined;
  const splitAt = raw.lastIndexOf('@');
  if (splitAt > 0) {
    packageName = raw.slice(0, splitAt);
    requestedVersion = raw.slice(splitAt + 1) || undefined;
  }
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) {
    throw new Error('无法识别该地址。请输入 npm 包名、owner/repo 或 github.com 仓库地址。');
  }
  return { kind: 'npm', raw, packageName, requestedVersion };
}

/** Produce the red/yellow/green card data for one resolved DSH plugin manifest. */
export function analyzeDshPluginManifest(input: DshManifestRiskInput): InstallRiskAssessment {
  const manifest = input.manifest;
  const packageName = typeof manifest.name === 'string' ? manifest.name : '<unnamed-plugin>';
  const version = typeof manifest.version === 'string' ? manifest.version : 'unversioned';
  const dependencies = asStringRecord(manifest.dependencies);
  const peerDependencies = asStringRecord(manifest.peerDependencies);
  const scripts = asStringRecord(manifest.scripts);
  const findings: InstallRiskFinding[] = [];
  const checks: InstallRiskCheck[] = [];

  const lifecycle = LIFECYCLE_SCRIPTS.filter((name) => scripts[name]);
  if (lifecycle.length === 0) {
    checks.push({ id: 'lifecycle', label: '生命周期脚本', status: 'pass', detail: '未声明安装时自动执行脚本' });
  } else {
    const dangerous = lifecycle.some((name) => REMOTE_OR_SHELL.test(scripts[name] ?? ''));
    const detail = lifecycle.map((name) => `${name}: ${scripts[name]}`).join(' · ');
    checks.push({ id: 'lifecycle', label: '生命周期脚本', status: dangerous ? 'danger' : 'warning', detail });
    findings.push({
      id: 'lifecycle-script',
      title: dangerous ? '安装脚本包含网络或命令执行' : '安装时会自动运行脚本',
      detail,
      severity: dangerous ? 'danger' : 'warning',
      recommendation: '先审查脚本及其调用文件；需要构建时仅显式允许已确认的包。',
    });
  }

  const runtimeDshDeps = Object.keys(dependencies).filter((name) => SHARED_DSH_PACKAGE.test(name));
  const duplicated = runtimeDshDeps.filter((name) => name in peerDependencies);
  if (runtimeDshDeps.length === 0) {
    checks.push({ id: 'host-dependencies', label: 'DSH 核心依赖', status: 'pass', detail: '未把宿主核心包打进运行时依赖' });
  } else {
    checks.push({
      id: 'host-dependencies',
      label: 'DSH 核心依赖',
      status: 'danger',
      detail: `${runtimeDshDeps.join(', ')} 位于 dependencies`,
    });
    findings.push({
      id: 'duplicate-dsh-runtime',
      title: '@deepseek-ai 运行时可能被重复安装',
      detail: `${runtimeDshDeps.join(', ')} 应由 DSH 宿主提供，而不是随插件复制。`,
      severity: 'danger',
      recommendation: '把宿主提供的核心包移到 peerDependencies，并仅在 devDependencies 中保留开发版本。',
    });
  }
  if (duplicated.length > 0) {
    findings.push({
      id: 'duplicate-dependency-declaration',
      title: '同一核心包同时出现在 dependencies 与 peerDependencies',
      detail: duplicated.join(', '),
      severity: 'danger',
      recommendation: '删除 dependencies 中的重复声明，避免 Loader、工具注册表或上下文类型出现多份实例。',
    });
  }

  const unsafeDependencies = Object.entries(dependencies)
    .filter(([, spec]) => UNSAFE_SPEC.test(spec))
    .map(([name, spec]) => `${name}@${spec}`);
  if (unsafeDependencies.length > 0) {
    checks.push({ id: 'dependency-specs', label: '依赖来源', status: 'warning', detail: unsafeDependencies.join(', ') });
    findings.push({
      id: 'unpinned-dependencies',
      title: '依赖来源未固定或绕过 npm 版本',
      detail: unsafeDependencies.join(', '),
      severity: 'warning',
      recommendation: '固定到审核过的 npm 版本或不可变 commit，避免安装内容随时间变化。',
    });
  } else {
    checks.push({ id: 'dependency-specs', label: '依赖来源', status: 'pass', detail: '运行时依赖均使用 registry 版本范围' });
  }

  const patch = getBundlePatchPath(manifest);
  if (!patch) {
    checks.push({ id: 'bundle-manifest', label: 'Bundle 声明', status: 'danger', detail: '缺少 dsh.bundle.patch' });
    findings.push({
      id: 'missing-bundle-patch',
      title: '缺少 dsh.bundle.patch',
      detail: '该包会被安装成普通依赖，但不会成为可激活的 DSH bundle。',
      severity: 'danger',
      recommendation: '在 package.json 中声明 dsh.bundle.patch，并发布对应的 patch 文件。',
    });
  } else {
    checks.push({ id: 'bundle-manifest', label: 'Bundle 声明', status: 'pass', detail: patch });
    const normalizedPatch = normalizeArchivePath(patch);
    const unsafePatch = patch.startsWith('/') || /^[A-Za-z]:[\\/]/.test(patch) || normalizedPatch.split('/').includes('..');
    let exists = input.patchFileExists;
    if (exists === undefined && input.availableFiles) {
      const files = new Set(input.availableFiles.map(normalizeArchivePath));
      exists = files.has(normalizedPatch);
    }
    if (unsafePatch) {
      checks.push({ id: 'patch-file', label: 'Patch 文件', status: 'danger', detail: 'patch 路径越出包目录' });
      findings.push({
        id: 'unsafe-patch-path',
        title: 'Bundle patch 路径不安全',
        detail: patch,
        severity: 'danger',
        recommendation: '使用包内相对路径，例如 ./cordis.patch.yml。',
      });
    } else if (exists === true) {
      checks.push({ id: 'patch-file', label: 'Patch 文件', status: 'pass', detail: `${patch} 已包含在发布内容中` });
    } else if (exists === false) {
      checks.push({ id: 'patch-file', label: 'Patch 文件', status: 'danger', detail: `${patch} 不存在` });
      findings.push({
        id: 'missing-patch-file',
        title: '声明的 patch 文件未发布',
        detail: `${patch} 不在已检查的包内容中。`,
        severity: 'danger',
        recommendation: '把 patch 文件加入 package.json 的 files 列表并重新发布。',
      });
    } else {
      checks.push({ id: 'patch-file', label: 'Patch 文件', status: 'unknown', detail: '当前来源无法确认文件是否存在' });
    }
  }

  const toolsPeer = peerDependencies['@deepseek-ai/dsh-tools'];
  if (!toolsPeer) {
    checks.push({ id: 'peer-version', label: 'DSH peer 版本', status: 'unknown', detail: '未声明 @deepseek-ai/dsh-tools peer' });
  } else if (!input.currentDshToolsVersion) {
    checks.push({ id: 'peer-version', label: 'DSH peer 版本', status: 'unknown', detail: `声明 ${toolsPeer}，未取得当前版本` });
  } else if (peerRangeIncludes(toolsPeer, input.currentDshToolsVersion)) {
    checks.push({ id: 'peer-version', label: 'DSH peer 版本', status: 'pass', detail: `${toolsPeer} 包含当前预览基线 ${input.currentDshToolsVersion}` });
  } else {
    checks.push({ id: 'peer-version', label: 'DSH peer 版本', status: 'danger', detail: `${toolsPeer} 不包含当前预览基线 ${input.currentDshToolsVersion}` });
    findings.push({
      id: 'incompatible-dsh-tools-peer',
      title: '@deepseek-ai/dsh-tools peer 版本不兼容',
      detail: `插件声明 ${toolsPeer}，npm 的 DSH next 基线为 ${input.currentDshToolsVersion}。`,
      severity: 'danger',
      recommendation: '在与当前 DSH 版本完成真实调用测试后更新 peerDependencies。',
    });
  }

  const staticFindings = input.staticScan?.findings ?? [];
  const noteworthy = staticFindings.filter((finding) => finding.severity !== Severity.Low);
  for (const finding of noteworthy.slice(0, 6)) {
    if (finding.ruleId === 'install-script') continue;
    findings.push({
      id: `scanner-${finding.ruleId}`,
      title: finding.ruleName,
      detail: finding.message,
      severity: finding.severity === Severity.Critical || finding.severity === Severity.High ? 'danger' : 'warning',
      recommendation: finding.recommendation ?? '安装前查看完整扫描证据。',
    });
  }

  const integrityVerified = input.integrityVerified ?? null;
  if (input.sourceKind === 'npm' && integrityVerified !== true) {
    findings.push({
      id: 'source-integrity-unverified',
      title: integrityVerified === false ? '发布内容完整性验证失败' : '未能验证发布内容完整性',
      detail: integrityVerified === false
        ? '下载内容未通过 npm 发布摘要验证。'
        : '本次扫描没有完成 tarball 下载和摘要验证。',
      severity: integrityVerified === false ? 'danger' : 'warning',
      recommendation: '不要安装未通过摘要验证的内容；检查网络后重新扫描。',
    });
  }
  const sourceStatus: InstallRiskStatus = input.sourceKind === 'github'
    ? 'pass'
    : integrityVerified === true
      ? 'pass'
      : integrityVerified === false
        ? 'danger'
        : 'warning';
  checks.unshift({
    id: 'source-pin',
    label: '来源固定',
    status: sourceStatus,
    detail: input.sourceKind === 'npm'
      ? `${packageName}@${version}${integrityVerified ? '，完整性已验证' : '，未完成完整性验证'}`
      : input.pinnedSpec,
  });

  const safetyScore = scoreRisk(findings, input.staticScan?.score);
  const riskLevel = riskFrom(safetyScore, findings);
  const profile = input.profile?.trim() || 'web';
  if (!SAFE_PROFILE_NAME.test(profile)) {
    throw new Error('DSH profile 名称只能包含字母、数字、点、下划线和连字符。');
  }
  const ignoreScripts = lifecycle.length > 0 ? ' --ignore-scripts' : '';
  const safeInstallCommand = `dsh plugin --profile ${profile} add ${input.pinnedSpec}${ignoreScripts}`;
  const summary = riskLevel === 'high'
    ? '发现会阻止可靠加载或需要人工审查的高风险项。'
    : riskLevel === 'medium'
      ? '可以继续评估，但安装前应处理黄色警告。'
      : '未发现明显的 DSH 安装契约问题，仍建议先在隔离 profile 中验证。';

  return {
    input: input.input,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    sourceUrl: input.sourceUrl,
    packageName,
    version,
    pinnedSpec: input.pinnedSpec,
    safeInstallCommand,
    riskLevel,
    safetyScore,
    summary,
    checks,
    findings,
    integrityVerified,
    inspectedAt: new Date().toISOString(),
  };
}

/** Convert an npm abbreviated manifest into the plain shape used by the analyzer. */
export function manifestToRecord(manifest: AbbreviatedVersion): Readonly<Record<string, unknown>> {
  return { ...manifest } as unknown as Readonly<Record<string, unknown>>;
}

/** Narrow helper used by source resolvers before decoding untrusted JSON. */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Convert core findings to a compact count for UI summaries. */
export function countSevereFindings(findings: readonly ScanFinding[]): number {
  return findings.filter((finding) => finding.severity === Severity.Critical || finding.severity === Severity.High).length;
}
