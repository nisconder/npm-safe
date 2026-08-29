import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(packageRoot, 'test');

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      tests.push(fullPath);
    }
  }
  return tests;
}

const testFiles = collectTests(testRoot).sort();
if (testFiles.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=4',
    '--test-reporter',
    'spec',
    ...testFiles,
  ],
  { cwd: packageRoot, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
