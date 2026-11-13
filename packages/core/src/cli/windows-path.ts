import { execFileSync } from "node:child_process";
import path from "node:path";

export type WindowsPathScope = "User" | "Machine";
export interface WindowsPathSnapshot {
  readonly value: string | null;
  readonly kind: "String" | "ExpandString" | null;
}
export interface WindowsPathStore {
  read(scope: WindowsPathScope): WindowsPathSnapshot;
  write(scope: WindowsPathScope, expected: WindowsPathSnapshot, value: string): void;
}

// Windows counts UTF-16 code units, including the terminating null character.
export const MAX_WINDOWS_PATH_CHARS = 32_766;

function comparablePath(value: string, environment: Readonly<NodeJS.ProcessEnv>): string {
  const variables = new Map(Object.entries(environment).map(([key, entry]) => [key.toLowerCase(), entry]));
  let expanded = value.trim().replace(/^"(.*)"$/, "$1");
  for (let pass = 0; pass < 8; pass++) {
    const next = expanded.replace(/%([^%]+)%/g, (reference, name: string) => variables.get(name.toLowerCase()) ?? reference);
    if (next === expanded) break;
    expanded = next;
  }
  return path.win32.normalize(expanded).replace(/[\\/]+$/, "").toLowerCase();
}

/** Change only our entry; every unrelated entry keeps its spelling and order. */
export function planWindowsPath(
  current: string | null,
  directory: string,
  remove = false,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (!directory || /[;\0\r\n]/.test(directory)) throw new Error("The shim directory cannot be represented as one Windows PATH entry.");
  const source = current ?? "";
  const entries = source === "" ? [] : source.split(";");
  const target = comparablePath(directory, environment);
  const matches = entries.map(entry => entry.length > 0 && comparablePath(entry, environment) === target);
  if (!remove && matches[0] && matches.filter(Boolean).length === 1) return source;
  const rest = entries.filter((_, index) => !matches[index]);
  if (remove) return matches.some(Boolean) ? rest.join(";") : source;
  const first = entries.find((_, index) => matches[index]) ?? directory;
  const next = [first, ...rest].join(";");
  if (next.length > MAX_WINDOWS_PATH_CHARS) {
    throw new Error(`Windows PATH would contain ${next.length} characters (maximum ${MAX_WINDOWS_PATH_CHARS}); it was not changed. Use npm-safe gate shell --file <PowerShell-profile> to install shell wrappers without editing PATH.`);
  }
  return next;
}

// Read raw registry values instead of .NET Environment.GetEnvironmentVariable:
// the latter expands REG_EXPAND_SZ references. No process/Machine PATH is copied
// into a User value. The payload travels over stdin, avoiding command-line caps.
const PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($payload.scope -eq 'User') {
  $hive = [Microsoft.Win32.Registry]::CurrentUser
  $subkey = 'Environment'
} elseif ($payload.scope -eq 'Machine') {
  $hive = [Microsoft.Win32.Registry]::LocalMachine
  $subkey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
} else { throw 'Unsupported PATH scope.' }
$writing = $payload.action -eq 'write'
if (-not $writing -and $payload.action -ne 'read') { throw 'Unsupported PATH action.' }
$key = $hive.OpenSubKey($subkey, $writing)
if ($null -eq $key -and $writing) { $key = $hive.CreateSubKey($subkey) }
try {
  $current = $null
  $kind = $null
  if ($null -ne $key) {
    $current = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $current) {
      $kind = $key.GetValueKind('Path').ToString()
      if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw 'PATH has an unsupported registry value type; it was not changed.' }
    }
  }
  if (-not $writing) { @{value=$current; kind=$kind} | ConvertTo-Json -Compress; return }
  if ($current -cne $payload.expected.value -or $kind -cne $payload.expected.kind) { throw 'PATH changed concurrently; run the command again. It was not overwritten.' }
  $next = [string]$payload.value
  if ($next.Length -gt 32766 -or $next.IndexOf([char]0) -ge 0) { throw 'PATH exceeds the Windows value limit; it was not changed. Use a shell profile wrapper instead.' }
  $nextKind = if ($null -eq $kind) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], $kind)) }
  $key.SetValue('Path', $next, $nextKind)
  if ($key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $next) { throw 'PATH verification failed after writing the registry value.' }
} finally { if ($null -ne $key) { $key.Dispose() } }
try {
  Add-Type -Namespace NpmSafe -Name EnvironmentNotification -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr window, uint message, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
  $result = [UIntPtr]::Zero
  [void][NpmSafe.EnvironmentNotification]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
} catch { }
'ok'
`;

export type WindowsPathInvoker = (script: string, input: string) => string;

export function windowsPathStore(invoke: WindowsPathInvoker = (script, input) => {
  const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", input, windowsHide: true,
  });
}): WindowsPathStore {
  return {
    read(scope) {
      const result = JSON.parse(invoke(PATH_SCRIPT, JSON.stringify({ action: "read", scope }))) as WindowsPathSnapshot;
      if ((result.value !== null && typeof result.value !== "string") || ![null, "String", "ExpandString"].includes(result.kind)) {
        throw new Error("Could not read the raw Windows PATH value.");
      }
      return result;
    },
    write(scope, expected, value) {
      invoke(PATH_SCRIPT, JSON.stringify({ action: "write", scope, expected, value }));
    },
  };
}

/** Explicit --user/--machine activation; callers can inject a non-registry store in tests. */
export function updateWindowsPath(
  directory: string,
  options: { readonly scope: WindowsPathScope; readonly remove?: boolean; readonly store?: WindowsPathStore; readonly environment?: Readonly<NodeJS.ProcessEnv> },
): "updated" | "already" | "removed" | "absent" {
  const store = options.store ?? windowsPathStore();
  const previous = store.read(options.scope);
  const next = planWindowsPath(previous.value, directory, options.remove, options.environment);
  if (next === (previous.value ?? "")) return options.remove ? "absent" : "already";
  store.write(options.scope, previous, next);
  return options.remove ? "removed" : "updated";
}
