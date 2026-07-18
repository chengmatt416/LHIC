import { deflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  content: Uint8Array;
}

/** Produces a standards-compliant deterministic ZIP without a runtime dependency. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const input = Buffer.from(entry.content);
    const compressed = deflateRawSync(input);
    const crc = crc32(input);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    files.push(local, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(input.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(centralBuffer.length, 12);
  footer.writeUInt32LE(offset, 16);
  footer.writeUInt16LE(0, 20);
  return Buffer.concat([...files, centralBuffer, footer]);
}

function crc32(input: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
