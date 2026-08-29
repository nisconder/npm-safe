/**
 * Bounded, in-memory inspection of npm package tarballs.
 *
 * Archives are never extracted to disk. The parser enforces compressed,
 * uncompressed, entry-count, per-file, and total-text limits before applying a
 * compact set of high-signal source rules.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import {
  FindingCategory,
  Severity,
  type ContentScanSummary,
  type ScanFinding,
} from './types.js';

export const DEFAULT_MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_ENTRIES = 5_000;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_SCANNED_BYTES = 8 * 1024 * 1024;

export interface PackageContentScanOptions {
  readonly integrity?: string;
  readonly shasum?: string;
  readonly maxUnpackedBytes?: number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxScannedBytes?: number;
}

export interface PackageContentScanResult {
  readonly findings: readonly ScanFinding[];
  readonly summary: ContentScanSummary;
  /** Safe, normalized archive paths observed during the bounded parse. */
  readonly filePaths: readonly string[];
}

/** Public metadata for the rules that only run during an opt-in content scan. */
export const CONTENT_SCAN_RULES = [
  { id: 'content-integrity-mismatch', name: 'Tarball integrity mismatch', description: 'Published integrity metadata does not match the downloaded tarball.', severity: Severity.Critical, category: FindingCategory.KnownMalicious },
  { id: 'content-archive-invalid', name: 'Invalid package archive', description: 'The package tarball cannot be safely decompressed or parsed.', severity: Severity.High, category: FindingCategory.Informational },
  { id: 'content-archive-path', name: 'Unsafe archive path', description: 'An archive entry attempts to escape the package root.', severity: Severity.Critical, category: FindingCategory.KnownMalicious },
  { id: 'content-archive-link', name: 'Escaping archive link', description: 'A symbolic or hard link targets a path outside the package root.', severity: Severity.High, category: FindingCategory.KnownMalicious },
  { id: 'content-native-binary', name: 'Bundled native or executable content', description: 'The published archive contains native, executable, or WebAssembly files.', severity: Severity.Low, category: FindingCategory.BinaryDownload },
  { id: 'content-remote-shell', name: 'Remote content piped to a shell', description: 'Published source downloads remote content and passes it to a command shell.', severity: Severity.Critical, category: FindingCategory.InstallScript },
  { id: 'content-obfuscated-exec', name: 'Obfuscated dynamic code execution', description: 'Published source combines encoded payloads with dynamic execution.', severity: Severity.High, category: FindingCategory.CodeObfuscation },
  { id: 'content-network-exec', name: 'Network and process execution', description: 'The same published file performs network access and child-process execution.', severity: Severity.High, category: FindingCategory.BinaryDownload },
  { id: 'content-process-exec', name: 'Process execution capability', description: 'Published runtime source imports or invokes child-process functionality.', severity: Severity.Medium, category: FindingCategory.SuspiciousDep },
  { id: 'content-sensitive-network', name: 'Sensitive environment access with networking', description: 'Published source reads sensitive environment data and performs network access.', severity: Severity.High, category: FindingCategory.SensitiveExposure },
  { id: 'content-scan-incomplete', name: 'Incomplete package-content scan', description: 'Configured safety limits prevented the entire archive from being inspected.', severity: Severity.Medium, category: FindingCategory.Informational },
  { id: 'content-scan-unavailable', name: 'Package-content scan unavailable', description: 'The published tarball could not be downloaded or inspected.', severity: Severity.Medium, category: FindingCategory.Informational },
] as const;

interface ArchiveEntry {
  readonly path: string;
  readonly type: string;
  readonly linkPath?: string;
  readonly data: Buffer;
  readonly declaredSize: number;
}

const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx',
  '.json', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.cmd', '.bat',
  '.py', '.rb', '.pl', '.node-gyp', '.gyp', '.html',
]);

const NATIVE_EXTENSIONS = new Set([
  '.node', '.dll', '.so', '.dylib', '.exe', '.wasm', '.bin',
]);

const REMOTE_SHELL_PATTERN =
  /(?:\b(?:curl|wget)\b[^\r\n]{0,400}(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|cmd)\b|(?:Invoke-WebRequest|DownloadString|WebClient)[^\r\n]{0,500}(?:Invoke-Expression|\biex\b|Start-Process))/i;
const PROCESS_EXEC_PATTERN =
  /(?:require\s*\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]|\bchild_process\s*\.\s*(?:exec|execFile|spawn|fork|execSync|spawnSync)\s*\()/i;
