// Minimal PNG reading for the dev tooling (no image library): the pixel size
// from the IHDR chunk, and full RGBA decoding of the 8-bit, non-interlaced
// truecolour PNGs that Chromium writes, used to measure icon transparency.

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function readPngSize(data: Uint8Array): { width: number; height: number } {
  const buf = asBuffer(data);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, row-major RGBA. */
  rgba: Uint8Array;
}

/**
 * Decodes an 8-bit RGB (colour type 2) or RGBA (colour type 6),
 * non-interlaced PNG. Anything else is rejected rather than misread.
 */
export function decodePng(data: Uint8Array): RgbaImage {
  const buf = asBuffer(data);
  const { width, height } = readPngSize(buf);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${String(bitDepth)}, colour type ${String(colorType)}, interlace ${String(interlace)})`);
  }
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + length));
    if (type === 'IEND') break;
    p += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has an unexpected length');
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (pixels[out + x - channels] as number) : 0;
      const b = y > 0 ? (pixels[out - stride + x] as number) : 0;
      const c = x >= channels && y > 0 ? (pixels[out - stride + x - channels] as number) : 0;
      let predictor: number;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = a; break;
        case 2: predictor = b; break;
        case 3: predictor = (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unsupported PNG filter ${String(filter)}`);
      }
      pixels[out + x] = ((row[x] as number) + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i] as number;
    rgba[j + 1] = pixels[i + 1] as number;
    rgba[j + 2] = pixels[i + 2] as number;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** The inclusive bounding box of pixels with alpha > 0, or null for a fully transparent image. */
export function alphaBounds(image: RgbaImage): { left: number; top: number; right: number; bottom: number } | null {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.rgba[(y * image.width + x) * 4 + 3] as number) === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/** True when every pixel is fully opaque (alpha 255). */
export function isFullyOpaque(image: RgbaImage): boolean {
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] !== 255) return false;
  return true;
}
