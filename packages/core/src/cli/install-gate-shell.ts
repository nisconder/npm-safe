import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NPM_INSTALL_ALIASES, packageManagerOptionKind } from "./install-arguments.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

export const SHELL_BLOCK_START = "# >>> npm-safe gate >>>";
export const SHELL_BLOCK_END = "# <<< npm-safe gate <<<";

export function bashWrapperBlock(): string {
  const module = Buffer.from(import.meta.url, "utf8").toString("base64");
  const invoke = `import(Buffer.from('${module}','base64').toString()).then(m=>{process.exitCode=m.runGateShim(process.argv[1],process.argv.slice(2))})`;
  const node = process.platform === "win32" ? process.execPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1") : process.execPath;
  const launcher = [node, ...sourceLoaderArgs(), "-e", invoke].map((arg) => `'${arg.replace(/'/g, `'"'"'`)}'`).join(" ");
  const wrappers = (["npm", "pnpm", "yarn"] as const).map((pm) => `${pm}() {
  command ${launcher} '${pm}' "$@"
}`).join("\n");
  return `${SHELL_BLOCK_START}\n${wrappers}\n${SHELL_BLOCK_END}`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function powershellWrapperBlock(): string {
  // Send argument data as base64. Windows PowerShell's legacy native argument
  // serializer otherwise drops empty arguments and changes embedded quotes.
  const module = Buffer.from(import.meta.url, "utf8").toString("base64");
  const invoke = `import(Buffer.from('${module}','base64').toString()).then(m=>{process.exitCode=m.runGateShim(process.argv[1],JSON.parse(Buffer.from(process.argv[2],'base64').toString()))})`;
  const launcher = [process.execPath, ...sourceLoaderArgs(), "-e", invoke].map(quotePowerShell).join(" ");
  const wrappers = (["npm", "pnpm", "yarn"] as const).map((pm) => `function ${pm} {
  $npmSafePayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject ([string[]]$args) -Compress)))
  & ${launcher} '${pm}' $npmSafePayload
}`).join("\n");
  return `${SHELL_BLOCK_START}\n${wrappers}\n${SHELL_BLOCK_END}`;
}

export function shimDirectory(): string {
  return path.join(os.homedir(), ".npm-safe", "bin");
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync(resolved); } catch { /* Missing paths cannot be executed. */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

function isGateShim(file: string): boolean {
  if (samePath(path.dirname(file), shimDirectory())) return true;
  if (!/\.(?:cmd|bat)$/i.test(file)) return false;
  try {
    return fs.readFileSync(file, "utf8").includes("rem npm-safe gate shim for ");
  } catch {
    return false;
  }
}

/** Resolve beyond our PATH shims so children never launch the gate recursively. */
export function resolvePackageManager(pm: PackageManager): string {
  const override = process.env[`NPMSAFE_REAL_${pm.toUpperCase()}`];
  if (override && fs.existsSync(override) && !isGateShim(override)) return override;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const directory = entry.replace(/^"(.*)"$/, "$1");
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${pm}${extension}`);
      if (isGateShim(candidate)) continue;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  throw new Error(`${pm} not found in PATH (excluding npm-safe gate shims)`);
}

/** Escape one argument for a cmd script that subsequently forwards it with %*. */
function quoteCmdArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Windows batch arguments cannot contain line breaks or null bytes");
  // First quote for the Windows argv parser, then protect shell metacharacters.
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  return quoted.replace(/([()%!^"<>&|;, *?])/g, "^$1").replace(/([()%!^"<>&|;, *?])/g, "^$1");
}

/** Execute the real command once and return its original exit code. */
export function runPackageManagerProcess(pm: PackageManager, argv: string[], cwd: string, stdoutToStderr = false): number {
  try {
    const binary = resolvePackageManager(pm);
    const env = { ...process.env, [`NPMSAFE_REAL_${pm.toUpperCase()}`]: binary };
    const prefix = env.NPMSAFE_GATE_COMMAND_PREFIX;
    delete env.NPMSAFE_GATE_COMMAND_PREFIX;
    if (prefix) {
      const original = JSON.parse(prefix) as { pm?: string; verb?: string; count?: number };
      const count = original.count;
      if (original.pm === pm && original.verb === argv[0] && typeof count === "number" && Number.isInteger(count) && count > 0 && count < argv.length) {
        argv = [...argv.slice(1, count + 1), argv[0], ...argv.slice(count + 1)];
      }
    }
    const result = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", [
        "/d", "/s", "/c",
        `"${[binary.replace(/([()%!^"<>&|;, *?])/g, "^$1"), ...argv.map(quoteCmdArgument)].join(" ")}"`,
      ], { cwd, env, stdio: stdoutToStderr ? ["inherit", process.stderr, process.stderr] : "inherit", windowsVerbatimArguments: true })
      : spawnSync(binary, argv, { cwd, env, stdio: stdoutToStderr ? ["inherit", process.stderr, process.stderr] : "inherit" });
    if (result.error) console.error(`[npm-safe] ${result.error.message}`);
    return result.status ?? 1;
  } catch (error) {
    console.error(`[npm-safe] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Invoked by the generated Node shim, where argv already has native tokenization. */
export function runGateShim(pm: PackageManager, argv: string[]): number {
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn") return 1;
  let commandIndex = 0;
  while (commandIndex < argv.length && argv[commandIndex].startsWith("-")) {
    const option = argv[commandIndex];
    if (option === "--") {
      commandIndex++;
      break;
    }
    const equals = option.indexOf("=");
    const name = equals < 0 ? option : option.slice(0, equals);
    const kind = packageManagerOptionKind(name, pm);
    const next = argv[commandIndex + 1];
    // npm's nopt parser consumes explicit boolean values before the command.
    // Color additionally accepts the enum "always" alongside true and false.
    const npmBooleanValue = pm === "npm" && equals < 0 && kind === "boolean" &&
      (next === "true" || next === "false" || ((name === "--color" || name === "--no-color") && next === "always"));
    if (["--help", "-h", "--version", "-v"].includes(option) && !(npmBooleanValue && next === "false")) {
      return runPackageManagerProcess(pm, argv, process.cwd());
    }
    const attachedShortValue = /^-[A-Za-z].+/.test(name) && packageManagerOptionKind(name.slice(0, 2), pm) === "value";
    if (kind === "unknown" && !attachedShortValue) {
      console.error(`[npm-safe] Cannot safely identify the ${pm} command after unknown option ${name}`);
      return 1;
    }
    commandIndex += (equals < 0 && kind === "value") || npmBooleanValue ? 2 : 1;
  }
  const explicitVerb = argv[commandIndex];
  const verb = explicitVerb ?? (pm === "yarn" ? "install" : "");
  const installation = ["install", "add", "i"].includes(verb) ||
    (pm === "npm" && (verb === "ci" || (NPM_INSTALL_ALIASES as readonly string[]).includes(verb)));
  if (!installation) return runPackageManagerProcess(pm, argv, process.cwd());
  try {
    const binary = resolvePackageManager(pm);
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const cli = fileURLToPath(new URL(`./cli${extension}`, import.meta.url));
    const args = explicitVerb === undefined ? argv : [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
    const result = spawnSync(process.execPath, [
      ...sourceLoaderArgs(), cli, "install", "--pm", pm, "--verb", verb, "--", ...args,
    ], {
      stdio: "inherit",
      env: {
        ...process.env,
        [`NPMSAFE_REAL_${pm.toUpperCase()}`]: binary,
        NPMSAFE_GATE_COMMAND_PREFIX: JSON.stringify({ pm, verb, count: explicitVerb === undefined ? 0 : commandIndex }),
      },
    });
    if (result.error) console.error(`[npm-safe] ${result.error.message}`);
    return result.status ?? 1;
  } catch (error) {
    console.error(`[npm-safe] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function sourceLoaderArgs(): string[] {
  return import.meta.url.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
    : [];
}

function quoteBatchLiteral(value: string): string {
  return `"${value.replace(/%/g, "%%")}"`;
}

export function windowsShimContent(pm: PackageManager): string {
  const launcher = [process.execPath, ...sourceLoaderArgs()].map(quoteBatchLiteral).join(" ");
  return `@echo off\r\nrem npm-safe gate shim for ${pm} - do not edit\r\nsetlocal DisableDelayedExpansion\r\n${launcher} "%~dp0gate-shim.mjs" ${pm} %*\r\nexit /b %errorlevel%\r\n`;
}

export function shimHelperContent(): string {
  return `import { runGateShim } from ${JSON.stringify(import.meta.url)};\nprocess.exitCode = runGateShim(process.argv[2], process.argv.slice(3));\n`;
}
