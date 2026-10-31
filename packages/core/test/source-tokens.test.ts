import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokenizeSource, tokenizeSourceDetailed } from '../src/scanner/source-tokens.js';

describe('bounded source tokens', () => {
  it('folds quoted constant chains across comments and preserves source offsets', () => {
    const source = "/* heading */ require('chi' /* note */ + 'ld_' + 'process')";
    const module = tokenizeSource(source).find((token) => token.kind === 'string');
    assert.equal(module?.value, 'child_process');
    assert.equal(module?.concealed, true);
    assert.equal(source.slice(module!.start, module!.end), "'chi' /* note */ + 'ld_' + 'process'");
  });

  it('decodes literal hexadecimal and Unicode escapes without evaluating expressions', () => {
    const source = String.raw`require('\x63hild_\u0070rocess')['sp'+'awn']('rundll32')`;
    const strings = tokenizeSource(source).filter((token) => token.kind === 'string');
    assert.deepEqual(strings.map((token) => token.value), ['child_process', 'spawn', 'rundll32']);
    assert.equal(strings[0].concealed, true);
  });

  it('keeps normal Windows path escapes distinct from concealed literals', () => {
    const token = tokenizeSource(String.raw`'C:\\Windows\\System32\\rundll32.exe'`)[0];
    assert.equal(token.value, 'C:\\Windows\\System32\\rundll32.exe');
    assert.equal(token.concealed, false);
  });

  it('keeps regex contents opaque to executable-token matching', () => {
    const source = String.raw`const example = /require\(['"]child_process['"]\)\/[a-z]/gi; real();`;
    const tokens = tokenizeSource(source);
    assert.equal(tokens.filter((token) => token.kind === 'regexp').length, 1);
    assert.equal(tokens.filter((token) => token.kind === 'identifier' && token.value === 'require').length, 0);
    assert.ok(tokens.some((token) => token.value === 'real'));
  });

  it('skips entire dynamic/nested templates and resumes executable tokens afterward', () => {
    const source = "const doc = `text ${`require('child_process')`} tail`; actual();";
    const tokens = tokenizeSource(source);
    assert.equal(tokens.filter((token) => token.kind === 'identifier' && token.value === 'require').length, 0);
    assert.ok(tokens.some((token) => token.value === 'actual'));
  });

  it('resumes after a shebang instead of skipping executable code', () => {
    const tokens = tokenizeSource('#!/usr/bin/env node\nrequire("child_process");');
    assert.equal(tokens[0].value, 'require');
    assert.equal(tokens[0].start, 20);
  });

  it('recognizes every JavaScript line-comment and shebang terminator', () => {
    for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      for (const prefix of ['// guidance', '#!/usr/bin/env node']) {
        assert.equal(tokenizeSource(`${prefix}${newline}actual();`)[0].value, 'actual');
      }
    }
  });

  it('recognizes regex expression statements after control-flow heads and arrow operators', () => {
    for (const head of ['if (ready)', 'while (ready)', 'for (;;)', 'for await (const x of source)', 'with (object)', 'catch (error)', 'switch (value)', '() =>', 'else', 'do', 'await', 'x instanceof', 'x in']) {
      const tokens = tokenizeSource(`${head} /fetch = function(x){new Response(1)};/.test(text);`);
      assert.equal(tokens.filter((token) => token.kind === 'regexp').length, 1, head);
      assert.equal(tokens.filter((token) => token.kind === 'identifier' && token.value === 'fetch').length, 0, head);
    }
  });

  it('exposes character and token budget exhaustion', () => {
    assert.equal(tokenizeSourceDetailed(' '.repeat(1024 * 1024 + 1)).truncated, true);
    const budget = tokenizeSourceDetailed(';'.repeat(200_001));
    assert.equal(budget.truncated, true);
    assert.equal(budget.tokens.length, 200_000);
    assert.equal(tokenizeSourceDetailed('const x = 1;').truncated, false);
    const foldedBudget = tokenizeSourceDetailed("'a'+".repeat(100_001));
    assert.equal(foldedBudget.truncated, true, 'Folding must not increase the raw token budget.');
    assert.ok(foldedBudget.tokens.length < 200_000);
  });

  it('does not fold dynamic values or run string-producing expressions', () => {
    const tokens = tokenizeSource("require('child_' + globalThis.moduleName)");
    assert.ok(tokens.some((token) => token.value === '+'));
    assert.ok(!tokens.some((token) => token.value === 'child_process'));
  });

  it('keeps malformed regex and oversized escaped literals opaque within limits', () => {
    assert.equal(tokenizeSource('const x = /unterminated')[3].kind, 'opaque');
    const source = `"${String.raw`\u0061`.repeat(10_000)}"; after();`;
    const tokens = tokenizeSource(source);
    assert.equal(tokens[0].kind, 'opaque');
    assert.equal(tokens[0].value, '');
    assert.ok(tokens.some((token) => token.value === 'after'));
    const escapedQuote = `"${'a'.repeat(4_100)}${String.raw`\"`}tail"; after();`;
    const opaque = tokenizeSource(escapedQuote);
    assert.equal(opaque[0].kind, 'opaque');
    assert.equal(escapedQuote.slice(opaque[0].end).trim(), '; after();');
  });
});
