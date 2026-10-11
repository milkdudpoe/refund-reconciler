// The committed Chrome Web Store listing images (store-assets/) and the padded
// store icon: dimensions, count, transparency and provenance labelling. These
// are measured from the PNG bytes; rendering may differ between operating
// systems and fonts, so no image hash is compared here.

import { readFile, readdir } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alphaBounds, decodePng, readPngSize } from '../../scripts/beta/png.ts';
import { isAllowedProductionPath } from '../../scripts/beta/verify.ts';
import {
  PROMO_TILE,
  SCREENSHOT,
  SCREENSHOT_COUNT,
  STORE_FILES,
  STORE_ICON_PADDING,
  checkImage,
  measureStoreIcon,
} from '../../scripts/store/checks.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DIR = join(ROOT, 'store-assets');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** An RGBA PNG of `size` px: transparent, with an opaque square `margin` px from every edge. */
function squarePng(size: number, margin: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = margin; y < size - margin; y++) {
    for (let x = margin; x < size - margin; x++) raw.writeUInt32BE(0x2456a6ff, y * (size * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('the packaged 128 px icon', () => {
  it('has 96x96 artwork inside a fully transparent 16 px margin', async () => {
    const m = measureStoreIcon(await readFile(join(ROOT, 'public', 'icons', 'icon-128.png')));
    expect(m.alphaBounds).toEqual({ left: 16, top: 16, right: 111, bottom: 111 });
    expect([m.artworkWidth, m.artworkHeight]).toEqual([96, 96]);
    expect(m.minTransparentMargin).toBeGreaterThanOrEqual(STORE_ICON_PADDING);
  });

  it('rejects other sizes and artwork that reaches into the padding (the earlier 4 px margin)', async () => {
    const toolbar48 = await readFile(join(ROOT, 'public', 'icons', 'icon-48.png'));
    expect(() => measureStoreIcon(toolbar48)).toThrow(/is 48x48, expected 128x128/);
    expect(() => measureStoreIcon(squarePng(128, 4))).toThrow(/needs 16 px of fully transparent padding/);
    expect(() => measureStoreIcon(squarePng(128, 15))).toThrow(/needs 16 px/);
    expect(measureStoreIcon(squarePng(128, 16)).minTransparentMargin).toBe(16);
  });
});

describe('PNG decoding', () => {
  it('decodes RGBA and finds alpha bounds', () => {
    const image = decodePng(squarePng(20, 3));
    expect(image.rgba.slice((3 * 20 + 3) * 4, (3 * 20 + 3) * 4 + 4)).toEqual(new Uint8Array([0x24, 0x56, 0xa6, 0xff]));
    expect(alphaBounds(image)).toEqual({ left: 3, top: 3, right: 16, bottom: 16 });
    expect(alphaBounds(decodePng(squarePng(8, 4)))).toBeNull();
  });
});

describe('committed store listing images', () => {
  it('are exactly one 440x280 tile and three 1280x800 screenshots, full bleed', async () => {
    const pngs = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort();
    expect(pngs).toEqual([STORE_FILES.tile, ...STORE_FILES.screenshots].sort());
    expect(STORE_FILES.screenshots).toHaveLength(SCREENSHOT_COUNT);
    checkImage(await readFile(join(DIR, STORE_FILES.tile)), PROMO_TILE, STORE_FILES.tile);
    for (const name of STORE_FILES.screenshots) checkImage(await readFile(join(DIR, name)), SCREENSHOT, name);
  });

  it('have an editable tile source with no text, external images or links', async () => {
    const svg = await readFile(join(DIR, 'source', 'small-promo-tile.svg'), 'utf8');
    expect(svg).toMatch(/viewBox="0 0 440 280"/);
    expect(svg).not.toMatch(/<(text|image|foreignObject|use|a|style|script)\b|href=|url\((?!#)/i);
  });

  it('carry a report that is labelled local-precommit, never final-head, and matches the files', async () => {
    const report = JSON.parse(await readFile(join(DIR, STORE_FILES.report), 'utf8')) as {
      generation: string;
      extension: { version: string; name: string; permissions: string[] };
      dataPracticesVersion: number;
      package: { sha256: string };
      outputs: { file: string; width: number; height: number; bytes: number; scenario?: string }[];
    };
    expect(report.generation).toBe('local-precommit');
    expect(report.extension).toEqual({ name: 'Refund Reconciler (local preview)', version: VERSION, permissions: ['storage', 'activeTab', 'scripting'] });
    expect(report.dataPracticesVersion).toBe(1);
    expect(report.package.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.outputs.map((o) => o.file)).toEqual([STORE_FILES.tile, ...STORE_FILES.screenshots]);
    for (const o of report.outputs) {
      const png = await readFile(join(DIR, o.file));
      expect({ ...readPngSize(png), bytes: png.length }).toEqual({ width: o.width, height: o.height, bytes: o.bytes });
    }
    for (const o of report.outputs.slice(1)) expect(o.scenario).toMatch(/SYNTHETIC-10/);
  });

  it('are never accepted into the extension package', () => {
    for (const name of [STORE_FILES.tile, ...STORE_FILES.screenshots, STORE_FILES.report, STORE_FILES.preview, 'store-assets/x.png', 'source/small-promo-tile.svg', 'icons/icon-store.svg']) {
      expect(isAllowedProductionPath(name)).toBe(false);
    }
  });
});
