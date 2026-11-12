import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { makeTarball } from './helpers/package-tarball.js';

const asset = `const asset = '${'A'.repeat(200)}';\n`;
const escaped = String.raw`\x63\x6f\x6e\x73\x6f\x6c\x65\x2e\x6c\x6f\x67\x28\x31\x29`;
function scan(source: string) {
  return analyzePackageTarball(makeTarball([{ path: 'package/index.js', content: source }]));
}
function dynamic(source: string) {
  return scan(source).findings.find(finding => finding.ruleId === 'content-obfuscated-exec');
}

describe('argument-local obfuscated execution', () => {
  it('retains long literals interrupted by sparse escapes through the archive prefilter', () => {
    const payload = ('A'.repeat(24) + String.raw`\u0041`).repeat(7);
    assert.ok(dynamic(`eval('${payload}');`));
  });

  for (const [name, source] of [
    ['global-object probe', `${asset}const root = freeGlobal || Function('return this')();`],
    ['template compiler', `${asset}String.fromCharCode(code); Function(importsKeys, sourceURL + 'return ' + source);`],
    ['plain eval', `${asset}eval('1 + 1');`],
    ['decoder in a comment', `Function('return this'); /* String.fromCharCode(code) */`],
    ['decoder example in an argument', `Function('return "String.fromCharCode(code)"');`],
    ['decoder comment inside an argument', `eval(/* String.fromCharCode(code) */ '1 + 1');`],
    ['encoded regex inside an argument', `eval(/${'A'.repeat(200)}/.source);`],
    ['comment between folded strings', `eval('1' /* ${'A'.repeat(200)} ${escaped} */ + '+1');`],
    ['ordinary methods', `${asset}obj.Function(String.fromCharCode(49)); obj.eval(atob(input));`],
    ['method declaration', `${asset}const obj = { Function(code = atob(input)) {} };`],
    ['non-body Function parameter', `Function('${'A'.repeat(200)}', 'return 1');`],
    ['ignored eval argument', `eval('1 + 1', atob(input));`],
    ['unrelated base64 label', `eval(format(input, 'base64')); Buffer.from(data);`],
  ]) {
    it(`does not infer obfuscation from ${name}`, () => {
      assert.equal(dynamic(source), undefined);
    });
  }

  for (const [name, source] of [
    ['base64 decoding with a variable', `${asset}eval(Buffer.from(asset, 'base64').toString());`],
    ['short base64 decoding', `eval(Buffer.from('MQ==', 'base64').toString());`],
    ['atob', `Function(atob(input))();`],
    ['decoder calls split by comments', `eval(Buffer /* comment */ .from(input, 'base64').toString());`],
    ['atob call split by a comment', `eval(atob /* comment */ (input));`],
    ['call before an independent block', `eval(atob(input))\n{ console.log(1); }`],
    ['character-code construction', `new Function(String.fromCharCode(114,101,116,117,114,110,32,49))();`],
    ['escaped source', `eval('${escaped}');`],
    ['Unicode escapes', `Function('${String.raw`\u0061`.repeat(8)}');`],
    ['long literal', `eval('${'A'.repeat(200)}');`],
    ['opaque long literal', `Function('${'A'.repeat(5000)}');`],
    ['folded long literal', `Function('${'A'.repeat(100)}' + '${'B'.repeat(100)}');`],
    ['Function body with trailing comma', `Function('arg', atob(input),)();`],
  ]) {
    it(`retains dynamic-execution evidence for ${name}`, () => {
      const finding = dynamic(source);
      assert.ok(finding);
      assert.equal(finding.severity, 'high');
    });
  }

  it('continues past a benign call and locates the later encoded execution', () => {
    const finding = dynamic(`${asset}const root = Function('return this')();\neval(Buffer.from(asset, 'base64').toString());`);
    assert.ok(finding);
    assert.equal(finding.lineNumber, 3);
    assert.equal(finding.codeSnippet, "eval(Buffer.from(asset, 'base64').toString());");
  });

  it('inspects a large opaque literal without exhausting the call stack or archive parser', () => {
    const result = scan(`eval('${'A'.repeat(900_000)}');`);
    assert.equal(result.summary.status, 'complete');
    assert.ok(result.findings.some(finding => finding.ruleId === 'content-obfuscated-exec'));
  });
});
