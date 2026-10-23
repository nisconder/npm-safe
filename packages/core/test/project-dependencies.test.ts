import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectDependencies, type ProjectDependency } from '../src/project-dependencies.js';

function project(manifest: Record<string, unknown>, lock: Record<string, unknown> | undefined, test: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-dependencies-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...manifest }));
    if (lock) writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    test(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function identities(deps: ProjectDependency[]): string[] {
  return deps.map(({ name, version }) => `${name}@${version}`).sort();
}

describe('project dependency identities', () => {
  it('collects manifest runtime, optional, peer and dev dependencies without duplicate names', () => {
    project({ dependencies: { runtime: '^1' }, optionalDependencies: { optional: '^2' }, peerDependencies: { peer: '^3' }, devDependencies: { runtime: '^1', development: '^4' } }, undefined, (dir) => {
      assert.deepEqual(readProjectDependencies(dir).map((dep) => dep.name).sort(), ['development', 'optional', 'peer', 'runtime']);
      assert.deepEqual(readProjectDependencies(dir, { prod: true }).map((dep) => dep.name).sort(), ['optional', 'peer', 'runtime']);
      assert.ok(readProjectDependencies(dir).every((dep) => dep.version === undefined));
    });
  });

  for (const lockfileVersion of [2, 3]) {
    it(`preserves exact versions, scoped names and multiple installed versions in npm v${lockfileVersion}`, () => {
      project({}, { lockfileVersion, packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/shared': { version: '1.2.3' },
        'node_modules/parent': { version: '2.0.0' },
        'node_modules/parent/node_modules/shared': { version: '4.5.6' },
        'node_modules/parent/node_modules/@scope/scoped': { version: '3.0.0' },
        'node_modules/other/node_modules/shared': { version: '1.2.3' },
      }, dependencies: { shared: { version: '99.0.0' } } }, (dir) => {
        assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true })), ['@scope/scoped@3.0.0', 'parent@2.0.0', 'shared@1.2.3', 'shared@4.5.6']);
      });
    });

    it(`traverses production nested, hoisted, optional and peer edges in npm v${lockfileVersion}`, () => {
      const root = { dependencies: { parent: '^1' }, optionalDependencies: { optional: '^1', unavailable: '^1' }, devDependencies: { development: '^1' } };
      project(root, { lockfileVersion, packages: {
        '': root,
        'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1', hoisted: '^1' }, peerDependencies: { peer: '^1', absentPeer: '^1' }, optionalDependencies: { absentOptional: '^1' } },
        'node_modules/parent/node_modules/child': { version: '1.0.0', dependencies: { shared: '^1' } },
        'node_modules/parent/node_modules/shared': { version: '1.0.0' },
        'node_modules/shared': { version: '2.0.0', dev: true },
        'node_modules/child': { version: '2.0.0', dev: true },
        'node_modules/hoisted': { version: '1.0.0', dependencies: { leaf: '^1' } },
        'node_modules/leaf': { version: '1.0.0', dev: true },
        'node_modules/peer': { version: '1.0.0' },
        'node_modules/optional': { version: '1.0.0', optional: true, dependencies: { optionalLeaf: '^1' } },
        'node_modules/optionalLeaf': { version: '1.0.0', optional: true },
        'node_modules/development': { version: '1.0.0', dev: true },
      } }, (dir) => {
        assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true, prod: true })), ['child@1.0.0', 'hoisted@1.0.0', 'leaf@1.0.0', 'optional@1.0.0', 'optionalLeaf@1.0.0', 'parent@1.0.0', 'peer@1.0.0', 'shared@1.0.0']);
      });
    });
  }

  it('uses current manifest production roots when lock root contains only package metadata', () => {
    project({ dependencies: { runtime: '^1' } }, { lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' }, 'node_modules/runtime': { version: '1.0.0', dependencies: { child: '^2' } }, 'node_modules/child': { version: '2.0.0' } } }, (dir) => {
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true, prod: true })), ['child@2.0.0', 'runtime@1.0.0']);
    });
  });

  it('uses the lock root production graph when no manifest is available', () => {
    project({}, { lockfileVersion: 3, packages: { '': { dependencies: { runtime: '^1' } }, 'node_modules/runtime': { version: '1.0.0' } } }, (dir) => {
      unlinkSync(path.join(dir, 'package.json'));
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true, prod: true })), ['runtime@1.0.0']);
    });
  });

  it('reports missing required production dependencies instead of claiming an empty clean tree', () => {
    project({ dependencies: { missing: '^1' } }, { lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }, (dir) => {
      assert.throws(() => readProjectDependencies(dir, { lockfile: true, prod: true }), /Missing locked production dependency missing/);
    });
  });

  it('scans a registry alias by its published identity rather than its install alias', () => {
    project({}, { lockfileVersion: 3, packages: { '': {}, 'node_modules/alias': { name: '@scope/actual', version: '1.2.3', resolved: 'https://registry.npmjs.org/@scope/actual/-/actual-1.2.3.tgz' } } }, (dir) => {
      assert.deepEqual(readProjectDependencies(dir, { lockfile: true }), [{ name: '@scope/actual', version: '1.2.3' }]);
    });
  });

  it('preserves multiple nested versions in npm v1 and removes duplicate identities', () => {
    project({}, { lockfileVersion: 1, dependencies: {
      parent: { version: '1.0.0', dependencies: { shared: { version: '2.0.0' } } },
      other: { version: '1.0.0', dependencies: { shared: { version: '1.0.0' } } },
      shared: { version: '1.0.0' },
    } }, (dir) => {
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true })), ['other@1.0.0', 'parent@1.0.0', 'shared@1.0.0', 'shared@2.0.0']);
    });
  });

  it('retains npm v1 production transitive requirements with nearest nested resolution', () => {
    project({ dependencies: { parent: '^1' } }, { lockfileVersion: 1, dependencies: {
      parent: { version: '1.0.0', requires: { child: '^1', hoisted: '^1' }, dependencies: { child: { version: '1.0.0', requires: { privateLeaf: '^1' } }, privateLeaf: { version: '1.0.0' } } },
      child: { version: '2.0.0', dev: true },
      hoisted: { version: '1.0.0', requires: { rootLeaf: '^1' } },
      rootLeaf: { version: '1.0.0' }, development: { version: '1.0.0', dev: true },
    } }, (dir) => {
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true, prod: true })), ['child@1.0.0', 'hoisted@1.0.0', 'parent@1.0.0', 'privateLeaf@1.0.0', 'rootLeaf@1.0.0']);
    });
  });

  it('permits an omitted npm v1 root optional dependency while retaining installed optional trees', () => {
    project({ dependencies: { runtime: '^1' }, optionalDependencies: { unavailable: '^1', optional: '^1' } }, { lockfileVersion: 1, dependencies: {
      runtime: { version: '1.0.0' }, optional: { version: '1.0.0', optional: true, requires: { child: '^1' } }, child: { version: '1.0.0', optional: true },
    } }, (dir) => {
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true, prod: true })), ['child@1.0.0', 'optional@1.0.0', 'runtime@1.0.0']);
    });
  });

  it('does not resolve a root-hoisted npm v1 package into its caller private subtree', () => {
    project({ dependencies: { parent: '^1' } }, { lockfileVersion: 1, dependencies: {
      parent: { version: '1.0.0', requires: { child: '^1' }, dependencies: { child: { version: '1.0.0', requires: { hoisted: '^1' } }, privateOnly: { version: '1.0.0' } } },
      hoisted: { version: '1.0.0', requires: { privateOnly: '^1' } },
    } }, (dir) => {
      assert.throws(() => readProjectDependencies(dir, { lockfile: true, prod: true }), /Missing locked dependency privateOnly/);
    });
  });

  it('does not silently omit required missing npm v1 dependencies', () => {
    project({ dependencies: { parent: '^1' } }, { lockfileVersion: 1, dependencies: { parent: { version: '1.0.0', requires: { missing: '^1' } } } }, (dir) => {
      assert.throws(() => readProjectDependencies(dir, { lockfile: true, prod: true }), /Missing locked dependency missing/);
    });
  });

  const invalidEntries = [
    {}, { version: '^1.2.3' }, { version: 'file:../local' },
    { version: '1.2.3', link: true }, { version: 'git+https://github.com/example/package.git#abcdef' },
    { version: '1.2.3', resolved: 'file:../package.tgz' },
    { version: '1.2.3', resolved: 'git+ssh://git@example.invalid/package.git' },
    { version: '1.2.3', resolved: 'https://mirror.example.invalid/package.tgz' },
    { version: '1.2.3', resolved: 'https://registry.npmjs.org.evil.invalid/package.tgz' },
    { version: '1.2.3', resolved: 'http://registry.npmjs.org/package/-/package-1.2.3.tgz' },
  ];
  for (const lockfileVersion of [1, 3]) {
    it(`rejects missing exact versions and unsupported locked sources in npm v${lockfileVersion}`, () => {
      for (const entry of invalidEntries) {
        const lock = lockfileVersion === 1 ? { lockfileVersion, dependencies: { package: entry } } : { lockfileVersion, packages: { '': {}, 'node_modules/package': entry } };
        project({}, lock, (dir) => {
          assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Cannot scan locked dependency package/, JSON.stringify(entry));
        });
      }
    });
  }

  it('rejects missing or malformed lockfiles', () => {
    project({}, undefined, (dir) => {
      assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Cannot read package-lock.json/);
      writeFileSync(path.join(dir, 'package-lock.json'), '{broken');
      assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Cannot read package-lock.json/);
      writeFileSync(path.join(dir, 'package-lock.json'), '[]');
      assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Cannot read package-lock.json/);
    });
  });

  it('does not treat unsupported or invalid lock structures as a clean empty tree', () => {
    for (const lock of [{}, { lockfileVersion: 4, packages: {} }, { lockfileVersion: 3 }, { lockfileVersion: 3, packages: [] }, { lockfileVersion: 1, dependencies: [] }]) {
      project({}, lock, (dir) => {
        assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /package-lock.json/);
      });
    }
  });

  it('rejects empty lock trees when the manifest has required dependencies', () => {
    for (const lock of [
      { lockfileVersion: 3, packages: {} },
      { lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } },
      { lockfileVersion: 2, packages: {} },
      { lockfileVersion: 1 },
      { lockfileVersion: 1, dependencies: {} },
    ]) {
      project({ dependencies: { required: '^1' } }, lock, (dir) => {
        assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Missing locked dependency required/);
      });
    }
  });

  for (const lockfileVersion of [1, 2, 3]) {
    const locked = (entries: Record<string, unknown>): Record<string, unknown> => lockfileVersion === 1
      ? { lockfileVersion, dependencies: entries }
      : { lockfileVersion, packages: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [`node_modules/${name}`, entry])) };

    it(`rejects a partially populated npm v${lockfileVersion} lock missing a required direct root`, () => {
      project({ dependencies: { present: '^1', missing: '^1' } }, locked({ present: { version: '1.0.0' } }), (dir) => {
        assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Missing locked dependency missing/);
      });
    });

    it(`rejects an npm v${lockfileVersion} lock missing required dev dependencies in the full scan`, () => {
      project({ dependencies: { present: '^1' }, devDependencies: { development: '^1' } }, locked({ present: { version: '1.0.0' } }), (dir) => {
        assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Missing locked dependency development/);
      });
    });

    it(`allows omitted optional overrides and peers in an npm v${lockfileVersion} full scan`, () => {
      project({ dependencies: { present: '^1', unavailable: '^1' }, optionalDependencies: { unavailable: '^1' }, peerDependencies: { peer: '^1' } }, locked({ present: { version: '1.0.0' } }), (dir) => {
        assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true })), ['present@1.0.0']);
      });
    });

    it(`allows a truly empty manifest and an empty npm v${lockfileVersion} lock`, () => {
      project({}, locked({}), (dir) => {
        assert.deepEqual(readProjectDependencies(dir, { lockfile: true }), []);
      });
    });
  }

  it('validates required roots from npm v3 lock metadata when the manifest is absent', () => {
    project({}, { lockfileVersion: 3, packages: { '': { dependencies: { missing: '^1' } } } }, (dir) => {
      unlinkSync(path.join(dir, 'package.json'));
      assert.throws(() => readProjectDependencies(dir, { lockfile: true }), /Missing locked dependency missing/);
    });
  });

  it('uses npm v1 top-level entries when no manifest is available', () => {
    project({}, { lockfileVersion: 1, dependencies: { present: { version: '1.0.0' } } }, (dir) => {
      unlinkSync(path.join(dir, 'package.json'));
      assert.deepEqual(identities(readProjectDependencies(dir, { lockfile: true })), ['present@1.0.0']);
    });
  });
});
