/** Bounded TAR/GZIP reads only. No extraction, imports, lifecycle or payload execution. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const ARCHIVE_LIMITS = Object.freeze({ compressedBytes: 20 * 1024 * 1024, unpackedBytes: 50 * 1024 * 1024, entries: 5000, fileBytes: 4 * 1024 * 1024, textBytes: 8 * 1024 * 1024 });
export function limit(value, maximum) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Limits must be nonnegative safe integers');
  return Math.min(value, maximum);
}
function string(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
}
function size(header) {
  if (header[124] & 0x80) throw new Error('Unsupported base-256 TAR size');
  const raw = string(header, 124, 12).trim();
  if (raw && !/^[0-7]+$/.test(raw)) throw new Error('Invalid TAR size');
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe TAR size');
  return value;
}
function checksum(header) {
  const raw = string(header, 148, 8).trim();
  if (!/^[0-7]+$/.test(raw)) return false;
  let actual = 0;
  for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
  return actual === Number.parseInt(raw, 8);
}
function safePath(value) {
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.length > 4096 || path.includes('\0') || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').includes('..')) throw new Error('Unsafe archive path or link');
  return path;
}
function pax(data) {
  const result = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0 || space - offset > 10) throw new Error('Invalid PAX record');
    const raw = data.subarray(offset, space).toString('ascii');
    const length = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10) throw new Error('Invalid PAX record length');
    const pair = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = pair.indexOf('=');
    if (equal < 1) throw new Error('Invalid PAX attribute');
    const key = pair.slice(0, equal);
    if (['path', 'linkpath', 'size'].includes(key)) result[key] = pair.slice(equal + 1);
    offset += length;
  }
  return result;
}
function verify(archive, options) {
  const weights = { sha512: 4, sha384: 3, sha256: 2, sha1: 1 };
  const values = (options.integrity ?? '').split(/\s+/).map(s => s.match(/^(sha(?:512|384|256|1))-([A-Za-z0-9+/=]+)$/)).filter(Boolean).sort((a, b) => weights[b[1]] - weights[a[1]]);
  if (values.length) {
    const algorithm = values[0][1], hash = createHash(algorithm).update(archive).digest('base64');
    if (!values.some(value => value[1] === algorithm && value[2] === hash)) throw new Error('Published integrity mismatch');
  } else if (/^[a-f\d]{40}$/i.test(options.shasum ?? '') && createHash('sha1').update(archive).digest('hex') !== options.shasum.toLowerCase()) throw new Error('Published shasum mismatch');
}

export function readSourceArchive(archive, options = {}) {
  const entries = [], skipped = [], reasons = [];
  let entryCount = 0, unpackedBytes = 0;
  const result = (status, reason) => ({ status, reason, archiveBytes: Buffer.isBuffer(archive) ? archive.length : 0, unpackedBytes, entryCount, entries, skipped, reasons });
  try {
    if (!Buffer.isBuffer(archive)) throw new Error('Archive must be a Buffer');
    if (archive.length > limit(options.maxArchiveBytes, ARCHIVE_LIMITS.compressedBytes)) return result('partial', 'Compressed archive byte limit exceeded');
    verify(archive, options);
    const maximum = limit(options.maxUnpackedBytes, ARCHIVE_LIMITS.unpackedBytes);
    let tar;
    try { tar = gunzipSync(archive, { maxOutputLength: Math.max(1, maximum) }); }
    catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') return result('partial', 'Unpacked archive byte limit exceeded');
      throw error;
    }
    if (tar.length > maximum) return result('partial', 'Unpacked archive byte limit exceeded');
    unpackedBytes = tar.length;
    const seen = new Set(), global = {};
    let next = {}, offset = 0, terminated = false;
    for (; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) { terminated = true; break; }
      if (!checksum(header)) throw new Error('TAR header checksum mismatch');
      if (++entryCount > limit(options.maxEntries, ARCHIVE_LIMITS.entries)) return result('partial', 'Archive entry limit exceeded');
      const length = size(header), dataStart = offset + 512, dataEnd = dataStart + length;
      if (dataEnd > tar.length) throw new Error('TAR entry exceeds archive bounds');
      const data = tar.subarray(dataStart, dataEnd);
      offset = dataStart + Math.ceil(length / 512) * 512;
      if (offset > tar.length) throw new Error('Truncated TAR entry padding');
      const type = String.fromCharCode(header[156] || 0);
      if (['x', 'g'].includes(type)) {
        if (data.length > 65536) throw new Error('PAX metadata limit exceeded');
        Object.assign(type === 'g' ? global : next, pax(data)); continue;
      }
      if (type === 'L' || type === 'K') {
        if (data.length > 4097) throw new Error('GNU long path limit exceeded');
        next[type === 'L' ? 'path' : 'linkpath'] = string(data, 0, data.length); continue;
      }
      const prefix = string(header, 345, 155), name = string(header, 0, 100), attrs = { ...global, ...next };
      next = {};
      if (attrs.size !== undefined && (!/^\d+$/.test(attrs.size) || Number(attrs.size) !== length)) throw new Error('PAX size disagrees with TAR header');
      const path = safePath(attrs.path ?? (prefix ? prefix + '/' + name : name));
      if (['1', '2'].includes(type)) {
        safePath(attrs.linkpath ?? string(header, 157, 100));
        skipped.push({ path, reason: 'Archive links are not followed' }); continue;
      }
      if (!['0', '\0', '7'].includes(type)) {
        if (type !== '5') skipped.push({ path, reason: 'Unsupported archive member type' });
        continue;
      }
      if (seen.has(path)) throw new Error('Duplicate archive member path');
      seen.add(path); entries.push({ path, data });
    }
    if (Object.keys(next).length) throw new Error('Dangling extended TAR metadata');
    if ((offset < tar.length && tar.subarray(offset).some(byte => byte !== 0)) || (!terminated && offset < tar.length)) throw new Error('Truncated or non-zero trailing TAR data');
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return result('complete');
  } catch (error) { return result('failed', error instanceof Error ? error.message : String(error)); }
}
