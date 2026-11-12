import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanConcealedContent, hasConcealedCodeCandidate } from '../src/scanner/content-concealed-code.js';
import { concealedConstants } from '../src/scanner/concealed-string-table.js';
import { tokenizeSource } from '../src/scanner/source-tokens.js';
import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { makeTarball } from './helpers/package-tarball.js';

// Inert source strings: the test only tokenizes them, never imports or runs them.
const strings = ['77', 'child_', 'process', 'exec', 'fs', 'request', 'createReadStream', 'post', 'data'];
function tableSource(values = strings): string {
  const rotated = [...values.slice(3), ...values.slice(0, 3)];
  return `
    (function(factory,target){const array=factory();while(!![]){try{
      const check=parseInt(lookup(0x100))/(2-1);
      if(check===target)break;else array['push'](array['shift']());
    }catch(error){array['push'](array['shift']());}}}(table,70+7));
    function lookup(input,unused){const array=table();return lookup=function(index,ignored){
      index=index-(0x80*2);const result=array[index];return result;
    },lookup(input,unused);}
    function table(){const items=${JSON.stringify(rotated)};table=function(){return items;};return table();}
    function wrapper(a,b){return lookup(a- -0x10,b);}
  `;
}
const calls = `
  const run=require(wrapper(0xf1,0)+lookup(0x102))[lookup(0x103)],
    files=require('fs'), network=require(lookup(0x105));
  run('echo fixture');
  files[lookup(0x106)]('fixture.data');
  network[lookup(0x107)]({body:'fixture'});
`;
const scan = (source: string) => scanConcealedContent(source, 'index.js');

describe('concealed capability combinations', () => {
  it('retains supported folded rotation names through the archive prefilter', () => {
    const source = (tableSource() + calls).replaceAll("['push']", "['pu'+'sh']");
    const result = analyzePackageTarball(makeTarball([{ path: 'package/index.js', content: source }]));
    assert.equal(result.summary.status, 'complete');
    assert.ok(result.findings.some(finding => finding.ruleId === 'content-concealed-capabilities'));
  });

  it('resolves rotated strings and arithmetic wrappers without evaluating source', () => {
    const source = tableSource() + 'wrapper(0xf1,0)+lookup(0x102)';
    const tokens = tokenizeSource(source), constants = concealedConstants(tokens);
    const start = tokens.findLastIndex(token => token.value === 'wrapper');
    assert.equal(constants.recovered, 1);
    assert.equal(constants.value(start, tokens.length), 'child_process');
  });

  it('reports concealed process execution with actual file and network calls', () => {
    const findings = scan(tableSource() + calls);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'content-concealed-capabilities');
    assert.equal(findings[0].severity, 'high');
    assert.ok(findings[0].lineNumber);
    assert.match(findings[0].message, /child_process\.exec.*fs\.createReadStream.*request\.post/);
  });

  for (const [name, remove] of [
    ['process execution', "run('echo fixture');"],
    ['file-reading calls', "files[lookup(0x106)]('fixture.data');"],
    ['network calls', "network[lookup(0x107)]({body:'fixture'});"],
  ]) it(`requires ${name}, not just module names in a string table`, () => {
    assert.deepEqual(scan(tableSource() + calls.replace(remove, '')), []);
  });

  it('does not flag benign obfuscated data access or a minified library', () => {
    assert.deepEqual(scan(tableSource() + "console.log(lookup(0x108));"), []);
    assert.deepEqual(scan("!function(t){var n=['require','parseInt','push','shift'];function e(t){return n[t]}t.label=e(0)}({});"), []);
  });

  it('does not associate global-object discovery with unrelated encoded assets', () => {
    const asset = 'QUFB'.repeat(80);
    assert.deepEqual(scan(tableSource() + `const root=Function('return this')(); const asset='${asset}';`), []);
  });

  it('does not confuse encoded-execution strings with recovered module imports', () => {
    assert.deepEqual(scan(tableSource() + `const example="require('child_process').exec('echo fixture')";`), []);
  });

  it('rejects ambiguous or unsatisfied checksums', () => {
    const ambiguous = [...strings]; ambiguous[8] = '77';
    assert.deepEqual(scan(tableSource(ambiguous) + calls), []);
    assert.deepEqual(scan(tableSource().replace('table,70+7', 'table,999') + calls), []);
  });

  it('rejects helpers with additional executable statements', () => {
    assert.deepEqual(scan(tableSource().replace('return result;', 'sideEffect();return result;') + calls), []);
    assert.deepEqual(scan(tableSource().replace('return items;', 'return different;') + calls), []);
  });

  it('does not infer a rotation from unrelated push and shift operations', () => {
    assert.deepEqual(scan(tableSource().replaceAll("array['push'](array['shift']())", "other['push'](other['shift']())") + calls), []);
    assert.deepEqual(scan(tableSource().replace('while(!![])', 'if(enabled)') + calls), []);
  });

  it('does not resolve shadowed or reassigned helpers', () => {
    assert.deepEqual(scan(tableSource() + 'lookup = other;' + calls), []);
    assert.deepEqual(scan(tableSource() + 'function local(lookup){}' + calls), []);
    assert.deepEqual(scan(tableSource() + 'function local(parseInt){}' + calls), []);
  });

  it('does not treat a local require function as the Node module loader', () => {
    assert.deepEqual(scan(tableSource() + `function local(require){${calls}}`), []);
  });

  it('does not join capabilities through reassigned or shadowed aliases', () => {
    assert.deepEqual(scan(tableSource() + calls + 'function local(run){}'), []);
    assert.deepEqual(scan(tableSource() + calls + 'network = other;'), []);
  });

  it('terminates on recursive wrappers and ignores unsupported file types', () => {
    const source = tableSource() + 'function cycle(n){return cycle(n);}' + calls.replace('wrapper(0xf1,0)', 'cycle(1)');
    assert.deepEqual(scan(source), []);
    assert.deepEqual(scanConcealedContent(tableSource() + calls, 'README.md'), []);
  });

  it('has a cheap necessary-condition prefilter', () => {
    assert.equal(hasConcealedCodeCandidate(tableSource() + calls), true);
    assert.equal(hasConcealedCodeCandidate('function add(a,b){return a+b}'), false);
  });
});
