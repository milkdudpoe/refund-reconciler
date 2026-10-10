// Reads a PNG's pixel size from its IHDR chunk, rejecting anything that is not a PNG.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngSize(data: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
