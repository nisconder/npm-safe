import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validatePackageName } from './registry/validator.js';

const semver = createRequire(import.meta.url)('semver') as {
  valid(version: string): string | null;
  validRange(range: string): string | null;
};
type Entry = Record<string, unknown>;
/** `version` is a requested selector for manifests and an exact version for locks. */
export interface ProjectDependency { readonly name: string; readonly version?: string }

function object(value: unknown): Entry {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Entry : {};
}

function readJson(dir: string, name: string): Entry {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
    return parsed as Entry;
  }
  catch { throw new Error(`Cannot read ${name} in ${dir}.`); }
}

function dependencyNames(entry: Entry, dev = false): string[] {
  return [...new Set([
    ...Object.keys(object(entry.dependencies)),
    ...Object.keys(object(entry.optionalDependencies)),
    ...Object.keys(object(entry.peerDependencies)),
    ...(dev ? Object.keys(object(entry.devDependencies)) : []),
  ])];
}

function manifestDependencies(manifest: Entry, prod: boolean): ProjectDependency[] {
  const declarations = Object.create(null) as Entry;
  // Do not guess which selector wins across dependency kinds. A lockfile is
  // required when the manifest alone describes conflicting requested identities.
  for (const field of ['peerDependencies', ...(!prod ? ['devDependencies'] : []), 'dependencies', 'optionalDependencies']) {
    const section = manifest[field];
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section))) {
      throw new Error(`Invalid package.json ${field}: expected a dependency map.`);
    }
    for (const [name, spec] of Object.entries(object(section))) {
      if (Object.hasOwn(declarations, name) && declarations[name] !== spec) {
        throw new Error(`Conflicting manifest selectors for dependency ${name}; use --lockfile to scan the resolved identity.`);
      }
      declarations[name] = spec;
    }
  }
  return Object.entries(declarations).map(([installName, spec]) => {
    if (typeof spec !== 'string' || !validatePackageName(installName).valid) {
      throw new Error(`Cannot scan dependency ${installName}: invalid package name or version selector.`);
    }
    let name = installName;
    let version = spec.trim();
    if (version.startsWith('npm:')) {
      const target = version.slice(4);
      const separator = target.lastIndexOf('@');
      name = separator > 0 ? target.slice(0, separator) : target;
      version = separator > 0 ? target.slice(separator + 1) : 'latest';
    }
    if (!validatePackageName(name).valid || !version || /\.(?:tgz|tar\.gz)$/i.test(version) ||
      (semver.validRange(version) === null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(version))) {
      throw new Error(`Cannot scan dependency ${installName}: unsupported source or invalid registry version selector.`);
    }
    return { name, version: semver.valid(version) ?? version };
  });
}

