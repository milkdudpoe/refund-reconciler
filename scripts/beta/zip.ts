// Minimal deterministic ZIP writer and strict reader, built on node:zlib only
// (no third-party dependency). Used by the beta packager to create the archive
// and to inspect the archive actually written to disk, and by the archive
// smoke test to extract it. It is development tooling; nothing here ships in
// the extension.
//
// Writer: regular files only, DEFLATE, UTF-8 names, one fixed timestamp and
// fixed permissions, so identical input files give a byte-identical archive.
// Reader: refuses anything the writer never produces (ZIP64, encryption,
// multi-disk archives, unknown compression methods, mismatched headers,
// wrong sizes or CRCs) instead of guessing.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipInputFile {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Uint8Array;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Unix file type and permission bits from the central directory (0 if not recorded). */
  unixMode: number;
  isDirectory: boolean;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
/** 1980-01-01 00:00:00, the earliest DOS timestamp; fixed for reproducible archives. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const REGULAR_FILE_MODE = 0o100644;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * True for a plain relative path that cannot escape the extraction directory
 * on any platform: forward slashes only, no absolute or drive paths, no empty,
 * `.` or `..` segments, and no control or Windows-reserved characters.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (/[\\:*?"<>|]/.test(name) || [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return false;
  if (name.startsWith('/')) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[ .]$/.test(seg));
}

export function createZip(files: readonly ZipInputFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const file of files) {
    if (!isSafeEntryName(file.name)) throw new Error(`Unsafe archive path: ${JSON.stringify(file.name)}`);
    if (seen.has(file.name)) throw new Error(`Duplicate archive path: ${file.name}`);
    seen.add(file.name);
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((REGULAR_FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

function fail(message: string): never {
  throw new Error(`Invalid archive: ${message}`);
}

/** Parses every entry of `zip`, verifying headers, sizes and CRCs. Does not judge names; see isSafeEntryName. */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let endAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_SIG) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) fail('no end-of-central-directory record');
  if (buf.readUInt16LE(endAt + 4) !== 0 || buf.readUInt16LE(endAt + 6) !== 0) fail('multi-disk archives are not supported');
  const count = buf.readUInt16LE(endAt + 10);
  if (count !== buf.readUInt16LE(endAt + 8)) fail('inconsistent entry counts');
  const cdSize = buf.readUInt32LE(endAt + 12);
  const cdOffset = buf.readUInt32LE(endAt + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('ZIP64 is not supported');
  if (cdOffset + cdSize !== endAt) fail('central directory is not where the end record says');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > endAt || buf.readUInt32LE(p) !== CENTRAL_SIG) fail(`bad central directory entry ${i}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (p > endAt) fail('central directory overruns the archive');
    if (flags & 0x0001) fail(`${name} is encrypted`);
    if (method !== 0 && method !== 8) fail(`${name} uses unsupported compression method ${method}`);
    if (size > MAX_ENTRY_BYTES) fail(`${name} is larger than ${MAX_ENTRY_BYTES} bytes`);

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL_SIG) fail(`${name} has no local header`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    if (!buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(nameBytes)) fail(`${name}: local and central names differ`);
    if (buf.readUInt16LE(localOffset + 8) !== method) fail(`${name}: local and central methods differ`);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > cdOffset) fail(`${name} overruns the archive`);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : Buffer.from(raw);
    if (data.length !== size) fail(`${name}: size mismatch`);
    if (crc32(data) !== crc) fail(`${name}: CRC mismatch`);

    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const isDirectory = name.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR || (external & 0x10) !== 0;
    entries.push({ name, data, unixMode, isDirectory });
  }
  return entries;
}

/** True when the recorded mode, if any, is a regular file (not a symlink, device or directory). */
export function isRegularFileEntry(entry: ZipEntry): boolean {
  return !entry.isDirectory && (entry.unixMode === 0 || (entry.unixMode & S_IFMT) === S_IFREG);
}
