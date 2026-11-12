import { createHash } from 'node:crypto';
import { realpath as callbackRealpath } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const realpath = promisify(callbackRealpath);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function readBounded(file, maximum) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) throw new Error('JSON file budget exceeded');
  const bytes = await readFile(file);
  if (bytes.length > maximum) throw new Error('JSON file budget exceeded');
  return bytes;
}

export async function readConfined(directory, relative, maximum) {
  const base = await realpath(directory), target = await realpath(path.resolve(base, relative));
  const within = path.relative(base, target);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('Review file escapes run directory');
  return readBounded(target, maximum);
}

export async function writeConfinedExclusive(directory, relative, bytes) {
  const base = await realpath(directory), target = path.resolve(base, relative);
  const parent = await realpath(path.dirname(target)), within = path.relative(base, parent);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('Output escapes run directory');
  // wx rejects an existing file or symlink. This is a path check, not an OS sandbox.
  return writeFile(path.join(parent, path.basename(target)), bytes, { flag: 'wx' });
}

export async function readArtifact(directory, descriptor, maximum) {
  const base = await realpath(directory);
  const target = await realpath(path.resolve(base, descriptor.path));
  const relative = path.relative(base, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Artifact escapes dataset root');
  const info = await stat(target);
  if (!info.isFile() || info.size > maximum) throw new Error('Artifact read budget exceeded');
  const bytes = await readFile(target);
  if (bytes.length > maximum || sha256(bytes) !== descriptor.sha256) throw new Error('Artifact hash/budget mismatch');
  return bytes;
}

export async function prototypeIdentity() {
  const files = ['scripts/evaluate-source-llm.mjs', 'scripts/evaluate-scanner.mjs'];
  for (const entry of await readdir(new URL('./', import.meta.url))) {
    if (entry.endsWith('.mjs') && !entry.endsWith('.test.mjs')) files.push(`scripts/llm-source/${entry}`);
  }
  const sourceFiles = {};
  for (const file of files.sort()) sourceFiles[file] = sha256(await readFile(path.join(repositoryRoot, file)));
  return { sourceFiles, fingerprint: sha256(JSON.stringify(sourceFiles)) };
}

export async function assertUnchanged(sourceFiles) {
  for (const [file, expected] of Object.entries(sourceFiles)) {
    if (sha256(await readFile(path.join(repositoryRoot, file))) !== expected) throw new Error(`Frozen source changed: ${file}`);
  }
}
