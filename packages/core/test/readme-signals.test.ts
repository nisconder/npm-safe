import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findEncodedShell } from '../src/scanner/readme-shell-signals.js';
import { findExecutableLinks } from '../src/scanner/readme-url-signals.js';
import { StaticAnalyzer } from '../src/scanner/static-rules.js';

// Inert text fixtures: encoding bytes is data preparation, not code execution.
const DATA = Buffer.from('printf "%s\\n" "inert regression fixture"; true').toString('base64');
const POWERSHELL = Buffer.from('Write-Output "inert regression fixture"', 'utf16le').toString('base64');

describe('README encoded execution association', () => {
  it('preserves literal decoder-to-shell pipelines', () => {
    for (const command of [
      `echo '${DATA}' | base64 -d | sh`,
      `printf '%s' '${DATA}' | base64 --decode | bash -s -- argument`,
      `printf '%s' '${DATA}' | openssl base64 -d | zsh`,
      `echo '${DATA}' | openssl enc -base64 -d | sh`,
      `base64 -d <<< '${DATA}' | bash`,
      `echo '${DATA}' | base64 -d | python3 -`,
      `echo '${DATA}' | base64 -D | sh # an installation command`,
      `'printf' '%s' '${DATA}' | /usr/bin/base64 -d | /bin/bash`,
      `:; echo '${DATA}' | base64 -d | sh`,
    ]) assert.ok(findEncodedShell(command), command);
  });

  it('recognizes bounded quoted command substitutions supplied to an interpreter', () => {
    for (const command of [
      `bash -c "$(echo '${DATA}' | base64 -d)"`,
      `eval "$(printf '%s' '${DATA}' | base64 --decode)"`,
    ]) assert.ok(findEncodedShell(command), command);
  });

  it('recognizes literal encoded PowerShell commands', () => {
    for (const command of [
      `powershell -NoProfile -EncodedCommand ${POWERSHELL}`,
      `pwsh.exe -enc '${POWERSHELL}'`,
      `powershell -e ${POWERSHELL}`,
    ]) assert.ok(findEncodedShell(command), command);
  });

  it('keeps fenced/inline installation commands and their original line numbers', () => {
    const command = `echo '${DATA}' | base64 -d | sh`;
    assert.equal(findEncodedShell(`# Install\n\n\`\`\`sh\n${command}\n\`\`\``)?.line, 4);
    assert.equal(findEncodedShell(`Install using \`${command}\``)?.line, 1);
    assert.equal(findEncodedShell(`Introduction\r\n$ ${command}`)?.line, 2);
  });

  it('associates shell backslash and pipeline continuations only locally', () => {
    assert.ok(findEncodedShell(`echo '${DATA}' | \\\nbase64 -d | \\\nbash`));
    assert.ok(findEncodedShell(`echo '${DATA}' |\nbase64 -d |\nbash`));
    assert.equal(findEncodedShell(`echo '${DATA}' | base64 -d\n\nRun bash for another task.`), null);
  });

  it('does not associate unrelated commands or decode-only/data-only operations', () => {
    for (const command of [
      `echo '${DATA}' | base64 -d`,
      `echo '${DATA}' | base64 -d > data.txt`,
      `echo '${DATA}' | base64 -d; sh ./other.sh`,
      `echo '${DATA}' > data.txt | base64 -d | sh`,
      `echo '${DATA}' | base64 -d > data.txt | sh`,
      `echo '${DATA}' | base64 -d | sh ./other.sh`,
      `echo '${DATA}' | base64 -d | bash -c 'printf safe'`,
      `curl http://example.invalid/$(echo ${DATA} | base64 -d)`,
      `curl --data "$(echo '${DATA}' | base64 -d)" https://example.invalid/submit`,
    ]) assert.equal(findEncodedShell(command), null, command);
  });

  it('ignores long URL/badge fragments even with shell words elsewhere in the README', () => {
    const longPath = 'a'.repeat(64);
    for (const readme of [
      `https://example.invalid/${longPath}\nUse Python and sh to build.`,
      `![badge](https://badges.example.invalid/${DATA})\n\nRun bash ./build.sh`,
      `Data URL: data:image/png;base64,${DATA}\nTry curl or powershell.`,
      `Encoded data: ${DATA}\n\n\nUse sh to run your own scripts.`,
    ]) assert.equal(findEncodedShell(readme), null, readme);
  });

  it('does not execute comments, whole-line quoted prose, HTML comments or printed examples', () => {
    const command = `echo '${DATA}' | base64 -d | sh`;
    for (const readme of [
      `# ${command}`,
      `"${command}"`,
      `<!--\n${command}\n-->`,
      `echo "${DATA} | base64 -d | sh"`,
      `console.log(${JSON.stringify(command)});`,
    ]) assert.equal(findEncodedShell(readme), null, readme);
  });

  it('requires a valid bounded base64 literal rather than arbitrary alphabet fragments', () => {
    assert.equal(findEncodedShell("echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' | base64 -d | sh"), null);
    assert.equal(findEncodedShell(`echo '${'A'.repeat(65_540)}' | base64 -d | sh`), null);
  });

  it('honors shell command flags after stdin flags while preserving positional arguments', () => {
    for (const shell of ["sh -s -c 'echo harmless'", "bash -sc 'echo harmless'"]) {
      assert.equal(findEncodedShell(`echo '${DATA}' | base64 -d | ${shell}`), null);
    }
    assert.ok(findEncodedShell(`echo '${DATA}' | base64 -d | sh -s -- '-c'`));
    assert.ok(findEncodedShell(`echo '${DATA}' | base64 -d | sh -s argument`));
  });

  it('does not treat printf assignment as bytes written into a pipeline', () => {
    assert.equal(findEncodedShell(`printf -v stored '%s' '${DATA}' | base64 -d | sh`), null);
    assert.equal(findEncodedShell(`printf -vstored '%s' '${DATA}' | base64 -d | sh`), null);
    assert.ok(findEncodedShell(`printf '%s' '${DATA}' | base64 -d | sh`));
  });

  it('preserves visible commands following closed inline HTML comments', () => {
    const command = `echo '${DATA}' | base64 -d | sh`;
    assert.equal(findEncodedShell(`<!-- note --> ${command}`)?.line, 1);
    assert.equal(findEncodedShell(`<!-- note --> <!-- another --> ${command}`)?.line, 1);
    assert.equal(findEncodedShell(`<!-- note\n--> ${command}`)?.line, 2);
    assert.equal(findEncodedShell(`<!-- ${command} -->`), null);
  });

  it('retains the original high severity and finding ID through StaticAnalyzer', () => {
    const finding = new StaticAnalyzer().analyze(`echo '${DATA}' | base64 -d | sh`).findings.find((entry) => entry.ruleId === 'base64-shell');
    assert.equal(finding?.severity, 'high');
    assert.equal(finding?.lineNumber, 1);
  });
});