/** Read requested manifest identities or exact locked identities. Unsupported sources fail closed. */
export function readProjectDependencies(
  dir: string,
  options: { lockfile?: boolean; prod?: boolean } = {},
): ProjectDependency[] {
  if (!options.lockfile) {
    return manifestDependencies(readJson(dir, 'package.json'), !!options.prod);
  }
  const lock = readJson(dir, 'package-lock.json');
  if (![1, 2, 3].includes(lock.lockfileVersion as number)) {
    throw new Error('Unsupported package-lock.json format: expected lockfileVersion 1, 2 or 3.');
  }
  const tree = lock.lockfileVersion === 1 ? lock.dependencies : lock.packages;
  if ((lock.lockfileVersion !== 1 || tree !== undefined) &&
    (!tree || typeof tree !== 'object' || Array.isArray(tree))) {
    throw new Error('Invalid package-lock.json dependency map.');
  }
  const manifest = fs.existsSync(path.join(dir, 'package.json'))
    ? readJson(dir, 'package.json') : undefined;
  const root = manifest ?? object(object(lock.packages)['']);
  if (!options.prod) {
    const optional = object(root.optionalDependencies);
    const requiredRoots = new Set([
      ...Object.keys(object(root.dependencies)),
      ...Object.keys(object(root.devDependencies)),
    ]);
    for (const name of requiredRoots) {
      if (Object.hasOwn(optional, name)) continue;
      const key = lock.lockfileVersion === 1 ? name : `node_modules/${name}`;
      if (!Object.hasOwn(object(tree), key)) {
        throw new Error(`Missing locked dependency ${name} required by root.`);
      }
    }
  }
  const result = new Map<string, ProjectDependency>();
  const add = (installName: string, entry: Entry): void => {
    const name = typeof entry.name === 'string' ? entry.name : installName;
    const version = typeof entry.version === 'string' ? entry.version : '';
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
    if (entry.link || !semver.valid(version) ||
      (resolved && !/^https?:\/\//.test(resolved))) {
      throw new Error(`Cannot scan locked dependency ${installName}: unsupported source or missing exact version.`);
    }
    // Registry checks cannot attest to a different archive bearing the same version.
    if (resolved && !/^https:\/\/registry\.npmjs\.org\//.test(resolved)) {
      throw new Error(`Cannot scan locked dependency ${installName}: non-npm registry archive ${resolved}.`);
    }
    result.set(`${name}@${version}`, { name, version });
  };

  if (lock.packages && typeof lock.packages === 'object') {
    const packages = object(lock.packages);
    const installName = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 13);
    if (!options.prod) {
      for (const [key, raw] of Object.entries(packages)) {
        if (!key || !/(^|\/)node_modules\//.test(key)) continue;
        add(installName(key), object(raw));
      }
    } else {
      // package.json describes the requested production tree. Old/incomplete
      // root lock metadata must not turn a nonempty project into a clean scan.
      const seen = new Set<string>();
      const resolve = (from: string, name: string): string | undefined => {
        let current = from;
        for (;;) {
          const candidate = `${current ? `${current}/` : ''}node_modules/${name}`;
          if (Object.hasOwn(packages, candidate)) return candidate;
          if (!current) return undefined;
          const parent = current.lastIndexOf('/node_modules/');
          current = parent < 0 ? '' : current.slice(0, parent);
        }
      };
      const visit = (from: string, entry: Entry): void => {
        const optional = object(entry.optionalDependencies);
        const peers = object(entry.peerDependencies);
        for (const name of dependencyNames(entry)) {
          const key = resolve(from, name);
          if (!key) {
            if (Object.hasOwn(optional, name) || Object.hasOwn(peers, name)) continue;
            throw new Error(`Missing locked production dependency ${name} required by ${from || 'root'}.`);
          }
          if (seen.has(key)) continue;
          seen.add(key);
          const child = object(packages[key]);
          add(installName(key), child);
          visit(key, child);
        }
      };
      visit('', root);
    }
  } else {
    // v1 lacks paths; resolve each requirement against its nearest nested tree.
    const top = object(lock.dependencies);
    const walk = (tree: Entry, ancestors: Entry[], names: string[], optional: Entry = {}): void => {
      for (const name of names) {
        const scope = [tree, ...ancestors];
        const ownerIndex = scope.findIndex((section) => Object.hasOwn(section, name));
        if (ownerIndex < 0) {
          if (Object.hasOwn(optional, name)) continue;
          throw new Error(`Missing locked dependency ${name}.`);
        }
        const owner = scope[ownerIndex]!;
        const entry = object(owner[name]);
        add(name, entry);
        if (visited.has(entry)) continue;
        visited.add(entry);
        const nested = object(entry.dependencies);
        // A hoisted package cannot resolve into the requesting package's
        // private dependencies. Resume from the package's actual owner scope.
        const parents = scope.slice(ownerIndex);
        if (!options.prod) walk(nested, parents, Object.keys(nested));
        else walk(nested, parents, Object.keys(object(entry.requires)), object(entry.optionalDependencies));
      }
    };
    const visited = new Set<Entry>();
    walk(top, [], options.prod && manifest ? dependencyNames(manifest) : Object.keys(top), object(root.optionalDependencies));
  }
  return [...result.values()];
}
