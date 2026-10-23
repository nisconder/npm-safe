import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function unsafeRegistry(source: string, key: string): Error {
  return new Error(`Cannot verify install registry "${key}" in ${source}; the gate only scans https://registry.npmjs.org/.`);
}

function expandEnvironment(value: string, source: string, key: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, variable: string) => {
    const resolved = process.env[variable];
    if (resolved === undefined) throw unsafeRegistry(source, key);
    return resolved;
  });
}

/** Strip a scalar's comments and surrounding quotes, refusing ambiguous syntax. */
function scalar(raw: string, source: string, key: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s*(?:[#;].*)?$/.exec(value);
    if (!match) throw unsafeRegistry(source, key);
    try {
      return expandEnvironment(JSON.parse(match[1]) as string, source, key);
    } catch {
      throw unsafeRegistry(source, key);
    }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:[#;].*)?$/.exec(value);
    if (!match) throw unsafeRegistry(source, key);
    return expandEnvironment(match[1].replace(/''/g, "'"), source, key);
  }
  return expandEnvironment(value.replace(/\s+[#;].*$/, "").trim(), source, key);
}

function checkRegistry(raw: string, source: string, key: string): void {
  let registry: URL;
  try {
    registry = new URL(scalar(raw, source, key));
  } catch {
    throw unsafeRegistry(source, key);
  }
  if (registry.protocol !== "https:" || registry.hostname !== "registry.npmjs.org" ||
      registry.port !== "" || registry.pathname !== "/" || registry.username ||
      registry.password || registry.search || registry.hash) {
    throw unsafeRegistry(source, key);
  }
}

function configPath(raw: string, source: string, key: string): string {
  // Environment paths are already shell-decoded. Treat # and ; as literal
  // filename characters instead of inspecting a different, truncated file.
  let value = source === "environment" ? raw : scalar(raw, source, key);
  if (source === "environment" && value.includes("${")) throw unsafeRegistry(source, key);
  if (!value || /[\r\n]/.test(value)) throw unsafeRegistry(source, key);
  if (value === "~") value = os.homedir();
  else if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/**
 * Refuse sources that can make npm, pnpm or Yarn download another registry's
 * artifact after the gate inspected the public npm manifest. Every configured
 * source is checked, including shadowed values, so precedence cannot hide one.
 */
export function assertPublicInstallRegistry(directory: string): void {
  const home = path.resolve(os.homedir());
  const npmFiles = new Set<string>();
  const yarnFiles = new Set<string>();
  const yarnClassicFiles = new Set<string>();
  let userConfig: string | undefined;
  let globalConfig: string | undefined;
  let prefix: string | undefined;
  let yarnFilename = ".yarnrc.yml";

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "npm_config_registry" || /^npm_config_.*[:_]registry$/.test(lower) ||
        lower === "yarn_npm_registry_server" || lower === "yarn_registry") {
      checkRegistry(value, "environment", key);
    } else if (lower === "yarn_npm_scopes" || lower.startsWith("yarn_npm_scopes__")) {
      throw unsafeRegistry("environment", key);
    } else if (lower === "npm_config_userconfig") {
      userConfig = configPath(value, "environment", key);
    } else if (lower === "npm_config_globalconfig") {
      globalConfig = configPath(value, "environment", key);
    } else if (lower === "npm_config_prefix") {
      prefix = configPath(value, "environment", key);
    } else if (lower === "yarn_rc_filename") {
      if (!value || path.basename(value) !== value || /[\\/\r\n]/.test(value)) throw unsafeRegistry("environment", key);
      yarnFilename = value;
    }
  }

  npmFiles.add(path.join(home, ".npmrc"));
  if (userConfig) npmFiles.add(userConfig);
  if (globalConfig) npmFiles.add(globalConfig);
  else {
    const defaultPrefix = process.platform === "win32" && process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm")
      : path.dirname(path.dirname(process.execPath));
    npmFiles.add(path.join(prefix ?? defaultPrefix, "etc", "npmrc"));
  }
  yarnFiles.add(path.join(home, yarnFilename));
  yarnFiles.add(path.join(home, ".yarnrc.yml"));
  yarnClassicFiles.add(path.join(home, ".yarnrc"));
  const ancestors: string[] = [];
  let current = path.resolve(directory);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    const atHome = process.platform === "win32" ? current.toLowerCase() === home.toLowerCase() : current === home;
    if (parent === current || atHome) break;
    current = parent;
  }
  // npm reads the local project/workspace config, rather than every .npmrc
  // above cwd. In particular, an unrelated account's ancestor file must not
  // become a user config when HOME was explicitly redirected.
  const projectIndex = ancestors.findIndex((candidate) =>
    fs.existsSync(path.join(candidate, "package.json")) || fs.existsSync(path.join(candidate, "node_modules")));
  let npmBoundary = Math.max(projectIndex, 0);
  for (let index = npmBoundary; index < ancestors.length; index++) {
    const candidate = ancestors[index];
    if (fs.existsSync(path.join(candidate, "pnpm-workspace.yaml")) ||
        fs.existsSync(path.join(candidate, "pnpm-workspace.yml"))) {
      npmBoundary = index;
      break;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      const workspaces = manifest.workspaces;
      if ((Array.isArray(workspaces) && workspaces.length > 0) ||
          (workspaces && typeof workspaces === "object" &&
            Array.isArray((workspaces as { packages?: unknown }).packages))) {
        npmBoundary = index;
        break;
      }
    } catch {
      // An absent/non-workspace ancestor manifest does not extend npm's root.
    }
  }
  for (const [index, candidate] of ancestors.entries()) {
    if (index <= npmBoundary) npmFiles.add(path.join(candidate, ".npmrc"));
    yarnFiles.add(path.join(candidate, yarnFilename));
    yarnFiles.add(path.join(candidate, ".yarnrc.yml"));
    yarnClassicFiles.add(path.join(candidate, ".yarnrc"));
  }

  const read = (filename: string): string | undefined => {
    try {
      return fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read registry configuration ${filename}.`);
    }
  };

  for (const filename of npmFiles) {
    const content = read(filename);
    if (content === undefined) continue;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^[#;]/.test(trimmed)) continue;
      const match = /^([^=]+)=(.*)$/.exec(trimmed);
      const keyRaw = (match?.[1] ?? trimmed).trim();
      const key = /^["']/.test(keyRaw) ? scalar(keyRaw, filename, "configuration key") : keyRaw;
      if (key.includes("\\")) throw unsafeRegistry(filename, "escaped configuration key");
      if (/^(?:registry|@[^\s:]+:registry)(?:\[\])?$/i.test(key)) {
        if (!match || key.endsWith("[]")) throw unsafeRegistry(filename, key);
        checkRegistry(match[2], filename, key);
      } else if (/^(?:globalconfig|userconfig)$/i.test(key) && match) {
        npmFiles.add(configPath(match[2], filename, key));
      } else if (key.toLowerCase() === "prefix" && match && !globalConfig) {
        npmFiles.add(path.join(configPath(match[2], filename, key), "etc", "npmrc"));
      }
    }
  }

  for (const filename of yarnFiles) {
    const content = read(filename);
    if (content === undefined) continue;
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      // Anchors and merge keys can hide a registry value from scalar parsing.
      const unquoted = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, "").replace(/\s+#.*$/, "");
      if (/(?:^|\s)[&*][\w-]+|<<\s*:/.test(unquoted)) throw unsafeRegistry(filename, "YAML aliases");
      if (/^\s*[?:](?:\s|$)|(?:^|\s)![^\s]|^\s*%/.test(unquoted)) {
        throw unsafeRegistry(filename, "YAML mapping syntax");
      }
      const keys = /(?:^|[,{]\s*)\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][\w-]*)\s*:\s*/g;
      for (const match of line.matchAll(keys)) {
        const key = scalar(match[1], filename, "configuration key");
        if (key.toLowerCase() === "npmregistryserver") {
          checkRegistry(line.slice(match.index! + match[0].length), filename, key);
        }
      }
    }
  }

  for (const filename of yarnClassicFiles) {
    const content = read(filename);
    if (content === undefined) continue;
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const match = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s]+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const key = scalar(match[1], filename, "configuration key");
      if (/^(?:registry|@[^\s:]+:registry)$/i.test(key)) checkRegistry(match[2], filename, key);
    }
  }
}
