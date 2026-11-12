import path from 'node:path';
import { readArtifact, readConfined, writeConfinedExclusive, sha256, assertUnchanged } from './evaluation-io.mjs';
import { SUPPLEMENT_LIMITS, collectSourceSupplement } from './source-supplement.mjs';

const MAX_PACKET_BYTES = 512 * 1024;
const save = (directory, file, value) => writeConfinedExclusive(directory, file, JSON.stringify(value, null, 2)+'\n');
export async function readFrozenRun(directory) {
  const receipt = JSON.parse(await readConfined(directory, 'receipt.json', 4096));
  const runBytes = await readConfined(directory, 'private-run.json', 32 * 1024 * 1024);
  const protocolBytes = await readConfined(directory, 'protocol.json', 1024 * 1024);
  if (sha256(runBytes) !== receipt.privateRunSha256 || sha256(protocolBytes) !== receipt.protocolSha256) throw new Error('Run/protocol receipt mismatch');
  const run = JSON.parse(runBytes);
  if (JSON.stringify(run.protocol) !== JSON.stringify(JSON.parse(protocolBytes)) || run.dataset.sha256 !== receipt.datasetSha256 || run.protocol.datasetSha256 !== receipt.datasetSha256) throw new Error('Dataset/protocol identity mismatch');
  if (run.cases.some(entry => !/^case-[a-f0-9]{12}$/.test(entry.caseId))) throw new Error('Invalid case ID');
  await assertUnchanged({ ...run.protocol.scanner.sourceFiles, ...run.protocol.prototype.sourceFiles });
  return run;
}

async function deriveSupplement(directory, run, entry, initial, requestBytes) {
  if (run.protocol.schemaVersion !== 2 || typeof run.artifactDirectory !== 'string') throw new Error('Run does not support source supplements');
  const sample = run.dataset.samples.find(sample => sample.id === entry.sampleId);
  const archive = await readArtifact(path.resolve(directory, run.artifactDirectory), sample.artifacts.tarball, 20 * 1024 * 1024);
  return { ...collectSourceSupplement(archive, initial, JSON.parse(requestBytes), entry.caseId),
    initialPacketSha256: entry.packetSha256, requestSha256: sha256(requestBytes) };
}

/** One immutable request batch; errors consume the attempt and remain recorded. */
export async function supplementSourceEvaluation(directory, caseId) {
  if (!/^case-[a-f0-9]{12}$/.test(caseId)) throw new Error('Invalid case ID');
  const run = await readFrozenRun(directory), entry = run.cases.find(entry => entry.caseId === caseId);
  if (entry?.status !== 'prepared') throw new Error('Case has no prepared evidence');
  const initialBytes = await readConfined(directory, `cases/${caseId}.json`, MAX_PACKET_BYTES);
  if (sha256(initialBytes) !== entry.packetSha256) throw new Error('Frozen review packet changed');
  // Create the one-shot marker before even reading untrusted request bytes.
  const receipt = { caseId, createdAt: new Date().toISOString(), initialPacketSha256: entry.packetSha256 };
  await save(directory, `source-attempts/${caseId}.json`, receipt);
  try {
    const requestBytes = await readConfined(directory, `requests/${caseId}.json`, SUPPLEMENT_LIMITS.requestBytes);
    receipt.requestSha256 = sha256(requestBytes);
    await writeConfinedExclusive(directory, `request-captures/${caseId}.json`, requestBytes);
    const packet = await deriveSupplement(directory, run, entry, JSON.parse(initialBytes), requestBytes);
    const bytes = Buffer.from(JSON.stringify(packet, null, 2)+'\n');
    if (bytes.length > MAX_PACKET_BYTES) throw new Error('Supplement packet JSON budget exceeded');
    await writeConfinedExclusive(directory, `supplements/${caseId}.json`, bytes);
    Object.assign(receipt, { status: 'complete', packetSha256: sha256(bytes), coverage: packet.coverage });
  } catch (error) { Object.assign(receipt, { status: 'failed', error: error.message }); }
  await save(directory, `supplement-receipts/${caseId}.json`, receipt);
  return receipt;
}

export async function loadSupplement(directory, run, entry, initial) {
  let receiptBytes;
  try { receiptBytes = await readConfined(directory, `supplement-receipts/${entry.caseId}.json`, 16384); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await readConfined(directory, `source-attempts/${entry.caseId}.json`, 4096); }
    catch (captureError) { if (captureError.code === 'ENOENT') {
      // A submitted but unserved request is also not a completed review round.
      try { await readConfined(directory, `requests/${entry.caseId}.json`, SUPPLEMENT_LIMITS.requestBytes); }
      catch (requestError) { if (requestError.code === 'ENOENT') return { status: 'not-requested' }; throw requestError; }
    } else throw captureError; }
    throw new Error('Source supplement request is pending/incomplete');
  }
  const receipt = JSON.parse(receiptBytes);
  if (receipt.caseId !== entry.caseId || receipt.initialPacketSha256 !== entry.packetSha256) throw new Error('Supplement identity mismatch');
  const attempt = JSON.parse(await readConfined(directory, `source-attempts/${entry.caseId}.json`, 4096));
  if (attempt.caseId !== entry.caseId || attempt.initialPacketSha256 !== entry.packetSha256 || attempt.createdAt !== receipt.createdAt) throw new Error('Supplement attempt mismatch');
  if (receipt.status === 'failed') return receipt;
  const captured = await readConfined(directory, `request-captures/${entry.caseId}.json`, SUPPLEMENT_LIMITS.requestBytes);
  const request = await readConfined(directory, `requests/${entry.caseId}.json`, SUPPLEMENT_LIMITS.requestBytes);
  if (sha256(captured) !== receipt.requestSha256 || sha256(request) !== receipt.requestSha256) throw new Error('Frozen source request changed');
  if (receipt.status !== 'complete') throw new Error('Invalid supplement status');
  const bytes = await readConfined(directory, `supplements/${entry.caseId}.json`, MAX_PACKET_BYTES);
  if (sha256(bytes) !== receipt.packetSha256) throw new Error('Frozen supplement changed');
  const packet = JSON.parse(bytes);
  // Re-derive from authenticated original bytes; a forged packet/receipt cannot invent evidence.
  const expected = await deriveSupplement(directory, run, entry, initial, captured);
  if (JSON.stringify(packet) !== JSON.stringify(expected) || JSON.stringify(receipt.coverage) !== JSON.stringify(expected.coverage)) throw new Error('Supplement differs from original source');
  return { ...receipt, request: JSON.parse(captured), packet };
}
