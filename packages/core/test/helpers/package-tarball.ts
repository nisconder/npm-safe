import { gzipSync } from 'node:zlib';

interface TestEntry {
  readonly path: string;
  readonly content: string | Buffer;
  readonly type?: string;
  readonly linkPath?: string;
}

function writeString(target: Buffer, value: string, offset: number, length: number): void {
  target.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeOctal(target: Buffer, value: number, offset: number, length: number): void {
  target.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** Inert TAR fixtures; malicious paths are intentionally allowed as test data. */
export function makeTarball(entries: readonly TestEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
    const header = Buffer.alloc(512);
    writeString(header, entry.path, 0, 100);
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, data.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkPath) writeString(header, entry.linkPath, 157, 100);
    writeString(header, 'ustar\0', 257, 6);
    writeString(header, '00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
