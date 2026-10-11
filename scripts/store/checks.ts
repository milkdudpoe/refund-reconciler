// Checks shared by the icon generator, the store-asset command and the unit
// tests. Dimensions and transparency are measured from the PNG bytes; nothing
// here is a visual-correctness claim.
//
// Requirements (Chrome Web Store "Supplying images",
// https://developer.chrome.com/docs/webstore/images, rechecked 2026-10-11):
//   - 128x128 PNG extension icon; square artwork about 96x96 with 16 px of
//     transparent padding per side; should work on light and dark backgrounds.
//   - one 440x280 small promotional image, filling the entire region.
//   - screenshots 1280x800 (preferred) or 640x400, square corners, no padding.

import { alphaBounds, decodePng, isFullyOpaque, readPngSize } from '../beta/png.ts';

export const STORE_ICON_SIZE = 128;
/** Transparent padding required on every side of the 128 px store icon. */
export const STORE_ICON_PADDING = 16;
export const PROMO_TILE = { width: 440, height: 280 } as const;
export const SCREENSHOT = { width: 1280, height: 800 } as const;
export const SCREENSHOT_COUNT = 3;

export interface StoreIconMeasurement {
  width: number;
  height: number;
  /** Inclusive pixel bounds of every pixel with alpha > 0. */
  alphaBounds: { left: number; top: number; right: number; bottom: number };
  artworkWidth: number;
  artworkHeight: number;
  /** Smallest fully transparent margin on any side, in pixels. */
  minTransparentMargin: number;
}

export function measureStoreIcon(png: Uint8Array): StoreIconMeasurement {
  const image = decodePng(png);
  if (image.width !== STORE_ICON_SIZE || image.height !== STORE_ICON_SIZE) {
    throw new Error(`store icon is ${image.width}x${image.height}, expected ${STORE_ICON_SIZE}x${STORE_ICON_SIZE}`);
  }
  const b = alphaBounds(image);
  if (!b) throw new Error('store icon is fully transparent');
  const minTransparentMargin = Math.min(b.left, b.top, image.width - 1 - b.right, image.height - 1 - b.bottom);
  if (minTransparentMargin < STORE_ICON_PADDING) {
    throw new Error(`store icon artwork reaches ${JSON.stringify(b)}; it needs ${STORE_ICON_PADDING} px of fully transparent padding per side`);
  }
  return {
    width: image.width,
    height: image.height,
    alphaBounds: b,
    artworkWidth: b.right - b.left + 1,
    artworkHeight: b.bottom - b.top + 1,
    minTransparentMargin,
  };
}

/** Exact pixel size, and (for full-bleed images) no transparent pixel anywhere. */
export function checkImage(png: Uint8Array, expected: { width: number; height: number }, label: string): void {
  const size = readPngSize(png);
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(`${label} is ${size.width}x${size.height}, expected ${expected.width}x${expected.height}`);
  }
  if (!isFullyOpaque(decodePng(png))) throw new Error(`${label} has transparent pixels; store images must be full bleed`);
}

/** Output file names, shared by the capture spec, the report and the committed copies. */
export const STORE_FILES = {
  tile: 'small-promo-tile-440x280.png',
  screenshots: [
    'screenshot-1-overview-1280x800.png',
    'screenshot-2-item-evidence-1280x800.png',
    'screenshot-3-case-summary-1280x800.png',
  ],
  capture: 'capture.json',
  report: 'store-assets-report.json',
  preview: 'preview.html',
} as const;
