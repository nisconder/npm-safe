import { createRequire } from 'node:module';
import type { PackageMetadata } from './types.js';

const semver = createRequire(import.meta.url)('semver') as {
  valid(value: string): string | null;
  validRange(value: string): string | null;
  satisfies(version: string, range: string): boolean;
  maxSatisfying(versions: string[], range: string): string | null;
};

/** Resolve the manifest actually requested, rather than always scanning latest. */
export function resolvePackageVersion(meta: PackageMetadata, requested = 'latest'): string {
  const hasVersion = (version: string): boolean => Object.hasOwn(meta.versions, version);
  if (Object.hasOwn(meta['dist-tags'], requested)) {
    const version = meta['dist-tags'][requested];
    if (hasVersion(version)) return version;
  } else if (semver.valid(requested)) {
    const version = semver.valid(requested)!;
    if (hasVersion(version)) return version;
  } else if (semver.validRange(requested)) {
    const latest = meta['dist-tags'].latest;
    if (latest && hasVersion(latest) && semver.satisfies(latest, requested)) return latest;
    const version = semver.maxSatisfying(Object.keys(meta.versions), requested);
    if (version) return version;
  }
  throw new Error(`Package "${meta.name}" has no published version matching "${requested}".`);
}
