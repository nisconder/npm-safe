import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NpmSafeEngine, SecurityLevel, Severity, FindingCategory, type NpmSafeEngineOptions } from '../src/index.js';
import { LlmConfigManager } from '../src/llm/llm-config.js';
import type { SourcePacket, SourceReview } from '../src/llm/source/types.js';
import type { PackageMetadata } from '../src/registry/types.js';
import { makeTarball } from './helpers/package-tarball.js';

const name = 'source-review-offline-fixture';
const modelBase = 'https://source-review-model.invalid/v1';
const tarballUrl = `https://registry.npmjs.org/${name}/fixture.tgz`;

/** Model replies below test integration semantics, not detection accuracy. */
describe('optional source review through the production engine', () => {
  let directory: string, originalFetch: typeof fetch, engine: NpmSafeEngine;
  let archive: Buffer, metadata: PackageMetadata;
  let registryCalls: number, downloads: number, metadataCalls: number, sourceCalls: number;
  let verdict: SourceReview['verdict'], modelFailure: boolean;
  let models: string[], packets: SourcePacket[];
  let duringModel: (() => void) | undefined;
  const options = (): NpmSafeEngineOptions => ({
    dbPath: path.join(directory, 'cache.db'), rulesConfigPath: path.join(directory, 'rules.json'),
    llmConfigPath: path.join(directory, 'llm.json'), rulesDir: path.join(directory, 'plugins'),
  });
  const configure = (sourceReview = true) => engine.setLlmConfig({
    enabled: true, sourceReview, apiKey: 'inert-fixture-key', baseUrl: modelBase, model: 'fixture-model-a',
  });

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-source-engine-'));
    originalFetch = globalThis.fetch;
    registryCalls = downloads = metadataCalls = sourceCalls = 0;
    verdict = 'benign'; modelFailure = false; models = []; packets = []; duringModel = undefined;
    archive = makeTarball([{path: 'package/index.js', content: 'export const answer = 42;\n'}]);
    metadata = {
      name, modified: '2026-01-01T00:00:00Z', readme: 'A harmless integration fixture.', 'dist-tags': {latest: '1.0.0'},
      versions: {'1.0.0': {name, version: '1.0.0', main: 'index.js',
        dist: {tarball: tarballUrl, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64')},
      }},
    };
    writeFileSync(path.join(directory, 'llm.json'), JSON.stringify({enabled: false}));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === tarballUrl) { downloads++; return new Response(archive); }
      if (url === `https://registry.npmjs.org/${name}`) { registryCalls++; return new Response(JSON.stringify(metadata)); }
      assert.equal(url, `${modelBase}/chat/completions`, 'fixture must never reach an unexpected service');
      const request = JSON.parse(String(init?.body));
      const payload = JSON.parse(request.messages[1].content);
      models.push(request.model);
      if (!payload.packet) {
        metadataCalls++;
        return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({summary: 'Metadata fixture.', functionalMatch: true, suspiciousScore: 0, findings: []})}}]}));
      }
      sourceCalls++; packets.push(payload.packet);
      duringModel?.();
      if (modelFailure) return new Response('fixture failure', {status: 503});
      const first = (payload.packet as SourcePacket).files[0];
      const excerpt = first.excerpts[0];
      const response: SourceReview = {schemaVersion: 1, caseId: payload.caseId, verdict, confidence: 0.5,
        summary: 'Synthetic transport result; not a malware judgment.', limitations: ['Inert fixture only.'],
        findings: verdict === 'malicious' ? [{kind: 'integration-fixture', severity: 'critical',
          claim: 'Synthetic finding for aggregation tests.', reasoning: 'Tests plumbing, not semantic accuracy.',
          evidence: [{path: first.path, startOffset: excerpt.startOffset, endOffset: excerpt.endOffset, quote: excerpt.text}],
        }] : [],
      };
      return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(response)}}]}));
    }) as typeof fetch;
    engine = new NpmSafeEngine(options());
  });
  afterEach(() => {
    engine.close(); globalThis.fetch = originalFetch;
    rmSync(directory, {recursive: true, force: true});
  });

  it('defaults off, including migration from a legacy enabled config without the source flag', async () => {
    assert.equal(engine.getLlmStatus().sourceReview, false);
    const result = await engine.checkPackage(name, {deep: true});
    assert.equal(result.security.sourceReview, undefined);
    assert.equal(result.security.overallLevel, SecurityLevel.Safe);
    assert.equal(sourceCalls + metadataCalls, 0);
    writeFileSync(path.join(directory, 'llm.json'), JSON.stringify({enabled: true, apiKey: 'inert-fixture-key'}));
    const legacy = new LlmConfigManager(path.join(directory, 'llm.json'));
    assert.equal(legacy.getConfig().sourceReview, false);
    assert.equal(legacy.getStatus().sourceReview, false);
  });

  it('keeps legacy metadata inference when source review is off and never uploads source without deep', async () => {
    configure(false);
    const first = await engine.checkPackage(name, {deep: true});
    assert.equal(first.security.llmScan?.enabled, true);
    assert.equal(first.security.sourceReview, undefined);
    assert.equal(metadataCalls, 1); assert.equal(sourceCalls, 0);
    engine.setLlmConfig({sourceReview: true});
    const second = await engine.checkPackage(name, {forceRefresh: true});
    assert.equal(second.security.sourceReview, undefined);
    assert.equal(metadataCalls, 2); assert.equal(sourceCalls, 0);
    assert.equal(downloads, 1, 'non-deep check must not acquire source');
  });

  it('shares one exact archive between static scanning and source inference without a metadata-model call', async () => {
    configure();
    const result = await engine.checkPackage(name, {deep: true});
    assert.equal(result.security.sourceReview?.status, 'complete');
    assert.equal(result.security.sourceReview?.verdict, 'benign');
    assert.equal(result.security.sourceReview?.archiveSha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(result.security.staticScan?.contentScan?.integrityVerified, true);
    assert.equal(result.security.llmScan, undefined);
    assert.equal(downloads, 1); assert.equal(sourceCalls, 1); assert.equal(metadataCalls, 0);
    assert.equal(packets[0].files[0].excerpts[0].text, 'export const answer = 42;\n');
  });

  it('never reuses a source verdict across checks, model changes, toggles or metadata-only requests', async () => {
    configure();
    await engine.checkPackage(name, {deep: true});
    engine.setLlmConfig({model: 'fixture-model-b'});
    verdict = 'unknown';
    const changed = await engine.checkPackage(name, {deep: true});
    assert.equal(changed.security.sourceReview?.verdict, 'unknown');
    assert.deepEqual(models, ['fixture-model-a', 'fixture-model-b']);
    assert.equal(registryCalls, 1); assert.equal(downloads, 2); assert.equal(sourceCalls, 2);
    const shallow = await engine.checkPackage(name);
    assert.equal(shallow.security.sourceReview, undefined);
    assert.equal(shallow.security.overallLevel, SecurityLevel.Safe);
    engine.setLlmConfig({sourceReview: false, enabled: false});
    const disabled = await engine.checkPackage(name, {deep: true});
    assert.equal(disabled.security.sourceReview, undefined);
    assert.equal(disabled.security.overallLevel, SecurityLevel.Safe);
    assert.equal(sourceCalls, 2);
  });

  for (const severity of [Severity.High, Severity.Critical]) for (const response of ['benign', 'unknown'] as const) {
    it(`retains a static ${severity} finding when the model returns ${response}`, async () => {
      configure(); verdict = response;
      engine.registerRule({id: 'source-aggregation-fixture', name: 'Fixture', description: '', enabled: true,
        severity, category: FindingCategory.Informational,
        match: () => [{ruleId: 'source-aggregation-fixture', ruleName: 'Fixture', severity,
          category: FindingCategory.Informational, message: 'Synthetic static rule finding.'}],
      });
      const result = await engine.checkPackage(name, {deep: true});
      assert.equal(result.security.overallLevel, severity === Severity.High ? SecurityLevel.Suspicious : SecurityLevel.Dangerous);
      assert.equal(result.security.overallScore, result.security.staticScan?.score);
      assert.equal(result.security.staticScan?.findings[0].severity, severity);
    });
  }

  it('adds model danger to the combined level while leaving static score and findings unchanged', async () => {
    configure(); verdict = 'malicious';
    const result = await engine.checkPackage(name, {deep: true});
    assert.equal(result.security.overallLevel, SecurityLevel.Dangerous);
    assert.equal(result.security.overallScore, 100);
    assert.equal(result.security.staticScan?.overallLevel, SecurityLevel.Safe);
    assert.equal(result.security.staticScan?.score, 100);
    assert.deepEqual(result.security.staticScan?.findings, []);
    assert.equal(result.security.sourceReview?.findings[0].filePath, 'package/index.js');
    assert.equal(result.security.sourceReview?.findings[0].lineNumber, 1);
  });

  for (const state of ['unknown', 'failure', 'unconfigured'] as const) {
    it(`does not report safe after a requested ${state} review`, async () => {
      if (state === 'unconfigured') engine.setLlmConfig({sourceReview: true, enabled: false});
      else configure();
      if (state === 'unknown') verdict = 'unknown';
      if (state === 'failure') modelFailure = true;
      const result = await engine.checkPackage(name, {deep: true});
      assert.equal(result.security.overallLevel, SecurityLevel.Unknown);
      assert.equal(result.security.staticScan?.overallLevel, SecurityLevel.Safe);
      assert.equal(result.security.sourceReview?.verdict, 'unknown');
      assert.equal(result.security.sourceReview?.status, state === 'unknown' ? 'complete' : state === 'failure' ? 'failed' : 'skipped');
      assert.equal(sourceCalls, state === 'unconfigured' ? 0 : 1);
    });
  }

  for (const state of ['integrity', 'download-policy'] as const) {
    it(`does not send source after ${state} failure`, async () => {
      configure();
      const dist = metadata.versions['1.0.0'].dist!;
      metadata = {...metadata, versions: {'1.0.0': {...metadata.versions['1.0.0'],
        dist: state === 'integrity' ? {...dist, integrity: 'sha512-AAAA'} : {...dist, tarball: 'https://untrusted.invalid/source.tgz'},
      }}};
      const result = await engine.checkPackage(name, {deep: true});
      assert.equal(result.security.sourceReview?.status, 'failed');
      assert.equal(result.security.sourceReview?.calls, 0);
      assert.notEqual(result.security.overallLevel, SecurityLevel.Safe);
      assert.equal(sourceCalls + metadataCalls, 0);
    });
  }

  it('propagates cancellation during a model call instead of converting it to an unknown clearance', async () => {
    configure();
    const controller = new AbortController();
    duringModel = () => controller.abort();
    await assert.rejects(engine.checkPackage(name, {deep: true, signal: controller.signal}), {name: 'AbortError'});
    assert.equal(sourceCalls, 1);
  });
});