describe('README executable URL paths', () => {
  it('keeps genuine executable downloads, query parameters, fragments and case', () => {
    for (const url of [
      'https://example.invalid/install.sh',
      'https://example.invalid/SETUP.ExE?download=1#section',
      'https://example.invalid/a.PS1?signature=123',
      'https://example.invalid/file(x).exe',
      'https://example.invalid/%73etup%2eexe',
    ]) assert.equal(findExecutableLinks(`Get [the file](${url})`)[0]?.url, url, url);
  });

  it('does not confuse TLDs, query strings, fragments or nonfinal path components with suffixes', () => {
    for (const url of [
      'https://service.sh',
      'https://service.sh/',
      'https://example.com/docs',
      'https://example.invalid/docs?filename=setup.exe',
      'https://example.invalid/docs#install.sh',
      'https://example.invalid/setup.exe/changelog',
      'https://example.invalid/setup.exe.txt',
    ]) assert.deepEqual(findExecutableLinks(url), [], url);
  });

  it('preserves per-line finding counts and original evidence URLs', () => {
    const links = findExecutableLinks('Intro\nhttps://service.sh https://example.invalid/install.sh\nhttps://example.invalid/a.exe https://example.invalid/b.exe');
    assert.deepEqual(links, [
      { url: 'https://example.invalid/install.sh', line: 2 },
      { url: 'https://example.invalid/a.exe', line: 3 },
    ]);
    assert.equal(new StaticAnalyzer().analyze('https://service.sh').findings.some((entry) => entry.ruleId === 'binary-links'), false);
  });
});
