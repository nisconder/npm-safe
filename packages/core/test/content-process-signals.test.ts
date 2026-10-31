import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanProcessContent } from '../src/scanner/content-process-signals.js';

const FILE = 'package/install.js';
const concealed = "require('chi'+'ld_pro'+'cess')[\"sp\"+\"awn\"](\"rund\"+\"ll32\", [path.join(__dirname, './native' + '.dll') + ',main']);";

describe('concealed native process execution', () => {
  it('detects fragmented module, method and native-loader command with original evidence', () => {
    const source = `// generic inert regression fixture\n${concealed}`;
    const [finding] = scanProcessContent(source, FILE);
    assert.equal(finding?.ruleId, 'content-concealed-native-exec');
    assert.equal(finding.severity, 'high');
    assert.equal(finding.filePath, FILE);
    assert.equal(finding.lineNumber, 2);
    assert.match(finding.codeSnippet!, /require\('chi'\+/);
  });

  it('recognizes same-block const module aliases and escaped static command values', () => {
    const source = String.raw`const cp = require('node:child_process'); cp.spawn('\x72undll32.exe', ['native.dll,Entry']);`;
    assert.equal(scanProcessContent(source, FILE).length, 1);
  });

  it('recognizes execFileSync with a concealed module import', () => {
    const source = "require('child_'+'process').execFileSync('rundll32', ['native.dll,Entry']);";
    assert.equal(scanProcessContent(source, FILE).length, 1);
  });

  it('does not mistake passing require as a call argument for a binding declaration', () => {
    assert.equal(scanProcessContent(`register(require); ${concealed}`, FILE).length, 1);
    assert.equal(scanProcessContent(`function demo(require) { return require; } ${concealed}`, FILE).length, 1);
  });

  it('follows same-block const aliases terminated by JavaScript automatic semicolon insertion', () => {
    const source = "const cp = require('child_'+'process')\ncp.spawn('rundll'+'32', ['native.dll,Entry']);";
    assert.equal(scanProcessContent(source, FILE).length, 1);
  });

  it('resumes after CR and Unicode line comments', () => {
    for (const newline of ['\r', '\u2028', '\u2029']) {
      assert.equal(scanProcessContent(`// guidance${newline}${concealed}`, FILE).length, 1);
    }
  });

  it('does not flag ordinary downloader/native-build child-process code', () => {
    const sources = [
      "const cp = require('child_process'); cp.spawn('node-gyp', ['rebuild']);",
      "require('child_'+'process').spawn('node-gyp', ['rebuild']);",
      "require('child_process').spawn('rundll32', ['native.dll,Entry']);",
      String.raw`require('child_process').spawn('C:\\Windows\\System32\\rundll32.exe', ['native.dll,Entry']);`,
      "require('child_'+'process').spawn('rundll32', ['native.dll']);",
      "require('child_'+'process').spawn('rundll32', [dllPath]);",
    ];
    for (const source of sources) assert.deepEqual(scanProcessContent(source, FILE), [], source);
  });

  it('does not treat comments, plain strings, regexes, docs or templates as executable calls', () => {
    const sources = [
      `/* ${concealed} */`, `// ${concealed}`,
      JSON.stringify(concealed), `const docs = ${JSON.stringify(concealed)};`,
      `const docs = \`${concealed}\`;`,
      `const docs = \`text \${\`${concealed}\`} tail\`;`,
      "const docs = /require('child_'+'process').spawn('rundll32', ['native.dll,Entry'])/;",
    ];
    for (const source of sources) assert.deepEqual(scanProcessContent(source, FILE), [], source);
    assert.deepEqual(scanProcessContent(concealed, 'package/README.md'), []);
  });

  it('does not resolve dynamic modules, commands, templates or method properties', () => {
    const sources = [
      "require('child_' + suffix)['sp'+'awn']('rundll32', ['native.dll,Entry']);",
      "require('child_'+'process').spawn('rundll32' + suffix, ['native.dll,Entry']);",
      "require('child_'+'process')[method]('rundll32', ['native.dll,Entry']);",
      "require(`child_process`)['sp'+'awn']('rundll32', ['native.dll,Entry']);",
      "require('child_'+'process').spawn('rundll32', [`${name}.dll,Entry`]);",
    ];
    for (const source of sources) assert.deepEqual(scanProcessContent(source, FILE), [], source);
  });

  it('avoids shadowed require and aliases from outer or sibling blocks', () => {
    const sources = [
      `const require = example; ${concealed}`,
      `function inspect(require) { ${concealed} }`,
      "const cp = require('child_'+'process'); function demo(cp) { cp.spawn('rundll32', ['native.dll,Entry']); }",
      "{ const cp = require('child_'+'process'); } { cp.spawn('rundll32', ['native.dll,Entry']); }",
    ];
    for (const source of sources) assert.deepEqual(scanProcessContent(source, FILE), [], source);
  });
});