const NETWORK_PATTERN =
  /(?:\bfetch\s*\(|\bhttps?\.(?:get|request)\s*\(|\baxios(?:\.(?:get|post|put|patch|delete|request))?\s*\(|\brequest\s*\(|\b(?:curl|wget)\b)/i;
const DYNAMIC_EXEC_PATTERN = /(?:\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\()/i;
const ENCODED_PAYLOAD_PATTERN =
  /(?:[A-Za-z0-9+/]{160,}={0,2}|(?:\\x[0-9a-fA-F]{2}){12,}|(?:\\u[0-9a-fA-F]{4}){8,}|fromCharCode\s*\()/i;
const SENSITIVE_ENV_PATTERN =
  /process\.env(?:\.|\[['"])(?:NPM_TOKEN|NODE_AUTH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN|SSH_AUTH_SOCK|HOME|USERPROFILE)/i;

function fileExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

function isTextCandidate(filePath: string, data: Buffer): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('/package.json') || lower.endsWith('/binding.gyp')) return true;
  if (TEXT_EXTENSIONS.has(fileExtension(lower))) return true;
  const prefix = data.subarray(0, Math.min(data.length, 128)).toString('utf8');
  return prefix.startsWith('#!') && /(?:node|sh|bash|zsh|python|ruby|perl|pwsh)/i.test(prefix);
}

function lineForMatch(content: string, pattern: RegExp): { line: number; snippet: string } | null {
  const match = pattern.exec(content);
  if (!match || match.index === undefined) return null;
  const line = content.slice(0, match.index).split(/\r?\n/).length;
  const sourceLine = content.split(/\r?\n/)[line - 1]?.trim() ?? match[0];
  return { line, snippet: sourceLine.slice(0, 240) };
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end >= start && end < start + length ? end : start + length;
  return buffer.subarray(start, boundedEnd).toString('utf8').trim();
}

function readTarSize(header: Buffer): number {
  const bytes = header.subarray(124, 136);
  if ((bytes[0] & 0x80) !== 0) {
    throw new Error('base-256 tar sizes are not supported');
  }
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar entry size');
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('unsafe tar entry size');
  return size;
}

function tarChecksumValid(header: Buffer): boolean {
  const raw = header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw || !/^[0-7]+$/.test(raw)) return false;
  const expected = Number.parseInt(raw, 8);
  let actual = 0;
  for (let index = 0; index < 512; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return actual === expected;
}

function parsePaxFields(data: Buffer): { path?: string; linkPath?: string } {
  const fields: { path?: string; linkPath?: string } = {};
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const pair = line.slice(space + 1);
    if (pair.startsWith('path=')) fields.path = pair.slice(5);
    if (pair.startsWith('linkpath=')) fields.linkPath = pair.slice(9);
  }
  return fields;
}

function isUnsafeArchivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  );
}

function integrityResult(
  archive: Buffer,
  integrity?: string,
  shasum?: string,
): { verified: boolean; mismatch: boolean } {
  const supported = new Set(['sha512', 'sha384', 'sha256', 'sha1']);
  const candidates = (integrity ?? '')
    .split(/\s+/)
    .map((token) => token.match(/^(sha(?:1|256|384|512))-([A-Za-z0-9+/=]+)$/))
    .filter((match): match is RegExpMatchArray => !!match && supported.has(match[1]));
  const priority: Readonly<Record<string, number>> = { sha512: 4, sha384: 3, sha256: 2, sha1: 1 };
  candidates.sort((a, b) => priority[b[1]] - priority[a[1]]);
  if (candidates.length > 0) {
    const algorithm = candidates[0][1];
    const actual = createHash(algorithm).update(archive).digest('base64');
    const verified = candidates.some((candidate) => candidate[1] === algorithm && candidate[2] === actual);
    return { verified, mismatch: !verified };
  }
  if (shasum && /^[a-fA-F0-9]{40}$/.test(shasum)) {
    const actual = createHash('sha1').update(archive).digest('hex');
    return { verified: actual.toLowerCase() === shasum.toLowerCase(), mismatch: actual.toLowerCase() !== shasum.toLowerCase() };
  }
  return { verified: false, mismatch: false };
}

function failure(
  archiveBytes: number,
  ruleId: string,
  message: string,
  severity: Severity,
  category: FindingCategory = FindingCategory.Informational,
): PackageContentScanResult {
  return {
    findings: [{
      ruleId,
      ruleName: 'Package archive validation',
      severity,
      message,
      recommendation: 'Do not install until the published archive can be verified and inspected.',
      category,
    }],
    summary: {
      status: 'failed',
      archiveBytes,
      unpackedBytes: 0,
      filesScanned: 0,
      filesSkipped: 0,
      integrityVerified: false,
      truncated: false,
      reason: message,
    },
    filePaths: [],
  };
}

/** Analyze a downloaded npm `.tgz` without extracting it to disk. */
export function analyzePackageTarball(
  archive: Buffer,
  options: PackageContentScanOptions = {},
): PackageContentScanResult {
  const integrity = integrityResult(archive, options.integrity, options.shasum);
  if (integrity.mismatch) {
    return failure(
      archive.length,
      'content-integrity-mismatch',
      'The downloaded tarball does not match its published integrity metadata.',
      Severity.Critical,
      FindingCategory.KnownMalicious,
    );
  }

  const maxUnpackedBytes = options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxScannedBytes = options.maxScannedBytes ?? DEFAULT_MAX_SCANNED_BYTES;

  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxUnpackedBytes });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failure(
      archive.length,
      'content-archive-invalid',
      `The package tarball could not be safely decompressed: ${reason}`,
      Severity.High,
    );
  }

  const findings: ScanFinding[] = [];
  const emitted = new Set<string>();
  let unpackedBytes = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let scannedBytes = 0;
  let entryCount = 0;
  let truncated = false;
  let partialReason: string | undefined;
  let nextPath: string | undefined;
  let nextLinkPath: string | undefined;
  const filePaths: string[] = [];

  const emit = (finding: ScanFinding): void => {
    if (emitted.has(finding.ruleId)) return;
    emitted.add(finding.ruleId);
    findings.push(finding);
  };

  try {
    let offset = 0;
    for (; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      if (!tarChecksumValid(header)) throw new Error('tar header checksum mismatch');
      entryCount++;
      if (entryCount > maxEntries) {
        truncated = true;
        partialReason = `Archive contains more than ${maxEntries} entries.`;
        break;
      }

      const name = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const declaredSize = readTarSize(header);
      const type = String.fromCharCode(header[156] || 0);
      const dataStart = offset + 512;
      const dataEnd = dataStart + declaredSize;
      if (dataEnd > tar.length) throw new Error('tar entry exceeds archive bounds');
      const data = tar.subarray(dataStart, dataEnd);
      offset = dataStart + Math.ceil(declaredSize / 512) * 512;

      if (type === 'x') {
        const fields = parsePaxFields(data);
        nextPath = fields.path ?? nextPath;
        nextLinkPath = fields.linkPath ?? nextLinkPath;
        continue;
      }
      if (type === 'g') {
        continue;
      }
      if (type === 'L') {
        nextPath = data.toString('utf8').replace(/\0.*$/, '').trim();
        continue;
      }
      if (type === 'K') {
        nextLinkPath = data.toString('utf8').replace(/\0.*$/, '').trim();
        continue;
      }

      const entry: ArchiveEntry = {
        path: nextPath ?? headerPath,
        type,
        linkPath: nextLinkPath ?? (readTarString(header, 157, 100) || undefined),
        data,
        declaredSize,
      };
      nextPath = undefined;
      nextLinkPath = undefined;

      if (isUnsafeArchivePath(entry.path)) {
        emit({
          ruleId: 'content-archive-path',
          ruleName: 'Unsafe archive path',
          severity: Severity.Critical,
          message: `Archive entry uses a path that escapes the package root: ${entry.path}`,
          filePath: entry.path,
          recommendation: 'Do not install this package; inspect the publisher and tarball provenance.',
          category: FindingCategory.KnownMalicious,
        });
        continue;
      }
      if (entry.type === '1' || entry.type === '2') {
        if (entry.linkPath && isUnsafeArchivePath(entry.linkPath)) {
          emit({
            ruleId: 'content-archive-link',
            ruleName: 'Escaping archive symlink',
            severity: Severity.High,
            message: `Archive symlink points outside the package root: ${entry.path} -> ${entry.linkPath}`,
            filePath: entry.path,
            recommendation: 'Review the tarball manually before installation.',
            category: FindingCategory.KnownMalicious,
          });
        }
        filesSkipped++;
        continue;
      }
      if (entry.type !== '\0' && entry.type !== '0' && entry.type !== '7') continue;

      filePaths.push(entry.path);

      unpackedBytes += entry.declaredSize;
      if (unpackedBytes > maxUnpackedBytes) {
        truncated = true;
        partialReason = `Unpacked content exceeds ${maxUnpackedBytes} bytes.`;
        break;
      }

      const extension = fileExtension(entry.path);
      if (NATIVE_EXTENSIONS.has(extension)) {
        emit({
          ruleId: 'content-native-binary',
          ruleName: 'Bundled native or executable content',
          severity: Severity.Low,
          message: `Published package contains native or executable content: ${entry.path}`,
          filePath: entry.path,
          recommendation: 'Verify the binary provenance and prefer reproducible source builds when possible.',
          category: FindingCategory.BinaryDownload,
        });
      }

      if (!isTextCandidate(entry.path, entry.data)) {
        filesSkipped++;
        continue;
      }
      if (entry.data.length > maxFileBytes || scannedBytes + entry.data.length > maxScannedBytes) {
        filesSkipped++;
        truncated = true;
        partialReason ??= 'Text scanning stopped at the configured byte limit.';
        continue;
      }
      if (entry.data.includes(0)) {
        filesSkipped++;
        continue;
      }

      filesScanned++;
      scannedBytes += entry.data.length;
      const content = entry.data.toString('utf8');
      const remoteShell = lineForMatch(content, REMOTE_SHELL_PATTERN);
      if (remoteShell) {
        emit({
          ruleId: 'content-remote-shell',
          ruleName: 'Remote content piped to a shell',
          severity: Severity.Critical,
          message: `Published source downloads remote content and executes it in ${entry.path}.`,
          filePath: entry.path,
          lineNumber: remoteShell.line,
          codeSnippet: remoteShell.snippet,
          recommendation: 'Do not install until the download, checksum verification, and executed payload are reviewed.',
          category: FindingCategory.InstallScript,
        });
      }

      const dynamic = lineForMatch(content, DYNAMIC_EXEC_PATTERN);
      if (dynamic && ENCODED_PAYLOAD_PATTERN.test(content)) {
        emit({
          ruleId: 'content-obfuscated-exec',
          ruleName: 'Obfuscated dynamic code execution',
          severity: Severity.High,
          message: `Published source combines encoded payloads with dynamic execution in ${entry.path}.`,
          filePath: entry.path,
          lineNumber: dynamic.line,
          codeSnippet: dynamic.snippet,
          recommendation: 'Decode the payload and review the executed code before installation.',
          category: FindingCategory.CodeObfuscation,
        });
      }

      const processExec = lineForMatch(content, PROCESS_EXEC_PATTERN);
      if (processExec && NETWORK_PATTERN.test(content)) {
        emit({
          ruleId: 'content-network-exec',
          ruleName: 'Network and process execution in published source',
          severity: Severity.High,
          message: `The same published file performs network access and process execution: ${entry.path}.`,
          filePath: entry.path,
          lineNumber: processExec.line,
          codeSnippet: processExec.snippet,
          recommendation: 'Review destination allowlists, integrity checks, and every spawned command.',
          category: FindingCategory.BinaryDownload,
        });
      } else if (processExec && !/(?:^|\/)(?:test|tests|__tests__|example|examples|docs?)\//i.test(entry.path)) {
        emit({
          ruleId: 'content-process-exec',
          ruleName: 'Process execution capability',
          severity: Severity.Medium,
          message: `Published runtime source can execute child processes: ${entry.path}.`,
          filePath: entry.path,
          lineNumber: processExec.line,
          codeSnippet: processExec.snippet,
          recommendation: 'Confirm process execution is necessary and arguments cannot be influenced by untrusted input.',
          category: FindingCategory.SuspiciousDep,
        });
      }

      const sensitive = lineForMatch(content, SENSITIVE_ENV_PATTERN);
      if (sensitive && NETWORK_PATTERN.test(content)) {
        emit({
          ruleId: 'content-sensitive-network',
          ruleName: 'Sensitive environment access with networking',
          severity: Severity.High,
          message: `Published source reads sensitive environment data and performs network access in ${entry.path}.`,
          filePath: entry.path,
          lineNumber: sensitive.line,
          codeSnippet: sensitive.snippet,
          recommendation: 'Verify no credentials or host information can be transmitted unexpectedly.',
          category: FindingCategory.SensitiveExposure,
        });
      }
    }
    if (!truncated && offset < tar.length && tar.subarray(offset).some((byte) => byte !== 0)) {
      throw new Error('tar archive has a truncated or non-zero trailing block');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit({
      ruleId: 'content-archive-invalid',
      ruleName: 'Invalid package archive',
      severity: Severity.High,
      message: `The tarball could not be completely parsed: ${reason}`,
      recommendation: 'Do not install until the archive structure is independently verified.',
      category: FindingCategory.Informational,
    });
    return {
      findings,
      summary: {
        status: 'failed',
        archiveBytes: archive.length,
        unpackedBytes,
        filesScanned,
        filesSkipped,
        integrityVerified: integrity.verified,
        truncated,
        reason,
      },
      filePaths,
    };
  }

  if (truncated) {
    emit({
      ruleId: 'content-scan-incomplete',
      ruleName: 'Incomplete package-content scan',
      severity: Severity.Medium,
      message: partialReason ?? 'The configured safety limits prevented a complete package-content scan.',
      recommendation: 'Inspect the remaining files in an isolated environment before installation.',
      category: FindingCategory.Informational,
    });
  }

  return {
    findings,
    summary: {
      status: truncated ? 'partial' : 'complete',
      archiveBytes: archive.length,
      unpackedBytes,
      filesScanned,
      filesSkipped,
      integrityVerified: integrity.verified,
      truncated,
      reason: partialReason,
    },
    filePaths,
  };
}
